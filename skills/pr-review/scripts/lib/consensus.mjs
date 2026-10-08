/**
 * Council consensus: payload validation, anonymization, agreement math,
 * leaderboard, Chairman packet, Chairman validation, and the final report.
 *
 * Agreement is decided here, in code. A member supports a finding when it
 * authored it, voted "agree" on it, or linked it as a duplicate of a finding
 * it authored itself. Self-votes and self-rankings are ignored.
 */

import { randomInt } from 'node:crypto';

import { CouncilError } from './errors.mjs';
import { CHAIRMAN_INSTRUCTIONS, LIMITS } from './prompts.mjs';

const SIDES = Object.freeze(['RIGHT', 'LEFT']);
const SEVERITIES = Object.freeze(['Major', 'Minor']);
const VERDICTS = Object.freeze(['agree', 'disagree', 'unsure']);
const LABEL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Creates a random source; a numeric seed makes it deterministic (tests only).
 *
 * @param {number|undefined} seed - Optional 32-bit seed.
 * @returns {() => number} Function returning floats in [0, 1).
 */
export function createRandom(seed) {
  if (!Number.isInteger(seed)) {
    return () => randomInt(0, 2 ** 32) / 2 ** 32;
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
  };
}

/**
 * Returns a shuffled copy (Fisher-Yates).
 *
 * @param {unknown[]} items - Items.
 * @param {() => number} random - Random source.
 * @returns {unknown[]} Shuffled copy.
 */
export function shuffle(items, random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

/**
 * Assigns random anonymous labels (A, B, C, ...) to member keys.
 *
 * @param {string[]} keys - Member keys.
 * @param {() => number} random - Random source.
 * @returns {Map<string, string>} Key to label.
 */
export function assignLabels(keys, random) {
  const labels = shuffle([...LABEL_ALPHABET.slice(0, keys.length)], random);
  return new Map(keys.map((key, index) => [key, labels[index]]));
}

/**
 * Throws a member-output validation error.
 *
 * @param {string} where - Field location.
 * @param {string} message - Problem.
 * @returns {never}
 */
function invalid(where, message) {
  throw new CouncilError('member-output', `${where} ${message}`);
}

/**
 * Requires a non-empty string within a length limit.
 *
 * @param {unknown} value - Candidate.
 * @param {string} where - Field location.
 * @param {number} limit - Maximum length.
 * @returns {string} The string.
 */
function requireText(value, where, limit) {
  if (typeof value !== 'string' || value.trim() === '') {
    invalid(where, 'must be a non-empty string');
  }
  if (value.length > limit) {
    invalid(where, `must be at most ${limit} characters`);
  }
  return value;
}

/**
 * Accepts null/undefined or a bounded non-empty string.
 *
 * @param {unknown} value - Candidate.
 * @param {string} where - Field location.
 * @param {number} limit - Maximum length.
 * @returns {string|null} The string or null.
 */
function optionalText(value, where, limit) {
  return value === null || value === undefined ? null : requireText(value, where, limit);
}

/**
 * Requires one of the allowed values.
 *
 * @param {unknown} value - Candidate.
 * @param {readonly unknown[]} allowed - Allowed values.
 * @param {string} where - Field location.
 * @returns {unknown} The value.
 */
function requireOneOf(value, allowed, where) {
  if (!allowed.includes(value)) {
    invalid(where, `must be one of ${allowed.join(', ')}`);
  }
  return value;
}

/**
 * Requires a positive integer.
 *
 * @param {unknown} value - Candidate.
 * @param {string} where - Field location.
 * @returns {number} The integer.
 */
function requireLine(value, where) {
  if (!Number.isInteger(value) || value < 1) {
    invalid(where, 'must be a positive integer');
  }
  return value;
}

/**
 * Requires a plain object.
 *
 * @param {unknown} value - Candidate.
 * @param {string} where - Field location.
 * @returns {void}
 */
function requireObject(value, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(where, 'must be an object');
  }
}

/**
 * Validates and normalizes a Stage 1 review.
 *
 * @param {unknown} value - Parsed member JSON.
 * @returns {{summary: string, findings: object[]}} Normalized review.
 * @throws {CouncilError} kind `member-output` on any schema violation.
 */
export function validateStage1(value) {
  requireObject(value, 'review');
  const summary = requireText(value.summary, 'summary', LIMITS.maxSummary);
  if (!Array.isArray(value.findings)) {
    invalid('findings', 'must be an array');
  }
  if (value.findings.length > LIMITS.maxFindings) {
    invalid('findings', `must contain at most ${LIMITS.maxFindings} entries`);
  }
  return { summary, findings: value.findings.map((finding, index) => normalizeFinding(finding, `findings[${index}]`)) };
}

