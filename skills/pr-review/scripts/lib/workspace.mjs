/**
 * Creates, verifies, and safely removes the private council workspace.
 *
 * A workspace is a `pr-review-council-*` directory created directly inside the
 * system temporary directory and carrying a marker file. Deletion is allowed
 * only for a path that passes those checks, never for a path found by content.
 */

import { randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { CouncilError } from './errors.mjs';

const PREFIX = 'pr-review-council-';
const MARKER = '.pr-review-council';

/**
 * Resolves every well-known path inside a workspace root.
 *
 * @param {string} root - Real workspace root.
 * @returns {Record<string, string>} Named absolute paths.
 */
export function workspacePaths(root) {
  const snapshot = join(root, 'snapshot');
  const pr = join(snapshot, 'pr');
  const council = join(root, 'council');
  return {
    root,
    snapshot,
    pr,
    head: join(snapshot, 'head'),
    base: join(snapshot, 'base'),
    ballots: join(snapshot, 'ballots'),
    meta: join(pr, 'meta.json'),
    files: join(pr, 'files.json'),
    diff: join(pr, 'diff.patch'),
    council,
    stage1: join(council, 'stage1'),
    stage2: join(council, 'stage2'),
    state: join(council, 'state.json'),
    roster: join(council, 'roster.json'),
    members: join(council, 'members.json'),
    analysis: join(council, 'analysis.json'),
    chairmanInput: join(council, 'chairman-input.json'),
    chairman: join(council, 'chairman.json'),
    final: join(council, 'final.json'),
  };
}

/**
 * Creates a fresh private workspace (mode 0700) in the temporary directory.
 *
 * @param {string} [base] - Temporary directory; defaults to the system one.
 * @returns {Record<string, string>} Workspace paths.
 */
export function createWorkspace(base = tmpdir()) {
  const root = mkdtempSync(join(realpathSync(base), PREFIX));
  const marker = { token: randomBytes(16).toString('hex'), created: new Date().toISOString() };
  writeFileSync(join(root, MARKER), JSON.stringify(marker), { mode: 0o600 });
  const paths = workspacePaths(root);
  for (const directory of [paths.pr, paths.head, paths.base, paths.ballots, paths.stage1, paths.stage2]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return paths;
}

/**
 * Opens an existing workspace after verifying its location and marker.
 *
 * @param {string} path - Absolute workspace path supplied by the caller.
 * @param {string} [base] - Temporary directory; defaults to the system one.
 * @returns {Record<string, string>} Workspace paths.
 * @throws {CouncilError} kind `workspace` when the path is not a verified council workspace.
 */
export function openWorkspace(path, base = tmpdir()) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new CouncilError('workspace', 'workspace must be an absolute path');
  }
  let root;
  try {
    root = realpathSync(path);
  } catch {
    throw new CouncilError('workspace', 'workspace does not exist');
  }
  if (dirname(root) !== realpathSync(base) || !basename(root).startsWith(PREFIX)) {
    throw new CouncilError('workspace', 'path is not a council workspace in the system temporary directory');
  }
  verifyMarker(join(root, MARKER));
  return workspacePaths(root);
}

/**
 * Verifies that the marker is a regular file with a token.
 *
 * @param {string} markerPath - Marker path.
 * @returns {void}
 * @throws {CouncilError} When the marker is missing, linked, or malformed.
 */
function verifyMarker(markerPath) {
  try {
    if (!lstatSync(markerPath).isFile()) {
      throw new Error('not a regular file');
    }
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (typeof marker.token !== 'string' || marker.token.length !== 32) {
      throw new Error('missing token');
    }
  } catch {
    throw new CouncilError('workspace', 'workspace marker is missing or invalid');
  }
}

/**
 * Empties a directory inside a verified workspace and recreates it.
 *
 * @param {Record<string, string>} paths - Verified workspace paths.
 * @param {'head'|'base'|'ballots'} name - Directory to reset.
 * @returns {void}
 */
export function resetSnapshotDirectory(paths, name) {
  if (!['head', 'base', 'ballots'].includes(name)) {
    throw new CouncilError('workspace', `refusing to reset ${name}`);
  }
  const target = paths[name];
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true, mode: 0o700 });
}

/**
 * Deletes the snapshot (repository checkout and ballots), keeping the council report.
 *
 * @param {Record<string, string>} paths - Verified workspace paths.
 * @returns {void}
 */
export function removeSnapshot(paths) {
  rmSync(paths.snapshot, { recursive: true, force: true });
}

/**
 * Deletes the entire workspace, including the council report.
 *
 * @param {Record<string, string>} paths - Verified workspace paths.
 * @returns {void}
 */
export function removeWorkspace(paths) {
  rmSync(paths.root, { recursive: true, force: true });
}

/**
 * Reads a JSON file written by the council.
 *
 * @param {string} path - File path.
 * @returns {unknown} Parsed value.
 * @throws {CouncilError} kind `state` when the file is missing or malformed.
 */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CouncilError('state', `cannot read ${basename(path)}: ${error.code ?? 'malformed JSON'}`);
  }
}

/**
 * Writes a JSON file readable only by the current user.
 *
 * @param {string} path - File path.
 * @param {unknown} value - JSON-serializable value.
 * @returns {void}
 */
export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
