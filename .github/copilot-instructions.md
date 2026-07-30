# Copilot instructions for `claude-skills`

A personal collection of **Agent Skills** (the open `SKILL.md` standard) plus
status-line scripts and shell helpers, shared between **Claude Code** and the
**GitHub Copilot CLI**. There is no application to build: the "product" is the
markdown skills and bash scripts themselves, consumed in place via symlinks into
the harness-specific personal directories (see `README.md`).

## No build / test / lint tooling

There is no package manager or build step. Validate skill packages with the
zero-dependency Node tools:

```bash
node scripts/validate-skills.mjs
node --test tests/*.test.mjs
```

- **Skill files** — the validator checks the repository's bounded frontmatter
  subset, folder/name parity, references, inventory, and generated artifacts.
- **Status-line scripts** — each reads a JSON status blob on stdin (`input=$(cat)`)
  and prints one line, parsed with `jq` (required dependency). Smoke-test by
  piping JSON, e.g. `echo '<status-json>' | ./statusline_copilot.sh`. The exact
  JSON shape each script expects is documented in its header comment, and the two
  scripts expect **different** schemas (see below).
- **Changelog** — `CHANGELOG.md` is generated from first-parent commit history by
  `node scripts/update-changelog.mjs`; use `--check` to verify it. Do not edit the
  generated file manually.

## Architecture / big picture

- `skills/<name>/SKILL.md` — one folder per skill. Skills are **prose workflow
  instructions, not code**: numbered phases/steps describing how the agent should
  behave (interview the user, present a summary table first, confirm findings
  one-by-one, post nothing until confirmed). Released skills:
  `adversarial-review`, `deeper-research`, `design-doc`, `grill-me`,
  `interview-assessment`, `pr-review`, `session-lessons`, `ultracode`, and
  `worklog`. Some packages also contain zero-dependency Node adapters or
  orchestration code.
- **Cross-harness by design** — the same `SKILL.md` standard and discovery paths
  work in both Claude Code (`~/.claude/skills`) and Copilot (`~/.copilot/skills`,
  `.github/skills`). `docs/using-skills-in-copilot.md` is the reference for the
  Copilot side.
- `statusline.sh` (Claude Code) and `statusline_copilot.sh` (Copilot CLI) are
  **two separate scripts for two different harnesses** that parse **different
  stdin JSON schemas** (e.g. Claude reads `.model.display_name` /
  `.context_window.*` / `.cost.*`; Copilot reads its own fields and fetches quota
  via `gh`). Keep them separate — do not merge or cross-edit them; the Copilot
  script explicitly leaves the Claude one untouched.
- `CLAUDE.md` is the global coding-rules artifact this repo **distributes**
  (symlinked to `~/.claude/CLAUDE.md`), not repo-local config. Keep it under
  200 lines. `COPILOT.md` is its GitHub Copilot counterpart (symlinked to
  `~/.copilot/copilot-instructions.md`) — the same global rules, kept in sync,
  and likewise not repo-local config. Neither is *this* file
  (`.github/copilot-instructions.md`), which is the repo-specific guidance.

## Conventions when adding or changing a skill

- The folder name **must** equal the frontmatter `name:`.
- Frontmatter requires `name` and `description`; the `description` must state both
  what the skill does **and when to use it** ("Use when …") — that text is how
  both Copilot and Claude decide relevance.
- Optional frontmatter used here: `license`, `metadata.author`,
  `compatibility`, and `allowed-tools` (e.g. `Bash(gh:*)` to pre-authorize a
  command in harnesses that honor it).
- Bundle supporting files in a subfolder (`templates/`, `scripts/`) and reference
  them by **relative path** from the `SKILL.md`.
- Every released skill has an `evals.json` in the repository's version-1
  `skill`/`cases` schema; executable helpers also need offline `node:test`
  coverage under `tests/`.
- The machine-checkable catalog between `skill-catalog` markers in `README.md`
  must be updated when a skill is added or renamed.
- `README.md` documents installation and both status lines — update it when you
  change that behavior.
