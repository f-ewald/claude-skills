---
name: review
description: Review a GitHub pull request for mistakes, classify them as major or minor, present a summary table, and post inline comments only on findings the user confirms one-by-one. Use when given a GitHub PR link to review.
---

Review a GitHub pull request for mistakes. Never post anything to GitHub unless the user confirms a finding individually. Use the `gh` CLI (assume it is installed and authenticated; if a call fails on auth, tell the user to run `gh auth login`). The tone of comments should be constructive, professional, and specific, aiming to help the author improve the code. Focus on correctness, security, and maintainability issues for major findings, and style or readability improvements for minor findings. Always provide a one-sentence description of each issue.

## 1. Input

Accept a GitHub PR URL of the form `https://github.com/{owner}/{repo}/pull/{number}`. Parse out `owner`, `repo`, and `number`. If no link is given, ask for one before continuing.

## 2. Fetch the PR

- Get the changed lines: `gh pr diff {number} --repo {owner}/{repo}`
- Get the head commit SHA and metadata (the SHA is required to post comments): `gh pr view {number} --repo {owner}/{repo} --json headRefOid,title,files`
- When the diff alone is not enough to judge correctness, read surrounding file context (e.g. `gh api repos/{owner}/{repo}/contents/{path}?ref={headRefOid}` or fetch the file). Only flag issues on lines that are part of the diff.

## 3. Review and classify

Identify mistakes and classify each finding:

**Major** — correctness-affecting problems:
- **Bugs** — wrong API used, off-by-one, incorrect arguments.
- **Correctness** — the logic won't work as intended even though tests pass.
- **Security** — unsafe/unvalidated parameters, injection, leaked secrets.
- **Data loss** — state kept in memory only, transactions never committed.
- **Broken logic** — the code claims to do one thing but does another.
- **Missing error handling** — exceptions unhandled, or caught too broadly/narrowly.

**Minor (nitpick)** — quality improvements that don't affect correctness:
- **Style** — formatting, inconsistent conventions.
- **Naming** — unclear or misleading identifiers.
- **Readability** — overly complex expressions, missing structure.
- **Idiomatic** — small non-idiomatic constructs.
- **Duplication** — repeated code that should be factored out (DRY).

For each finding, record: file path, line number (the right side of the diff), severity, a one-sentence description, and — whenever the fix is a concrete code change — the replacement code to offer as a GitHub `suggestion` block.

## 4. Summary table

Present all findings in a markdown table. State explicitly that nothing has been posted to GitHub yet.

| # | Severity | File:Line | Description |
|---|----------|-----------|-------------|
| 1 | Major    | `src/a.py:42` | One-sentence description of the issue. |
| 2 | Minor    | `src/b.js:10` | One-sentence description of the issue. |

## 5. Confirm one-by-one

Walk through the findings in order. For each one, show the file:line, the severity, and the proposed comment body, then ask whether to post it. Accept: skip, edit-then-post, or post as-is. Do not batch — handle each finding individually.

## 6. Post inline (only confirmed findings)

Whenever the fix is a concrete code change, end the comment body with a GitHub `suggestion` block so the author can apply it with one click. The body has the form:

````
<one-sentence description of the issue>

```suggestion
<the exact replacement code>
```
````

The `suggestion` block replaces the comment's target line(s) verbatim, so it must contain the complete intended replacement — correctly indented and with no diff markers. Skip the block for findings that have no single concrete replacement (e.g. "extract this into a helper").

For each approved finding, post a standalone inline comment on the exact changed line:

```
gh api repos/{owner}/{repo}/pulls/{number}/comments \
  -f body="<comment>" \
  -f commit_id="<headRefOid>" \
  -f path="<file path>" \
  -F line=<line number> \
  -f side="RIGHT"
```

A suggestion must cover exactly the line(s) it replaces. For a multi-line replacement, target the whole range by also passing `-F start_line=<first line> -f start_side="RIGHT"` alongside `line=<last line>`.

Confirm success (or report the error) after each post. Never post a finding the user skipped. Comment only on lines present in the diff so the API call targets a valid position. Keep comments specific and actionable.

## 7. Submit the review

Once all findings have been handled, ask the user whether they want to **approve the PR** or **just leave the comments**.

- **Approve** — submit an approving review. In the body, give a short reasoning for approving: note that the remaining findings are minor and are recommendations or preferences rather than blockers.

  ```
  gh pr review {number} --repo {owner}/{repo} --approve --body "<reasoning>"
  ```

- **Comment only** — submit a non-approving review. In the body, give a short summary of how many issues were found (e.g. how many major and minor).

  ```
  gh pr review {number} --repo {owner}/{repo} --comment --body "<summary>"
  ```

## 8. Wrap up

Summarize which comments were posted, which were skipped, and whether the PR was approved or left with comments.
