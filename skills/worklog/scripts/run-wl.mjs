#!/usr/bin/env node

/**
 * Executes a constrained worklog CLI request without invoking a shell.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { connect } from 'node:net';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const SERVER_READY_TIMEOUT_MS = 10_000;
const SERVER_POLL_INTERVAL_MS = 100;
const SIGNAL_ESCALATION_MS = 1_000;
const WL_SERVER_PORT = 9292;
const MAX_EXPORT_ENTRIES = 10_000;
const MAX_EXPORT_BYTES = 100 * 1024 * 1024;
const MAX_EXPORT_DEPTH = 16;
const TAKEOUT_PATTERN = /^worklog_takeout_\d{8}_\d{6}\.tar\.gz$/u;
const REQUEST_FILE_PATTERN = /^worklog-request-[A-Za-z0-9._-]+\.json$/u;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const RUBY_DEBUG_FILTER = 'worklog-adapter-suppress-debug';
const MUTATING_COMMANDS = new Set([
  'add',
  'github',
  'init',
  'remove',
  'storage-export',
  'storage-import',
  'takeout',
]);
const CONFIRMATION_REQUIRED = new Set(['github', 'init', 'remove', 'storage-import']);

const SHOW_DATE_RANGE_FLAGS = {
  date: { type: 'date' },
  from: { type: 'date' },
  since: { type: 'date' },
  to: { type: 'date' },
  days: { type: 'days' },
};

const DATE_RANGE_FLAGS = {
  date: { type: 'date' },
  from: { type: 'date' },
  to: { type: 'date' },
  days: { type: 'days' },
};

const COMMANDS = {
  version: { argv: ['version'], flags: {} },
  add: {
    argv: ['add'],
    message: true,
    flags: {
      date: { type: 'date' },
      time: { type: 'time' },
      tags: { type: 'tags' },
      ticket: { type: 'identifier' },
      url: { type: 'url' },
      epic: { type: 'boolean' },
      project: { type: 'identifier' },
    },
  },
  show: {
    argv: ['show'],
    flags: {
      ...SHOW_DATE_RANGE_FLAGS,
      epicsOnly: { type: 'boolean', cliName: 'epics-only' },
      tags: { type: 'tags' },
      project: { type: 'identifier' },
    },
  },
  standup: { argv: ['standup'], flags: DATE_RANGE_FLAGS },
  summary: { argv: ['summary'], flags: DATE_RANGE_FLAGS },
  stats: { argv: ['stats'], flags: {} },
  projects: { argv: ['projects'], flags: { oneline: { type: 'boolean' } } },
  people: { argv: ['people'], flags: { inactive: { type: 'boolean' } } },
  tags: { argv: ['tags'], flags: DATE_RANGE_FLAGS },
  remove: { argv: ['remove'], flags: { date: { type: 'date' } } },
  github: { argv: ['github'], flags: {} },
  init: { argv: ['init'], flags: {} },
  server: { argv: ['server'], flags: { logPath: { type: 'logPath', adapterOnly: true } } },
  takeout: {
    argv: ['takeout'],
    flags: { outputPath: { type: 'takeoutOutputPath', adapterOnly: true } },
  },
  'storage-export': {
    argv: ['storage', 'export'],
    flags: {
      path: { type: 'exportPath' },
      format: { type: 'format' },
    },
  },
  'storage-import': {
    argv: ['storage', 'import'],
    flags: {
      path: { type: 'importPath' },
      format: { type: 'format' },
    },
  },
};

/**
 * Represents an invalid or unsafe adapter request.
 */
class RequestError extends Error {}

/**
 * Tests whether a value is a non-array JSON object.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} Whether the value is a record.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rejects unknown object fields.
 *
 * @param {Record<string, unknown>} value - Object to inspect.
 * @param {string[]} allowed - Allowed field names.
 * @param {string} label - Object label for errors.
 */
function assertAllowedFields(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new RequestError(`${label} contains unknown field(s): ${unknown.join(', ')}`);
  }
}

/**
 * Validates a bounded single-line string.
 *
 * @param {unknown} value - Value to validate.
 * @param {string} label - Field label.
 * @param {number} [maxLength=1024] - Maximum accepted length.
 * @returns {string} Validated string.
 */
function validateString(value, label, maxLength = 1024) {
  if (typeof value !== 'string') {
    throw new RequestError(`${label} must be a string`);
  }
  if (value.length === 0 || value.length > maxLength) {
    throw new RequestError(`${label} must contain 1-${maxLength} characters`);
  }
  if (/[\0-\x1f\x7f]/u.test(value)) {
    throw new RequestError(`${label} must not contain control characters`);
  }
  return value;
}

/**
 * Validates a real calendar date in YYYY-MM-DD form.
 *
 * @param {unknown} value - Value to validate.
 * @param {string} label - Field label.
 * @returns {string} Validated date.
 */
