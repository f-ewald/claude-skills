---
name: deep-research
description: Spawn multiple agents to research a topic exhaustively from many perspectives — generate a wide grill-me-style question tree but auto-answer it "as a reasonable person" so the agents run autonomously, then synthesize a cited markdown report (optionally converted to other formats). Use when the user wants deep, exhaustive, or multi-perspective research, a landscape or literature review, or invokes "deep research".
license: MIT
author: Freddy Ewald
compatibility: Reuses the ultracode skill's Node engine for the Copilot CLI path — install the ultracode skill as a sibling under the same skills/ directory and have Node >= 18 on PATH. On Claude Code it uses the native Workflow tool instead; with neither, it degrades to sequential research. Company-agnostic — uses internal MCP research/code-search tools only if connected, otherwise web-only.
---

# Deep Research

Produce an exhaustive, multi-perspective research report the way a rigorous analyst would —
decompose the question widely, investigate every angle in parallel, verify the load-bearing
claims, then synthesize with citations. Run **autonomously**: instead of interviewing the user,
answer your own questions the way a reasonable, well-informed person would and record every such
decision, pulling the user in only at the checkpoints below.

This skill combines two others:

- **grill-me** — generate as many questions as possible (walk every branch of the research tree).
- **ultracode** — fan the work out to parallel subagents and adversarially verify
  (`find → verify → synthesize`).

Work through the phases in order.

## Operating principles (in force for the whole task)

- **Autonomy over interrogation.** Unlike grill-me, do **not** ask the user each question.
  Auto-answer as a reasonable person, log it, and keep moving. The user is touched only at three
  checkpoints: **start**, **mid-research**, **end** — and only for genuinely blocking decisions.
- **Assumptions are transparent.** Every auto-answered question goes into an **"Assumptions made"**
  ledger that ships in the final report, so autonomy never hides a decision the user might make
  differently.
- **Company-agnostic sourcing.** Never assume a specific company's tools or URLs. List available
  tools first; use internal MCP/research/code-search tools **only if connected**, otherwise proceed
  **web-only** and never block on internal tools.
- **Citations required.** Every load-bearing claim carries a source. Claims that can't be
  sourced/verified are kept but flagged as unverified.
- **Resolve, don't infer, load-bearing facts.** For a fact a conclusion hinges on (a version,
  config value, flag state, price, date, spec detail), get it from the **authoritative/primary
  source** and, where possible, **resolve it directly** at the exact target (the pinned
  version/BOM/lockfile, the specific commit/tag, the actual config or environment) instead of
  reasoning about what it "should" be — "unpinned" ≠ "latest." This especially guards the
  auto-answer autonomy above: never let a reasonable-person *guess* stand in for a checkable fact.
- **Absence of evidence ≠ evidence of absence.** A claim you could not confirm is *unconfirmed*,
  not *false* — keep the two distinct. Any negative or null finding must carry the **scope you
  actually checked** (which sources, versions, conditions); a clean result under conditions that
  don't match the real ones is not a disproof. State that limitation explicitly.
- **Safe by default.** Research subagents are **read-only** (view/search/web-fetch). Never grant
  write/exec permissions for a research fan-out.
- **Scale to the ask.** Pick a depth — `quick | standard | exhaustive` — that sets the number of
  researcher agents, verification voters, and loop rounds. Default `standard`; go `exhaustive` when
  the user says "thorough / deep / comprehensive."
- **Heterogeneous models (if available).** To widen perspective and control cost, spread subagents
  across a heterogeneous model pool whenever more than one model is available:
  - **Rotate model families** across the research angles so different perspectives are investigated
    by different families — and verify each load-bearing claim with a *different* family than
    produced it, to catch family-specific blind spots.
  - **Match cost to difficulty** — cheap/small models for easy, mechanical steps (broad lookups,
    dedup, the completeness-critic enumeration); stronger/expensive models for hard reasoning
    (adversarial verification, synthesis, counter-argument and risk analysis).
  - **Best-effort, graceful fallback** — this is "if available." If you can determine only one
    model, use it everywhere; never fail or block because a diverse pool isn't available.

## Phase 0 — Frame the research

Capture the **question/topic**, the **depth** (above), and the **output target** (default: a
markdown file). Then detect your environment:

- **Orchestration mechanism** — a Claude Code `Workflow` tool? the Copilot CLI `task` tool + Node
  (ultracode's `orchestrate.mjs`)? just a `task` tool? none? (Determines Phase 4's path.)
- **Sources** — list connected MCP tools; note whether internal research/code-search is available.
  If not, plan web-only.
- **Models** — determine which models are available (the runtime's model list, a `/model`-style
  command, or a user-provided list) and group them by **family** and **cost tier** (cheap vs.
  strong). If you can find only one, note that and skip the model-heterogeneity below.

Do not ask the user about any of this unless it is genuinely ambiguous — infer sensible defaults
and record them.

## Phase 1 — Generate the question tree (grill-me, auto-answered)

Like grill-me, decompose the topic into **as many questions as possible**, walking each branch of
the research/decision tree and resolving dependencies between them. But instead of asking the user:

- **Answer each question** the way a reasonable, well-informed person would — choose sensible scope,
  definitions, timeframe, audience, and success criteria.
