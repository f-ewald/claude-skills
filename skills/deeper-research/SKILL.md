---
name: deeper-research
description: Conducts rigorous multi-perspective research with deterministic depth presets, sourced findings, quorum verification, completeness criticism, and a gated whole-thesis red team. Use when the user wants deep or exhaustive research, a landscape or literature review, or a cited decision report without invoking Claude Code's bundled deep-research command.
license: MIT
metadata:
  author: Freddy Ewald
compatibility: Works in Claude Code or GitHub Copilot CLI. The Node path requires Node.js 18+ and one separately installed ultracode engine. Public deterministic research is Copilot-only because the Claude adapter cannot enforce URL grants; use native Claude Workflow/runtime permissions for public Claude research. Internal/local-only deterministic Claude runs remain supported.
---

# Deeper Research

Produce a cited, multi-perspective research report while keeping assumptions,
source boundaries, incomplete coverage, and failed subagents visible. This skill
is named `deeper-research` so it does not shadow Claude Code's bundled
`/deep-research`; there is intentionally no alias.

Read [README.txt](README.txt) before using the deterministic Node workflow and
[templates/report-template.md](templates/report-template.md) before writing the
report.

## Invocation modes

- **`standalone` (default):** complete the research, then perform the normal end
  checkpoint, filename confirmation, Markdown report emission, and optional
  conversions.
- **`embedded` / evidence-only:** complete framing, assumptions, research,
  completeness, verification, synthesis, and the gated red team, then return the
  structured evidence bundle directly to the calling skill. Skip filename
  confirmation, report file emission, and conversions.

The `design-doc` skill uses embedded mode so research evidence is available
inside its workflow before recommendation sign-off. The caller owns how that
evidence is incorporated; deeper-research must not emit a competing report
first. For the deterministic workflow set
`DEEPER_RESEARCH_MODE=embedded`.

## Non-negotiable contract

- Run autonomously. Auto-answer reasonable defaults and record them.
- Ask the user only at the start, midpoint, or end, and only for genuinely
  blocking decisions.
- Keep `verified`, `refuted`, and `unconfirmed` distinct. Failed calls are not
  refutations.
- Every finding has at least one source and an explicit `loadBearing` boolean.
- Preserve source URLs/URIs, checked scope, confidence, source limitations, and
  the exact scope of negative findings.
- Use only already configured, approved, read-only internal tools. Use public web
  only for non-sensitive material and only with explicit bounded URL/domain
  grants.
- Never send internal/private content to public tools. Never probe speculative
  tool names merely to discover whether they exist.
- Never grant all URLs, a write profile, shell execution, or a shell fallback.
- Keep generated workflows and results in a session workspace, never in the
  installed skill directory.
- Reuse the installed ultracode engine. Do not copy or fork `orchestrate.mjs`.

## Depth presets

Depth selection deterministically controls initial researcher fan-out, verifier
votes, and completeness bounds:

| Depth | Research angles | Votes per load-bearing claim | Completeness |
| --- | ---: | ---: | ---: |
| `quick` | exactly 3 | 1 | exactly 1 pass |
| `standard` | exactly 6 | 2 | up to 2 rounds |
| `exhaustive` | 8-12 (default 10) | 3 | up to 3 rounds |

Default to `standard`. Choose `exhaustive` for "thorough", "deep",
"comprehensive", or equivalent requests. Do not silently change one control
without changing the selected preset.

## Phase 0 — Frame and preflight

Capture:

1. The research question.
2. The depth preset.
3. The invocation mode: `standalone` or `embedded`.
4. The output target for standalone mode, defaulting to Markdown.
5. The source classification: public, internal/private, or isolated mixed
   angles.
6. Available model families and cost tiers.

For the deterministic path:

1. Create a session workspace under the working repository or another
   user-approved working directory.
2. Copy `research.workflow.template.mjs` into that workspace.
3. Resolve the one shared engine with `ULTRACODE_ENGINE` or the standard
   `~/.copilot/skills`, `~/.agents/skills`, or `~/.claude/skills` location.
4. Set `ULTRACODE_CWD` to the research workspace/repository.
5. For Copilot public research, set `ULTRACODE_ALLOWED_URLS` to the smallest
   explicit list of required URLs/domains.
6. Run preflight before launching any subagent. A missing engine, working
   directory, unresolved blocking question, or public URL grant is a visible
   failure, not a reason to broaden permissions.

