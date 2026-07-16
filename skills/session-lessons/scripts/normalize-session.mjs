#!/usr/bin/env node

/**
 * Normalizes local Claude Code and GitHub Copilot CLI transcripts.
 *
 * The module intentionally uses only Node built-ins. SQLite discovery shells out
 * to an installed sqlite3 binary with an argument array and never uses a shell.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';

const SUPPORTED_SOURCES = new Set(['auto', 'claude', 'copilot']);
const PRIVATE_BLOCK_TYPES = new Set(['thinking', 'reasoning', 'redacted_thinking']);
const DEFAULT_TEXT_LIMIT = 2_000;
const TOOL_TEXT_LIMIT = 500;
const JSON_PREFIX_LENGTH_LIMIT = 1024 * 1024;
const JSON_PREFIX_DEPTH_LIMIT = 128;
const JSON_COMPLETE = 'complete';
const JSON_INCOMPLETE = 'incomplete';
const JSON_INVALID = 'invalid';
const SENSITIVE_KEYS = new Set([
  'accesskey',
  'accesstoken',
  'apikey',
  'apisecret',
  'auth',
  'authorization',
  'clientsecret',
  'credential',
  'credentials',
  'password',
  'passwd',
  'privatekey',
  'refreshtoken',
  'secret',
  'sessiontoken',
  'token',
]);
const SENSITIVE_KEY_SUFFIXES = [
  'apikey',
  'apisecret',
  'secretaccesskey',
  'accesskeyid',
  'accesskey',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'clientsecret',
  'privatekey',
  'password',
  'passwd',
  'credential',
  'credentials',
];
const SENSITIVE_KEY_BASE_SOURCE = [
  'api[_-]?(?:key|secret)',
  '(?:secret[_-]?)?access[_-]?key(?:[_-]?id)?',
  '(?:access|refresh|session)[_-]?token',
  'client[_-]?secret',
  'private[_-]?key',
  'auth(?:orization)?',
  'password',
  'passwd',
  'secret',
  'token',
  'credentials?',
].join('|');
const SENSITIVE_KEY_SOURCE = String.raw`(?:[A-Za-z0-9]+[_-]+)*(?:${SENSITIVE_KEY_BASE_SOURCE})`;
const SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`((?:"(?:${SENSITIVE_KEY_SOURCE})"|'(?:${SENSITIVE_KEY_SOURCE})'`
    + String.raw`|\b(?:${SENSITIVE_KEY_SOURCE})\b)\s*[:=]\s*)`
    + String.raw`("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`
    + String.raw`|(?:(?:Basic|Bearer|Token)\s+)?[^\s,;}\]]+)`,
  'gi',
);

/**
 * Reports whether an object key names sensitive credential material.
 *
 * @param {string} key - Object key.
 * @returns {boolean} Whether the value must be redacted.
 */
function isSensitiveKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEYS.has(normalized)
    || SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * Redacts sensitive values recursively before structured data is serialized.
 *
 * @param {unknown} value - Structured value.
 * @param {string} replacement - Credential replacement marker.
 * @param {WeakSet<object>} [seen] - Circular-reference guard.
 * @returns {unknown} Redacted structured value.
 */
function redactStructuredValue(value, replacement, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactStructuredValue(item, replacement, seen));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    isSensitiveKey(key) ? replacement : redactStructuredValue(item, replacement, seen),
  ]));
}

/**
 * Parses JSON-looking strings so quoted credential keys are redacted structurally.
 *
 * @param {string} text - Transcript text.
 * @param {string} replacement - Credential replacement marker.
 * @returns {string} Original text or redacted serialized JSON.
 */
function redactJsonString(text, replacement) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return text;
  }
  try {
    return JSON.stringify(redactStructuredValue(JSON.parse(text), replacement));
  } catch {
    return text;
  }
}

/**
 * Redacts complete sensitive-key assignments while preserving quotes and auth scheme names.
 *
 * @param {string} text - Transcript text.
 * @param {string} replacement - Credential replacement marker.
 * @returns {string} Text with assignment values redacted.
 */
function redactCredentialAssignments(text, replacement) {
  return text.replace(SENSITIVE_ASSIGNMENT_PATTERN, (match, prefix, value) => {
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      return `${prefix}${quote}${replacement}${quote}`;
    }
    const scheme = value.match(/^(?:Basic|Bearer|Token)\s+/i)?.[0] ?? '';
    return `${prefix}${scheme}${replacement}`;
  });
}

/**
 * Decodes one base64url JSON segment, returning null for non-JSON data.
 *
 * @param {string} segment - Base64url segment.
 * @returns {unknown|null} Parsed JSON value.
 */
