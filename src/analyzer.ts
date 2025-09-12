import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import simpleGit from 'simple-git';
import OpenAI from 'openai';
import { execa } from 'execa';

export interface AnalyzeOptions {
  apiKey?: string;
  model?: string;
  dryRun?: boolean;
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

  // Analyze with OpenAI
  const versionType = await analyzeWithOpenAI(changes, options);

  console.log(`Recommended version bump: ${versionType}`);

  if (options.dryRun) {
    console.log(`Would run: npm version ${versionType}`);
    return;
  }

  // Execute version bump
  await executeVersionBump(versionType);
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
    const diff = await git.diff(['--no-pager']);
    return diff;
  } catch (error) {
    throw new Error(`Failed to get git diff: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function analyzeWithOpenAI(changes: string, options: AnalyzeOptions): Promise<'major' | 'minor' | 'patch'> {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OpenAI API key not provided. Use --api-key option or set OPENAI_API_KEY environment variable.');
  }

  const openai = new OpenAI({
    apiKey: apiKey,
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

async function executeVersionBump(versionType: 'major' | 'minor' | 'patch'): Promise<void> {
  try {
    console.log(`Running: npm version ${versionType}`);
    const result = await execa('npm', ['version', versionType], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    if (result.exitCode !== 0) {
      throw new Error(`npm version command failed with exit code ${result.exitCode}`);
    }

    console.log('Version bump completed successfully.');
  } catch (error) {
    throw new Error(`Failed to execute version bump: ${error instanceof Error ? error.message : String(error)}`);
  }
}
