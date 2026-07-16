#!/usr/bin/env node

/**
 * Validates the repository's intentionally small Agent Skills frontmatter subset.
 *
 * This is not a general YAML parser. It supports top-level scalar fields plus a
 * one-level `metadata` mapping, which is the complete shape used by this repo.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_FIELDS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GENERATED_WORKFLOW_PATTERN = /^(?:my-.+|.+\.run)\.mjs$|^uc-hello\.mjs$|(?:^|[-.])result\.json$/;
const CATALOG_START = '<!-- skill-catalog:start -->';
const CATALOG_END = '<!-- skill-catalog:end -->';

/**
 * Removes matching YAML-style quotes from a scalar value.
 *
 * @param {string} value - Raw scalar text.
 * @returns {string} The unquoted value.
 */
function unquote(value) {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Extracts the YAML frontmatter block and Markdown body.
 *
 * @param {string} text - Complete SKILL.md contents.
 * @param {string} filePath - Path used in validation errors.
 * @returns {{ frontmatter: string, body: string }} Parsed file sections.
 * @throws {Error} If frontmatter delimiters are missing.
 */
export function extractFrontmatter(text, filePath = 'SKILL.md') {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new Error(`${filePath}: missing or malformed YAML frontmatter`);
  }
  return {
    frontmatter: match[1],
    body: text.slice(match[0].length),
  };
}

/**
 * Parses the repository's bounded frontmatter shape.
 *
 * @param {string} frontmatter - Text between the YAML delimiters.
 * @param {string} filePath - Path used in validation errors.
 * @returns {Record<string, string | Record<string, string>>} Parsed fields.
 * @throws {Error} If unsupported YAML structure is used.
 */
export function parseFrontmatter(frontmatter, filePath = 'SKILL.md') {
  const result = {};
  let mappingKey = null;

  for (const [index, rawLine] of frontmatter.split(/\r?\n/).entries()) {
    const lineNumber = index + 2;
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    const separator = line.indexOf(':');
    if (separator === -1) {
      throw new Error(`${filePath}:${lineNumber}: expected "key: value"`);
    }

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (indent === 0) {
      if (!rawValue && key !== 'metadata') {
        throw new Error(`${filePath}:${lineNumber}: "${key}" requires a scalar value`);
      }
      mappingKey = rawValue ? null : key;
      result[key] = rawValue ? unquote(rawValue) : {};
      continue;
    }

    if (indent !== 2 || mappingKey !== 'metadata') {
      throw new Error(`${filePath}:${lineNumber}: unsupported nested YAML structure`);
    }
    result.metadata[key] = unquote(rawValue);
  }

  return result;
}

/**
 * Extracts relative Markdown-link targets from a skill body.
 *
 * @param {string} markdown - Skill Markdown body.
 * @returns {string[]} Relative file references.
 */
export function extractRelativeLinks(markdown) {
  const links = [];
  const pattern = /\[[^\]]*]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(pattern)) {
    const target = match[1].trim().split(/\s+/)[0];
    if (!target || target.startsWith('#') || /^[a-z]+:/i.test(target)) {
      continue;
    }
    links.push(target.replace(/^<|>$/g, ''));
  }
  return links;
}

/**
 * Validates one skill directory.
 *
 * @param {string} skillDirectory - Absolute skill directory path.
 * @returns {string[]} Validation errors.
 */
export function validateSkill(skillDirectory) {
  const errors = [];
  const skillPath = join(skillDirectory, 'SKILL.md');
  const skillName = basename(skillDirectory);
  if (!existsSync(skillPath)) {
    return [`${skillPath}: missing SKILL.md`];
  }

  let parsed;
  let body;
  try {
    const sections = extractFrontmatter(readFileSync(skillPath, 'utf8'), skillPath);
    parsed = parseFrontmatter(sections.frontmatter, skillPath);
    body = sections.body;
  } catch (error) {
    return [error.message];
  }

  for (const key of Object.keys(parsed)) {
    if (!SUPPORTED_FIELDS.has(key)) {
      errors.push(`${skillPath}: unsupported top-level field "${key}"`);
    }
  }
  for (const key of ['name', 'description', 'license', 'compatibility', 'allowed-tools']) {
    if (typeof parsed[key] !== 'undefined' && typeof parsed[key] !== 'string') {
      errors.push(`${skillPath}: "${key}" must be a scalar string`);
    }
  }

  if (!parsed.name) {
    errors.push(`${skillPath}: missing required "name"`);
  } else {
    if (parsed.name !== skillName) {
      errors.push(`${skillPath}: name "${parsed.name}" does not match folder "${skillName}"`);
    }
    if (!NAME_PATTERN.test(parsed.name) || parsed.name.length > 64) {
      errors.push(`${skillPath}: invalid Agent Skills name "${parsed.name}"`);
    }
  }

  if (!parsed.description) {
    errors.push(`${skillPath}: missing required "description"`);
  } else {
    if (parsed.description.length > 1024) {
      errors.push(`${skillPath}: description exceeds 1024 characters`);
    }
    if (!/\buse when\b/i.test(parsed.description)) {
      errors.push(`${skillPath}: description must state when to use the skill`);
    }
  }

  if (parsed.compatibility && parsed.compatibility.length > 500) {
    errors.push(`${skillPath}: compatibility exceeds 500 characters`);
  }
  if (typeof parsed.metadata !== 'undefined' && typeof parsed.metadata !== 'object') {
    errors.push(`${skillPath}: metadata must be a mapping`);
  }
  if (typeof parsed['allowed-tools'] === 'string' && parsed['allowed-tools'].includes(',')) {
    errors.push(`${skillPath}: allowed-tools must be space-separated`);
  }

  for (const target of extractRelativeLinks(body)) {
    const pathWithoutAnchor = target.split('#')[0];
    if (pathWithoutAnchor && !existsSync(resolve(skillDirectory, pathWithoutAnchor))) {
      errors.push(`${skillPath}: missing referenced file "${target}"`);
    }
  }

  return errors;
}

