/**
 * Verifies council payload validation, agreement math, leaderboard, and the
 * Chairman contract.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assignLabels,
  buildChairmanPacket,
  computeAgreement,
  computeLeaderboard,
  createRandom,
  screenFindings,
  validateChairman,
  validateStage1,
  validateStage2,
} from '../skills/pr-review/scripts/lib/consensus.mjs';
import { REVIEW_RUBRIC, buildStage1Prompt, buildStage2Prompt } from '../skills/pr-review/scripts/lib/prompts.mjs';
import { CLOSE_MARKER, OPEN_MARKER } from '../skills/pr-review/scripts/lib/runner.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Builds a valid Stage 1 finding.
 *
 * @param {object} [overrides] - Field overrides.
 * @returns {object} Finding.
 */
function finding(overrides = {}) {
  return {
    path: 'src/app.js', side: 'RIGHT', line: 2, start_line: null, severity: 'Major', title: 'Bug',
    description: 'Breaks.', body: 'Fix it.', suggestion: null, evidence: 'head/src/app.js', ...overrides,
  };
}

/**
 * Builds a vote.
 *
 * @param {string} id - Finding ID.
 * @param {string} verdict - Verdict.
 * @param {string|null} [duplicateOf] - Duplicate link.
 * @returns {object} Vote.
 */
function vote(id, verdict, duplicateOf = null) {
  const severity = verdict === 'agree' ? 'Major' : null;
  return { finding: id, verdict, severity, duplicate_of: duplicateOf, reason: 'r' };
}

test('validates Stage 1 reviews and screens coordinates and fenced suggestions', () => {
  const review = validateStage1({ summary: 'ok', findings: [finding(), finding({ line: 99, suggestion: '```x' })] });
  const screened = screenFindings(
    { findings: [...review.findings, finding({ suggestion: 'x\n```\ny' })] },
    'B',
    (candidate) => (candidate.line === 99 ? 'not in diff' : null),
  );
  assert.deepEqual(screened.accepted.map((entry) => [entry.id, entry.author, entry.suggestion]), [
    ['B1', 'B', null],
    ['B2', 'B', null],
  ]);
  assert.deepEqual(screened.rejected, [
    { author: 'B', reason: 'not in diff', path: 'src/app.js', side: 'RIGHT', line: 99 },
  ]);
  const invalid = [
    { findings: [] },
    { summary: 'ok', findings: [finding({ side: 'BOTH' })] },
    { summary: 'ok', findings: [finding({ line: 0 })] },
    { summary: 'ok', findings: [finding({ body: 'x'.repeat(4001) })] },
    { summary: 'ok', findings: Array.from({ length: 51 }, () => finding()) },
  ];
  for (const value of invalid) {
    assert.throws(() => validateStage1(value), { kind: 'member-output' });
  }
});

test('validates complete Stage 2 ballots', () => {
  const ids = ['A1', 'B1'];
  const labels = ['A', 'B'];
  const ranking = ['B', 'A'];
  const valid = validateStage2({ votes: [vote('B1', 'agree'), vote('A1', 'unsure', 'B1')], ranking }, ids, labels);
  assert.deepEqual(valid.votes.map((entry) => entry.finding), ids);
  const invalid = [
    { votes: [vote('A1', 'agree')], ranking },
    { votes: [vote('A1', 'agree'), vote('A1', 'agree'), vote('B1', 'agree')], ranking },
    { votes: [vote('A1', 'agree', 'A1'), vote('B1', 'agree')], ranking },
    { votes: [vote('A1', 'maybe'), vote('B1', 'agree')], ranking },
    { votes: [vote('A1', 'agree'), vote('B1', 'agree')], ranking: ['A'] },
    { votes: [vote('A1', 'agree'), vote('B1', 'agree')], ranking: ['A', 'A'] },
  ];
  for (const value of invalid) {
    assert.throws(() => validateStage2(value, ids, labels), { kind: 'member-output' }, JSON.stringify(value));
  }
});

test('flags a finding only when a strict majority supports it', () => {
  const findings = [
    { id: 'A1', author: 'A' },
    { id: 'A2', author: 'A' },
    { id: 'B1', author: 'B' },
    { id: 'C1', author: 'C' },
  ];
  const ballots = new Map([
    ['A', { votes: [vote('A1', 'agree'), vote('A2', 'agree'), vote('B1', 'agree'), vote('C1', 'unsure')] }],
    ['B', { votes: [vote('A1', 'agree'), vote('A2', 'disagree'), vote('B1', 'agree'), vote('C1', 'disagree')] }],
    ['C', { votes: [vote('A1', 'disagree'), vote('A2', 'disagree'), vote('B1', 'disagree', 'C1'),
      vote('C1', 'agree')] }],
  ]);
  const agreement = computeAgreement({ findings, memberLabels: ['A', 'B', 'C'], ballots });
  assert.equal(agreement.threshold, 2);
  assert.deepEqual(Object.fromEntries([...agreement.support].map(([id, set]) => [id, [...set].sort()])), {
    A1: ['A', 'B'],
    A2: ['A'],
    B1: ['A', 'B', 'C'],
    C1: ['C'],
  });
  assert.deepEqual([...agreement.agreed].sort(), ['A1', 'B1']);
  assert.deepEqual(agreement.clusters, [['A1'], ['A2'], ['B1', 'C1']]);
  const pair = computeAgreement({
    findings: [{ id: 'A1', author: 'A' }],
    memberLabels: ['A', 'B'],
    ballots: new Map([['B', { votes: [vote('A1', 'unsure')] }]]),
  });
  assert.deepEqual([pair.threshold, pair.agreed.size], [2, 0]);
});

