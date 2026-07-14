# Collection of Claude Skills

* `skills/` contains the actual skills, organized by category.
* `CLAUDE.md` contains the global rules that apply to all Claude sessions.
* `programming-standards/` contains per-language coding standards and required libraries (e.g. `python.md`).


## How to use

1. Clone this repository to your local machine
2. Create a symlink to the `skills/` directory inside your `~/.claude/` folder
```bash
ln -s /path/to/claude-skills/skills/ ~/.claude/skills
ln -s /path/to/claude-skills/CLAUDE.md ~/.claude/CLAUDE.md
ln -s /path/to/claude-skills/programming-standards/ ~/.claude/programming-standards
ln -s /path/to/claude-skills/statusline.sh ~/.claude/statusline.sh
```

> **Company-managed rules:** If `~/.claude/CLAUDE.md` is already provided and managed by your company, don't overwrite it. Symlink this repo's rules under an alternate name instead (e.g. `ln -s /path/to/claude-skills/CLAUDE.md ~/.claude/CLAUDE.personal.md`) so the company file stays intact, and reference the personal file from the company-managed `CLAUDE.md` (e.g. with an `@CLAUDE.personal.md` import) if you want both to apply.

Update your `~/.claude/settings.json` and add the following as a root level key:

```
"statusLine": {
    "type": "command",
    "command": "bash /home/fewald/.claude/statusline.sh"
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

## Adversarial review — critique your own changes

[`skills/adversarial-review/`](skills/adversarial-review/) turns the agent into a hostile reviewer of
**your own** work: it auto-detects your changes (uncommitted, else the current branch vs its base),
hunts for real flaws and action items, and presents them as a summary table — **changing nothing on
disk**. It then offers to build a fix **todo list** you curate one-by-one (**accept as-is / reject /
rephrase**), and only after you approve the plan does it implement the fixes, one at a time.

**Invoke it** by asking for an *"adversarial review"* of your changes (or *"critically review what I
just wrote"*). See [`skills/adversarial-review/SKILL.md`](skills/adversarial-review/SKILL.md) for the
full phase-by-phase contract.

## Session lessons — turn corrections into rules

[`skills/session-lessons/`](skills/session-lessons/) gives a stateless assistant a memory: it reads a
Copilot CLI session, finds the **mistakes** the model made — where it corrected itself, or where you
had to correct it (including turns you interrupted) — and distills each into a short, durable rule. It
presents the candidates as a summary table **without writing anything**, walks them **one-by-one**
(**accept / reject / rephrase**), and only then appends each confirmed rule — to your global
[`COPILOT.md`](COPILOT.md) or a repo-local `.github/copilot-instructions.md`, as you choose per rule —
so the same correction doesn't recur next session.

**Invoke it** by asking to *"learn from this session"*, *"what mistakes did you make?"*, or to *"add
what you got wrong to COPILOT.md"*. It reads only local session data and makes no network calls. See
[`skills/session-lessons/SKILL.md`](skills/session-lessons/SKILL.md) for the full phase-by-phase contract.

## Ultracode — multi-agent orchestration skill

[`skills/ultracode/`](skills/ultracode/) is a heavier skill that puts the agent into a standing
**multi-agent orchestration** mode for a task: rather than working solo, it fans each step out to
parallel subagents, adversarially verifies every finding, then synthesizes
(`find → verify → synthesize`). It is **cross-harness** — on Claude Code it drives the native
`Workflow` tool; on the **GitHub Copilot CLI** it ships its own zero-dependency Node engine
([`orchestrate.mjs`](skills/ultracode/orchestrate.mjs)) that reproduces the same deterministic
fan-out by shelling out to real `copilot -p` subagents.

**Invoke it** by asking to *"use ultracode"* (or `/ultracode`) at the start of a task — that is the
standing opt-in to orchestration for the rest of that task.

**On the Copilot CLI (deterministic engine):**

```bash
cd /path/to/claude-skills/skills/ultracode
cp workflow.template.mjs my-review.mjs         # edit the CONFIG block + prompts for your task
ULTRACODE_CLI=copilot node my-review.mjs path/to/file
```

Subagents are **read-only by default** (a view/search allowlist — no file writes or arbitrary
shell); opt into full autonomy with `ULTRACODE_PERMS=all` only when a workflow must edit files or
run commands. See [`skills/ultracode/README.txt`](skills/ultracode/README.txt) for the full Copilot
guide (install, Options A/B, env vars, troubleshooting) and
[`skills/ultracode/SKILL.md`](skills/ultracode/SKILL.md) for the behavioral contract.

> Verified end-to-end on the Copilot CLI — the engine drives real `copilot -p` subagents through
> the find → adversarially-verify → synthesize pipeline.

## Deep research — autonomous multi-perspective research

[`skills/deep-research/`](skills/deep-research/) fuses two of the skills above into an **autonomous
researcher**. It decomposes a question into as wide a set of sub-questions as possible (the
**grill-me** move) but — unlike grill-me — **auto-answers** each one the way a reasonable person
would, logging every decision to an **"Assumptions made"** ledger instead of interrupting you. It
then fans the investigation out to parallel subagents, one per perspective (technical, adoption,
economics, risk, alternatives, counter-arguments…), **adversarially verifies** the load-bearing
claims, and synthesizes a **cited markdown report**. The user is pulled in only at three
checkpoints — **start**, **mid-research**, **end** — and only for genuinely blocking decisions, so
the agents run long and autonomously.

It **reuses the ultracode engine by reference** — its workflow template imports
[`../ultracode/orchestrate.mjs`](skills/ultracode/orchestrate.mjs), so install both skills side by
side. On Claude Code it uses the native `Workflow` tool; with no orchestration at all it degrades to
sequential research. Sourcing is **company-agnostic**: internal MCP research tools are used only if
connected, otherwise web-only.

**On the Copilot CLI:**

```bash
cd /path/to/claude-skills/skills/deep-research
cp research.workflow.template.mjs research.run.mjs      # edit TOPIC + ANGLES
ULTRACODE_CLI=copilot node research.run.mjs "Your research question" > result.json
```

For more diverse perspectives it can also spread researchers across a **heterogeneous model pool** —
rotating model families and using cheap models for easy angles, stronger models for hard reasoning
and verification — via the workflow's `MODELS` config or the `ULTRACODE_MODELS` env var (best-effort:
it falls back to a single model when a pool isn't available).

Research subagents are **read-only** — never set `ULTRACODE_PERMS=all` for a research run. The
markdown report can optionally be converted to other formats by delegating (e.g. the
`write-google-docs` skill, or `pandoc` for PDF/HTML). **Invoke it** by asking for *"deep research
on …"* or an *"exhaustive multi-perspective investigation"*. See
[`skills/deep-research/SKILL.md`](skills/deep-research/SKILL.md) for the full phase-by-phase
contract and [`skills/deep-research/README.txt`](skills/deep-research/README.txt) for the Copilot
CLI run guide.

## Worklog — drive the `wl` CLI as a skill

[`skills/worklog/`](skills/worklog/) is a **command-interface** skill that lets the agent operate a
personal work log through the `wl` CLI — a stand-in for a
worklog **MCP server** (MCP integrations are disallowed in some environments, so this skill is the
workaround). It maps natural-language requests onto `wl` subcommands: `add` an entry, `show` a day or
range, and inspect `projects`, `people`, `tags`, `stats`, `standup`, and `summary`. It also documents
the safety rails — confirm before `remove`/`storage import`, never run the interactive `wl edit` or
the blocking `wl server` inline — and how to strip `wl`'s Ruby-Logger `DEBUG` output noise
(`| grep -Ev '^D, \['`) while keeping `INFO`/`WARN`/`ERROR` confirmations.

**Requires** the `wl` binary on `$PATH` (`command -v wl`); all data stays local under `~/.worklog/`.
**Invoke it** by asking to *"log that I …"*, *"what did I do yesterday?"*, *"show my standup"*, or
*"list my worklog projects"*. See [`skills/worklog/SKILL.md`](skills/worklog/SKILL.md) for the full
command reference and behavioral contract.
