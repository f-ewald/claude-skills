---
name: worklog
description: Drive the `wl` CLI through a shell-free adapter to record and review a personal work log. Use when the user wants to add work, inspect a day or date range, prepare a standup or summary, manage worklog storage, or run the local worklog server.
license: MIT
metadata:
  author: Freddy Ewald
compatibility: Requires Node.js and `wl` 0.4.0 or newer on $PATH. Worklog data stays local under `~/.worklog/` except when the user explicitly confirms `wl github`.
allowed-tools: Write Bash(node */skills/worklog/scripts/run-wl.mjs:*) Bash(command -v wl:*)
---

# Worklog (`wl`) command interface

Use `scripts/run-wl.mjs` for **every** `wl` operation. Never call `wl` directly, interpolate
user-provided content into a shell command, or read/edit `~/.worklog/` data files. Send one JSON
request through stdin when the process tool has a real stdin channel. Otherwise use the trusted
request-file workflow below. Never use `echo`, a heredoc, a shell pipe, or a generated shell command.

## 1. Prerequisites

1. Once per session, run only `command -v wl`. If missing, tell the user `wl` must be on `$PATH`
   and stop; never install it.
2. Require Node.js and use the adapter's `version` command. Parse the reported semantic version and
   stop if it is older than 0.4.0; do not guess compatibility.
3. Invoke the adapter as `node <skill-directory>/scripts/run-wl.mjs`, using stdin or
   `--request-file <absolute-session-workspace-path>`.
4. Parse its single JSON response. Trust `ok`, `exitCode`, and `signal`; show cleaned `stdout`,
   relevant `stderr`, `warnings`, and parsed `confirmation`. A nonzero adapter status is a failure.
5. Never request, display, or pass GitHub/API tokens. The adapter does not accept token fields.

Request shape:

```json
{
  "command": "show",
  "flags": { "date": "2026-07-15" },
  "confirmed": false
}
```

`command` is required. `message` is allowed only for `add`; `flags` is an object; `confirmed` is a
boolean recording explicit user confirmation. Do not invent fields or pass raw argv.

### Request-file fallback

When the execution tool has no stdin channel:

1. Generate a unique `worklog-request-<nonce>.json` path inside the harness's session workspace.
   The filename and path must be harness-generated, absolute, and unrelated to user content.
2. Use the harness file-write capability to write only the JSON request, preferably mode `0600`.
3. Run `node <trusted-adapter-path> --request-file <trusted-request-file-path>`. The shell command
   may contain only those two trusted paths; it must not contain request values or user text.
4. In a finally-style cleanup step, verify the exact request-file path and delete that one file
   through the harness. If shell deletion is the only option, use `rm -- <exact-trusted-path>`;
   never use a glob, recursive removal, directory removal, or a user-provided path.

The adapter opens a request file once with no-follow semantics where supported, validates type,
owner, mode, and size from that descriptor, and bounded-reads from the same descriptor so path
replacement or file growth cannot bypass validation.

## 2. Dates and privacy

- Resolve words such as "today", "yesterday", "last Friday", and "this week" in the timezone
  stated by the user. Otherwise use the system timezone.
- Before any write, state the resolved absolute date in `YYYY-MM-DD` form. If the timezone or
  intended date is ambiguous, resolve it before writing.
- Use the narrowest date, project, or tag filter that answers a personal-data question. Do not
  fetch the entire history when a day or bounded range suffices.
- Do not read raw YAML or config. Worklog data remains local unless the user explicitly confirms
  the `github` network write.
- Never invent project keys, people handles, dates, ticket IDs, or URLs. Use narrow `projects` or
  `people` lookups when needed.

Date flags use absolute `YYYY-MM-DD` strings. `days` is a positive integer encoded as a string.
`since` is a `show`-only alias for `from`; `standup`, `summary`, and `tags` accept `from` but not
`since`. Do not combine `date` with `days` or range flags, and do not combine `days` with range
flags. Use explicit `from`/`to` for a range anchored to a particular date, or `days` by itself.
`to` requires `from` (or `since` for `show` only).

## 3. Read-only commands

| Intent | Adapter request |
| --- | --- |
| CLI baseline | `{"command":"version","flags":{}}` |
| Today's entries | `{"command":"show","flags":{"date":"YYYY-MM-DD"}}` |
| Date range | `{"command":"show","flags":{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}}` |
| Last/current N-day window | `{"command":"show","flags":{"days":"N"}}` |
| Filter entries | `show` flags: `epicsOnly` boolean, `tags` string array, `project` string |
| Standup | `standup` with optional `date`/`from`/`to`/`days` |
| Summary | `summary` with optional `date`/`from`/`to`/`days` |
| Statistics | `{"command":"stats","flags":{}}` |
| Projects | `projects`, optionally `{"oneline":true}` |
| People | `people`, optionally `{"inactive":true}` |
| Tags | `tags` with optional `date`/`from`/`to`/`days` |

