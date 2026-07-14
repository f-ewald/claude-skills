<!--
Deep-research report template.
Read by the `deep-research` skill in Phase 6. Replace every {placeholder} and remove the
guidance comments before emitting. Keep the section order intact.
-->

# {Title}

Created — {Current Date}
Depth — {quick | standard | exhaustive}

## TL;DR

<!-- 3–6 sentences, written LAST. The question, the headline answer, and the confidence.
A reader should grasp the whole report from this. -->

{One short paragraph: the question, the answer, and the bottom line.}

## Scope & Method

<!-- What was and wasn't investigated, the perspectives covered, the sources used (internal
tools if any, else web), the orchestration mechanism, and how claims were verified. -->

- **Question:** {the research question}
- **Perspectives covered:** {angle 1}, {angle 2}, …
- **Sources:** {web / internal MCP tools / both}
- **Verification:** load-bearing facts resolved from authoritative/primary sources and adversarially verified ({n} confirmed, {r} refuted, {u} unconfirmed); the synthesized conclusion was then red-teamed by a separate adversary (verdict: {survives | qualified | overturned})

## Key Findings

<!-- Grouped by theme/perspective. Lead with the most important. Cite sources inline by
number, e.g. [1]. -->

### {Theme / perspective 1}

- {finding} [n]

### {Theme / perspective 2}

- {finding} [n]

## Evidence & Analysis

<!-- The reasoning that ties findings together — comparisons, trade-offs, trends. Ground every
load-bearing statement in a cited source. -->

{Analysis.}

## Verified vs. Unverified Claims

**Confirmed (authoritative/primary source):**

- {claim} — {source} [n]

**Refuted (primary source contradicts the claim):**

- {claim} — {what the source actually shows} [n]

**Unconfirmed (could not establish — kept, NOT treated as false):**

- {claim} — {scope checked: sources / versions / conditions, and why it stayed open}

## Assumptions Made

<!-- The auto-answered questions from the question-tree phase. Surfaced so the reader can spot
any they would answer differently. -->

| # | Question | Assumed answer | Rationale |
|---|----------|----------------|-----------|
| 1 | {question} | {answer} | {one line} |
| 2 | {question} | {answer} | {one line} |

## Open Questions

- {something still undecided or needing input / further research}

## Adversarial Review (Red-Team)

<!-- A separate adversary took the position that this report's own conclusion is FALSE and built the
strongest good-faith case against it. Summarize that case and how it was resolved; the conclusion
below must reflect this outcome. -->

- **Strongest counter-thesis:** {the best opposing view}
- **Weak points raised:** {specific points, each naming the finding/step it targets}
- **Would flip the conclusion if wrong:** {the load-bearing claims the conclusion most depends on}
- **Verdict:** {survives | holds only with caveats | overturned} — {why the counter-case does or doesn't succeed}
- **Residual doubts:** {what remains genuinely uncertain}

## Recommendation / Conclusion

<!-- The bottom-line answer and why, given the evidence above AND the red-team outcome. State whether
the conclusion survived as-is, was qualified with caveats, or was revised. -->

{The conclusion and the reasoning behind it.}

## References

<!-- Every source, numbered and deduped. Cite these inline above by number. -->

1. {Title} — {URL}
2. {Title} — {URL}
