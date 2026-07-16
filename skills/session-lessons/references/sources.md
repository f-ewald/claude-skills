# Local source adapters

Session Lessons is strictly local-only. Do not call `session_store_sql`, cloud
session stores, network APIs, or downloaded scripts.

## Claude Code

- Transcript: `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
- `<encoded-cwd>` is the absolute working directory with path separators replaced
  by `-` (for example, `/Users/me/work` becomes `-Users-me-work`).
- Supported records have `type` equal to `user`, `assistant`, or `system`.
- Observable message content is under `message.content`.
- Text blocks and observable `tool_use` / `tool_result` blocks are supported.
- `thinking`, `reasoning`, and `redacted_thinking` blocks are never read.
- Explicit IDs are searched under every local `projects/*/<id>.jsonl` path.
  Candidates are associated using observable top-level `cwd`, `git_root`, or
  equivalent workspace fields when present; ambiguous associated matches fail.
- Auto discovery includes transcript cwd/project directories contained by the
  resolved Git root, so sessions started in repository subdirectories match.

## GitHub Copilot CLI

- Event log: `~/.copilot/session-state/<session-id>/events.jsonl`
- Local metadata registry: `~/.copilot/session-store.db`
- Workspace metadata may also be present beside the event log.
- Supported events: `user.message`, `assistant.message`, `system.message`,
  `abort`, `tool.execution_start`, and `tool.execution_complete`.
- Observable content is under `data.content` (or `data.message.content`).
- Tool starts and completions are correlated by `toolCallId`; normalized tool
  evidence retains stable redacted IDs and bounded redacted arguments.
- `data.reasoningText` and reasoning-only event types are never read.

## Discovery precedence

1. Explicit `--input`, `--source`, and `--session` arguments.
2. `SESSION_LESSONS_SOURCE` / `SESSION_LESSONS_SESSION_ID`.
3. Harness session environment variables.
4. Most recently updated local session for the current working directory.

Copilot registry discovery invokes an installed `sqlite3` executable with
`execFile` and an argv array. The normalizer has no SQLite package dependency.
If the registry or executable is unavailable, discovery scans local
`session-state/*/workspace.yaml` metadata. Both `cwd` and `git_root` are matched
so sessions started in repository subdirectories remain discoverable.

The JSONL parser ignores only a malformed, unterminated final line. Any malformed
complete line is an error. Parse diagnostics expose only the harness/source and
line number with a generic reason—never the raw JSONL line or parser snippet.
Top-level CLI errors pass through secret/path sanitization; filesystem failures
use generic messages, and encoded Claude project identities such as
`projects/-Users-name-...` are redacted before display.