The deterministic ultracode Claude adapter cannot enforce URL allowlists.
Therefore public deterministic `ULTRACODE_CLI=claude` runs fail closed. Use
native Claude Workflow/runtime permissions for public research, or use the
Copilot deterministic engine. Internal/local-only deterministic Claude runs are
allowed.

Do not use an absolute user-specific engine path in committed files. Do not
create `research.run.mjs` or result files inside this package.

## Phase 1 — Question tree and assumptions ledger

Build and persist a structured question tree. Each auto-answered entry contains:

- `question`
- `assumption`
- `rationale`
- `confidence` (`low | medium | high`)
- `status` (`auto-answered | confirmed | needs-user`)

Track genuinely blocking questions in a separate `blockingQuestions` list. Use
code/source exploration instead of assumptions when the answer is inspectable.
Choose a reasonable default for scope, audience, timeframe, definitions, and
success criteria when that cannot invalidate the whole run.

## Phase 2 — Start checkpoint

If blocking questions exist, ask them once as a batch with recommended answers.
Resolve them before fan-out. If none exist, proceed silently.

## Phase 3 — Research plan and source isolation

Select the preset's exact initial angle count from distinct perspectives such as
technical facts, authoritative evidence, risk, adoption, economics,
alternatives, governance, human impact, history, implementation,
counter-arguments, and future scenarios.

Assign each angle one source scope:

- **Public:** only non-sensitive material and only the explicit allowlist.
- **Internal:** only already configured approved internal/local read-only tools;
  no public web.

Public deterministic agents receive allowlisted `web_fetch` only. `web_search`
is intentionally unavailable because its discovery results are not constrained
by configured URL grants.

Never put internal findings into a public-agent prompt. When a downstream critic,
synthesizer, or red team receives any internal content, run it with the internal
read-only scope.

The deterministic adapter creates an empty temporary public-agent cwd outside
the internal repository. Every public researcher, public verifier, and
public-only completeness critic runs there, and the exact generated directory
is removed in `finally`. If isolation cannot be created, mixed/public runs fail
before fan-out. The shared ultracode engine must advertise and enforce
`--disallow-temp-dir` for Copilot read profiles; older engines fail preflight.
Internal agents continue to use the internal `ULTRACODE_CWD`.

## Phase 4 — Research fan-out

Dispatch one required researcher per selected angle. Require the workflow schema:

- `claim`
- `evidence`
- nonempty `sources`
- explicit `loadBearing`
- `confidence`
- `checkedScope`
- `sourceLimitations`
- `negativeFinding`
- `negativeFindingScope`

No source means no finding. A negative finding must state exactly which sources,
versions, dates, or conditions were checked. Required researcher failures remain
in `failures.researchers`, reduce successful coverage, and mark the result
incomplete.

Public citations must be bounded credential-free HTTP(S) URLs covered by
`ULTRACODE_ALLOWED_URLS`. Malformed, out-of-grant, source-free, or negative
findings without a nonblank negative-finding scope are rejected into visible semantic
failure metadata. Internal source identifiers follow internal policy but must
be nonblank.

Copilot grant semantics are protocol-sensitive: a bare domain or wildcard host
grants HTTPS only, while an explicit `http://` or `https://` grant covers only
that protocol. Normalize and require nonblank claim, evidence, checked scope,
and source limitations before accepting any finding.

Canonicalize `DEEPER_RESEARCH_INTERNAL_ANGLES` keys to lowercase. Every
duplicate, unknown, or depth-unselected key fails preflight in one batched
configuration error; a typo or case mismatch must never silently become public.

### Model policy

Use a configurable heterogeneous pool when available:

- cheap models for mechanical discovery and completeness criticism;
- strong models for verification, synthesis, and whole-thesis red-team work;
- rotate families across angles;
- verify with a different family from the researcher when possible;
- use a different family for synthesis/red-team when possible.

If only one model is available, use it everywhere and record
`single-model-fallback`; never fail solely because diversity is unavailable.

## Phase 5 — Bounded completeness loop

Run the depth preset's completeness critic. It returns:

- whether coverage is complete;
- newly discovered, sourced findings;
- newly identified angles;
- remaining gaps.

Treat a critic's requested follow-up scope as a suggestion, not provenance.
Store it as `suggestedSourceScope`, attach `executionSourceScope` from the
actual critic invocation, and discard any returned `sourceScope` field.
Downstream cwd selection uses actual execution/finding/failure provenance only.