/**
 * Normalizes one Stage 1 finding.
 *
 * @param {unknown} finding - Raw finding.
 * @param {string} where - Field location.
 * @returns {object} Normalized finding.
 */
function normalizeFinding(finding, where) {
  requireObject(finding, where);
  const startLine = finding.start_line === null || finding.start_line === undefined
    ? null
    : requireLine(finding.start_line, `${where}.start_line`);
  return {
    path: requireText(finding.path, `${where}.path`, LIMITS.maxPath),
    side: requireOneOf(finding.side, SIDES, `${where}.side`),
    line: requireLine(finding.line, `${where}.line`),
    start_line: startLine,
    severity: requireOneOf(finding.severity, SEVERITIES, `${where}.severity`),
    title: requireText(finding.title, `${where}.title`, LIMITS.maxTitle),
    description: requireText(finding.description, `${where}.description`, LIMITS.maxText),
    body: requireText(finding.body, `${where}.body`, LIMITS.maxBody),
    suggestion: optionalText(finding.suggestion, `${where}.suggestion`, LIMITS.maxBody),
    evidence: optionalText(finding.evidence, `${where}.evidence`, LIMITS.maxText) ?? '',
  };
}

/**
 * Assigns IDs to a member's findings and drops those whose coordinates are not
 * in the pinned diff. A fenced suggestion is removed rather than trusted.
 *
 * @param {{findings: object[]}} review - Normalized review.
 * @param {string} label - Author's anonymous label.
 * @param {(coordinate: object) => string|null} checkCoordinate - Returns a rejection reason or null.
 * @returns {{accepted: object[], rejected: object[]}} Screened findings.
 */
export function screenFindings(review, label, checkCoordinate) {
  const accepted = [];
  const rejected = [];
  for (const finding of review.findings) {
    const reason = checkCoordinate(finding);
    if (reason) {
      rejected.push({ author: label, reason, path: finding.path, side: finding.side, line: finding.line });
      continue;
    }
    const suggestion = finding.suggestion?.includes('```') ? null : finding.suggestion;
    accepted.push({ ...finding, suggestion, id: `${label}${accepted.length + 1}`, author: label });
  }
  return { accepted, rejected };
}

/**
 * Builds one voter's ballot with reviewers in random order.
 *
 * @param {{label: string, summary: string, findings: object[]}[]} reviews - Screened reviews.
 * @param {() => number} random - Random source.
 * @returns {{reviewers: object[]}} Ballot document.
 */
export function buildBallot(reviews, random) {
  return {
    reviewers: shuffle(reviews, random).map((review) => ({
      label: review.label,
      summary: review.summary,
      findings: review.findings.map((finding) => ballotFinding(finding)),
    })),
  };
}

/**
 * Projects a finding onto the fields voters see.
 *
 * @param {object} finding - Screened finding.
 * @returns {object} Ballot entry.
 */
function ballotFinding(finding) {
  return {
    id: finding.id,
    path: finding.path,
    side: finding.side,
    line: finding.line,
    start_line: finding.start_line,
    severity: finding.severity,
    title: finding.title,
    description: finding.description,
    body: finding.body,
    suggestion: finding.suggestion,
    evidence: finding.evidence,
  };
}

/**
 * Validates a Stage 2 ballot response.
 *
 * @param {unknown} value - Parsed member JSON.
 * @param {string[]} findingIds - Every ballot finding ID.
 * @param {string[]} labels - Every reviewer label.
 * @returns {{votes: object[], ranking: string[]}} Normalized ballot response.
 * @throws {CouncilError} kind `member-output` on any violation.
 */
export function validateStage2(value, findingIds, labels) {
  requireObject(value, 'ballot');
  if (!Array.isArray(value.votes)) {
    invalid('votes', 'must be an array');
  }
  const known = new Set(findingIds);
  const votes = new Map();
  value.votes.forEach((vote, index) => {
    const normalized = normalizeVote(vote, `votes[${index}]`, known);
    if (votes.has(normalized.finding)) {
      invalid(`votes[${index}]`, `repeats finding ${normalized.finding}`);
    }
    votes.set(normalized.finding, normalized);
  });
  const missing = findingIds.filter((id) => !votes.has(id));
  if (missing.length > 0) {
    invalid('votes', `are missing for ${missing.slice(0, 10).join(', ')}`);
  }
  return { votes: findingIds.map((id) => votes.get(id)), ranking: normalizeRanking(value.ranking, labels) };
}

