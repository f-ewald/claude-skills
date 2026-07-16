---
name: session-lessons
description: Mine a local Claude Code or GitHub Copilot CLI session for observable corrections and mistakes, distill them into durable rules, and write only individually confirmed lessons to harness-appropriate global or repository instructions. Use when the user asks to learn from a session, capture mistakes as rules, stop repeated corrections, or update Claude/Copilot instructions from session evidence.
license: MIT
metadata:
  author: Freddy Ewald
compatibility: Claude Code and GitHub Copilot CLI. Requires Node.js 18+; optional installed sqlite3 supports Copilot metadata discovery. Reads only local session files and never requires jq, cloud session stores, or network access.
allowed-tools: Bash(node:*) Bash(sqlite3:*) Bash(git:*)
---

# Session lessons — turn corrections into rules

Analyze local session evidence through one adapter-based workflow, propose only
defensible lessons, and write nothing until the user approves each lesson and
the exact target diff.

**Non-negotiable boundaries**

- Local-only: never call `session_store_sql`, cloud session stores, network APIs,
  or downloaded scripts.
- Observable evidence only: never read private reasoning, chain-of-thought,
  `reasoningText`, or reasoning/thinking blocks.
- Redact credentials, secrets, private identifiers, home-directory identities,
  and unnecessary transcript content before displaying or writing it.
- Never print raw JSONL lines or raw filesystem diagnostics. Report only a
  sanitized source/line and generic parse reason; sanitize every stderr error.
- Phases 1–5 are read-only. Only Phase 6 may write, and only after explicit
  approval of the exact target set and diffs.

Read [the local source schema and discovery reference](references/sources.md) and
[the lesson, routing, and preflight protocol](references/protocol.md) before use.

## 1. Resolve the local session

Default to the current session, but honor overrides in this order:

1. Explicit source, session id, or transcript path from the user.
2. Harness/session environment context.
3. Most recent local session for the current repository.

Use the zero-dependency normalizer:

```bash
node skills/session-lessons/scripts/normalize-session.mjs \
  --source auto --cwd "$(pwd)" --pretty
```

Optional overrides are `--source claude|copilot`, `--session <id>`,
`--input <jsonl>`, and `--home <path>`. The adapters read:

- Claude: `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
- Copilot: `~/.copilot/session-state/<session-id>/events.jsonl`

Copilot discovery may query the local `~/.copilot/session-store.db` through an
installed `sqlite3` binary invoked with argv, never a shell. The normalizer has
no third-party SQLite dependency. State the detected harness/session in one line
and let the user redirect. Skip the turn that invoked this skill.

## 2. Review normalized observable events

The shared event model contains only:

- `actor`: `user`, `assistant`, `system`, or `tool`
- `kind`: `message`, `tool_call`, `tool_result`, or `abort`
- redacted/bounded `text`, timestamp, source, and optional tool status

The JSONL reader tolerates an incomplete final line from a live session, while
rejecting malformed complete lines. Work cheap-signal-first:

1. User corrections and adjacent assistant messages.
2. Repeated corrections.
3. Model self-corrections.
4. Observable tool failures and recoveries.
5. Abort signals, with surrounding observable context.

## 3. Extract and score candidate lessons

Keep a candidate only when a durable written rule would likely prevent the
mistake. Exclude new scope, ordinary iteration, and one-off preferences.

Signal confidence:

- Repeated correction: highest.
- Explicit user correction: high.
- Model self-correction or reproducible tool mistake: medium.
- Abort plus corroborating evidence: supporting evidence only.
- Abort alone: low confidence; do not promote it to a permanent rule.

For each candidate record the mistake, signal, timestamp, a short redacted
quote, proposed imperative rule, scope, harness applicability, and confidence.

## 4. De-duplicate and detect conflicts

Read existing bullets from every proposed target before showing candidates.
Use conservative token overlap/containment from
`scripts/lesson-helpers.mjs` as **semantic-ish de-duplication**. Do not claim
embeddings or semantic search.

- Existing-rule precedence: if an existing rule covers the candidate, drop the
  candidate and note the existing rule.
- If similar rules have opposite polarity or incompatible actions, flag a
  contradiction and ask the user to resolve it. Never auto-merge conflicts.
- Merge repeated evidence for the same candidate rather than proposing duplicate
  rules.

## 5. Present and confirm one by one

First present all surviving candidates in one table and say explicitly:
**nothing has been written yet**.

| # | Signal · confidence | Mistake and redacted evidence | Proposed rule | Target |
| --- | --- | --- | --- | --- |

If there are no genuine lessons, say so and stop.

Then walk candidates in order, one at a time:

1. Show evidence, mistake, proposed rule, and any existing-rule conflict.
2. Ask for **Accept as-is**, **Reject**, or **Rephrase**.
3. For accepted/rephrased rules, confirm global vs repository and Claude,
   Copilot, or shared applicability.
4. Read back rephrased wording before accepting it.

A shared global rule targets both harness files after one explicit confirmation.
Still do not write during this phase.

## 6. Route, preflight, preview, and write

Use `scripts/lesson-helpers.mjs` for deterministic routing and safety checks.

Routing:

- Claude global: `~/.claude/CLAUDE.md`
- Copilot global: `~/.copilot/copilot-instructions.md`
- Shared global: both files after one confirmation
- Claude repository: `<repo>/CLAUDE.md`
- Copilot repository: `<repo>/.github/copilot-instructions.md`

Resolve symlinks portably with Node. If a global path resolves into this
repository's distributed top-level `CLAUDE.md` or `COPILOT.md`, reconcile that
pair together so their shared global rules remain synchronized.

Before every write:

1. Resolve the canonical target path.
2. Stop on company/enterprise-managed or do-not-edit markers.
3. Inspect dirty state for repository targets.
4. Insert under the best existing section without duplicating a rule.
5. Create a write plan with the exact diff and SHA-256 digest of each complete
   proposed replacement.
6. Obtain explicit approval for that exact target set, diff, and digest.
7. Re-read each target and abort if it changed after preview.
8. Verify the supplied replacement matches the approved digest; boolean approval
   alone is insufficient.
9. Acquire an exclusive same-directory advisory lock with `wx`; fail closed and
   never delete an existing unknown lock.
10. Write through an exclusive same-directory temp file, preserve mode where
   applicable, fsync/close, verify, recheck the digest, and atomically rename.
11. Release only the exact owned lock, clean the exact temp file on failure,
    then re-read and verify successful writes exactly. Non-cooperating external
    writers still cause mismatch/blocked handling rather than silent retries.

Never overwrite unrelated dirty changes. Never commit or open a pull request
unless the user separately requests it.

## 7. Report

Summarize accepted, rephrased, rejected, already-covered, and contradictory
candidates. List each verified file and section changed. Mention any blocked
managed file, dirty-state concern, concurrent change, or file-length concern.
