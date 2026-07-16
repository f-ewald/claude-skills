---
name: ultracode
description: Use when the user invokes /ultracode, asks to run a task "like ultracode", at maximum thoroughness, or with multi-agent orchestration. Activates standing multi-agent orchestration mode for the current task. Runtime-agnostic — works on Claude Code (Workflow tool) and Copilot CLI (parallel task subagents).
---

# Ultracode — Standing Multi-Agent Orchestration Mode

## Overview

Invoking this skill is an explicit, standing opt-in to multi-agent orchestration for the **current task**. Adopt this posture: fan work out to coordinated subagents for every substantive step instead of doing it solo. The goal is the most exhaustive, correct answer you can produce — **token cost is not a constraint.**

This works on any runtime that can dispatch subagents. The **patterns are identical everywhere; only the mechanism differs.** First detect your runtime (see *Pick your execution mechanism*), then apply the patterns with that runtime's tools.

Invoking this skill **is the authorization**: it grants standing permission to orchestrate subagents/workflows for the rest of the task — do not re-ask before each round.

## The mandate (in force until the user ends the task or says "stop ultracode")

1. **Default to orchestrating, not soloing.** For every substantive step, fan work out to subagents. Work solo ONLY on conversational turns or trivial mechanical edits (a one-line fix, a rename, a direct factual answer).
2. **One orchestration round per phase, in sequence.** Multi-phase work (understand → design → implement → review) is several rounds run back-to-back — one per phase — so you stay in the loop and read each phase's result before launching the next.
3. **Adversarially verify findings.** Never trust a single subagent's claim. Apply a quality pattern below before committing to a conclusion — unless the work is trivial or already verified.
4. **Scale to the ask.** Quick check → a few finders, single-vote verify. "Audit / thorough / be comprehensive" → larger finder pool, 3–5-vote adversarial pass, synthesis stage.

## Quality patterns (runtime-independent — use by name)

- **Adversarial verify** — N independent skeptics per finding, each prompted to *refute*; default the verdict to "not real" and kill the finding on majority.
- **Perspective-diverse verify** — give each verifier a distinct lens (correctness, security, perf, does-it-reproduce).
- **Judge panel** — N independent attempts from different angles, scored by parallel judges, synthesized from the winner.
- **Multi-modal sweep** — parallel subagents each searching a different way (by-container, by-content, by-entity, by-time).
- **Loop-until-dry** — keep dispatching finders in successive rounds until K consecutive rounds surface nothing new.
- **Completeness critic** — a final subagent asks "what's missing?"; its answer becomes the next round of work.

Canonical shape: **find → dedup → adversarially verify → synthesize.** Dedup/merge in your own reasoning between rounds; only the find and verify steps need to fan out.

## Pick your execution mechanism (detect your runtime by the tools you have)

### Claude Code — use the `Workflow` tool (preferred: deterministic)

You have a `Workflow` tool. Author and run a JS orchestration script per phase. It gives you `pipeline()` (no barrier between stages — the default), `parallel()` (barrier), `agent(prompt, {schema})` for **validated** structured output, loops, and a shared token budget. This is the richest path — prefer it for any fan-out beyond ~3 subagents or any multi-stage find→verify pipeline. See the `Workflow` tool description for the full API and pattern recipes.

Tiny-fan-out fallback: issue multiple `Agent`/`Task` calls in one message (they run in parallel) and synthesize the results yourself.

### Copilot CLI (and any runtime with subagents but no workflow engine)

You have a `task` tool (`agent_type: general-purpose | explore | research | code-review | …`) and a `bash` tool, but **no `Workflow` tool**. Two ways to orchestrate — prefer **Option A** when Node is available, because it restores deterministic control flow.

#### Option A — deterministic JS engine (preferred; closest parity with `Workflow`)

This skill ships a zero-dependency Node engine, **`orchestrate.mjs`**, that gives you
`agent()` / `map()` / `parallel()` / `pipeline()` / `synthesize()` / `run()`. It
provides concurrency control, bounded recursive schema validation, one overall
deadline per agent, side-effect-aware retries, process-tree cancellation, and
structured result envelopes.

1. **Create a session workspace outside the installed skill directory.** Copy
   `workflow.template.mjs` there and edit its CONFIG block and prompts. The template
   resolves the installed engine through `ULTRACODE_ENGINE`, so generated run files
   never need to live inside a copied or symlinked skill.
