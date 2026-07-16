/**
 * Zero-dependency deterministic orchestration for headless Copilot and Claude subagents.
 *
 * Node >= 18. Subagents are local-read by default, execute in an explicit working
 * directory, share one deadline across all attempts, and always return envelopes.
 */

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Runtime-enforceable features exposed for dependent workflow preflight. */
export const ENGINE_CAPABILITIES = Object.freeze({
  copilotReadDisallowTempDir: true,
});

const OPEN = '<<<ULTRACODE_JSON>>>';
const CLOSE = '<<<ULTRACODE_END>>>';
const SUPPORTED_SCHEMA_KEYS = new Set([
  'type',
  'required',
  'properties',
  'items',
  'enum',
  'minItems',
]);
const SUPPORTED_TYPES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);
const PROFILE_TOOLS = {
  'local-read': {
    copilot: ['view', 'rg', 'glob'],
    claude: ['Read', 'Grep', 'Glob'],
  },
  'research-read': {
    copilot: ['view', 'rg', 'glob', 'web_fetch'],
    claude: ['Read', 'Grep', 'Glob'],
  },
};
const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_NODES = 512;
const MAX_DIAGNOSTICS = 8;
const MAX_VALIDATION_ERRORS = 20;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_URL_GRANTS = 32;
const MAX_URL_GRANT_LENGTH = 2048;
const KILL_GRACE_MS = 100;
const EXIT_GRACE_MS = 50;

let active = 0;
let launched = 0;
let runtimeLogged = false;
let shutdownState = null;
const waiters = [];
const activeChildren = new Set();

class UltracodeError extends Error {
  /**
   * Creates a classified orchestration error.
   *
   * @param {string} kind - Stable machine-readable error kind.
   * @param {string} message - Human-readable bounded message.
   * @param {object} [options] - Retry and diagnostic attributes.
   */
  constructor(kind, message, options = {}) {
    super(message);
    this.name = 'UltracodeError';
    this.kind = kind;
    this.retryable = options.retryable === true;
    this.incomplete = options.incomplete === true;
    this.stdout = options.stdout || '';
    this.stdoutTruncated = options.stdoutTruncated === true;
    this.stderr = options.stderr || '';
    this.stderrTruncated = options.stderrTruncated === true;
  }
}

/**
 * Reads a bounded integer environment variable.
 *
 * @param {string} name - Environment variable name.
 * @param {number} fallback - Value used when the variable is absent or invalid.
 * @param {number} minimum - Smallest accepted value.
 * @returns {number} Parsed or fallback value.
 */
function integerEnvironment(name, fallback, minimum) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

/**
 * Reads an explicit boolean environment variable.
 *
 * @param {string} name - Environment variable name.
 * @param {boolean} fallback - Value used when the variable is absent.
 * @returns {boolean} Parsed boolean.
 * @throws {UltracodeError} If a present value is not true or false.
 */
function booleanEnvironment(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new UltracodeError('configuration', `${name} must be "true" or "false"`);
}

/**
 * Parses and validates the explicit URL grants used by Copilot research agents.
 *
 * Options may pass a string array; ULTRACODE_ALLOWED_URLS uses a comma-separated
 * string. Only bounded HTTP(S) URLs and exact or wildcard host grants are accepted.
 *
 * @param {unknown} configured - String, string array, or undefined.
 * @returns {string[]} Validated URL or domain grants.
 * @throws {UltracodeError} If a grant is unsafe, malformed, or exceeds bounds.
 */
function parseAllowedUrls(configured) {
  const raw = Array.isArray(configured)
    ? configured
    : String(configured || '').split(',');
  const grants = [...new Set(raw.map((entry) => String(entry).trim()).filter(Boolean))];
  if (grants.length > MAX_URL_GRANTS) {
    throw new UltracodeError(
      'configuration',
      `research URL grants exceed the limit of ${MAX_URL_GRANTS}`,
    );
  }
  for (const grant of grants) {
    if (grant.length > MAX_URL_GRANT_LENGTH) {
      throw new UltracodeError('configuration', 'research URL grant is too long');
    }
    if (grant === '*') {
      throw new UltracodeError('configuration', 'research URL grants must not allow all URLs');
    }
    if (/^https?:\/\//i.test(grant)) {
      validateHttpUrlGrant(grant);
      continue;
    }
    if (!/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?$/i.test(grant)) {
      throw new UltracodeError('configuration', `invalid research URL grant "${grant}"`);
    }
  }
  return grants;
}

/**
 * Validates one absolute HTTP(S) URL grant.
 *
 * @param {string} grant - URL grant.
 * @returns {void}
 * @throws {UltracodeError} If the URL is malformed or contains credentials.
 */