function validateDate(value, label) {
  const date = validateString(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new RequestError(`${label} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new RequestError(`${label} is not a valid calendar date`);
  }
  return date;
}

/**
 * Validates a worklog time value.
 *
 * @param {unknown} value - Value to validate.
 * @param {string} label - Field label.
 * @returns {string} Validated time.
 */
function validateTime(value, label) {
  const time = validateString(value, label, 8);
  const match = time.match(/^(\d{2})(?::?(\d{2}))(?::(\d{2}))?$/u);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] ?? 0) > 59) {
    throw new RequestError(`${label} must be a valid HHMM, HH:MM, or HH:MM:SS time`);
  }
  return time;
}

/**
 * Validates a positive day count represented as a string.
 *
 * @param {unknown} value - Value to validate.
 * @param {string} label - Field label.
 * @returns {string} Validated day count.
 */
function validateDays(value, label) {
  const days = validateString(value, label, 4);
  if (!/^\d+$/u.test(days) || Number(days) < 1 || Number(days) > 3660) {
    throw new RequestError(`${label} must be a string integer from 1 through 3660`);
  }
  return days;
}

/**
 * Validates a project, ticket, or similar identifier.
 *
 * @param {unknown} value - Value to validate.
 * @param {string} label - Field label.
 * @returns {string} Validated identifier.
 */
function validateIdentifier(value, label) {
  const identifier = validateString(value, label, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(identifier)) {
    throw new RequestError(`${label} contains unsupported characters`);
  }
  return identifier;
}

/**
 * Validates a list of worklog tags.
 *
 * @param {unknown} value - Value to validate.
 * @param {string} label - Field label.
 * @returns {string[]} Validated tags.
 */
function validateTags(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new RequestError(`${label} must be a non-empty array with at most 50 strings`);
  }
  return value.map((tag, index) => {
    const validated = validateString(tag, `${label}[${index}]`, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(validated)) {
      throw new RequestError(`${label}[${index}] contains unsupported characters`);
    }
    return validated;
  });
}

/**
 * Validates an HTTP or HTTPS URL.
 *
 * @param {unknown} value - Value to validate.
 * @param {string} label - Field label.
 * @returns {string} Validated URL.
 */
function validateUrl(value, label) {
  const rawUrl = validateString(value, label, 2048);
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new RequestError(`${label} must be a valid URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new RequestError(`${label} must use http or https`);
  }
  return rawUrl;
}

/**
 * Validates an absolute filesystem path.
 *
 * @param {unknown} value - Value to validate.
 * @param {string} label - Field label.
 * @returns {string} Validated path.
 */
function validateAbsolutePath(value, label) {
  const path = validateString(value, label, 4096);
  if (!isAbsolute(path)) {
    throw new RequestError(`${label} must be an absolute path`);
  }
  return path;
}

/**
 * Rejects symlink paths because export/import behavior must target the named location.
 *
 * @param {string} path - Existing path to inspect.
 * @param {string} label - Field label.
 */
function rejectSymlink(path, label) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new RequestError(`${label} must not be a symbolic link`);
  }
}

/**
 * Validates an existing import directory.
 *
 * @param {unknown} value - Value to validate.
 * @param {string} label - Field label.
 * @returns {string} Validated directory.
 */
function validateImportPath(value, label) {
  const path = validateAbsolutePath(value, label);
  rejectSymlink(path, label);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new RequestError(`${label} must be an existing directory`);
  }
  return path;
}

/**
 * Validates every existing directory in an absolute parent chain.
 *
 * @param {string} directory - Existing absolute directory.
 * @param {string} label - Field label.
 */
function validateDirectoryChain(directory, label) {
  const normalized = normalize(directory);
  const root = parse(normalized).root;
  const segments = relative(root, normalized).split(sep).filter(Boolean);
  const rootEntry = lstatSync(root);
  if (!rootEntry.isDirectory() || isUnsafeWritableDirectory(rootEntry)) {
    throw new RequestError(`${label} parent chain must contain protected real directories`);
  }
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const entry = lstatSync(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new RequestError(`${label} parent chain must contain only real directories`);
    }
    if (isUnsafeWritableDirectory(entry)) {
      throw new RequestError(`${label} parent chain must not contain unsafe writable directories`);
    }
  }
}

/**
 * Tests whether a directory is group/world writable without sticky-bit protection.
 *
 * @param {import('node:fs').Stats} entry - Directory metadata.
 * @returns {boolean} Whether the directory is unsafe for staging.
 */
function isUnsafeWritableDirectory(entry) {
  return (entry.mode & 0o022) !== 0 && (entry.mode & 0o1000) === 0;
}

/**
 * Validates an export path and its existing parent.
 *
 * @param {unknown} value - Value to validate.
 * @param {string} label - Field label.
 * @returns {string} Validated path.
 */
function validateExportPath(value, label) {
  const path = normalize(validateAbsolutePath(value, label));
  rejectSymlink(path, label);
  if (existsSync(path) && !statSync(path).isDirectory()) {
    throw new RequestError(`${label} must be a directory path`);
  }
  const parent = dirname(path);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new RequestError(`${label} parent must be an existing directory`);
  }
  validateDirectoryChain(parent, label);
  if (existsSync(path)) {
    const destination = lstatSync(path);
    if (!destination.isDirectory() || isUnsafeWritableDirectory(destination)) {
      throw new RequestError(`${label} must be a real, non-writable-by-others directory`);
    }
  }
  return path;
}

/**
 * Validates an explicit takeout archive output path.
 *
 * @param {unknown} value - Value to validate.
 * @param {string} label - Field label.
 * @returns {string} Validated output path.
 */
function validateTakeoutOutputPath(value, label) {
  const path = normalize(validateAbsolutePath(value, label));
  if (!path.endsWith('.tar.gz')) {
    throw new RequestError(`${label} must end with .tar.gz`);
  }
  rejectSymlink(path, label);
  if (existsSync(path) && !statSync(path).isFile()) {
    throw new RequestError(`${label} must be a file path`);
  }
  const parent = dirname(path);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new RequestError(`${label} parent must be an existing directory`);
  }
  validateDirectoryChain(parent, label);
  return path;
}

/**
 * Validates a new server log path.
 *
 * @param {unknown} value - Value to validate.
 * @param {string} label - Field label.
 * @returns {string} Validated log path.
 */
function validateLogPath(value, label) {
  const path = normalize(validateAbsolutePath(value, label));
  if (existsSync(path)) {
    throw new RequestError(`${label} already exists; choose a new log path`);
  }
  const parent = dirname(path);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new RequestError(`${label} parent must be an existing directory`);
  }
  validateDirectoryChain(parent, label);
  return path;
}

