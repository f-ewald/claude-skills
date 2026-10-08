/**
 * Discovers Copilot models and selects the newest flagship model per council vendor.
 *
 * Sources: the policy-aware but experimental `models.list` JSON-RPC method of a
 * headless Copilot CLI, merged with the static catalog printed by
 * `copilot help config`. Availability of catalog-only models is proven at launch.
 */

import { bounded } from './errors.mjs';
import { runProcess, spawnTracked, terminate } from './process.mjs';

/** Council seats: one member per vendor, identified by model ID prefix. */
export const COUNCIL_VENDORS = Object.freeze([
  Object.freeze({ vendor: 'anthropic', label: 'Anthropic', pattern: /^claude-/ }),
  Object.freeze({ vendor: 'openai', label: 'OpenAI', pattern: /^(?:gpt-|o\d)/ }),
  Object.freeze({ vendor: 'google', label: 'Google', pattern: /^gemini-/ }),
]);

/** Reasoning effort levels from strongest to weakest. */
export const EFFORT_LADDER = Object.freeze(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']);

/** Variant classes never selected: speed variants and small variants. */
export const EXCLUDED_VARIANTS = Object.freeze(['fast', 'small']);

const CATEGORY_TIERS = new Map([['powerful', 3], ['versatile', 2], ['lightweight', 1]]);
const TOKEN_TIERS = new Map([
  ['opus', 3], ['sol', 3], ['pro', 3], ['ultra', 3],
  ['sonnet', 2], ['terra', 2], ['flash', 2],
  ['haiku', 1], ['luna', 1],
]);
const VARIANT_TOKENS = new Map([['fast', 'fast'], ['mini', 'small'], ['nano', 'small'], ['lite', 'small']]);
const TIER_NAMES = new Map([[3, 'flagship'], [2, 'mid'], [1, 'light'], [0, 'unknown']]);
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const VERSION_TOKEN = /^o?(\d+(?:\.\d+)*)$/;
const RPC_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_CHAIN_LENGTH = 3;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * Extracts the model IDs listed under the `model` setting of `copilot help config`.
 *
 * @param {string} text - Help output.
 * @returns {string[]} Unique, syntactically valid model IDs in listed order.
 */
export function parseCatalog(text) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*`model`:/.test(line));
  if (start === -1) {
    return [];
  }
  const ids = [];
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^\s+-\s+"([^"]+)"\s*$/);
    if (!match) {
      break;
    }
    if (MODEL_ID_PATTERN.test(match[1])) {
      ids.push(match[1]);
    }
  }
  return [...new Set(ids)];
}

/**
 * Derives vendor, version, tier hint, and variant from a model ID.
 *
 * @param {string} id - Model ID such as `claude-opus-5.5` or `gpt-6.1-sol`.
 * @returns {{vendor: string|null, version: number[], tokenTier: number, variant: string|null,
 *   extraTokens: number}} Parsed description.
 */
export function describeModelId(id) {
  const tokens = id.split('-');
  const body = /^o\d/.test(tokens[0]) ? tokens : tokens.slice(1);
  const versionToken = body.find((token) => VERSION_TOKEN.test(token)) ?? null;
  const tierToken = body.find((token) => TOKEN_TIERS.has(token)) ?? null;
  const variantToken = body.find((token) => VARIANT_TOKENS.has(token)) ?? null;
  const known = new Set([versionToken, tierToken, variantToken].filter(Boolean));
  return {
    vendor: COUNCIL_VENDORS.find((entry) => entry.pattern.test(id))?.vendor ?? null,
    version: versionToken ? versionToken.match(VERSION_TOKEN)[1].split('.').map(Number) : [],
    tokenTier: tierToken ? TOKEN_TIERS.get(tierToken) : 0,
    variant: variantToken ? VARIANT_TOKENS.get(variantToken) : null,
    extraTokens: body.filter((token) => !known.has(token)).length,
  };
}

/**
 * Returns the strongest reasoning effort in a list.
 *
 * @param {string[]} levels - Supported levels.
 * @returns {string|null} Strongest level, or null when none is recognized.
 */
export function highestEffort(levels) {
  return EFFORT_LADDER.find((level) => levels.includes(level)) ?? null;
}

