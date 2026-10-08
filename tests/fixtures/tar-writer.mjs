/**
 * Builds gzip-compressed ustar/pax archives for pr-review council tests,
 * including deliberately unsafe members, without external tools.
 */

import { gzipSync } from 'node:zlib';

const BLOCK = 512;
const TYPE_FLAGS = new Map([['file', '0'], ['dir', '5'], ['symlink', '2'], ['hardlink', '1']]);

/**
 * Writes an ASCII or UTF-8 string into a header field.
 *
 * @param {Buffer} header - Header block.
 * @param {number} offset - Field offset.
 * @param {number} length - Field length.
 * @param {string} value - Field value.
 * @returns {void}
 */
function writeString(header, offset, length, value) {
  Buffer.from(value, 'utf8').copy(header, offset, 0, length);
}

/**
 * Writes a zero-padded octal number field.
 *
 * @param {Buffer} header - Header block.
 * @param {number} offset - Field offset.
 * @param {number} length - Field length.
 * @param {number} value - Number.
 * @returns {void}
 */
function writeOctal(header, offset, length, value) {
  writeString(header, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

/**
 * Builds one header block with a valid checksum.
 *
 * @param {object} entry - Header fields.
 * @returns {Buffer} Header block.
 */
function headerBlock({ name, size, type, linkName = '' }) {
  const header = Buffer.alloc(BLOCK);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, type === '5' ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  writeString(header, 157, 100, linkName);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

/**
 * Pads data to whole blocks.
 *
 * @param {Buffer} data - Payload.
 * @returns {Buffer} Padded payload.
 */
function pad(data) {
  const remainder = data.length % BLOCK;
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - remainder)]);
}

/**
 * Encodes pax records.
 *
 * @param {Record<string, string>} records - Keyword values.
 * @returns {Buffer} Record bytes.
 */
function paxPayload(records) {
  const lines = Object.entries(records).map(([key, value]) => {
    const body = ` ${key}=${value}\n`;
    const bodyLength = Buffer.byteLength(body);
    let length = bodyLength;
    let total = String(length).length + bodyLength;
    while (total !== length) {
      length = total;
      total = String(length).length + bodyLength;
    }
    return `${length}${body}`;
  });
  return Buffer.from(lines.join(''), 'utf8');
}

/**
 * Encodes one metadata member (pax global or extended header).
 *
 * @param {string} type - `g` or `x`.
 * @param {Record<string, string>} records - Keyword values.
 * @returns {Buffer} Header plus payload.
 */
function paxMember(type, records) {
  const payload = paxPayload(records);
  return Buffer.concat([headerBlock({ name: 'pax_header', size: payload.length, type }), pad(payload)]);
}

/**
 * Creates a gzip-compressed tarball shaped like GitHub's tarball endpoint output.
 *
 * @param {object[]} entries - Members: {path, type?: file|dir|symlink|hardlink, content?, target?, raw?}.
 *   Paths are prefixed with `topLevel/` unless `raw` is true.
 * @param {object} [options] - Archive options.
 * @param {string|null} [options.commit] - pax global `comment`; null omits the global header.
 * @param {string} [options.topLevel='octo-demo-aaaa111'] - Top-level directory name.
 * @returns {Buffer} Compressed archive.
 */
export function createTarball(entries, { commit = null, topLevel = 'octo-demo-aaaa111' } = {}) {
  const parts = commit === null ? [] : [paxMember('g', { comment: commit })];
  parts.push(headerBlock({ name: `${topLevel}/`, size: 0, type: '5' }));
  for (const entry of entries) {
    const type = TYPE_FLAGS.get(entry.type ?? 'file');
    const name = entry.raw ? entry.path : `${topLevel}/${entry.path}`;
    const data = Buffer.from(entry.content ?? '', 'utf8');
    const size = type === '0' ? data.length : 0;
    if (Buffer.byteLength(name) > 100) {
      parts.push(paxMember('x', { path: name }));
    }
    parts.push(headerBlock({ name: name.slice(0, 100), size, type, linkName: entry.target ?? '' }));
    if (size > 0) {
      parts.push(pad(data));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts));
}
