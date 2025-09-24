# npm-version-tool

A command line tool that analyzes your git unstaged changes and automatically determines whether to bump the npm version as major, minor, or patch using OpenAI's API. It updates both package.json and package-lock.json with the new version.

## Installation

```bash
npm install -g .
```

Or run locally:

```bash
npm install
npm run build
npm link
```

## Usage

Navigate to any npm project with git and run:

```bash
npm-version-tool
```

## Options

- `-k, --api-key <key>`: OpenAI API key (can also be set via `OPENAI_API_KEY` environment variable)
- `-m, --model <model>`: OpenAI model to use (default: gpt-4)
- `--dry-run`: Show what would be done without making changes
- `-f, --force`: Force version bump even with uncommitted changes

## Prerequisites

- Must be run in a git repository
- Must have a `package.json` file in the current directory
- Git working directory must be clean (or use `--force` to override)
- OpenAI API key must be provided

## How it works

1. Validates that you're in a git repository with a package.json
2. Gets the unstaged changes using `git diff`
3. Sends the changes to OpenAI with a prompt asking for semantic version bump type
4. Based on the response (major/minor/patch), runs `npm version <type>` and updates both package.json and package-lock.json

## Example

```bash
cd my-npm-project
# Make some changes...
npm-version-tool --api-key your-openai-key

# If you have uncommitted changes and want to force the version bump:
npm-version-tool --api-key your-openai-key --force
```

Output:
```
Found unstaged changes:
diff --git a/src/index.js b/src/index.js
+ console.log('New feature added');

Recommended version bump: minor
Running: npm version minor
```

## License

MIT