function validateHttpUrlGrant(grant) {
  let url;
  try {
    url = new URL(grant);
  } catch {
    throw new UltracodeError('configuration', `invalid research URL grant "${grant}"`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new UltracodeError('configuration', `invalid research URL grant "${grant}"`);
  }
}

/**
 * Bounds text included in diagnostics.
 *
 * @param {unknown} value - Value to stringify.
 * @param {number} limit - Maximum character count.
 * @returns {string} Bounded text.
 */
function boundedText(value, limit = 500) {
  const text = String(value || '');
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Creates a successful result envelope.
 *
 * @param {unknown} value - Successful value.
 * @param {number} [attempts=0] - Number of CLI attempts made.
 * @param {object} [meta] - Optional metadata.
 * @returns {{ok: true, value: unknown, attempts: number, meta?: object}} Envelope.
 */
function successEnvelope(value, attempts = 0, meta) {
  const envelope = { ok: true, value, attempts };
  if (meta && Object.keys(meta).length > 0) {
    envelope.meta = meta;
  }
  return envelope;
}

/**
 * Creates a failed result envelope.
 *
 * @param {UltracodeError|Error} error - Failure to expose.
 * @param {number} attempts - Number of CLI attempts made.
 * @param {object} [meta] - Optional metadata.
 * @param {object[]} [diagnostics] - Bounded attempt diagnostics.
 * @param {number} [incompleteCount=0] - Parse or schema incomplete attempt count.
 * @returns {{ok: false, error: object, attempts: number, meta?: object}} Envelope.
 */
function failureEnvelope(error, attempts, meta, diagnostics = [], incompleteCount = 0) {
  const classified = classifyError(error);
  const detail = {
    kind: classified.kind,
    message: boundedText(classified.message),
    retryable: classified.retryable,
    incompleteCount,
  };
  if (diagnostics.length > 0) {
    detail.diagnostics = diagnostics.slice(-MAX_DIAGNOSTICS);
  }
  const envelope = { ok: false, error: detail, attempts };
  if (meta && Object.keys(meta).length > 0) {
    envelope.meta = meta;
  }
  return envelope;
}

/**
 * Classifies an arbitrary thrown value.
 *
 * @param {unknown} error - Thrown value.
 * @returns {UltracodeError} Classified error.
 */
function classifyError(error) {
  if (error instanceof UltracodeError) {
    return error;
  }
  return new UltracodeError('internal', error instanceof Error ? error.message : String(error));
}

/**
 * Validates a schema definition and rejects unsupported JSON Schema claims.
 *
 * @param {unknown} schema - Bounded schema subset.
 * @returns {{ok: true}|{ok: false, errors: string[]}} Validation result.
 */
export function validateSchemaDefinition(schema) {
  const errors = [];
  const budget = { nodes: 0 };

  function visit(node, path, depth) {
    if (errors.length >= MAX_VALIDATION_ERRORS) {
      return;
    }
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      errors.push(`${path} must be an object`);
      return;
    }
    budget.nodes += 1;
    if (depth > MAX_SCHEMA_DEPTH || budget.nodes > MAX_SCHEMA_NODES) {
      errors.push(`${path} exceeds schema complexity limits`);
      return;
    }
    for (const key of Object.keys(node)) {
      if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
        errors.push(`${path} uses unsupported keyword "${key}"`);
      }
    }
    if ('type' in node && !SUPPORTED_TYPES.has(node.type)) {
      errors.push(`${path}.type must be one of ${[...SUPPORTED_TYPES].join(', ')}`);
    }
    if ('required' in node) {
      if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
        errors.push(`${path}.required must be an array of strings`);
      }
    }
    if ('properties' in node) {
      if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
        errors.push(`${path}.properties must be an object`);
      } else {
        for (const [key, child] of Object.entries(node.properties)) {
          visit(child, `${path}.properties.${key}`, depth + 1);
        }
      }
    }
    if ('items' in node) {
      visit(node.items, `${path}.items`, depth + 1);
    }
    if ('enum' in node && (!Array.isArray(node.enum) || node.enum.length === 0)) {
      errors.push(`${path}.enum must be a non-empty array`);
    }
    if ('minItems' in node && (!Number.isInteger(node.minItems) || node.minItems < 0)) {
      errors.push(`${path}.minItems must be a non-negative integer`);
    }
  }

  visit(schema, '$', 0);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Validates a value against ultracode's bounded recursive schema subset.
 *
 * @param {unknown} value - Parsed value.
 * @param {object} schema - Previously validated schema.
 * @returns {{ok: true}|{ok: false, errors: string[]}} Validation result.
 */
