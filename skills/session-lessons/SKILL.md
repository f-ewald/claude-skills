---
name: session-lessons
description: Mine a GitHub Copilot CLI session for mistakes the model made — places where it corrected itself or where the user had to correct it — distill each into a durable, generalizable rule, and, only after the user confirms it one-by-one, append it to the global COPILOT.md instructions or a repo-local instructions file so the same correction doesn't recur across sessions. Use when the user wants to capture lessons from a session, stop repeating the same corrections, turn what went wrong into rules, update their Copilot/global rules from a session, or asks things like "what mistakes did you make?", "learn from this session", or "add what you got wrong to COPILOT.md".
license: MIT
author: Freddy Ewald
compatibility: GitHub Copilot CLI. Reads only local session data (~/.copilot/session-state/<id>/events.jsonl and the session_store_sql tool) and makes no network calls. Requires jq for the on-disk log path.
allowed-tools: Bash(jq:*), Bash(ls:*), Bash(cat:*), Bash(sqlite3:*), Bash(git rev-parse:*), Bash(readlink:*)
---

# Session lessons — turn corrections into rules

Read a Copilot CLI session, find the **mistakes** the model made — the moments where it had to
correct itself, or (worse) where the user had to correct it — distill each into a short, durable
rule, and add the confirmed rules to the user's instructions file so the same mistake doesn't recur
in future sessions. This is how a stateless assistant gains memory: by writing its lessons down.

**Hard rule: change nothing on disk until the user confirms rules in Phase 5.** Phases 1–4 are
strictly read-only — you are reading logs and drafting, not editing. Only Phase 6 writes, and only
the rules the user explicitly confirmed.

**Local only.** This skill reads local session logs and edits local instruction files. It makes no
network calls and runs no downloaded scripts.

## 1. Choose the session(s) to analyze

Default to the **current session**, but let the user redirect:

1. **Explicit override** — if the user named a session id, a past session, or "the last N sessions
   for this repo", use exactly that.
2. **Current session (default)** — your own session id is the folder name in the **`Session folder`**
   path given in your session context (`~/.copilot/session-state/<session-id>/`). That folder's
   `events.jsonl` is the live, full-fidelity log of this conversation.
3. **Recent sessions for this repo** — list candidates with the `session_store_sql` tool (or the
   registry DB) and let the user pick:

   ```sql
   SELECT id, updated_at, substr(summary,1,70) AS summary
   FROM sessions
   WHERE cwd = '<repo dir>'          -- git_root of the current repo
   ORDER BY updated_at DESC LIMIT 10;
   ```

   (Fallback without the tool: `sqlite3 ~/.copilot/session-store.db "SELECT id, updated_at, summary
   FROM sessions WHERE cwd='<repo dir>' ORDER BY updated_at DESC LIMIT 10;"`. Each session's
   `~/.copilot/session-state/<id>/workspace.yaml` also records its `cwd`/`git_root`.)

State the detected scope in one line (e.g. *"Analyzing the current session (1c8d237a…)"*) and let the
user redirect before you dig in. **Skip the turn that invoked this skill** so you don't analyze your
own invocation.

## 2. Read the transcript (read-only)

Prefer the on-disk log — it is the freshest and most complete, especially for the *current* session
whose latest turns may not be flushed to the store yet. For a session id `S`, its log is
`~/.copilot/session-state/S/events.jsonl` (one JSON event per line: `.type`, `.data`, `.timestamp`).

Work cheap-signal-first so long sessions stay affordable:

- **User turns + interrupts** (cheapest, highest signal):

  ```bash
  jq -rc 'select(.type=="user.message" or .type=="abort")
          | {t:.timestamp, type, text:(.data.content // .data.reason // "")}' \
     ~/.copilot/session-state/S/events.jsonl
  ```

- **Model turns** (read the ones *adjacent to* a correction to see what the model actually did;
  `.data.content` is the reply, `.data.reasoningText` its reasoning):

  ```bash
  jq -rc 'select(.type=="assistant.message")
          | {t:.timestamp, text:(.data.content[0:400])}' \
     ~/.copilot/session-state/S/events.jsonl
  ```

- **Tool failures** the model then worked around: events of type `tool.execution_complete` with a
  failure result, near a retry.

(The `session_store_sql` tool exposes the same material as `turns` — `user_message` /
`assistant_response` — and `events`; use it instead if you prefer SQL or are mining several past
sessions at once.)

## 3. Extract candidate mistakes

Scan for evidence that the model got something wrong. Classify each candidate by how it surfaced:

- **User correction (strongest).** A user turn pushing back on what the model just did or said —
  cues like *"no", "don't", "stop", "that's wrong", "that's not what I asked", "actually", "why did
  you", "you should have", "I told you", "revert / undo", "not like that", "instead", "you broke"* —
  **or** an `abort` event (`reason: user_initiated`), i.e. the user interrupted the model mid-action.
  Read the preceding model turn(s) to see exactly what it did wrong and what the user wanted instead.
- **Model self-correction.** A model turn admitting or repairing its own error — *"you're right",
  "apologies / sorry", "my mistake", "that was incorrect", "let me fix / revert", "I should have",
  "I misread", "on second thought"* — or the model undoing a change it made moments earlier, or a
  tool failure caused by a wrong assumption that it then had to fix.
- **Repeated correction (high priority).** The same class of mistake corrected more than once — in
  one session or across the selected sessions. These are precisely the "same thing over and over"
  worth a permanent rule; flag them first.

For each candidate capture: **what the model did** (the mistake), **how it surfaced** (which signal,
plus a turn timestamp and a short verbatim quote as evidence), and the **generalizable lesson**.

**Filter out non-lessons** — keep false positives low:
- A user adding new scope ("actually, also do X") is a *new request*, not a correction.
- One-off preferences unlikely to recur, and normal iterative refinement, are not rules.
- The test for keeping a candidate: *would a written rule have prevented this mistake from recurring?*
  If not, drop it. Report only real, defensible lessons — do not pad.

## 4. Draft rules and present the table

For each surviving candidate, write a **concise, imperative rule** in the style of the existing
`COPILOT.md` bullets (short, one line where possible, an optional parenthetical *why*). De-duplicate
against rules **already present** in the target files (see Phase 6) — if a lesson is already covered,
drop it (you may note it was already covered). Suggest, for each, a **target** (global `COPILOT.md`
vs. a repo-local instructions file) and a **section** (e.g. *Code Style*, *Safety…*, *Git commits*,
or a new one).

Present every candidate in a single markdown table, and state explicitly that **nothing has been
written yet**:

| # | Signal | Mistake (evidence) | Proposed rule | Suggested target · section |
|---|--------|--------------------|---------------|----------------------------|
| 1 | User correction | One-line mistake + short quote (ts). | The imperative rule. | global · Code Style |
| 2 | Repeated | … | … | repo-local · Testing |

If no genuine lessons were found, say so plainly and stop — an empty, honest result is a valid one.

## 5. Confirm each lesson one-by-one

Walk the candidates **in order, one at a time — never as a group**. For each, show the evidence
quote(s), the mistake, and the proposed rule, then ask the user to decide with a multiple-choice
question:

- **Accept as-is** — take the rule as written.
- **Reject** — it wasn't really a mistake, or the user doesn't want a rule; drop it entirely.
- **Rephrase** — the user reworks the wording or scope; capture the revision, read it back to
  confirm, and use the agreed version.

For every **accepted or rephrased** rule, also confirm **where it goes**, defaulting to your
suggestion but letting the user switch:

- **Global `COPILOT.md`** — applies to every future session (the user's personal instructions).
- **Repo-local instructions file** — applies only inside this repository.

Only accepted/rephrased rules proceed. Still nothing is written.

## 6. Write the confirmed rules

Locate each target and append surgically. **Write only to the chosen instructions file(s); do not
edit any other rules file** (e.g. leave `CLAUDE.md` untouched — the user opted out of mirroring).

- **Global `COPILOT.md`** = the Copilot personal-instructions file at
  `~/.copilot/copilot-instructions.md`. If that path is a **symlink** (a common setup points it at a
  repo-tracked `COPILOT.md`), edit the **resolved real file** (`readlink -f`) so the change lands in
  the tracked source, not a dangling copy. If the user has this repo's `COPILOT.md` open/tagged, that
  is the same file — edit it directly. If no such file exists, ask where the global rules live.
- **Repo-local** = `<repo root>/.github/copilot-instructions.md` (repo root via
  `git rev-parse --show-toplevel`). Create it with a minimal header if it doesn't exist, only after
  the user confirmed a repo-local rule.

For each confirmed rule: insert it as a bullet under the **best-matching existing section**, or add a
new `## <Topic>` section if none fits. Match the surrounding bullet style, and don't duplicate a rule
already present. Keep the file tidy — if additions push a global rules file well past its ~200-line
guidance, mention it so the user can prune.

## 7. Wrap up

Summarize what was **accepted, rephrased, and rejected**; **which file** each new rule went into
(global vs. repo-local) and under which section; any candidates that were **already covered**; and
whether any file is now near/over its length guidance. Offer next steps — e.g. review the diff, or
commit — but **don't commit and never open a PR** unless the user explicitly asks.