function decodeBase64UrlJson(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Redacts plausible three-segment compact JWTs without matching ordinary dotted text.
 *
 * @param {string} text - Transcript text.
 * @param {string} replacement - Credential replacement marker.
 * @returns {string} Text with compact JWTs redacted.
 */
function redactCompactJwts(text, replacement) {
  const pattern = new RegExp(
    String.raw`(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{12,256})`
      + String.raw`\.([A-Za-z0-9_-]{12,4096})`
      + String.raw`\.([A-Za-z0-9_-]{16,1024})(?![A-Za-z0-9_-])`,
    'g',
  );
  return text.replace(pattern, (match, prefix, headerSegment, payloadSegment) => {
    const header = decodeBase64UrlJson(headerSegment);
    const payload = decodeBase64UrlJson(payloadSegment);
    const plausibleHeader = header && typeof header === 'object' && typeof header.alg === 'string';
    const plausiblePayload = payload && typeof payload === 'object' && !Array.isArray(payload);
    return plausibleHeader && plausiblePayload ? `${prefix}${replacement}` : match;
  });
}

/**
 * Redacts credentials and private identifiers from observable transcript text.
 *
 * @param {unknown} value - Transcript value to sanitize.
 * @param {number} [limit=DEFAULT_TEXT_LIMIT] - Maximum retained characters.
 * @returns {string} Redacted, bounded text.
 */
export function redactText(value, limit = DEFAULT_TEXT_LIMIT) {
  const credentialReplacement = '[REDACTED_' + 'CREDENTIAL]';
  let text = typeof value === 'string'
    ? redactJsonString(value, credentialReplacement)
    : JSON.stringify(redactStructuredValue(value ?? '', credentialReplacement));
  text = text
    .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/gi,
      '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      credentialReplacement)
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, credentialReplacement)
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, credentialReplacement)
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, credentialReplacement)
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, credentialReplacement)
    .replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, credentialReplacement)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, credentialReplacement)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, credentialReplacement)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      '[REDACTED_ID]')
    .replace(/\b[0-9a-f]{24,}\b/gi, '[REDACTED_ID]')
    .replace(/\/Users\/[^/\s]+/g, '~')
    .replace(/\/home\/[^/\s]+/g, '~')
    .replace(
      /(\.claude[\\/]+projects[\\/]+)-(?:Users|home)-[^/\\\s]+/gi,
      '$1[REDACTED_CLAUDE_PROJECT]',
    )
    .replace(/\b[A-Z]:\\+Users\\+[^\\\s"']+/gi, '~');
  text = redactCredentialAssignments(text, credentialReplacement);
  text = redactCompactJwts(text, credentialReplacement);
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, () => credentialReplacement);
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}… [TRUNCATED]`;
}

/**
 * Converts a private tool-call identifier into a deterministic local correlation token.
 *
 * @param {unknown} value - Harness tool-call identifier.
 * @returns {string|undefined} Stable redacted identifier.
 */
function redactStableIdentifier(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const digest = createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
  return `tool-${digest}`;
}

/**
 * Skips JSON whitespace.
 *
 * @param {{ text: string, index: number }} state - Parser state.
 */
function skipJsonWhitespace(state) {
  while (state.index < state.text.length && /[ \t\r\n]/.test(state.text[state.index])) {
    state.index += 1;
  }
}

/**
 * Parses a JSON string token or a valid incomplete prefix.
 *
 * @param {{ text: string, index: number }} state - Parser state.
 * @returns {'complete'|'incomplete'|'invalid'} Parse status.
 */
function parseJsonStringPrefix(state) {
  if (state.text[state.index] !== '"') {
    return JSON_INVALID;
  }
  state.index += 1;
  while (state.index < state.text.length) {
    const character = state.text[state.index];
    state.index += 1;
    if (character === '"') {
      return JSON_COMPLETE;
    }
    if (character.charCodeAt(0) < 0x20) {
      return JSON_INVALID;
    }
    if (character !== '\\') {
      continue;
    }
    if (state.index >= state.text.length) {
      return JSON_INCOMPLETE;
    }
    const escape = state.text[state.index];
    state.index += 1;
    if ('"\\/bfnrt'.includes(escape)) {
      continue;
    }
    if (escape !== 'u') {
      return JSON_INVALID;
    }
    for (let digit = 0; digit < 4; digit += 1) {
      if (state.index >= state.text.length) {
        return JSON_INCOMPLETE;
      }
      if (!/[0-9a-f]/i.test(state.text[state.index])) {
        return JSON_INVALID;
      }
      state.index += 1;
    }
  }
  return JSON_INCOMPLETE;
}

/**
 * Parses a fixed JSON literal or a valid incomplete prefix.
 *
 * @param {{ text: string, index: number }} state - Parser state.
 * @param {string} literal - Expected literal.
 * @returns {'complete'|'incomplete'|'invalid'} Parse status.
 */
function parseJsonLiteralPrefix(state, literal) {
  for (const expected of literal) {
    if (state.index >= state.text.length) {
      return JSON_INCOMPLETE;
    }
    if (state.text[state.index] !== expected) {
      return JSON_INVALID;
    }
    state.index += 1;
  }
  return JSON_COMPLETE;
}

/**
 * Parses a JSON number or a valid incomplete numeric prefix.
 *
 * @param {{ text: string, index: number }} state - Parser state.
 * @returns {'complete'|'incomplete'|'invalid'} Parse status.
 */
function parseJsonNumberPrefix(state) {
  if (state.text[state.index] === '-') {
    state.index += 1;
    if (state.index >= state.text.length) {
      return JSON_INCOMPLETE;
    }
  }

  if (state.text[state.index] === '0') {
    state.index += 1;
    if (/\d/.test(state.text[state.index] ?? '')) {
      return JSON_INVALID;
    }
  } else if (/[1-9]/.test(state.text[state.index] ?? '')) {
    while (/\d/.test(state.text[state.index] ?? '')) {
      state.index += 1;
    }
  } else {
    return JSON_INVALID;
  }

  if (state.text[state.index] === '.') {
    state.index += 1;
    if (state.index >= state.text.length) {
      return JSON_INCOMPLETE;
    }
    if (!/\d/.test(state.text[state.index])) {
      return JSON_INVALID;
    }
    while (/\d/.test(state.text[state.index] ?? '')) {
      state.index += 1;
    }
  }

  if (/[eE]/.test(state.text[state.index] ?? '')) {
    state.index += 1;
    if (state.index >= state.text.length) {
      return JSON_INCOMPLETE;
    }
    if (/[+-]/.test(state.text[state.index])) {
      state.index += 1;
      if (state.index >= state.text.length) {
        return JSON_INCOMPLETE;
      }
    }
    if (!/\d/.test(state.text[state.index])) {
      return JSON_INVALID;
    }
    while (/\d/.test(state.text[state.index] ?? '')) {
      state.index += 1;
    }
  }
  return JSON_COMPLETE;
}

/**
 * Parses a JSON array or a valid incomplete prefix.
 *
 * @param {{ text: string, index: number }} state - Parser state.
 * @param {number} depth - Current nesting depth.
 * @returns {'complete'|'incomplete'|'invalid'} Parse status.
 */
function parseJsonArrayPrefix(state, depth) {
  if (depth > JSON_PREFIX_DEPTH_LIMIT) {
    return JSON_INVALID;
  }
  state.index += 1;
  skipJsonWhitespace(state);
  if (state.index >= state.text.length) {
    return JSON_INCOMPLETE;
  }
  if (state.text[state.index] === ']') {
    state.index += 1;
    return JSON_COMPLETE;
  }

  while (state.index < state.text.length) {
    const valueStatus = parseJsonValuePrefix(state, depth + 1);
    if (valueStatus !== JSON_COMPLETE) {
      return valueStatus;
    }
    skipJsonWhitespace(state);
    if (state.index >= state.text.length) {
      return JSON_INCOMPLETE;
    }
    if (state.text[state.index] === ']') {
      state.index += 1;
      return JSON_COMPLETE;
    }
    if (state.text[state.index] !== ',') {
      return JSON_INVALID;
    }
    state.index += 1;
    skipJsonWhitespace(state);
    if (state.index >= state.text.length) {
      return JSON_INCOMPLETE;
    }
    if (state.text[state.index] === ']') {
      return JSON_INVALID;
    }
  }
  return JSON_INCOMPLETE;
}

/**
 * Parses a JSON object or a valid incomplete prefix.
 *
 * @param {{ text: string, index: number }} state - Parser state.
 * @param {number} depth - Current nesting depth.
 * @returns {'complete'|'incomplete'|'invalid'} Parse status.
 */
function parseJsonObjectPrefix(state, depth) {
  if (depth > JSON_PREFIX_DEPTH_LIMIT) {
    return JSON_INVALID;
  }
  state.index += 1;
  skipJsonWhitespace(state);
  if (state.index >= state.text.length) {
    return JSON_INCOMPLETE;
  }
  if (state.text[state.index] === '}') {
    state.index += 1;
    return JSON_COMPLETE;
  }

  while (state.index < state.text.length) {
    if (state.text[state.index] !== '"') {
      return JSON_INVALID;
    }
    const keyStatus = parseJsonStringPrefix(state);
    if (keyStatus !== JSON_COMPLETE) {
      return keyStatus;
    }
    skipJsonWhitespace(state);
    if (state.index >= state.text.length) {
      return JSON_INCOMPLETE;
    }
    if (state.text[state.index] !== ':') {
      return JSON_INVALID;
    }
    state.index += 1;
    skipJsonWhitespace(state);
    if (state.index >= state.text.length) {
      return JSON_INCOMPLETE;
    }
    const valueStatus = parseJsonValuePrefix(state, depth + 1);
    if (valueStatus !== JSON_COMPLETE) {
      return valueStatus;
    }
    skipJsonWhitespace(state);
    if (state.index >= state.text.length) {
      return JSON_INCOMPLETE;
    }
    if (state.text[state.index] === '}') {
      state.index += 1;
      return JSON_COMPLETE;
    }
    if (state.text[state.index] !== ',') {
      return JSON_INVALID;
    }
    state.index += 1;
    skipJsonWhitespace(state);
    if (state.index >= state.text.length) {
      return JSON_INCOMPLETE;
    }
    if (state.text[state.index] === '}') {
      return JSON_INVALID;
    }
  }
  return JSON_INCOMPLETE;
}

/**
 * Parses one JSON value or a valid incomplete prefix.
 *
 * @param {{ text: string, index: number }} state - Parser state.
 * @param {number} depth - Current nesting depth.
 * @returns {'complete'|'incomplete'|'invalid'} Parse status.
 */
function parseJsonValuePrefix(state, depth) {
  skipJsonWhitespace(state);
  if (state.index >= state.text.length) {
    return JSON_INCOMPLETE;
  }
  const character = state.text[state.index];
  if (character === '"') {
    return parseJsonStringPrefix(state);
  }
  if (character === '{') {
    return parseJsonObjectPrefix(state, depth);
  }
  if (character === '[') {
    return parseJsonArrayPrefix(state, depth);
  }
  if (character === 't') {
    return parseJsonLiteralPrefix(state, 'true');
  }
  if (character === 'f') {
    return parseJsonLiteralPrefix(state, 'false');
  }
  if (character === 'n') {
    return parseJsonLiteralPrefix(state, 'null');
  }
  if (character === '-' || /\d/.test(character)) {
    return parseJsonNumberPrefix(state);
  }
  return JSON_INVALID;
}

/**
 * Classifies a bounded string as complete, incomplete, or invalid JSON.
 *
 * @param {string} text - JSON text or prefix.
 * @returns {'complete'|'incomplete'|'invalid'} Parse status.
 */
function classifyJsonPrefix(text) {
  if (text.length === 0 || text.length > JSON_PREFIX_LENGTH_LIMIT) {
    return JSON_INVALID;
  }
  const state = { text, index: 0 };
  const status = parseJsonValuePrefix(state, 0);
  if (status !== JSON_COMPLETE) {
    return status;
  }
  skipJsonWhitespace(state);
  return state.index === state.text.length ? JSON_COMPLETE : JSON_INVALID;
}

/**
 * Checks whether invalid JSON is a demonstrably incomplete EOF prefix.
 *
 * @param {string} line - Invalid final JSONL line.
 * @returns {boolean} Whether the line is demonstrably truncated.
 */
function canCompleteJsonPrefix(line) {
  const trimmed = line.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  return classifyJsonPrefix(trimmed) === JSON_INCOMPLETE;
}

/**
 * Parses JSONL while tolerating an incomplete final line.
 *
 * @param {string} text - JSONL document.
 * @param {object} [options] - Parser options.
 * @param {'claude'|'copilot'|'session'} [options.source='session'] - Sanitized source label.
 * @returns {{ records: object[], ignoredPartialLine: boolean }} Parsed records.
 * @throws {Error} If a complete line is invalid JSON.
 */
export function parseJsonLines(text, { source = 'session' } = {}) {
  const sourceLabel = ['claude', 'copilot', 'session'].includes(source) ? source : 'session';
  const hasFinalNewline = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (hasFinalNewline) {
    lines.pop();
  }

  const records = [];
  let ignoredPartialLine = false;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      const isPartialFinalLine = index === lines.length - 1
        && !hasFinalNewline
        && canCompleteJsonPrefix(line);
      if (isPartialFinalLine) {
        ignoredPartialLine = true;
        continue;
      }
      throw new Error(
        `Invalid JSONL at line ${index + 1} (source: ${sourceLabel}): malformed complete record`,
      );
    }
  }
  return { records, ignoredPartialLine };
}

/**
 * Encodes a working directory using Claude Code's project-directory convention.
 *
 * @param {string} cwd - Absolute working directory.
 * @returns {string} Encoded Claude project directory name.
 */
export function encodeClaudeCwd(cwd) {
  return resolve(cwd).replace(/[\\/]/g, '-').replace(/:/g, '-');
}

/**
 * Returns the expected Claude transcript path for a session.
 *
 * @param {object} options - Path options.
 * @param {string} options.homeDirectory - User home directory.
 * @param {string} options.cwd - Session working directory.
 * @param {string} options.sessionId - Claude session identifier.
 * @returns {string} Absolute transcript path.
 */
export function claudeTranscriptPath({ homeDirectory, cwd, sessionId }) {
  return join(homeDirectory, '.claude', 'projects', encodeClaudeCwd(cwd), `${sessionId}.jsonl`);
}

/**
 * Returns the expected Copilot event-log path for a session.
 *
 * @param {object} options - Path options.
 * @param {string} options.homeDirectory - User home directory.
 * @param {string} options.sessionId - Copilot session identifier.
 * @returns {string} Absolute event-log path.
 */
export function copilotTranscriptPath({ homeDirectory, sessionId }) {
  return join(homeDirectory, '.copilot', 'session-state', sessionId, 'events.jsonl');
}

/**
 * Converts supported message content into visible text and tool evidence.
 *
 * @param {unknown} content - Harness-specific message content.
 * @returns {{ text: string, tools: object[] }} Observable content.
 */
function observableContent(content) {
  if (typeof content === 'string') {
    return { text: redactText(content), tools: [] };
  }
  if (!Array.isArray(content)) {
    return { text: '', tools: [] };
  }

  const texts = [];
  const tools = [];
  for (const block of content) {
    if (typeof block === 'string') {
      texts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object' || PRIVATE_BLOCK_TYPES.has(block.type)) {
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      continue;
    }
    if (block.type === 'tool_use') {
      const toolName = redactText(block.name ?? 'unknown', 100);
      tools.push({
        kind: 'tool_call',
        toolCallId: redactStableIdentifier(block.id),
        toolName,
        arguments: redactText(block.input ?? {}, TOOL_TEXT_LIMIT),
        text: `Called ${toolName}`,
      });
      continue;
    }
    if (block.type === 'tool_result') {
      const result = observableContent(block.content);
      tools.push({
        kind: 'tool_result',
        toolCallId: redactStableIdentifier(block.tool_use_id),
        toolName: redactText(block.name ?? block.tool_name ?? 'unknown', 100),
        success: block.is_error !== true,
        text: result.text,
      });
    }
  }
  return {
    text: redactText(texts.join('\n')),
    tools,
  };
}

/**
 * Creates a normalized observable event.
 *
 * @param {object} values - Event values.
 * @returns {object} Shared event model.
 */
function event(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== ''));
}

/**
 * Normalizes Claude Code JSONL records.
 *
 * @param {object[]} records - Parsed Claude transcript records.
 * @returns {object[]} Shared observable events.
 */
export function normalizeClaudeRecords(records) {
  const events = [];
  const toolCalls = new Map();
  for (const record of records) {
    if (!['user', 'assistant', 'system'].includes(record.type)) {
      continue;
    }
    const content = observableContent(record.message?.content);
    if (content.text) {
      events.push(event({
        source: 'claude',
        timestamp: record.timestamp,
        actor: record.type,
        kind: 'message',
        text: content.text,
      }));
    }
    for (const tool of content.tools) {
      const matchingCall = tool.kind === 'tool_result' && tool.toolCallId
        ? toolCalls.get(tool.toolCallId)
        : null;
      const normalizedTool = event({
        source: 'claude',
        timestamp: record.timestamp,
        actor: 'tool',
        ...tool,
        toolName: tool.toolName === 'unknown' ? matchingCall?.toolName ?? 'unknown' : tool.toolName,
        arguments: tool.arguments ?? matchingCall?.arguments,
        text: redactText(tool.text, TOOL_TEXT_LIMIT),
      });
      events.push(normalizedTool);
      if (normalizedTool.kind === 'tool_call' && normalizedTool.toolCallId) {
        toolCalls.set(normalizedTool.toolCallId, normalizedTool);
      }
    }
  }
  return events;
}

/**
 * Extracts a Copilot event's public content without reading reasoningText.
 *
 * @param {object} record - Copilot event record.
 * @returns {unknown} Observable content.
 */
function copilotContent(record) {
  return record.data?.content ?? record.data?.message?.content ?? '';
}

/**
 * Normalizes GitHub Copilot CLI event records.
 *
 * @param {object[]} records - Parsed Copilot events.
 * @returns {object[]} Shared observable events.
 */
export function normalizeCopilotRecords(records) {
  const events = [];
  const toolCalls = new Map();
  for (const record of records) {
    if (['user.message', 'assistant.message', 'system.message'].includes(record.type)) {
      const actor = record.type.split('.')[0];
      const content = observableContent(copilotContent(record));
      if (content.text) {
        events.push(event({
          source: 'copilot',
          timestamp: record.timestamp,
          actor,
          kind: 'message',
          text: content.text,
        }));
      }
      continue;
    }
    if (record.type === 'abort') {
      events.push(event({
        source: 'copilot',
        timestamp: record.timestamp,
        actor: 'user',
        kind: 'abort',
        text: redactText(record.data?.reason ?? 'user interrupted the session', TOOL_TEXT_LIMIT),
      }));
      continue;
    }
    if (record.type === 'tool.execution_start') {
      const toolCallId = record.data?.toolCallId
        ?? record.data?.tool_call_id
        ?? record.toolCallId
        ?? record.tool_call_id;
      const toolName = redactText(record.data?.toolName ?? record.data?.name ?? 'unknown', 100);
      const redactedToolCallId = redactStableIdentifier(toolCallId);
      const argumentsText = redactText(
        record.data?.arguments ?? record.data?.input ?? record.arguments ?? {},
        TOOL_TEXT_LIMIT,
      );
      const toolCall = event({
        source: 'copilot',
        timestamp: record.timestamp,
        actor: 'tool',
        kind: 'tool_call',
        toolCallId: redactedToolCallId,
        toolName,
        arguments: argumentsText,
        text: `Called ${redactText(toolName, 100)}`,
      });
      events.push(toolCall);
      if (toolCallId) {
        toolCalls.set(toolCallId, toolCall);
      }
      continue;
    }
    if (record.type === 'tool.execution_complete') {
      const toolCallId = record.data?.toolCallId
        ?? record.data?.tool_call_id
        ?? record.toolCallId
        ?? record.tool_call_id;
      const matchingCall = toolCallId ? toolCalls.get(toolCallId) : null;
      const redactedToolCallId = redactStableIdentifier(toolCallId);
      const toolName = redactText(
        record.data?.toolName ?? record.data?.name ?? matchingCall?.toolName ?? 'unknown',
        100,
      );
      const argumentsText = redactText(
        record.data?.arguments
          ?? record.data?.input
          ?? record.arguments
          ?? matchingCall?.arguments
          ?? {},
        TOOL_TEXT_LIMIT,
      );
      const success = record.data?.success !== false && record.data?.result?.success !== false;
      const failureText = success ? '' : record.data?.result?.content ?? record.data?.error ?? 'tool failed';
      events.push(event({
        source: 'copilot',
        timestamp: record.timestamp,
        actor: 'tool',
        kind: 'tool_result',
        toolCallId: redactedToolCallId,
        toolName,
        arguments: argumentsText,
        success,
        text: success ? `Completed ${redactText(toolName, 100)}` : redactText(failureText, TOOL_TEXT_LIMIT),
      }));
    }
  }
  return events;
}

/**
 * Infers a harness from parsed records.
 *
 * @param {object[]} records - Parsed transcript records.
 * @returns {'claude'|'copilot'|null} Detected source.
 */
export function inferSource(records) {
  const copilotTypes = new Set([
    'user.message',
    'assistant.message',
    'system.message',
    'abort',
    'tool.execution_start',
    'tool.execution_complete',
  ]);
  if (records.some((record) => copilotTypes.has(record.type))) {
    return 'copilot';
  }
  if (records.some((record) => ['user', 'assistant', 'system'].includes(record.type) && record.message)) {
    return 'claude';
  }
  return null;
}

/**
 * Normalizes parsed records with the selected adapter.
 *
 * @param {'claude'|'copilot'} source - Harness adapter name.
 * @param {object[]} records - Parsed transcript records.
 * @returns {object[]} Shared observable events.
 */
export function normalizeRecords(source, records) {
  const adapter = SESSION_ADAPTERS[source];
  if (!adapter) {
    throw new Error(`Unsupported source: ${source}`);
  }
  return adapter.normalize(records);
}

/**
 * Builds a safely escaped read-only discovery query for Copilot metadata.
 *
 * @param {string} cwd - Repository working directory.
 * @param {number} limit - Maximum sessions to return.
 * @param {string} [repositoryRoot=cwd] - Repository root used for subdirectory matching.
 * @returns {string} SQLite query.
 */
export function buildCopilotDiscoveryQuery(cwd, limit, repositoryRoot = cwd) {
  const paths = [...new Set([resolve(cwd), resolve(repositoryRoot)])]
    .map((path) => `'${path.replaceAll("'", "''")}'`)
    .join(', ');
  const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 10));
  return [
    'SELECT id, COALESCE(updated_at, created_at), COALESCE(summary, \'\')',
    'FROM sessions',
    `WHERE cwd IN (${paths}) OR git_root IN (${paths})`,
    'ORDER BY COALESCE(updated_at, created_at) DESC',
    `LIMIT ${safeLimit};`,
  ].join(' ');
}

