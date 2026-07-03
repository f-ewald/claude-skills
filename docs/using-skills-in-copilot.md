# Using these skills in GitHub Copilot

> **Last verified: June 2026.** GitHub Copilot's Agent Skills support and the Agent Skills
> standard are evolving quickly. If the paths, settings, or UI steps below don't match your
> version, re-check the linked docs in [References](#references).

The skills in this repo (`skills/<name>/SKILL.md`) are written in the **Agent Skills** format —
an open standard originally created by Anthropic and published at
[agentskills.io](https://agentskills.io). GitHub Copilot (in VS Code and via the Copilot CLI)
supports the **same** standard and discovers skills from the very same locations this repo
already uses — **including the Claude paths** (`~/.claude/skills/...` and `.claude/skills/...`).

That means **no conversion is needed**. Because `README.md` already symlinks this repo's `skills/`
directory into `~/.claude/skills`, Copilot picks these skills up as-is. The only required
frontmatter is `name` and `description`, which every skill here already has.

Skills Copilot will see from this repo: `adversarial-review`, `design-doc`, `grill-me`, `review`, `ultracode`.

---

## Prerequisites

- **For VS Code:** a recent VS Code with the **GitHub Copilot** and **GitHub Copilot Chat**
  extensions, signed in to a Copilot-enabled account.
- **For the CLI:** the **GitHub Copilot CLI** installed and authenticated.
- This repo cloned, with the symlink from `README.md` in place:

  ```bash
  ln -s /path/to/claude-skills/skills/ ~/.claude/skills
  ```

  Copilot discovers user-level skills from any of these (this repo uses the second one):

  - `~/.copilot/skills/<name>/SKILL.md`
  - `~/.claude/skills/<name>/SKILL.md`  ← satisfied by the symlink above
  - `~/.agents/skills/<name>/SKILL.md`

  And project-level skills from `.github/skills/`, `.claude/skills/`, or `.agents/skills/`.

---

## Path A — VS Code Copilot

1. **Confirm the symlink resolves.** The skill folders should be visible under your home dir:

   ```bash
   ls -l ~/.claude/skills
   ```

   You should see `review/` and `grill-me/` (each containing a `SKILL.md`).

2. **Open Copilot Chat in Agent mode.** Open the **Chat** view, then switch the mode selector to
   **Agent**. (Skills are loaded by the agent, not by inline completions.)

3. **Verify the skills are detected.** In the Chat view, open **Configure Chat** (the gear icon)
   and go to the **Skills** tab. Confirm `review` and `grill-me` are listed.

   > If the Skills tab is empty or missing, the feature may be behind a setting in your version —
   > enable skills in **Settings**, then reload the window (`Developer: Reload Window`).

4. **Use a skill.** Two ways:

   - **Automatically** — just describe a task that matches the skill's `description`. For example,
     paste a PR URL: *"Review this PR: https://github.com/owner/repo/pull/123"*. Copilot matches
     it to the `review` skill and loads the full `SKILL.md` on demand.
   - **Explicitly** — type `/` in the chat input and pick the skill by name.

5. **(Optional) Share a skill with a team.** Copy or symlink a skill into a repository at
   `.github/skills/<name>/SKILL.md` (or `.claude/skills/<name>/SKILL.md`) and commit it. Everyone
   who opens that repo in Copilot gets the skill — no per-machine setup.

---

## Path B — GitHub Copilot CLI

1. **Install and authenticate** the GitHub Copilot CLI, and confirm it launches.

2. **No extra setup for these skills.** The CLI uses the same discovery locations as VS Code, so
   the existing `~/.claude/skills` symlink already exposes `review` and `grill-me` at the
   user level. Project-level `.github/skills` / `.claude/skills` also work.

3. **Trigger a skill.** Run the CLI in (or pointed at) your project, then either describe the
   matching task in natural language or invoke the skill by name. Any bundled `scripts/` or
   reference files inside a skill folder are used the same way they are in VS Code.

---

## Verifying it works

- In VS Code, ask: *"Review this PR: <url>"* and confirm Copilot follows the `review` steps —
  it should present a **summary table first**, walk findings **one-by-one**, and **post nothing**
  to GitHub until you confirm each one.
- Ask: *"Grill me on this plan"* and confirm the `grill-me` skill activates.

**Troubleshooting — skill not showing up:**

- The folder name must match the `name:` field in the skill's frontmatter.
- The `description:` field must be present (it's how Copilot decides relevance).
- Check the symlink/path actually resolves (`ls -l ~/.claude/skills/<name>/SKILL.md`).
- Reload the VS Code window after adding or changing skills.

---

## Bonus: carry over the global rules too

The same standard means Copilot in VS Code also reads a **`CLAUDE.md`** file as always-on
instructions (controlled by the `chat.useClaudeMdFile` setting). So this repo's coding rules can
apply in Copilot as well — place or symlink a `CLAUDE.md` at your workspace root, or rely on the
global `~/.claude/CLAUDE.md`.

For the **Copilot CLI**, the global rules travel through Copilot's own personal-instructions file:
symlink this repo's [`COPILOT.md`](../COPILOT.md) to `~/.copilot/copilot-instructions.md` (see the
main [README](../README.md#github-copilot-global-rules)). The CLI also reads a `CLAUDE.md` directly,
so inside this repo the rules already apply via the distributed `~/.claude/CLAUDE.md`.

---

## References

- Agent Skills standard — <https://agentskills.io>
- VS Code: Agent Skills — <https://code.visualstudio.com/docs/copilot/customization/agent-skills>
- GitHub Copilot: About Agent Skills — <https://docs.github.com/en/copilot/concepts/agents/about-agent-skills>