export function validateStructuredValue(value, schema) {
  const errors = [];
  const budget = { nodes: 0 };

  function typeMatches(candidate, type) {
    if (type === 'object') {
      return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
    }
    if (type === 'array') {
      return Array.isArray(candidate);
    }
    if (type === 'integer') {
      return Number.isInteger(candidate);
    }
    if (type === 'number') {
      return typeof candidate === 'number' && Number.isFinite(candidate);
    }
    if (type === 'null') {
      return candidate === null;
    }
    return typeof candidate === type;
  }

  function equalJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function visit(candidate, node, path, depth) {
    if (errors.length >= MAX_VALIDATION_ERRORS) {
      return;
    }
    budget.nodes += 1;
    if (depth > MAX_SCHEMA_DEPTH || budget.nodes > MAX_SCHEMA_NODES) {
      errors.push(`${path} exceeds validation complexity limits`);
      return;
    }
    if (node.type && !typeMatches(candidate, node.type)) {
      errors.push(`${path} must be ${node.type}`);
      return;
    }
    if (node.enum && !node.enum.some((entry) => equalJson(entry, candidate))) {
      errors.push(`${path} must be one of the declared enum values`);
    }
    if (Array.isArray(candidate)) {
      if (node.minItems !== undefined && candidate.length < node.minItems) {
        errors.push(`${path} must contain at least ${node.minItems} items`);
      }
      if (node.items) {
        candidate.forEach((entry, index) => visit(entry, node.items, `${path}[${index}]`, depth + 1));
      }
    }
    if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
      for (const key of node.required || []) {
        if (!Object.hasOwn(candidate, key)) {
          errors.push(`${path}.${key} is required`);
        }
      }
      for (const [key, child] of Object.entries(node.properties || {})) {
        if (Object.hasOwn(candidate, key)) {
          visit(candidate[key], child, `${path}.${key}`, depth + 1);
        }
      }
    }
  }

  visit(value, schema, '$', 0);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Resolves a workflow target against an explicit subagent working directory.
 *
 * @param {string} target - Relative or absolute target.
 * @param {string} [cwd] - Base directory, defaulting to ULTRACODE_CWD or process.cwd().
 * @returns {string} Absolute target path.
 */
export function resolveTarget(target, cwd = process.env.ULTRACODE_CWD || process.cwd()) {
  return isAbsolute(target) ? resolve(target) : resolve(cwd, target);
}

/**
 * Resolves an engine path or file URL for session-workspace workflow loaders.
 *
 * @param {string|URL} location - Engine path or file URL.
 * @returns {string} Importable file URL.
 */
export function resolveEngineSpecifier(location) {
  if (location instanceof URL || String(location).startsWith('file:')) {
    return String(location);
  }
  return pathToFileURL(resolve(String(location))).href;
}

/**
 * Writes a phase heading to stderr.
 *
 * @param {string} title - Phase title.
 * @returns {void}
 */
export function phase(title) {
  process.stderr.write(`\n▶ ${title}\n`);
}

/**
 * Writes a progress message to stderr.
 *
 * @param {string} message - Progress text.
 * @returns {void}
 */
export function log(message) {
  process.stderr.write(`  ${message}\n`);
}

/**
 * Writes a warning to stderr.
 *
 * @param {string} message - Warning text.
 * @returns {void}
 */
function warn(message) {
  process.stderr.write(`  ! ${message}\n`);
}

/**
 * Validates and builds effective per-agent configuration.
 *
 * @param {object} options - Agent options.
 * @returns {object} Effective configuration.
 * @throws {UltracodeError} If the adapter or options are invalid.
 */
