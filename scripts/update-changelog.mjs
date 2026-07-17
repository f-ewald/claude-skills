#!/usr/bin/env node

/**
 * Generates CHANGELOG.md from the repository's first-parent commit history.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_MARKER = '[skip changelog]';
const USAGE = `Usage: node scripts/update-changelog.mjs [--check]

Options:
  --check  Exit with an error when CHANGELOG.md is not current.
  --help   Show this help text.
`;

/**
 * Converts one tab-separated git-log line into a changelog commit.
 *
 * @param {string} line - A line emitted by the configured git-log format.
 * @returns {{ hash: string, shortHash: string, date: string, subject: string }} Parsed commit details.
 * @throws {Error} If the line does not contain the expected fields.
 */
function parseGitLogLine(line) {
  const [hash, shortHash, date, ...subjectParts] = line.split('\t');
  if (!hash || !shortHash || !date || subjectParts.length === 0) {
    throw new Error(`Unexpected git log entry: ${JSON.stringify(line)}`);
  }
  return {
    hash,
    shortHash,
    date,
    subject: subjectParts.join('\t'),
  };
}

/**
 * Parses the machine-readable git-log output used by this generator.
 *
 * @param {string} output - Complete git-log output.
 * @returns {Array<{ hash: string, shortHash: string, date: string, subject: string }>} Parsed commits.
 */
export function parseGitLog(output) {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseGitLogLine);
}

/**
 * Reads commits from the current first-parent history.
 *
 * @param {string} repositoryRoot - Absolute repository root.
 * @returns {Array<{ hash: string, shortHash: string, date: string, subject: string }>} Newest-first commits.
 */
export function readCommits(repositoryRoot) {
  const output = execFileSync(
    'git',
    ['log', '--first-parent', '--format=%H%x09%h%x09%cs%x09%s', 'HEAD'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return parseGitLog(output);
}

/**
 * Escapes untrusted commit subjects for safe Markdown rendering.
 *
 * @param {string} text - Plain commit-subject text.
 * @returns {string} Markdown-safe text.
 */
function escapeMarkdown(text) {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_[\]~])/g, '\\$1');
}

/**
 * Determines whether a commit belongs in the generated changelog.
 *
 * @param {{ subject: string }} commit - Commit to inspect.
 * @returns {boolean} Whether to include the commit.
 */
function shouldIncludeCommit(commit) {
  return !commit.subject.toLowerCase().includes(SKIP_MARKER);
}

/**
 * Renders commits as a deterministic, date-grouped changelog.
 *
 * @param {Array<{ hash: string, shortHash: string, date: string, subject: string }>} commits - Newest-first commits.
 * @returns {string} Complete CHANGELOG.md contents.
 */
export function renderChangelog(commits) {
  const lines = [
    '# Changelog',
    '',
    "This file is generated from the repository's first-parent commit history by",
    '[`scripts/update-changelog.mjs`](scripts/update-changelog.mjs). Do not edit it manually.',
  ];
  let currentDate = null;

  for (const commit of commits.filter(shouldIncludeCommit)) {
    if (commit.date !== currentDate) {
      currentDate = commit.date;
      lines.push('', `## ${currentDate}`, '');
    }
    const subject = escapeMarkdown(commit.subject || '(no commit subject)');
    const commitLink = `../../commit/${commit.hash}`;
    lines.push(`- ${subject} ([\`${commit.shortHash}\`](${commitLink}))`);
  }

  if (currentDate === null) {
    lines.push('', '_No changes recorded._');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Finds the root of the Git repository containing a working directory.
 *
 * @param {string} workingDirectory - Directory from which to resolve the repository.
 * @returns {string} Absolute repository root.
 */
function findRepositoryRoot(workingDirectory) {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: workingDirectory,
    encoding: 'utf8',
  }).trim();
}

/**
 * Writes or checks the generated changelog.
 *
 * @param {string} repositoryRoot - Absolute repository root.
 * @param {boolean} checkOnly - Whether to check without writing.
 * @returns {boolean} Whether the existing changelog already matched.
 */
export function updateChangelog(repositoryRoot, checkOnly = false) {
  const changelogPath = join(repositoryRoot, 'CHANGELOG.md');
  const generated = renderChangelog(readCommits(repositoryRoot));
  const current = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : null;
  if (current === generated) {
    return true;
  }
  if (checkOnly) {
    return false;
  }
  writeFileSync(changelogPath, generated);
  return false;
}

/**
 * Runs the changelog command-line interface.
 *
 * @param {string[]} args - Command-line arguments after the script path.
 * @param {string} workingDirectory - Directory from which to locate the repository.
 * @returns {number} Process exit code.
 */
export function main(args, workingDirectory = process.cwd()) {
  if (args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const unknownArguments = args.filter((argument) => argument !== '--check');
  if (unknownArguments.length > 0) {
    process.stderr.write(`Unknown argument: ${unknownArguments[0]}\n${USAGE}`);
    return 2;
  }

  const checkOnly = args.includes('--check');
  const repositoryRoot = findRepositoryRoot(workingDirectory);
  const current = updateChangelog(repositoryRoot, checkOnly);
  if (checkOnly && !current) {
    process.stderr.write('CHANGELOG.md is out of date. Run node scripts/update-changelog.mjs.\n');
    return 1;
  }
  process.stdout.write(current ? 'CHANGELOG.md is up to date.\n' : 'Updated CHANGELOG.md.\n');
  return 0;
}

const scriptPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (scriptPath === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), dirname(scriptPath));
}
