import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import simpleGit from 'simple-git';
import OpenAI from 'openai';
import { execa } from 'execa';
import * as yaml from 'js-yaml';
import { ensureAndGetOpenAIKey } from './config';

export interface AnalyzeOptions {
  apiKey?: string;
  model?: string;
  dryRun?: boolean;
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

  // Get unstaged changes
  const changes = await getUnstagedChanges();

  if (!changes.trim()) {
    console.log('No unstaged changes found. Nothing to analyze.');
    return;
  }

  console.log('Found unstaged changes:\n', changes);

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

async function getUnstagedChanges(): Promise<string> {
  const git = simpleGit();

  try {
    // Get diff of unstaged changes
    const diff = await git.diff();
    return diff;
  } catch (error) {
    throw new Error(`Failed to get git diff: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function detectChangeType(changes: string): ChangeType {
  const lines = changes.split('\n');
  let helmChanges = false;
  let appChanges = false;

  for (const line of lines) {
    // Check for helm directory changes
    if (line.includes('helm/') && !line.includes('helm/Chart.yaml')) {
      helmChanges = true;
    }
    // Check for app changes (everything except helm directory)
    if (!line.startsWith('---') && !line.startsWith('+++') && !line.startsWith('@@') &&
      !line.includes('helm/') && line.trim() !== '') {
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

  const prompt = `Analyze the following git diff and determine what type of version bump is appropriate according to semantic versioning (semver):

MAJOR: Breaking changes (incompatible API changes)
MINOR: New features (backwards compatible)
PATCH: Bug fixes (backwards compatible)

Git diff:
${changes}

Respond with only one word: "major", "minor", or "patch".`;

  try {
    const completion = await openai.chat.completions.create({
      model: options.model || 'gpt-4',
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
