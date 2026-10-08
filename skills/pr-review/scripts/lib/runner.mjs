/**
 * Runs council members as sandboxed, read-only headless Copilot CLI processes.
 *
 * Members get only view/rg/glob inside the snapshot directory, no custom
 * instructions, no built-in MCP servers, and no temporary-directory access.
 * The user's Copilot configuration (including managed hooks) stays in effect;
 * only COPILOT_ALLOW_ALL is removed so the snapshot is never auto-trusted.
 */

import { CouncilError, bounded } from './errors.mjs';
import { EFFORT_LADDER } from './models.mjs';
import { runProcess } from './process.mjs';

export const OPEN_MARKER = '<<<PR_REVIEW_COUNCIL_JSON>>>';
export const CLOSE_MARKER = '<<<PR_REVIEW_COUNCIL_END>>>';
export const MEMBER_TOOLS = Object.freeze(['view', 'rg', 'glob']);
const MAX_MEMBER_STDOUT_BYTES = 8 * 1024 * 1024;
const REJECTIONS = Object.freeze([
  Object.freeze({ kind: 'model-unavailable', pattern: /Model "[^"]*" from --model flag is not available/ }),
  Object.freeze({ kind: 'effort-unsupported', pattern: /Reasoning effort "[^"]*" is not supported for model/ }),
  Object.freeze({ kind: 'effort-not-configurable', pattern: /does not support reasoning effort configuration/ }),
]);

/**
 * Builds the complete, sandboxed argument list for one member invocation.
 *
 * @param {object} options - Invocation values.
 * @param {string} options.prompt - Member prompt.
 * @param {string} options.model - Model ID.
 * @param {string|null} options.effort - Reasoning effort, or null to omit the flag.
 * @param {string} options.cwd - Snapshot directory.
 * @returns {string[]} Arguments for the copilot executable.
 */
export function buildMemberArguments({ prompt, model, effort, cwd }) {
  return [
    '-p', prompt,
    '--model', model,
    ...(effort ? ['--reasoning-effort', effort] : []),
    '-C', cwd,
    '--silent',
    '--no-color',
    '--log-level', 'none',
    '--no-ask-user',
    '--no-auto-update',
    '--no-custom-instructions',
    '--disable-builtin-mcps',
    '--disallow-temp-dir',
    '--no-remote-export',
    '--available-tools', MEMBER_TOOLS.join(','),
    ...MEMBER_TOOLS.flatMap((tool) => ['--allow-tool', tool]),
  ];
}

/**
 * Copies the environment without variables that would auto-trust the snapshot.
 *
 * @param {NodeJS.ProcessEnv} environment - Source environment.
 * @returns {NodeJS.ProcessEnv} Member environment.
 */
export function memberEnvironment(environment) {
  const copy = { ...environment };
  delete copy.COPILOT_ALLOW_ALL;
  return copy;
}

/**
 * Detects the CLI's zero-cost, pre-call rejections.
 *
 * @param {{code: number|null, stdout: string, stderr: string}} result - Process result.
 * @returns {'model-unavailable'|'effort-unsupported'|'effort-not-configurable'|null} Rejection kind.
 */
export function classifyRejection(result) {
  if (result.code !== 1 || String(result.stdout).trim() !== '') {
    return null;
  }
  return REJECTIONS.find(({ pattern }) => pattern.test(result.stderr))?.kind ?? null;
}

/**
 * Extracts the JSON value from the last complete sentinel block.
 *
 * @param {string} stdout - Member output.
 * @returns {unknown} Parsed value.
 * @throws {CouncilError} kind `member-output` when no parsable block exists.
 */
export function extractMemberJson(stdout) {
  const end = stdout.lastIndexOf(CLOSE_MARKER);
  const start = end === -1 ? -1 : stdout.lastIndexOf(OPEN_MARKER, end);
  if (start === -1) {
    throw new CouncilError('member-output', 'response has no complete JSON block');
  }
  try {
    return JSON.parse(stdout.slice(start + OPEN_MARKER.length, end).trim());
  } catch {
    throw new CouncilError('member-output', 'response JSON block is malformed');
  }
}

/**
 * Runs one member through its confirmed fallback chain within one deadline.
 *
 * @param {object} options - Member options.
 * @param {object[]} options.chain - Confirmed models, best first.
 * @param {string} options.prompt - Prompt.
 * @param {Function} options.validate - Validates and normalizes the parsed JSON; throws on error.
 * @param {string} options.cwd - Snapshot directory.
 * @param {number} options.deadlineMs - Total time for every attempt.
 * @param {number} options.retries - Extra attempts after malformed output or a failed exit.
 * @param {string} options.binary - copilot executable.
 * @param {NodeJS.ProcessEnv} options.env - Member environment.
 * @param {import('./process.mjs').ProcessRegistry} [options.registry] - Process registry.
 * @returns {Promise<{status: 'ok'|'failed', value?: unknown, model?: string, name?: string,
 *   effort?: string|null, error?: string, attempts: object[]}>} Outcome; never rejects.
 */
export async function runMember(options) {
  const deadlineAt = Date.now() + options.deadlineMs;
  const attempts = [];
  for (const candidate of options.chain) {
    const outcome = await runCandidate({ ...options, candidate, deadlineAt, attempts });
    if (outcome.status !== 'unavailable') {
      return { ...outcome, attempts };
    }
  }
  return { status: 'failed', error: 'no model in the confirmed fallback chain is available', attempts };
}

/**
 * Runs one model, stepping down the effort ladder when the model rejects a
 * level, and dropping the flag when the model has no effort configuration.
 *
 * @param {object} options - Member options plus `candidate`, `deadlineAt`, and `attempts`.
 * @returns {Promise<object>} Outcome with status ok, failed, or unavailable.
 */
async function runCandidate(options) {
  const levels = options.candidate.effortProbe ? [...EFFORT_LADDER, null] : [options.candidate.effort ?? null];
  for (const effort of levels) {
    const outcome = await runWithRetries({ ...options, effort });
    if (outcome.status === 'effort-not-configurable' && effort !== null) {
      return settleEffort(await runWithRetries({ ...options, effort: null }), options.candidate);
    }
    if (outcome.status !== 'effort-unsupported') {
      return settleEffort(outcome, options.candidate);
    }
  }
  return { status: 'failed', error: `no reasoning effort was accepted for ${options.candidate.id}` };
}

/**
 * Converts a leftover effort rejection into a failure.
 *
 * @param {object} outcome - Attempt outcome.
 * @param {object} candidate - Model candidate.
 * @returns {object} Outcome with status ok, failed, or unavailable.
 */
function settleEffort(outcome, candidate) {
  return outcome.status.startsWith('effort-')
    ? { status: 'failed', error: `no reasoning effort was accepted for ${candidate.id}` }
    : outcome;
}

/**
 * Runs one model at one effort, retrying malformed output.
 *
 * @param {object} options - Candidate options plus `effort`.
 * @returns {Promise<object>} Outcome with status ok, failed, unavailable, or effort-unsupported.
 */
async function runWithRetries(options) {
  const { candidate, effort } = options;
  let lastError = 'no attempt ran';
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    const remaining = options.deadlineAt - Date.now();
    if (remaining <= 0) {
      return { status: 'failed', error: 'deadline exceeded' };
    }
    const args = buildMemberArguments({ prompt: options.prompt, model: candidate.id, effort, cwd: options.cwd });
    const result = await runProcess(options.binary, args, {
      cwd: options.cwd,
      env: options.env,
      deadlineMs: remaining,
      maxStdoutBytes: MAX_MEMBER_STDOUT_BYTES,
      registry: options.registry,
    });
    options.attempts.push(describeAttempt(candidate.id, effort, result));
    const terminal = terminalOutcome(result);
    if (terminal) {
      return terminal;
    }
    const parsed = parseMemberResult(result, options.validate);
    if (parsed.ok) {
      return { status: 'ok', value: parsed.value, model: candidate.id, name: candidate.name, effort };
    }
    lastError = parsed.error;
  }
  return { status: 'failed', error: lastError };
}

/**
 * Maps results that must not be retried to an outcome.
 *
 * @param {object} result - Process result.
 * @returns {object|null} Outcome, or null when the result should be parsed.
 */
function terminalOutcome(result) {
  const rejection = classifyRejection(result);
  if (rejection === 'model-unavailable') {
    return { status: 'unavailable' };
  }
  if (rejection) {
    return { status: rejection };
  }
  if (result.spawnError) {
    return { status: 'failed', error: `cannot start copilot: ${bounded(result.spawnError, 200)}` };
  }
  return result.timedOut ? { status: 'failed', error: 'deadline exceeded' } : null;
}

/**
 * Validates a finished member process and its JSON block.
 *
 * @param {object} result - Process result.
 * @param {Function} validate - Payload validator.
 * @returns {{ok: true, value: unknown}|{ok: false, error: string}} Parse outcome.
 */
function parseMemberResult(result, validate) {
  if (result.code !== 0) {
    return { ok: false, error: `copilot exited ${result.code ?? result.signal}: ${bounded(result.stderr, 300)}` };
  }
  if (result.stdoutTruncated) {
    return { ok: false, error: 'member output exceeded the size limit' };
  }
  try {
    return { ok: true, value: validate(extractMemberJson(result.stdout)) };
  } catch (error) {
    return { ok: false, error: bounded(error.message, 300) };
  }
}

/**
 * Summarizes an attempt for the council report.
 *
 * @param {string} model - Model ID.
 * @param {string|null} effort - Effort used.
 * @param {object} result - Process result.
 * @returns {object} Attempt record.
 */
function describeAttempt(model, effort, result) {
  return {
    model,
    effort,
    exit: result.code ?? result.signal ?? null,
    timedOut: result.timedOut,
    rejected: classifyRejection(result),
    stderr: bounded(result.stderr.trim(), 200),
  };
}
