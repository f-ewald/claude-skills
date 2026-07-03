---
name: adversarial-review
description: Critically review your own uncommitted or branch changes as a skeptical adversary — surface real flaws and action items, curate them into a todo list you accept / reject / rephrase one-by-one, then implement only the approved plan. Use when you want to self-review your own changes, critique code you just wrote before pushing or opening a PR, hunt for flaws in your own work, or ask for an "adversarial review".
license: MIT
author: Freddy Ewald
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git merge-base:*), Bash(git symbolic-ref:*)
---

# Adversarial self-review

Review the user's own changes the way a hostile reviewer would — assume the code is broken and hunt for the reasons why. Surface only real, defensible problems, curate them into a fix list the user controls item-by-item, and implement only what they approve.

**Hard rule: change nothing on disk until the plan is approved in Phase 5.** Phases 1–4 are strictly read-only — you are reviewing and planning, not editing.

## 1. Identify the changes to review

Auto-detect the change set, in this order:

1. **Explicit override** — if the user named specific files, a commit, or a range, review exactly that.
2. **Uncommitted work** — if `git status --short` shows staged or unstaged changes, review `git diff HEAD`. Include newly added **untracked** files by reading them directly (they don't appear in `git diff HEAD`).
3. **Branch vs base** — if the working tree is clean, review the branch against its base: resolve the base with `git symbolic-ref --short refs/remotes/origin/HEAD` (fall back to `main` or `master`), then review `git diff $(git merge-base HEAD <base>)...HEAD`.
4. **Nothing to review** — if no changes are found, say so and stop.

State the detected scope in one line (e.g. *"Reviewing 3 uncommitted files vs HEAD"*) and let the user redirect before you dig in. Read enough surrounding code — not just the diff hunks — to judge correctness in context.

## 2. Review adversarially

Adopt a skeptical, break-it posture: assume each change is wrong and look for the proof. Hunt for:

- **Major (correctness / impact)** — logic bugs, wrong API or arguments, off-by-one, unhandled edge cases, missing or wrong error handling, race conditions, resource/transaction/state leaks, security holes (injection, unvalidated input, leaked secrets), data loss, broken backward-compatibility, and any gap between what the code *claims* to do and what it *actually* does.
- **Test & doc gaps** — new behavior with no test, tests that assert the wrong thing, stale comments or docs left inconsistent with the change.
- **Minor (quality)** — naming, readability, duplication, non-idiomatic constructs, style.

Report **only real, defensible issues** — do not invent or pad. If the changes look sound, say so plainly rather than manufacturing problems. Distinguish **major** (correctness/security) from **minor** (quality) for each finding.

For a large or high-stakes diff, consider escalating to the **`ultracode`** skill to fan the review out to multiple adversarial subagents and adversarially verify each finding before presenting — this keeps false positives low.

For each surviving finding, record: `file:line`, severity, a one-sentence description, and a concrete proposed fix or action item.

## 3. Present findings, then offer the todo list

Present every finding in a single markdown table. State explicitly that **nothing has been changed and no todos have been created yet**:

| # | Severity | File:Line | Issue | Proposed fix |
|---|----------|-----------|-------|--------------|
| 1 | Major    | `src/a.py:42` | One-sentence description of the flaw. | What to change. |
| 2 | Minor    | `src/b.js:10` | One-sentence description of the flaw. | What to change. |

Then **offer to turn these findings into a todo list of fixes**. If the user declines, stop here — the review itself is the deliverable.

## 4. Curate the list one-by-one (accept / reject / rephrase)

If the user accepts the offer, walk the findings **in order, one at a time — never as a group**. For each finding, show the issue and its proposed fix, then present three choices as a multiple-choice question:

- **Accept as-is** — add the action item to the todo list unchanged.
- **Reject** — drop it entirely; it does not go on the list.
- **Rephrase** — the user reworks the scope or wording; capture their revised action item, read it back to confirm, and add the agreed version.

Build the curated todo list from the **accepted and rephrased items only**. Keep each todo self-contained and actionable (which file, what change, and why). Record it in the harness's todo/plan tracker so progress is visible.

## 5. Approve the plan

Present the final curated todo list as the implementation plan and get **explicit approval to implement**. The user may still reorder, tweak, or drop items here. Implement nothing until this approval is given — this is the gate that ends the read-only phase.

## 6. Implement the approved fixes

Work the approved todos **one at a time**. For each: mark it in-progress, make the **smallest surgical change** that satisfies that item, then mark it done. Follow the repo's existing conventions and any `programming-standards/`, `CLAUDE.md`, or `COPILOT.md` rules that apply. Validate with the **smallest** relevant *existing* tests, build, or lint — do not add new tooling. If an item proves infeasible or conflicts with another, **stop and report** rather than guessing. Do **not** commit or push unless the user explicitly asks.

## 7. Wrap up

Summarize what was implemented, what was rejected, and what was rephrased, plus any items that couldn't be completed and suggested follow-ups (e.g. run the full test suite, commit the changes). Offer those next steps — don't take them unless asked.