/**
 * Validates one flag value using its declared type.
 *
 * @param {unknown} value - Value to validate.
 * @param {string} label - Field label.
 * @param {string} type - Schema type.
 * @returns {string | string[] | boolean} Validated value.
 */
function validateFlagValue(value, label, type) {
  const validators = {
    date: validateDate,
    time: validateTime,
    days: validateDays,
    identifier: validateIdentifier,
    tags: validateTags,
    url: validateUrl,
    importPath: validateImportPath,
    exportPath: validateExportPath,
    takeoutOutputPath: validateTakeoutOutputPath,
    logPath: validateLogPath,
  };
  if (type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new RequestError(`${label} must be a boolean`);
    }
    return value;
  }
  if (type === 'format') {
    if (value !== 'yaml') {
      throw new RequestError(`${label} must be the string "yaml"`);
    }
    return value;
  }
  return validators[type](value, label);
}

/**
 * Rejects ambiguous combinations of date-range flags.
 *
 * @param {Record<string, string | string[] | boolean>} flags - Validated flags.
 */
function validateDateRange(flags) {
  if (flags.from && flags.since) {
    throw new RequestError('flags.from and flags.since are aliases and cannot be combined');
  }
  const rangeStart = flags.from ?? flags.since;
  if (flags.date && (rangeStart || flags.to)) {
    throw new RequestError('flags.date cannot be combined with range flags');
  }
  if (flags.date && flags.days) {
    throw new RequestError('flags.date cannot be combined with flags.days');
  }
  if (flags.days && (rangeStart || flags.to)) {
    throw new RequestError('flags.days cannot be combined with range flags');
  }
  if (flags.to && !rangeStart) {
    throw new RequestError('flags.to requires flags.from or flags.since');
  }
  if (rangeStart && flags.to && rangeStart > flags.to) {
    throw new RequestError('range start must not be after flags.to');
  }
}

/**
 * Validates command-specific filesystem safety constraints.
 *
 * @param {string} command - Command name.
 * @param {Record<string, string | string[] | boolean>} flags - Validated flags.
 * @param {boolean} confirmed - Whether the caller recorded explicit confirmation.
 */
function validateCommandSafety(command, flags, confirmed) {
  if (CONFIRMATION_REQUIRED.has(command) && !confirmed) {
    throw new RequestError(`${command} requires confirmed: true`);
  }
  if (command === 'storage-export') {
    if (!flags.path) {
      throw new RequestError('storage-export requires flags.path');
    }
    if (existsSync(flags.path) && readdirSync(flags.path).length > 0 && !confirmed) {
      throw new RequestError('storage-export into a non-empty directory requires confirmed: true');
    }
  }
  if (command === 'storage-import' && !flags.path) {
    throw new RequestError('storage-import requires flags.path');
  }
  if (command === 'takeout') {
    if (!flags.outputPath) {
      throw new RequestError('takeout requires flags.outputPath');
    }
    if (existsSync(flags.outputPath) && !confirmed) {
      throw new RequestError(`takeout output already exists; confirm overwrite of ${flags.outputPath}`);
    }
  }
  if (command === 'server' && !flags.logPath) {
    throw new RequestError('server requires flags.logPath');
  }
}

/**
 * Validates the complete JSON request.
 *
 * @param {unknown} value - Parsed JSON value.
 * @returns {{
 *   command: string,
 *   message?: string,
 *   flags: Record<string, string | string[] | boolean>,
 *   confirmed: boolean
 * }} Validated request.
 */
function validateRequest(value) {
  if (!isRecord(value)) {
    throw new RequestError('request must be a JSON object');
  }
  assertAllowedFields(value, ['command', 'message', 'flags', 'confirmed'], 'request');
  const command = validateString(value.command, 'command', 64);
  const definition = COMMANDS[command];
  if (!definition) {
    throw new RequestError(`unsupported command: ${command}`);
  }
  const confirmed = value.confirmed ?? false;
  if (typeof confirmed !== 'boolean') {
    throw new RequestError('confirmed must be a boolean');
  }
  const rawFlags = value.flags ?? {};
  if (!isRecord(rawFlags)) {
    throw new RequestError('flags must be a JSON object');
  }
  assertAllowedFields(rawFlags, Object.keys(definition.flags), 'flags');
  const flags = {};
  for (const [name, flagValue] of Object.entries(rawFlags)) {
    flags[name] = validateFlagValue(flagValue, `flags.${name}`, definition.flags[name].type);
  }
  validateDateRange(flags);
  validateCommandSafety(command, flags, confirmed);

  let message;
  if (definition.message) {
    message = validateString(value.message, 'message', 10_000);
  } else if (Object.hasOwn(value, 'message')) {
    throw new RequestError(`message is not allowed for ${command}`);
  }
  return { command, message, flags, confirmed };
}

/**
 * Appends one validated CLI flag to an argv array.
 *
 * @param {string[]} argv - Arguments being built.
 * @param {string} cliName - CLI flag name without dashes.
 * @param {string | string[] | boolean} value - Validated flag value.
 */
function appendFlag(argv, cliName, value) {
  if (value === false) {
    return;
  }
  if (value === true) {
    argv.push(`--${cliName}`);
  } else if (Array.isArray(value)) {
    argv.push(`--${cliName}`, ...value);
  } else {
    argv.push(`--${cliName}=${value}`);
  }
}

/**
 * Builds add argv with a Thor array terminator and protected positional message.
 *
 * @param {{
 *   message: string,
 *   flags: Record<string, string | string[] | boolean>
 * }} request - Validated add request.
 * @returns {string[]} Worklog arguments.
 */
