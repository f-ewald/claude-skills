/**
 * Verifies pinned-diff parsing and review-comment coordinate validation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDiffIndex, parsePatch, validateCoordinate } from '../skills/pr-review/scripts/lib/diff.mjs';

const PATCH = [
  '@@ -1,4 +1,5 @@',
  ' const a = 1;',
  '-const b = 2;',
  '-const old = 0;',
  '+const b = 3;',
  '+const c = 4;',
  '+const d = 5;',
  ' module.exports = a;',
  '@@ -20 +21 @@',
  '-tail();',
  '+tail(1);',
  '\\ No newline at end of file',
  '',
].join('\n');

const INDEX = buildDiffIndex([
  { filename: 'src/app.js', status: 'modified', patch: PATCH },
  { filename: 'new/name.js', previous_filename: 'old/name.js', status: 'renamed', patch: '@@ -3 +3 @@\n-x\n+y\n' },
  { filename: 'image.png', status: 'added' },
]);

test('maps RIGHT to head added/context lines and LEFT to deleted base lines', () => {
  assert.deepEqual(parsePatch(PATCH).map((hunk) => [[...hunk.right], [...hunk.left]]), [
    [[1, 2, 3, 4, 5], [2, 3]],
    [[21], [20]],
  ]);
});

test('accepts only coordinates present in one hunk on one side', () => {
  const cases = [
    [{ path: 'src/app.js', side: 'RIGHT', line: 4, start_line: 2 }, null],
    [{ path: 'src/app.js', side: 'LEFT', line: 3, start_line: 2 }, null],
    [{ path: 'new/name.js', side: 'LEFT', line: 3, start_line: null }, null],
    [{ path: 'src/app.js', side: 'LEFT', line: 1, start_line: null }, /not a commentable line/],
    [{ path: 'src/app.js', side: 'RIGHT', line: 21, start_line: 5 }, /within one diff hunk/],
    [{ path: 'src/app.js', side: 'RIGHT', line: 3, start_line: 3 }, /earlier line/],
    [{ path: 'old/name.js', side: 'LEFT', line: 3, start_line: null }, /not a changed file/],
    [{ path: 'image.png', side: 'RIGHT', line: 1, start_line: null }, /not a commentable line/],
    [{ path: 'src/app.js', side: 'BOTH', line: 1, start_line: null }, /RIGHT or LEFT/],
  ];
  for (const [coordinate, expected] of cases) {
    const reason = validateCoordinate(INDEX, coordinate);
    if (expected === null) {
      assert.equal(reason, null, JSON.stringify(coordinate));
    } else {
      assert.match(reason, expected, JSON.stringify(coordinate));
    }
  }
});

test('fails closed on patches whose counts disagree with their headers', () => {
  for (const patch of [
    '@@ -300,3 +300,4 @@\n context\n+added\n',
    '@@ -1 +1 @@\n-a\n+b\n+c\n',
    '@@ -1,2 +1,2 @@\n a\n*garbage\n',
  ]) {
    assert.throws(() => parsePatch(patch), { kind: 'incomplete-diff' }, JSON.stringify(patch));
  }
});