function buildConfiguration(options) {
  const cli = String(options.cli || process.env.ULTRACODE_CLI || 'copilot').toLowerCase();
  if (!['copilot', 'claude'].includes(cli)) {
    throw new UltracodeError('adapter', `unsupported CLI adapter "${cli}"`);
  }
  const profile = String(options.profile || process.env.ULTRACODE_PROFILE || 'local-read').toLowerCase();
  if (!['local-read', 'research-read', 'write'].includes(profile)) {
    throw new UltracodeError('configuration', `unsupported profile "${profile}"`);
  }
  if (cli === 'claude' && profile === 'research-read') {
    throw new UltracodeError(
      'configuration',
      'Claude deterministic research-read is unavailable; use Claude native Workflow/runtime permission controls',
    );
  }
  const cwd = resolve(options.cwd || process.env.ULTRACODE_CWD || process.cwd());
  try {
    if (!statSync(cwd).isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    throw new UltracodeError('configuration', `working directory does not exist: ${cwd}`);
  }
  const effect = String(options.effect || (profile === 'write' ? 'write' : 'read')).toLowerCase();
  if (!['read', 'write', 'exec'].includes(effect)) {
    throw new UltracodeError('configuration', `unsupported effect "${effect}"`);
  }
  if ((effect === 'write' || effect === 'exec') && profile !== 'write') {
    throw new UltracodeError('configuration', `${effect} effects require profile "write"`);
  }
  const defaultRetries = integerEnvironment('ULTRACODE_RETRIES', 2, 0);
  const retriesAreExplicit = Number.isInteger(options.retries);
  const requestedRetries = retriesAreExplicit ? Math.max(0, options.retries) : defaultRetries;
  const sideEffecting = profile === 'write' || effect === 'write' || effect === 'exec';
  const retries = sideEffecting
    ? (options.idempotent === true && retriesAreExplicit ? requestedRetries : 0)
    : requestedRetries;
  const deadlineMs = Number.isInteger(options.deadlineMs)
    ? Math.max(1, options.deadlineMs)
    : integerEnvironment(
        'ULTRACODE_DEADLINE_MS',
        integerEnvironment('ULTRACODE_TIMEOUT_MS', 600000, 1),
        1,
      );
  const inheritInstructions = options.inheritInstructions === undefined
    ? booleanEnvironment('ULTRACODE_INHERIT_INSTRUCTIONS', false)
    : options.inheritInstructions === true;
  const allowTempDir = profile === 'write'
    ? (options.allowTempDir === undefined
        ? booleanEnvironment('ULTRACODE_ALLOW_TEMP_DIR', false)
        : options.allowTempDir === true)
    : false;
  const binary = String(options.bin || process.env.ULTRACODE_CLI_BIN || cli);
  if (binary.trim() === '') {
    throw new UltracodeError('adapter', 'CLI binary must not be empty');
  }
  const needsCopilotUrls = cli === 'copilot' && profile === 'research-read';
  const allowedUrls = needsCopilotUrls
    ? parseAllowedUrls(options.allowedUrls ?? process.env.ULTRACODE_ALLOWED_URLS)
    : [];
  if (needsCopilotUrls && allowedUrls.length === 0) {
    throw new UltracodeError(
      'configuration',
      'Copilot research-read requires allowedUrls or ULTRACODE_ALLOWED_URLS',
    );
  }
  return {
    cli,
    binary,
    profile,
    cwd,
    effect,
    retries,
    deadlineMs,
    inheritInstructions,
    allowTempDir,
    allowedUrls,
    model: options.model || process.env.ULTRACODE_MODEL || '',
  };
}

/**
 * Builds explicit, validated CLI arguments for one subagent invocation.
 *
 * @param {string} prompt - Fully contracted prompt.
 * @param {object} configuration - Effective agent configuration.
 * @returns {string[]} Argument array.
 */
export function buildAdapterArguments(prompt, configuration) {
  const config = buildConfiguration(configuration);
  const modelArgs = config.model ? ['--model', config.model] : [];
  if (config.cli === 'claude') {
    const permissionArgs = config.profile === 'write'
      ? ['--permission-mode', 'bypassPermissions']
      : ['--permission-mode', 'dontAsk', '--allowedTools', PROFILE_TOOLS[config.profile].claude.join(',')];
    const instructionArgs = config.inheritInstructions ? [] : ['--safe-mode'];
    return [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--no-session-persistence',
      ...instructionArgs,
      ...permissionArgs,
      ...modelArgs,
    ];
  }
  const common = [
    '-p',
    prompt,
    '-C',
    config.cwd,
    '--silent',
    '--no-color',
    '--log-level',
    'none',
    '--no-ask-user',
    '--no-remote-export',
    ...(config.allowTempDir ? [] : ['--disallow-temp-dir']),
  ];
  const instructionArgs = config.inheritInstructions ? [] : ['--no-custom-instructions'];
  if (config.profile === 'write') {
    return [...common, ...instructionArgs, '--allow-all-tools', ...modelArgs];
  }
  const tools = PROFILE_TOOLS[config.profile].copilot;
  return [
    ...common,
    ...instructionArgs,
    '--available-tools',
    tools.join(','),
    ...tools.flatMap((tool) => ['--allow-tool', tool]),
    ...config.allowedUrls.flatMap((url) => ['--allow-url', url]),
    ...modelArgs,
  ];
}

/**
 * Adds the mandatory structured output contract to a prompt.
 *
 * @param {string} prompt - User prompt.
 * @param {object} schema - Validated schema subset.
 * @param {boolean} retry - Whether this is a correction attempt.
 * @returns {string} Contracted prompt.
 */
function withContract(prompt, schema, retry) {
  const correction = retry
    ? '\nThis is a correction attempt. Return a complete JSON value and obey every schema constraint.'
    : '';
  return `${prompt}

────────────────────────────────────────
OUTPUT CONTRACT (mandatory):
Return ONE complete JSON value matching this bounded schema:
${JSON.stringify(schema, null, 2)}

Wrap it exactly between:
${OPEN}
...complete JSON value...
${CLOSE}
No prose or markdown.${correction}`;
}

/**
 * Parses a complete JSON value from a subagent response.
 *
 * @param {string} text - CLI response text.
 * @returns {unknown} Parsed value.
 * @throws {UltracodeError} If output is partial or invalid.
 */
function extractJson(text) {
  const openIndex = text.indexOf(OPEN);
  const closeIndex = text.lastIndexOf(CLOSE);
  if ((openIndex === -1) !== (closeIndex === -1) || (openIndex !== -1 && closeIndex < openIndex)) {
    throw new UltracodeError('parse', 'subagent output contained incomplete JSON markers', {
      retryable: true,
      incomplete: true,
    });
  }
  const body = openIndex === -1
    ? text.trim()
    : text.slice(openIndex + OPEN.length, closeIndex).trim();
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new UltracodeError('parse', 'subagent output was not valid JSON', {
      retryable: true,
      incomplete: true,
    });
  }
  return value;
}

