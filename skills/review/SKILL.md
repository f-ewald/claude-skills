---
name: review
description: Review a GitHub pull request for mistakes, classify them as major or minor, present a summary table, and add inline comments to a single review only on findings the user confirms one-by-one. Use when given a GitHub PR link to review.
license: MIT
compatibility: Requires the gh (GitHub CLI), installed and authenticated; run gh auth login if a call fails on auth.
allowed-tools: Bash(gh:*)
---

Review a GitHub pull request for mistakes. Never post anything to GitHub unless the user confirms a finding individually. The tone of comments should be constructive, professional, and specific, aiming to help the author improve the code. Focus on correctness, security, and maintainability issues for major findings, and style or readability improvements for minor findings. Always provide a one-sentence description of each issue.

## 1. Input

Accept a GitHub PR URL of the form `https://github.com/{owner}/{repo}/pull/{number}`. Parse out `owner`, `repo`, and `number`. If no link is given, ask for one before continuing.

## 2. Fetch the PR

- Get the changed lines: `gh pr diff {number} --repo {owner}/{repo}`
- Get the head commit SHA, PR description, and metadata (the SHA is required to post comments; the description is needed for the accuracy check in the next step): `gh pr view {number} --repo {owner}/{repo} --json headRefOid,title,body,files`
- When the diff alone is not enough to judge correctness, read surrounding file context (e.g. `gh api repos/{owner}/{repo}/contents/{path}?ref={headRefOid}` or fetch the file). Only flag issues on lines that are part of the diff.

## 3. Check description accuracy

Compare the PR description/body against the actual diff and assess whether the stated summary is accurate. Look for:

- **Omissions** — substantive changes in the diff the description doesn't mention.
- **False claims** — things the description says it does that aren't in the diff.
- **Misleading statements** — the description characterizes a change differently from what the code actually does.

Report the assessment in chat: either confirm the description is accurate, or list the specific discrepancies. If the PR has no description, note that. Nothing is posted to GitHub in this step — remember the result for the review submission (Section 8).

## 4. Review and classify

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

## 5. Summary table

Present all findings in a markdown table. State explicitly that nothing has been posted to GitHub yet.

| # | Severity | File:Line | Description |
|---|----------|-----------|-------------|
| 1 | Major    | `src/a.py:42` | One-sentence description of the issue. |
| 2 | Minor    | `src/b.js:10` | One-sentence description of the issue. |

## 6. Confirm one-by-one

Walk through the findings in order. For each one, show the file:line, the severity, and the proposed comment body, then ask whether to include it in the review. Accept: skip, edit-then-include, or include as-is. Confirm each finding individually — don't present them as a group. Collect the confirmed ones; they go into a single review assembled in the next step (nothing is sent to GitHub yet).

## 7. Assemble the review (only confirmed findings)

Important: post nothing per finding. Gather every finding the user confirmed in Section 6 into a single review, then submit it in the next step. First check whether you already have a pending review on this PR — pending reviews are visible only to their author and GitHub allows at most one per user, so any `PENDING` entry is yours to reuse:

```
gh api repos/{owner}/{repo}/pulls/{number}/reviews \
  --jq '[.[] | select(.state=="PENDING")][0] | {id, node_id}'
```

Whenever the fix is a concrete code change, end the comment body with a GitHub `suggestion` block so the author can apply it with one click. The body has the form:

````
<one-sentence description of the issue>

```suggestion
<the exact replacement code>
```
````

The `suggestion` block replaces the comment's target line(s) verbatim, so it must contain the complete intended replacement — correctly indented and with no diff markers. Skip the block for findings that have no single concrete replacement (e.g. "extract this into a helper").

Build the review one of two ways, depending on the pending-review check above. In both, each comment's `body` is the text described above (its description plus the optional `suggestion` block):

**No pending review exists — create one holding every confirmed comment in a single call.** Omit `event` so the review stays pending. The `comments` array can't be expressed with `-f`/`-F`, so pass JSON via `--input` (escape newlines in bodies as `\n`):

```
gh api repos/{owner}/{repo}/pulls/{number}/reviews --method POST --input - <<'JSON'
{
  "commit_id": "<headRefOid>",
  "comments": [
    {"path": "src/a.py", "line": 42, "side": "RIGHT", "body": "<description + optional suggestion block>"},
    {"path": "src/b.js", "start_line": 8, "start_side": "RIGHT", "line": 10, "side": "RIGHT", "body": "<description>"}
  ]
}
JSON
```

Capture the returned review `id` — you submit it in Section 8. Use `line`+`side` for a single line; for a multi-line range add `start_line`+`start_side`.

**A pending review already exists — reuse it.** Add each confirmed finding to that review via GraphQL, targeting its `node_id`:

```
gh api graphql -f query='
  mutation($review: ID!, $path: String!, $line: Int!, $body: String!) {
    addPullRequestReviewThread(input: {
      pullRequestReviewId: $review, path: $path, line: $line, side: RIGHT, body: $body
    }) { thread { id } }
  }' -f review="<node_id>" -f path="<file path>" -F line=<line number> -f body="<comment>"
```

For a multi-line range, also declare `$startLine: Int!` and pass `startLine: $startLine, startSide: RIGHT` with `-F startLine=<first line>`. To avoid duplicating a finding already in a reused review, first list its comments (`gh api repos/{owner}/{repo}/pulls/{number}/reviews/{review_id}/comments`) and skip any match on path + line + body.

Comment only on lines present in the diff so each comment targets a valid position. Never include a finding the user skipped. Keep comments specific and actionable.

## 8. Submit the review

Once every confirmed finding is in the pending review (created or reused in Section 7), ask the user whether they want to **approve the PR** or **just leave the comments**. Submit that pending review by its `review_id` — the `id` captured in Section 7 — which publishes it together with all of its inline comments at once. Use this submit endpoint, not `gh pr review`, which would open a separate review without these comments.

If the accuracy check (Section 3) found the PR description inaccurate, offer to fold a brief note about the discrepancy into the review body — for either choice below. Only include the note if the user confirms.

- **Approve** — submit with `event=APPROVE`. In the body, give a short reasoning for approving: note that the remaining findings are minor and are recommendations or preferences rather than blockers.

  ```
  gh api repos/{owner}/{repo}/pulls/{number}/reviews/{review_id}/events \
    --method POST -f event=APPROVE -f body="<reasoning>"
  ```

- **Comment only** — submit with `event=COMMENT`. In the body, give a short summary of how many issues were found (e.g. how many major and minor).

  ```
  gh api repos/{owner}/{repo}/pulls/{number}/reviews/{review_id}/events \
    --method POST -f event=COMMENT -f body="<summary>"
  ```

## 9. Wrap up

Summarize which comments were included in the review, which were skipped, whether the PR description was flagged as inaccurate (and whether a note about it was added to the review), and whether the PR was approved or left with comments.
