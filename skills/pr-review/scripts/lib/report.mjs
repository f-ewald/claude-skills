/**
 * Composes the de-anonymized final council report after Chairman validation.
 */

import { composeBody, coordinateTuple, votesFor } from './consensus.mjs';

/**
 * Builds the final report: Chairman findings as Section 5 tuples, dissent,
 * rejected findings, leaderboard, and member outcomes, with model names.
 *
 * @param {object} input - Report input.
 * @param {object[]} input.output - Validated Chairman entries.
 * @param {object} input.packet - Chairman packet.
 * @param {object} input.analysis - Persisted analysis from the run step.
 * @param {string} input.headSha - Pinned head SHA.
 * @returns {object} Final report.
 */
export function composeFinalReport({ output, packet, analysis, headSha }) {
  const names = new Map(analysis.members.map((member) => [member.label, member.stage1.model ?? member.vendor]));
  const name = (label) => names.get(label) ?? label;
  const byId = new Map(analysis.findings.map((finding) => [finding.id, finding]));
  const sent = new Map(packet.issues.flatMap((issue) => issue.findings.map((finding) => [finding.id, finding])));
  const support = new Map(Object.entries(analysis.support));
  const ballots = new Map(Object.entries(analysis.ballots));
  const covered = new Set(output.flatMap((entry) => entry.covers));
  return {
    version: 1,
    pinned: analysis.pinned,
    context: analysis.context,
    threshold: analysis.threshold,
    members: analysis.members.map((member) => describeMember(member)),
    findings: output.map((entry) => finalFinding({ entry, byId, sent, support, name, headSha })),
    dissent: analysis.findings
      .filter((finding) => !covered.has(finding.id))
      .map((finding) => dissentFinding({ finding, support, ballots, name, headSha })),
    rejected: analysis.rejected.map((entry) => ({ ...entry, author: name(entry.author) })),
    leaderboard: analysis.leaderboard.map((entry) => ({ ...entry, model: name(entry.label) })),
  };
}

/**
 * Converts one Chairman entry into a confirmed-finding candidate.
 *
 * @param {object} options - Entry and lookup tables.
 * @returns {object} Final finding with council provenance.
 */
function finalFinding({ entry, byId, sent, support, name, headSha }) {
  const agreed = entry.covers.filter((id) => sent.get(id).agreed);
  const supporters = new Set(agreed.flatMap((id) => support.get(id) ?? []));
  return {
    ...coordinateTuple(byId.get(entry.coordinate_from), headSha),
    severity: entry.severity,
    severity_reason: entry.severity_reason,
    description: entry.description,
    body: composeBody(entry.body, entry.suggestion ?? null),
    council: {
      covers: entry.covers,
      reported_by: [...new Set(entry.covers.map((id) => name(byId.get(id).author)))],
      support: [...supporters].map(name).sort(),
      votes: entry.covers.flatMap((id) => sent.get(id).votes.map((vote) => ({
        finding: id, model: name(vote.voter), verdict: vote.verdict, severity: vote.severity, reason: vote.reason,
      }))),
    },
  };
}

/**
 * Describes a finding that did not reach agreement and was not covered.
 *
 * @param {object} options - Finding and lookup tables.
 * @returns {object} Dissent entry, promotable only by explicit user choice.
 */
function dissentFinding({ finding, support, ballots, name, headSha }) {
  return {
    id: finding.id,
    ...coordinateTuple(finding, headSha),
    severity: finding.severity,
    title: finding.title,
    description: finding.description,
    body: composeBody(finding.body, finding.suggestion),
    author: name(finding.author),
    support: (support.get(finding.id) ?? []).map(name).sort(),
    votes: votesFor(finding, ballots).map((vote) => ({
      model: name(vote.voter), verdict: vote.verdict, severity: vote.severity, reason: vote.reason,
    })),
  };
}

/**
 * Lists the models a member skipped because the CLI reported them unavailable.
 *
 * @param {object[]} attempts - Attempt records from the runner.
 * @returns {string[]} Skipped model IDs in order, without duplicates.
 */
export function fallbacksUsed(attempts) {
  return [...new Set(attempts.filter((attempt) => attempt.rejected === 'model-unavailable')
    .map((attempt) => attempt.model))];
}

/**
 * Projects a member record for the report.
 *
 * @param {object} member - Persisted member record.
 * @returns {object} Member summary.
 */
function describeMember(member) {
  return {
    vendor: member.vendorLabel,
    model: member.stage1.model ?? null,
    effort: member.stage1.effort ?? null,
    stage1: member.stage1.status,
    stage2: member.stage2?.status ?? 'not-run',
    error: member.stage1.error ?? member.stage2?.error ?? null,
    fallbacks_used: fallbacksUsed(member.stage1.attempts),
  };
}
