#!/usr/bin/env node

import { Command } from 'commander';
import { analyzeChanges } from './analyzer';

const program = new Command();

program
  .name('aibump')
  .description('AI-powered CLI tool that analyzes git changes and automatically bumps npm and Helm versions')
  .version('1.0.0')
  .option('-k, --api-key <key>', 'OpenAI API key (will be saved to ~/.config/aibump)')
  .option('-m, --model <model>', 'OpenAI model to use', 'gpt-4')
  .option('--dry-run', 'Show what would be done without making changes')
  .option('--no-commit', 'Skip generating commit message and committing changes')
  .action(async (options) => {
    try {
      await analyzeChanges(options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.parse();
