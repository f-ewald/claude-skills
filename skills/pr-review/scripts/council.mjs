#!/usr/bin/env node

/**
 * LLM-council command line for the pr-review skill (GitHub Copilot CLI only).
 *
 * Every subcommand prints exactly one JSON envelope on stdout,
 * `{"ok": true, "value": ...}` or `{"ok": false, "error": {kind, message, details?}}`,
 * and reports progress on stderr.
 *
 *   prepare  --host H --owner O --repo R --number N --head SHA --base SHA --changed-files N
 *   run      --workspace PATH
 *   finalize --workspace PATH
 *   cleanup  --workspace PATH [--all]
 *
 * Environment (defaults in parentheses): PR_REVIEW_COPILOT_BIN (copilot),
 * PR_REVIEW_GH_BIN (gh), PR_REVIEW_COUNCIL_STAGE1_MS (30 min),
 * PR_REVIEW_COUNCIL_STAGE2_MS (15 min), PR_REVIEW_COUNCIL_RETRIES (1),
 * PR_REVIEW_COUNCIL_SNAPSHOT_MIB (2048), and PR_REVIEW_COUNCIL_SEED (tests only;
 * makes anonymous labels and ballot order deterministic).
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDiffIndex, validateCoordinate } from './lib/diff.mjs';
import { CouncilError, bounded, exitCodeFor } from './lib/errors.mjs';
import { discoverRoster } from './lib/models.mjs';
import { ProcessRegistry } from './lib/process.mjs';
import { buildStage1Prompt, buildStage2Prompt } from './lib/prompts.mjs';
import { composeFinalReport, fallbacksUsed } from './lib/report.mjs';
import { memberEnvironment, runMember } from './lib/runner.mjs';
import {
  DEFAULT_SNAPSHOT_CAP_MIB,
  GhClient,
  fetchComparison,
  fetchPinnedPullRequest,
  materializeChangedFiles,
  materializeHead,
  validatePinnedInput,
  writeSnapshotDocuments,
} from './lib/snapshot.mjs';
import {
  assignLabels,
  buildBallot,
  buildChairmanPacket,
  computeAgreement,
  computeLeaderboard,
  createRandom,
  screenFindings,
  validateChairman,
  validateStage1,
  validateStage2,
} from './lib/consensus.mjs';
import {
  createWorkspace,
  openWorkspace,
  readJson,
  removeSnapshot,
  removeWorkspace,
  resetSnapshotDirectory,
  writeJson,
} from './lib/workspace.mjs';

const MINUTE_MS = 60_000;
const QUORUM = 2;
const COMMAND_OPTIONS = new Map([
  ['prepare', ['host', 'owner', 'repo', 'number', 'head', 'base', 'changed-files']],
  ['run', ['workspace']],
  ['finalize', ['workspace']],
  ['cleanup', ['workspace']],
]);
const COMMAND_FLAGS = new Map([['cleanup', ['all']]]);

/**
 * Writes a progress line to stderr.
 *
 * @param {string} message - Progress text.
 * @returns {void}
 */
function log(message) {
  process.stderr.write(`[pr-review council] ${message}\n`);
}

/**
 * Parses `<command> --name value ... [--flag]` with per-command allowlists.
 *
 * @param {string[]} argv - Arguments after the script path.
 * @returns {{command: string, options: Record<string, string>, flags: Set<string>}} Parsed arguments.
 * @throws {CouncilError} kind `usage` for unknown commands, options, or missing values.
 */
export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!COMMAND_OPTIONS.has(command)) {
    throw new CouncilError('usage', `unknown command; expected one of ${[...COMMAND_OPTIONS.keys()].join(', ')}`);
  }
  const allowed = COMMAND_OPTIONS.get(command);
  const allowedFlags = COMMAND_FLAGS.get(command) ?? [];
  const options = Object.create(null);
  const flags = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index].startsWith('--') ? rest[index].slice(2) : null;
    if (name !== null && allowedFlags.includes(name)) {
      flags.add(name);
      continue;
    }
    if (name === null || !allowed.includes(name) || rest[index + 1] === undefined || name in options) {
      throw new CouncilError('usage', `unexpected or incomplete argument: ${bounded(rest[index], 40)}`);
    }
    options[name] = rest[index + 1];
    index += 1;
  }
  const missing = allowed.filter((name) => !(name in options));
  if (missing.length > 0) {
    throw new CouncilError('usage', `missing --${missing.join(', --')}`);
  }
  return { command, options, flags };
}