/**
 * Resolves the local Git repository root without invoking a shell.
 *
 * @param {string} cwd - Working directory.
 * @param {Function} [execFile=execFileSync] - Injectable execFileSync implementation.
 * @returns {string} Repository root, or cwd when Git cannot resolve one.
 */
export function discoverRepositoryRoot(cwd, execFile = execFileSync) {
  try {
    return resolve(execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim());
  } catch {
    return resolve(cwd);
  }
}

/**
 * Discovers Copilot sessions from the local SQLite registry.
 *
 * @param {object} options - Discovery options.
 * @param {string} options.homeDirectory - User home directory.
 * @param {string} options.cwd - Repository working directory.
 * @param {string} [options.repositoryRoot] - Repository root for subdirectory matching.
 * @param {number} [options.limit=10] - Maximum sessions.
 * @param {Function} [options.execFile=execFileSync] - Injectable execFileSync implementation.
 * @param {Function} [options.gitExecFile=execFileSync] - Injectable Git execFileSync implementation.
 * @returns {object[]} Local session candidates.
 */
export function discoverCopilotSessions({
  homeDirectory,
  cwd,
  repositoryRoot,
  limit = 10,
  execFile = execFileSync,
  gitExecFile = execFileSync,
}) {
  const expectedRepositoryRoot = repositoryRoot
    ? resolve(repositoryRoot)
    : discoverRepositoryRoot(cwd, gitExecFile);
  const database = join(homeDirectory, '.copilot', 'session-store.db');
  if (!existsSync(database)) {
    return discoverCopilotStateSessions({
      homeDirectory,
      cwd,
      repositoryRoot: expectedRepositoryRoot,
      limit,
    });
  }
  try {
    const output = execFile(
      'sqlite3',
      [
        '-readonly',
        '-separator',
        '\t',
        database,
        buildCopilotDiscoveryQuery(cwd, limit, expectedRepositoryRoot),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const sessions = output.trim().split('\n').filter(Boolean).map((line) => {
      const [sessionId, updatedAt, summary = ''] = line.split('\t');
      return {
        source: 'copilot',
        sessionId,
        updatedAt,
        summary: redactText(summary, 160),
        path: copilotTranscriptPath({ homeDirectory, sessionId }),
      };
    }).filter((candidate) => existsSync(candidate.path));
    return sessions.length > 0
      ? sessions
      : discoverCopilotStateSessions({
        homeDirectory,
        cwd,
        repositoryRoot: expectedRepositoryRoot,
        limit,
      });
  } catch {
    return discoverCopilotStateSessions({
      homeDirectory,
      cwd,
      repositoryRoot: expectedRepositoryRoot,
      limit,
    });
  }
}

/**
 * Reads a workspace cwd or git_root from Copilot's small local YAML file.
 *
 * @param {string} sessionDirectory - Local session-state directory.
 * @returns {{ cwd: string|null, gitRoot: string|null }|null} Recorded workspace paths.
 */
function readCopilotWorkspace(sessionDirectory) {
  const workspacePath = join(sessionDirectory, 'workspace.yaml');
  if (!existsSync(workspacePath)) {
    return null;
  }
  const content = readFileSync(workspacePath, 'utf8');
  const workspace = {
    cwd: readWorkspaceValue(content, 'cwd'),
    gitRoot: readWorkspaceValue(content, 'git_root'),
  };
  if (!workspace.cwd && !workspace.gitRoot) {
    return null;
  }
  return workspace;
}

/**
 * Reads one top-level scalar from Copilot workspace YAML.
 *
 * @param {string} content - Workspace YAML.
 * @param {string} key - Scalar key.
 * @returns {string|null} Unquoted scalar value.
 */
function readWorkspaceValue(content, key) {
  const match = content.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  return match ? match[1].replace(/^["']|["']$/g, '') : null;
}

/**
 * Discovers Copilot sessions by scanning local session-state metadata.
 *
 * @param {object} options - Discovery options.
 * @param {string} options.homeDirectory - User home directory.
 * @param {string} options.cwd - Repository working directory.
 * @param {string} [options.repositoryRoot=cwd] - Repository root.
 * @param {number} [options.limit=10] - Maximum sessions.
 * @returns {object[]} Local session candidates.
 */
export function discoverCopilotStateSessions({
  homeDirectory,
  cwd,
  repositoryRoot = cwd,
  limit = 10,
}) {
  const stateDirectory = join(homeDirectory, '.copilot', 'session-state');
  if (!existsSync(stateDirectory)) {
    return [];
  }
  const expectedPaths = new Set([resolve(cwd), resolve(repositoryRoot)]);
  return readdirSync(stateDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const sessionDirectory = join(stateDirectory, entry.name);
      const path = join(sessionDirectory, 'events.jsonl');
      const workspace = readCopilotWorkspace(sessionDirectory);
      const workspacePaths = workspace
        ? [workspace.cwd, workspace.gitRoot].filter(Boolean).map((value) => resolve(value))
        : [];
      const matchesWorkspace = workspacePaths.some((value) => expectedPaths.has(value));
      if (!existsSync(path) || !matchesWorkspace) {
        return null;
      }
      return {
        source: 'copilot',
        sessionId: entry.name,
        updatedAt: statSync(path).mtime.toISOString(),
        summary: '',
        path,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

/**
 * Reports whether a path is equal to or contained by a repository root.
 *
 * @param {string} candidatePath - Candidate working directory.
 * @param {string} repositoryRoot - Expected repository root.
 * @returns {boolean} Whether the candidate belongs to the repository.
 */
function pathBelongsToRepository(candidatePath, repositoryRoot) {
  const relativePath = relative(resolve(repositoryRoot), resolve(candidatePath));
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

/**
 * Reads observable top-level Claude cwd and git-root metadata.
 *
 * @param {string} transcriptPath - Claude transcript path.
 * @returns {{ cwds: Set<string>, gitRoots: Set<string> }} Workspace association.
 */
function readClaudeWorkspaceAssociation(transcriptPath) {
  const cwds = new Set();
  const gitRoots = new Set();
  const lines = readFileSync(transcriptPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      const cwdValues = [record.cwd, record.workspace?.cwd];
      const gitRootValues = [
        record.git_root,
        record.gitRoot,
        record.repositoryRoot,
        record.workspace?.git_root,
        record.workspace?.gitRoot,
      ];
      cwdValues.filter((value) => typeof value === 'string').forEach((value) => cwds.add(resolve(value)));
      gitRootValues
        .filter((value) => typeof value === 'string')
        .forEach((value) => gitRoots.add(resolve(value)));
    } catch {
      // Discovery ignores malformed/partial lines and never reads message content.
    }
  }
  return { cwds, gitRoots };
}

/**
 * Checks whether a Claude transcript can be associated with the requested repository.
 *
 * @param {string} transcriptPath - Claude transcript path.
 * @param {string} cwd - Current working directory.
 * @param {string} repositoryRoot - Resolved repository root.
 * @returns {boolean} Whether the candidate is safely associated.
 */
function matchesClaudeRepository(transcriptPath, cwd, repositoryRoot) {
  const association = readClaudeWorkspaceAssociation(transcriptPath);
  if (association.gitRoots.size > 0) {
    return [...association.gitRoots].some((value) => resolve(value) === resolve(repositoryRoot));
  }
  if (association.cwds.size > 0) {
    return [...association.cwds].some((value) => pathBelongsToRepository(value, repositoryRoot));
  }
  const projectDirectory = basename(dirname(transcriptPath));
  return new Set([encodeClaudeCwd(cwd), encodeClaudeCwd(repositoryRoot)]).has(projectDirectory);
}

/**
 * Lists Claude transcript paths across local project directories.
 *
 * @param {string} homeDirectory - User home directory.
 * @param {string} [sessionId] - Optional exact session identifier.
 * @returns {string[]} Local transcript paths.
 */
function listClaudeTranscriptPaths(homeDirectory, sessionId) {
  const projectsDirectory = join(homeDirectory, '.claude', 'projects');
  if (!existsSync(projectsDirectory)) {
    return [];
  }
  if (sessionId && !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    throw new Error('Invalid Claude session id');
  }

  const paths = [];
  for (const project of readdirSync(projectsDirectory, { withFileTypes: true })) {
    if (!project.isDirectory()) {
      continue;
    }
    const projectDirectory = join(projectsDirectory, project.name);
    if (sessionId) {
      const path = join(projectDirectory, `${sessionId}.jsonl`);
      if (existsSync(path)) {
        paths.push(path);
      }
      continue;
    }
    for (const name of readdirSync(projectDirectory)) {
      if (name.endsWith('.jsonl')) {
        paths.push(join(projectDirectory, name));
      }
    }
  }
  return paths;
}

/**
 * Resolves an explicit Claude session across repository subdirectory project folders.
 *
 * @param {object} options - Resolution options.
 * @param {string} options.homeDirectory - User home directory.
 * @param {string} options.cwd - Current working directory.
 * @param {string} options.repositoryRoot - Resolved repository root.
 * @param {string} options.sessionId - Explicit Claude session identifier.
 * @returns {object|null} Matching local session, or null.
 * @throws {Error} If more than one associated transcript matches.
 */
export function resolveClaudeSession({
  homeDirectory,
  cwd,
  repositoryRoot,
  sessionId,
}) {
  const matches = listClaudeTranscriptPaths(homeDirectory, sessionId)
    .filter((path) => matchesClaudeRepository(path, cwd, repositoryRoot))
    .map((path) => ({
      source: 'claude',
      sessionId,
      updatedAt: statSync(path).mtime.toISOString(),
      summary: '',
      path,
    }));
  if (matches.length > 1) {
    throw new Error(`Ambiguous local Claude session ${redactText(sessionId, 80)}`);
  }
  return matches[0] ?? null;
}

/**
 * Discovers Claude sessions across project directories associated with one repository.
 *
 * @param {object} options - Discovery options.
 * @param {string} options.homeDirectory - User home directory.
 * @param {string} options.cwd - Repository working directory.
 * @param {string} [options.repositoryRoot] - Resolved repository root.
 * @param {number} [options.limit=10] - Maximum sessions.
 * @returns {object[]} Local session candidates.
 */
export function discoverClaudeSessions({
  homeDirectory,
  cwd,
  repositoryRoot = discoverRepositoryRoot(cwd),
  limit = 10,
}) {
  return listClaudeTranscriptPaths(homeDirectory)
    .filter((path) => matchesClaudeRepository(path, cwd, repositoryRoot))
    .map((path) => ({
      source: 'claude',
      sessionId: basename(path, '.jsonl'),
      updatedAt: statSync(path).mtime.toISOString(),
      summary: '',
      path,
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

/**
 * Harness adapters used by source resolution and normalization.
 */
export const SESSION_ADAPTERS = Object.freeze({
  claude: Object.freeze({
    transcriptPath: claudeTranscriptPath,
    discover: discoverClaudeSessions,
    normalize: normalizeClaudeRecords,
  }),
  copilot: Object.freeze({
    transcriptPath: copilotTranscriptPath,
    discover: discoverCopilotSessions,
    normalize: normalizeCopilotRecords,
  }),
});

/**
 * Resolves a transcript using explicit overrides before local auto-detection.
 *
 * @param {object} options - Resolution options.
 * @param {'auto'|'claude'|'copilot'} [options.source='auto'] - Source override.
 * @param {string} [options.sessionId] - Session override.
 * @param {string} [options.inputPath] - Transcript path override.
 * @param {string} [options.cwd=process.cwd()] - Session working directory.
 * @param {string} [options.repositoryRoot] - Resolved repository root.
 * @param {string} [options.homeDirectory=homedir()] - User home directory.
 * @returns {{ source: 'claude'|'copilot', sessionId: string, path: string }} Resolution.
 */
export function resolveTranscript({
  source = 'auto',
  sessionId,
  inputPath,
  cwd = process.cwd(),
  repositoryRoot,
  homeDirectory = homedir(),
}) {
  if (!SUPPORTED_SOURCES.has(source)) {
    throw new Error(`Invalid source "${source}"; expected auto, claude, or copilot`);
  }

  if (inputPath) {
    const path = resolve(inputPath);
    const parsed = parseJsonLines(readFileSync(path, 'utf8'), {
      source: source === 'auto' ? 'session' : source,
    });
    const detected = source === 'auto' ? inferSource(parsed.records) : source;
    if (!detected) {
      throw new Error('Could not infer transcript source; pass --source');
    }
    return { source: detected, sessionId: sessionId ?? 'explicit-input', path };
  }

  const environmentSession = source === 'claude'
    ? process.env.CLAUDE_SESSION_ID
    : source === 'copilot'
      ? process.env.COPILOT_SESSION_ID
      : process.env.COPILOT_SESSION_ID ?? process.env.CLAUDE_SESSION_ID;
  const selectedSession = sessionId ?? process.env.SESSION_LESSONS_SESSION_ID ?? environmentSession;
  const selectedSource = source === 'auto' ? process.env.SESSION_LESSONS_SOURCE ?? 'auto' : source;
  if (!SUPPORTED_SOURCES.has(selectedSource)) {
    throw new Error(`Invalid source "${selectedSource}"; expected auto, claude, or copilot`);
  }
  const expectedRepositoryRoot = repositoryRoot
    ? resolve(repositoryRoot)
    : discoverRepositoryRoot(cwd);

  if (selectedSession) {
    const matches = [];
    if (selectedSource === 'auto' || selectedSource === 'copilot') {
      const path = copilotTranscriptPath({ homeDirectory, sessionId: selectedSession });
      if (existsSync(path)) {
        matches.push({ source: 'copilot', sessionId: selectedSession, path });
      }
    }
    if (selectedSource === 'auto' || selectedSource === 'claude') {
      const claudeSession = resolveClaudeSession({
        homeDirectory,
        cwd,
        repositoryRoot: expectedRepositoryRoot,
        sessionId: selectedSession,
      });
      if (claudeSession) {
        matches.push(claudeSession);
      }
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous local session source for ${redactText(selectedSession, 80)}`);
    }
    if (matches.length === 1) {
      return matches[0];
    }
    throw new Error(`No associated local transcript found for session ${redactText(selectedSession, 80)}`);
  }

  const candidates = [
    ...(selectedSource === 'auto' || selectedSource === 'copilot'
      ? discoverCopilotSessions({
        homeDirectory,
        cwd,
        repositoryRoot: expectedRepositoryRoot,
      }) : []),
    ...(selectedSource === 'auto' || selectedSource === 'claude'
      ? discoverClaudeSessions({
        homeDirectory,
        cwd,
        repositoryRoot: expectedRepositoryRoot,
      }) : []),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (candidates.length === 0) {
    throw new Error('No local session transcript found; pass --source and --session or --input');
  }
  return candidates[0];
}

/**
 * Reads and normalizes a resolved local transcript.
 *
 * @param {object} options - Resolution options accepted by resolveTranscript.
 * @returns {object} Source metadata and shared observable events.
 */
export function loadNormalizedSession(options = {}) {
  const resolvedTranscript = resolveTranscript(options);
  const parsed = parseJsonLines(readFileSync(resolvedTranscript.path, 'utf8'), {
    source: resolvedTranscript.source,
  });
  return {
    source: resolvedTranscript.source,
    sessionId: redactText(resolvedTranscript.sessionId, 80),
    path: redactText(resolvedTranscript.path, 500),
    ignoredPartialLine: parsed.ignoredPartialLine,
    events: normalizeRecords(resolvedTranscript.source, parsed.records),
  };
}

/**
 * Sanitizes a top-level CLI error without exposing raw filesystem details or secrets.
 *
 * @param {unknown} error - Caught error.
 * @returns {string} Single-line sanitized error text.
 */
export function sanitizeTopLevelError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  const genericFileSystemMessages = {
    EACCES: 'Local input could not be accessed due to permissions.',
    EEXIST: 'A required local target already exists or is locked.',
    EISDIR: 'The selected local input is not a readable transcript file.',
    ELOOP: 'A local path contains an unsafe symbolic-link loop.',
    ENOENT: 'The selected local input was not found.',
    ENOTDIR: 'The selected local input path is invalid.',
    EPERM: 'Local input could not be accessed due to permissions.',
  };
  const rawMessage = genericFileSystemMessages[code]
    ?? (error instanceof Error ? error.message : String(error));
  return redactText(rawMessage, 500).replace(/[\r\n]+/g, ' ');
}

/**
 * Parses the normalizer's intentionally small CLI surface.
 *
 * @param {string[]} argv - Process arguments after the script name.
 * @returns {object} Normalizer options.
 */
function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--pretty') {
      options.pretty = true;
      continue;
    }
    const key = {
      '--source': 'source',
      '--session': 'sessionId',
      '--input': 'inputPath',
      '--cwd': 'cwd',
      '--repo-root': 'repositoryRoot',
      '--home': 'homeDirectory',
    }[argument];
    if (!key || !argv[index + 1]) {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
    options[key] = argv[index + 1];
    index += 1;
  }
  return options;
}

/**
 * Runs the normalizer command-line interface.
 *
 * @param {string[]} argv - Process arguments after the script name.
 */
function main(argv) {
  const options = parseArguments(argv);
  const result = loadNormalizedSession(options);
  process.stdout.write(`${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`session-lessons: ${sanitizeTopLevelError(error)}\n`);
    process.exitCode = 1;
  }
}