2. **Run it from the repository being inspected**, setting an explicit subagent cwd:
   ```bash
   ULTRACODE_ENGINE="$HOME/.copilot/skills/ultracode/orchestrate.mjs" \
   ULTRACODE_CWD="$PWD" ULTRACODE_CLI=copilot \
   node .copilot-session/my-workflow.mjs src/example.mjs
   ```
   The default `local-read` profile exposes only `view`, `rg`, and `glob`.
   Copilot read profiles also pass `--disallow-temp-dir`, so their automatic
   file boundary is the explicit cwd even when that cwd itself is under the
   system temporary directory.
   The engine advertises this contract through
   `ENGINE_CAPABILITIES.copilotReadDisallowTempDir=true`, allowing composed
   workflows to fail closed against older engines.
   Research workflows must opt in to `web_fetch`. `web_search` is intentionally
   unavailable because URL grants do not constrain it. Copilot also requires an
   explicit URL/domain allowlist:
   ```bash
   ULTRACODE_PROFILE=research-read \
   ULTRACODE_ALLOWED_URLS='https://docs.example.com,api.example.com' ...
   ```
   A workflow may instead pass
   `agent(prompt, {profile: 'research-read', allowedUrls: ['https://docs.example.com']})`.
   Grant only required destinations; there is no global wildcard or all-URL
   fallback. Deterministic `ULTRACODE_CLI=claude` research-read fails closed
   because this engine cannot enforce URL grants for Claude; use Claude's native
   Workflow/runtime permission controls for research. Claude local-read remains
   supported.
   Editing or command execution requires the explicit `write` profile and an
   `effect: 'write'` or `effect: 'exec'` agent option. Write-capable agents default
   to zero retries; a retry requires both `idempotent: true` and an explicit retry
   count. Write profiles also disallow automatic temp-directory access by default;
   opt in only when required with `allowTempDir: true` or
   `ULTRACODE_ALLOW_TEMP_DIR=true`.
3. **Read the final envelope** from stdout. `agent()` and `run()` return
   `{ok:true,value,attempts,meta?}` or
   `{ok:false,error:{kind,message,...},attempts,meta?}`. Required stage failures
   remain visible instead of becoming `null`. Progress and bounded diagnostics go
   to stderr or envelope metadata.

Important knobs: `ULTRACODE_CWD`, `ULTRACODE_PROFILE`,
`ULTRACODE_DEADLINE_MS`, `ULTRACODE_CONCURRENCY`, `ULTRACODE_RETRIES`,
`ULTRACODE_MODEL`, and `ULTRACODE_INHERIT_INSTRUCTIONS`. Instruction inheritance
defaults off and must be deliberately enabled. The same engine supports
`ULTRACODE_CLI=claude` for cross-runtime workflows.

#### Option B — model-driven loop (no Node; always works)

You — the main agent loop — *are* the orchestrator. There is no script and no schema enforcement, so run each phase as an explicit **dispatch → collect → verify** cycle that you drive by hand:

1. **Fan out a round.** Issue multiple `task` calls **in a single response** so they run concurrently — one per finder / review-dimension / search-angle. In each subagent's prompt, specify the exact output contract: **"Return ONLY a JSON object of this shape: {…}. No prose."** (You enforce the schema by parsing, since the runtime won't.)
2. **Collect the round.** Wait for the batch, parse each subagent's JSON from its final message. Use `list_agents` / `read_agent` to check status or pull output. Gathering the whole round before proceeding is a **barrier** — true per-item pipelining needs a script, so barrier-per-round is the expected shape here and is fine.
3. **Dedup & decide** in your own reasoning (this replaces the script's dedup step).
4. **Verify round.** Fan out a second batch of `task` calls — one skeptic per surviving finding, each prompted to *refute* it and return a JSON verdict (`{isReal, confidence, reasoning}`). Collect, then keep only findings the verifiers confirm.
5. **Loop when the pattern calls for it** (loop-until-dry, loop-until-count, completeness-critic): repeat the cycle in the next turn until the stop condition holds. Track rounds with `update_todo`; persist cross-round facts with `store_memory` if useful.

Keep batches **flat** — the main loop dispatches; subagents don't nest. Cap each round to a handful of concurrent `task` calls and run successive rounds across turns. The result is the same find→verify→synthesize behavior as the Claude Code path, executed by your reasoning loop instead of a script.

## How to run it (both runtimes)

1. **Restate** the task in one line and **decompose into phases** (understand / design / implement / review — drop any that don't apply).
2. **Scout inline first if the work-list is unknown** — list the files, find the channels, scope the diff — then fan out over what you found.
3. **Run phase 1** via your runtime's mechanism above. Read the structured results.
4. **Stay in the loop between phases** — summarize what each phase found and what the next one will do — then run the next phase. Repeat until the task is complete and verified.

## Red flags — you are drifting out of ultracode mode

| Thought | Reality |
|---|---|
| "This is faster if I just do it myself" | The user opted into thoroughness over speed. Orchestrate. |
| "One subagent already answered this" | Single-agent claims are unverified. Run a verify round. |
| "I'll skip the subagents just for this step" | Only conversational turns and trivial edits are exempt. |
| "I found enough, I can stop searching" | Use loop-until-dry / completeness critic before concluding. |
| "No Workflow tool here, so I can't orchestrate" | Wrong — dispatch parallel `task` subagents and drive the loop yourself. |
| "Re-confirm with the user before the next round" | Authorization is standing for the whole task. Proceed. |

Stay in this mode for the remainder of the task. Revert only when the user ends the task or explicitly says to stop.

---

**Files in this skill.** `SKILL.md` (this file), plus the deterministic-engine support files: `orchestrate.mjs` (the engine) and `workflow.template.mjs` (copy-and-adapt example). Keep all three together — Option A needs the `.mjs` files alongside `SKILL.md`.

**Install locations differ per runtime.** Claude Code reads `~/.claude/skills/`; Copilot CLI reads `~/.copilot/skills/` or the cross-runtime alias `~/.agents/skills/` (shared with Codex/Gemini). To share this skill, symlink or copy the whole `ultracode/` directory (not just `SKILL.md`) into the other runtime's directory.