Deduplicate new findings by stable angle/claim/source keys and new angles by
normalized key, then sort deterministically. Stop early for `standard` or
`exhaustive` when complete or when a round adds nothing. Never exceed the
preset's round limit. Unresearched suggested angles and remaining gaps stay
visible as incomplete coverage.

Use the midpoint checkpoint only if research exposes a material fork that no
reasonable default can resolve or invalidates the original framing.

## Phase 6 — Quorum verification

Verify every load-bearing finding with the preset vote count. Each independent
verifier returns `verified`, `refuted`, or `unconfirmed`, plus confidence,
reasoning, checked scope, source limitations, and its best source.

Quorum is a strict majority of the configured vote count:

- `quick`: 1 of 1
- `standard`: 2 of 2
- `exhaustive`: 2 of 3

Count only successful verifier envelopes. Failed verifier calls remain in
failure metadata and never count as refutations. Without verified or refuted
quorum, the claim is `unconfirmed`.

A successful verifier envelope is still rejected semantically unless reasoning,
checked scope, source limitations, and best source are nonblank. Public best
sources must also satisfy the configured URL grants. Invalid votes are visible
failures and never contribute to quorum.

## Phase 7 — Synthesis and whole-thesis red team

Run strong-model synthesis only from the structured evidence. Preserve refuted
and unconfirmed items, source limitations, required failures, and incomplete
coverage.

Trim and semantically validate every required synthesis field: thesis, summary,
analysis, recommendation, and each evidence limitation. Likewise validate the
red team's counter-thesis, reasoning, every weak-point field, every
conclusion-flipping claim, and residual doubts. Schema-valid whitespace is a
visible `semantic_validation` failure with `inconclusive` status, never a
completed or `survives`-shaped result.

Synthesis and red-team agents always use `local-read`, never web tools. They use
the internal cwd whenever any included finding, rejected finding, failure,
verification, completeness result, or gap originated internally. Entirely
public payloads use the sanitized public cwd.

Run the whole-thesis red team only when:

- at least two load-bearing claims are verified;
- at least half of required researcher angles succeeded; and
- synthesis completed.

Otherwise emit `adversarialReview.status = skipped` with a concrete reason. If
the red-team call fails, emit `inconclusive` with its failure envelope. Never
return a success-shaped red-team verdict when the evidence gate was not met.

Zero accepted findings or fewer than two verified load-bearing claims always
set `incomplete=true`, mark coverage incomplete, and emit an explicit
`evidenceAssessment.status = inconclusive` reason even when the completeness
critic reported no gaps.

## Phase 8 — Report and end checkpoint

In `embedded` mode, stop after returning the structured evidence bundle. It must
include sources, verified/refuted/unconfirmed states, assumptions, blocking
questions, coverage and failures, synthesis, and red-team status. Do not ask for
a filename, write a report artifact, or offer/perform conversions.

The remaining steps apply only to `standalone` mode.

Fill every section in
[templates/report-template.md](templates/report-template.md). The final report
must expose:

- depth and exact orchestration controls;
- question tree, assumptions, and blocking questions;
- source policy and public/internal separation;
- verified, refuted, and unconfirmed claims;
- source scope and limitations;
- coverage gaps and every required failure;
- synthesis state;
- red-team result or skipped/inconclusive reason;
- deduplicated references.

Propose a kebab-case Markdown filename. If it already exists, obtain explicit
overwrite confirmation before writing. At the end, ask only about a genuinely
blocking output decision or confirmation.

Optional Google Doc, PDF, HTML, or DOCX conversions happen only after the
Markdown report is safely written. Preserve the Markdown if any conversion
fails, report the conversion failure, and do not delete or replace the source
report.

## Runtime fallbacks

- **Claude Code native workflow:** use this path for public Claude research;
  use structured agents and the same presets,
  schemas, source isolation, quorum, completeness bounds, and red-team gate.
- **Copilot CLI + Node:** prefer the shipped template and shared ultracode
  engine.
- **Runtime subagent tool without Node:** drive flat
  dispatch → collect → deduplicate → verify rounds manually, preserving
  structured failure records.
- **No subagents:** proceed sequentially only if necessary, and explicitly mark
  the reduced coverage and verification limitations.

Files in this package: `SKILL.md`, `README.txt`, `evals.json`,
`research.workflow.template.mjs`, and `templates/report-template.md`.
