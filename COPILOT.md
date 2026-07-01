# Global Rules

<!--
GitHub Copilot CLI counterpart to CLAUDE.md — the same always-on global coding
rules, for the Copilot harness. Distribute it by symlinking to the location
Copilot reads personal (global) instructions from (see README.md):

    ln -s /path/to/claude-skills/COPILOT.md ~/.copilot/copilot-instructions.md

- This is NOT .github/copilot-instructions.md — that file documents *this repo's*
  architecture and is auto-loaded only inside this repo. COPILOT.md carries the
  *global* rules and applies everywhere once symlinked into ~/.copilot/.
- Copilot does not auto-read a file named COPILOT.md, so it has no effect while it
  just sits in this repo; inside this repo the same rules already apply via CLAUDE.md.
- Keep this in sync with CLAUDE.md.
-->

## Code Style
- Prefer early return over nested if-else structures.
- Document each method that you write with the language-specific documentation style (e.g., Javadoc for Java, docstrings for Python)
- Avoid long methods; if a method exceeds 40 lines, consider refactoring it into smaller methods.
- Use best practices for specific languages. Per-language standards and required libraries live in `programming-standards/<language>.md` (e.g. `programming-standards/python.md`) and take precedence over general guidance (like PEP 8) where they conflict.
- Avoid using global variables; instead, pass necessary data through method parameters or use class-level variables when appropriate.
- Avoid big refactors unless specifically asked to do so. Focus on making minimal necessary changes to achieve the migration goals while maintaining code stability.
- When refactoring or making major changes, update the relevant always-on instructions file (CLAUDE.md and this file) to reflect the new structure and rules.
- When solving an issue and you encounter debug statements, explicitly ask the user if it is ok to remove them.
- These global-rules files should contain less than 200 lines in the ideal case.

## Safety with destructive commands
- Before running `rm -rf` (or any irreversible command — `rm`, an overwriting `mv`,
  `git reset --hard`, `git clean -fd`, dropping a DB/table), STOP and reason
  explicitly first: state which exact paths will be affected and why, and confirm
  they are the intended targets. Deletes are unrecoverable, so the extra step is worth it.
- Never choose paths to delete by matching file *content* (e.g. `grep`-ing logs or
  data files). Unrelated files can contain the same string, so you may delete the
  wrong thing. Delete by explicit, verified path only. (This rule exists because a
  content grep once matched — and deleted — the live session whose log happened to
  contain a test marker string.)
- Prefer the narrowest command: name specific paths, avoid broad globs/loops, and
  `ls`/print the targets to review them before deleting.
- Be extra careful in shared or stateful directories (`~/.copilot`, `~/.claude`,
  home config) — deleting there can corrupt a live session or another process's state.

## Git commits
- Do not add a `Co-authored-by` trailer to git commits, and do not otherwise list
  the AI assistant as an author or co-author.
- Never create pull requests unless the user explicitly asks you to. Committing when
  requested is fine, but do not open, push, or draft a PR on your own initiative.
