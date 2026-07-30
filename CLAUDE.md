# Global Rules

## Code Style
- Prefer early return over nested if-else structures.
- Avoid long methods; if a method exceeds 40 lines, consider refactoring it into smaller methods.
- Use best practices for specific languages. Per-language standards and required libraries live in `programming-standards/<language>.md` (e.g. `programming-standards/python.md`) and take precedence over general guidance (like PEP 8) where they conflict.
- Avoid using global variables; instead, pass necessary data through method parameters or use class-level variables when appropriate.
- Avoid big refactors unless specifically asked to do so. Focus on making minimal necessary changes to achieve the migration goals while maintaining code stability.
- When refactoring or making major changes, update the relevant always-on instructions file (`CLAUDE.md` and `COPILOT.md`) to reflect the new structure and rules.
- When solving an issue and you encounter debug statements, explicitly ask the user if it is ok to remove them.
- These global-rules files should contain less than 200 lines in the ideal case.

## Comments & documentation
- Document every method using the language's documentation style; per-language
  conventions live in `programming-standards/<language>.md`.
- Document the contract — behavior, parameters, return value, errors, and any
  caller-visible side effects or constraints. Do not describe the inner workings
  or narrate the algorithm.
- Keep it brief. A one-line summary is usually enough; add detail only where the
  contract is genuinely non-obvious.
- Do not restate the signature in prose; names and types are already visible in
  the code.
- Comment only what the code cannot express — a non-obvious rationale, a
  constraint, a workaround, or a reference. Never restate what the code does.
- Prefer a clearer name or structure over an explanatory comment.
- Keep docs and comments current when behavior changes; delete ones that no
  longer apply.

## Testing
- Keep the test suite minimal: cover each behavior once and do not add redundant
  or near-duplicate tests.
- Group input variations into parametrized or table-driven cases rather than
  separate near-identical tests.
- Minimal means non-redundant, not thin — keep the cases covering real edge cases
  and error paths, and never delete or weaken a test just to reduce the count.

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
