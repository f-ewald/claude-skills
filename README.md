# Cross-harness Agent Skills

* `skills/` contains reusable Agent Skills shared by Claude Code and GitHub Copilot.
* `CLAUDE.md` contains the global rules for Claude Code.
* `COPILOT.md` contains the equivalent global rules for GitHub Copilot CLI.
* `programming-standards/` contains per-language coding standards and required libraries (e.g. `python.md`).

## Changelog

[`CHANGELOG.md`](CHANGELOG.md) is generated from the repository's first-parent
commit history, grouped by commit date. Update it locally with:

```bash
node scripts/update-changelog.mjs
```

Use `node scripts/update-changelog.mjs --check` to verify that it is current.
Commits whose subject contains `[skip changelog]` are omitted.

The SHA-pinned, GitHub-owned workflow at
[`.github/workflows/update-changelog.yml`](.github/workflows/update-changelog.yml)
runs after each push to `main` and commits an updated file with the repository's
`GITHUB_TOKEN`. Repository Actions settings must permit workflow write access.
The workflow runs only the checked-in generator and does not install third-party
plugins, hooks, packages, or scripts.

## Install

Clone this repository, then expose the shared skills through each harness's
personal discovery path. Do not run a whole-directory `ln -s` command when the
destination already exists: `ln` would create an incorrectly nested `skills/`
entry.

**Claude Code:**

```bash
mkdir -p "$HOME/.claude/skills"
for skill in /path/to/claude-skills/skills/*; do
  target="$HOME/.claude/skills/$(basename "$skill")"
  [ -e "$target" ] || ln -s "$skill" "$target"
done

# Run these only when each destination is absent.
ln -s /path/to/claude-skills/CLAUDE.md ~/.claude/CLAUDE.md
ln -s /path/to/claude-skills/programming-standards/ ~/.claude/programming-standards
ln -s /path/to/claude-skills/statusline.sh ~/.claude/statusline.sh
```

**GitHub Copilot CLI:**

```bash
copilot skill add /path/to/claude-skills/skills

# Run these only when each destination is absent.
ln -s /path/to/claude-skills/COPILOT.md ~/.copilot/copilot-instructions.md
ln -s /path/to/claude-skills/programming-standards/ ~/.copilot/programming-standards
```

Copilot CLI also supports per-skill links under `~/.copilot/skills/` or
`~/.agents/skills/`. A personal
`~/.claude/skills/` symlink is discovered by Claude Code and VS Code, but not by
Copilot CLI. Project-level `.github/skills/`, `.agents/skills/`, and
`.claude/skills/` are supported by Copilot CLI.

> **Company-managed rules:** If `~/.claude/CLAUDE.md` is already provided and managed by your company, don't overwrite it. Symlink this repo's rules under an alternate name instead (e.g. `ln -s /path/to/claude-skills/CLAUDE.md ~/.claude/CLAUDE.personal.md`) so the company file stays intact, and reference the personal file from the company-managed `CLAUDE.md` (e.g. with an `@CLAUDE.personal.md` import) if you want both to apply.

Update your `~/.claude/settings.json` and add the following as a root level key:

```
"statusLine": {
    "type": "command",
    "command": "bash /path/to/claude-skills/statusline.sh"
}
```

## GitHub Copilot status line

[`statusline_copilot.sh`](statusline_copilot.sh) is a status line for **GitHub Copilot CLI**, separate from the Claude Code `statusline.sh` above. It renders:

```
[Opus 4.8 (1M context) · max] █████████████░░░░░░░ 65% | 650.0k/1m | ↑1.2m ↓45.6k | 536 AIC · 99.5% left
```