/**
 * Acquires a subprocess slot before the overall deadline.
 *
 * @param {number} deadlineAt - Absolute deadline timestamp.
 * @returns {Promise<void>} Slot acquisition.
 */
function acquire(deadlineAt) {
  if (shutdownState) {
    return Promise.reject(new UltracodeError('shutdown', `shutdown started by ${shutdownState.signal}`));
  }
  if (active < integerEnvironment('ULTRACODE_CONCURRENCY', 4, 1)) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolveAcquire, rejectAcquire) => {
    const waiter = { cancelled: false, resolve: resolveAcquire };
    const remaining = Math.max(0, deadlineAt - Date.now());
    waiter.timer = setTimeout(() => {
      waiter.cancelled = true;
      rejectAcquire(new UltracodeError('deadline', 'agent deadline expired while waiting for a slot'));
    }, remaining);
    waiters.push(waiter);
  });
}

/**
 * Releases a subprocess slot to the next live waiter.
 *
 * @returns {void}
 */
function release() {
  active = Math.max(0, active - 1);
  while (waiters.length > 0) {
    const waiter = waiters.shift();
    if (waiter.cancelled) {
      continue;
    }
    clearTimeout(waiter.timer);
    active += 1;
    waiter.resolve();
    return;
  }
}

/**
 * Terminates a child process and, where supported, its process group.
 *
 * @param {import('node:child_process').ChildProcess} child - Spawned child.
 * @param {NodeJS.Signals} signal - Signal to send.
 * @returns {void}
 */
