# Global Rules

## Code Style
- Prefer early return over nested if-else structures.
- Document each method that you write with the language-specific documentation style (e.g., Javadoc for Java, docstrings for Python)
- Avoid long methods; if a method exceeds 40 lines, consider refactoring it into smaller methods.
- Use best practices for specific languages. Per-language standards and required libraries live in `programming-standards/<language>.md` (e.g. `programming-standards/python.md`) and take precedence over general guidance (like PEP 8) where they conflict.
- Avoid using global variables; instead, pass necessary data through method parameters or use class-level variables when appropriate.
- Avoid big refactors unless specifically asked to do so. Focus on making minimal necessary changes to achieve the migration goals while maintaining code stability.
- When refactoring, or adding making major changes, make sure to update the CLAUDE.md to reflect the new structure and rules.
- When solving an issue and you encounter debug statements, explicitly ask the user if it is ok to remove them.
- The CLAUDE.md should contain less than 200 lines in the ideal case.

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

## File Management
- A `todo.md` file may be maintained that contains todos. Offer to work on them one by one and mark them as done.
- A `bugs.md` file may be maintained. Whenever the user asks to fix bugs, offer to look them up and mark them as done once done.
