/**
 * Materializes the pinned pull-request snapshot that council members read.
 *
 * Every GitHub call uses a static `gh` argument template whose route contains
 * only validated host, owner, repository, number, and SHA values. File paths
 * travel only as GraphQL variables and are written only below the snapshot.
 */

import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import { CouncilError, bounded } from './errors.mjs';
import { runProcess, spawnTracked, terminate } from './process.mjs';
import { TarExtractor } from './tar.mjs';

export const MAX_BLOB_BYTES = 1024 * 1024;
export const DEFAULT_SNAPSHOT_CAP_MIB = 2048;
export const DEFAULT_MAX_FILES = 1_000_000;
const GH_OUTPUT_LIMIT = 64 * 1024 * 1024;
const GH_TIMEOUT_MS = 120_000;
const BLOB_CONCURRENCY = 8;
const DEGRADABLE_KINDS = new Set(['oversize', 'unsafe-archive', 'api']);
const DNS_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const PATTERNS = Object.freeze({
  host: new RegExp(`^(?=.{1,253}$)${DNS_LABEL}(?:\\.${DNS_LABEL})*$`),
  name: /^[A-Za-z0-9._-]{1,100}$/,
  number: /^[1-9]\d{0,9}$/,
  sha: /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
  count: /^\d{1,7}$/,
});
const BLOB_QUERY = `
    query($owner: String!, $repo: String!, $expression: String!) {
      repository(owner: $owner, name: $repo) {
        object(expression: $expression) {
          ... on Blob { oid byteSize isBinary }
        }
      }
    }`;

/**
 * Validates and normalizes the pinned review inputs.
 *
 * @param {Record<string, string>} raw - Raw CLI values.
 * @returns {{host: string, owner: string, repo: string, number: number, head: string, base: string,
 *   changedFiles: number}} Normalized input.
 * @throws {CouncilError} kind `input` for any invalid value.
 */
export function validatePinnedInput(raw) {
  const checks = [
    ['host', PATTERNS.host], ['owner', PATTERNS.name], ['repo', PATTERNS.name], ['number', PATTERNS.number],
    ['head', PATTERNS.sha], ['base', PATTERNS.sha], ['changedFiles', PATTERNS.count],
  ];
  for (const [field, pattern] of checks) {
    if (typeof raw[field] !== 'string' || !pattern.test(raw[field])) {
      throw new CouncilError('input', `invalid ${field}`);
    }
  }
  if (['.', '..'].includes(raw.owner) || ['.', '..'].includes(raw.repo)) {
    throw new CouncilError('input', 'invalid owner or repo');
  }
  return {
    host: raw.host.toLowerCase(),
    owner: raw.owner,
    repo: raw.repo,
    number: Number(raw.number),
    head: raw.head,
    base: raw.base,
    changedFiles: Number(raw.changedFiles),
  };
}

/** Executes the snapshot's static `gh` templates without a shell. */
export class GhClient {
  /**
   * Creates a client.
   *
   * @param {object} options - Client options.
   * @param {string} [options.binary='gh'] - gh executable.
   * @param {NodeJS.ProcessEnv} [options.env] - Environment.
   * @param {import('./process.mjs').ProcessRegistry} [options.registry] - Process registry.
   */
  constructor({ binary = 'gh', env = process.env, registry } = {}) {
    this.binary = binary;
    this.env = env;
    this.registry = registry;
  }

  /**
   * Runs gh and returns stdout.
   *
   * @param {string[]} args - Static template arguments.
   * @param {boolean} [asBuffer=false] - Return a Buffer instead of text.
   * @returns {Promise<string|Buffer>} Stdout.
   * @throws {CouncilError} kind `api` on any failure.
   */
  async output(args, asBuffer = false) {
    const result = await runProcess(this.binary, args, {
      env: this.env,
      registry: this.registry,
      deadlineMs: GH_TIMEOUT_MS,
      maxStdoutBytes: GH_OUTPUT_LIMIT,
      binary: asBuffer,
    });
    if (result.code !== 0 || result.stdoutTruncated || result.timedOut) {
      const reason = result.spawnError || result.stderr || (result.timedOut ? 'timed out' : 'output too large');
      throw new CouncilError('api', `gh ${describe(args)} failed: ${bounded(reason, 300)}`);
    }
    return result.stdout;
  }

  /**
   * Runs gh and parses JSON stdout.
   *
   * @param {string[]} args - Static template arguments.
   * @returns {Promise<unknown>} Parsed JSON.
   * @throws {CouncilError} kind `api` on failure or malformed JSON.
   */
  async json(args) {
    const text = await this.output(args);
    try {
      return JSON.parse(text);
    } catch {
      throw new CouncilError('api', `gh ${describe(args)} returned malformed JSON`);
    }
  }

