/**
 * Tests the deterministic changelog generator.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseGitLog,
  renderChangelog,
} from '../scripts/update-changelog.mjs';

const scriptPath = fileURLToPath(new URL('../scripts/update-changelog.mjs', import.meta.url));

test('parseGitLog preserves tabs in commit subjects', () => {
  const hash = 'a'.repeat(40);
  const output = `${hash}\taaaaaaa\t2026-07-15\tAdd subject\twith tab\n`;

  assert.deepEqual(parseGitLog(output), [{
    hash,
    shortHash: 'aaaaaaa',
    date: '2026-07-15',
    subject: 'Add subject\twith tab',
  }]);
});

test('renderChangelog groups dates, escapes subjects, and omits marked commits', () => {
  const commits = [
    {
      hash: 'a'.repeat(40),
      shortHash: 'aaaaaaa',
      date: '2026-07-15',
      subject: 'Add [safe] *thing*',
    },
    {
      hash: 'b'.repeat(40),
      shortHash: 'bbbbbbb',
      date: '2026-07-15',
      subject: 'chore: update changelog [skip changelog]',
    },
    {
      hash: 'c'.repeat(40),
      shortHash: 'ccccccc',
      date: '2026-07-14',
      subject: 'Fix <script> & docs',
    },
  ];

  const changelog = renderChangelog(commits);
  assert.match(changelog, /## 2026-07-15/);
  assert.match(changelog, /Add \\\[safe\\\] \\\*thing\\\*/);
  assert.match(changelog, /## 2026-07-14/);
  assert.match(changelog, /Fix &lt;script&gt; &amp; docs/);
  assert.doesNotMatch(changelog, /update changelog/);
});

test('the CLI rejects unsupported arguments', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--unknown'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown argument: --unknown/);
});
