/**
 * Zero-dependency, fail-closed extraction of GitHub repository tarballs.
 *
 * Writes regular files only (mode 0600). Symbolic links, hard links, devices,
 * and FIFOs are recorded but never created. Absolute or dot-segment paths,
 * entries outside the single top-level directory, checksum errors, size or
 * file-count overruns, and a commit that differs from the pinned SHA abort.
 */

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { Writable } from 'node:stream';

import { CouncilError, bounded } from './errors.mjs';

const BLOCK = 512;
const MAX_META_BYTES = 1024 * 1024;
const MAX_SKIPPED_RECORDED = 200;
const FILE_TYPES = new Set(['0', '\0', '7']);
const META_TYPES = new Set(['x', 'g', 'L']);
const TYPE_NAMES = new Map([['1', 'hardlink'], ['2', 'symlink'], ['3', 'character-device'],
  ['4', 'block-device'], ['6', 'fifo'], ['K', 'long-link-name']]);

/**
 * Rounds a size up to whole tar blocks.
 *
 * @param {number} size - Byte count.
 * @returns {number} Padded byte count.
 */
function padded(size) {
  return Math.ceil(size / BLOCK) * BLOCK;
}

/**
 * Reads a NUL-terminated string field.
 *
 * @param {Buffer} header - Header block.
 * @param {number} offset - Field offset.
 * @param {number} length - Field length.
 * @returns {string} Field text.
 */
function readField(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

/**
 * Parses an octal numeric field.
 *
 * @param {Buffer} header - Header block.
 * @param {number} offset - Field offset.
 * @param {number} length - Field length.
 * @returns {number} Parsed value.
 * @throws {CouncilError} For base-256 or malformed values.
 */
function readOctal(header, offset, length) {
  if (header[offset] & 0x80) {
    throw new CouncilError('oversize', 'tar entry uses a base-256 size');
  }
  const text = readField(header, offset, length).trim();
  if (!/^[0-7]*$/.test(text)) {
    throw new CouncilError('unsafe-archive', 'tar header has a malformed numeric field');
  }
  return text === '' ? 0 : Number.parseInt(text, 8);
}

/**
 * Verifies a header block's checksum.
 *
 * @param {Buffer} header - Header block.
 * @returns {void}
 * @throws {CouncilError} On mismatch.
 */
function verifyChecksum(header) {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (readOctal(header, 148, 8) !== sum) {
    throw new CouncilError('unsafe-archive', 'tar header checksum mismatch');
  }
}

/**
 * Parses pax extended-header records into a prototype-free map.
 *
 * @param {Buffer} payload - Record bytes.
 * @returns {Record<string, string>} Keyword values.
 * @throws {CouncilError} On a malformed record.
 */
export function parsePax(payload) {
  const records = Object.create(null);
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    const length = space === -1 ? Number.NaN : Number.parseInt(payload.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isInteger(length) || length <= 0 || offset + length > payload.length) {
      throw new CouncilError('unsafe-archive', 'malformed pax record');
    }
    const record = payload.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) {
      records[record.slice(0, equals)] = record.slice(equals + 1);
    }
    offset += length;
  }
  return records;
}

/** Writable stream that extracts an uncompressed tar archive into a root directory. */
export class TarExtractor extends Writable {
  /**
   * Creates an extractor.
   *
   * @param {object} options - Extraction limits.
   * @param {string} options.root - Existing, empty destination directory.
   * @param {number} options.capBytes - Maximum total regular-file bytes.
   * @param {number} options.maxFiles - Maximum regular-file count.
   * @param {string} [options.expectedSha] - Commit the pax global header must declare.
   */
  constructor({ root, capBytes, maxFiles, expectedSha }) {
    super();
    this.root = resolve(root);
    this.capBytes = capBytes;
    this.maxFiles = maxFiles;
    this.expectedSha = expectedSha;
    this.buffer = Buffer.alloc(0);
    this.entry = null;
    this.skipRemaining = 0;
    this.pending = Object.create(null);
    this.longName = null;
    this.topLevel = null;
    this.zeroBlocks = 0;
    this.ended = false;
    this.stats = { files: 0, directories: 0, bytes: 0, skipped: [], skippedCount: 0, commit: null };
  }

