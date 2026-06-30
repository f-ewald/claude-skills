# Collection of Claude Skills

* `skills/` contains the actual skills, organized by category.
* `CLAUDE.md` contains the global rules that apply to all Claude sessions.


## How to use

1. Clone this repository to your local machine
2. Create a symlink to the `skills/` directory inside your `~/.claude/` folder
```bash
ln -s /path/to/claude-skills/skills/ ~/.claude/skills
ln -s /path/to/claude-skills/CLAUDE.md ~/.claude/CLAUDE.md
ln -s /path/to/claude-skills/statusline.sh ~/.claude/statusline.sh
```

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

## Using these skills in GitHub Copilot

These skills use the open Agent Skills (`SKILL.md`) standard, which GitHub Copilot also supports —
see [docs/using-skills-in-copilot.md](docs/using-skills-in-copilot.md) for step-by-step instructions.
