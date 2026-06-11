---
name: review
description: Review a GitHub pull request for mistakes, classify them as major or minor, present a summary table, and post inline comments only on findings the user confirms one-by-one. Use when given a GitHub PR link to review.
---

Review a GitHub pull request for mistakes. Never post anything to GitHub unless the user confirms a finding individually. Use the `gh` CLI (assume it is installed and authenticated; if a call fails on auth, tell the user to run `gh auth login`).

## 1. Input

Accept a GitHub PR URL of the form `https://github.com/{owner}/{repo}/pull/{number}`. Parse out `owner`, `repo`, and `number`. If no link is given, ask for one before continuing.

## 2. Fetch the PR

- Get the changed lines: `gh pr diff {number} --repo {owner}/{repo}`
- Get the head commit SHA and metadata (the SHA is required to post comments): `gh pr view {number} --repo {owner}/{repo} --json headRefOid,title,files`
- When the diff alone is not enough to judge correctness, read surrounding file context (e.g. `gh api repos/{owner}/{repo}/contents/{path}?ref={headRefOid}` or fetch the file). Only flag issues on lines that are part of the diff.

## 3. Review and classify

Identify mistakes and classify each finding:

- **Major** — bugs, correctness, security, data-loss issues, broken logic, or missing error handling.
- **Minor (nitpick)** — style, naming, readability, or small idiomatic improvements.

For each finding, record: file path, line number (the right side of the diff), severity, and a one-sentence description.

## 4. Summary table

Present all findings in a markdown table. State explicitly that nothing has been posted to GitHub yet.

| # | Severity | File:Line | Description |
|---|----------|-----------|-------------|
| 1 | Major    | `src/a.py:42` | One-sentence description of the issue. |
| 2 | Minor    | `src/b.js:10` | One-sentence description of the issue. |

## 5. Confirm one-by-one

Walk through the findings in order. For each one, show the file:line, the severity, and the proposed comment body, then ask whether to post it. Accept: skip, edit-then-post, or post as-is. Do not batch — handle each finding individually.

## 6. Post inline (only confirmed findings)

For each approved finding, post a standalone inline comment on the exact changed line:

```
gh api repos/{owner}/{repo}/pulls/{number}/comments \
  -f body="<comment>" \
  -f commit_id="<headRefOid>" \
  -f path="<file path>" \
  -F line=<line number> \
  -f side="RIGHT"
```

Confirm success (or report the error) after each post. Never post a finding the user skipped. Comment only on lines present in the diff so the API call targets a valid position. Keep comments specific and actionable.

## 7. Wrap up

Summarize which comments were posted and which were skipped.
