/**
 * Checks cross-package contracts that are easy to drift during skill changes.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  readCatalogSkills,
  validateEvals,
  validateSkill,
} from '../scripts/validate-skills.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillsDirectory = join(repositoryRoot, 'skills');

/**
 * Returns the shared global-rules body, excluding harness-specific headers.
 *
 * @param {string} text - Complete instruction file.
 * @returns {string} Shared rules from Code Style onward.
 */
function sharedRules(text) {
  const marker = '## Code Style';
  const index = text.indexOf(marker);
  assert.notEqual(index, -1, `missing ${marker}`);
  return text.slice(index).trim();
}

test('Claude and Copilot global rules share one common body', () => {
  const claude = readFileSync(join(repositoryRoot, 'CLAUDE.md'), 'utf8');
  const copilot = readFileSync(join(repositoryRoot, 'COPILOT.md'), 'utf8');
  assert.equal(sharedRules(claude), sharedRules(copilot));
});

test('all released skills have valid metadata and eval scenarios', () => {
  const names = readdirSync(skillsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDirectory, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
  const readme = readFileSync(join(repositoryRoot, 'README.md'), 'utf8');
  const catalog = readCatalogSkills(readme);
  assert.equal(new Set(catalog).size, catalog.length);
  assert.deepEqual([...catalog].sort(), names);

  for (const name of names) {
    const directory = join(skillsDirectory, name);
    assert.deepEqual(validateSkill(directory), [], `${name} skill validation`);
    assert.deepEqual(validateEvals(directory), [], `${name} eval validation`);
  }
});

test('the retired custom deep-research package has no stale path references', () => {
  assert.equal(existsSync(join(skillsDirectory, 'deep-research')), false);
  const documentationFiles = [
    'README.md',
    'docs/using-skills-in-copilot.md',
    '.github/copilot-instructions.md',
    'skills/design-doc/SKILL.md',
  ];
  for (const relativePath of documentationFiles) {
    const text = readFileSync(join(repositoryRoot, relativePath), 'utf8');
    assert.doesNotMatch(text, /skills\/deep-research|`deep-research`|name: deep-research/);
  }
});
