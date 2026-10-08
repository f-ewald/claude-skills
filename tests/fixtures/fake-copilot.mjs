#!/usr/bin/env node

/**
 * Offline stand-in for the GitHub Copilot CLI used by the pr-review council tests.
 *
 * Modes, selected by argv:
 * - `help config`: prints a config help excerpt listing `scenario.catalog`.
 * - `--headless ... --stdio`: Content-Length JSON-RPC server answering `ping` and
 *   `models.list` from `scenario.modelsList` (`scenario.rpcFail` exits immediately).
 * - `-p PROMPT --model ID ...`: a council member. `scenario.members[ID]` controls
 *   availability (`unavailable`), supported efforts (`efforts`), missing effort
 *   configuration (`noEffort`), and per-stage behavior (`stage1`, `stage2`).
 *   Stage 2 votes `agree` when a finding title contains one of `agreeTitles`,
 *   marks `duplicateTitles` pairs, and ranks labels alphabetically.
 *
 * The scenario JSON path comes from FAKE_COPILOT_SCENARIO. Each invocation is
 * appended to FAKE_COPILOT_CALLS as `{argv, allowAll}` JSON.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OPEN = '<<<PR_REVIEW_COUNCIL_JSON>>>';
const CLOSE = '<<<PR_REVIEW_COUNCIL_END>>>';
const scenario = JSON.parse(readFileSync(process.env.FAKE_COPILOT_SCENARIO, 'utf8'));
const argv = process.argv.slice(2);

if (process.env.FAKE_COPILOT_CALLS) {
  const allowAll = Object.hasOwn(process.env, 'COPILOT_ALLOW_ALL');
  appendFileSync(process.env.FAKE_COPILOT_CALLS, `${JSON.stringify({ argv, allowAll })}\n`);
}

/**
 * Reads the value following a flag.
 *
 * @param {string} flag - Flag name.
 * @returns {string|undefined} Value.
 */
function option(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/**
 * Prints the `copilot help config` model list.
 *
 * @returns {void}
 */
function helpConfig() {
  const lines = ['Configuration Settings:', '', '  `model`: AI model to use for Copilot CLI.'];
  for (const id of scenario.catalog ?? []) {
    lines.push(`    - "${id}"`);
  }
  lines.push('', '  `theme`: color theme.');
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * Serves ping and models.list over Content-Length framed stdio.
 *
 * @returns {void}
 */
function headless() {
  if (scenario.rpcFail) {
    process.exit(3);
  }
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
      if (buffer.length < headerEnd + 4 + length) {
        return;
      }
      const request = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
      buffer = buffer.subarray(headerEnd + 4 + length);
      const result = request.method === 'ping'
        ? { message: 'pong', protocolVersion: 3 }
        : { models: scenario.modelsList ?? [] };
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
      process.stdout.write(body);
    }
  });
}

/**
 * Prints a member response wrapped in council markers after a preamble.
 *
 * @param {unknown} value - Response JSON.
 * @returns {void}
 */
function respond(value) {
  process.stdout.write(`Reviewing the snapshot now.\n${OPEN}\n${JSON.stringify(value)}\n${CLOSE}\n`);
}

/**
 * Builds Stage 2 votes for a ballot.
 *
 * @param {object} behavior - Member stage 2 behavior.
 * @param {string} cwd - Snapshot directory.
 * @param {string} prompt - Stage 2 prompt.
 * @returns {object} Ballot response.
 */
function vote(behavior, cwd, prompt) {
  const ballotPath = /ballots\/ballot-[0-9a-f]+\.json/.exec(prompt)[0];
  const ballot = JSON.parse(readFileSync(join(cwd, ballotPath), 'utf8'));
  const findings = ballot.reviewers.flatMap((reviewer) => reviewer.findings);
  const agreeTitles = behavior.agreeTitles ?? [];
  const pairs = behavior.duplicateTitles ?? [];
  const votes = findings.map((finding) => {
    const agree = agreeTitles.some((token) => finding.title.includes(token));
    const pair = pairs.find(([from]) => finding.title.includes(from));
    const duplicate = pair ? findings.find((other) => other.title.includes(pair[1])) : null;
    return {
      finding: finding.id,
      verdict: agree ? 'agree' : 'disagree',
      severity: agree ? finding.severity : null,
      duplicate_of: duplicate && duplicate.id !== finding.id ? duplicate.id : null,
      reason: agree ? 'Verified in head/.' : 'Not supported by the snapshot.',
    };
  });
  return { votes, ranking: ballot.reviewers.map((reviewer) => reviewer.label).sort() };
}

/**
 * Emulates one council member invocation.
 *
 * @returns {Promise<void>}
 */
async function member() {
  const model = option('--model');
  const effort = option('--reasoning-effort');
  const config = scenario.members?.[model];
  if (!config || config.unavailable) {
    process.stderr.write(`Error: Model "${model}" from --model flag is not available.\n`);
    process.exit(1);
  }
  if (effort && config.noEffort) {
    process.stderr.write(
      `Error: Model "${model}" does not support reasoning effort configuration (requested: "${effort}").\n`,
    );
    process.exit(1);
  }
  if (effort && config.efforts && !config.efforts.includes(effort)) {
    process.stderr.write(`Error: Reasoning effort "${effort}" is not supported for model "${model}".\n`);
    process.exit(1);
  }
  const prompt = option('-p');
  const stage = prompt.includes('Council stage: 2') ? 'stage2' : 'stage1';
  const behavior = config[stage] ?? {};
  if (behavior.delayMs) {
    await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
  }
  if (behavior.exitCode) {
    process.stderr.write('simulated failure\n');
    process.exit(behavior.exitCode);
  }
  if (behavior.raw !== undefined) {
    process.stdout.write(behavior.raw);
    return;
  }
  respond(stage === 'stage1'
    ? { summary: behavior.summary ?? `Review by ${model}.`, findings: behavior.findings ?? [] }
    : vote(behavior, option('-C'), prompt));
}

if (argv[0] === 'help' && argv[1] === 'config') {
  helpConfig();
} else if (argv.includes('--headless')) {
  headless();
} else if (argv.includes('-p')) {
  await member();
} else {
  process.stderr.write(`unsupported fake copilot invocation: ${argv.join(' ')}\n`);
  process.exit(2);
}