/**
 * Normalizes one vote.
 *
 * @param {unknown} vote - Raw vote.
 * @param {string} where - Field location.
 * @param {Set<string>} known - Known finding IDs.
 * @returns {object} Normalized vote.
 */
function normalizeVote(vote, where, known) {
  requireObject(vote, where);
  const finding = requireOneOf(vote.finding, [...known], `${where}.finding`);
  const duplicateOf = vote.duplicate_of === null || vote.duplicate_of === undefined ? null : vote.duplicate_of;
  if (duplicateOf !== null && (!known.has(duplicateOf) || duplicateOf === finding)) {
    invalid(`${where}.duplicate_of`, 'must be another ballot finding ID or null');
  }
  const severity = vote.severity === null || vote.severity === undefined ? null : vote.severity;
  return {
    finding,
    verdict: requireOneOf(vote.verdict, VERDICTS, `${where}.verdict`),
    severity: severity === null ? null : requireOneOf(severity, SEVERITIES, `${where}.severity`),
    duplicate_of: duplicateOf,
    reason: requireText(vote.reason, `${where}.reason`, LIMITS.maxReason),
  };
}

/**
 * Requires a ranking that is a permutation of the reviewer labels.
 *
 * @param {unknown} ranking - Raw ranking.
 * @param {string[]} labels - Reviewer labels.
 * @returns {string[]} Ranking, best first.
 */
function normalizeRanking(ranking, labels) {
  const valid = Array.isArray(ranking) && ranking.length === labels.length
    && new Set(ranking).size === labels.length && ranking.every((label) => labels.includes(label));
  if (!valid) {
    invalid('ranking', `must list each of ${labels.join(', ')} exactly once`);
  }
  return ranking;
}

/**
 * Computes support, agreement, and duplicate clusters.
 *
 * @param {object} input - Agreement input.
 * @param {object[]} input.findings - Screened findings with `id` and `author`.
 * @param {string[]} input.memberLabels - Labels of members with valid Stage 1 output.
 * @param {Map<string, {votes: object[]}>} input.ballots - Voter label to validated ballot.
 * @returns {{threshold: number, support: Map<string, Set<string>>, agreed: Set<string>, clusters: string[][]}}
 *   Agreement result.
 */
export function computeAgreement({ findings, memberLabels, ballots }) {
  const threshold = Math.floor(memberLabels.length / 2) + 1;
  const authorOf = new Map(findings.map((finding) => [finding.id, finding.author]));
  const support = new Map(findings.map((finding) => [finding.id, new Set([finding.author])]));
  for (const [voter, ballot] of ballots) {
    for (const vote of ballot.votes) {
      addSupport(vote, voter, authorOf, support);
    }
  }
  const agreed = new Set(findings.filter((finding) => support.get(finding.id).size >= threshold)
    .map((finding) => finding.id));
  return { threshold, support, agreed, clusters: clusterFindings(findings, ballots) };
}

/**
 * Adds the support one vote expresses.
 *
 * @param {object} vote - Normalized vote.
 * @param {string} voter - Voter label.
 * @param {Map<string, string>} authorOf - Finding ID to author label.
 * @param {Map<string, Set<string>>} support - Mutable support sets.
 * @returns {void}
 */
function addSupport(vote, voter, authorOf, support) {
  const author = authorOf.get(vote.finding);
  if (author !== voter && vote.verdict === 'agree') {
    support.get(vote.finding).add(voter);
  }
  if (vote.duplicate_of === null) {
    return;
  }
  const otherAuthor = authorOf.get(vote.duplicate_of);
  if (otherAuthor === voter && author !== voter) {
    support.get(vote.finding).add(voter);
  }
  if (author === voter && otherAuthor !== voter) {
    support.get(vote.duplicate_of).add(voter);
  }
}

/**
 * Groups findings connected by any duplicate link (union-find).
 *
 * @param {object[]} findings - Screened findings.
 * @param {Map<string, {votes: object[]}>} ballots - Validated ballots.
 * @returns {string[][]} Clusters in finding order.
 */
function clusterFindings(findings, ballots) {
  const parent = new Map(findings.map((finding) => [finding.id, finding.id]));
  const root = (id) => {
    let current = id;
    while (parent.get(current) !== current) {
      current = parent.get(current);
    }
    return current;
  };
  for (const ballot of ballots.values()) {
    for (const vote of ballot.votes.filter((entry) => entry.duplicate_of !== null)) {
      parent.set(root(vote.finding), root(vote.duplicate_of));
    }
  }
  const clusters = new Map();
  for (const finding of findings) {
    const key = root(finding.id);
    clusters.set(key, [...(clusters.get(key) ?? []), finding.id]);
  }
  return [...clusters.values()];
}

