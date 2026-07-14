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
 *
 * HETEROGENEOUS MODELS (optional, best-effort — "if available"): to widen perspective and match
 * cost to difficulty, populate the MODELS pool below (or set ULTRACODE_MODELS) with the models
 * available in YOUR environment, each tagged by family and tier. Researchers then ROTATE across
 * model families (different angles investigated by different families), easy angles use cheap
 * models and hard angles use strong ones, and each load-bearing claim is verified by a STRONG
 * model from a DIFFERENT family than produced it. Leave the pool empty to use the engine's single
 * default model everywhere (ULTRACODE_MODEL, or the CLI default) — nothing else changes.
 *   ULTRACODE_MODELS="familyA:cheap:modelA-mini, familyA:strong:modelA-pro, familyB:cheap:modelB-mini"
 */

import { agent, parallel, pipeline, phase, log, run } from '../ultracode/orchestrate.mjs'

// ─── CONFIG ───────────────────────────────────────────────────────────────────────────
const TOPIC = process.argv[2] || 'Your research question / topic here'

// One researcher runs per angle. `complexity` picks the model tier: 'easy' → cheap model,
// 'hard' → strong model. Add/remove/edit to fit the topic and depth preset.
const ANGLES = [
  { key: 'technical', complexity: 'hard', focus: 'how it works, architecture, capabilities, limitations, maturity' },
  { key: 'adoption', complexity: 'easy', focus: 'who uses it, ecosystem, community, real-world case studies' },
  { key: 'economics', complexity: 'easy', focus: 'cost, pricing, total cost of ownership, licensing, business model' },
  { key: 'risks', complexity: 'hard', focus: 'security, reliability, failure modes, compliance, lock-in' },
  { key: 'alternatives', complexity: 'hard', focus: 'competing approaches and how they compare, trade-offs' },
  { key: 'counter', complexity: 'hard', focus: 'the strongest criticisms and arguments AGAINST the mainstream view' },
]

// ─── MODELS (optional; heterogeneous perspectives + cost control) ─────────────────────
// Tag each available model with a `family` (rotated for diverse perspectives) and a `tier`
// ('cheap' for easy tasks, 'strong' for hard reasoning + verification). Supply via the
// ULTRACODE_MODELS env var ("family:tier:id, …") or edit the fallback array below. Empty →
// the engine's single default model is used everywhere (no behavior change).
function parseModels(spec) {
  if (!spec) return []
  return spec.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [family, tier, ...rest] = entry.split(':')
    return { family: (family || '').trim(), tier: (tier || 'cheap').trim(), id: rest.join(':').trim() }
  }).filter((m) => m.id)
}

const MODELS = parseModels(process.env.ULTRACODE_MODELS).length
  ? parseModels(process.env.ULTRACODE_MODELS)
  : [
      // Edit to the models available in YOUR environment, or set ULTRACODE_MODELS:
      // { id: 'family-a-mini', family: 'a', tier: 'cheap' },
      // { id: 'family-a-pro',  family: 'a', tier: 'strong' },
      // { id: 'family-b-mini', family: 'b', tier: 'cheap' },
      // { id: 'family-b-pro',  family: 'b', tier: 'strong' },
    ]
const FAMILIES = [...new Set(MODELS.map((m) => m.family))]

// Pick a model of `tier`, rotating across families by `idx` for perspective diversity. Falls back
// gracefully: any tier when that tier is empty, a different family when asked and one exists, and
// undefined (→ the engine's default model) when the pool is empty.
function pickModel(tier, idx, opts = {}) {
  if (!MODELS.length) return undefined
  const byTier = MODELS.filter((m) => m.tier === tier)
  let pool = byTier.length ? byTier : MODELS
  if (opts.avoidFamily && FAMILIES.length > 1) {
    const other = pool.filter((m) => m.family !== opts.avoidFamily)
    if (other.length) pool = other
  }
  const fams = [...new Set(pool.map((m) => m.family))]
  const famPool = pool.filter((m) => m.family === fams[idx % fams.length])
  return famPool[idx % famPool.length]
}

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
    status: { type: 'string', enum: ['confirmed', 'refuted', 'unconfirmed'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasoning: { type: 'string' },
    scope: { type: 'string' },
    bestSource: { type: 'string' },
  },
  required: ['status', 'reasoning'],
}

