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
  staged?: boolean;
  unstaged?: boolean;
  both?: boolean;
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

  // Determine what changes to analyze based on options
  const changeType = determineChangeType(options);
  console.log(`Analyzing ${changeType} changes...`);

  // Get changes (excluding large files)
  const { staged, unstaged, combined } = await getChanges(options);

  if (!combined.trim()) {
    console.log(`No relevant ${changeType} changes found. Large files like package-lock.json are excluded from analysis.`);
    return;
  }

  console.log(`Found relevant ${changeType} changes (large files excluded):\n`, combined);

  // Filter out version-only changes before analysis
  const filteredChanges = filterVersionChanges(combined);

  // Determine change type (helm vs app)
  const detectedChangeType = detectChangeType(filteredChanges);
  console.log(`Change type detected: ${detectedChangeType.type}`);

  // Add specific logging for Helm scripts
  if (detectedChangeType.type === 'helm-only') {
    const hasHelmScripts = combined.includes('helm/') && (
      combined.includes('.sh') || combined.includes('.bash') || combined.includes('.py') ||
      combined.includes('.js') || combined.includes('.ts') || combined.includes('.rb') ||
      combined.includes('.pl') || combined.includes('.ps1') || combined.includes('.bat') ||
      combined.includes('.cmd') || combined.includes('scripts/') || combined.includes('hooks/')
    );

    if (hasHelmScripts) {
      console.log('Note: Only Helm scripts detected - package.json version will not be bumped');
    }
  }

  if (detectedChangeType.type === 'none') {
    console.log('No relevant changes found. Nothing to version.');
    return;
  }

  // Analyze with OpenAI (use filtered changes to exclude version bumps)
  const versionType = await analyzeWithOpenAI(filteredChanges, options);

  console.log(`Recommended version bump: ${versionType}`);

  if (options.dryRun) {
    if (detectedChangeType.type === 'helm-only') {
      console.log(`Would bump Helm chart version: ${versionType}`);
    } else if (detectedChangeType.type === 'app-only' || detectedChangeType.type === 'both') {
      const packageJsonPath = join(process.cwd(), 'package.json');
      if (existsSync(packageJsonPath)) {
        console.log(`Would run: npm version ${versionType} and update Helm appVersion`);
      } else {
        console.log(`Would bump Helm chart version: ${versionType} (no package.json found)`);
      }
    }
    return;
  }

  // Execute appropriate version bump based on change type
  await executeVersionBump(versionType, detectedChangeType);

  // Generate commit message and commit changes by default (unless disabled or dry run)
  if (!options.noCommit && !options.dryRun) {
    await generateCommitMessageAndCommit(options);
  }
}

