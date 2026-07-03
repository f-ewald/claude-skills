==============================================================================
 ultracode — using it in GitHub Copilot CLI
==============================================================================

ultracode is a skill that puts the agent into a standing multi-agent
orchestration mode: instead of doing substantive work solo, it fans the work
out to subagents, adversarially verifies the findings, and synthesizes. On
Claude Code it drives the native Workflow tool. On Copilot CLI it has no such
engine built in, so this skill ships its own — a small Node script that gives
you the same deterministic fan-out by shelling out to `copilot -p` once per
subagent.

This file explains how to run it under Copilot CLI specifically. For the full
behavioral contract (the patterns, the mandate), read SKILL.md.


------------------------------------------------------------------------------
 0. Requirements
------------------------------------------------------------------------------
  - GitHub Copilot CLI installed and on PATH (the `copilot` command), and
    authenticated (run `copilot` once interactively and sign in if you haven't).
  - Node.js >= 18 on PATH (only needed for Option A, the deterministic engine).
  - This whole `ultracode/` directory, with all of:
        SKILL.md              the skill (behavior + instructions)
        orchestrate.mjs       the deterministic engine
        workflow.template.mjs  a copy-and-adapt example
        README.txt            this file


------------------------------------------------------------------------------
 1. Install
------------------------------------------------------------------------------
Copilot CLI reads user skills from ~/.copilot/skills/ (and also from the
cross-runtime alias ~/.agents/skills/). Copy or symlink the ENTIRE directory —
not just SKILL.md, because Option A needs the .mjs files next to it:

    # copy
    cp -R /Users/fewald/.claude/skills/ultracode ~/.copilot/skills/

    # or symlink (keeps it in sync with the Claude Code copy)
    ln -s /Users/fewald/.claude/skills/ultracode ~/.copilot/skills/ultracode

Confirm Copilot can see it:

    copilot
    > /skills            # ultracode should be listed


------------------------------------------------------------------------------
 2. Invoke it
------------------------------------------------------------------------------
Inside a Copilot CLI session, trigger the skill (e.g. ask to "use ultracode"
or invoke it as a skill). From that point, for the current task, the agent
orchestrates instead of working solo. It will pick one of two mechanisms.


------------------------------------------------------------------------------
 3. Option A — deterministic engine (preferred when Node is available)
------------------------------------------------------------------------------
This gives the closest parity with Claude Code's Workflow tool: a real
concurrency cap, retries, and schema-validated structured output, all driven
by a JS script you can read and re-run.

  Step 1. Copy the template to a working file and edit the CONFIG block +
          prompts for your task. The find -> adversarially-verify pipeline is
          already wired up.

          KEEP THE WORKFLOW FILE IN THIS DIRECTORY (next to orchestrate.mjs).
          The template imports './orchestrate.mjs', and Node resolves that
          relative to the workflow file's own location — not your shell's cwd —
          so a copy in /tmp would fail to find the engine.

              cd ~/.copilot/skills/ultracode
              cp workflow.template.mjs my-review.mjs
              # edit my-review.mjs: set TARGET, DIMENSIONS, prompts

          (If you must keep the workflow elsewhere, change its import line to
          the ABSOLUTE path of orchestrate.mjs, e.g.
          import { ... } from '/Users/you/.copilot/skills/ultracode/orchestrate.mjs'.)

  Step 2. Run it, telling the engine to use Copilot as the subagent runtime.
          Run from this directory, or pass the workflow's full path (the engine
          import still resolves because orchestrate.mjs sits beside it):

              cd ~/.copilot/skills/ultracode
              ULTRACODE_CLI=copilot node my-review.mjs path/to/file.py

          Progress prints to STDERR; the final JSON result prints to STDOUT,
          so you can capture just the result:

              ULTRACODE_CLI=copilot node my-review.mjs src/app.py > result.json

  Step 3. Read the JSON, decide the next phase, and run the next workflow.
          Multi-phase work (understand -> design -> implement -> review) is
          several scripts run back-to-back, reading each result in between.

How it works: each agent() call in your script runs
    copilot -p "<prompt>" --silent --no-color --log-level none <permission flags> [--model M]
as a separate process — a fresh, real Copilot subagent. The engine collects
their outputs, enforces your JSON schema by parsing, retries on bad output,
and bounds how many run at once.


------------------------------------------------------------------------------
 4. Permissions — SAFE BY DEFAULT (important)
------------------------------------------------------------------------------
By default the engine launches subagents with a READ-ONLY tool allowlist
(view, rg, glob, web_fetch, web_search). They can read and search but CANNOT
write files or run arbitrary shell. This fits the core ultracode use case:
review / research / audit fan-outs.

    ULTRACODE_PERMS=read-only   (default)  read/search only; no writes or exec
    ULTRACODE_PERMS=all                    FULL AUTONOMY — passes
                                           --allow-all-tools to copilot, which
                                           DISABLES its approval prompts.

