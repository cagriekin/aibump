# aibump

An AI-powered command line tool that analyzes your git unstaged changes and automatically determines whether to bump the npm version as major, minor, or patch using OpenAI's API. It intelligently handles both Node.js applications and Helm charts:

- **Helm-only changes**: Bumps the version in `helm/Chart.yaml` without touching `package.json`
- **App changes**: Bumps `package.json` version and syncs `appVersion` in `helm/Chart.yaml` to match
- **Mixed changes**: Bumps both versions appropriately

## Installation

```bash
npm install aibump -g
```

## Usage

Navigate to any npm project with git and run:

```bash
aibump
```

## Options

- `-k, --api-key <key>`: OpenAI API key (can also be set via `OPENAI_API_KEY` environment variable)
- `-m, --model <model>`: OpenAI model to use (default: gpt-4)
- `--dry-run`: Show what would be done without making changes
- `--no-commit`: Skip generating commit message and committing changes (commit is enabled by default)

## Prerequisites

- Must be run in a git repository
- Must have a `package.json` file in the current directory
- OpenAI API key must be provided

## How it works

1. Validates that you're in a git repository with a package.json
2. Gets the unstaged changes using `git diff`
3. Analyzes changes to determine if they're in the `helm/` directory, Node.js app, or both
4. Sends the changes to OpenAI with a prompt asking for semantic version bump type
5. Based on the change type and response:
   - **Helm-only changes**: Bumps version in `helm/Chart.yaml`
   - **App changes**: Bumps `package.json` version and syncs `appVersion` in `helm/Chart.yaml`
   - **Mixed changes**: Bumps both versions appropriately
6. Generates a conventional commit message using OpenAI and commits all changes (unless `--no-commit` is used)

## Example

```bash
cd my-npm-project
# Make some changes...
aibump
```

Output:
```
Found unstaged changes:
diff --git a/src/index.js b/src/index.js
+ console.log('New feature added');

Change type detected: app-only
Recommended version bump: minor
Running: npm version minor
Updated Helm chart appVersion to 1.1.0
Version bump completed successfully.
Committed changes with message: feat: add new feature logging
```

## Helm Chart Support

The tool automatically detects changes in your `helm/` directory and handles versioning appropriately:

- **Helm-only changes**: Only bumps the `version` field in `helm/Chart.yaml`
- **App changes**: Bumps `package.json` and sets `appVersion` in `helm/Chart.yaml` to match
- **Mixed changes**: Bumps both versions

Make sure your `helm/Chart.yaml` exists and has a `version` field for Helm versioning to work.

## License

MIT