/**
 * Averages each member's rank position across the other voters' rankings.
 *
 * @param {Map<string, {ranking: string[]}>} ballots - Validated ballots.
 * @param {string[]} memberLabels - Ranked labels.
 * @returns {{label: string, average_rank: number|null, rankings: number}[]} Best first.
 */
export function computeLeaderboard(ballots, memberLabels) {
  const positions = new Map(memberLabels.map((label) => [label, []]));
  for (const [voter, ballot] of ballots) {
    ballot.ranking.filter((label) => label !== voter)
      .forEach((label, index) => positions.get(label).push(index + 1));
  }
  const board = memberLabels.map((label) => {
    const ranks = positions.get(label);
    const average = ranks.length ? ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length : null;
    return { label, average_rank: average === null ? null : Math.round(average * 100) / 100, rankings: ranks.length };
  });
  return board.sort((left, right) => (left.average_rank ?? Infinity) - (right.average_rank ?? Infinity)
    || left.label.localeCompare(right.label));
}

/**
 * Builds the anonymized Chairman packet containing only issues with agreement.
 *
 * @param {object} input - Packet input.
 * @param {object[]} input.findings - Screened findings.
 * @param {object} input.agreement - Result of computeAgreement.
 * @param {Map<string, {votes: object[]}>} input.ballots - Validated ballots.
 * @param {{label: string, summary: string}[]} input.summaries - Member summaries.
 * @param {object[]} input.leaderboard - Result of computeLeaderboard.
 * @param {number} input.memberCount - Members with valid Stage 1 output.
 * @returns {object} Chairman packet.
 */
export function buildChairmanPacket({ findings, agreement, ballots, summaries, leaderboard, memberCount }) {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const issues = agreement.clusters
    .filter((cluster) => cluster.some((id) => agreement.agreed.has(id)))
    .map((cluster, index) => ({
      issue: `I${index + 1}`,
      findings: cluster.map((id) => packetFinding(byId.get(id), agreement, ballots)),
    }));
  return {
    version: 1,
    threshold: agreement.threshold,
    members: memberCount,
    voters: ballots.size,
    instructions: CHAIRMAN_INSTRUCTIONS,
    output_example: [{
      covers: ['A1', 'B2'], coordinate_from: 'A1', severity: 'Major', severity_reason: 'Why this severity.',
      description: 'One sentence.', body: 'Review comment.', suggestion: null,
    }],
    issues,
    summaries,
    leaderboard,
  };
}

/**
 * Projects one finding with its support and non-self votes.
 *
 * @param {object} finding - Screened finding.
 * @param {object} agreement - Agreement result.
 * @param {Map<string, {votes: object[]}>} ballots - Validated ballots.
 * @returns {object} Packet finding.
 */
function packetFinding(finding, agreement, ballots) {
  return {
    ...ballotFinding(finding),
    author: finding.author,
    agreed: agreement.agreed.has(finding.id),
    support: [...agreement.support.get(finding.id)].sort(),
    votes: votesFor(finding, ballots),
  };
}

/**
 * Lists the votes other members cast on a finding.
 *
 * @param {object} finding - Screened finding.
 * @param {Map<string, {votes: object[]}>} ballots - Validated ballots.
 * @returns {object[]} Votes with voter labels.
 */
export function votesFor(finding, ballots) {
  return [...ballots]
    .filter(([voter]) => voter !== finding.author)
    .map(([voter, ballot]) => ({ voter, ...ballot.votes.find((vote) => vote.finding === finding.id) }))
    .map(({ voter, verdict, severity, duplicate_of: duplicateOf, reason }) => ({
      voter, verdict, severity, duplicate_of: duplicateOf, reason,
    }));
}

/**
 * Validates the Chairman's output against the packet.
 *
 * @param {unknown} output - Parsed council/chairman.json.
 * @param {object} packet - Chairman packet.
 * @returns {string[]} Every violation; empty when valid.
 */
export function validateChairman(output, packet) {
  if (!Array.isArray(output)) {
    return ['chairman output must be a JSON array'];
  }
  const sent = new Map(packet.issues.flatMap((issue) => issue.findings
    .map((finding) => [finding.id, { ...finding, issue: issue.issue }])));
  const covered = new Set();
  const errors = output.flatMap((entry, index) => entryErrors(entry, `entry ${index + 1}`, sent, covered));
  for (const [id, finding] of sent) {
    if (finding.agreed && !covered.has(id)) {
      errors.push(`agreed finding ${id} is not covered`);
    }
  }
  return errors;
}

