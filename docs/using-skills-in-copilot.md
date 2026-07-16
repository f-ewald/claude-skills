# Using these skills in GitHub Copilot

> **Last verified: July 2026.** GitHub Copilot's Agent Skills support and the Agent Skills
> standard are evolving quickly. If the paths, settings, or UI steps below don't match your
> version, re-check the linked docs in [References](#references).

The skills in this repo (`skills/<name>/SKILL.md`) use the open
[Agent Skills](https://agentskills.io) format. GitHub Copilot in VS Code and the
Copilot CLI can consume the same packages without conversion, but their
**personal discovery paths differ**.

- Copilot CLI: `~/.copilot/skills/` or `~/.agents/skills/`
- VS Code: also recognizes `~/.claude/skills/`
- Copilot CLI projects: `.github/skills/`, `.agents/skills/`, or `.claude/skills/`

The released set is maintained in the main
[skill catalog](../README.md#skill-catalog-and-safety), which is also checked
against the on-disk packages by `scripts/validate-skills.mjs`.

---

## Prerequisites

- **For VS Code:** a recent VS Code with the **GitHub Copilot** and **GitHub Copilot Chat**
  extensions, signed in to a Copilot-enabled account.
- **For the CLI:** the **GitHub Copilot CLI** installed and authenticated.
- This repo cloned.
- **For the CLI:** register the shared skill directory:

  ```bash
  copilot skill add /path/to/claude-skills/skills
  ```

- **For VS Code:** expose each package beneath a supported personal path:

  ```bash
  mkdir -p "$HOME/.claude/skills"
  for skill in /path/to/claude-skills/skills/*; do
    target="$HOME/.claude/skills/$(basename "$skill")"
    [ -e "$target" ] || ln -s "$skill" "$target"
  done
  ```

  Copilot CLI users may use the same per-package pattern under
  `~/.copilot/skills/` or `~/.agents/skills/` instead of `copilot skill add`.
  Do not link the whole `skills/` directory to an existing destination;
  standard `ln` behavior would create an extra nested `skills/` directory.

---

## Path A — VS Code Copilot

1. **Confirm a supported personal path resolves.** For the shared Claude/VS Code
   installation:

   ```bash
   ls -l ~/.claude/skills
   ```

   You should see `review/` and `grill-me/` (each containing a `SKILL.md`).

2. **Open Copilot Chat in Agent mode.** Open the **Chat** view, then switch the mode selector to
   **Agent**. (Skills are loaded by the agent, not by inline completions.)

3. **Verify the skills are detected.** Use the current VS Code skills management
   surface, then reload the window after adding or changing packages.

4. **Use a skill.** Two ways:

   - **Automatically** — just describe a task that matches the skill's `description`. For example,
     paste a PR URL: *"Review this PR: https://github.com/owner/repo/pull/123"*. Copilot matches
     it to the `review` skill and loads the full `SKILL.md` on demand.
   - **Explicitly** — type `/` in the chat input and pick the skill by name.

   The custom `deeper-research` name is intentional: it does not shadow Claude
   Code's bundled `/deep-research` workflow.

5. **(Optional) Share a skill with a team.** Copy or symlink a skill into a repository at
   `.github/skills/<name>/SKILL.md` (or `.claude/skills/<name>/SKILL.md`) and commit it. Everyone
   who opens that repo in Copilot gets the skill — no per-machine setup.

---

## Path B — GitHub Copilot CLI

1. **Install and authenticate** the GitHub Copilot CLI, and confirm it launches.

2. **Verify discovery.**

   ```bash
   copilot skill list
   ```

   A personal `~/.claude/skills` symlink alone is not sufficient for Copilot
   CLI. Use `~/.copilot/skills`, `~/.agents/skills`, or `copilot skill add`.

3. **Trigger a skill.** Run the CLI in (or pointed at) your project, then either describe the
   matching task in natural language or invoke the skill by name. Any bundled `scripts/` or
   reference files inside a skill folder are used the same way they are in VS Code.

---

## Verifying it works

- In VS Code, ask: *"Review this PR: <url>"* and confirm Copilot follows the `review` steps —
  it should present a **summary table first**, walk findings **one-by-one**, and **post nothing**
  to GitHub until you confirm each one.
- Ask: *"Grill me on this plan"* and confirm the `grill-me` skill activates.
- Ask for *"deeper research on this topic"* and confirm the portable custom
  workflow activates rather than a harness-native similarly named feature.

**Troubleshooting — skill not showing up:**

- The folder name must match the `name:` field in the skill's frontmatter.
- The `description:` field must be present (it's how Copilot decides relevance).
- Check the relevant path resolves (`ls -l ~/.copilot/skills/<name>/SKILL.md`)
  or inspect custom directories with `copilot skill list`.
- Reload the VS Code window after adding or changing skills.

---

## Bonus: carry over the global rules too

Custom instructions are a separate feature from Agent Skills. VS Code can read
`CLAUDE.md` when that support is enabled; this does not make `CLAUDE.md` part of
the Agent Skills standard.

For the **Copilot CLI**, the global rules travel through Copilot's own personal-instructions file:
symlink this repo's [`COPILOT.md`](../COPILOT.md) to `~/.copilot/copilot-instructions.md` (see the
main [README](../README.md#github-copilot-global-rules)). Repository-level
instruction files may also apply independently of the personal skills location.

---

## References

- Agent Skills standard — <https://agentskills.io>
- VS Code: Agent Skills — <https://code.visualstudio.com/docs/copilot/customization/agent-skills>
- GitHub Copilot: About Agent Skills — <https://docs.github.com/en/copilot/concepts/agents/about-agent-skills>
