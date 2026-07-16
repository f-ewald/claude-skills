==============================================================================
 ultracode deterministic engine
==============================================================================

ultracode provides standing multi-agent orchestration patterns plus a
zero-dependency Node engine for runtimes without a native Workflow tool. The
engine shells out to a supported headless CLI once per subagent while enforcing
cwd, tool profiles, deadlines, retries, structured output, and process cleanup.


------------------------------------------------------------------------------
 1. Requirements and installation
------------------------------------------------------------------------------
  - Node.js >= 18.
  - GitHub Copilot CLI or Claude Code CLI, installed and authenticated.
  - The complete ultracode directory:
        SKILL.md
        orchestrate.mjs
        workflow.template.mjs
        README.txt

Install or symlink the whole directory into a runtime skill location:

    ~/.copilot/skills/ultracode/
    ~/.agents/skills/ultracode/
    ~/.claude/skills/ultracode/


------------------------------------------------------------------------------
 2. Session workspace workflow files
------------------------------------------------------------------------------
Do not create generated run files inside an installed or symlinked skill
directory. Copy workflow.template.mjs into a session workspace under the
repository you are working in. The template has an engine resolver: set
ULTRACODE_ENGINE to the absolute installed orchestrate.mjs path, or let it check
the standard skill locations.

Example, run from the repository under review:

    mkdir -p .copilot-session
    cp "$HOME/.copilot/skills/ultracode/workflow.template.mjs" \
       .copilot-session/review.mjs

    ULTRACODE_ENGINE="$HOME/.copilot/skills/ultracode/orchestrate.mjs" \
    ULTRACODE_CWD="$PWD" \
    ULTRACODE_CLI=copilot \
    node .copilot-session/review.mjs src/example.mjs

Targets are resolved to absolute paths against ULTRACODE_CWD. Each subagent
process also executes with that cwd. A workflow may override cwd per agent with
agent(prompt, {cwd: '/absolute/repository/path'}).


------------------------------------------------------------------------------
 3. Safe profiles and explicit write opt-in
------------------------------------------------------------------------------
ULTRACODE_PROFILE controls both tool availability and approval flags.

    local-read     default; view, rg, and glob only
    research-read  local-read plus web_fetch
    write          explicit write/command capability

For Copilot, read profiles pass both --available-tools and matching
--allow-tool flags. All noninteractive Copilot subagents also use
--no-ask-user, --no-remote-export, and --disallow-temp-dir. Their automatic
file boundary is therefore ULTRACODE_CWD (or the per-agent cwd), even when that
explicit cwd itself is located under the system temporary directory.

Use research-read only when the task genuinely needs external research.
`web_search` is intentionally unavailable because Copilot URL grants do not
constrain it. Copilot requires explicit URL/domain grants for web_fetch:

    ULTRACODE_PROFILE=research-read \
    ULTRACODE_ALLOWED_URLS='https://docs.example.com,api.example.com' ...

Workflows may provide the same grants per agent:

    agent(prompt, {
      profile: 'research-read',
      allowedUrls: ['https://docs.example.com', 'api.example.com'],
    })

Grant only the destinations required for the task. The engine rejects a global
wildcard; there is no all-URL compatibility fallback.

The deterministic Claude CLI adapter supports local-read but rejects
research-read because it cannot enforce these URL grants. Use Claude's native
Workflow/runtime permission controls for research instead; the engine does not
expose unrestricted WebFetch as a fallback.

Write or command execution is never a compatibility fallback. Opt in in the
workflow and mark the effect:

    agent(prompt, {
      profile: 'write',
      effect: 'write',       // or 'exec'
      retries: 0,
    })

The write profile disables approval prompts for the selected headless CLI.
Use it only for trusted prompts and repositories. It also passes
--disallow-temp-dir by default. If a write workflow genuinely needs Copilot's
automatic temp-directory access, opt in explicitly:

    agent(prompt, {profile: 'write', effect: 'write', allowTempDir: true})

or set ULTRACODE_ALLOW_TEMP_DIR=true for that workflow.

Custom project/global instruction inheritance is explicit:

    ULTRACODE_INHERIT_INSTRUCTIONS=false   default; isolated subagents
    ULTRACODE_INHERIT_INSTRUCTIONS=true    inherit runtime instructions


------------------------------------------------------------------------------
 4. Deadlines, cancellation, and retries
