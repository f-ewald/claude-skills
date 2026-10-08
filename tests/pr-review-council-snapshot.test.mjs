/**
 * Verifies fail-closed snapshot extraction, path containment, workspace
 * verification, and pinned-input validation.
 */

import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { createGunzip } from 'node:zlib';

import { fetchComparison, validatePinnedInput, writeContained } from '../skills/pr-review/scripts/lib/snapshot.mjs';
import { TarExtractor } from '../skills/pr-review/scripts/lib/tar.mjs';
import {
  createWorkspace,
  openWorkspace,
  removeSnapshot,
  resetSnapshotDirectory,
} from '../skills/pr-review/scripts/lib/workspace.mjs';
import { createTarball } from './fixtures/tar-writer.mjs';

const SHA = 'a'.repeat(40);

/**
 * Creates a scratch directory removed after the test.
 *
 * @param {import('node:test').TestContext} context - Test context.
 * @returns {string} Directory path.
 */
function scratch(context) {
  const directory = mkdtempSync(join(tmpdir(), 'pr-review-snapshot-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * Extracts an archive into a fresh directory.
 *
 * @param {string} root - Parent scratch directory.
 * @param {Buffer} archive - Gzipped tarball.
 * @param {object} [limits] - Extractor overrides.
 * @returns {Promise<{root: string, stats: object}>} Destination and statistics.
 */
async function extract(root, archive, limits = {}) {
  const destination = mkdtempSync(join(root, 'out-'));
  const extractor = new TarExtractor({ root: destination, capBytes: 1024, maxFiles: 10, expectedSha: SHA, ...limits });
  await pipeline(Readable.from([archive]), createGunzip(), extractor);
  return { root: destination, stats: extractor.stats };
}

test('extracts regular files only and records links without creating them', async (context) => {
  const root = scratch(context);
  const longPath = `deep/${'x'.repeat(120)}/file.txt`;
  const { root: out, stats } = await extract(root, createTarball([
    { path: 'src', type: 'dir' },
    { path: 'src/app.js', content: 'ok\n' },
    { path: longPath, content: 'long\n' },
    { path: 'secret', type: 'symlink', target: '/etc/passwd' },
    { path: 'hard', type: 'hardlink', target: 'src/app.js' },
  ], { commit: SHA }));
  assert.equal(readFileSync(join(out, 'src/app.js'), 'utf8'), 'ok\n');
  assert.equal(readFileSync(join(out, longPath), 'utf8'), 'long\n');
  assert.equal(existsSync(join(out, 'secret')), false);
  assert.equal(existsSync(join(out, 'hard')), false);
  assert.equal(lstatSync(join(out, 'src/app.js')).mode & 0o777, 0o600);
  assert.deepEqual(stats.skipped.map((entry) => entry.type), ['symlink', 'hardlink']);
  assert.equal(stats.commit, SHA);
});

test('aborts on unsafe, unverifiable, or oversized archives', async (context) => {
  const root = scratch(context);
  const file = (path, extra = {}) => ({ path, content: 'x', ...extra });
  const cases = [
    ['parent segment', createTarball([file('a/../../escape')], { commit: SHA }), 'unsafe-archive'],
    ['absolute path', createTarball([file('/etc/evil', { raw: true })], { commit: SHA }), 'unsafe-archive'],
    ['second top-level directory', createTarball([file('other-top/x', { raw: true })], { commit: SHA }),
      'unsafe-archive'],
    ['commit mismatch', createTarball([file('a')], { commit: 'b'.repeat(40) }), 'unsafe-archive'],
    ['missing commit', createTarball([file('a')]), 'unsafe-archive'],
    ['size cap', createTarball([{ path: 'big', content: 'y'.repeat(2048) }], { commit: SHA }), 'oversize'],
    ['file-count cap', createTarball([file('1'), file('2'), file('3')], { commit: SHA }), 'oversize', { maxFiles: 2 }],
  ];
  for (const [name, archive, kind, limits] of cases) {
    await assert.rejects(extract(root, archive, limits), { kind }, name);
  }
  await assert.rejects(extract(root, Buffer.from('not gzip')), /incorrect header check/);
});

test('writes fetched blobs only below the snapshot root', (context) => {
  const root = scratch(context);
  writeContained(root, 'src/app.js', Buffer.from('archive'));
  writeContained(root, 'src/app.js', Buffer.from('pinned'), true);
  assert.equal(readFileSync(join(root, 'src/app.js'), 'utf8'), 'pinned');
  mkdirSync(join(root, 'dir'));
  for (const [path, replace] of [['../escape'], ['/abs'], ['a//b'], ['a/./b'], ['src/app.js'], ['dir', true]]) {
    assert.throws(() => writeContained(root, path, Buffer.from('x'), replace), path);
  }
});

test('opens and cleans only verified council workspaces', (context) => {
  const base = scratch(context);
  const paths = createWorkspace(base);
  assert.equal(openWorkspace(paths.root, base).root, paths.root);
  assert.equal(lstatSync(paths.root).mode & 0o777, 0o700);
  const impostor = join(base, 'pr-review-council-fake');
  mkdirSync(impostor);
  const nested = join(paths.root, 'pr-review-council-nested');
  mkdirSync(nested);
  writeFileSync(join(nested, '.pr-review-council'), JSON.stringify({ token: 'x'.repeat(32) }));
  for (const candidate of ['relative/path', impostor, nested, join(base, 'missing'), base]) {
    assert.throws(() => openWorkspace(candidate, base), { kind: 'workspace' }, candidate);
  }
  assert.throws(() => resetSnapshotDirectory(paths, 'council'), { kind: 'workspace' });
  writeFileSync(join(paths.head, 'file'), 'x');
  removeSnapshot(paths);
  assert.equal(existsSync(paths.snapshot), false);
  assert.equal(existsSync(paths.council), true);
});

test('accepts patchless records only for binaries or files without changed lines', async () => {
  const input = validatePinnedInput({
    host: 'github.com', owner: 'octo', repo: 'demo', number: '7', head: SHA, base: 'b'.repeat(40), changedFiles: '3',
  });
  const record = (filename, status, changes) => ({ filename, status, changes });
  const gh = (files) => ({
    output: async () => 'diff',
    json: async (args) => {
      if (args[1] !== 'graphql') {
        return { files };
      }
      const expression = args.find((argument) => argument.startsWith('expression='));
      const object = { oid: 'c'.repeat(40), byteSize: 0, isBinary: expression.endsWith('.png') };
      return { data: { repository: { object } } };
    },
  });
  const accepted = await fetchComparison(input, gh([
    record('pkg/__init__.py', 'added', 0), record('run.sh', 'modified', 0), record('logo.png', 'modified', 0),
  ]));
  assert.deepEqual(accepted.files.map((file) => [file.filename, file.binary]),
    [['pkg/__init__.py', false], ['run.sh', false], ['logo.png', true]]);
  const incomplete = [record('a.txt', 'modified', 0), record('b.txt', 'modified', 7), record('c', 'added', 0)];
  await assert.rejects(fetchComparison(input, gh(incomplete)), { kind: 'incomplete-diff' });
});

test('validates every pinned input before it reaches a gh route', () => {
  const valid = {
    host: 'GitHub.example.com', owner: 'octo', repo: 'demo.js', number: '7', head: SHA, base: 'b'.repeat(40),
    changedFiles: '2',
  };
  assert.deepEqual(validatePinnedInput(valid), { ...valid, host: 'github.example.com', number: 7, changedFiles: 2 });
  const invalid = [
    { host: 'evil.com/x' }, { host: '-x.com' }, { owner: '..' }, { repo: 'a/b' }, { number: '0' }, { number: '7a' },
    { head: 'A'.repeat(40) }, { base: 'b'.repeat(39) }, { changedFiles: '-1' },
  ];
  for (const override of invalid) {
    assert.throws(() => validatePinnedInput({ ...valid, ...override }), { kind: 'input' }, JSON.stringify(override));
  }
});
