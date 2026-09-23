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

test('global rules live only in AGENTS.md and stay under 200 lines', () => {
  const agents = readFileSync(join(repositoryRoot, 'AGENTS.md'), 'utf8');
  assert.match(agents, /^## Code Style$/m);
  assert.ok(agents.split('\n').length < 200, 'AGENTS.md must stay under 200 lines');
  for (const retired of ['CLAUDE.md', 'COPILOT.md']) {
    assert.equal(existsSync(join(repositoryRoot, retired)), false, `${retired} must not be reintroduced`);
  }
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