- If a question is answerable by **exploring the codebase or a source**, do that instead of assuming.
- **Record every answer** in the Assumptions ledger (question → your answer → one-line rationale).
- **Flag the genuinely blocking few** — questions where a wrong default would waste the whole run
  and no reasonable default exists.

## Phase 2 — Start checkpoint (batched, blocking-only)

If Phase 1 produced any genuinely blocking questions, ask them **once, batched**, up front
(`AskUserQuestion` / `ask_user`), each with your recommended answer. If there are none, proceed
silently. Keep this minimal — it is the only guaranteed user touchpoint.

## Phase 3 — Build the research plan

Turn the topic + assumptions into a **research brief**:

- The key **sub-questions** to answer.
- A set of **distinct perspectives/angles** so the topic is covered from many sides — e.g.
  technical, historical, economic/cost, adoption/ecosystem, security/risk, UX/human,
  counter-arguments, and alternatives. Choose the angles that fit the topic.
- The **sources** to consult per angle (internal first if connected, then web).
- The **load-bearing claims** — the facts the conclusion depends on — which will need verification.

Size the plan to the depth preset.

## Phase 4 — Fan-out research (ultracode orchestration)

Dispatch one researcher per angle/sub-question; each returns findings **with source URLs**. Then
**adversarially verify** the load-bearing claims (a skeptic per claim, defaulting to "not
established" until the source unambiguously confirms it). Use **loop-until-dry** and a
**completeness critic** ("what's missing?") to decide when to stop. The patterns are identical
across runtimes; only the mechanism differs (see the **ultracode** skill):

- **Claude Code** — author a `Workflow` script: a researcher agent per angle (schema: findings +
  citations), a verification stage on the load-bearing claims, then synthesize.
- **Copilot CLI + Node (preferred)** — copy `research.workflow.template.mjs` to a working file, edit
  its CONFIG (topic, angles, sub-questions, depth), and run it:

  ```bash
  cd <this skill dir>
  cp research.workflow.template.mjs research.run.mjs
  ULTRACODE_CLI=copilot node research.run.mjs "Your research question" > result.json
  ```

  Keep the **read-only default** — research only reads and searches; do **not** set
  `ULTRACODE_PERMS=all`. (Engine mechanics, env vars, and troubleshooting live in the ultracode
  skill's `README.txt`.)
- **Copilot CLI, no Node** — model-driven loop (ultracode Option B): fan out one `task` subagent per
  angle in a single response, collect JSON, dedup, then a verify round; loop across turns until dry.
- **No orchestration at all** — degrade gracefully: research each angle sequentially yourself, still
  covering every perspective and still verifying the load-bearing claims.

**Assign models heterogeneously (if a pool is available).** Whichever mechanism you use, spread the
work across model families and tiers per the *Heterogeneous models* principle above:

- **Claude Code Workflow** — pass a distinct `model` to each `agent()` call: rotate families across
  the per-angle researchers, use the cheap tier for easy angles and the strong tier for hard ones,
  and pick a strong, different-family model for each verification agent.
- **Copilot engine (Option A)** — the template ships this prewired: populate its `MODELS` pool (edit
  the array or set `ULTRACODE_MODELS="family:tier:id, …"`) and it rotates families across
  researchers, selects the tier from each angle's `complexity`, and verifies each claim with a
  strong cross-family model. Empty pool → the single default model everywhere.
- **Task-loop (Option B)** — if your `task` tool accepts a model override, set it per subagent the
  same way (rotate families, match tier to difficulty); otherwise dispatch with what you have.

## Phase 5 — Mid-research checkpoint (only if needed)

Pause **once**, batched, only if research surfaces a **material fork** that a reasonable default
can't resolve, or a finding that invalidates the framing. Otherwise keep running autonomously. This
is the "interactive phase" — use it sparingly.

## Phase 6 — Synthesize the report

Dedup and merge findings in your own reasoning. Read
[templates/report-template.md](templates/report-template.md) and fill every section:

- **TL;DR / Abstract** (write last), **Scope & Method** (depth, sources, and orchestration used),
  **Key Findings** grouped by theme/perspective, **Evidence & Analysis**, **Verified vs. Unverified
  claims**, the **Assumptions made** ledger from Phase 1, **Open Questions**,
  **Recommendation / Conclusion**, and a numbered, deduped **References** list. Every load-bearing
  claim cites a source by number.

## Phase 7 — Emit + end checkpoint

Derive a `kebab-case` slug from the title, propose `./<slug>.md`, confirm the filename, then write
the markdown report. Present a short summary **plus the Assumptions list** so the user can spot any
they'd answer differently. Then **offer** optional format conversions and **delegate** — build
nothing new:

- **Google Doc** → the `write-google-docs` skill (pass the assembled markdown).
- **PDF / HTML / docx** → `pandoc` if it is installed (`command -v pandoc`); otherwise say
  markdown-only.

Accept refinements — re-open any assumption or deepen an angle — and loop back as needed.

---

**Files in this skill.** `SKILL.md` (this file), `research.workflow.template.mjs` (copy-and-adapt
engine workflow that imports ultracode's `orchestrate.mjs`), `templates/report-template.md` (output
skeleton), and `README.txt` (Copilot CLI run guide). The workflow template needs the **ultracode**
skill installed as a sibling under the same `skills/` directory so its `../ultracode/orchestrate.mjs`
import resolves; if you install this skill alone, change that import to the absolute path of
`orchestrate.mjs`.