function determineChangeType(options: AnalyzeOptions): string {
  if (options.staged) return 'staged';
  if (options.unstaged) return 'unstaged';
  if (options.both) return 'staged and unstaged';
  return 'staged and unstaged'; // default behavior
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
  const packageJsonExists = existsSync(packageJsonPath);

  // Check if Helm Chart.yaml exists
  const helmChartPath = getHelmChartPath();
  const helmChartExists = existsSync(helmChartPath);

  // At least one of package.json or Helm Chart.yaml must exist
  if (!packageJsonExists && !helmChartExists) {
    throw new Error('Neither package.json nor Helm Chart.yaml found. Please run this command from a project directory with either npm package or Helm chart.');
  }

  // Validate package.json content if it exists
  if (packageJsonExists) {
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

  // Validate Helm Chart.yaml content if it exists
  if (helmChartExists) {
    try {
      const chart = readHelmChart();
      if (!chart || !chart.version) {
        throw new Error('Helm Chart.yaml does not contain a version field.');
      }
    } catch (error) {
      throw new Error(`Helm Chart.yaml validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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

async function getStagedChanges(): Promise<string> {
  const git = simpleGit();

  try {
    // Get list of staged files
    const status = await git.status();
    const stagedFiles = status.staged;

    if (stagedFiles.length === 0) {
      return '';
    }

    // Filter out excluded files
    const excludedFiles = stagedFiles.filter(file =>
      EXCLUDED_FILES.some(excluded =>
        file.includes(excluded) ||
        (excluded.includes('*') && file.match(excluded.replace('*', '.*')))
      )
    );

    const relevantFiles = stagedFiles.filter(file =>
      !EXCLUDED_FILES.some(excluded =>
        file.includes(excluded) ||
        (excluded.includes('*') && file.match(excluded.replace('*', '.*')))
      )
    );

    if (excludedFiles.length > 0) {
      console.log(`Excluding large staged files from analysis: ${excludedFiles.join(', ')}`);
    }

    if (relevantFiles.length === 0) {
      return '';
    }

    // Get diff for staged files
    return await git.diff(['--cached', ...relevantFiles]);
  } catch (error) {
    throw new Error(`Failed to get staged git diff: ${error instanceof Error ? error.message : String(error)}`);
  }
}

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
      status.renamed.some(r => r.to === file)
    );
    const deletedFiles = relevantFiles.filter(file =>
      status.deleted.includes(file)
    );
    const newFiles = relevantFiles.filter(file =>
      status.created.includes(file) ||
      status.not_added.includes(file)
    );

    let diff = '';

    // Get diff for modified files (excluding deleted files)
    if (modifiedFiles.length > 0) {
      diff += await git.diff(modifiedFiles);
    }

    // Handle deleted files separately
    if (deletedFiles.length > 0) {
      try {
        diff += await git.diff(['--', ...deletedFiles]);
      } catch (error) {
        // If the above fails, try handling each deleted file individually
        for (const file of deletedFiles) {
          try {
            diff += await git.diff(['--', file]);
          } catch (fileError) {
            console.warn(`Warning: Could not get diff for deleted file ${file}: ${fileError instanceof Error ? fileError.message : String(fileError)}`);
          }
        }
      }
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

async function getChanges(options: AnalyzeOptions): Promise<{ staged: string; unstaged: string; combined: string }> {
  const staged = options.staged || options.both || (!options.staged && !options.unstaged && !options.both) ? await getStagedChanges() : '';
  const unstaged = options.unstaged || options.both || (!options.staged && !options.unstaged && !options.both) ? await getUnstagedChanges() : '';

  let combined = '';
  if (staged && unstaged) {
    combined = `=== STAGED CHANGES ===\n${staged}\n\n=== UNSTAGED CHANGES ===\n${unstaged}`;
  } else if (staged) {
    combined = `=== STAGED CHANGES ===\n${staged}`;
  } else if (unstaged) {
    combined = `=== UNSTAGED CHANGES ===\n${unstaged}`;
  }

  return { staged, unstaged, combined };
}

function filterVersionChanges(diff: string): string {
  // Filter out version-only changes from package.json and helm/Chart.yaml
  // This prevents previous version bumps from influencing the AI analysis

  const lines = diff.split('\n');
  const filteredLines: string[] = [];
  let skipNextLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip lines if we're in a version-only change section
    if (skipNextLines > 0) {
      skipNextLines--;
      continue;
    }

    // Check if this is a package.json or Chart.yaml version change
    // Look for patterns like:
    // -  "version": "1.0.7",
    // +  "version": "2.0.0",
    // or
    // -appVersion: 1.0.7
    // +appVersion: 2.0.0
    // or
    // -version: 0.1.0
    // +version: 0.1.1

    const isPackageJsonVersionLine = /^[-+]\s*"version":\s*"[\d.]+",?\s*$/.test(line);
    const isHelmVersionLine = /^[-+](app)?[Vv]ersion:\s*[\d.]+\s*$/.test(line);

    if (isPackageJsonVersionLine || isHelmVersionLine) {
      // Check if the next line is also a version change (the + after -)
      const nextLine = lines[i + 1];
      if (nextLine) {
        const nextIsPackageJsonVersion = /^[-+]\s*"version":\s*"[\d.]+",?\s*$/.test(nextLine);
        const nextIsHelmVersion = /^[-+](app)?[Vv]ersion:\s*[\d.]+\s*$/.test(nextLine);

        if (nextIsPackageJsonVersion || nextIsHelmVersion) {
          // This is a version change pair, skip both lines
          skipNextLines = 1;
          continue;
        }
      }
    }

    filteredLines.push(line);
  }

  return filteredLines.join('\n');
}

function detectChangeType(changes: string): ChangeType {
  // If no changes after filtering, return none
  if (!changes.trim()) {
    return { type: 'none', helmChanges: false, appChanges: false };
  }

  const lines = changes.split('\n');
  let helmChanges = false;
  let helmScriptChanges = false;
  let appChanges = false;
  let helmNonScriptChanges = false;

  // Check if package.json exists to determine if this is a JavaScript project
  const packageJsonPath = join(process.cwd(), 'package.json');
  const packageJsonExists = existsSync(packageJsonPath);

  // File extensions that are considered Helm scripts
  const helmScriptExtensions = ['.sh', '.bash', '.py', '.js', '.ts', '.rb', '.pl', '.ps1', '.bat', '.cmd'];

  // Track which file we're currently processing
  let currentFile = '';

  for (const line of lines) {
    // Check for diff --git headers to track current file
    if (line.startsWith('diff --git')) {
      // Extract file path from "diff --git a/path/to/file b/path/to/file"
      const match = line.match(/diff --git a\/(.+?) b\//);
      if (match) {
        currentFile = match[1];
      }
      continue;
    }

    // Skip other diff metadata lines
    if (line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('@@') ||
      line.startsWith('index ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.trim() === '') {
      continue;
    }

    // Check if current file is helm-related (excluding Chart.yaml)
    const isHelmRelated = currentFile.startsWith('helm/') && !currentFile.includes('Chart.yaml');

    if (isHelmRelated) {
      helmChanges = true;

      // Check if this is a Helm script file
      const isHelmScript = helmScriptExtensions.some(ext =>
        currentFile.includes(ext) ||
        currentFile.includes('scripts/') ||
        currentFile.includes('hooks/')
      );

      if (isHelmScript) {
        helmScriptChanges = true;
      } else {
        // This is a helm change but not a script
        helmNonScriptChanges = true;
      }
    }
    // Check for app changes (everything except helm directory)
    // If no package.json exists, treat all non-helm changes as helm-only since there's no JavaScript app
    else if (currentFile && !isHelmRelated) {
      if (packageJsonExists) {
        appChanges = true;
      } else {
        // No package.json exists, so this is a helm-only repository
        // Treat any non-helm changes as helm changes
        helmChanges = true;
        helmNonScriptChanges = true;
      }
    }
  }

  // If no package.json exists, this is a helm-only repository
  if (!packageJsonExists) {
    if (helmChanges) {
      return { type: 'helm-only', helmChanges: true, appChanges: false };
    } else {
      return { type: 'none', helmChanges: false, appChanges: false };
    }
  }

  // If only Helm scripts changed (no other helm changes, no app changes), treat as helm-only
  if (helmChanges && helmScriptChanges && !helmNonScriptChanges && !appChanges) {
    return { type: 'helm-only', helmChanges: true, appChanges: false };
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

## MAJOR VERSION (X.0.0) - BREAKING CHANGES ONLY
A major version bump is required ONLY when changes would break existing code, configurations, or deployments that depend on this software. This means:

**API BREAKING CHANGES:**
- Changing HTTP API endpoint paths or URLs
- Changing API request payload structure or required fields
- Changing API response format or structure
- Removing or changing required API headers
- Changing message formats for consumed or published messages
- Changing external service interfaces or protocols

**CONFIGURATION BREAKING CHANGES:**
- Removing required configuration options that have no default values
- Changing configuration format in ways that break existing configs
- Changing required CLI command arguments or their behavior
- Changing output formats that break existing parsers

**DEPLOYMENT BREAKING CHANGES:**
- Changes that would cause existing deployments to fail without manual intervention
- Removing required environment variables that have no fallback
- Changing required service dependencies or interfaces
- Renaming or removing required Helm values that would break existing deployments

**IMPORTANT: Moving or reorganizing Helm values is NOT a breaking change if:**
- The values have default values (empty strings, null, or other defaults)
- The change is internal refactoring of the values structure
- Example: Moving env.apiKey to secrets.apiKey with default empty string is PATCH, not MAJOR

## MINOR VERSION (0.X.0) - NEW FEATURES (BACKWARDS COMPATIBLE)
A minor version bump is for adding new functionality that doesn't break existing usage:

**NEW FEATURES:**
- Adding new functions, methods, classes, or exports
- Adding optional parameters to existing functions
- Adding new optional properties/fields
- Adding new configuration options
- Adding new CLI commands or optional arguments
- Adding new output formats or options
- Adding new deployment environments or configurations

**ENHANCEMENTS:**
- Performance improvements that don't change behavior
- Enhancing existing functionality without breaking changes
- Adding new features that extend existing capabilities

## PATCH VERSION (0.0.X) - EVERYTHING ELSE
A patch version bump is for all other changes that don't add new features or break existing functionality:

**BUG FIXES:**
- Fixing bugs without changing public APIs
- Security fixes that don't change APIs
- Fixing CLI command behavior without changing the interface
- Improving error messages or logging

**MAINTENANCE:**
- Updating internal implementation details
- Internal refactoring that doesn't affect public interfaces
- Updating dependencies (unless they introduce breaking changes)
- Fixing typos in documentation or comments

**CONFIGURATION CHANGES:**
- Deployment configuration changes (resource limits, replica counts, scaling settings)
- Infrastructure changes that don't affect application behavior
- Configuration cleanup or optimization
- Environment-specific configuration adjustments
- Changing port numbers, service configurations, or deployment settings
- Updating Helm chart values (ports, resource limits, scaling settings)
- Changing default values without breaking existing configs
- Refactoring Helm templates or reorganizing Helm values structure
- Moving configuration between Helm values sections (e.g., from env to secrets) when values have defaults
- Removing fields from Helm values if they have default empty values (e.g., removing openaiApiKey with empty string from env)
- Internal Helm template changes that don't change the deployed resources
- Reorganizing where optional configuration values are defined

## DECISION FRAMEWORK

**Ask yourself: "Would this change break existing code or deployments?"**
- YES → MAJOR
- NO → Continue to next question

**Ask yourself: "Does this add new functionality or features?"**
- YES → MINOR
- NO → PATCH

## CRITICAL RULES

1. **MAJOR is ONLY for breaking changes** - If existing code/deployments would fail, it's MAJOR
2. **Everything else is MINOR or PATCH** - There is no "undefined" category
3. **When in doubt, choose the lower version** - Prefer PATCH over MINOR, MINOR over MAJOR
4. **Helm configuration changes are almost always PATCH** unless they break existing deployments
5. **Helm template refactoring is PATCH** - Reorganizing Helm values or templates is PATCH
6. **Removing optional Helm values with defaults is PATCH** - If a field has a default value like "", removing it is PATCH
7. **Moving values between Helm sections is PATCH** - Moving from env to secrets is refactoring, not breaking
8. **Adding new options/features is MINOR** - Even if they're significant additions
9. **Bug fixes are PATCH** - Even if they're important security fixes

## EXAMPLES

**MAJOR (Breaking):**
- Removing a required CLI argument
- Changing HTTP API endpoint paths
- Changing API request/response payload structure
- Removing a required environment variable
- Changing message queue message formats

**MINOR (New Features):**
- Adding new CLI options
- Adding new configuration parameters
- Adding new API endpoints
- Adding new deployment environments
- Adding new internal functions or methods
- Adding optional parameters to existing functions

**PATCH (Everything Else):**
- Fixing bugs
- Updating dependencies
- Changing port numbers
- Adjusting resource limits
- Security patches
- Documentation updates
- Internal refactoring
- Changing internal function signatures
- Removing unused internal functions
- Refactoring Helm templates or values structure
- Moving values between Helm sections (env to secrets, etc.)

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
      // Check if package.json exists before trying to bump npm version
      const packageJsonPath = join(process.cwd(), 'package.json');
      if (existsSync(packageJsonPath)) {
        // Bump npm package version and sync with Helm appVersion
        await bumpNpmVersion(versionType);
        await syncHelmAppVersion();
      } else {
        // No package.json exists, only bump Helm chart version
        await bumpHelmChartVersion(versionType);
      }
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

  if (!existsSync(packageJsonPath)) {
    console.log('package.json not found. Skipping appVersion sync.');
    return;
  }

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

    // Get the appropriate diff based on options
    let diff = '';
    if (options.staged) {
      // Only commit staged changes
      diff = await git.diff(['--cached']);
    } else if (options.unstaged) {
      // Stage unstaged changes and commit them
      await git.add('.');
      diff = await git.diff(['--cached']);
    } else if (options.both || (!options.staged && !options.unstaged && !options.both)) {
      // Stage all changes (both staged and unstaged) and commit
      await git.add('.');
      diff = await git.diff(['--cached']);
    }

    if (!diff.trim()) {
      console.log('No changes to commit.');
      return;
    }

    // Generate commit message using OpenAI
    const commitMessage = await generateCommitMessage(diff, options);

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