------------------------------------------------------------------------------
Each agent has one overall deadline covering queue wait and every attempt:

    ULTRACODE_DEADLINE_MS=600000
    agent(prompt, {deadlineMs: 120000})

ULTRACODE_TIMEOUT_MS remains a deprecated deadline alias when
ULTRACODE_DEADLINE_MS is absent.

On deadline or parent SIGINT/SIGTERM, the engine terminates the subprocess
process group and escalates to SIGKILL after a short grace period. Stdout and
stderr capture are bounded.

Read-only agents default to ULTRACODE_RETRIES=2. Retries occur only for:
  - parse failures;
  - schema failures; or
  - classified transient process failures.

Write/exec-capable agents default to zero retries. A write-capable retry occurs
only when the workflow explicitly declares idempotency:

    agent(prompt, {
      profile: 'write',
      effect: 'write',
      idempotent: true,
      retries: 1,
    })


------------------------------------------------------------------------------
 5. Structured envelopes and schema subset
------------------------------------------------------------------------------
agent() always returns one of:

    {ok: true, value, attempts, meta?}

    {
      ok: false,
      error: {
        kind,
        message,
        retryable,
        incompleteCount,
        diagnostics?,
      },
      attempts,
      meta?,
    }

There is no null-as-success behavior. Bounded diagnostics describe failed
attempts. pipeline() stops an item on a failed envelope and records
pipelineIndex and failedStage, so required stage failures remain visible.

run() prints one final envelope to stdout; progress prints to stderr.

The schema validator intentionally supports only this bounded recursive subset:

    type, required, properties, items, enum, minItems

Unsupported keywords are rejected before launching a CLI. This is not a claim
of full JSON Schema support.


------------------------------------------------------------------------------
 6. Engine API
------------------------------------------------------------------------------
The ES module exports:

    ENGINE_CAPABILITIES
    agent(prompt, options)
    map(items, mapper)
    parallel(thunks)
    pipeline(items, ...stages)
    synthesize(inputs, promptOrBuilder, options)
    phase(title)
    log(message)
    run(main)
    resolveTarget(target, cwd)
    resolveEngineSpecifier(location)
    validateSchemaDefinition(schema)
    validateStructuredValue(value, schema)
    buildAdapterArguments(prompt, configuration)
    deterministicSort(values, keys)

ENGINE_CAPABILITIES.copilotReadDisallowTempDir is true when the engine enforces
--disallow-temp-dir for every Copilot read profile. Composed workflows may
require this capability and fail preflight against older engines.

The shipped template demonstrates local-read defaults, absolute targets,
structured envelopes, configurable verifier voting, a bounded completeness
critic loop, deterministic ordering, and explicit failure metadata.


------------------------------------------------------------------------------
 7. Configuration
------------------------------------------------------------------------------
    ULTRACODE_CLI                  copilot | claude (default: copilot)
    ULTRACODE_CLI_BIN              executable override
    ULTRACODE_CWD                  subagent working directory
    ULTRACODE_PROFILE              local-read | research-read | write
    ULTRACODE_ALLOWED_URLS         comma-separated Copilot research URL/domain grants
    ULTRACODE_ALLOW_TEMP_DIR       true only for write-profile temp access
    ULTRACODE_INHERIT_INSTRUCTIONS true | false (default: false)
    ULTRACODE_MODEL                model override
    ULTRACODE_CONCURRENCY          max active subprocesses (default: 4)
    ULTRACODE_RETRIES              read-agent retry count (default: 2)
    ULTRACODE_DEADLINE_MS          overall per-agent deadline (default: 600000)
    ULTRACODE_TIMEOUT_MS           deprecated deadline alias

Template-only controls:

    ULTRACODE_ENGINE               absolute orchestrate.mjs path or file URL
    ULTRACODE_THOROUGH             false for lightweight mode
    ULTRACODE_VERIFIER_VOTES       1..5
    ULTRACODE_CRITIC_ROUNDS        0..3


------------------------------------------------------------------------------
 8. Option B: runtime-managed orchestration
------------------------------------------------------------------------------
When Node or a supported CLI adapter is unavailable, use the runtime's native
subagent tool. Keep dispatches flat and drive explicit
dispatch -> collect -> deduplicate -> verify -> synthesize rounds. Require
subagents to return JSON, track failures, and retain the same safe-profile and
cwd intent wherever the runtime supports those controls.
==============================================================================