function buildAddArguments(request) {
  const argv = ['add'];
  for (const name of ['date', 'time', 'ticket', 'url', 'project']) {
    if (Object.hasOwn(request.flags, name)) {
      appendFlag(argv, name, request.flags[name]);
    }
  }
  if (request.flags.tags) {
    appendFlag(argv, 'tags', request.flags.tags);
  }
  argv.push(request.flags.epic === true ? '--epic' : '--no-epic');
  argv.push('--', request.message);
  return argv;
}

/**
 * Converts a validated request to literal child-process arguments.
 *
 * @param {{
 *   command: string,
 *   message?: string,
 *   flags: Record<string, string | string[] | boolean>
 * }} request - Validated request.
 * @returns {string[]} Worklog arguments.
 */
function buildArguments(request) {
  if (request.command === 'add') {
    return buildAddArguments(request);
  }
  const definition = COMMANDS[request.command];
  const argv = [...definition.argv];
  for (const [name, value] of Object.entries(request.flags)) {
    const flag = definition.flags[name];
    if (flag.adapterOnly) {
      continue;
    }
    const cliName = flag.cliName ?? name;
    appendFlag(argv, cliName, value);
  }
  return argv;
}

/**
 * Conservatively removes only prefixed DEBUG lines if source suppression was unavailable.
 *
 * @param {string} stdout - Raw completed stdout.
 * @returns {string} Cleaned stdout.
 */
function cleanDebugLines(stdout) {
  return stdout
    .split(/\r?\n/u)
    .filter((line) => !/^D, \[[^\]]+\]\s+DEBUG\s+--\s+:/u.test(line))
    .join('\n');
}

/**
 * Extracts warning messages from retained Ruby Logger records.
 *
 * @param {string} output - Cleaned command output.
 * @returns {string[]} Warning messages.
 */
function parseWarnings(output) {
  const warnings = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^W, \[[^\]]+\]\s+WARN\s+--\s+:\s?(.*)$/u);
    if (match) {
      warnings.push(match[1]);
    }
  }
  return warnings;
}

/**
 * Parses the last informational write confirmation where feasible.
 *
 * @param {string} command - Executed command.
 * @param {string} output - Cleaned command output.
 * @returns {{ level: string, message: string } | null} Parsed confirmation.
 */
function parseConfirmation(command, output) {
  if (!MUTATING_COMMANDS.has(command)) {
    return null;
  }
  let confirmation = null;
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^I, \[[^\]]+\]\s+INFO\s+--\s+:\s?(.*)$/u);
    if (match) {
      confirmation = { level: 'INFO', message: match[1] };
    }
  }
  return confirmation;
}

/**
 * Builds a complete structured response.
 *
 * @param {Partial<{
 *   ok: boolean,
 *   exitCode: number | null,
 *   signal: string | null,
 *   stdout: string,
 *   stderr: string,
 *   warnings: string[],
 *   confirmation: object | null
 * }>} values - Response overrides.
 * @returns {object} Complete response.
 */
function response(values = {}) {
  return {
    ok: false,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    warnings: [],
    confirmation: null,
    ...values,
  };
}

/**
 * Builds the child environment with wl Ruby DEBUG logging suppressed at source.
 *
 * @returns {NodeJS.ProcessEnv} Child process environment.
 */
function childEnvironment() {
  const rubyLib = [SCRIPT_DIRECTORY, process.env.RUBYLIB].filter(Boolean).join(delimiter);
  const rubyOpt = [process.env.RUBYOPT, `-r${RUBY_DEBUG_FILTER}`].filter(Boolean).join(' ');
  return { ...process.env, RUBYLIB: rubyLib, RUBYOPT: rubyOpt };
}

/**
 * Returns the independent POSIX process-group ID for a detached child.
 *
 * @param {import('node:child_process').ChildProcess} child - Spawned child.
 * @returns {number | null} Process-group ID, or null on Windows.
 */
function processGroupId(child) {
  return process.platform === 'win32' ? null : child.pid;
}

/**
 * Checks whether the tracked child process tree still exists.
 *
 * @param {import('node:child_process').ChildProcess} child - Spawned child.
 * @param {number | null} groupId - Independent POSIX process-group ID.
 * @returns {boolean} Whether the process tree is alive.
 */
