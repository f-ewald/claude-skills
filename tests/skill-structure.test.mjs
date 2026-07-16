/**
 * Tests the repository-specific Agent Skills validator.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  extractFrontmatter,
  extractRelativeLinks,
  findGeneratedWorkflowFiles,
  listFilesRecursively,
  parseFrontmatter,
  readCatalogSkills,
  validateEvals,
  validateSkill,
} from '../scripts/validate-skills.mjs';

/**
 * Creates an isolated temporary directory and removes it after the test.
 *
 * @param {import('node:test').TestContext} context - Node test context.
 * @returns {string} Temporary directory path.
 */
function temporaryDirectory(context) {
  const directory = mkdtempSync(join(tmpdir(), 'claude-skills-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('parses the supported frontmatter subset', () => {
  const sections = extractFrontmatter(`---
name: example
description: Example behavior. Use when testing.
metadata:
  author: Example
allowed-tools: Bash(git:*) Read
---

Body.
`);
  assert.deepEqual(parseFrontmatter(sections.frontmatter), {
    name: 'example',
    description: 'Example behavior. Use when testing.',
    metadata: { author: 'Example' },
    'allowed-tools': 'Bash(git:*) Read',
  });
  assert.equal(sections.body.trim(), 'Body.');
});

test('rejects unsupported nested frontmatter', () => {
  assert.throws(
    () => parseFrontmatter('name: example\nother:\n  nested: value'),
    /requires a scalar value/,
  );
});

test('rejects empty scalar frontmatter values', () => {
  assert.throws(
    () => parseFrontmatter('name: example\ncompatibility:'),
    /requires a scalar value/,
  );
});

test('extracts only relative Markdown links', () => {
  assert.deepEqual(
    extractRelativeLinks('[local](references/local.md) [web](https://example.com) [anchor](#section)'),
    ['references/local.md'],
  );
});

test('validates a conforming skill and its references', (context) => {
  const root = temporaryDirectory(context);
  const skillDirectory = join(root, 'example-skill');
  mkdirSync(join(skillDirectory, 'references'), { recursive: true });
  writeFileSync(
    join(skillDirectory, 'SKILL.md'),
    `---
name: example-skill
description: Performs an example workflow. Use when an example is needed.
metadata:
  author: Example
---

Read [the reference](references/guide.md).
`,
  );
  writeFileSync(join(skillDirectory, 'references', 'guide.md'), '# Guide\n');
  assert.deepEqual(validateSkill(skillDirectory), []);
});

test('reports portability and reference errors', (context) => {
  const root = temporaryDirectory(context);
  const skillDirectory = join(root, 'broken-skill');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    join(skillDirectory, 'SKILL.md'),
    `---
name: wrong-name
description: Missing trigger wording.
author: Example
allowed-tools: Bash(git:*), Read
---

Read [the reference](missing.md).
`,
  );
  const errors = validateSkill(skillDirectory).join('\n');
  assert.match(errors, /unsupported top-level field "author"/);
  assert.match(errors, /does not match folder/);
  assert.match(errors, /must state when to use/);
  assert.match(errors, /allowed-tools must be space-separated/);
  assert.match(errors, /missing referenced file/);
});

test('reads the machine-checkable README catalog', () => {
  const readme = `# Skills
<!-- skill-catalog:start -->
| Skill |
| --- |
| \`alpha\` |
| \`beta-skill\` |
<!-- skill-catalog:end -->
`;
  assert.deepEqual(readCatalogSkills(readme), ['alpha', 'beta-skill']);
});

test('validates per-skill behavior scenarios', (context) => {
  const root = temporaryDirectory(context);
  const skillDirectory = join(root, 'example-skill');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    join(skillDirectory, 'evals.json'),
    JSON.stringify({
      version: 1,
      skill: 'example-skill',
      cases: [
        {
          name: 'safe behavior',
          prompt: 'Perform the safe behavior.',
          expect: ['asks before writing'],
          reject: ['writes immediately'],
        },
      ],
    }),
  );
  assert.deepEqual(validateEvals(skillDirectory), []);
});

test('reports malformed behavior scenarios', (context) => {
  const root = temporaryDirectory(context);
  const skillDirectory = join(root, 'example-skill');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    join(skillDirectory, 'evals.json'),
    JSON.stringify({
      version: 2,
      skill: 'other-skill',
      cases: [{ name: '', prompt: '', expect: [] }],
    }),
  );
  const errors = validateEvals(skillDirectory).join('\n');
  assert.match(errors, /version must be 1/);
  assert.match(errors, /does not match folder/);
  assert.match(errors, /name must be a non-empty string/);
  assert.match(errors, /prompt must be a non-empty string/);
  assert.match(errors, /expect must be a non-empty array/);
});

test('reports a non-object behavior document', (context) => {
  const root = temporaryDirectory(context);
  const skillDirectory = join(root, 'example-skill');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(join(skillDirectory, 'evals.json'), 'null\n');
  assert.deepEqual(
    validateEvals(skillDirectory),
    [`${join(skillDirectory, 'evals.json')}: top-level value must be an object`],
  );
});

test('finds generated workflow artifacts in skill directories', (context) => {
  const root = temporaryDirectory(context);
  const skillDirectory = join(root, 'example');
  mkdirSync(join(skillDirectory, 'nested'), { recursive: true });
  writeFileSync(join(skillDirectory, 'SKILL.md'), 'test');
  writeFileSync(join(skillDirectory, 'nested', 'research-result.json'), 'test');
  assert.deepEqual(
    findGeneratedWorkflowFiles(root),
    [join(skillDirectory, 'nested', 'research-result.json')],
  );
  assert.deepEqual(listFilesRecursively(root), [
    join(skillDirectory, 'SKILL.md'),
    join(skillDirectory, 'nested', 'research-result.json'),
  ]);
});
