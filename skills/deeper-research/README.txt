==============================================================================
 deeper-research — deterministic workflow guide
==============================================================================

This package deliberately uses the name deeper-research. It does not install a
deep-research alias and therefore does not shadow Claude Code's bundled command.

The package ships a workflow TEMPLATE, not an orchestration engine. Every run
imports the one installed ultracode/orchestrate.mjs through ULTRACODE_ENGINE or
a standard skill location.


------------------------------------------------------------------------------
 Requirements
------------------------------------------------------------------------------
  - Node.js >= 18 for the deterministic path.
  - GitHub Copilot CLI or Claude Code CLI, installed and authenticated.
  - The ultracode skill installed in one of:
        ~/.copilot/skills/ultracode/
        ~/.agents/skills/ultracode/
        ~/.claude/skills/ultracode/
    Or set ULTRACODE_ENGINE to its orchestrate.mjs.

No generated workflow or report is required inside this skill directory.


------------------------------------------------------------------------------
 Session-workspace run
------------------------------------------------------------------------------
Run from the repository/workspace being researched:

    mkdir -p .copilot-session
    cp "$HOME/.copilot/skills/deeper-research/research.workflow.template.mjs" \
       .copilot-session/deeper-research.mjs

    ULTRACODE_ENGINE="$HOME/.copilot/skills/ultracode/orchestrate.mjs" \
    ULTRACODE_CWD="$PWD" \
    ULTRACODE_CLI=copilot \
    DEEPER_RESEARCH_MODE=standalone \
    DEEPER_RESEARCH_DEPTH=standard \
    ULTRACODE_ALLOWED_URLS='https://docs.example.com,example.com' \
    node .copilot-session/deeper-research.mjs "Your research question" \
      > .copilot-session/research-result.json

The workflow performs an explicit preflight. It fails closed if the shared
engine, cwd, blocking-question resolution, or public URL grants are missing.
Progress goes to stderr. Stdout is one ultracode envelope:

    { "ok": true, "value": { ... }, "attempts": 0 }

Required researcher/verifier/critic/synthesis/red-team failures and rejected
source-invalid findings remain in value.failures and set value.incomplete when
appropriate.


------------------------------------------------------------------------------
 Invocation mode
------------------------------------------------------------------------------
Standalone mode is the default:

    DEEPER_RESEARCH_MODE=standalone

It returns the evidence state for the skill to use during its normal end
checkpoint, report filename confirmation, Markdown emission, and conversions.

Embedded/evidence-only mode:

    DEEPER_RESEARCH_MODE=embedded

It still runs framing, research, completeness, verification, synthesis, and the
gated red team, but returns the structured evidence bundle to the caller. It
skips filename confirmation, report file emission, and conversions. The
design-doc skill uses this mode so evidence is incorporated before its
recommendation sign-off instead of producing a separate research report first.

The JSON includes mode=embedded, evidenceBundleVersion=1, and
outputDisposition.evidenceOnly=true. The bundle retains sources, evidence
states, assumptions, failures, coverage, synthesis, and red-team status.

Synthesis and red-team outputs receive semantic validation after schema
validation. Required thesis/summary/analysis/recommendation/evidence-limit and
counter-thesis/reasoning/weak-point/flipping-claim/residual-doubt fields are
trimmed and must remain nonblank. Invalid outputs become visible inconclusive
failure envelopes.


------------------------------------------------------------------------------
 Exact depth controls
------------------------------------------------------------------------------
    quick       3 researchers, 1 verifier vote, 1 completeness pass
    standard    6 researchers, 2 verifier votes, up to 2 rounds
    exhaustive  8-12 researchers (default 10), 3 votes, up to 3 rounds

Set:

    DEEPER_RESEARCH_DEPTH=quick|standard|exhaustive

For exhaustive only:

    DEEPER_RESEARCH_EXHAUSTIVE_ANGLES=8..12

Values outside that range are bounded to it.


------------------------------------------------------------------------------
 Source safety and URL permissions
------------------------------------------------------------------------------
Public Copilot research always uses profile research-read and requires:

    ULTRACODE_ALLOWED_URLS='https://docs.example.com,api.example.com'

The list must be explicit and bounded. "*" is rejected. The workflow never uses
a write profile, shell fallback, or all-tool/all-URL grant.

The adapter creates an empty temporary cwd outside ULTRACODE_CWD for public
researchers, public verifiers, and public-only completeness critics. It removes
that exact generated directory in finally. Public or mixed runs fail closed if
this isolation cannot be established. Internal agents remain local-read in
ULTRACODE_CWD.

The installed ultracode engine must expose
ENGINE_CAPABILITIES.copilotReadDisallowTempDir=true and pass
--disallow-temp-dir for Copilot read profiles. Public research fails preflight
with an upgrade message when that capability is unavailable.

Public citations are accepted only when they are bounded credential-free
HTTP(S) URLs covered by ULTRACODE_ALLOWED_URLS. Invalid or out-of-grant findings
remain visible in failure metadata. Verifier votes also require nonblank
reasoning, checked scope, source limitations, and a valid best source.

Public research-read agents receive allowlisted web_fetch only. web_search is
unavailable because configured URL grants do not constrain its discovery
results.

Bare domain and wildcard grants cover HTTPS only. Explicit http:// and https://
grants cover only their declared protocol. Findings also require trimmed,
nonblank claim, evidence, checked scope, and source limitations.

Public deterministic ULTRACODE_CLI=claude runs fail closed even when an
allowlist is supplied: the current ultracode Claude adapter cannot enforce URL
grants. Use native Claude Workflow/runtime permissions for public Claude
research, or use the Copilot deterministic engine. Internal/local-only
deterministic Claude runs remain allowed.

For internal/private research:

    DEEPER_RESEARCH_SENSITIVITY=internal

All selected angles then use local/internal read-only scope with no public web.
For isolated mixed-source work, keep the topic public-safe and list internal
angles:

    DEEPER_RESEARCH_INTERNAL_ANGLES='technical,implementation'

Keys are canonicalized to lowercase. Duplicate, unknown, or depth-unselected
keys fail preflight together rather than silently becoming public.

Internal findings are never passed to a public downstream agent. Use only
already configured approved internal read-only tools; do not probe speculative
tool names. Public tools are only for non-sensitive content.

Synthesis and red-team agents never receive web tools. They run local-read in
the internal cwd whenever any included evidence, failure, or completeness
metadata originated internally; entirely public payloads use the sanitized
public cwd.

Completeness suggestions store requested follow-up scope in
suggestedSourceScope. Provenance is attached separately as
executionSourceScope from the actual critic invocation; returned sourceScope
fields are discarded.


------------------------------------------------------------------------------
 Heterogeneous model policy
------------------------------------------------------------------------------
Optionally configure available models:

    ULTRACODE_MODELS='family-a:cheap:model-a-mini,\
family-a:strong:model-a-pro,family-b:cheap:model-b-mini,\
family-b:strong:model-b-pro'

Cheap models perform discovery and completeness criticism. Strong models perform
verification, synthesis, and red-team work. Families rotate, and a different
family is selected when possible.

With zero or one configured model, the workflow records a graceful
single-model fallback and uses ULTRACODE_MODEL or the CLI default as needed.


------------------------------------------------------------------------------
 Output and conversion safety
------------------------------------------------------------------------------
Feed the successful value into templates/report-template.md. Confirm before
overwriting an existing output file.

Write Markdown first. Optional Google Doc/PDF/HTML/DOCX conversions must preserve
the Markdown source on failure; report the failure without deleting or replacing
the report.
==============================================================================
