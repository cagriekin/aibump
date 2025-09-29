import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import simpleGit from 'simple-git';
import OpenAI from 'openai';
import { execa } from 'execa';
import * as yaml from 'js-yaml';
import { ensureAndGetOpenAIKey } from './config';

export interface AnalyzeOptions {
  apiKey?: string;
  model?: string;
  dryRun?: boolean;
  noCommit?: boolean;
}

export interface ChangeType {
  type: 'helm-only' | 'app-only' | 'both' | 'none';
  helmChanges: boolean;
  appChanges: boolean;
}

export interface HelmChart {
  apiVersion?: string;
  name?: string;
  version?: string;
  appVersion?: string;
  description?: string;
  [key: string]: any;
}

export async function analyzeChanges(options: AnalyzeOptions): Promise<void> {
  // Validate environment
  await validateEnvironment();

  // Get unstaged changes (excluding large files)
  const changes = await getUnstagedChanges();

  if (!changes.trim()) {
    console.log('No relevant unstaged changes found. Large files like package-lock.json are excluded from analysis.');
    return;
  }

  console.log('Found relevant unstaged changes (large files excluded):\n', changes);

  // Determine change type (helm vs app)
  const changeType = detectChangeType(changes);
  console.log(`Change type detected: ${changeType.type}`);

  if (changeType.type === 'none') {
    console.log('No relevant changes found. Nothing to version.');
    return;
  }

  // Analyze with OpenAI
  const versionType = await analyzeWithOpenAI(changes, options);

  console.log(`Recommended version bump: ${versionType}`);

  if (options.dryRun) {
    if (changeType.type === 'helm-only') {
      console.log(`Would bump Helm chart version: ${versionType}`);
    } else if (changeType.type === 'app-only' || changeType.type === 'both') {
      console.log(`Would run: npm version ${versionType} and update Helm appVersion`);
    }
    return;
  }

  // Execute appropriate version bump based on change type
  await executeVersionBump(versionType, changeType);

  // Generate commit message and commit changes by default (unless disabled or dry run)
  if (!options.noCommit && !options.dryRun) {
    await generateCommitMessageAndCommit(options);
  }
}

async function validateEnvironment(): Promise<void> {
  // Check if we're in a git repository
  try {
    const git = simpleGit();
    await git.status();
  } catch (error) {
    throw new Error('Not in a git repository. Please run this command from a git repository.');
  }

  // Check if package.json exists
  const packageJsonPath = join(process.cwd(), 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error('package.json not found. Please run this command from an npm project directory.');
  }

  // Validate package.json content
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    if (!packageJson.version) {
      throw new Error('package.json does not contain a version field.');
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('package.json is not valid JSON.');
    }
    throw error;
  }
}

// Files to exclude from analysis due to size and lack of semantic meaning
const EXCLUDED_FILES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  'coverage/',
  '.nyc_output/',
  '*.log',
  '*.min.js',
  '*.min.css'
];