  /**
   * Spawns gh with a streaming stdout.
   *
   * @param {string[]} args - Static template arguments.
   * @returns {import('node:child_process').ChildProcess} Child process.
   */
  stream(args) {
    return spawnTracked(this.binary, args, { env: this.env, registry: this.registry });
  }
}

/**
 * Describes a gh invocation using only its validated leading arguments.
 *
 * @param {string[]} args - Arguments.
 * @returns {string} Short description.
 */
function describe(args) {
  return args.filter((argument) => !argument.startsWith('query=')).slice(0, 4).join(' ');
}

/**
 * Re-reads the pull request and verifies it still matches the pinned snapshot.
 *
 * @param {object} input - Normalized pinned input.
 * @param {GhClient} gh - gh client.
 * @returns {Promise<{url: string, title: string, body: string}>} Untrusted display metadata.
 * @throws {CouncilError} kind `stale` when the head, base, number, or file count moved.
 */
export async function fetchPinnedPullRequest(input, gh) {
  const meta = await gh.json([
    'pr', 'view', String(input.number),
    '--repo', `${input.host}/${input.owner}/${input.repo}`,
    '--json', 'url,number,headRefOid,baseRefOid,title,body,changedFiles',
  ]);
  const moved = meta?.number !== input.number || meta.headRefOid !== input.head
    || meta.baseRefOid !== input.base || meta.changedFiles !== input.changedFiles;
  if (moved) {
    throw new CouncilError('stale', 'the pull request no longer matches the pinned snapshot', {
      pinned: { head: input.head, base: input.base },
      current: { head: bounded(meta?.headRefOid, 80), base: bounded(meta?.baseRefOid, 80) },
    });
  }
  return { url: String(meta.url ?? ''), title: String(meta.title ?? ''), body: String(meta.body ?? '') };
}

/**
 * Fetches the pinned comparison and verifies it covers every changed file.
 *
 * @param {object} input - Normalized pinned input.
 * @param {GhClient} gh - gh client.
 * @returns {Promise<{files: object[], diffText: string}>} Normalized file records and raw diff.
 * @throws {CouncilError} kind `incomplete-diff` when files or required patches are missing.
 */
export async function fetchComparison(input, gh) {
  const route = `repos/${input.owner}/${input.repo}/compare/${input.base}...${input.head}`;
  const compare = await gh.json(['api', '--hostname', input.host, route]);
  const files = Array.isArray(compare?.files) ? compare.files.map(normalizeFileRecord) : [];
  if (files.length !== input.changedFiles) {
    const message = `comparison lists ${files.length} of ${input.changedFiles} changed files`;
    throw new CouncilError('incomplete-diff', message);
  }
  await classifyPatchlessFiles(input, files, gh);
  const accept = 'Accept: application/vnd.github.diff';
  const diffText = await gh.output(['api', '--hostname', input.host, route, '-H', accept]);
  return { files, diffText };
}

/**
 * Normalizes one comparison file record.
 *
 * @param {object} file - Raw record.
 * @returns {object} Normalized record.
 * @throws {CouncilError} kind `incomplete-diff` for a malformed record.
 */
function normalizeFileRecord(file) {
  if (typeof file?.filename !== 'string' || file.filename === '' || typeof file.status !== 'string') {
    throw new CouncilError('incomplete-diff', 'comparison contains a malformed file record');
  }
  return {
    filename: file.filename,
    previous_filename: typeof file.previous_filename === 'string' ? file.previous_filename : null,
    status: file.status,
    changes: Number.isInteger(file.changes) ? file.changes : null,
    binary: false,
    ...(typeof file.patch === 'string' ? { patch: file.patch } : {}),
  };
}

/**
 * Accepts a patchless record only when it is a verified binary file or has no
 * changed lines (empty file, mode-only change, or pure rename).
 *
 * @param {object} input - Normalized pinned input.
 * @param {object[]} files - Normalized records; `binary` is updated in place.
 * @param {GhClient} gh - gh client.
 * @returns {Promise<void>}
 * @throws {CouncilError} kind `incomplete-diff` when a text patch is missing.
 */
async function classifyPatchlessFiles(input, files, gh) {
  for (const file of files.filter((record) => record.patch === undefined)) {
    const removed = file.status === 'removed';
    const path = removed ? (file.previous_filename ?? file.filename) : file.filename;
    const blob = await lookupBlob(input, removed ? input.base : input.head, path, gh);
    file.binary = blob?.isBinary === true;
    if (!file.binary && file.changes !== 0) {
      const message = 'the comparison omits a text patch; the diff cannot be proven complete';
      throw new CouncilError('incomplete-diff', message);
    }
  }
}

