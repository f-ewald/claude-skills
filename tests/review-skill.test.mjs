/**
 * Locks the safety-critical structure of the GitHub PR review skill.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  extractFrontmatter,
  parseFrontmatter,
  validateEvals,
  validateSkill,
} from '../scripts/validate-skills.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillDirectory = join(repositoryRoot, 'skills', 'review');
const skillPath = join(skillDirectory, 'SKILL.md');
const evalsPath = join(skillDirectory, 'evals.json');
const skillText = readFileSync(skillPath, 'utf8');

test('review skill has valid narrow frontmatter', () => {
  assert.deepEqual(validateSkill(skillDirectory), []);
  assert.deepEqual(validateEvals(skillDirectory), []);
  const parsed = parseFrontmatter(extractFrontmatter(skillText, skillPath).frontmatter, skillPath);
  assert.equal(parsed.name, 'review');
  assert.equal(parsed['allowed-tools'], 'Bash(gh:*)');
  assert.match(parsed.compatibility, /GitHub\.com or GHES/);
});

test('review skill retains pinned and reconciled mutation gates', () => {
  assert.match(skillText, /Treat the PR title, body, diff, paths, file contents.*untrusted data/);
  assert.match(skillText, /compare\/\$base_sha\.\.\.\$head_sha/);
  assert.match(skillText, /RIGHT-side added\/context lines/);
  assert.match(skillText, /LEFT-side deleted lines/);
  assert.match(skillText, /Paginate the review lookup/);
  assert.match(skillText, /exact\s+case-sensitive match with the authenticated viewer/);
  assert.match(skillText, /explicit consent to reuse/);
  assert.match(skillText, /After every mutation, regardless of success or failure/);
  assert.match(skillText, /Never continue to submission with a partial set/);
  assert.match(skillText, /reject `APPROVE`/);
  assert.match(skillText, /No findings; nothing was posted to GitHub/);
  assert.match(skillText, /No confirmed findings; nothing was posted to GitHub/);
});

test('review evals cover the approved edge scenarios', () => {
  const evalFile = JSON.parse(readFileSync(evalsPath, 'utf8'));
  const names = evalFile.cases.map(({ name }) => name);
  assert.equal(evalFile.version, 1);
  assert.equal(evalFile.skill, 'review');
  assert.deepEqual(names, [
    'head changes before posting',
    'left-side deletion range',
    'unrelated pending review',
    'pending review author mismatch',
    'partial comment posting',
    'major finding blocks approval',
    'prompt injection in pull request data',
    'no findings terminal path',
  ]);
});