  /**
   * Consumes a chunk of the archive.
   *
   * @param {Buffer} chunk - Archive bytes.
   * @param {string} _encoding - Unused.
   * @param {Function} callback - Completion callback.
   * @returns {void}
   */
  _write(chunk, _encoding, callback) {
    try {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      while (this.step()) {
        // Keep consuming complete records.
      }
      callback();
    } catch (error) {
      this.closeEntry();
      callback(error);
    }
  }

  /**
   * Verifies the archive ended cleanly and declared the pinned commit.
   *
   * @param {Function} callback - Completion callback.
   * @returns {void}
   */
  _final(callback) {
    if (this.entry || this.skipRemaining > 0 || !this.ended) {
      callback(new CouncilError('unsafe-archive', 'archive ended before its end-of-archive marker'));
      return;
    }
    if (this.expectedSha && this.stats.commit !== this.expectedSha) {
      const message = this.stats.commit ? 'archive commit differs from the pinned head' : 'archive omits its commit';
      callback(new CouncilError('unsafe-archive', message));
      return;
    }
    callback();
  }

  /**
   * Releases an open file descriptor on destroy.
   *
   * @param {Error|null} error - Destroy reason.
   * @param {Function} callback - Completion callback.
   * @returns {void}
   */
  _destroy(error, callback) {
    this.closeEntry();
    callback(error);
  }

  /**
   * Performs one unit of progress.
   *
   * @returns {boolean} True when progress was made.
   */
  step() {
    if (this.ended) {
      this.buffer = Buffer.alloc(0);
      return false;
    }
    if (this.entry) {
      return this.writeData();
    }
    if (this.skipRemaining > 0) {
      return this.skipData();
    }
    return this.buffer.length >= BLOCK && this.readHeader();
  }

  /**
   * Writes buffered bytes of the current regular file.
   *
   * @returns {boolean} True when bytes were written.
   */
  writeData() {
    const take = Math.min(this.entry.remaining, this.buffer.length);
    if (take === 0) {
      return false;
    }
    writeSync(this.entry.fd, this.buffer, 0, take);
    this.buffer = this.buffer.subarray(take);
    this.entry.remaining -= take;
    if (this.entry.remaining === 0) {
      this.skipRemaining = this.entry.padding;
      this.closeEntry();
    }
    return true;
  }

  /**
   * Discards buffered bytes of skipped data or padding.
   *
   * @returns {boolean} True when bytes were discarded.
   */
  skipData() {
    const take = Math.min(this.skipRemaining, this.buffer.length);
    if (take === 0) {
      return false;
    }
    this.buffer = this.buffer.subarray(take);
    this.skipRemaining -= take;
    return true;
  }

  /**
   * Parses the next header block (and a metadata payload when complete).
   *
   * @returns {boolean} True when the header was consumed.
   */
  readHeader() {
    const header = this.buffer.subarray(0, BLOCK);
    if (header.every((byte) => byte === 0)) {
      this.buffer = this.buffer.subarray(BLOCK);
      this.zeroBlocks += 1;
      this.ended = this.zeroBlocks >= 2;
      return true;
    }
    this.zeroBlocks = 0;
    verifyChecksum(header);
    const type = header[156] === 0 ? '\0' : String.fromCharCode(header[156]);
    const size = readOctal(header, 124, 12);
    if (META_TYPES.has(type)) {
      return this.readMeta(type, size);
    }
    this.buffer = this.buffer.subarray(BLOCK);
    this.handleEntry(header, type, size);
    return true;
  }

  /**
   * Consumes a pax or GNU long-name metadata record once fully buffered.
   *
   * @param {string} type - Metadata type flag.
   * @param {number} size - Payload size.
   * @returns {boolean} True when consumed; false while waiting for more bytes.
   */
  readMeta(type, size) {
    if (size > MAX_META_BYTES) {
      throw new CouncilError('unsafe-archive', 'tar metadata record is too large');
    }
    const total = BLOCK + padded(size);
    if (this.buffer.length < total) {
      return false;
    }
    const payload = this.buffer.subarray(BLOCK, BLOCK + size);
    this.buffer = this.buffer.subarray(total);
    if (type === 'L') {
      this.longName = readField(payload, 0, payload.length);
    } else if (type === 'x') {
      this.pending = parsePax(payload);
    } else {
      this.stats.commit = parsePax(payload).comment ?? this.stats.commit;
    }
    return true;
  }

