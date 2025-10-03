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
  lastCommits?: string;
  override?: string;
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

  // Check if we're analyzing last commits instead of working directory
  if (options.lastCommits) {
    // Validate that conflicting options are not used
    if (options.staged || options.unstaged || options.both) {
      throw new Error(
        '--last-commits cannot be used with --staged, --unstaged, or --both options'
      );
    }
    await analyzeLastCommits(options);
    return;
  }

  // Determine what changes to analyze based on options
  const changeType = determineChangeType(options);
  console.log(`Analyzing ${changeType} changes...`);

  // Get changes (excluding large files)
  const { staged, unstaged, combined } = await getChanges(options);

  if (!combined.trim()) {
    console.log(
      `No relevant ${changeType} changes found. Large files like package-lock.json are excluded from analysis.`
    );
    return;
  }

  console.log(
    `Found relevant ${changeType} changes (large files excluded):\n`,
    combined
  );

  // Filter out version-only changes before analysis
  const filteredChanges = filterVersionChanges(combined);

  // Determine change type (helm vs app)
  const detectedChangeType = detectChangeType(filteredChanges);
  console.log(`Change type detected: ${detectedChangeType.type}`);

  // Add specific logging for Helm scripts
  if (detectedChangeType.type === 'helm-only') {
    const hasHelmScripts =
      combined.includes('helm/') &&
      (combined.includes('.sh') ||
        combined.includes('.bash') ||
        combined.includes('.py') ||
        combined.includes('.js') ||
        combined.includes('.ts') ||
        combined.includes('.rb') ||
        combined.includes('.pl') ||
        combined.includes('.ps1') ||
        combined.includes('.bat') ||
        combined.includes('.cmd') ||
        combined.includes('scripts/') ||
        combined.includes('hooks/'));

    if (hasHelmScripts) {
      console.log(
        'Note: Only Helm scripts detected - package.json version will not be bumped'
      );
    }
  }

  if (detectedChangeType.type === 'none') {
    console.log('No relevant changes found. Nothing to version.');
    return;
  }

  // Determine version bump type - use override if provided, otherwise analyze with OpenAI
  let versionType: 'major' | 'minor' | 'patch';
  
  if (options.override) {
    const overrideValue = options.override.toLowerCase();
    if (overrideValue !== 'major' && overrideValue !== 'minor' && overrideValue !== 'patch') {
      throw new Error(`Invalid override value: ${options.override}. Must be one of: major, minor, patch`);
    }
    versionType = overrideValue as 'major' | 'minor' | 'patch';
    console.log(`Using override version bump: ${versionType}`);
  } else {
    // Analyze with OpenAI (use filtered changes to exclude version bumps)
    versionType = await analyzeWithOpenAI(filteredChanges, options);
    console.log(`Recommended version bump: ${versionType}`);
  }

  if (options.dryRun) {
    if (detectedChangeType.type === 'helm-only') {
      console.log(`Would bump Helm chart version: ${versionType}`);
    } else if (
      detectedChangeType.type === 'app-only' ||
      detectedChangeType.type === 'both'
    ) {
      const packageJsonPath = join(process.cwd(), 'package.json');
      if (existsSync(packageJsonPath)) {
        console.log(
          `Would run: npm version ${versionType} and update Helm appVersion`
        );
      } else {
        console.log(
          `Would bump Helm chart version: ${versionType} (no package.json found)`
        );
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

async function analyzeLastCommits(options: AnalyzeOptions): Promise<void> {
  const numberOfCommits = parseInt(options.lastCommits || '1', 10);

  if (isNaN(numberOfCommits) || numberOfCommits < 1) {
    throw new Error(
      `Invalid number of commits: ${options.lastCommits}. Must be a positive integer.`
    );
  }

  console.log(`Analyzing changes from the last ${numberOfCommits} commit(s)...`);

  // Get changes from last N commits
  const changes = await getLastCommitsChanges(numberOfCommits);

  if (!changes.trim()) {
    console.log(
      `No relevant changes found in the last ${numberOfCommits} commit(s). Large files like package-lock.json are excluded from analysis.`
    );
    return;
  }

  console.log(
    `Found relevant changes in the last ${numberOfCommits} commit(s) (large files excluded)`
  );

  // Filter out version-only changes before analysis
  const filteredChanges = filterVersionChanges(changes);

  // Determine change type (helm vs app)
  const detectedChangeType = detectChangeType(filteredChanges);
  console.log(`Change type detected: ${detectedChangeType.type}`);

  if (detectedChangeType.type === 'none') {
    console.log('No relevant changes found. Nothing to version.');
    return;
  }

  // Determine version bump type - use override if provided, otherwise analyze with OpenAI
  let versionType: 'major' | 'minor' | 'patch';
  
  if (options.override) {
    const overrideValue = options.override.toLowerCase();
    if (overrideValue !== 'major' && overrideValue !== 'minor' && overrideValue !== 'patch') {
      throw new Error(`Invalid override value: ${options.override}. Must be one of: major, minor, patch`);
    }
    versionType = overrideValue as 'major' | 'minor' | 'patch';
    console.log(`Using override version bump: ${versionType}`);
  } else {
    // Analyze with OpenAI (use filtered changes to exclude version bumps)
    versionType = await analyzeWithOpenAI(filteredChanges, options);
    console.log(`Recommended version bump: ${versionType}`);
  }

  if (options.dryRun) {
    if (detectedChangeType.type === 'helm-only') {
      console.log(`Would bump Helm chart version: ${versionType}`);
    } else if (
      detectedChangeType.type === 'app-only' ||
      detectedChangeType.type === 'both'
    ) {
      const packageJsonPath = join(process.cwd(), 'package.json');
      if (existsSync(packageJsonPath)) {
        console.log(
          `Would run: npm version ${versionType} and update Helm appVersion`
        );
      } else {
        console.log(
          `Would bump Helm chart version: ${versionType} (no package.json found)`
        );
      }
    }
    console.log('Would commit the version bump changes.');
    return;
  }

  // Execute appropriate version bump based on change type
  await executeVersionBump(versionType, detectedChangeType);

  // Always commit the version bump (don't respect noCommit flag in this mode)
  console.log('\nCommitting version bump changes...');
  await commitVersionBump(versionType, numberOfCommits, options);
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
    throw new Error(
      'Not in a git repository. Please run this command from a git repository.'
    );
  }

  // Check if package.json exists
  const packageJsonPath = join(process.cwd(), 'package.json');
  const packageJsonExists = existsSync(packageJsonPath);

  // Check if Helm Chart.yaml exists
  const helmChartPath = getHelmChartPath();
  const helmChartExists = existsSync(helmChartPath);

  // At least one of package.json or Helm Chart.yaml must exist
  if (!packageJsonExists && !helmChartExists) {
    throw new Error(
      'Neither package.json nor Helm Chart.yaml found. Please run this command from a project directory with either npm package or Helm chart.'
    );
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
      throw new Error(
        `Helm Chart.yaml validation failed: ${error instanceof Error ? error.message : String(error)}`
      );
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
  '*.min.css',
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
      EXCLUDED_FILES.some(
        excluded =>
          file.includes(excluded) ||
          (excluded.includes('*') && file.match(excluded.replace('*', '.*')))
      )
    );

    const relevantFiles = stagedFiles.filter(
      file =>
        !EXCLUDED_FILES.some(
          excluded =>
            file.includes(excluded) ||
            (excluded.includes('*') && file.match(excluded.replace('*', '.*')))
        )
    );

    if (excludedFiles.length > 0) {
      console.log(
        `Excluding large staged files from analysis: ${excludedFiles.join(', ')}`
      );
    }

    if (relevantFiles.length === 0) {
      return '';
    }

    // Get diff for staged files
    return await git.diff(['--cached', ...relevantFiles]);
  } catch (error) {
    throw new Error(
      `Failed to get staged git diff: ${error instanceof Error ? error.message : String(error)}`
    );
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
      ...status.renamed.map(r => r.to),
    ];

    // Filter out excluded files
    const excludedFiles = changedFiles.filter(file =>
      EXCLUDED_FILES.some(
        excluded =>
          file.includes(excluded) ||
          (excluded.includes('*') && file.match(excluded.replace('*', '.*')))
      )
    );

    const relevantFiles = changedFiles.filter(
      file =>
        !EXCLUDED_FILES.some(
          excluded =>
            file.includes(excluded) ||
            (excluded.includes('*') && file.match(excluded.replace('*', '.*')))
        )
    );

    if (excludedFiles.length > 0) {
      console.log(
        `Excluding large files from analysis: ${excludedFiles.join(', ')}`
      );
    }

    if (relevantFiles.length === 0) {
      return '';
    }

    // Separate modified/deleted files from newly created files
    const modifiedFiles = relevantFiles.filter(
      file =>
        status.modified.includes(file) ||
        status.renamed.some(r => r.to === file)
    );
    const deletedFiles = relevantFiles.filter(file =>
      status.deleted.includes(file)
    );
    const newFiles = relevantFiles.filter(
      file => status.created.includes(file) || status.not_added.includes(file)
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
            console.warn(
              `Warning: Could not get diff for deleted file ${file}: ${fileError instanceof Error ? fileError.message : String(fileError)}`
            );
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
        console.warn(
          `Warning: Could not read content of new file ${file}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return diff;
  } catch (error) {
    throw new Error(
      `Failed to get git diff: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function getLastCommitsChanges(numberOfCommits: number): Promise<string> {
  const git = simpleGit();

  try {
    // Get the combined diff of the last N commits
    // This shows all changes introduced by those commits
    const diff = await git.diff([`HEAD~${numberOfCommits}`, 'HEAD']);

    if (!diff.trim()) {
      return '';
    }

    // Filter out excluded files
    const lines = diff.split('\n');
    const filteredLines: string[] = [];
    let currentFile = '';
    let skipFile = false;

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        const fileMatch = line.match(/diff --git a\/(.+?) b\/(.+?)$/);
        if (fileMatch) {
          currentFile = fileMatch[1];

          // Check if this file should be excluded
          const shouldExclude = EXCLUDED_FILES.some(
            excluded =>
              currentFile.includes(excluded) ||
              (excluded.includes('*') &&
                currentFile.match(excluded.replace('*', '.*')))
          );

          if (shouldExclude) {
            skipFile = true;
            console.log(`Excluding large file from analysis: ${currentFile}`);
          } else {
            skipFile = false;
          }
        }
      }

      if (!skipFile) {
        filteredLines.push(line);
      }
    }

    return filteredLines.join('\n');
  } catch (error) {
    throw new Error(
      `Failed to get changes from last ${numberOfCommits} commits: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function getChanges(
  options: AnalyzeOptions
): Promise<{ staged: string; unstaged: string; combined: string }> {
  const staged =
    options.staged ||
    options.both ||
    (!options.staged && !options.unstaged && !options.both)
      ? await getStagedChanges()
      : '';
  const unstaged =
    options.unstaged ||
    options.both ||
    (!options.staged && !options.unstaged && !options.both)
      ? await getUnstagedChanges()
      : '';

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

    const isPackageJsonVersionLine = /^[-+]\s*"version":\s*"[\d.]+",?\s*$/.test(
      line
    );
    const isHelmVersionLine = /^[-+](app)?[Vv]ersion:\s*[\d.]+\s*$/.test(line);

    if (isPackageJsonVersionLine || isHelmVersionLine) {
      // Check if the next line is also a version change (the + after -)
      const nextLine = lines[i + 1];
      if (nextLine) {
        const nextIsPackageJsonVersion =
          /^[-+]\s*"version":\s*"[\d.]+",?\s*$/.test(nextLine);
        const nextIsHelmVersion = /^[-+](app)?[Vv]ersion:\s*[\d.]+\s*$/.test(
          nextLine
        );

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
  const helmScriptExtensions = [
    '.sh',
    '.bash',
    '.py',
    '.js',
    '.ts',
    '.rb',
    '.pl',
    '.ps1',
    '.bat',
    '.cmd',
  ];

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
    if (
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('@@') ||
      line.startsWith('index ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.trim() === ''
    ) {
      continue;
    }

    // Check if current file is helm-related (excluding Chart.yaml)
    const isHelmRelated =
      currentFile.startsWith('helm/') && !currentFile.includes('Chart.yaml');

    if (isHelmRelated) {
      helmChanges = true;

      // Check if this is a Helm script file
      const isHelmScript = helmScriptExtensions.some(
        ext =>
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
  if (
    helmChanges &&
    helmScriptChanges &&
    !helmNonScriptChanges &&
    !appChanges
  ) {
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
    throw new Error(
      `Failed to read Helm Chart.yaml: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function writeHelmChart(chart: HelmChart): void {
  const chartPath = getHelmChartPath();

  try {
    const content = yaml.dump(chart, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    });
    writeFileSync(chartPath, content);
  } catch (error) {
    throw new Error(
      `Failed to write Helm Chart.yaml: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function bumpVersion(
  version: string,
  type: 'major' | 'minor' | 'patch'
): string {
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

async function analyzeWithOpenAI(
  changes: string,
  options: AnalyzeOptions
): Promise<'major' | 'minor' | 'patch'> {
  // Ensure we have an API key via config file, seeding from CLI option if provided
  const apiKey = await ensureAndGetOpenAIKey(options.apiKey);

  const openai = new OpenAI({
    apiKey,
  });

  // Truncate changes to ensure we stay within 8192 token limit
  // Reserve ~2000 tokens for the prompt template itself
  const truncatedChanges = truncateDiffForCommit(changes, 6000);
  
  // Create a hash of the input for debugging consistency
  const inputHash = createHash('sha256').update(truncatedChanges).digest('hex').substring(0, 8);
  console.log(`Analyzing changes (hash: ${inputHash})...`);

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
${truncatedChanges}

Respond with only one word: "major", "minor", or "patch".`;

  // Retry logic to ensure consistency
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model: options.model || 'gpt-5-nano',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 10,
        temperature: 0,
      });

      const rawResponse = completion.choices[0]?.message?.content?.trim();
      
      if (!rawResponse) {
        throw new Error('No response from OpenAI');
      }

      // Remove quotes and convert to lowercase
      const response = rawResponse
        .replace(/^["']|["']$/g, '') // Remove leading/trailing quotes
        .trim()
        .toLowerCase();

      if (!['major', 'minor', 'patch'].includes(response)) {
        throw new Error(`Invalid response from OpenAI: "${rawResponse}" (cleaned: "${response}")`);
      }

      return response as 'major' | 'minor' | 'patch';
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt < maxRetries) {
        console.log(`OpenAI API attempt ${attempt} failed, retrying... (${lastError.message})`);
        // Wait a bit before retrying
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  throw new Error(
    `OpenAI API error after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`
  );
}

async function executeVersionBump(
  versionType: 'major' | 'minor' | 'patch',
  changeType: ChangeType
): Promise<void> {
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
    throw new Error(
      `Failed to execute version bump: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function bumpHelmChartVersion(
  versionType: 'major' | 'minor' | 'patch'
): Promise<void> {
  const chart = readHelmChart();

  if (!chart) {
    throw new Error(
      'Helm Chart.yaml not found. Cannot bump Helm chart version.'
    );
  }

  if (!chart.version) {
    throw new Error('Helm Chart.yaml does not contain a version field.');
  }

  const newVersion = bumpVersion(chart.version, versionType);
  chart.version = newVersion;

  writeHelmChart(chart);
  console.log(`Updated Helm chart version to ${newVersion}`);
}

async function bumpNpmVersion(
  versionType: 'major' | 'minor' | 'patch'
): Promise<void> {
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
    console.log(
      `Bumping npm version from ${packageJson.version} to ${newVersion}`
    );

    // Update package.json
    packageJson.version = newVersion;
    writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

    console.log(`Updated package.json version to ${newVersion}`);

    // Update package-lock.json with the new version
    await updatePackageLockVersion();
  } catch (error) {
    throw new Error(
      `Failed to bump npm version: ${error instanceof Error ? error.message : String(error)}`
    );
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
      console.log(
        'package-lock.json not found. Skipping package-lock.json update.'
      );
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
    console.log(
      'Warning: Could not update package-lock.json version:',
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function filterLargeFilesFromDiff(diff: string): string {
  const lines = diff.split('\n');
  const filteredLines: string[] = [];
  let skipFile = false;
  let currentFile = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this is a file header line (diff --git a/file b/file)
    if (line.startsWith('diff --git')) {
      const fileMatch = line.match(/diff --git a\/(.+?) b\/(.+?)$/);
      if (fileMatch) {
        currentFile = fileMatch[1];

        // Check if this file should be excluded
        const shouldExclude = EXCLUDED_FILES.some(
          excluded =>
            currentFile.includes(excluded) ||
            (excluded.includes('*') &&
              currentFile.match(excluded.replace('*', '.*')))
        );

        if (shouldExclude) {
          skipFile = true;
          // Add a summary line instead of the full diff
          filteredLines.push(`diff --git a/${currentFile} b/${currentFile}`);
          filteredLines.push(`index 0000000..0000000 100644`);
          filteredLines.push(`--- a/${currentFile}`);
          filteredLines.push(`+++ b/${currentFile}`);
          filteredLines.push(`@@ -0,0 +1,0 @@`);
          filteredLines.push(
            `+[${currentFile} changed - content excluded from commit message]`
          );
          filteredLines.push('');
          continue;
        } else {
          skipFile = false;
        }
      }
    }

    // If we're not skipping this file, add the line
    if (!skipFile) {
      filteredLines.push(line);
    }
  }

  return filteredLines.join('\n');
}

export function filterDeletedFilesFromDiff(diff: string): string {
  const lines = diff.split('\n');
  const filteredLines: string[] = [];
  let skipDeletedFile = false;
  let currentFile = '';
  let isDeleted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this is a file header line (diff --git a/file b/file)
    if (line.startsWith('diff --git')) {
      const fileMatch = line.match(/diff --git a\/(.+?) b\/(.+?)$/);
      if (fileMatch) {
        currentFile = fileMatch[1];
        skipDeletedFile = false;
        isDeleted = false;
      }
      filteredLines.push(line);
      continue;
    }

    // Check for deleted file mode indicator
    if (line.startsWith('deleted file mode')) {
      isDeleted = true;
      skipDeletedFile = true;
      // Add a summary instead of the full diff
      filteredLines.push(`deleted file mode ${line.split(' ').pop()}`);
      filteredLines.push(`--- a/${currentFile}`);
      filteredLines.push(`+++ /dev/null`);
      filteredLines.push(`@@ File deleted: ${currentFile} @@`);
      filteredLines.push('');
      continue;
    }

    // Skip all content lines for deleted files
    if (skipDeletedFile) {
      // Skip lines until we reach the next file
      continue;
    }

    // Add all other lines
    filteredLines.push(line);
  }

  return filteredLines.join('\n');
}

async function commitVersionBump(
  versionType: 'major' | 'minor' | 'patch',
  numberOfCommits: number,
  options: AnalyzeOptions
): Promise<void> {
  try {
    const git = simpleGit();

    // Stage the version files
    const filesToStage: string[] = [];
    
    const packageJsonPath = join(process.cwd(), 'package.json');
    if (existsSync(packageJsonPath)) {
      filesToStage.push('package.json');
      
      const packageLockPath = join(process.cwd(), 'package-lock.json');
      if (existsSync(packageLockPath)) {
        filesToStage.push('package-lock.json');
      }
    }
    
    const helmChartPath = getHelmChartPath();
    if (existsSync(helmChartPath)) {
      filesToStage.push('helm/Chart.yaml');
    }

    if (filesToStage.length === 0) {
      console.log('No version files to commit.');
      return;
    }

    // Stage the files
    await git.add(filesToStage);

    // Create commit message
    const commitMessage = `chore: bump version to ${versionType} based on last ${numberOfCommits} commit(s)`;

    // Commit
    await git.commit(commitMessage);

    console.log(`\nSuccessfully committed version bump with message:\n"${commitMessage}"`);
  } catch (error) {
    throw new Error(
      `Failed to commit version bump: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function generateCommitMessageAndCommit(
  options: AnalyzeOptions
): Promise<void> {
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
    } else if (
      options.both ||
      (!options.staged && !options.unstaged && !options.both)
    ) {
      // Stage all changes (both staged and unstaged) and commit
      await git.add('.');
      diff = await git.diff(['--cached']);
    }

    if (!diff.trim()) {
      console.log('No changes to commit.');
      return;
    }

    // Filter out large files from diff for commit message generation
    let filteredDiff = filterLargeFilesFromDiff(diff);
    
    // Filter out deleted files diffs (keep only summary)
    filteredDiff = filterDeletedFilesFromDiff(filteredDiff);

    // Log if any large files were filtered out
    if (filteredDiff !== diff) {
      console.log(
        'Note: Large files (like package-lock.json) and deleted file diffs are excluded from commit message generation to avoid token limits.'
      );
    }

    // Generate commit message using OpenAI with filtered diff
    const commitMessage = await generateCommitMessage(filteredDiff, options);

    // Commit with the generated message
    await git.commit(commitMessage);

    console.log(`Committed changes with message: ${commitMessage}`);
  } catch (error) {
    throw new Error(
      `Failed to commit changes: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Rough token estimation (approximately 1 token per 4 characters)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Intelligently truncate diff to fit within token limits
function truncateDiffForCommit(diff: string, maxTokens: number = 6000): string {
  const estimatedTokens = estimateTokens(diff);
  
  if (estimatedTokens <= maxTokens) {
    return diff;
  }

  console.log(`Diff is too large (estimated ${estimatedTokens} tokens). Applying intelligent truncation...`);

  const lines = diff.split('\n');
  const truncatedLines: string[] = [];
  let currentTokens = 0;
  const targetTokens = maxTokens;
  
  // Strategy 1: Keep file headers and context, truncate large file contents
  const files: { header: string[], content: string[], stats: { additions: number, deletions: number } }[] = [];
  let currentFile: { header: string[], content: string[], stats: { additions: number, deletions: number } } | null = null;
  
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (currentFile) {
        files.push(currentFile);
      }
      currentFile = { header: [line], content: [], stats: { additions: 0, deletions: 0 } };
    } else if (currentFile) {
      // Metadata lines go in header
      if (line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++') || 
          line.startsWith('new file mode') || line.startsWith('deleted file mode') ||
          line.startsWith('@@')) {
        currentFile.header.push(line);
      } else {
        // Content lines
        currentFile.content.push(line);
        if (line.startsWith('+') && !line.startsWith('+++')) {
          currentFile.stats.additions++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          currentFile.stats.deletions++;
        }
      }
    }
  }
  
  if (currentFile) {
    files.push(currentFile);
  }

  // Strategy 2: Prioritize smaller files and summaries
  const result: string[] = [];
  let tokensUsed = 0;
  
  for (const file of files) {
    const headerText = file.header.join('\n');
    const headerTokens = estimateTokens(headerText);
    
    // Always include the header
    result.push(headerText);
    tokensUsed += headerTokens;
    
    const contentText = file.content.join('\n');
    const contentTokens = estimateTokens(contentText);
    
    // If this file fits, include it fully
    if (tokensUsed + contentTokens < targetTokens) {
      result.push(contentText);
      tokensUsed += contentTokens;
    } else {
      // Truncate this file's content
      const remainingTokens = targetTokens - tokensUsed;
      const remainingChars = remainingTokens * 4;
      
      if (remainingChars > 200) {
        // Include partial content with summary
        const partialContent = file.content.slice(0, Math.floor(file.content.length * 0.3)).join('\n');
        const truncatedPartial = partialContent.substring(0, remainingChars - 200);
        result.push(truncatedPartial);
        result.push(`\n... [${file.stats.additions} additions, ${file.stats.deletions} deletions - content truncated] ...\n`);
        tokensUsed = targetTokens;
        break;
      } else {
        // Just add summary
        result.push(`... [${file.stats.additions} additions, ${file.stats.deletions} deletions - content truncated] ...\n`);
        tokensUsed = targetTokens;
        break;
      }
    }
  }
  
  const truncatedDiff = result.join('\n');
  console.log(`Truncated diff from ${estimatedTokens} to approximately ${estimateTokens(truncatedDiff)} tokens`);
  
  return truncatedDiff;
}

async function generateCommitMessage(
  diff: string,
  options: AnalyzeOptions
): Promise<string> {
  // Ensure we have an API key via config file, seeding from CLI option if provided
  const apiKey = await ensureAndGetOpenAIKey(options.apiKey);

  const openai = new OpenAI({
    apiKey,
  });

  // Truncate diff to ensure we stay within 8192 token limit
  // Reserve ~2000 tokens for the prompt template itself
  const truncatedDiff = truncateDiffForCommit(diff, 6000);

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
- If the diff is truncated, focus on the visible changes

Git diff:
${truncatedDiff}

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
    throw new Error(
      `OpenAI API error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