/**
 * Validates one skill's machine-readable behavior scenarios.
 *
 * @param {string} skillDirectory - Absolute skill directory path.
 * @returns {string[]} Validation errors.
 */
export function validateEvals(skillDirectory) {
  const errors = [];
  const evalsPath = join(skillDirectory, 'evals.json');
  const skillName = basename(skillDirectory);
  if (!existsSync(evalsPath)) {
    return [`${evalsPath}: missing per-skill behavior scenarios`];
  }

  let document;
  try {
    document = JSON.parse(readFileSync(evalsPath, 'utf8'));
  } catch (error) {
    return [`${evalsPath}: invalid JSON (${error.message})`];
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return [`${evalsPath}: top-level value must be an object`];
  }

  if (document.version !== 1) {
    errors.push(`${evalsPath}: version must be 1`);
  }
  if (document.skill !== skillName) {
    errors.push(`${evalsPath}: skill "${document.skill}" does not match folder "${skillName}"`);
  }
  if (!Array.isArray(document.cases) || document.cases.length === 0) {
    errors.push(`${evalsPath}: cases must be a non-empty array`);
    return errors;
  }

  const names = new Set();
  for (const [index, scenario] of document.cases.entries()) {
    const location = `${evalsPath}: cases[${index}]`;
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
      errors.push(`${location} must be an object`);
      continue;
    }
    if (typeof scenario.name !== 'string' || !scenario.name.trim()) {
      errors.push(`${location}.name must be a non-empty string`);
    } else if (names.has(scenario.name)) {
      errors.push(`${location}.name duplicates "${scenario.name}"`);
    } else {
      names.add(scenario.name);
    }
    if (typeof scenario.prompt !== 'string' || !scenario.prompt.trim()) {
      errors.push(`${location}.prompt must be a non-empty string`);
    }
    if (!Array.isArray(scenario.expect) || scenario.expect.length === 0) {
      errors.push(`${location}.expect must be a non-empty array`);
    }
    for (const field of ['expect', 'reject']) {
      if (typeof scenario[field] !== 'undefined'
          && (!Array.isArray(scenario[field])
            || scenario[field].some((entry) => typeof entry !== 'string' || !entry.trim()))) {
        errors.push(`${location}.${field} must contain only non-empty strings`);
      }
    }
  }
  return errors;
}

/**
 * Reads the machine-checkable README skill catalog.
 *
 * @param {string} readme - README contents.
 * @returns {string[]} Catalog skill names.
 * @throws {Error} If catalog markers are absent.
 */
export function readCatalogSkills(readme) {
  const start = readme.indexOf(CATALOG_START);
  const end = readme.indexOf(CATALOG_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`README.md: missing ${CATALOG_START}/${CATALOG_END} markers`);
  }
  const catalog = readme.slice(start + CATALOG_START.length, end);
  return catalog
    .split(/\r?\n/)
    .map((line) => line.match(/^\|\s*`([a-z0-9]+(?:-[a-z0-9]+)*)`/))
    .filter(Boolean)
    .map((match) => match[1]);
}

/**
 * Finds generated workflow artifacts that should live outside skill packages.
 *
 * @param {string} skillsDirectory - Absolute skills directory.
 * @returns {string[]} Absolute generated artifact paths.
 */
export function findGeneratedWorkflowFiles(skillsDirectory) {
  const generated = [];
  for (const path of listFilesRecursively(skillsDirectory)) {
    if (GENERATED_WORKFLOW_PATTERN.test(basename(path))) {
      generated.push(path);
    }
  }
  return generated;
}

