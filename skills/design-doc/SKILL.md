---
name: design-doc
description: Create a reviewed software design document by composing the grill-me interview and deeper-research evidence workflows, obtaining recommendation sign-off, and emitting Markdown with an optional Google Docs conversion. Use when the user wants an RFC, software design document, technical design, or a durable design artifact; use grill-me alone for a chat-only stress test.
license: MIT
metadata:
  author: Freddy Ewald
---

# Software Design Document

Produce a reviewed software design document the way a senior engineer would: interrogate the problem, survey prior art, justify a recommendation with research — then write it up. Do **not** dump a blank template on the user. Work through the phases below in order.

The output document has these sections, in this order: Title, Abstract, Reviewers table, Problem Statement, Goals & Non-Goals, Alternatives Considered, Recommendation / Conclusion, Risks & Open Questions, Execution Plan, References. The full template is in [templates/design-doc-template.md](templates/design-doc-template.md) — read it before Phase 5.

## Phase 0 — Output target and identity

Default to a **Markdown file**. Switch to a **Google Doc** only if the user
explicitly requests one. Collect or confirm the document **title** and
**author** before assembly; never infer authorship from the active account.
Note the desired output and carry it to Phase 6. Do not block the design work
merely because an optional Google Docs capability is unavailable.

## Phase 1 — Grill the user

Invoke the **`grill-me`** skill for the interview. If the active harness cannot
nested-invoke another skill, follow `grill-me`'s documented contract directly:
one focused question at a time, recommended defaults with rationale, codebase
grounding, a live in-chat decision ledger, contradiction handling, and final
reconciliation.

Drive the interview to extract exactly the inputs the document needs:

- **Problem & context** — what is broken or missing today, and why it matters now.
- **Who is affected** — users, teams, systems, on-call.
- **Goals & non-goals** — what success looks like, and explicitly what is out of scope.
- **Constraints & requirements** — scale, latency, cost, deadlines, compliance, existing systems to integrate with.
- **Success criteria** — how we will know the design worked.
- **Candidate alternatives** — any approaches the user already has in mind (you will add more in research).

Keep going until the problem is crisp. Use the harness's user-question
capability for discrete choices and ordinary conversation for open-ended
probing. Do not move on while the problem statement is still vague.

**Never silently fill gaps with assumptions.** If any part of the problem,
scope, or a requirement is unclear or missing, stop and ask the user to clarify
before continuing. When the user explicitly delegates a choice with wording
such as "use your judgment," apply the recommended default and record it in the
ledger as an assumption. If the user is unavailable, flag any necessary
assumption for confirmation rather than presenting it as settled fact.

## Phase 2 — Structured follow-ups

Once the problem is clear, ask focused follow-up questions to lock down the
remaining metadata:

- The concrete **set of alternatives** to evaluate (combine the user's with any obvious industry options).
- **Reviewers** — zero or more names and teams. Rows are repeatable and removable.
- **Planning unit** — points, days, weeks, milestones, or `TBD`; estimates are optional.
- **Audience** — who reads this doc (peers, staff+, cross-org), which sets the depth.
- **Title and author** — confirm both explicitly.
- Confirm the **output target** from Phase 0 if it was ambiguous.

## Phase 3 — Research alternatives & best practices

Invoke **`deeper-research` in embedded evidence-only mode** only after the
interview contract is complete and the alternatives are stable. Embedded mode
returns the assumptions, sourced evidence states, failures, limitations,
synthesis, and red-team status to this workflow without writing its own report.
If nested invocation is unavailable, follow that embedded evidence contract
directly. Build a research brief from Phases 1-2 covering the problem, each
candidate alternative, and how mature teams solve the same class of problem.

The output must preserve, per alternative:

- evidence for pros, cons, adoption, operational fit, and risks;
- source URLs and checked scope;
- load-bearing claim classifications;
- separate **verified**, **refuted**, and **unconfirmed** results;
- confidence and material research limitations.

Use only already configured, approved internal read-only sources. Public web
research is appropriate only for non-sensitive material; never send internal
content to public web tools. If a source class is unavailable, continue with
the approved sources and retain that limitation. Keep every cited source for
the References section.

## Phase 4 — Sign-off gate

Before writing anything, present a **summary table of the alternatives** plus your **proposed recommendation**:

| # | Alternative | Pros | Cons |
|---|-------------|------|------|
| 1 | … | … | … |
| 2 | … | … | … |

Add an evidence-status column or concise notes so unconfirmed claims are not
presented as facts. State clearly that nothing has been written yet, then give
your recommendation, reasoning, residual uncertainty, and strongest
counterargument. Let the user **accept**, **edit**, or **redirect**. Iterate
until they approve. Do not generate the document until the recommendation is
signed off.

## Phase 5 — Assemble the document

Read [templates/design-doc-template.md](templates/design-doc-template.md) and fill every section from the work above:

- Pre-fill exactly the confirmed **Reviewers** rows; omit placeholder rows when there are none.
- **Alternatives Considered** — one repeatable subsection per alternative plus a dynamic comparison table; remove unused rows and criteria.
- **Recommendation** — the signed-off choice and why it beats the alternatives.
- **Risks & Open Questions** — preserve refuted and unconfirmed research distinctions rather than flattening uncertainty.
- **Execution Plan** — repeatable task rows using the user's planning unit, or `TBD`; omit a numeric total when estimates are incomparable or absent.
- **References** — numbered, every source URL from Phase 3.
- Write the **Abstract last** so it accurately summarizes the finished document.

## Phase 6 — Emit

- **Markdown (default):** derive a `kebab-case` slug from the title and propose
  `./<slug>.md`. Check whether the path exists. Show the target and require
  explicit confirmation before replacing any existing file, then use the
  harness's file-writing capability.
- **Google Doc:** first confirm a local path and write the completed Markdown
  artifact there. If an approved Google Docs capability is available, delegate
  conversion from that durable source and return both locations. If none is
  available, keep the local Markdown artifact and state that the optional
  conversion could not be performed; do not fail or discard the document.

After emitting, report the artifact location and any remaining unconfirmed
research or open decisions. Do not start implementation unless separately
requested.
