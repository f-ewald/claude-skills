---
name: design-doc
description: Create a software design document by grilling the user, researching alternatives and best practices, then producing a structured markdown doc (or Google Doc). Use when the user wants to write a design doc / RFC / software design document / technical design.
license: MIT
author: Freddy Ewald
---

# Software Design Document

Produce a reviewed software design document the way a senior engineer would: interrogate the problem, survey prior art, justify a recommendation with research — then write it up. Do **not** dump a blank template on the user. Work through the phases below in order.

The output document has these sections, in this order: Title, Abstract, Reviewers table, Problem Statement, Goals & Non-Goals, Alternatives Considered, Recommendation / Conclusion, Risks & Open Questions, Execution Plan, References. The full template is in [templates/design-doc-template.md](templates/design-doc-template.md) — read it before Phase 5.

## Phase 0 — Output target

Default to a **markdown file**. Switch to a **Google Doc** only if the user explicitly asks for one (e.g. "as a Google doc", "write it to Google docs"). Note the choice and carry it to Phase 6. Do not ask about output format here unless it is genuinely ambiguous.

## Phase 1 — Grill the user

Interview the user relentlessly about the design until you reach a shared understanding. Walk down each branch of the decision tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer so the user can react rather than start from scratch. **If a question can be answered by exploring the codebase, explore the codebase instead of asking.**

Drive the interview to extract exactly the inputs the document needs:

- **Problem & context** — what is broken or missing today, and why it matters now.
- **Who is affected** — users, teams, systems, on-call.
- **Goals & non-goals** — what success looks like, and explicitly what is out of scope.
- **Constraints & requirements** — scale, latency, cost, deadlines, compliance, existing systems to integrate with.
- **Success criteria** — how we will know the design worked.
- **Candidate alternatives** — any approaches the user already has in mind (you will add more in research).

Keep going until the problem is crisp. Use `AskUserQuestion` for discrete choices; use plain prose for open-ended probing. Don't move on while the problem statement is still vague.

**Never fill gaps with assumptions.** If any part of the problem, scope, or a requirement is unclear or missing, stop and ask the user to clarify before continuing — do not guess, do not invent defaults, and do not proceed to later phases on an ambiguous problem. It is always better to ask one more question than to design against an assumed problem. Only state an assumption when the user is genuinely unavailable to answer, and when you do, flag it explicitly as an assumption to confirm.

## Phase 2 — Structured follow-ups

Once the problem is clear, run a focused `AskUserQuestion` round to lock down the remaining metadata the document needs:

- The concrete **set of alternatives** to evaluate (combine the user's with any obvious industry options).
- **Reviewers** — names and teams to pre-fill in the reviewer table.
- **Execution-plan horizon** — rough timeframe / how granular the task breakdown should be.
- **Audience** — who reads this doc (peers, staff+, cross-org), which sets the depth.
- Confirm the **output target** from Phase 0 if it was ambiguous.

## Phase 3 — Research alternatives & best practices

Delegate the heavy lifting. Synthesize a research brief from Phases 1–2 covering: the problem statement, each candidate alternative, and the best-practice angle ("how do mature teams solve X"). Then run the research one of two ways:

- **If multi-agent orchestration is available** (the `Workflow` tool, or an equivalent fan-out mechanism), run a fan-out research workflow: one researcher per candidate alternative plus a best-practices researcher, then an adversarial verification pass on the load-bearing claims, each returning cited sources.
- **Otherwise**, invoke the **`deep-research`** skill with that brief.

Either way the output must be the same: per-alternative evidence (pros, cons, adoption) plus verified key claims, all with source URLs.

Instruct the research to **also consult internal sources** when internal MCP tools are connected - list MCP tools first - to surface internal prior art and existing solutions before recommending an external one. If those tools are not connected, proceed **web-only** and do not block on them.

Keep every cited source — they become the References section. Each alternative should come out of this phase with evidence for its pros, cons, and real-world adoption.

## Phase 4 — Sign-off gate

Before writing anything, present a **summary table of the alternatives** plus your **proposed recommendation**:

| # | Alternative | Pros | Cons |
|---|-------------|------|------|
| 1 | … | … | … |
| 2 | … | … | … |

State clearly that nothing has been written yet, then give your recommendation and reasoning. Let the user **accept**, **edit**, or **redirect**. Iterate until they approve. Do not generate the document until the recommendation is signed off.

## Phase 5 — Assemble the document

Read [templates/design-doc-template.md](templates/design-doc-template.md) and fill every section from the work above:

- Pre-fill the **Reviewers** table rows with the names/teams from Phase 2 (leave Date and Comment blank for reviewers).
- **Alternatives Considered** — one subsection per alternative (summary / pros / cons) plus the comparison table; ground claims in the Phase 3 research.
- **Recommendation** — the signed-off choice and why it beats the alternatives.
- **Execution Plan** — a `Task | Estimate (weeks)` table with a total row, at the granularity agreed in Phase 2.
- **References** — numbered, every source URL from Phase 3.
- Write the **Abstract last** so it accurately summarizes the finished document.

## Phase 6 — Emit

- **Markdown (default):** derive a `kebab-case` slug from the title, propose `./<slug>.md`, confirm the filename with the user, then `Write` the document.
- **Google Doc:** delegate to the **`write-google-docs`** skill — pass the fully assembled **markdown** to `create_google_docs_document` (its tools convert markdown to native Google Docs formatting). Return the document URL to the user.
