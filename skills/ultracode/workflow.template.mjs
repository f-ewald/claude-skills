/**
 * ultracode workflow TEMPLATE — copy this, edit the CONFIG block + prompts, then run:
 *
 *   ULTRACODE_CLI=copilot node my-workflow.mjs            # Copilot CLI subagents
 *   ULTRACODE_CLI=claude  node my-workflow.mjs            # Claude Code subagents
 *
 * This is the canonical ultracode shape: fan out review dimensions over a target,
 * then ADVERSARIALLY VERIFY each finding (a skeptic prompted to refute it), keeping
 * only findings that survive. Mirrors the Claude Code `Workflow` review→verify recipe.
 *
 * The engine is SAFE BY DEFAULT (read-only subagents). This review workflow only reads,
 * so the default is correct — do NOT set ULTRACODE_PERMS=all for it.
 */

import { agent, parallel, pipeline, phase, log, run } from './orchestrate.mjs'

// ─── CONFIG ───────────────────────────────────────────────────────────────────────────
const TARGET = process.argv[2] || 'path/to/file/under/review'

const DIMENSIONS = [
  { key: 'correctness', focus: 'logic bugs, wrong mappings, incorrect semantics, data-model mismatches' },
  { key: 'security', focus: 'secret handling, sensitive data in logs, injection, auth/expiry correctness' },
  { key: 'robustness', focus: 'error handling, transaction safety, races, resource/session cleanup' },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          location: { type: 'string' },
          explanation: { type: 'string' },
        },
        required: ['title', 'severity', 'location', 'explanation'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    isReal: { type: 'boolean' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasoning: { type: 'string' },
  },
  required: ['isReal', 'reasoning'],
}

const reviewPrompt = (d) =>
  `Read the file ${TARGET} and review it ONLY for the "${d.key}" dimension (${d.focus}). ` +
  `Report ONLY real, defensible issues — do not invent or pad. Empty findings array if none.`

const verifyPrompt = (f, dim) =>
  `Adversarially verify this ${dim} finding about ${TARGET}. Read the file and any related code.\n` +
  `Title: ${f.title}\nLocation: ${f.location}\nClaim: ${f.explanation}\n` +
  `Your job is to REFUTE it. Default isReal=false unless the code unambiguously confirms a material issue.`

// ─── ORCHESTRATION ──────────────────────────────────────────────────────────────────────
run(async () => {
  phase('Review')
  const results = await pipeline(
    DIMENSIONS,
    (d) => agent(reviewPrompt(d), { label: `review:${d.key}`, schema: FINDINGS_SCHEMA }),
    (review, d) =>
      parallel((review?.findings || []).map((f) => () =>
        agent(verifyPrompt(f, d.key), { label: `verify:${d.key}`, schema: VERDICT_SCHEMA })
          .then((v) => ({ dimension: d.key, ...f, verdict: v })))),
  )

  const all = results.flat().filter(Boolean)
  const confirmed = all.filter((f) => f.verdict && f.verdict.isReal)
  const refuted = all.filter((f) => !f.verdict || !f.verdict.isReal)
  log(`${all.length} raw findings → ${confirmed.length} confirmed, ${refuted.length} refuted`)

  return {
    target: TARGET,
    rawFindingCount: all.length,
    confirmed: confirmed.map((f) => ({ dimension: f.dimension, title: f.title, severity: f.severity, location: f.location })),
    refuted: refuted.map((f) => ({ dimension: f.dimension, title: f.title, why: f.verdict && f.verdict.reasoning })),
  }
})
