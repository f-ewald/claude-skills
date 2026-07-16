<!--
Deeper-research report template.
Replace every placeholder and remove guidance comments before writing.
Confirm before overwriting an existing output file.
-->

# {Title}

Created — {Current date}
Depth — {quick | standard | exhaustive}
Evidence state — {complete | incomplete | inconclusive}

## TL;DR

<!-- Write last. State the answer, confidence, decisive evidence, and biggest limitation. -->

{Headline answer and confidence.}

## Scope & Method

- **Question:** {research question}
- **Depth controls:** {angle count}, {votes per load-bearing claim},
  {completeness rounds completed / maximum}
- **Source policy:** {public | internal | isolated mixed}
- **Public URL/domain grants:** {explicit grants or none}
- **Internal/public separation:** {how private content was kept from public tools}
- **Public-agent isolation:** {sanitized temporary cwd and cleanup result}
- **Models:** {heterogeneous assignments or single-model fallback}
- **Coverage:** {successful required angles / required angles}
- **Evidence assessment:** {sufficient | inconclusive} — {reason, including zero
  accepted findings or insufficient verified claims}

## Question Tree

| ID | Parent | Question | Answer / assumption | Confidence | Status |
| --- | --- | --- | --- | --- | --- |
| {id} | {parent or —} | {question} | {answer} | {low/medium/high} | {status} |

## Assumptions Ledger

| # | Assumption | Rationale | Confidence | Status |
| --- | --- | --- | --- | --- |
| 1 | {assumption} | {rationale} | {confidence} | {status} |

## Blocking Questions

- {Resolved blocking question and answer, or "None"}

## Key Findings

### {Perspective / theme}

- {Finding with inline reference [n], confidence, and checked scope}

## Evidence & Analysis

{Synthesis grounded only in the structured evidence. Cite every load-bearing
statement and do not generalize beyond checked scope.}

## Claim Status

### Verified

- **{claim}** — {reason quorum verified it}; confidence: {confidence};
  checked: {scope}; limitations: {limitations}; sources: {[n]}

### Refuted

- **{claim}** — {contradicting evidence}; checked: {scope};
  limitations: {limitations}; sources: {[n]}

### Unconfirmed

- **{claim}** — {why quorum was not reached}; successful votes: {x/y};
  verifier failures: {count}; checked: {scope}; limitations: {limitations}

### Non-load-bearing

- {Sourced contextual finding that was not sent to the verifier panel [n]}

## Negative Findings

- **{negative finding}** — exact checked scope: {sources, versions, dates,
  conditions}; confidence: {confidence}; limitations: {limitations} [n]

## Coverage Gaps and Failures

- **Missing/suggested angles:** {angles or none}
- **Remaining gaps:** {gaps or none}
- **Required researcher failures:** {angle + structured envelope or none}
- **Rejected invalid findings:** {blank-source / missing negative-scope records or none}
- **Completeness critic failures:** {round + structured envelope or none}
- **Verifier failures:** {claim + process/schema/semantic vote failures or none}
- **Synthesis/red-team failures:** {structured envelopes or none}

Do not hide this section when the run is incomplete.

## Synthesis

- **Status:** {completed | skipped | inconclusive}
- **Thesis:** {narrowest defensible thesis, if completed}
- **Analysis:** {reasoning that connects verified evidence to the thesis}
- **Recommendation:** {bounded action supported by the evidence}
- **Evidence limits:** {limitations}
- **Reason when not completed:** {reason}

## Adversarial Review

- **Status:** {completed | skipped | inconclusive}
- **Counter-thesis:** {strongest opposing case, if completed}
- **Reasoning:** {why the counter-thesis is the strongest good-faith challenge}
- **Weak points:** {specific targets and why they matter}
- **Would flip the conclusion if wrong:** {load-bearing claims}
- **Verdict:** {survives | qualify | overturn, only when completed}
- **Skipped/inconclusive reason:** {required when no completed verdict exists}
- **Residual doubts:** {genuine uncertainty}

## Recommendation / Conclusion

{Conclusion reconciled with refuted/unconfirmed evidence, incomplete coverage,
and the red-team result. Do not emit success-shaped certainty after a skipped or
inconclusive red team.}

## References

<!-- Deduplicate while preserving URL/URI, checked scope, confidence, limitations,
and negative-finding scope. -->

1. {Title} — {URL or stable source URI}
   - Checked scope: {scope}
   - Confidence: {confidence}
   - Source limitations: {limitations}
   - Negative-finding scope: {scope or not applicable}

## Output Notes

- Markdown source: {path}
- Overwrite confirmed: {yes | not needed}
- Optional conversions: {not requested | succeeded | failed while Markdown was preserved}