  /**
   * Extracts, creates, or records one archive member.
   *
   * @param {Buffer} header - Header block.
   * @param {string} type - Type flag.
   * @param {number} headerSize - Size from the header.
   * @returns {void}
   */
  handleEntry(header, type, headerSize) {
    const prefix = readField(header, 257, 6) === 'ustar' ? readField(header, 345, 155) : '';
    const name = readField(header, 0, 100);
    const rawPath = this.pending.path ?? this.longName ?? (prefix ? `${prefix}/${name}` : name);
    const size = this.pending.size === undefined ? headerSize : Number(this.pending.size);
    const target = this.pending.linkpath ?? readField(header, 157, 100);
    this.pending = Object.create(null);
    this.longName = null;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new CouncilError('unsafe-archive', 'tar entry has an invalid size');
    }
    const relativePath = this.safeRelativePath(rawPath);
    if (relativePath !== null && FILE_TYPES.has(type)) {
      this.openFile(relativePath, size);
      return;
    }
    if (relativePath !== null && type === '5') {
      mkdirSync(join(this.root, relativePath), { recursive: true, mode: 0o700 });
      this.stats.directories += 1;
    } else if (relativePath !== null) {
      this.recordSkipped(relativePath, type, target);
    }
    this.skipRemaining = padded(size);
  }

  /**
   * Validates an archive path and strips the single top-level directory.
   *
   * @param {string} rawPath - Path from the archive.
   * @returns {string|null} Safe relative path, or null for the top-level directory itself.
   * @throws {CouncilError} For unsafe paths.
   */
  safeRelativePath(rawPath) {
    if (rawPath.startsWith('/') || rawPath.includes('\0') || rawPath.includes('\\')) {
      throw new CouncilError('unsafe-archive', `unsafe archive path: ${bounded(rawPath, 120)}`);
    }
    const parts = rawPath.split('/').filter((part) => part !== '');
    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
      throw new CouncilError('unsafe-archive', `unsafe archive path: ${bounded(rawPath, 120)}`);
    }
    this.topLevel ??= parts[0];
    if (parts[0] !== this.topLevel) {
      throw new CouncilError('unsafe-archive', 'archive has more than one top-level directory');
    }
    if (parts.length === 1) {
      return null;
    }
    const relativePath = parts.slice(1).join('/');
    if (!resolve(this.root, relativePath).startsWith(`${this.root}${sep}`)) {
      throw new CouncilError('unsafe-archive', 'archive path escapes the snapshot');
    }
    return relativePath;
  }

  /**
   * Creates a regular file exclusively and prepares to stream its data.
   *
   * @param {string} relativePath - Safe relative path.
   * @param {number} size - File size.
   * @returns {void}
   * @throws {CouncilError} kind `oversize` when a cap would be exceeded.
   */
  openFile(relativePath, size) {
    if (this.stats.files + 1 > this.maxFiles || this.stats.bytes + size > this.capBytes) {
      throw new CouncilError('oversize', 'repository snapshot exceeds the configured size or file-count cap');
    }
    const absolute = join(this.root, relativePath);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    const fd = openSync(absolute, 'wx', 0o600);
    this.stats.files += 1;
    this.stats.bytes += size;
    this.entry = { fd, remaining: size, padding: padded(size) - size };
    if (size === 0) {
      this.skipRemaining = this.entry.padding;
      this.closeEntry();
    }
  }

  /**
   * Records a member that is intentionally not created.
   *
   * @param {string} relativePath - Member path.
   * @param {string} type - Type flag.
   * @param {string} target - Link target, when any.
   * @returns {void}
   */
  recordSkipped(relativePath, type, target) {
    this.stats.skippedCount += 1;
    if (this.stats.skipped.length < MAX_SKIPPED_RECORDED) {
      this.stats.skipped.push({
        path: bounded(relativePath, 300),
        type: TYPE_NAMES.get(type) ?? `type-${bounded(type, 4)}`,
        target: bounded(target, 300),
      });
    }
  }

  /**
   * Closes the current file descriptor, if any.
   *
   * @returns {void}
   */
  closeEntry() {
    if (this.entry) {
      closeSync(this.entry.fd);
      this.entry = null;
    }
  }
}