/**
 * Looks up blob metadata at `<sha>:<path>` through GraphQL variables.
 *
 * @param {object} input - Normalized pinned input.
 * @param {string} sha - Commit SHA.
 * @param {string} path - Repository path (untrusted; passed only as a variable).
 * @param {GhClient} gh - gh client.
 * @returns {Promise<{oid: string, byteSize: number, isBinary: boolean}|null>} Blob, or null when absent.
 * @throws {CouncilError} kind `api` on a malformed response.
 */
export async function lookupBlob(input, sha, path, gh) {
  const response = await gh.json([
    'api', 'graphql', '--hostname', input.host,
    '-f', `query=${BLOB_QUERY}`,
    '-f', `owner=${input.owner}`,
    '-f', `repo=${input.repo}`,
    '-f', `expression=${sha}:${path}`,
  ]);
  if (response?.errors) {
    throw new CouncilError('api', 'blob lookup returned GraphQL errors');
  }
  const blob = response?.data?.repository?.object;
  if (!blob || blob.oid === undefined) {
    return null;
  }
  if (typeof blob.oid !== 'string' || !PATTERNS.sha.test(blob.oid)) {
    throw new CouncilError('api', 'blob lookup returned an invalid object ID');
  }
  return blob;
}

/**
 * Writes bytes to a validated relative path below a root.
 *
 * @param {string} root - Destination root.
 * @param {string} relativePath - Repository path.
 * @param {Buffer} content - File bytes.
 * @param {boolean} [replace=false] - Replace an existing regular file instead of failing.
 * @returns {void}
 * @throws {CouncilError} kind `unsafe-archive` when the path would escape the root or is not a regular file.
 */
export function writeContained(root, relativePath, content, replace = false) {
  const parts = relativePath.split('/');
  const unsafe = relativePath.startsWith('/') || relativePath.includes('\0')
    || parts.some((part) => part === '' || part === '.' || part === '..');
  const absolute = resolve(root, relativePath);
  if (unsafe || !absolute.startsWith(`${resolve(root)}${sep}`)) {
    throw new CouncilError('unsafe-archive', `unsafe repository path: ${bounded(relativePath, 120)}`);
  }
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  if (replace && existsSync(absolute)) {
    if (!lstatSync(absolute).isFile()) {
      throw new CouncilError('unsafe-archive', `not a regular file: ${bounded(relativePath, 120)}`);
    }
    rmSync(absolute);
  }
  writeFileSync(absolute, content, { flag: 'wx', mode: 0o600 });
}

/**
 * Fetches one side of every changed text file (≤1 MiB) into a root directory.
 *
 * @param {object} options - Materialization options.
 * @param {object} options.input - Normalized pinned input.
 * @param {object[]} options.files - Normalized comparison records.
 * @param {'head'|'base'} options.side - Snapshot side.
 * @param {string} options.root - Destination root.
 * @param {GhClient} options.gh - gh client.
 * @param {boolean} [options.replace=false] - Overwrite files extracted from the archive.
 * @returns {Promise<{path: string, status: string}[]>} Per-file outcome.
 */
export async function materializeChangedFiles({ input, files, side, root, gh, replace = false }) {
  const targets = files
    .map((file) => (side === 'head' ? headPath(file) : basePath(file)))
    .filter((path) => path !== null);
  const sha = side === 'head' ? input.head : input.base;
  return mapWithConcurrency(targets, BLOB_CONCURRENCY,
    (path) => materializeBlob({ input, sha, path, root, gh, replace }));
}

/**
 * Returns a record's head path, or null for a deleted file.
 *
 * @param {object} file - Normalized record.
 * @returns {string|null} Head path.
 */
function headPath(file) {
  return file.status === 'removed' ? null : file.filename;
}

/**
 * Returns a record's base path, or null for an added file.
 *
 * @param {object} file - Normalized record.
 * @returns {string|null} Base path (the previous name for renames).
 */
function basePath(file) {
  return file.status === 'added' ? null : (file.previous_filename ?? file.filename);
}

/**
 * Fetches one blob when it is text and within the size limit.
 *
 * @param {object} options - Blob options, including `replace`.
 * @returns {Promise<{path: string, status: string}>} Outcome: written, binary, oversize, or missing.
 */
