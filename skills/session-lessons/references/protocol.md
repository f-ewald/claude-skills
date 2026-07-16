# Lesson and write protocol

## Observable evidence

Use only normalized user, assistant, system, abort, and tool events. Never use
private reasoning, hidden chain-of-thought, or `reasoningText`. Evidence shown to
the user or written into an instruction file must already be redacted and bounded.

## Candidate quality

- Rank repeated and explicit user corrections highest.
- Model self-corrections and reproducible tool mistakes are medium-confidence.
- An abort without adjacent correction evidence is low-confidence and cannot by
  itself justify a permanent rule.
- Exclude added scope, normal iteration, and one-off preferences.

De-duplicate with conservative token overlap and containment. Describe this as
"semantic-ish" matching, not embeddings or semantic search. Existing rules take
precedence: a covered candidate is dropped. A similar rule with opposite
polarity is a contradiction that must be shown to the user, never auto-merged.

## Confirmation

Show the complete candidate table first and state that nothing has been written.
Then confirm candidates one at a time: accept, reject, or rephrase. Confirm scope
and harness for every accepted rule. A shared global rule patches both harness
files after one explicit confirmation. Do not write anything until the complete
accepted set and exact target diffs have been approved.

## Routing

| Scope | Claude Code | GitHub Copilot CLI |
| --- | --- | --- |
| Global | `~/.claude/CLAUDE.md` | `~/.copilot/copilot-instructions.md` |
| Repository | `<repo>/CLAUDE.md` | `<repo>/.github/copilot-instructions.md` |

Resolve symlinks before previewing. In this `claude-skills` repository, the
distributed top-level `CLAUDE.md` and `COPILOT.md` are a synchronized pair. If a
global symlink resolves to either file, route and reconcile the accepted patch
to both files together.

## Mandatory preflight and write sequence

For every target:

1. Resolve symlinks portably with Node `realpath`, including a canonical parent
   for a file that does not exist yet.
2. Detect company/enterprise-managed and "do not edit" markers; stop if found.
3. For repository files, inspect `git status --porcelain=v1 -- <path>`.
   Treat any Git inspection failure as blocked/unknown, never as clean.
4. Render a write plan containing the exact full diff and SHA-256 digest of the
   complete proposed replacement for every target.
5. Obtain explicit approval for that exact target set, diff, and proposed digest.
6. Re-read each target and compare its digest with the preview snapshot.
7. Write only the approved content through an exclusive same-directory file:
   first acquire an exclusive same-directory advisory lock (`open` with `wx`);
   preserve mode where applicable, fsync/close, verify the temp content, recheck
   the target digest, and atomically rename over the canonical target.
8. Fail closed when a lock already exists and never delete an unknown lock.
9. Release only the exact lock created by this writer and clean the exact owned
   temp file on failure.
10. Re-read and verify exact content after writing.

The write helper must recompute the supplied replacement digest and require it
to match the explicitly approved write-plan digest before acquiring a lock.
A boolean approval without this content binding is insufficient.

If a file changed after preview, abort and restart preflight. Never commit or
open a pull request unless separately requested. The advisory lock serializes
cooperating Session Lessons writers only. Non-cooperating external writers may
still trigger digest or post-write mismatch checks; report those as blocked and
do not silently retry.
