#!/usr/bin/env node

import { Command } from 'commander';
import { analyzeChanges } from './analyzer';

const program = new Command();

program
  .name('npm-version-tool')
  .description('CLI tool that analyzes git changes and automatically bumps npm version')
  .version('1.0.0')
  .option('-k, --api-key <key>', 'OpenAI API key (will be saved to ~/.config/version-tool)')
  .option('-m, --model <model>', 'OpenAI model to use', 'gpt-4')
  .option('--dry-run', 'Show what would be done without making changes')
  .action(async (options) => {
    try {
      await analyzeChanges(options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.parse();