| Segment | Meaning |
| --- | --- |
| `[Opus 4.8 (1M context) · max]` | Model display name, context-window size, and the effort level read from `~/.copilot/settings.json` |
| `█████░░░ 65%` | Current context-window (memory) usage; green `<60%`, yellow `≥60%`, red `≥80%` |
| `650.0k/1m` | Context tokens used / context-window size |
| `↑1.2m ↓45.6k` | Session-cumulative tokens sent (input) / received (output) |
| `536 AIC` | AI compute used this session (`total_nano_aiu / 1e9` — the value Copilot's footer shows) |
| `99.5% left` | Remaining monthly premium-interaction quota (relevant on token-based billing) |

Wire it into `~/.copilot/settings.json` as a root-level key (use an absolute path):

```json
"statusLine": {
    "type": "command",
    "command": "/path/to/claude-skills/statusline_copilot.sh",
    "padding": 0
}
```

Notes:

* Copilot reads `statusLine` at startup — restart the CLI (or run `/restart`) after editing settings.
* The quota segment calls `gh api /copilot_internal/user` in a detached background job and caches the result at `~/.copilot/.statusline-quota-cache.json` (5-minute TTL), so renders never block on the network. It needs an authenticated `gh`; if `gh` is unavailable the segment is simply omitted.
* Tunables at the top of the script: `QUOTA_ENABLED`, `QUOTA_TTL_MIN`, `USE_COLOR` (or export `NO_COLOR`). `SL_QUOTA_*` environment variables override the quota settings for testing.

## Directory-scoped `copilot` shell function

> **Note:** This applies to **GitHub Copilot CLI only** — it resumes Copilot sessions and is unrelated to Claude Code's own session handling.

Add this function to your shell startup file — `~/.zshrc` (zsh) or `~/.bashrc` (bash) — instead of a plain alias. It resumes the most recent Copilot session for the **current directory**, so each project keeps its own independent conversation history. Falls back to a fresh session when none exists yet.

The function reads Copilot's session registry — the SQLite database at `~/.copilot/session-store.db` — and selects the most recently updated session whose `cwd` matches the current directory, so it only calls `--resume` with a known-valid session ID. This avoids the "No session matched" error that occurs when deriving the session ID from session files directly (those files exist even for sessions that are no longer resumable). It requires the `sqlite3` binary; if `sqlite3` isn't installed, the function says so and starts a new session instead.

**zsh** — add to `~/.zshrc`:

```zsh
# Resume the most recent Copilot session for the current directory.
# Reads Copilot's SQLite session registry (~/.copilot/session-store.db) so we
# only call --resume with a known-valid session ID, avoiding spurious error output.
copilot() {
  local session_id db="$HOME/.copilot/session-store.db" cwd_q
  # Escape single quotes so the path is a safe SQL string literal.
  cwd_q=${PWD//\'/\'\'}

  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "copilot: sqlite3 not found — cannot look up the previous session for this directory; starting a new session instead." >&2
  elif [[ -f "$db" ]]; then
    session_id=$(sqlite3 "$db" \
      "SELECT id FROM sessions WHERE cwd='$cwd_q' ORDER BY updated_at DESC LIMIT 1;" 2>/dev/null)
  fi

  if [[ -n "$session_id" ]]; then
    command copilot --yolo --resume "$session_id"
  else
    command copilot --yolo
  fi
}
```

**bash (Linux)** — add to `~/.bashrc`:

```bash
# Resume the most recent Copilot session for the current directory.
# Reads Copilot's SQLite session registry (~/.copilot/session-store.db) so we
# only call --resume with a known-valid session ID, avoiding spurious error output.
copilot() {
  local session_id db="$HOME/.copilot/session-store.db" cwd_q
  # Escape single quotes so the path is a safe SQL string literal.
  cwd_q=${PWD//\'/\'\'}

  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "copilot: sqlite3 not found — cannot look up the previous session for this directory; starting a new session instead." >&2
  elif [[ -f "$db" ]]; then
    session_id=$(sqlite3 "$db" \
      "SELECT id FROM sessions WHERE cwd='$cwd_q' ORDER BY updated_at DESC LIMIT 1;" 2>/dev/null)
  fi

  if [[ -n "$session_id" ]]; then
    command copilot --yolo --resume "$session_id"
  else
    command copilot --yolo
  fi
}
```

After adding it, reload your shell config — `source ~/.zshrc` (zsh) or `source ~/.bashrc` (bash). Sessions persist until you run `/clear` inside Copilot.

## GitHub Copilot global rules

[`COPILOT.md`](COPILOT.md) is the GitHub Copilot CLI counterpart to [`CLAUDE.md`](CLAUDE.md): the same always-on global coding rules (code style + destructive-command safety), for the Copilot harness. Distribute it the same way you symlink `CLAUDE.md`, but into Copilot's personal-instructions location:

```bash
ln -s /path/to/claude-skills/COPILOT.md ~/.copilot/copilot-instructions.md
ln -s /path/to/claude-skills/programming-standards/ ~/.copilot/programming-standards
```

Copilot CLI reads `~/.copilot/copilot-instructions.md` as personal (global) custom instructions, so these rules then apply in every Copilot session. Keep `COPILOT.md` in sync with `CLAUDE.md`.

> **Company-managed rules:** If `~/.copilot/copilot-instructions.md` is already provided and managed by your company, don't overwrite it. Symlink this repo's rules under an alternate name instead (e.g. `ln -s /path/to/claude-skills/COPILOT.md ~/.copilot/copilot-instructions.personal.md`) so the company file stays intact, and reference the personal file from the company-managed instructions if you want both to apply.

> Not to be confused with [`.github/copilot-instructions.md`](.github/copilot-instructions.md), which documents *this repo's* architecture and is auto-loaded only when working inside this repo.

## Using these skills in GitHub Copilot

These skills use the open Agent Skills (`SKILL.md`) standard, which GitHub Copilot also supports —
see [docs/using-skills-in-copilot.md](docs/using-skills-in-copilot.md) for step-by-step instructions.

## Skill catalog and safety

<!-- skill-catalog:start -->
| Skill | Primary output | Prerequisites | Network | Writes / destructive behavior |
| --- | --- | --- | --- | --- |
| `adversarial-review` | Curated fixes to the user's changes | Git | None | Read-only until plan approval; surgical edits afterward; no commit or push |
| `deeper-research` | Cited Markdown research report | Node 18+, sibling ultracode; approved sources | Opt-in public web or configured read-only internal tools | Report only; no destructive actions |
| `design-doc` | Reviewed Markdown RFC; optional Google Doc | grill-me and deeper-research contracts | Research sources; optional approved Google Docs | Confirms before replacing a file |
| `grill-me` | In-chat decision ledger and final reconciliation | None | None | Read-only and chat-only unless an artifact is explicitly requested |
| `pr-review` | One confirmed GitHub pull-request review | Authenticated gh | GitHub or GHES API | Posts only confirmed comments; submission is explicit |
| `session-lessons` | Confirmed durable instruction rules | Node 18+ and local harness transcripts | None | Previews and confirms each local instruction-file edit |
| `ultracode` | Structured multi-agent workflow result | Node 18+ and a supported agent CLI | None in local-read; opt-in in research-read | Read-only by default; write/exec requires an explicit profile |
| `worklog` | Local worklog entries and summaries | Node 18+ and wl 0.4.x | Only an explicitly confirmed wl github operation | Uses a JSON-to-argv adapter; confirms initialization, imports, bulk writes, and overwrites |
<!-- skill-catalog:end -->

All packages support Claude Code and GitHub Copilot unless their
`compatibility` field says otherwise. `allowed-tools` is experimental Agent
Skills metadata: Claude may honor narrow command grants, while Copilot CLI may
prompt through its own permission system. Do not replace those prompts with
broad shell approval.

### `adversarial-review`

Use for a skeptical review of your own uncommitted work or branch. It confirms
the review scope, treats source content as untrusted, reports only defensible
findings, and lets you accept, reject, or rephrase fixes one-by-one. Validation
must pass before a fix is marked done.
[Contract](skills/adversarial-review/SKILL.md)

### `deeper-research`

Use for exhaustive, multi-perspective research with explicit assumptions,
source-backed findings, verifier voting, completeness criticism, and a
conclusion red-team. It is the portable custom workflow; Claude Code's bundled
`/deep-research` remains available separately.
[Contract](skills/deeper-research/SKILL.md) ·
[CLI guide](skills/deeper-research/README.txt)

### `design-doc`

Use when the deliverable is an RFC or technical design. It composes the
`grill-me` interview and `deeper-research` evidence contracts, obtains
recommendation sign-off, and writes only to a confirmed target. Google Docs
conversion is optional; Markdown remains the fallback.
[Contract](skills/design-doc/SKILL.md)

### `grill-me`

Use for a standalone design stress test. It asks one decision at a time,
provides a recommended default and rationale, grounds factual questions in the
codebase, and maintains an in-chat ledger until every material branch is
reconciled.
[Contract](skills/grill-me/SKILL.md)

### `pr-review`

Use with a GitHub or GHES pull-request URL. It pins the reviewed head SHA,
supports added and deleted line locations, and inventories pending reviews. A
conservative manifest/lockfile-only fast path checks CI for the pinned head and
can recommend an explicitly confirmed approval for version-only changes. It
posts only confirmed content and never silently submits a partial review.
[Contract](skills/pr-review/SKILL.md)

### `session-lessons`

Use to turn observable corrections from a local Claude Code or Copilot CLI
session into durable rules. It normalizes local transcripts, redacts sensitive
evidence, detects duplicate or conflicting rules, previews exact diffs, and
writes only after per-rule confirmation.
[Contract](skills/session-lessons/SKILL.md)

### `ultracode`

Use for explicit multi-agent orchestration. Claude Code can use its native
workflow facilities; Copilot CLI can use the bundled zero-dependency engine.
The custom skill is separate from any harness-native effort level or workflow
feature. Workflows use structured success/failure envelopes and local-read
permissions by default.
[Contract](skills/ultracode/SKILL.md) ·
[CLI guide](skills/ultracode/README.txt)

### `worklog`

Use to add or inspect personal entries through the local `wl` CLI. All
user-provided values pass as argument arrays through the bundled adapter rather
than shell interpolation. Queries are narrowed to the needed dates/projects,
and sensitive or bulk operations require confirmation.
[Contract](skills/worklog/SKILL.md)

## Validate the portfolio

No package manager is required:

```bash
node scripts/validate-skills.mjs
node --test tests/*.test.mjs
```

The validator intentionally supports only this repository's bounded
frontmatter shape; it is not a general YAML or JSON Schema implementation.

After adding or changing a skill, restart or reload the active harness. For
Copilot CLI, inspect discovery with `copilot skill list`. For VS Code, reload
the window. If a skill is missing, verify that the folder matches `name:`, the
description says what the skill does and when to use it, and the symlink or
custom directory resolves.
