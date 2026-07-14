==============================================================================
 deep-research — running the research workflow in GitHub Copilot CLI
==============================================================================

deep-research fans a single topic out to one researcher subagent per
perspective, adversarially verifies the load-bearing claims, and synthesizes a
cited markdown report. It REUSES the ultracode skill's engine rather than
shipping its own — see ../ultracode/README.txt for engine mechanics, env vars,
permissions, and troubleshooting. This file only covers what is specific to
deep-research. For the behavioral contract (phases, checkpoints, autonomy),
read SKILL.md.


------------------------------------------------------------------------------
 Requirements
------------------------------------------------------------------------------
  - GitHub Copilot CLI installed, on PATH, and authenticated.
  - Node.js >= 18 (for the deterministic-engine option).
  - The `ultracode` skill installed as a SIBLING of this skill, so that
    ../ultracode/orchestrate.mjs resolves:
        skills/deep-research/research.workflow.template.mjs
        skills/ultracode/orchestrate.mjs
    (Both are satisfied by the repo's ~/.claude/skills symlink.) If you install
    deep-research ALONE, edit the import at the top of your workflow file to the
    ABSOLUTE path of orchestrate.mjs.


------------------------------------------------------------------------------
 Run it
------------------------------------------------------------------------------
    cd ~/.copilot/skills/deep-research      # or wherever this skill lives
    cp research.workflow.template.mjs research.run.mjs
    # edit research.run.mjs: set TOPIC (or pass it as an argument) and the
    # ANGLES that fit your question and depth

    ULTRACODE_CLI=copilot node research.run.mjs "Your research question" > result.json

Progress prints to STDERR; the final JSON — findings by angle, confirmed vs.
unverified load-bearing claims, and a deduped source list — prints to STDOUT.
Feed that JSON back into the deep-research Phase 6 synthesis step to write the
markdown report.

KEEP THE WORKFLOW FILE IN THIS DIRECTORY (next to the ../ultracode sibling).
Node resolves the './../ultracode/orchestrate.mjs' import relative to the
workflow file's own location, not your shell's cwd — a copy in /tmp would fail
to find the engine unless you switch the import to an absolute path.


------------------------------------------------------------------------------
 Permissions — keep the read-only default
------------------------------------------------------------------------------
Research only reads and searches, so DO NOT set ULTRACODE_PERMS=all. The
engine's default read-only allowlist (view, rg, glob, web_fetch, web_search) is
exactly what a research fan-out needs. Tuning knobs (ULTRACODE_MODEL,
ULTRACODE_CONCURRENCY, ULTRACODE_TIMEOUT_MS, ULTRACODE_RETRIES, …) are
documented in ../ultracode/README.txt.


------------------------------------------------------------------------------
 Heterogeneous models (optional — cheaper + more diverse)
------------------------------------------------------------------------------
To investigate angles with a MIX of models — different families for diverse
perspectives, cheap models for easy angles and strong models for hard reasoning
and verification — give the workflow a model pool. Either edit the MODELS array
near the top of your research.run.mjs, or set the env var (no editing needed):

    ULTRACODE_MODELS="familyA:cheap:modelA-mini, familyA:strong:modelA-pro, \
                      familyB:cheap:modelB-mini, familyB:strong:modelB-pro" \
    ULTRACODE_CLI=copilot node research.run.mjs "Your research question"

Each entry is family:tier:model-id, where tier is 'cheap' or 'strong'.
Researchers rotate across families; easy angles (ANGLES complexity:'easy') use
cheap models, hard angles use strong ones; and every load-bearing claim is
verified by a strong model from a DIFFERENT family than produced it. Leave the
pool empty to use a single default model everywhere (ULTRACODE_MODEL or the CLI
default) — this feature is strictly "if available."


------------------------------------------------------------------------------
 Company-agnostic sourcing
------------------------------------------------------------------------------
The researcher prompt asks each subagent to use web search/fetch AND any
connected internal research tools. If no internal tools are connected, the run
is simply web-only — nothing is hardcoded to a particular company or vendor.
==============================================================================