Treat the known two-line `WL_PATH` development banner in `stderr` as harmless, but do not suppress
other stderr. The adapter preloads a local Ruby Logger shim that suppresses DEBUG before formatting,
so complete multiline DEBUG records never reach stdout. Its conservative fallback removes only
prefixed DEBUG header lines, preserving unprefixed command output and all non-DEBUG records.

## 4. Add and remove

For `add`, pass user text only as the JSON `message`. Supported flags are `date`, `time`, `tags`
(string array), `ticket`, `url`, `epic` (boolean), and `project`.
The adapter owns Thor-compatible argv ordering, including the boolean sentinel needed to terminate
tag arrays before a protected leading-dash message. Never construct add argv yourself.

1. Resolve and state the absolute date before writing.
2. If a project is requested, verify its exact key with narrow `projects --oneline` behavior.
3. Run the adapter and confirm success from `ok` plus the parsed `confirmation`.

`remove` deletes the last entry for a date and cannot be undone:

1. Use `show` for that exact date and identify the last entry.
2. Tell the user exactly what would be removed and obtain explicit confirmation.
3. Send `{"command":"remove","flags":{"date":"YYYY-MM-DD"},"confirmed":true}`.

Never run `edit`; it is interactive and intentionally unsupported by the adapter.

## 5. Initialization, GitHub, storage, and exports

Obtain explicit confirmation immediately before:

- `init`, because it creates local configuration/storage;
- `storage-import`, because it mutates the current store;
- `github`, because it performs a network request and may add many entries.

The adapter enforces `confirmed:true` for these commands. Explain `github`'s network and bulk-write
effects before asking. Never inspect or reveal configured credentials.

For `storage-import`, use an existing absolute directory and `format:"yaml"`. For
`storage-export`, use an absolute destination. Check whether it exists and whether it contains
files; never overwrite or merge into a non-empty destination without showing the destination and
obtaining confirmation. The adapter also requires `confirmed:true` for a non-empty destination.
It exports into an adapter-owned sibling staging directory, validates bounded regular entries with
no symbolic or hard links, validates the destination parent chain, and publishes with atomic
renames that replace link entries rather than following them. Staging directories are pinned by
descriptor identity and revalidated before publication. Treat any fail-closed validation or publish
error as final; never retry by calling `wl storage export` directly.

For `takeout`, choose and show the exact absolute `.tar.gz` output path before execution and pass it
as `flags.outputPath`. The adapter derives the destination directory, creates wl's timestamped
archive in an adapter-owned staging directory, and atomically publishes only to that chosen path.
If the exact output path already exists, obtain confirmation for that path and retry with
`confirmed:true`. The adapter validates protected, non-symlink parent chains and pins/revalidates
the stage identity. Report `confirmation.path`. Never use an implicit or generated final path.

## 6. Server lifecycle

Use the adapter's constrained `server` command; never launch `wl server` directly.

1. Choose a new absolute log path under a protected real parent chain. Do not overwrite a log.
2. Send `{"command":"server","flags":{"logPath":"/absolute/new/server.log"}}`.
3. `wl` 0.4.0 ignores `webserver_port` and starts Rackup on default port 9292. The adapter checks
   that port before launch, keeps the exact exclusively opened log descriptor, parses Rackup/Puma's
   bound port from that descriptor, verifies stable TCP readiness and process-group liveness, and
   returns the verified URL and PID.
4. Report the verified URL, exact PID, and log path.
5. Give the exact stop instruction returned by the adapter (`kill <PID>`). Never use `pkill`,
   `killall`, or a name-based stop command. The harness may use its exact-PID process tooling.

If readiness fails, report the adapter error and log path; do not claim the server is running.
If startup is cancelled, the adapter forwards SIGINT/SIGTERM to the detached server process group,
waits, and escalates that exact group before returning.

## 7. Safety rules

- Use only documented adapter commands and flags. Do not use `help`, `tree`, arbitrary subcommands,
  global verbose flags, raw argv, environment overrides, or shell syntax.
- Quotes, spaces, backticks, `$()`, semicolons, pipes, redirects, and other metacharacters in an
  entry are data. Keep them inside the JSON `message`; never place them in shell source.
- Treat validation failures as final for that request. Correct the structured request rather than
  bypassing the adapter.
- If the adapter receives SIGINT or SIGTERM during a foreground operation, it forwards the signal
  to the exact retained `wl` process-group ID, waits for the whole group rather than only its
  leader, and escalates that same group if descendants remain.
- For errors or uncertainty, report the structured result. Do not fall back to direct `wl`.