/**
 * Lists every file below a directory in deterministic order.
 *
 * @param {string} directory - Directory to scan.
 * @returns {string[]} Absolute file paths.
 */
export function listFilesRecursively(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(path));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(path);
    }
  }
  return files.sort();
}

/**
 * Lists tracked skill names using Git.
 *
 * @param {string} repositoryRoot - Git repository root.
 * @returns {string[]} Tracked skill names.
 */
export function listTrackedSkillNames(repositoryRoot) {
  const output = execFileSync('git', ['ls-files', 'skills/*/SKILL.md'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((path) => basename(dirname(path)))
    .sort();
}

/**
 * Lists all tracked files under the skills directory.
 *
 * @param {string} repositoryRoot - Git repository root.
 * @returns {string[]} Repository-relative paths.
 */
export function listTrackedSkillFiles(repositoryRoot) {
  const output = execFileSync('git', ['ls-files', 'skills'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  return output.split(/\r?\n/).filter(Boolean).sort();
}

/**
 * Lists ignored files under the skills directory so local OS artifacts do not
 * become release requirements.
 *
 * @param {string} repositoryRoot - Git repository root.
 * @returns {string[]} Repository-relative paths.
 */
export function listIgnoredSkillFiles(repositoryRoot) {
  const output = execFileSync(
    'git',
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--', 'skills'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  return output.split(/\r?\n/).filter(Boolean).sort();
}

/**
 * Validates the complete repository.
 *
 * @param {string} repositoryRoot - Git repository root.
 * @returns {string[]} Validation errors.
 */
export function validateRepository(repositoryRoot) {
  const errors = [];
  const skillsDirectory = join(repositoryRoot, 'skills');
  const skillDirectories = readdirSync(skillsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDirectory, entry.name, 'SKILL.md')))
    .map((entry) => join(skillsDirectory, entry.name))
    .sort();
  const discoveredNames = skillDirectories.map((path) => basename(path));

  for (const skillDirectory of skillDirectories) {
    errors.push(...validateSkill(skillDirectory));
    errors.push(...validateEvals(skillDirectory));
  }

  const trackedNames = listTrackedSkillNames(repositoryRoot);
  if (trackedNames.join('\n') !== discoveredNames.join('\n')) {
    errors.push(
      `Tracked skill inventory differs from disk: tracked=[${trackedNames.join(', ')}] `
      + `disk=[${discoveredNames.join(', ')}]`,
    );
  }
  const ignoredSkillFiles = new Set(listIgnoredSkillFiles(repositoryRoot));
  const diskSkillFiles = listFilesRecursively(skillsDirectory)
    .map((path) => path.slice(repositoryRoot.length + 1))
    .filter((path) => !ignoredSkillFiles.has(path))
    .sort();
  const trackedSkillFiles = listTrackedSkillFiles(repositoryRoot);
  if (trackedSkillFiles.join('\n') !== diskSkillFiles.join('\n')) {
    const tracked = new Set(trackedSkillFiles);
    const disk = new Set(diskSkillFiles);
    const untracked = diskSkillFiles.filter((path) => !tracked.has(path));
    const missing = trackedSkillFiles.filter((path) => !disk.has(path));
    errors.push(
      `Tracked skill files differ from disk: untracked=[${untracked.join(', ')}] `
      + `missing=[${missing.join(', ')}]`,
    );
  }

  try {
    const rawCatalogNames = readCatalogSkills(readFileSync(join(repositoryRoot, 'README.md'), 'utf8'));
    const catalogNames = [...new Set(rawCatalogNames)].sort();
    if (catalogNames.length !== rawCatalogNames.length) {
      errors.push('README.md: skill catalog contains duplicate rows');
    }
    if (catalogNames.join('\n') !== discoveredNames.join('\n')) {
      errors.push(
        `README skill catalog differs from disk: catalog=[${catalogNames.join(', ')}] `
        + `disk=[${discoveredNames.join(', ')}]`,
      );
    }
  } catch (error) {
    errors.push(error.message);
  }

  for (const generatedPath of findGeneratedWorkflowFiles(skillsDirectory)) {
    errors.push(`${generatedPath}: generated workflow artifact belongs outside skills/`);
  }

  return errors;
}

/**
 * Runs the command-line validator.
 *
 * @param {string[]} argv - Command-line arguments.
 */
function main(argv) {
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const repositoryRoot = resolve(argv[2] || defaultRoot);
  if (!existsSync(repositoryRoot) || !statSync(repositoryRoot).isDirectory()) {
    process.stderr.write(`Repository root does not exist: ${repositoryRoot}\n`);
    process.exitCode = 2;
    return;
  }

  const errors = validateRepository(repositoryRoot);
  if (errors.length > 0) {
    process.stderr.write(`Skill validation failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):\n`);
    for (const error of errors) {
      process.stderr.write(`- ${error}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Skill validation passed.\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
