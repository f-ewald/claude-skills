/**
 * deep-research workflow TEMPLATE — copy this, edit the CONFIG block + prompts, then run:
 *
 *   ULTRACODE_CLI=copilot node research.run.mjs "Your research question"   # Copilot CLI subagents
 *   ULTRACODE_CLI=claude  node research.run.mjs "Your research question"   # Claude Code subagents
 *
 * Shape: fan out one RESEARCHER per perspective/angle over a single TOPIC (each returns findings
 * WITH source URLs), then ADVERSARIALLY VERIFY every load-bearing claim (a skeptic prompted to
 * refute it), keeping only claims that survive. This is the deep-research analogue of ultracode's
 * review -> verify recipe.
 *
 * Engine: this imports ultracode's orchestrate.mjs BY REFERENCE. It expects the `ultracode` skill
 * installed as a SIBLING under the same skills/ directory:
 *     skills/deep-research/research.workflow.template.mjs   (this file)
 *     skills/ultracode/orchestrate.mjs                       (the engine)
 * Both are satisfied by the repo's ~/.claude/skills symlink. If you install deep-research ALONE,
 * change the import below to the ABSOLUTE path of orchestrate.mjs, e.g.
 * '/Users/you/.copilot/skills/ultracode/orchestrate.mjs'.
 *
 * SAFE BY DEFAULT: research only reads and searches, so keep the engine's read-only default —
 * do NOT set ULTRACODE_PERMS=all for this workflow.
 */

import { agent, parallel, pipeline, phase, log, run } from '../ultracode/orchestrate.mjs'

// ─── CONFIG ───────────────────────────────────────────────────────────────────────────
const TOPIC = process.argv[2] || 'Your research question / topic here'

// One researcher runs per angle. Add/remove/edit to fit the topic and depth preset.
const ANGLES = [
  { key: 'technical', focus: 'how it works, architecture, capabilities, limitations, maturity' },
  { key: 'adoption', focus: 'who uses it, ecosystem, community, real-world case studies' },
  { key: 'economics', focus: 'cost, pricing, total cost of ownership, licensing, business model' },
  { key: 'risks', focus: 'security, reliability, failure modes, compliance, lock-in' },
  { key: 'alternatives', focus: 'competing approaches and how they compare, trade-offs' },
  { key: 'counter', focus: 'the strongest criticisms and arguments AGAINST the mainstream view' },
]

const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          evidence: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
          loadBearing: { type: 'boolean' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['claim', 'evidence', 'sources'],
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
    bestSource: { type: 'string' },
  },
  required: ['isReal', 'reasoning'],
}

const researchPrompt = (a) =>
  `Research this topic from the "${a.key}" perspective (${a.focus}):\n\n"${TOPIC}"\n\n` +
  `Investigate thoroughly using web search/fetch and any connected internal research tools. ` +
  `Return concrete, defensible findings. For EACH finding include the claim, the supporting ` +
  `evidence, and one or more SOURCE URLs — no source, no finding. Set loadBearing=true for claims ` +
  `a conclusion would depend on. Do not pad or speculate; an empty findings array is fine.`

const verifyPrompt = (f) =>
  `Adversarially verify this research claim about:\n"${TOPIC}"\n\n` +
  `Claim: ${f.claim}\nEvidence offered: ${f.evidence}\nSources: ${(f.sources || []).join(', ') || '(none)'}\n\n` +
  `Independently check the sources and search for refutation. Your job is to REFUTE it. Default ` +
  `isReal=false unless independent sources unambiguously confirm the claim. Put the single strongest ` +
  `corroborating URL in bestSource (empty string if none).`

// ─── ORCHESTRATION ──────────────────────────────────────────────────────────────────────
run(async () => {
  phase('Research')
  const perAngle = await pipeline(
    ANGLES,
    (a) => agent(researchPrompt(a), { label: `research:${a.key}`, schema: RESEARCH_SCHEMA })
      .then((r) => ({ angle: a.key, findings: (r && r.findings) || [] })),
  )

  const findings = perAngle.flatMap((p) => p.findings.map((f) => ({ angle: p.angle, ...f })))
  const loadBearing = findings.filter((f) => f.loadBearing)
  log(`${findings.length} findings across ${ANGLES.length} angles; ${loadBearing.length} load-bearing → verifying`)

  phase('Verify load-bearing claims')
  const verified = await parallel(
    loadBearing.map((f) => () =>
      agent(verifyPrompt(f), { label: `verify:${f.angle}`, schema: VERDICT_SCHEMA })
        .then((v) => ({ ...f, verdict: v }))),
  )

  const confirmed = verified.filter((f) => f && f.verdict && f.verdict.isReal)
  const refuted = verified.filter((f) => f && (!f.verdict || !f.verdict.isReal))
  log(`load-bearing: ${confirmed.length} confirmed, ${refuted.length} refuted/unverified`)

  const sources = [...new Set(findings.flatMap((f) => f.sources || []).filter(Boolean))]

  return {
    topic: TOPIC,
    angles: ANGLES.map((a) => a.key),
    findingCount: findings.length,
    findingsByAngle: perAngle,
    confirmedClaims: confirmed.map((f) => ({ angle: f.angle, claim: f.claim, source: (f.verdict && f.verdict.bestSource) || (f.sources || [])[0] })),
    unverifiedClaims: refuted.map((f) => ({ angle: f.angle, claim: f.claim, why: f.verdict && f.verdict.reasoning })),
    sources,
  }
})