/**
 * Reads a bounded integer setting from the environment.
 *
 * @param {NodeJS.ProcessEnv} environment - Environment.
 * @param {string} name - Variable name.
 * @param {number} fallback - Default value.
 * @param {number} minimum - Smallest accepted value.
 * @returns {number} Setting.
 */
function integerSetting(environment, name, fallback, minimum) {
  const parsed = Number.parseInt(environment[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

/**
 * Builds the execution context from the environment.
 *
 * @param {NodeJS.ProcessEnv} environment - Environment.
 * @param {ProcessRegistry} registry - Process registry.
 * @returns {object} Context.
 */
function createContext(environment, registry) {
  const seed = Number.parseInt(environment.PR_REVIEW_COUNCIL_SEED ?? '', 10);
  return {
    registry,
    env: environment,
    memberEnv: memberEnvironment(environment),
    copilot: environment.PR_REVIEW_COPILOT_BIN || 'copilot',
    gh: new GhClient({ binary: environment.PR_REVIEW_GH_BIN || 'gh', env: environment, registry }),
    stage1Ms: integerSetting(environment, 'PR_REVIEW_COUNCIL_STAGE1_MS', 30 * MINUTE_MS, 1),
    stage2Ms: integerSetting(environment, 'PR_REVIEW_COUNCIL_STAGE2_MS', 15 * MINUTE_MS, 1),
    retries: integerSetting(environment, 'PR_REVIEW_COUNCIL_RETRIES', 1, 0),
    capBytes: integerSetting(environment, 'PR_REVIEW_COUNCIL_SNAPSHOT_MIB', DEFAULT_SNAPSHOT_CAP_MIB, 1) * 1024 * 1024,
    random: createRandom(Number.isInteger(seed) ? seed : undefined),
  };
}

/**
 * Validates persisted pinned input again before reuse.
 *
 * @param {object} state - Persisted state document.
 * @returns {object} Normalized input.
 */
function pinnedInputFrom(state) {
  const input = state.input ?? {};
  return validatePinnedInput({
    host: String(input.host), owner: String(input.owner), repo: String(input.repo), number: String(input.number),
    head: String(input.head), base: String(input.base), changedFiles: String(input.changedFiles),
  });
}

/**
 * Requires the workspace to be at an expected stage.
 *
 * @param {object} state - Persisted state document.
 * @param {string} stage - Expected stage.
 * @returns {void}
 * @throws {CouncilError} kind `state` otherwise.
 */
function requireStage(state, stage) {
  if (state.stage !== stage) {
    throw new CouncilError('state', `workspace is at stage "${bounded(state.stage, 20)}", expected "${stage}"`);
  }
}

/**
 * Builds the untrusted pull-request metadata document members read.
 *
 * @param {object} input - Normalized pinned input.
 * @param {{url: string, title: string, body: string}} pr - Pull-request metadata.
 * @param {object[]} files - Normalized comparison records.
 * @param {string} context - Context mode.
 * @returns {object} Metadata document.
 */
function metaDocument(input, pr, files, context) {
  return {
    pinned: { host: input.host, owner: input.owner, repo: input.repo, number: input.number,
      head: input.head, base: input.base },
    url: pr.url,
    untrusted_title: pr.title,
    untrusted_body: pr.body,
    context,
    files: files.map(({ filename, previous_filename: previous, status, binary }) => ({
      filename, previous_filename: previous, status, binary,
    })),
  };
}

/**
 * Prepares a workspace and the roster; spends no model credits.
 *
 * @param {Record<string, string>} options - Parsed options.
 * @param {object} context - Execution context.
 * @returns {Promise<object>} Workspace path, quorum, and roster for confirmation.
 */
async function prepare(options, context) {
  const input = validatePinnedInput({ ...options, changedFiles: options['changed-files'] });
  log('verifying the pinned pull request and comparison');
  const pr = await fetchPinnedPullRequest(input, context.gh);
  const { files, diffText } = await fetchComparison(input, context.gh);
  buildDiffIndex(files);
  log('discovering council models');
  const roster = await discoverRoster({
    binary: context.copilot, cwd: tmpdir(), env: context.memberEnv, registry: context.registry,
  });
  if (roster.members.length < QUORUM) {
    throw new CouncilError('below-quorum', 'fewer than two council vendors have a usable model', { roster });
  }
  const paths = createWorkspace();
  writeSnapshotDocuments(paths, metaDocument(input, pr, files, 'pending'), files, diffText);
  writeJson(paths.roster, roster);
  writeJson(paths.state, { version: 1, stage: 'prepared', input, created: new Date().toISOString() });
  return { workspace: paths.root, quorum: { members: roster.members.length, required: QUORUM }, roster };
}

/**
 * Materializes the head and base context for members.
 *
 * @param {object} options - Snapshot options.
 * @returns {Promise<object>} Context description.
 */
async function materializeContext({ input, files, paths, context }) {
  for (const name of ['head', 'base', 'ballots']) {
    resetSnapshotDirectory(paths, name);
  }
  log('downloading the pinned repository snapshot');
  const head = await materializeHead({
    input, files, gh: context.gh, root: paths.head, capBytes: context.capBytes,
    reset: () => resetSnapshotDirectory(paths, 'head'),
  });
  if (head.context !== 'full') {
    log(`full snapshot unavailable (${head.reason}); using changed files only`);
  }
  const base = await materializeChangedFiles({ input, files, side: 'base', root: paths.base, gh: context.gh });
  return {
    mode: head.context,
    reason: head.reason,
    detail: head.detail,
    files: head.stats?.files ?? null,
    bytes: head.stats?.bytes ?? null,
    skipped_links: head.stats?.skippedCount ?? 0,
    unavailable: [...head.fetched, ...base].filter((entry) => entry.status !== 'written'),
  };
}

/**
 * Runs Stage 1 for every member in parallel.
 *
 * @param {object} options - Stage options.
 * @returns {Promise<object[]>} Member records with screened reviews.
 */
async function runStageOne({ roster, labels, paths, diffIndex, context }) {
  log(`stage 1: ${roster.members.length} independent reviews`);
  const prompt = buildStage1Prompt();
  const outcomes = await Promise.all(roster.members.map((member) => runMember({
    chain: member.chain, prompt, validate: validateStage1, cwd: paths.snapshot, deadlineMs: context.stage1Ms,
    retries: context.retries, binary: context.copilot, env: context.memberEnv, registry: context.registry,
  })));
  return roster.members.map((member, index) => {
    const label = labels.get(member.vendor);
    const outcome = outcomes[index];
    const screened = outcome.status === 'ok'
      ? screenFindings(outcome.value, label, (finding) => validateCoordinate(diffIndex, finding))
      : null;
    if (outcome.status === 'ok') {
      writeJson(join(paths.stage1, `${label}.json`), outcome.value);
    }
    const { value, ...stage1 } = outcome;
    return { label, vendor: member.vendor, vendorLabel: member.vendorLabel, stage1, summary: value?.summary, screened };
  });
}

/**
 * Runs Stage 2 for every member that completed Stage 1.
 *
 * @param {object} options - Stage options.
 * @returns {Promise<Map<string, {votes: object[], ranking: string[]}>>} Valid ballots by voter label.
 */
async function runStageTwo({ members, paths, context }) {
  const reviews = members.map((member) => ({
    label: member.label, summary: member.summary, findings: member.screened.accepted,
  }));
  const findingIds = reviews.flatMap((review) => review.findings.map((finding) => finding.id));
  const labels = reviews.map((review) => review.label).sort();
  log(`stage 2: ${members.length} anonymous peer reviews of ${findingIds.length} findings`);
  const outcomes = await Promise.all(members.map((member) => {
    const ballotName = `ballot-${randomBytes(8).toString('hex')}.json`;
    writeJson(join(paths.ballots, ballotName), buildBallot(reviews, context.random));
    return runMember({
      chain: [{ id: member.stage1.model, name: member.stage1.name, effort: member.stage1.effort, effortProbe: false }],
      prompt: buildStage2Prompt(`ballots/${ballotName}`),
      validate: (value) => validateStage2(value, findingIds, labels),
      cwd: paths.snapshot, deadlineMs: context.stage2Ms, retries: context.retries,
      binary: context.copilot, env: context.memberEnv, registry: context.registry,
    });
  }));
  const ballots = new Map();
  members.forEach((member, index) => {
    const { value, ...stage2 } = outcomes[index];
    member.stage2 = stage2;
    if (outcomes[index].status === 'ok') {
      ballots.set(member.label, value);
      writeJson(join(paths.stage2, `${member.label}.json`), value);
    }
  });
  return ballots;
}

/**
 * Persists member outcomes and fails when fewer than two members responded.
 *
 * @param {object[]} members - Member records.
 * @param {number} responded - Members that completed the stage.
 * @param {string} stage - Stage name.
 * @param {Record<string, string>} paths - Workspace paths.
 * @returns {void}
 * @throws {CouncilError} kind `below-quorum`.
 */
function requireQuorum(members, responded, stage, paths) {
  writeJson(paths.members, members.map(({ screened, summary, ...member }) => member));
  if (responded < QUORUM) {
    const outcomes = members.map((member) => ({
      vendor: member.vendorLabel, stage1: member.stage1.status, stage2: member.stage2?.status ?? 'not-run',
      error: member.stage2?.error ?? member.stage1.error ?? null,
    }));
    throw new CouncilError('below-quorum', `fewer than two council members completed ${stage}`, { members: outcomes });
  }
}

/**
 * Runs Stages 1 and 2 and writes the anonymized Chairman packet.
 *
 * @param {Record<string, string>} options - Parsed options.
 * @param {object} context - Execution context.
 * @returns {Promise<object>} Run summary with the Chairman packet path.
 */
async function run(options, context) {
  const paths = openWorkspace(options.workspace);
  const state = readJson(paths.state);
  requireStage(state, 'prepared');
  const input = pinnedInputFrom(state);
  const roster = readJson(paths.roster);
  const pr = await fetchPinnedPullRequest(input, context.gh);
  const files = readJson(paths.files);
  const diffIndex = buildDiffIndex(files);
  const snapshotContext = await materializeContext({ input, files, paths, context });
  writeSnapshotDocuments(paths, metaDocument(input, pr, files, snapshotContext.mode), files,
    readFileSync(paths.diff, 'utf8'));
  const labels = assignLabels(roster.members.map((member) => member.vendor), context.random);
  const members = await runStageOne({ roster, labels, paths, diffIndex, context });
  const responding = members.filter((member) => member.stage1.status === 'ok');
  requireQuorum(members, responding.length, 'stage 1', paths);
  const findingCount = responding.reduce((sum, member) => sum + member.screened.accepted.length, 0);
  const ballots = findingCount > 0 ? await runStageTwo({ members: responding, paths, context }) : new Map();
  if (findingCount > 0) {
    requireQuorum(members, ballots.size, 'stage 2', paths);
  }
  writeJson(paths.members, members.map(({ screened, summary, ...member }) => member));
  return deliberate({ members, responding, ballots, paths, state, input, snapshotContext });
}

/**
 * Summarizes member outcomes without anonymous labels.
 *
 * @param {object[]} members - Member records.
 * @returns {object[]} Vendor, model, effort, fallbacks, and stage statuses.
 */
function summarizeMembers(members) {
  return members.map((member) => ({
    vendor: member.vendorLabel,
    model: member.stage1.model ?? null,
    effort: member.stage1.effort ?? null,
    fallbacks_used: fallbacksUsed(member.stage1.attempts),
    stage1: member.stage1.status,
    stage2: member.stage2?.status ?? 'not-run',
  }));
}

/**
 * Applies the agreement rule and writes the analysis and Chairman packet.
 *
 * @param {object} options - Deliberation input.
 * @returns {object} Run summary.
 */
function deliberate({ members, responding, ballots, paths, state, input, snapshotContext }) {
  const findings = responding.flatMap((member) => member.screened.accepted);
  const memberLabels = responding.map((member) => member.label).sort();
  const agreement = computeAgreement({ findings, memberLabels, ballots });
  const leaderboard = computeLeaderboard(ballots, memberLabels);
  const summaries = responding.map((member) => ({ label: member.label, summary: member.summary }));
  const packet = buildChairmanPacket({ findings, agreement, ballots, summaries, leaderboard,
    memberCount: memberLabels.length });
  writeJson(paths.chairmanInput, packet);
  writeJson(paths.analysis, {
    pinned: { head: input.head, base: input.base },
    context: snapshotContext,
    threshold: agreement.threshold,
    members: members.map(({ screened, summary, ...member }) => member),
    findings,
    rejected: responding.flatMap((member) => member.screened.rejected),
    support: Object.fromEntries([...agreement.support].map(([id, set]) => [id, [...set].sort()])),
    ballots: Object.fromEntries(ballots),
    leaderboard,
  });
  writeJson(paths.state, { ...state, stage: 'ran', ran: new Date().toISOString() });
  return {
    workspace: paths.root,
    chairman_input: paths.chairmanInput,
    chairman_output: paths.chairman,
    context: snapshotContext,
    threshold: agreement.threshold,
    members: summarizeMembers(members),
    findings: findings.length,
    agreed: agreement.agreed.size,
    issues_for_chairman: packet.issues.length,
  };
}

/**
 * Reads the Chairman output; it may be absent only when no issue reached agreement.
 *
 * @param {Record<string, string>} paths - Workspace paths.
 * @param {object} packet - Chairman packet.
 * @returns {unknown} Chairman entries.
 * @throws {CouncilError} kinds `chairman-missing` or `chairman-invalid`.
 */
function readChairmanOutput(paths, packet) {
  let text;
  try {
    text = readFileSync(paths.chairman, 'utf8');
  } catch {
    if (packet.issues.length === 0) {
      return [];
    }
    throw new CouncilError('chairman-missing', `write the Chairman output to ${paths.chairman}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CouncilError('chairman-invalid', 'council/chairman.json is not valid JSON', {
      errors: ['malformed JSON'],
    });
  }
}

/**
 * Validates the Chairman output, writes the final report, and deletes the checkout.
 *
 * @param {Record<string, string>} options - Parsed options.
 * @param {object} context - Execution context.
 * @returns {Promise<object>} Final report and its path.
 */
async function finalize(options, context) {
  const paths = openWorkspace(options.workspace);
  const state = readJson(paths.state);
  requireStage(state, 'ran');
  const packet = readJson(paths.chairmanInput);
  const output = readChairmanOutput(paths, packet);
  const errors = validateChairman(output, packet);
  if (errors.length > 0) {
    throw new CouncilError('chairman-invalid', 'the Chairman output violates the council contract', { errors });
  }
  const input = pinnedInputFrom(state);
  await fetchPinnedPullRequest(input, context.gh);
  const analysis = readJson(paths.analysis);
  const report = composeFinalReport({ output, packet, analysis, headSha: input.head });
  writeJson(paths.final, report);
  removeSnapshot(paths);
  writeJson(paths.state, { ...state, stage: 'finalized', finalized: new Date().toISOString() });
  return { report_path: paths.final, ...report };
}

/**
 * Deletes the checkout (default) or the whole verified workspace (`--all`).
 *
 * @param {Record<string, string>} options - Parsed options.
 * @param {object} _context - Unused.
 * @param {Set<string>} flags - Parsed flags.
 * @returns {object} Removed and kept paths.
 */
function cleanup(options, _context, flags) {
  const paths = openWorkspace(options.workspace);
  if (flags.has('all')) {
    removeWorkspace(paths);
    return { removed: paths.root };
  }
  removeSnapshot(paths);
  return { removed: paths.snapshot, kept: paths.council };
}

const COMMANDS = new Map([['prepare', prepare], ['run', run], ['finalize', finalize], ['cleanup', cleanup]]);

/**
 * Executes one CLI invocation.
 *
 * @param {string[]} argv - Arguments after the script path.
 * @param {NodeJS.ProcessEnv} [environment] - Environment.
 * @param {ProcessRegistry} [registry] - Process registry.
 * @returns {Promise<{code: number, envelope: object}>} Exit code and JSON envelope.
 */
export async function main(argv, environment = process.env, registry = new ProcessRegistry()) {
  try {
    const { command, options, flags } = parseArguments(argv);
    const value = await COMMANDS.get(command)(options, createContext(environment, registry), flags);
    return { code: 0, envelope: { ok: true, value } };
  } catch (error) {
    const kind = error instanceof CouncilError ? error.kind : 'internal';
    const details = error instanceof CouncilError && error.details ? { details: error.details } : {};
    return { code: exitCodeFor(kind), envelope: { ok: false, error: { kind, message: bounded(error.message, 1000),
      ...details } } };
  }
}

/**
 * Tests whether this module is the process entry point, following symlinks.
 *
 * @returns {boolean} True when executed directly.
 */
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const registry = new ProcessRegistry();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      registry.killAll('SIGTERM');
      process.stdout.write(`${JSON.stringify({ ok: false, error: { kind: 'interrupted', message: signal } })}\n`);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
  const { code, envelope } = await main(process.argv.slice(2), process.env, registry);
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  process.exitCode = code;
}