/**
 * Compares numeric version arrays.
 *
 * @param {number[]} left - First version.
 * @param {number[]} right - Second version.
 * @returns {number} Negative when left is older, positive when newer, zero when equal.
 */
export function compareVersions(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * Orders candidates best-first: top tier, then newest version, then verified,
 * then the base model over decorated variants, then ID.
 *
 * @param {object} left - Candidate.
 * @param {object} right - Candidate.
 * @returns {number} Sort order.
 */
export function compareCandidates(left, right) {
  return (right.tier - left.tier)
    || compareVersions(right.version, left.version)
    || (Number(right.verified) - Number(left.verified))
    || (left.extraTokens - right.extraTokens)
    || left.id.localeCompare(right.id);
}

/**
 * Merges models.list entries and catalog IDs into eligible council candidates.
 *
 * @param {object} sources - Discovery results.
 * @param {object[]} [sources.rpcModels] - Raw models.list entries.
 * @param {string[]} [sources.catalogIds] - Static catalog IDs.
 * @param {string[]} [sources.excludedVariants] - Variant classes to drop.
 * @returns {object[]} Candidates belonging to a council vendor.
 */
export function buildCandidates({ rpcModels = [], catalogIds = [], excludedVariants = EXCLUDED_VARIANTS }) {
  const byId = new Map();
  for (const model of rpcModels) {
    if (!isWellFormedRpcModel(model) || byId.has(model.id)) {
      continue;
    }
    byId.set(model.id, model.policy?.state === 'disabled' ? null : candidateFromRpc(model));
  }
  for (const id of catalogIds) {
    if (MODEL_ID_PATTERN.test(id) && !byId.has(id)) {
      byId.set(id, candidateFromCatalog(id));
    }
  }
  return [...byId.values()].filter(
    (candidate) => candidate !== null && candidate.vendor !== null && !excludedVariants.includes(candidate.variant),
  );
}

/**
 * Checks the minimal shape of a models.list entry.
 *
 * @param {unknown} model - Raw entry.
 * @returns {boolean} True when the entry has a valid, non-auto ID.
 */
function isWellFormedRpcModel(model) {
  return Boolean(model) && typeof model.id === 'string' && MODEL_ID_PATTERN.test(model.id) && model.id !== 'auto';
}

/**
 * Builds a candidate from a policy-aware models.list entry.
 *
 * @param {object} model - Raw models.list entry.
 * @returns {object} Candidate.
 */
function candidateFromRpc(model) {
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.filter((level) => EFFORT_LADDER.includes(level))
    : [];
  const description = describeModelId(model.id);
  return {
    ...description,
    id: model.id,
    name: displayName(model.name, model.id),
    tier: CATEGORY_TIERS.get(model.modelPickerCategory) ?? description.tokenTier,
    verified: model.policy?.state === 'enabled',
    effort: highestEffort(efforts),
    effortProbe: false,
    multiplier: Number.isFinite(model.billing?.multiplier) ? model.billing.multiplier : null,
    price: tokenPrice(model.billing?.tokenPrices),
    source: 'models.list',
  };
}

/**
 * Extracts input/output token prices when the service publishes them.
 *
 * @param {unknown} prices - Raw `billing.tokenPrices`.
 * @returns {{input: number, output: number, perTokens: number}|null} Prices, or null when unavailable.
 */
function tokenPrice(prices) {
  if (!prices || !Number.isFinite(prices.inputPrice) || !Number.isFinite(prices.outputPrice)) {
    return null;
  }
  const perTokens = Number.isFinite(prices.batchSize) ? prices.batchSize : 1_000_000;
  return { input: prices.inputPrice, output: prices.outputPrice, perTokens };
}

/**
 * Builds an unverified candidate from a static catalog ID.
 *
 * @param {string} id - Model ID.
 * @returns {object} Candidate whose availability and effort are proven at launch.
 */
function candidateFromCatalog(id) {
  const description = describeModelId(id);
  return {
    ...description,
    id,
    name: id,
    tier: description.tokenTier,
    verified: false,
    effort: null,
    effortProbe: true,
    multiplier: null,
    price: null,
    source: 'catalog',
  };
}

/**
 * Sanitizes a provider display name.
 *
 * @param {unknown} name - Raw display name.
 * @param {string} fallback - Value used when the name is unusable.
 * @returns {string} Printable name of at most 80 characters.
 */
function displayName(name, fallback) {
  if (typeof name !== 'string') {
    return fallback;
  }
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return clean || fallback;
}

/**
 * Selects one ranked fallback chain per council vendor.
 *
 * Verified candidates are preferred; unverified ones are used only for a vendor
 * that has no verified candidate.
 *
 * @param {object[]} candidates - Output of buildCandidates.
 * @param {number} [chainLength=3] - Models kept per vendor.
 * @returns {{members: object[], missingVendors: string[]}} Roster.
 */
export function selectRoster(candidates, chainLength = DEFAULT_CHAIN_LENGTH) {
  const members = [];
  const missingVendors = [];
  for (const { vendor, label } of COUNCIL_VENDORS) {
    const all = candidates.filter((candidate) => candidate.vendor === vendor);
    const verified = all.filter((candidate) => candidate.verified);
    const pool = verified.length > 0 ? verified : all;
    if (pool.length === 0) {
      missingVendors.push(vendor);
      continue;
    }
    const chain = [...pool].sort(compareCandidates).slice(0, chainLength).map(publicCandidate);
    members.push({ vendor, vendorLabel: label, chain });
  }
  return { members, missingVendors };
}

/**
 * Projects a candidate onto the fields persisted in the roster.
 *
 * @param {object} candidate - Internal candidate.
 * @returns {object} Roster entry.
 */
function publicCandidate(candidate) {
  return {
    id: candidate.id,
    name: candidate.name,
    tier: TIER_NAMES.get(candidate.tier) ?? 'unknown',
    version: candidate.version.join('.'),
    verified: candidate.verified,
    effort: candidate.effort,
    effortProbe: candidate.effortProbe,
    multiplier: candidate.multiplier,
    price: candidate.price,
    source: candidate.source,
  };
}

/**
 * Reads the static model catalog from `copilot help config`.
 *
 * @param {object} options - Discovery options.
 * @returns {Promise<string[]>} Catalog IDs.
 * @throws {Error} When the command fails or lists no models.
 */
export async function readCatalog(options) {
  const result = await runProcess(options.binary, ['help', 'config'], {
    cwd: options.cwd,
    env: options.env,
    deadlineMs: options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
    registry: options.registry,
    maxStdoutBytes: 1024 * 1024,
  });
  if (result.code !== 0) {
    throw new Error(`copilot help config failed: ${bounded(result.spawnError || result.stderr)}`);
  }
  const ids = parseCatalog(result.stdout);
  if (ids.length === 0) {
    throw new Error('copilot help config listed no models');
  }
  return ids;
}

/**
 * Lists models through a short-lived headless Copilot CLI JSON-RPC server.
 *
 * @param {object} options - Discovery options.
 * @returns {Promise<{protocolVersion: number, models: object[]}>} Raw models.list result.
 * @throws {Error} On timeout, protocol, or transport failure.
 */
export async function listModelsViaRpc(options) {
  const child = spawnTracked(options.binary, ['--headless', '--no-auto-update', '--stdio'], {
    cwd: options.cwd,
    env: options.env,
    registry: options.registry,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const connection = new JsonRpcConnection(child);
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const timer = setTimeout(() => connection.fail(new Error('models.list timed out')), timeoutMs);
  try {
    const ping = await connection.request('ping', {});
    if (!Number.isInteger(ping?.protocolVersion)) {
      throw new Error('headless Copilot returned an unexpected ping response');
    }
    const listed = await connection.request('models.list', {});
    if (!Array.isArray(listed?.models)) {
      throw new Error('models.list returned no models array');
    }
    return { protocolVersion: ping.protocolVersion, models: listed.models };
  } finally {
    clearTimeout(timer);
    connection.close();
  }
}

/**
 * Discovers the council roster from every available source.
 *
 * @param {object} options - Discovery options.
 * @param {string} options.binary - Copilot CLI executable.
 * @param {string} options.cwd - Neutral working directory.
 * @param {NodeJS.ProcessEnv} options.env - Environment for the CLI.
 * @param {import('./process.mjs').ProcessRegistry} [options.registry] - Process registry.
 * @param {number} [options.timeoutMs] - Per-source timeout.
 * @param {number} [options.chainLength] - Fallback chain length.
 * @returns {Promise<{members: object[], missingVendors: string[], sources: object, diagnostics: object[]}>}
 *   Roster; source failures are reported as diagnostics, never thrown.
 */
export async function discoverRoster(options) {
  const diagnostics = [];
  const [rpc, catalogIds] = await Promise.all([
    captureFailure(() => listModelsViaRpc(options), 'models.list', diagnostics),
    captureFailure(() => readCatalog(options), 'help config', diagnostics),
  ]);
  const candidates = buildCandidates({ rpcModels: rpc?.models ?? [], catalogIds: catalogIds ?? [] });
  return {
    ...selectRoster(candidates, options.chainLength),
    sources: {
      modelsList: rpc ? { protocolVersion: rpc.protocolVersion, entries: rpc.models.length } : null,
      catalog: catalogIds ? { entries: catalogIds.length } : null,
    },
    diagnostics,
  };
}

/**
 * Runs a discovery source and records its failure instead of throwing.
 *
 * @param {Function} action - Async source.
 * @param {string} source - Source name.
 * @param {object[]} diagnostics - Collected failures.
 * @returns {Promise<unknown>} Source result, or null on failure.
 */
async function captureFailure(action, source, diagnostics) {
  try {
    return await action();
  } catch (error) {
    diagnostics.push({ source, error: bounded(error.message) });
    return null;
  }
}

/** Minimal Content-Length framed JSON-RPC 2.0 client over a child's stdio. */
class JsonRpcConnection {
  /**
   * Attaches to a spawned child.
   *
   * @param {import('node:child_process').ChildProcess} child - Child with piped stdin/stdout.
   */
  constructor(child) {
    this.child = child;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.failure = null;
    child.stdout.on('data', (chunk) => this.receive(chunk));
    child.stdin.on('error', () => {});
    child.once('error', (error) => this.fail(error));
    child.once('exit', (code) => this.fail(new Error(`headless Copilot exited (${code}) before responding`)));
  }

  /**
   * Sends a request and resolves with its result.
   *
   * @param {string} method - JSON-RPC method.
   * @param {object} params - Parameters.
   * @returns {Promise<unknown>} Result value.
   */
  request(method, params) {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    const id = this.nextId;
    this.nextId += 1;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
    return promise;
  }

  /**
   * Buffers stdout and dispatches every complete message.
   *
   * @param {Buffer} chunk - Stdout chunk.
   * @returns {void}
   */
  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > RPC_MAX_BUFFER_BYTES) {
      this.fail(new Error('JSON-RPC response exceeded the size limit'));
      return;
    }
    for (let message = this.nextMessage(); message !== null; message = this.nextMessage()) {
      this.dispatch(message);
    }
  }

  /**
   * Removes and parses the next complete framed message.
   *
   * @returns {object|null} Parsed message, or null when incomplete or failed.
   */
  nextMessage() {
    if (this.failure) {
      return null;
    }
    const headerEnd = this.buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      return null;
    }
    const match = /content-length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString('latin1'));
    if (!match) {
      this.fail(new Error('malformed JSON-RPC header'));
      return null;
    }
    const end = headerEnd + 4 + Number(match[1]);
    if (this.buffer.length < end) {
      return null;
    }
    const text = this.buffer.subarray(headerEnd + 4, end).toString('utf8');
    this.buffer = this.buffer.subarray(end);
    try {
      return JSON.parse(text);
    } catch {
      this.fail(new Error('malformed JSON-RPC body'));
      return null;
    }
  }

  /**
   * Resolves or rejects the pending request a response belongs to.
   *
   * @param {object} message - Parsed message.
   * @returns {void}
   */
  dispatch(message) {
    const entry = this.pending.get(message?.id);
    if (!entry) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(`JSON-RPC error: ${bounded(message.error.message ?? 'unknown', 200)}`));
      return;
    }
    entry.resolve(message.result);
  }

  /**
   * Rejects every pending request once.
   *
   * @param {Error} error - Failure reason.
   * @returns {void}
   */
  fail(error) {
    if (this.failure) {
      return;
    }
    this.failure = error;
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }

  /**
   * Closes the connection and terminates the server.
   *
   * @returns {void}
   */
  close() {
    this.fail(new Error('connection closed'));
    this.child.stdin.end();
    terminate(this.child);
  }
}