function killProcessTree(child, signal) {
  if (!child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    const args = ['/PID', String(child.pid), '/T'];
    if (signal === 'SIGKILL') {
      args.push('/F');
    }
    try {
      const killer = spawn('taskkill.exe', args, {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => {
        try {
          child.kill(signal);
        } catch {
          // The process already exited.
        }
      });
      killer.unref();
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The process already exited.
      }
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

/**
 * Installs one-time parent signal handlers that cancel all active process trees.
 *
 * @returns {void}
 */
function installSignalHandlers() {
  if (installSignalHandlers.installed) {
    return;
  }
  installSignalHandlers.installed = true;
  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => {
      shutdownState = { signal, exitCode, startedAt: Date.now() };
      for (const child of activeChildren) {
        killProcessTree(child, signal);
      }
      process.exitCode = exitCode;
      const forceTimer = setTimeout(() => {
        for (const child of activeChildren) {
          killProcessTree(child, 'SIGKILL');
        }
      }, KILL_GRACE_MS);
      const exitTimer = setTimeout(() => process.exit(exitCode), KILL_GRACE_MS + EXIT_GRACE_MS);
      forceTimer.unref();
      exitTimer.unref();
    });
  }
}
installSignalHandlers.installed = false;

/**
 * Runs one CLI process with bounded output and the remaining overall deadline.
 *
 * @param {object} configuration - Effective configuration.
 * @param {string[]} args - Validated adapter arguments.
 * @param {number} deadlineAt - Absolute overall deadline.
 * @returns {Promise<{stdout: string, stderr: string, stderrTruncated: boolean}>} Captured output.
 */
function runChild(configuration, args, deadlineAt) {
  return new Promise((resolveChild, rejectChild) => {
    if (shutdownState) {
      rejectChild(new UltracodeError('shutdown', `shutdown started by ${shutdownState.signal}`));
      return;
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      rejectChild(new UltracodeError('deadline', 'agent deadline expired before CLI launch'));
      return;
    }
    installSignalHandlers();
    const child = spawn(configuration.binary, args, {
      cwd: configuration.cwd,
      detached: process.platform !== 'win32',
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.add(child);
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let capturedStderrBytes = 0;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;

    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      activeChildren.delete(child);
      handler(value);
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        killProcessTree(child, 'SIGKILL');
        finish(
          rejectChild,
          new UltracodeError('output_limit', `subagent stdout exceeded ${MAX_STDOUT_BYTES} bytes`),
        );
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      const remainingBytes = MAX_STDERR_BYTES - capturedStderrBytes;
      if (remainingBytes > 0) {
        const captured = chunk.subarray(0, remainingBytes);
        stderrChunks.push(captured);
        capturedStderrBytes += captured.length;
      }
      stderrTruncated = stderrBytes > MAX_STDERR_BYTES;
    });
    child.once('error', (error) => {
      finish(
        rejectChild,
        new UltracodeError('adapter', `failed to launch ${configuration.cli}: ${error.message}`),
      );
    });
    child.once('close', (code, signal) => {
      if (settled) {
        return;
      }
      const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
      const stderr = Buffer.concat(stderrChunks, capturedStderrBytes).toString('utf8');
      if (shutdownState) {
        finish(
          rejectChild,
          new UltracodeError('shutdown', `subagent cancelled by ${shutdownState.signal}`),
        );
        return;
      }
      if (timedOut) {
        finish(
          rejectChild,
          new UltracodeError('deadline', `agent deadline exceeded after ${configuration.deadlineMs}ms`, {
            stderr,
            stderrTruncated,
          }),
        );
        return;
      }
      if (code === 0) {
        finish(resolveChild, { stdout, stderr, stderrTruncated });
        return;
      }
      const failure = invocationFailure(configuration, code, signal, stdout, stderr, stderrTruncated);
      finish(
        rejectChild,
        failure,
      );
    });

    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, 'SIGTERM');
    }, remaining);
    const killTimer = setTimeout(() => {
      if (timedOut && !settled) {
        killProcessTree(child, 'SIGKILL');
      }
    }, remaining + KILL_GRACE_MS);
    deadlineTimer.unref();
    killTimer.unref();
  });
}

/**
 * Builds a classified nonzero CLI invocation error.
 *
 * @param {object} configuration - Effective configuration.
 * @param {number|null} code - Exit code.
 * @param {NodeJS.Signals|null} signal - Exit signal.
 * @param {string} stdout - Bounded stdout.
 * @param {string} stderr - Bounded stderr.
 * @param {boolean} stderrTruncated - Whether stderr exceeded its bound.
 * @returns {UltracodeError} Classified invocation error.
 */
function invocationFailure(configuration, code, signal, stdout, stderr, stderrTruncated) {
  let detail = stderr;
  let message = `${configuration.cli} exited ${signal || code}`;
  if (configuration.cli === 'claude' && stdout.trim()) {
    try {
      const envelope = JSON.parse(stdout);
      const subtype = String(envelope.subtype || envelope.type || '');
      const result = String(envelope.result || envelope.error || '');
      detail = [subtype, result, stderr].filter(Boolean).join(': ');
      message = `claude error: ${boundedText(detail || `exit ${signal || code}`, 500)}`;
    } catch {
      detail = [stdout, stderr].filter(Boolean).join('\n');
      message = `claude exited ${signal || code} with malformed error output`;
    }
  } else if (stderr) {
    message += `: ${boundedText(stderr, 500)}`;
  }
  const retryable = isTransientFailure(code, signal, detail);
  return new UltracodeError(
    retryable ? 'transient' : 'invocation',
    message,
    {
      retryable,
      stdout,
      stderr,
      stderrTruncated,
    },
  );
}

/**
 * Classifies retryable process failures.
 *
 * @param {number|null} code - Exit code.
 * @param {NodeJS.Signals|null} signal - Exit signal.
 * @param {string} stderr - Bounded stderr.
 * @returns {boolean} Whether retrying is safe for a read/idempotent agent.
 */
function isTransientFailure(code, signal, stderr) {
  if (signal || [75, 124, 137].includes(code)) {
    return true;
  }
  return /temporar|timeout|timed out|rate.?limit|overload|unavailable|try again|api_error/i.test(stderr);
}

/**
 * Normalizes Claude's JSON envelope to the model response text.
 *
 * @param {string} stdout - Claude CLI stdout.
 * @returns {string} Model response.
 * @throws {UltracodeError} If the envelope is malformed or reports an error.
 */