Only set ULTRACODE_PERMS=all when a workflow's subagents must edit files or run
commands AND you trust the prompts. You are turning off the safety gate — do it
deliberately:

    ULTRACODE_PERMS=all ULTRACODE_CLI=copilot node /tmp/my-implement.mjs

Note: Copilot CLI requires non-prompting permissions to run non-interactively.
The read-only default uses per-tool `--allow-tool` grants. If your version of
Copilot refuses to run a prompt non-interactively without --allow-all-tools,
switch to ULTRACODE_PERMS=all (understanding it disables the gate).


------------------------------------------------------------------------------
 5. Configuration (environment variables)
------------------------------------------------------------------------------
    ULTRACODE_CLI            copilot | claude            default: copilot
    ULTRACODE_CLI_BIN        override the binary path     default: the CLI name
    ULTRACODE_MODEL          model for each subagent       default: CLI's default
                             (e.g. ULTRACODE_MODEL=gpt-5.2)
    ULTRACODE_CONCURRENCY    max concurrent subagents      default: 4
    ULTRACODE_RETRIES        retries on failure/bad-JSON   default: 2
    ULTRACODE_TIMEOUT_MS     per-subagent hard timeout     default: 600000
    ULTRACODE_PERMS          read-only | all              default: read-only
    ULTRACODE_COPILOT_TOOLS  read-only allowlist           default:
                             view,rg,glob,web_fetch,web_search

A typo in a numeric var (e.g. ULTRACODE_CONCURRENCY=auto) is ignored and the
default is used — it will not hang. A subagent that exceeds ULTRACODE_TIMEOUT_MS
is force-killed and recorded as null, so one stuck call cannot stall the run.


------------------------------------------------------------------------------
 6. Option B — model-driven loop (no Node required)
------------------------------------------------------------------------------
If Node is unavailable, the agent orchestrates by hand using Copilot's own
`task` tool. Each phase is an explicit dispatch -> collect -> verify cycle:

  1. Fan out a round: issue multiple `task` calls in a SINGLE response so they
     run concurrently — one per finder / dimension / search-angle. Tell each
     subagent: "Return ONLY a JSON object of this shape: {...}. No prose."
  2. Collect: parse each subagent's JSON. Use list_agents / read_agent for
     status or output.
  3. Dedup and decide in your own reasoning.
  4. Verify: fan out a second batch — one skeptic per surviving finding,
     prompted to REFUTE it and return {isReal, confidence, reasoning}. Keep
     only findings the verifiers confirm.
  5. Loop across turns until done (loop-until-dry / completeness critic).

This produces the same find -> verify -> synthesize behavior; the agent loop
plays the role the engine script plays in Option A.


------------------------------------------------------------------------------
 7. Quick smoke test (optional)
------------------------------------------------------------------------------
Verify the engine can drive Copilot subagents on your machine. Write the test
file INSIDE the skill dir so its './orchestrate.mjs' import resolves:

    cd ~/.copilot/skills/ultracode
    cat > uc-hello.mjs <<'EOF'
    import { agent, parallel, run } from './orchestrate.mjs'
    const S = { type:'object', properties:{ result:{} }, required:['result'] }
    run(async () => {
      const [a,b] = await parallel([
        () => agent('Compute 2+2.',   { label:'add', schema:S }),
        () => agent('Compute 10*10.', { label:'mul', schema:S }),
      ])
      return { add:a, mul:b, ok: !!(a && b) }
    })
    EOF

    ULTRACODE_CLI=copilot node uc-hello.mjs
    rm uc-hello.mjs            # clean up when done

Expect a JSON object on stdout with results 4 and 100 and "ok": true.


------------------------------------------------------------------------------
 8. Troubleshooting
------------------------------------------------------------------------------
  - "command not found: copilot"  -> Copilot CLI isn't on PATH. Install it /
    open a shell where `copilot` resolves.
  - It prompts for permission / refuses non-interactive  -> set
    ULTRACODE_PERMS=all (disables the gate; see section 4).
  - "no parseable JSON object found"  -> a subagent didn't honor the output
    contract. The engine already retries (ULTRACODE_RETRIES); raise it, or
    simplify the schema in your workflow's prompts.
  - Subagent returns null  -> it failed all retries or hit the timeout. Check
    the stderr lines (prefixed with "!") for the reason; raise
    ULTRACODE_TIMEOUT_MS for slow tasks.
  - Auth errors  -> run `copilot` interactively once and sign in.

Note: the Copilot adapter's flags are verified against `copilot --help`, but
the engine was executed and proven end-to-end using the Claude adapter; your
first real Copilot run is the final confirmation on your setup.
==============================================================================