async function materializeBlob({ input, sha, path, root, gh, replace }) {
  const blob = await lookupBlob(input, sha, path, gh);
  if (!blob) {
    return { path, status: 'missing' };
  }
  if (blob.isBinary) {
    return { path, status: 'binary' };
  }
  if (!Number.isInteger(blob.byteSize) || blob.byteSize > MAX_BLOB_BYTES) {
    return { path, status: 'oversize' };
  }
  const route = `repos/${input.owner}/${input.repo}/git/blobs/${blob.oid}`;
  const content = await gh.output(
    ['api', '--hostname', input.host, route, '-H', 'Accept: application/vnd.github.raw+json'],
    true,
  );
  writeContained(root, path, content, replace);
  return { path, status: 'written' };
}

/**
 * Maps items through an async function with bounded concurrency, preserving order.
 *
 * @param {unknown[]} items - Inputs.
 * @param {number} limit - Maximum concurrent calls.
 * @param {Function} mapper - Async mapper.
 * @returns {Promise<unknown[]>} Results in input order.
 */
export async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Streams the pinned head tarball into the head directory.
 *
 * @param {object} options - Download options.
 * @param {object} options.input - Normalized pinned input.
 * @param {string} options.root - Empty head directory.
 * @param {GhClient} options.gh - gh client.
 * @param {number} options.capBytes - Extracted-size cap.
 * @param {number} [options.maxFiles] - File-count cap.
 * @returns {Promise<object>} Extraction statistics.
 * @throws {CouncilError} kinds `oversize`, `unsafe-archive`, or `api`.
 */
export async function downloadHeadTree({ input, root, gh, capBytes, maxFiles = DEFAULT_MAX_FILES }) {
  const route = `repos/${input.owner}/${input.repo}/tarball/${input.head}`;
  const child = gh.stream(['api', '--hostname', input.host, route]);
  const exited = waitForExit(child);
  const extractor = new TarExtractor({ root, capBytes, maxFiles, expectedSha: input.head });
  try {
    await pipeline(child.stdout, createGunzip(), extractor);
  } catch (error) {
    terminate(child);
    const { stderr } = await exited;
    throw error instanceof CouncilError
      ? error
      : new CouncilError('api', `repository download failed: ${bounded(stderr || error.message, 300)}`);
  }
  const { code, stderr } = await exited;
  if (code !== 0) {
    throw new CouncilError('api', `repository download failed: ${bounded(stderr, 300)}`);
  }
  return extractor.stats;
}

/**
 * Resolves when a child closes, with its exit code and stderr tail.
 *
 * @param {import('node:child_process').ChildProcess} child - Child process.
 * @returns {Promise<{code: number|null, stderr: string}>} Exit details; never rejects.
 */
function waitForExit(child) {
  return new Promise((resolve) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.once('error', (error) => resolve({ code: null, stderr: error.message }));
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

/**
 * Materializes the head side: the full tree, or changed files only when the
 * full tree is oversized, unsafe, or cannot be downloaded. Archive exports omit
 * `export-ignore` paths and rewrite `export-subst` files, so every changed text
 * file is then refreshed from its exact pinned blob.
 *
 * @param {object} options - Options for downloadHeadTree plus `files` and `reset`.
 * @param {Function} options.reset - Empties the head directory before degrading.
 * @returns {Promise<{context: string, reason: string|null, detail: string|null, stats: object|null,
 *   fetched: object[]}>} Context description.
 * @throws {CouncilError} Errors that cannot be degraded.
 */
export async function materializeHead(options) {
  let stats;
  try {
    stats = await downloadHeadTree(options);
  } catch (error) {
    const kind = degradableKind(error);
    if (!DEGRADABLE_KINDS.has(kind)) {
      throw error;
    }
    options.reset();
    const fetched = await materializeChangedFiles({ ...options, side: 'head' });
    return { context: 'changed-files', reason: kind, detail: bounded(error.message, 300), stats: null, fetched };
  }
  const fetched = await materializeChangedFiles({ ...options, side: 'head', replace: true });
  return { context: 'full', reason: null, detail: null, stats, fetched };
}

/**
 * Classifies a head-download failure; zlib corruption counts as an unsafe archive.
 *
 * @param {Error} error - Failure.
 * @returns {string|null} Error kind, or null when unclassified.
 */
function degradableKind(error) {
  if (error instanceof CouncilError) {
    return error.kind;
  }
  return String(error.code ?? '').startsWith('Z_') ? 'unsafe-archive' : null;
}

/**
 * Writes snapshot text files that members read.
 *
 * @param {Record<string, string>} paths - Workspace paths.
 * @param {object} meta - Pull-request metadata document.
 * @param {object[]} files - Normalized comparison records.
 * @param {string} diffText - Raw pinned diff.
 * @returns {void}
 */
export function writeSnapshotDocuments(paths, meta, files, diffText) {
  writeFileSync(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(paths.files, `${JSON.stringify(files, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(paths.pr, 'diff.patch'), diffText, { mode: 0o600 });
}