function unwrapClaude(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new UltracodeError('adapter', 'claude returned a malformed JSON envelope');
  }
  if (envelope.is_error) {
    throw new UltracodeError(
      'invocation',
      `claude error: ${boundedText(envelope.subtype || envelope.result || 'unknown error')}`,
    );
  }
  if (typeof envelope.result !== 'string') {
    throw new UltracodeError('adapter', 'claude JSON envelope did not contain a string result');
  }
  return envelope.result;
}

/**
 * Produces one bounded attempt diagnostic.
 *
 * @param {number} attempt - One-based attempt number.
 * @param {UltracodeError} error - Classified failure.
 * @returns {object} Diagnostic record.
 */
function attemptDiagnostic(attempt, error) {
  const diagnostic = {
    attempt,
    kind: error.kind,
    message: boundedText(error.message),
  };
  if (error.stderr) {
    diagnostic.stderr = boundedText(error.stderr, 2000);
    diagnostic.stderrTruncated = error.stderrTruncated;
  }
  if (error.stdout) {
    diagnostic.stdout = boundedText(error.stdout, 2000);
    diagnostic.stdoutTruncated = error.stdoutTruncated;
  }
  return diagnostic;
}

/**
 * Dispatches one subagent and always returns a structured envelope.
 *
 * @param {string} prompt - Subagent prompt.
 * @param {object} [options] - Adapter, schema, deadline, retry, cwd, and profile options.
 * @returns {Promise<{ok: boolean, value?: unknown, error?: object, attempts: number, meta?: object}>} Envelope.
 */
export async function agent(prompt, options = {}) {
  const startedAt = Date.now();
  let configuration;
  try {
    configuration = buildConfiguration(options);
  } catch (error) {
    return failureEnvelope(classifyError(error), 0);
  }
  const deadlineAt = startedAt + configuration.deadlineMs;
  const label = options.label || prompt.replace(/\s+/g, ' ').slice(0, 48);
  const id = ++launched;
  const baseMeta = {
    id,
    label,
    cli: configuration.cli,
    cwd: configuration.cwd,
    profile: configuration.profile,
    effect: configuration.effect,
  };
  if (!runtimeLogged) {
    runtimeLogged = true;
    log(
      `ultracode-engine: cli=${configuration.cli} profile=${configuration.profile} ` +
      `cwd=${configuration.cwd}`,
    );
  }

  if (options.schema) {
    const definition = validateSchemaDefinition(options.schema);
    if (!definition.ok) {
      return failureEnvelope(
        new UltracodeError('schema_definition', definition.errors.join('; ')),
        0,
        { ...baseMeta, durationMs: Date.now() - startedAt },
      );
    }
  }

  try {
    await acquire(deadlineAt);
  } catch (error) {
    return failureEnvelope(
      classifyError(error),
      0,
      { ...baseMeta, durationMs: Date.now() - startedAt },
    );
  }

  const diagnostics = [];
  let incompleteCount = 0;
  let attempts = 0;
  let lastError = new UltracodeError('internal', 'agent did not run');
  process.stderr.write(`  → [${id}] ${label}\n`);
  try {
    for (let attempt = 0; attempt <= configuration.retries; attempt += 1) {
      if (shutdownState) {
        lastError = new UltracodeError('shutdown', `shutdown started by ${shutdownState.signal}`);
        break;
      }
      attempts = attempt + 1;
      const contractedPrompt = options.schema
        ? withContract(prompt, options.schema, attempt > 0)
        : prompt;
      try {
        const args = buildAdapterArguments(contractedPrompt, { ...options, ...configuration });
        const result = await runChild(configuration, args, deadlineAt);
        const output = configuration.cli === 'claude' ? unwrapClaude(result.stdout) : result.stdout;
        const value = options.schema ? extractJson(output) : output.trim();
        if (options.schema) {
          const validation = validateStructuredValue(value, options.schema);
          if (!validation.ok) {
            throw new UltracodeError('schema', validation.errors.join('; '), {
              retryable: true,
              incomplete: true,
            });
          }
        }
        const meta = {
          ...baseMeta,
          durationMs: Date.now() - startedAt,
        };
        if (diagnostics.length > 0) {
          meta.diagnostics = diagnostics;
          meta.incompleteCount = incompleteCount;
        }
        return successEnvelope(value, attempts, meta);
      } catch (error) {
        lastError = classifyError(error);
        if (lastError.incomplete) {
          incompleteCount += 1;
        }
        diagnostics.push(attemptDiagnostic(attempts, lastError));
        if (diagnostics.length > MAX_DIAGNOSTICS) {
          diagnostics.shift();
        }
        warn(
          `[${id}] ${label} attempt ${attempts}/${configuration.retries + 1} failed: ` +
          `${lastError.message}`,
        );
        if (
          shutdownState ||
          !lastError.retryable ||
          attempt === configuration.retries ||
          Date.now() >= deadlineAt
        ) {
          break;
        }
      }
    }
    return failureEnvelope(
      lastError,
      attempts,
      { ...baseMeta, durationMs: Date.now() - startedAt },
      diagnostics,
      incompleteCount,
    );
  } finally {
    release();
  }
}

