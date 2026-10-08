/**
 * Parses pinned pull-request patches and validates review-comment coordinates.
 *
 * RIGHT coordinates use head line numbers of added or context lines. LEFT
 * coordinates use base line numbers of deleted lines. A range must stay on
 * one side inside one hunk.
 */

import { CouncilError } from './errors.mjs';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses one file's unified-diff patch into hunks with commentable line sets.
 *
 * @param {string} patch - Patch text from a comparison file record.
 * @returns {{right: Set<number>, left: Set<number>}[]} Hunks in patch order.
 * @throws {CouncilError} kind `incomplete-diff` when line counts disagree with a hunk header.
 */
export function parsePatch(patch) {
  const hunks = [];
  let state = null;
  for (const line of patch.split('\n')) {
    const header = line.match(HUNK_HEADER);
    if (header) {
      assertHunkComplete(state);
      state = openHunk(header);
      hunks.push(state.hunk);
      continue;
    }
    if (state && !line.startsWith('\\')) {
      consumeLine(state, line);
    }
  }
  assertHunkComplete(state);
  return hunks;
}

/**
 * Creates the mutable parse state for a hunk header.
 *
 * @param {RegExpMatchArray} header - Matched hunk header.
 * @returns {object} Parse state.
 */
function openHunk(header) {
  return {
    hunk: { right: new Set(), left: new Set() },
    oldLine: Number(header[1]),
    newLine: Number(header[3]),
    oldRemaining: header[2] === undefined ? 1 : Number(header[2]),
    newRemaining: header[4] === undefined ? 1 : Number(header[4]),
  };
}

/**
 * Applies one patch body line to the hunk state.
 *
 * @param {object} state - Parse state.
 * @param {string} line - Patch line.
 * @returns {void}
 * @throws {CouncilError} When the line exceeds the header's counts.
 */
function consumeLine(state, line) {
  const marker = line[0];
  if (marker === '+') {
    takeNew(state);
    return;
  }
  if (marker === '-') {
    takeOld(state);
    return;
  }
  if (marker === ' ' || (line === '' && state.oldRemaining > 0 && state.newRemaining > 0)) {
    takeContext(state);
    return;
  }
  if (line !== '' || state.oldRemaining > 0 || state.newRemaining > 0) {
    throw new CouncilError('incomplete-diff', 'patch contains a malformed hunk line');
  }
}

/**
 * Records a head-side (RIGHT) line.
 *
 * @param {object} state - Parse state.
 * @returns {void}
 */
function takeNew(state) {
  if (state.newRemaining <= 0) {
    throw new CouncilError('incomplete-diff', 'patch hunk has more head lines than its header declares');
  }
  state.hunk.right.add(state.newLine);
  state.newLine += 1;
  state.newRemaining -= 1;
}

/**
 * Records an unchanged context line, which is commentable only on the RIGHT side.
 *
 * @param {object} state - Parse state.
 * @returns {void}
 */
function takeContext(state) {
  if (state.oldRemaining <= 0) {
    throw new CouncilError('incomplete-diff', 'patch hunk has more base lines than its header declares');
  }
  state.oldLine += 1;
  state.oldRemaining -= 1;
  takeNew(state);
}

/**
 * Records a deleted base-side (LEFT) line.
 *
 * @param {object} state - Parse state.
 * @returns {void}
 */
function takeOld(state) {
  if (state.oldRemaining <= 0) {
    throw new CouncilError('incomplete-diff', 'patch hunk has more base lines than its header declares');
  }
  state.hunk.left.add(state.oldLine);
  state.oldLine += 1;
  state.oldRemaining -= 1;
}

/**
 * Verifies that the previous hunk consumed exactly its declared line counts.
 *
 * @param {object|null} state - Parse state of the previous hunk.
 * @returns {void}
 * @throws {CouncilError} When the hunk is truncated.
 */
function assertHunkComplete(state) {
  if (state && (state.oldRemaining !== 0 || state.newRemaining !== 0)) {
    throw new CouncilError('incomplete-diff', 'patch hunk is truncated');
  }
}

/**
 * Indexes comparison file records by their head path.
 *
 * @param {object[]} files - Comparison records with filename, previous_filename, status, and patch.
 * @returns {Map<string, {status: string, previousFilename: string|null, hasPatch: boolean, hunks: object[]}>}
 *   Index keyed by filename.
 */
export function buildDiffIndex(files) {
  const index = new Map();
  for (const file of files) {
    const hasPatch = typeof file.patch === 'string';
    index.set(file.filename, {
      status: file.status,
      previousFilename: file.previous_filename ?? null,
      hasPatch,
      hunks: hasPatch ? parsePatch(file.patch) : [],
    });
  }
  return index;
}

/**
 * Checks that a finding's coordinates exist in the pinned diff.
 *
 * @param {Map<string, object>} index - Result of buildDiffIndex.
 * @param {{path: string, side: string, line: number, start_line: number|null}} coordinate - Proposed target.
 * @returns {string|null} A rejection reason, or null when the coordinate is valid.
 */
export function validateCoordinate(index, coordinate) {
  const file = index.get(coordinate.path);
  if (!file) {
    return 'path is not a changed file in the pinned diff';
  }
  if (coordinate.side !== 'RIGHT' && coordinate.side !== 'LEFT') {
    return 'side must be RIGHT or LEFT';
  }
  const key = coordinate.side === 'RIGHT' ? 'right' : 'left';
  const hunk = file.hunks.find((candidate) => candidate[key].has(coordinate.line));
  if (!hunk) {
    return `${coordinate.side} line ${coordinate.line} is not a commentable line in the pinned diff`;
  }
  const startLine = coordinate.start_line;
  if (startLine === null || startLine === undefined) {
    return null;
  }
  if (!Number.isInteger(startLine) || startLine >= coordinate.line) {
    return 'start_line must be an earlier line than line';
  }
  return hunk[key].has(startLine) ? null : 'a range must stay on one side within one diff hunk';
}