const researchPrompt = (a) =>
  `Research this topic from the "${a.key}" perspective (${a.focus}):\n\n"${TOPIC}"\n\n` +
  `Investigate thoroughly using web search/fetch and any connected internal research tools. ` +
  `Prefer PRIMARY/AUTHORITATIVE sources; for any fact a conclusion hinges on (a version, config ` +
  `value, flag state, price, date, spec detail), resolve it directly from the source rather than ` +
  `inferring what it "should" be. Return concrete, defensible findings. For EACH finding include ` +
  `the claim, the supporting evidence, and one or more SOURCE URLs — no source, no finding. Set ` +
  `loadBearing=true for claims a conclusion would depend on. Do not pad or speculate; an empty ` +
  `findings array is fine.`

const verifyPrompt = (f) =>
  `Adversarially verify this research claim about:\n"${TOPIC}"\n\n` +
  `Claim: ${f.claim}\nEvidence offered: ${f.evidence}\nSources: ${(f.sources || []).join(', ') || '(none)'}\n\n` +
  `Check the AUTHORITATIVE/PRIMARY source directly — resolve the fact at its exact target (pinned ` +
  `version/BOM/lockfile, specific commit/tag, actual config or environment); do not infer what it ` +
  `"should" be. Your job is to REFUTE the claim. Return status='confirmed' ONLY if the primary ` +
  `source unambiguously confirms it, 'refuted' if the source contradicts it, otherwise ` +
  `'unconfirmed' — do NOT report an unconfirmed claim as refuted. For 'refuted'/'unconfirmed', put ` +
  `the exact scope you checked (sources, versions, conditions) in scope. Put the single strongest ` +
  `corroborating URL in bestSource (empty string if none).`

// ─── ORCHESTRATION ──────────────────────────────────────────────────────────────────────
run(async () => {
  phase(MODELS.length ? `Research (${FAMILIES.length} families / ${MODELS.length} models, rotating)` : 'Research')
  const perAngle = await pipeline(
    ANGLES,
    (a, _orig, i) => {
      const m = pickModel(a.complexity === 'hard' ? 'strong' : 'cheap', i)
      return agent(researchPrompt(a), { label: `research:${a.key}${m ? ` @${m.id}` : ''}`, model: m && m.id, schema: RESEARCH_SCHEMA })
        .then((r) => ({ angle: a.key, family: m && m.family, model: m && m.id, findings: (r && r.findings) || [] }))
    },
  )

  const findings = perAngle.flatMap((p) => p.findings.map((f) => ({ angle: p.angle, researchFamily: p.family, ...f })))
  const loadBearing = findings.filter((f) => f.loadBearing)
  log(`${findings.length} findings across ${ANGLES.length} angles; ${loadBearing.length} load-bearing → verifying`)

  phase(MODELS.length ? 'Verify load-bearing claims (strong tier, cross-family)' : 'Verify load-bearing claims')
  const verified = await parallel(
    loadBearing.map((f, j) => () => {
      const m = pickModel('strong', j, { avoidFamily: f.researchFamily })
      return agent(verifyPrompt(f), { label: `verify:${f.angle}${m ? ` @${m.id}` : ''}`, model: m && m.id, schema: VERDICT_SCHEMA })
        .then((v) => ({ ...f, verifyFamily: m && m.family, verdict: v }))
    }),
  )

  const statusOf = (f) => (f && f.verdict && f.verdict.status) || 'unconfirmed'
  const confirmed = verified.filter((f) => f && statusOf(f) === 'confirmed')
  const refuted = verified.filter((f) => f && statusOf(f) === 'refuted')
  const unconfirmed = verified.filter((f) => f && statusOf(f) === 'unconfirmed')
  log(`load-bearing: ${confirmed.length} confirmed, ${refuted.length} refuted, ${unconfirmed.length} unconfirmed`)

  const sources = [...new Set(findings.flatMap((f) => f.sources || []).filter(Boolean))]

  return {
    topic: TOPIC,
    angles: ANGLES.map((a) => a.key),
    models: MODELS.map((m) => `${m.family}:${m.tier}:${m.id}`),
    findingCount: findings.length,
    findingsByAngle: perAngle,
    confirmedClaims: confirmed.map((f) => ({ angle: f.angle, claim: f.claim, verifiedBy: f.verifyFamily, source: (f.verdict && f.verdict.bestSource) || (f.sources || [])[0] })),
    refutedClaims: refuted.map((f) => ({ angle: f.angle, claim: f.claim, why: f.verdict && f.verdict.reasoning, scope: f.verdict && f.verdict.scope })),
    unconfirmedClaims: unconfirmed.map((f) => ({ angle: f.angle, claim: f.claim, why: f.verdict && f.verdict.reasoning, scope: f.verdict && f.verdict.scope })),
    sources,
  }
})