function isProcessTreeAlive(child, groupId) {
  if (!groupId && (child.exitCode !== null || child.signalCode !== null)) {
    return false;
  }
  const target = groupId ? -groupId : child.pid;
  if (!target) {
    return false;
  }
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') {
      return true;
    }
    if (error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

/**
 * Sends a signal to the retained process group on POSIX, or the child on Windows.
 *
 * @param {import('node:child_process').ChildProcess} child - Spawned child.
 * @param {number | null} groupId - Independent POSIX process-group ID.
 * @param {NodeJS.Signals} signal - Signal to send.
 */
function signalProcessTree(child, groupId, signal) {
  const target = groupId ? -groupId : child.pid;
  if (!target || (!groupId && child.exitCode !== null)) {
    return;
  }
  try {
    process.kill(target, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}

/**
 * Runs wl synchronously from the adapter's perspective and captures bounded output.
 *
 * @param {string[]} argv - Literal arguments passed to wl.
 * @param {string | undefined} cwd - Optional working directory.
 * @returns {Promise<{
 *   exitCode: number | null,
 *   signal: string | null,
 *   stdout: string,
 *   stderr: string,
 *   warnings: string[],
 *   spawnError?: Error
 * }>} Completed process result.
 */
function runWorklog(argv, cwd) {
  return new Promise((resolve) => {
    const child = spawn('wl', argv, {
      cwd,
      detached: process.platform !== 'win32',
      env: childEnvironment(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const groupId = processGroupId(child);
    const stdout = [];
    const stderr = [];
    const warnings = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let spawnError;
    let terminatedForOutput = false;
    let forwardedSignal = null;
    let terminationPromise = null;

    /**
     * Starts exact-tree termination and escalation.
     *
     * @param {NodeJS.Signals} signal - Initial signal.
     */
    function terminateTree(signal) {
      if (terminationPromise) {
        signalProcessTree(child, groupId, 'SIGKILL');
        return;
      }
      terminationPromise = stopProcessTree(child, groupId, signal);
    }

    /**
     * Forwards a signal received by the adapter.
     *
     * @param {NodeJS.Signals} signal - Received signal.
     */
    function forwardSignal(signal) {
      if (forwardedSignal) {
        signalProcessTree(child, groupId, 'SIGKILL');
        return;
      }
      forwardedSignal = signal;
      terminateTree(signal);
    }

    const onSigint = () => forwardSignal('SIGINT');
    const onSigterm = () => forwardSignal('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);

    /**
     * Collects a bounded output chunk and terminates an over-producing child.
     *
     * @param {Buffer} chunk - Output chunk.
     * @param {Buffer[]} chunks - Destination chunks.
     * @param {'stdout' | 'stderr'} streamName - Stream label.
     */
    function collect(chunk, chunks, streamName) {
      if (terminatedForOutput) {
        return;
      }
      if (streamName === 'stdout') {
        stdoutBytes += chunk.length;
      } else {
        stderrBytes += chunk.length;
      }
      if (stdoutBytes + stderrBytes > MAX_OUTPUT_BYTES) {
        terminatedForOutput = true;
        warnings.push(`wl output exceeded ${MAX_OUTPUT_BYTES} bytes and was terminated`);
        terminateTree('SIGTERM');
        return;
      }
      chunks.push(chunk);
    }

    child.stdout.on('data', (chunk) => collect(chunk, stdout, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, stderr, 'stderr'));
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', async (exitCode, signal) => {
      if (terminationPromise) {
        await terminationPromise;
      }
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      resolve({
        exitCode,
        signal: signal ?? forwardedSignal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        warnings,
        spawnError,
      });
    });
  });
}

/**
 * Checks whether a local TCP port currently accepts connections.
 *
 * @param {number} port - TCP port.
 * @param {number} [timeoutMs=250] - Connection timeout.
 * @returns {Promise<boolean>} Whether the port accepted a connection.
 */
function isPortOpen(port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;

    /**
     * Resolves once and closes the probe socket.
     *
     * @param {boolean} open - Probe result.
     */
    function finish(open) {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(open);
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Parses the bound port reported by Rackup/Puma in the server log.
 *
 * @param {number} logFd - Exact exclusively opened server log descriptor.
 * @returns {number | null} Reported port, if available.
 */
function parseBoundPort(logFd) {
  const file = fstatSync(logFd);
  if (file.size === 0) {
    return null;
  }
  const length = Math.min(file.size, 64 * 1024);
  const buffer = Buffer.allocUnsafe(length);
  const read = readSync(logFd, buffer, 0, length, Math.max(0, file.size - length));
  const log = buffer.subarray(0, read).toString('utf8');
  const match = log.match(/https?:\/\/(?:0\.0\.0\.0|127\.0\.0\.1|localhost|\[::\]):(\d{1,5})/u);
  if (!match) {
    return null;
  }
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

/**
 * Waits for a detached server to report and accept connections on its actual port.
 *
 * @param {import('node:child_process').ChildProcess} child - Spawned server process.
 * @param {number} logFd - Exact exclusively opened server log descriptor.
 * @returns {Promise<number | null>} Verified bound port.
 */
async function waitForServer(child, logFd) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return null;
    }
    const port = parseBoundPort(logFd);
    if (port && await isPortOpen(port)) {
      return port;
    }
    await new Promise((resolve) => setTimeout(resolve, SERVER_POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * Waits for the retained child process tree to exit.
 *
 * @param {import('node:child_process').ChildProcess} child - Spawned child.
 * @param {number | null} groupId - Independent POSIX process-group ID.
 * @param {number} timeoutMs - Timeout.
 * @returns {Promise<boolean>} Whether the process tree exited.
 */
async function waitForProcessTreeExit(child, groupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessTreeAlive(child, groupId)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * Stops an exact child process group and escalates if needed.
 *
 * @param {import('node:child_process').ChildProcess} child - Spawned child.
 * @param {number | null} groupId - Independent POSIX process-group ID.
 * @param {NodeJS.Signals} [signal='SIGTERM'] - Initial stop signal.
 * @param {boolean} [alreadySignaled=false] - Whether the initial signal was already sent.
 * @returns {Promise<void>}
 */
async function stopProcessTree(child, groupId, signal = 'SIGTERM', alreadySignaled = false) {
  if (!isProcessTreeAlive(child, groupId)) {
    return;
  }
  if (!alreadySignaled) {
    signalProcessTree(child, groupId, signal);
  }
  if (await waitForProcessTreeExit(child, groupId, SIGNAL_ESCALATION_MS)) {
    return;
  }
  signalProcessTree(child, groupId, 'SIGKILL');
  await waitForProcessTreeExit(child, groupId, 1_000);
}

/**
 * Starts wl server detached, captures its PID/log, and verifies readiness.
 *
 * @param {string} logPath - New log file path.
 * @returns {Promise<object>} Structured adapter response.
 */
async function startServer(logPath) {
  if (await isPortOpen(WL_SERVER_PORT)) {
    throw new RequestError(`cannot start server: Rackup default port ${WL_SERVER_PORT} is already in use`);
  }
  const logFd = openSync(logPath, 'wx+', 0o600);
  let child;
  let groupId = null;
  let cancellationSignal = null;
  let resolveCancellation;
  const cancellation = new Promise((resolve) => {
    resolveCancellation = resolve;
  });
  let onSigint;
  let onSigterm;

  /**
   * Removes server-start cancellation handlers.
   */
  function removeCancellationHandlers() {
    if (onSigint) {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }
  }

  try {
    child = spawn('wl', ['server'], {
      detached: true,
      env: childEnvironment(),
      shell: false,
      stdio: ['ignore', logFd, logFd],
    });
    groupId = processGroupId(child);
    /**
     * Forwards adapter cancellation to the detached server process group.
     *
     * @param {NodeJS.Signals} signal - Received signal.
     */
    function cancelServerStart(signal) {
      if (cancellationSignal) {
        signalProcessTree(child, groupId, 'SIGKILL');
        return;
      }
      cancellationSignal = signal;
      signalProcessTree(child, groupId, signal);
      resolveCancellation(signal);
    }

    onSigint = () => cancelServerStart('SIGINT');
    onSigterm = () => cancelServerStart('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (error) {
    removeCancellationHandlers();
    closeSync(logFd);
    throw error;
  }

  let outcome;
  try {
    outcome = await Promise.race([
      waitForServer(child, logFd).then((port) => ({ port })),
      cancellation.then((signal) => ({ signal })),
    ]);
  } catch (error) {
    await stopProcessTree(child, groupId);
    removeCancellationHandlers();
    closeSync(logFd);
    throw error;
  }
  if (outcome.signal) {
    await stopProcessTree(child, groupId, outcome.signal, true);
    removeCancellationHandlers();
    closeSync(logFd);
    return response({
      exitCode: child.exitCode,
      signal: outcome.signal,
      stderr: `wl server start cancelled; inspect ${logPath}`,
    });
  }
  if (!outcome.port) {
    await stopProcessTree(child, groupId);
    removeCancellationHandlers();
    closeSync(logFd);
    return response({
      exitCode: child.exitCode && child.exitCode !== 0 ? child.exitCode : 1,
      signal: child.signalCode,
      stderr: `wl server did not become ready; inspect ${logPath}`,
    });
  }

  let portStillReady = true;
  let processTreeAlive = true;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    processTreeAlive = isProcessTreeAlive(child, groupId);
    if (cancellationSignal || !processTreeAlive) {
      portStillReady = false;
      break;
    }
    portStillReady = await isPortOpen(outcome.port);
    if (cancellationSignal || !portStillReady) {
      break;
    }
  }
  const cancelledBeforeSuccess = cancellationSignal !== null;
  if (cancelledBeforeSuccess || !portStillReady || !processTreeAlive) {
    await stopProcessTree(
      child,
      groupId,
      cancellationSignal ?? 'SIGTERM',
      cancelledBeforeSuccess,
    );
    removeCancellationHandlers();
    closeSync(logFd);
    return response({
      exitCode: child.exitCode && child.exitCode !== 0 ? child.exitCode : 1,
      signal: cancellationSignal ?? child.signalCode,
      stderr: cancellationSignal
        ? `wl server start cancelled; inspect ${logPath}`
        : `wl server exited during readiness verification; inspect ${logPath}`,
    });
  }
  removeCancellationHandlers();
  closeSync(logFd);
  child.unref();
  const url = `http://127.0.0.1:${outcome.port}`;
  return response({
    ok: true,
    confirmation: {
      type: 'server-started',
      pid: child.pid,
      logPath,
      url,
      stopInstruction: `kill ${child.pid}`,
    },
  });
}

/**
 * Validates only the trusted syntax of a harness-created request file path.
 *
 * @param {string} path - Candidate request file path.
 * @returns {string} Validated request file path.
 */
function validateRequestFile(path) {
  if (!isAbsolute(path)) {
    throw new RequestError('--request-file must be an absolute path');
  }
  if (!REQUEST_FILE_PATTERN.test(basename(path))) {
    throw new RequestError('request file name must match worklog-request-*.json');
  }
  return path;
}

/**
 * Opens, validates, and bounded-reads one request file through the same descriptor.
 *
 * @param {string} path - Validated request file path.
 * @returns {string} Request JSON text.
 */
function readRequestFile(path) {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw new RequestError('request file must not be a symbolic link');
    }
    if (error.code === 'ENOENT') {
      throw new RequestError('request file does not exist');
    }
    throw error;
  }
  try {
    const file = fstatSync(fd);
    if (!file.isFile()) {
      throw new RequestError('request file must be a regular file');
    }
    if (file.size > MAX_INPUT_BYTES) {
      throw new RequestError(`request exceeds ${MAX_INPUT_BYTES} bytes`);
    }
    if (typeof process.getuid === 'function' && file.uid !== process.getuid()) {
      throw new RequestError('request file must be owned by the current user');
    }
    if ((file.mode & 0o022) !== 0) {
      throw new RequestError('request file must not be group- or world-writable');
    }

    const chunks = [];
    let bytes = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(8192, MAX_INPUT_BYTES + 1 - bytes));
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) {
        break;
      }
      bytes += read;
      if (bytes > MAX_INPUT_BYTES) {
        throw new RequestError(`request exceeds ${MAX_INPUT_BYTES} bytes`);
      }
      chunks.push(chunk.subarray(0, read));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Parses the adapter's constrained command-line arguments.
 *
 * @returns {string | null} Request file path, or null for stdin.
 */
function parseRequestFileArgument() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    return null;
  }
  if (args.length === 2 && args[0] === '--request-file') {
    return validateRequestFile(args[1]);
  }
  if (args.length === 1 && args[0].startsWith('--request-file=')) {
    return validateRequestFile(args[0].slice('--request-file='.length));
  }
  throw new RequestError('usage: run-wl.mjs [--request-file ABSOLUTE_PATH]');
}

/**
 * Reads bounded JSON text from standard input.
 *
 * @returns {Promise<string>} Request JSON text.
 */
async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) {
      throw new RequestError(`request exceeds ${MAX_INPUT_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Reads a bounded JSON request from stdin or a trusted request file.
 *
 * @returns {Promise<unknown>} Parsed request.
 */
async function readRequest() {
  const requestFile = parseRequestFileArgument();
  const input = requestFile ? readRequestFile(requestFile) : await readStdin();
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
    throw new RequestError(`request exceeds ${MAX_INPUT_BYTES} bytes`);
  }
  if (!input.trim()) {
    throw new RequestError('request JSON is required');
  }
  try {
    return JSON.parse(input);
  } catch {
    throw new RequestError('request input must contain one valid JSON value');
  }
}

/**
 * Creates and pins an adapter-owned staging directory.
 *
 * @param {string} parent - Protected existing parent directory.
 * @param {string} prefix - Staging directory prefix.
 * @returns {{ path: string, fd: number, dev: number, ino: number, closed: boolean }} Pinned stage.
 */
function createOwnedStage(parent, prefix) {
  validateDirectoryChain(parent, 'staging path');
  const path = join(parent, `.${prefix}-${process.pid}-${randomUUID()}`);
  mkdirSync(path, { mode: 0o700 });
  const directoryFlag = typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0;
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  try {
    const fd = openSync(path, constants.O_RDONLY | directoryFlag | noFollow);
    const entry = fstatSync(fd);
    return { path, fd, dev: entry.dev, ino: entry.ino, closed: false };
  } catch (error) {
    rmdirSync(path);
    throw error;
  }
}

/**
 * Verifies that a stage pathname still identifies the pinned directory.
 *
 * @param {{ path: string, fd: number, dev: number, ino: number }} stage - Pinned stage.
 */
function assertStageIdentity(stage) {
  const pinned = fstatSync(stage.fd);
  let current;
  try {
    current = lstatSync(stage.path);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new RequestError('adapter-owned staging path disappeared before publish');
    }
    throw error;
  }
  if (
    !pinned.isDirectory()
    || current.isSymbolicLink()
    || !current.isDirectory()
    || pinned.dev !== stage.dev
    || pinned.ino !== stage.ino
    || current.dev !== stage.dev
    || current.ino !== stage.ino
  ) {
    throw new RequestError('adapter-owned staging path identity changed before publish');
  }
}

/**
 * Closes a pinned stage descriptor once.
 *
 * @param {{ fd: number, closed: boolean }} stage - Pinned stage.
 */
function closeOwnedStage(stage) {
  if (!stage.closed) {
    closeSync(stage.fd);
    stage.closed = true;
  }
}

/**
 * Removes one exact adapter-owned tree without following links.
 *
 * @param {string} path - Exact owned path.
 */
function cleanOwnedPath(path) {
  if (!existsSync(path)) {
    return;
  }
  for (const name of readdirSync(path)) {
    const childPath = join(path, name);
    const entry = lstatSync(childPath);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      cleanOwnedPath(childPath);
    } else {
      unlinkSync(childPath);
    }
  }
  rmdirSync(path);
}

/**
 * Removes a stage only while its pathname still identifies the pinned directory.
 *
 * @param {{ path: string, fd: number, dev: number, ino: number, closed: boolean }} stage - Pinned stage.
 */
function cleanOwnedStage(stage) {
  try {
    assertStageIdentity(stage);
    cleanOwnedPath(stage.path);
  } catch (error) {
    if (!(error instanceof RequestError)) {
      throw error;
    }
  } finally {
    closeOwnedStage(stage);
  }
}

/**
 * Creates an adapter-owned staging directory inside the selected takeout destination.
 *
 * @param {string} outputPath - Explicit final archive path.
 * @returns {{ path: string, fd: number, dev: number, ino: number, closed: boolean }} Pinned stage.
 */
function createTakeoutStage(outputPath) {
  return createOwnedStage(dirname(outputPath), 'worklog-takeout');
}

/**
 * Atomically publishes the staged takeout without overwriting unless confirmed.
 *
 * @param {{ path: string, fd: number, dev: number, ino: number, closed: boolean }} stage - Pinned stage.
 * @param {string} outputPath - Explicit final archive path.
 * @param {boolean} confirmed - Whether overwrite was explicitly confirmed.
 * @returns {string} Final archive path.
 */
function publishTakeout(stage, outputPath, confirmed) {
  try {
    assertStageIdentity(stage);
    const entries = readdirSync(stage.path);
    const archives = entries.filter((name) => TAKEOUT_PATTERN.test(name));
    if (archives.length !== 1 || entries.length !== 1) {
      throw new RequestError('takeout did not create exactly one expected archive');
    }
    const source = join(stage.path, archives[0]);
    assertStageIdentity(stage);
    if (confirmed) {
      renameSync(source, outputPath);
    } else {
      linkSync(source, outputPath);
      unlinkSync(source);
    }
    rmdirSync(stage.path);
    closeOwnedStage(stage);
    return outputPath;
  } catch (error) {
    cleanOwnedStage(stage);
    if (error.code === 'EEXIST') {
      throw new RequestError(`takeout output already exists; confirm overwrite of ${outputPath}`);
    }
    throw error;
  }
}

/**
 * Creates an adapter-owned storage-export staging directory beside the destination.
 *
 * @param {string} destination - Validated export destination.
 * @returns {{ path: string, fd: number, dev: number, ino: number, closed: boolean }} Pinned stage.
 */
function createStorageExportStage(destination) {
  return createOwnedStage(dirname(destination), 'worklog-export');
}

/**
 * Validates bounded staged export entries and returns their relative file paths.
 *
 * @param {string} stagePath - Adapter-created staging directory.
 * @returns {{ files: string[], hasDirectories: boolean }} Validated manifest.
 */
function validateStorageExportStage(stagePath) {
  const files = [];
  let entries = 0;
  let bytes = 0;
  let hasDirectories = false;

  /**
   * Validates one staged directory recursively.
   *
   * @param {string} directory - Current absolute directory.
   * @param {string} relativeDirectory - Current relative directory.
   * @param {number} depth - Current depth.
   */
  function visit(directory, relativeDirectory, depth) {
    if (depth > MAX_EXPORT_DEPTH) {
      throw new RequestError(`storage-export exceeded maximum depth ${MAX_EXPORT_DEPTH}`);
    }
    for (const name of readdirSync(directory)) {
      entries += 1;
      if (entries > MAX_EXPORT_ENTRIES) {
        throw new RequestError(`storage-export exceeded ${MAX_EXPORT_ENTRIES} staged entries`);
      }
      const path = join(directory, name);
      const relativePath = relativeDirectory ? join(relativeDirectory, name) : name;
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) {
        throw new RequestError(`storage-export staged a symbolic link: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        hasDirectories = true;
        visit(path, relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || entry.nlink !== 1) {
        throw new RequestError(`storage-export staged a non-regular or hard-linked file: ${relativePath}`);
      }
      bytes += entry.size;
      if (bytes > MAX_EXPORT_BYTES) {
        throw new RequestError(`storage-export exceeded ${MAX_EXPORT_BYTES} staged bytes`);
      }
      files.push(relativePath);
    }
  }

  visit(stagePath, '', 0);
  return { files, hasDirectories };
}

/**
 * Atomically publishes validated storage-export files without following destination links.
 *
 * @param {{ path: string, fd: number, dev: number, ino: number, closed: boolean }} stage - Pinned stage.
 * @param {string} destination - Validated final directory.
 * @param {boolean} confirmed - Whether conflicts/non-empty destination were confirmed.
 * @returns {string} Final destination.
 */
function publishStorageExport(stage, destination, confirmed) {
  try {
    assertStageIdentity(stage);
    const manifest = validateStorageExportStage(stage.path);
    const destinationExists = existsSync(destination);
    if (!destinationExists) {
      assertStageIdentity(stage);
      renameSync(stage.path, destination);
      closeOwnedStage(stage);
      return destination;
    }
    validateExportPath(destination, 'flags.path');
    if (readdirSync(destination).length > 0 && !confirmed) {
      throw new RequestError('storage-export into a non-empty directory requires confirmed: true');
    }
    if (manifest.hasDirectories) {
      throw new RequestError('storage-export cannot safely merge staged directories into an existing destination');
    }

    for (const relativePath of manifest.files) {
      const target = join(destination, relativePath);
      if (!existsSync(target)) {
        continue;
      }
      const targetEntry = lstatSync(target);
      if (!targetEntry.isFile() && !targetEntry.isSymbolicLink()) {
        throw new RequestError(`storage-export cannot safely replace destination entry: ${relativePath}`);
      }
    }
    for (const relativePath of manifest.files) {
      assertStageIdentity(stage);
      validateExportPath(destination, 'flags.path');
      renameSync(join(stage.path, relativePath), join(destination, relativePath));
    }
    rmdirSync(stage.path);
    closeOwnedStage(stage);
    return destination;
  } catch (error) {
    cleanOwnedStage(stage);
    throw error;
  }
}

/**
 * Executes the adapter request and returns a structured response.
 *
 * @returns {Promise<object>} Adapter response.
 */
async function main() {
  try {
    const request = validateRequest(await readRequest());
    if (request.command === 'server') {
      return await startServer(request.flags.logPath);
    }
    const storageExportStage = request.command === 'storage-export'
      ? createStorageExportStage(request.flags.path)
      : null;
    const executionRequest = storageExportStage
      ? { ...request, flags: { ...request.flags, path: storageExportStage.path } }
      : request;
    const argv = buildArguments(executionRequest);
    const takeoutStage = request.command === 'takeout'
      ? createTakeoutStage(request.flags.outputPath)
      : null;
    const cwd = takeoutStage?.path;
    const result = await runWorklog(argv, cwd);
    if (takeoutStage && (result.exitCode !== 0 || result.signal)) {
      cleanOwnedStage(takeoutStage);
    }
    if (storageExportStage && (result.exitCode !== 0 || result.signal)) {
      cleanOwnedStage(storageExportStage);
    }
    if (result.spawnError) {
      const exitCode = result.spawnError.code === 'ENOENT' ? 127 : 1;
      return response({ exitCode, stderr: result.spawnError.message });
    }
    const stdout = cleanDebugLines(result.stdout);
    let takeoutPath = null;
    let storageExportPath = null;
    if (takeoutStage && result.exitCode === 0 && !result.signal) {
      takeoutPath = publishTakeout(
        takeoutStage,
        request.flags.outputPath,
        request.confirmed,
      );
    }
    if (storageExportStage && result.exitCode === 0 && !result.signal) {
      storageExportPath = publishStorageExport(
        storageExportStage,
        request.flags.path,
        request.confirmed,
      );
    }
    const confirmation = parseConfirmation(request.command, stdout);
    if (takeoutPath && confirmation) {
      confirmation.path = takeoutPath;
    }
    if (storageExportPath && confirmation) {
      confirmation.message = `Exported worklog data to ${storageExportPath}`;
      confirmation.path = storageExportPath;
    }
    return response({
      ok: result.exitCode === 0 && result.signal === null,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout,
      stderr: result.stderr,
      warnings: [...result.warnings, ...parseWarnings(stdout)],
      confirmation,
    });
  } catch (error) {
    if (error instanceof RequestError) {
      return response({ exitCode: 2, stderr: error.message });
    }
    return response({ exitCode: 1, stderr: `adapter failure: ${error.message}` });
  }
}

const result = await main();
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.signal === 'SIGINT') {
  process.exitCode = 130;
} else if (result.signal === 'SIGTERM') {
  process.exitCode = 143;
} else if (result.signal) {
  process.exitCode = 1;
} else if (typeof result.exitCode === 'number') {
  process.exitCode = result.exitCode;
}
