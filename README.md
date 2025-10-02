# aibump

An AI-powered command line tool that analyzes your git unstaged changes and automatically determines whether to bump the npm version as major, minor, or patch using OpenAI's API. It intelligently handles both Node.js applications and Helm charts:

- **Helm-only changes**: Bumps the version in `helm/Chart.yaml` without touching `package.json`
- **Helm script changes**: Only bumps Helm chart version when only scripts (`.sh`, `.py`, `.js`, etc.) in `helm/scripts/` or `helm/hooks/` change
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
- `--staged`: Analyze only staged changes
- `--unstaged`: Analyze only unstaged changes
- `--both`: Analyze both staged and unstaged changes (default behavior)
- `--last-commits <number>`: Analyze the last N commits instead of working directory changes

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
   - **Helm script changes**: Only bumps Helm chart version (no package.json bump)
   - **App changes**: Bumps `package.json` version and syncs `appVersion` in `helm/Chart.yaml`
   - **Mixed changes**: Bumps both versions appropriately
6. Generates a structured commit message using OpenAI and commits all changes (unless `--no-commit` is used)

## Commit Message Format

The tool generates structured commit messages with:

- A conventional commit header: `type(scope): brief summary`
- A bullet list highlighting the most important changes
- Focus on what changed and its impact

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

- Add console logging for new feature
- Update version to 1.1.0
- Sync Helm chart appVersion
```

## Analyzing Historical Commits

You can analyze the last N commits instead of working directory changes using the `--last-commits` option:

```bash
aibump --last-commits 5
```

This is useful for:
- **Retrospective versioning**: Bump version based on already-committed work
- **Release preparation**: Analyze what changed since last release
- **CI/CD pipelines**: Automatically determine version bump based on merged commits

When using `--last-commits`:
- The tool analyzes changes introduced by the last N commits (using `git diff HEAD~N HEAD`)
- It determines the appropriate version bump based on those changes
- It commits the version bump with a message like: `chore: bump version to minor based on last 5 commit(s)`
- You **cannot** combine it with `--staged`, `--unstaged`, or `--both` options

### Example

```bash
# Analyze last 3 commits and bump version
aibump --last-commits 3

# Dry run to see what would happen
aibump --last-commits 10 --dry-run
```

Output:
```
Analyzing changes from the last 3 commit(s)...
Found relevant changes in the last 3 commit(s) (large files excluded)
Change type detected: app-only
Recommended version bump: minor
Bumping npm version from 1.0.0 to 1.1.0
Updated package.json version to 1.1.0
Updated package-lock.json version to 1.1.0
Updated Helm chart appVersion to 1.1.0
Version bump completed successfully.

Committing version bump changes...
Successfully committed version bump with message:
"chore: bump version to minor based on last 3 commit(s)"
```

## Helm Chart Support

The tool automatically detects changes in your `helm/` directory and handles versioning appropriately:

- **Helm-only changes**: Only bumps the `version` field in `helm/Chart.yaml`
- **Helm script changes**: Only bumps Helm chart version when only scripts (`.sh`, `.py`, `.js`, `.ts`, `.rb`, `.pl`, `.ps1`, `.bat`, `.cmd`) in `helm/scripts/` or `helm/hooks/` directories change
- **App changes**: Bumps `package.json` and sets `appVersion` in `helm/Chart.yaml` to match
- **Mixed changes**: Bumps both versions

Make sure your `helm/Chart.yaml` exists and has a `version` field for Helm versioning to work.

## License

MIT