/**
 * Runs thunks concurrently while preserving input order.
 *
 * @param {Array<() => unknown|Promise<unknown>>} thunks - Deferred tasks.
 * @returns {Promise<unknown[]>} Ordered task results; thrown tasks become failure envelopes.
 */
export async function parallel(thunks) {
  return Promise.all(thunks.map(async (thunk, index) => {
    try {
      return await thunk();
    } catch (error) {
      return failureEnvelope(
        new UltracodeError('stage', `parallel task ${index} failed: ${classifyError(error).message}`),
        0,
        { index },
      );
    }
  }));
}

/**
 * Maps items concurrently while preserving input order.
 *
 * @param {unknown[]} items - Input items.
 * @param {(item: unknown, index: number) => unknown|Promise<unknown>} mapper - Mapping function.
 * @returns {Promise<unknown[]>} Ordered mapped results.
 */
export async function map(items, mapper) {
  return parallel(items.map((item, index) => () => mapper(item, index)));
}

/**
 * Sends each item through required stages without barriers between stages.
 *
 * A failed agent envelope or thrown stage stops that item and remains visible in
 * the returned ordered array.
 *
 * @param {unknown[]} items - Original pipeline items.
 * @param {...Function} stages - Required stage functions.
 * @returns {Promise<object[]>} One success or failure envelope per item.
 */
export async function pipeline(items, ...stages) {
  return Promise.all(items.map(async (item, index) => {
    let value = item;
    for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
      try {
        const result = await stages[stageIndex](value, item, index);
        if (isEnvelope(result)) {
          if (!result.ok) {
            return {
              ...result,
              meta: {
                ...(result.meta || {}),
                pipelineIndex: index,
                failedStage: stageIndex,
              },
            };
          }
          value = result.value;
        } else {
          value = result;
        }
      } catch (error) {
        return failureEnvelope(
          new UltracodeError('stage', `pipeline stage ${stageIndex} failed: ${classifyError(error).message}`),
          0,
          { pipelineIndex: index, failedStage: stageIndex },
        );
      }
    }
    return successEnvelope(value, 0, { pipelineIndex: index, stagesCompleted: stages.length });
  }));
}

/**
 * Dispatches a synthesis agent over prior structured results.
 *
 * @param {unknown[]} inputs - Results to synthesize.
 * @param {string|((inputs: unknown[]) => string)} prompt - Prompt or prompt builder.
 * @param {object} [options] - Standard agent options.
 * @returns {Promise<object>} Agent envelope.
 */
export async function synthesize(inputs, prompt, options = {}) {
  const synthesisPrompt = typeof prompt === 'function' ? prompt(inputs) : prompt;
  return agent(`${synthesisPrompt}\n\nINPUTS:\n${JSON.stringify(inputs, null, 2)}`, options);
}

/**
 * Sorts values deterministically by selected scalar keys.
 *
 * @param {object[]} values - Objects to sort without mutation.
 * @param {string[]} keys - Keys compared in order.
 * @returns {object[]} Sorted copy.
 */
export function deterministicSort(values, keys) {
  return [...values].sort((left, right) => {
    for (const key of keys) {
      const comparison = String(left?.[key] ?? '').localeCompare(String(right?.[key] ?? ''), 'en');
      if (comparison !== 0) {
        return comparison;
      }
    }
    return JSON.stringify(left).localeCompare(JSON.stringify(right), 'en');
  });
}

/**
 * Tests whether a value is an ultracode envelope.
 *
 * @param {unknown} value - Candidate value.
 * @returns {boolean} Whether the value is an envelope.
 */
function isEnvelope(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.ok === 'boolean' &&
    Number.isInteger(value.attempts),
  );
}

/**
 * Executes a workflow and prints one final structured envelope to stdout.
 *
 * @param {() => unknown|Promise<unknown>} main - Workflow body.
 * @returns {Promise<object>} Printed envelope.
 */
export async function run(main) {
  let envelope;
  try {
    const value = await main();
    envelope = isEnvelope(value) ? value : successEnvelope(value);
  } catch (error) {
    envelope = failureEnvelope(
      new UltracodeError('workflow', classifyError(error).message),
      0,
    );
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  return envelope;
}