/**
 * Lists the violations of one Chairman entry and records its coverage.
 *
 * @param {unknown} entry - Raw entry.
 * @param {string} where - Location label.
 * @param {Map<string, object>} sent - Findings sent to the Chairman, with their issue.
 * @param {Set<string>} covered - Mutable set of covered IDs.
 * @returns {string[]} Violations.
 */
function entryErrors(entry, where, sent, covered) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return [`${where} must be an object`];
  }
  if (!Array.isArray(entry.covers) || entry.covers.length === 0) {
    return [`${where}: covers must be a non-empty array`];
  }
  const errors = [...coverErrors(entry, where, sent, covered), ...agreementErrors(entry, where, sent)];
  const checks = [
    [SEVERITIES.includes(entry.severity), 'severity must be Major or Minor'],
    [isText(entry.severity_reason, LIMITS.maxReason), 'severity_reason must be a non-empty string'],
    [isText(entry.description, LIMITS.maxText), 'description must be a non-empty string'],
    [isText(entry.body, LIMITS.maxBody), `body must be a non-empty string of at most ${LIMITS.maxBody} characters`],
    [entry.suggestion === null || entry.suggestion === undefined
      || (isText(entry.suggestion, LIMITS.maxBody) && !entry.suggestion.includes('```')),
    'suggestion must be null or text without code fences'],
  ];
  return [...errors, ...checks.filter(([ok]) => !ok).map(([, message]) => `${where}: ${message}`)];
}

/**
 * Validates that every cover was sent and is covered only once.
 *
 * @param {object} entry - Entry with a covers array.
 * @param {string} where - Location label.
 * @param {Map<string, object>} sent - Findings sent to the Chairman.
 * @param {Set<string>} covered - Mutable set of covered IDs.
 * @returns {string[]} Violations.
 */
function coverErrors(entry, where, sent, covered) {
  const errors = [];
  for (const id of entry.covers) {
    if (!sent.has(id)) {
      errors.push(`${where}: ${String(id).slice(0, 20)} was not sent to the Chairman`);
    } else if (covered.has(id)) {
      errors.push(`${where}: ${id} is covered more than once`);
    }
    covered.add(id);
  }
  return errors;
}

/**
 * Validates that an entry is anchored on agreement: it covers an agreed
 * finding, takes its location from one, and covers non-agreed findings only
 * within the same issue as one of its agreed findings.
 *
 * @param {object} entry - Entry with a covers array.
 * @param {string} where - Location label.
 * @param {Map<string, object>} sent - Findings sent to the Chairman, with their issue.
 * @returns {string[]} Violations.
 */
function agreementErrors(entry, where, sent) {
  const known = entry.covers.filter((id) => sent.has(id)).map((id) => sent.get(id));
  const agreed = known.filter((finding) => finding.agreed);
  if (agreed.length === 0) {
    return [`${where}: must cover at least one agreed finding`];
  }
  const issues = new Set(agreed.map((finding) => finding.issue));
  const errors = known
    .filter((finding) => !finding.agreed && !issues.has(finding.issue))
    .map((finding) => `${where}: ${finding.id} belongs to a different issue than the entry's agreed findings`);
  if (!agreed.some((finding) => finding.id === entry.coordinate_from)) {
    errors.push(`${where}: coordinate_from must be one of the entry's agreed findings`);
  }
  return errors;
}

/**
 * Tests for a bounded non-empty string.
 *
 * @param {unknown} value - Candidate.
 * @param {number} limit - Maximum length.
 * @returns {boolean} True when valid.
 */
function isText(value, limit) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= limit;
}

/**
 * Appends a GitHub suggestion block to a comment body.
 *
 * @param {string} body - Comment body.
 * @param {string|null} suggestion - Replacement text.
 * @returns {string} Final body.
 */
export function composeBody(body, suggestion) {
  return suggestion ? `${body}\n\n\`\`\`suggestion\n${suggestion}\n\`\`\`` : body;
}

/**
 * Builds a Section 5 coordinate tuple from a screened finding.
 *
 * @param {object} finding - Screened finding.
 * @param {string} headSha - Pinned head SHA.
 * @returns {object} Tuple with path, commit_id, side, line, and optional start_side/start_line.
 */
export function coordinateTuple(finding, headSha) {
  const tuple = { path: finding.path, commit_id: headSha, side: finding.side, line: finding.line };
  if (finding.start_line !== null) {
    tuple.start_side = finding.side;
    tuple.start_line = finding.start_line;
  }
  return tuple;
}