async function getUnstagedChanges(): Promise<string> {
  const git = simpleGit();

  try {
    // Get list of changed files first
    const status = await git.status();
    const changedFiles = [
      ...status.modified,
      ...status.created,
      ...status.deleted,
      ...status.not_added, // Include untracked files
      ...status.renamed.map(r => r.to)
    ];

    // Filter out excluded files
    const excludedFiles = changedFiles.filter(file =>
      EXCLUDED_FILES.some(excluded =>
        file.includes(excluded) ||
        (excluded.includes('*') && file.match(excluded.replace('*', '.*')))
      )
    );

    const relevantFiles = changedFiles.filter(file =>
      !EXCLUDED_FILES.some(excluded =>
        file.includes(excluded) ||
        (excluded.includes('*') && file.match(excluded.replace('*', '.*')))
      )
    );

    if (excludedFiles.length > 0) {
      console.log(`Excluding large files from analysis: ${excludedFiles.join(', ')}`);
    }

    if (relevantFiles.length === 0) {
      return '';
    }

    // Separate modified/deleted files from newly created files
    const modifiedFiles = relevantFiles.filter(file => 
      status.modified.includes(file) || 
      status.deleted.includes(file) || 
      status.renamed.some(r => r.to === file)
    );
    const newFiles = relevantFiles.filter(file => 
      status.created.includes(file) || 
      status.not_added.includes(file)
    );

    let diff = '';

    // Get diff for modified/deleted files
    if (modifiedFiles.length > 0) {
      diff += await git.diff(modifiedFiles);
    }

    // Handle newly created files by reading their content
    for (const file of newFiles) {
      try {
        const fileContent = await git.show(`:${file}`).catch(() => {
          // If file is not in index, read it directly from filesystem
          return readFileSync(file, 'utf8');
        });
        
        diff += `diff --git a/${file} b/${file}\n`;
        diff += `new file mode 100644\n`;
        diff += `index 0000000..${createHash('sha1').update(fileContent).digest('hex').substring(0, 7)}\n`;
        diff += `--- /dev/null\n`;
        diff += `+++ b/${file}\n`;
        
        // Add file content with + prefix
        const lines = fileContent.split('\n');
        for (const line of lines) {
          diff += `+${line}\n`;
        }
        diff += '\n';
      } catch (error) {
        console.warn(`Warning: Could not read content of new file ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return diff;
  } catch (error) {
    throw new Error(`Failed to get git diff: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function detectChangeType(changes: string): ChangeType {
  // If no changes after filtering, return none
  if (!changes.trim()) {
    return { type: 'none', helmChanges: false, appChanges: false };
  }

  const lines = changes.split('\n');
  let helmChanges = false;
  let appChanges = false;

  for (const line of lines) {
    // Skip diff metadata lines
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@') || line.trim() === '') {
      continue;
    }

    // Check for helm directory changes (excluding Chart.yaml which is handled separately)
    if (line.includes('helm/') && !line.includes('helm/Chart.yaml')) {
      helmChanges = true;
    }
    // Check for app changes (everything except helm directory)
    else if (!line.includes('helm/')) {
      appChanges = true;
    }
  }

  if (helmChanges && appChanges) {
    return { type: 'both', helmChanges: true, appChanges: true };
  } else if (helmChanges) {
    return { type: 'helm-only', helmChanges: true, appChanges: false };
  } else if (appChanges) {
    return { type: 'app-only', helmChanges: false, appChanges: true };
  } else {
    return { type: 'none', helmChanges: false, appChanges: false };
  }
}

function getHelmChartPath(): string {
  return join(process.cwd(), 'helm', 'Chart.yaml');
}

function readHelmChart(): HelmChart | null {
  const chartPath = getHelmChartPath();

  if (!existsSync(chartPath)) {
    return null;
  }

  try {
    const content = readFileSync(chartPath, 'utf-8');
    return yaml.load(content) as HelmChart;
  } catch (error) {
    throw new Error(`Failed to read Helm Chart.yaml: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeHelmChart(chart: HelmChart): void {
  const chartPath = getHelmChartPath();

  try {
    const content = yaml.dump(chart, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: false
    });
    writeFileSync(chartPath, content);
  } catch (error) {
    throw new Error(`Failed to write Helm Chart.yaml: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function bumpVersion(version: string, type: 'major' | 'minor' | 'patch'): string {
  const parts = version.split('.').map(Number);

  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid version format: ${version}`);
  }

  switch (type) {
    case 'major':
      return `${parts[0] + 1}.0.0`;
    case 'minor':
      return `${parts[0]}.${parts[1] + 1}.0`;
    case 'patch':
      return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
    default:
      throw new Error(`Invalid version type: ${type}`);
  }
}

async function analyzeWithOpenAI(changes: string, options: AnalyzeOptions): Promise<'major' | 'minor' | 'patch'> {
  // Ensure we have an API key via config file, seeding from CLI option if provided
  const apiKey = await ensureAndGetOpenAIKey(options.apiKey);

  const openai = new OpenAI({
    apiKey,
  });

  const prompt = `Analyze the following git diff and determine what type of version bump is appropriate according to semantic versioning (semver).

This is a CLI tool called "aibump" that analyzes git changes and automatically bumps npm and Helm versions using AI.

MAJOR (breaking changes - incompatible API changes):
- Removing public functions, methods, classes, or exports
- Changing function signatures (parameter names, types, order, or removing parameters)
- Changing return types of public APIs
- Removing or renaming public properties/fields
- Changing behavior that breaks existing functionality
- Removing configuration options or changing their format
- Changing environment variable names or formats
- Breaking changes to CLI commands or their arguments
- Changing the format of output or responses
- Removing CLI options or changing their behavior

MINOR (new features - backwards compatible):
- Adding new functions, methods, classes, or exports
- Adding optional parameters to existing functions
- Adding new optional properties/fields
- Adding new features without changing existing behavior
- Adding new configuration options
- Adding new CLI commands or optional arguments
- Performance improvements that don't change behavior
- Adding new output formats or options
- Enhancing existing functionality without breaking changes

PATCH (bug fixes - backwards compatible):
- Fixing bugs without changing public APIs
- Updating internal implementation details
- Fixing typos in documentation or comments
- Updating dependencies (unless they introduce breaking changes)
- Security fixes that don't change APIs
- Internal refactoring that doesn't affect public interfaces
- Fixing CLI command behavior without changing the interface
- Improving error messages or logging

CRITICAL GUIDANCE:
- Only use MAJOR if existing code/scripts using this tool would break
- Adding new CLI options (like --new-flag) is MINOR, not MAJOR
- Fixing bugs in existing functionality is PATCH, not MAJOR
- Internal code changes that don't affect the public interface are PATCH
- When in doubt between MINOR and PATCH, choose PATCH for bug fixes and MINOR for new features

Git diff:
${changes}

Respond with only one word: "major", "minor", or "patch".`;

  try {
    const completion = await openai.chat.completions.create({
      model: options.model || 'gpt-5-nano',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 10,
      temperature: 0,
    });

    const response = completion.choices[0]?.message?.content?.trim().toLowerCase();

    if (!response || !['major', 'minor', 'patch'].includes(response)) {
      throw new Error(`Invalid response from OpenAI: ${response}`);
    }

    return response as 'major' | 'minor' | 'patch';
  } catch (error) {
    throw new Error(`OpenAI API error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function executeVersionBump(versionType: 'major' | 'minor' | 'patch', changeType: ChangeType): Promise<void> {
  try {
    // Note: We intentionally don't check for clean working directory here
    // because we want to analyze and version based on unstaged changes

    if (changeType.type === 'helm-only') {
      // Only bump Helm chart version
      await bumpHelmChartVersion(versionType);
    } else if (changeType.type === 'app-only' || changeType.type === 'both') {
      // Bump npm package version and sync with Helm appVersion
      await bumpNpmVersion(versionType);
      await syncHelmAppVersion();
    }

    console.log('Version bump completed successfully.');
  } catch (error) {
    throw new Error(`Failed to execute version bump: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function bumpHelmChartVersion(versionType: 'major' | 'minor' | 'patch'): Promise<void> {
  const chart = readHelmChart();

  if (!chart) {
    throw new Error('Helm Chart.yaml not found. Cannot bump Helm chart version.');
  }

  if (!chart.version) {
    throw new Error('Helm Chart.yaml does not contain a version field.');
  }

  const newVersion = bumpVersion(chart.version, versionType);
  chart.version = newVersion;

  writeHelmChart(chart);
  console.log(`Updated Helm chart version to ${newVersion}`);
}

async function bumpNpmVersion(versionType: 'major' | 'minor' | 'patch'): Promise<void> {
  const packageJsonPath = join(process.cwd(), 'package.json');

  try {
    // Read current package.json
    const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);

    if (!packageJson.version) {
      throw new Error('package.json does not contain a version field.');
    }

    // Calculate new version
    const newVersion = bumpVersion(packageJson.version, versionType);
    console.log(`Bumping npm version from ${packageJson.version} to ${newVersion}`);

    // Update package.json
    packageJson.version = newVersion;
    writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

    console.log(`Updated package.json version to ${newVersion}`);

    // Update package-lock.json with the new version
    await updatePackageLockVersion();
  } catch (error) {
    throw new Error(`Failed to bump npm version: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function syncHelmAppVersion(): Promise<void> {
  const chart = readHelmChart();

  if (!chart) {
    console.log('Helm Chart.yaml not found. Skipping appVersion sync.');
    return;
  }

  // Read the updated version from package.json
  const packageJsonPath = join(process.cwd(), 'package.json');
  const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
  const packageJson = JSON.parse(packageJsonContent);
  const newAppVersion = packageJson.version;

  chart.appVersion = newAppVersion;
  writeHelmChart(chart);
  console.log(`Updated Helm chart appVersion to ${newAppVersion}`);
}

async function updatePackageLockVersion(): Promise<void> {
  const packageJsonPath = join(process.cwd(), 'package.json');
  const packageLockPath = join(process.cwd(), 'package-lock.json');

  try {
    // Read the updated version from package.json
    const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);
    const newVersion = packageJson.version;

    // Check if package-lock.json exists
    if (!existsSync(packageLockPath)) {
      console.log('package-lock.json not found. Skipping package-lock.json update.');
      return;
    }

    // Read and update package-lock.json
    const packageLockContent = readFileSync(packageLockPath, 'utf-8');
    const packageLock = JSON.parse(packageLockContent);

    // Update the version field
    packageLock.version = newVersion;

    // Also update the version in the packages[""] section if it exists
    if (packageLock.packages && packageLock.packages['']) {
      packageLock.packages[''].version = newVersion;
    }

    // Write the updated package-lock.json back to disk
    writeFileSync(packageLockPath, JSON.stringify(packageLock, null, 2) + '\n');

    console.log(`Updated package-lock.json version to ${newVersion}`);
  } catch (error) {
    // If package-lock.json doesn't exist or can't be updated, that's okay
    console.log('Warning: Could not update package-lock.json version:', error instanceof Error ? error.message : String(error));
  }
}

async function generateCommitMessageAndCommit(options: AnalyzeOptions): Promise<void> {
  try {
    const git = simpleGit();

    // Get the current git diff (staged and unstaged changes)
    const diff = await git.diff();

    if (!diff.trim()) {
      console.log('No changes to commit.');
      return;
    }

    // Generate commit message using OpenAI
    const commitMessage = await generateCommitMessage(diff, options);

    // Stage all changes
    await git.add('.');

    // Commit with the generated message
    await git.commit(commitMessage);

    console.log(`Committed changes with message: ${commitMessage}`);
  } catch (error) {
    throw new Error(`Failed to commit changes: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function generateCommitMessage(diff: string, options: AnalyzeOptions): Promise<string> {
  // Ensure we have an API key via config file, seeding from CLI option if provided
  const apiKey = await ensureAndGetOpenAIKey(options.apiKey);

  const openai = new OpenAI({
    apiKey,
  });

  const prompt = `Analyze the following git diff and generate a structured commit message.

The commit message should follow this format:

type(scope): Brief summary of changes

- Bullet point highlighting key change 1
- Bullet point highlighting key change 2
- Bullet point highlighting key change 3

Common types:
- feat: new features
- fix: bug fixes
- docs: documentation changes
- style: formatting, missing semicolons, etc.
- refactor: code refactoring
- test: adding or updating tests
- chore: maintenance tasks, dependency updates, version bumps

Guidelines:
- Keep the summary line concise (under 50 characters)
- Include 2-4 bullet points highlighting the most important changes
- Focus on what changed, not how it was implemented
- Use present tense for the summary and bullet points
- Be specific about the impact or functionality
- Do NOT include version bumps (package.json, Chart.yaml version changes) in the summary line
- Version bumps can be included in bullet points if they are significant

Git diff:
${diff}

Respond with only the commit message in the specified format, no additional text or quotes.`;

  try {
    const completion = await openai.chat.completions.create({
      model: options.model || 'gpt-5-nano',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0.3,
    });

    const response = completion.choices[0]?.message?.content?.trim();

    if (!response) {
      throw new Error('No response from OpenAI');
    }

    // Clean up the response (remove quotes if present)
    const cleanMessage = response.replace(/^["']|["']$/g, '');

    return cleanMessage;
  } catch (error) {
    throw new Error(`OpenAI API error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
