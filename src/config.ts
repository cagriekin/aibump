import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import os from 'os';
import readline from 'readline';

const CONFIG_DIR = join(os.homedir(), '.config');
const CONFIG_PATH = join(CONFIG_DIR, 'aibump');

function parseKeyFromConfig(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  try {
    const config = JSON.parse(trimmed);
    if (config && typeof config.openaiApiKey === 'string') {
      return config.openaiApiKey;
    }
  } catch (error) {
    // Invalid JSON format
    return null;
  }

  return null;
}

async function promptForApiKey(): Promise<string> {
  const question =
    'Enter your OpenAI API key (will be saved to ~/.config/aibump): ';

  return new Promise<string>(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const originalWrite = (rl as any)._writeToOutput;
    (rl as any)._writeToOutput = function (stringToWrite: string) {
      // Show the question, mask subsequent input
      if (stringToWrite.includes(question)) {
        originalWrite.call(rl, stringToWrite);
      } else {
        originalWrite.call(rl, '*');
      }
    };

    rl.question(question, answer => {
      (rl as any)._writeToOutput = originalWrite;
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function ensureAndGetOpenAIKey(
  initialFromCli?: string
): Promise<string> {
  // If config file exists, read and return the key
  if (existsSync(CONFIG_PATH)) {
    const content = readFileSync(CONFIG_PATH, 'utf-8');
    const key = parseKeyFromConfig(content);
    if (key) return key;
  }

  // Ensure config dir exists with secure permissions
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  // Prefer CLI-provided key if given; otherwise prompt
  const key =
    (initialFromCli && initialFromCli.trim()) || (await promptForApiKey());

  if (!key) {
    throw new Error('OpenAI API key is required.');
  }

  // Write config file with secure permissions in JSON format
  const config = { openaiApiKey: key };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log(`Saved OpenAI API key to ${CONFIG_PATH}`);

  return key;
}
