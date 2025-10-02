#!/usr/bin/env node

// Suppress Node.js warnings
process.env.NODE_NO_WARNINGS = '1';

import { Command } from 'commander';
import { analyzeChanges } from './analyzer';
import { readFileSync } from 'fs';
import { join } from 'path';

// Read version from package.json
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '../package.json'), 'utf8')
);

const program = new Command();

program
  .name('aibump')
  .description(
    'AI-powered CLI tool that analyzes git changes and automatically bumps npm and Helm versions'
  )
  .option('--version', 'display version number')
  .option(
    '-k, --api-key <key>',
    'OpenAI API key (will be saved to ~/.config/aibump)'
  )
  .option('-m, --model <model>', 'OpenAI model to use', 'gpt-4')
  .option('--dry-run', 'Show what would be done without making changes')
  .option(
    '--no-commit',
    'Skip generating commit message and committing changes'
  )
  .option('--staged', 'Analyze only staged changes')
  .option('--unstaged', 'Analyze only unstaged changes')
  .option(
    '--both',
    'Analyze both staged and unstaged changes (default behavior)'
  )
  .option(
    '--last-commits <number>',
    'Analyze the last N commits instead of working directory changes'
  )
  .action(async options => {
    try {
      // Handle --version option
      if (options.version) {
        console.log(packageJson.version);
        return;
      }

      await analyzeChanges(options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
    }
  });

program.parse();