test('ranks members by average position, ignoring self-rankings', () => {
  const ballots = new Map([
    ['A', { ranking: ['A', 'B', 'C'] }],
    ['B', { ranking: ['A', 'C', 'B'] }],
    ['C', { ranking: ['C', 'A', 'B'] }],
  ]);
  assert.deepEqual(computeLeaderboard(ballots, ['A', 'B', 'C']), [
    { label: 'A', average_rank: 1, rankings: 2 },
    { label: 'B', average_rank: 1.5, rankings: 2 },
    { label: 'C', average_rank: 2, rankings: 2 },
  ]);
});

test('accepts only Chairman output anchored on agreed findings', () => {
  const findings = ['A1', 'B1', 'C1', 'C2'].map((id) => ({ ...finding(), id, author: id[0] }));
  const ballots = new Map([
    ['A', { votes: [vote('A1', 'agree'), vote('B1', 'agree'), vote('C1', 'disagree', 'B1'), vote('C2', 'disagree')] }],
    ['B', { votes: [vote('A1', 'agree'), vote('B1', 'agree'), vote('C1', 'disagree'), vote('C2', 'disagree')] }],
    ['C', { votes: [vote('A1', 'disagree'), vote('B1', 'disagree'), vote('C1', 'agree'), vote('C2', 'agree')] }],
  ]);
  const agreement = computeAgreement({ findings, memberLabels: ['A', 'B', 'C'], ballots });
  const packet = buildChairmanPacket({ findings, agreement, ballots, summaries: [], leaderboard: [], memberCount: 3 });
  assert.deepEqual(packet.issues.map((issue) => issue.findings.map((entry) => [entry.id, entry.agreed])),
    [[['A1', true]], [['B1', true], ['C1', false]]]);
  const entry = (covers, overrides = {}) => ({
    covers, coordinate_from: covers[0], severity: 'Major', severity_reason: 'Confirmed.',
    description: 'Breaks.', body: 'Fix.', suggestion: null, ...overrides,
  });
  assert.deepEqual(validateChairman([entry(['A1']), entry(['B1', 'C1'])], packet), []);
  const cases = [
    [{}, /must be a JSON array/],
    [[entry(['A1'])], /B1 is not covered/],
    [[entry(['A1']), entry(['B1']), entry(['B1'])], /B1 is covered more than once/],
    [[entry(['A1', 'C2']), entry(['B1'])], /C2 was not sent/],
    [[entry(['A1', 'C1']), entry(['B1'])], /C1 belongs to a different issue/],
    [[entry(['A1']), entry(['C1', 'B1'])], /coordinate_from must be one of the entry's agreed findings/],
    [[entry(['A1']), entry(['B1']), entry(['C1'])], /must cover at least one agreed finding/],
    [[entry(['A1'], { severity: 'Critical' }), entry(['B1'])], /severity must be Major or Minor/],
    [[entry(['A1'], { severity_reason: ' ' }), entry(['B1'])], /severity_reason/],
    [[entry(['A1'], { suggestion: '```js\nx\n```' }), entry(['B1'])], /suggestion must be null or text without code/],
  ];
  for (const [output, expected] of cases) {
    assert.match(validateChairman(output, packet).join('\n'), expected);
  }
});

test('anonymizes deterministically under a seed and keeps prompts aligned with SKILL.md', () => {
  const first = assignLabels(['anthropic', 'openai', 'google'], createRandom(7));
  const second = assignLabels(['anthropic', 'openai', 'google'], createRandom(7));
  assert.deepEqual([...first], [...second]);
  assert.deepEqual([...first.values()].sort(), ['A', 'B', 'C']);
  const skill = readFileSync(join(ROOT, 'skills', 'pr-review', 'SKILL.md'), 'utf8');
  for (const line of REVIEW_RUBRIC) {
    assert.ok(skill.includes(line), `SKILL.md must contain the rubric line: ${line}`);
  }
  for (const prompt of [buildStage1Prompt(), buildStage2Prompt('ballots/ballot-00.json')]) {
    assert.match(prompt, /untrusted data/);
    assert.ok(prompt.includes(OPEN_MARKER) && prompt.includes(CLOSE_MARKER));
  }
});
