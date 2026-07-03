/**
 * ultracode/orchestrate.mjs — a tiny deterministic multi-agent orchestration engine.
 *
 * Purpose: give runtimes that have NO native workflow engine (Copilot CLI, Codex,
 * Gemini, plain shells) the same deterministic fan-out that Claude Code's `Workflow`
 * tool provides — pipeline/parallel control flow, a concurrency cap, retries, and
 * schema-validated structured output — by shelling out to a host CLI's headless mode
 * once per subagent.
 *
 * It mirrors the Workflow API surface: agent(), parallel(), pipeline(), phase(), log(),
 * plus run() to execute a workflow and print its JSON result to stdout.
 *
 * Zero dependencies. Node >= 18 (ESM). Used by writing a workflow file that imports
 * these primitives and running it with `node my-workflow.mjs`.
 *
 * ─── Runtime adapters (set ULTRACODE_CLI) ───────────────────────────────────────────
 *   copilot (default) : copilot -p <prompt> --silent --no-color --log-level none <perm> [--model M]
 *   claude            : claude  -p --output-format json <perm> [--model M] <prompt>
 * Both invoked via execFile with an args array (shell:false) so prompts may contain
 * any quotes/newlines with no escaping. Each call spawns a REAL subagent of the host
 * CLI — fresh context — exactly like a Workflow agent() call.
 *
 * ─── Permissions: SAFE BY DEFAULT ───────────────────────────────────────────────────
 * By default subagents get a READ-ONLY tool allowlist (read/search/web-fetch) and
 * CANNOT write files or run arbitrary shell. This suits the core ultracode use case:
 * review / research / audit fan-outs that only read and search.
 *
 *   ULTRACODE_PERMS=read-only  (DEFAULT) — read/search-only allowlist; no writes/exec.
 *   ULTRACODE_PERMS=all                  — FULL AUTONOMY. Disables the host CLI's
 *                                          approval gates (copilot --allow-all-tools,
 *                                          claude --permission-mode bypassPermissions).
 *                                          Only set this when a workflow's subagents
 *                                          must edit files or run commands, and you
 *                                          trust the prompts. You are turning off the
 *                                          safety prompts — opt in deliberately.
 *
 * ─── Configuration (environment variables) ──────────────────────────────────────────
 *   ULTRACODE_CLI            copilot | claude            (default: copilot)
 *   ULTRACODE_CLI_BIN        override the binary path     (default: the CLI name on PATH)
 *   ULTRACODE_MODEL          model passed to each subagent (default: CLI's own default)
 *   ULTRACODE_CONCURRENCY    max concurrent subagents     (default: 4)
 *   ULTRACODE_RETRIES        retries on failure/bad-JSON  (default: 2)
 *   ULTRACODE_TIMEOUT_MS     per-subagent timeout         (default: 600000)
 *   ULTRACODE_PERMS          read-only | all             (default: read-only)
 *   ULTRACODE_CLAUDE_TOOLS   claude read-only allowlist   (default: Read,Grep,Glob,LS,WebFetch,WebSearch)
 *   ULTRACODE_COPILOT_TOOLS  copilot read-only allowlist  (default: view,rg,glob,web_fetch,web_search)
 */

import { execFile } from 'node:child_process'

// Parse an integer env var, falling back to `def` on missing/non-numeric/NaN input.
// (A bare Math.max(min, parseInt(...)) yields NaN for "auto"/whitespace, and NaN as a
// concurrency cap deadlocks the whole engine — every acquire() queues forever.)
function intEnv(name, def, min) {
  const n = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(n) ? Math.max(min, n) : def
}

// ─── Config ─────────────────────────────────────────────────────────────────────────
const CLI = (process.env.ULTRACODE_CLI || 'copilot').toLowerCase()
const BIN = process.env.ULTRACODE_CLI_BIN || CLI
const DEFAULT_MODEL = process.env.ULTRACODE_MODEL || ''
const CONCURRENCY = intEnv('ULTRACODE_CONCURRENCY', 4, 1)
const RETRIES = intEnv('ULTRACODE_RETRIES', 2, 0)
const TIMEOUT = intEnv('ULTRACODE_TIMEOUT_MS', 600000, 1000)
const PERMS = (process.env.ULTRACODE_PERMS || 'read-only').toLowerCase()
const CLAUDE_TOOLS = (process.env.ULTRACODE_CLAUDE_TOOLS || 'Read,Grep,Glob,LS,WebFetch,WebSearch')
  .split(',').map((s) => s.trim()).filter(Boolean)
const COPILOT_TOOLS = (process.env.ULTRACODE_COPILOT_TOOLS || 'view,rg,glob,web_fetch,web_search')
  .split(',').map((s) => s.trim()).filter(Boolean)

const OPEN = '<<<ULTRACODE_JSON>>>'
const CLOSE = '<<<ULTRACODE_END>>>'

let launched = 0
process.stderr.write(
  `ultracode-engine: cli=${CLI} perms=${PERMS} concurrency=${CONCURRENCY} model=${DEFAULT_MODEL || '(default)'}\n`)
if (PERMS === 'all') process.stderr.write('  ! ULTRACODE_PERMS=all — subagent approval gates are DISABLED\n')

// ─── Logging (stderr; stdout is reserved for the final JSON result) ───────────────────
export function phase(title) { process.stderr.write(`\n▶ ${title}\n`) }
export function log(msg) { process.stderr.write(`  ${msg}\n`) }
function warn(msg) { process.stderr.write(`  ! ${msg}\n`) }

// ─── Concurrency semaphore (bounds real subprocesses, like Workflow's cap) ────────────
let active = 0
const waiters = []
function acquire() {
  if (active < CONCURRENCY) { active++; return Promise.resolve() }
  return new Promise((resolve) => waiters.push(resolve))
}
function release() {
  active--
  const next = waiters.shift()
  if (next) { active++; next() }
}

// ─── Structured-output contract + extraction ──────────────────────────────────────────
function withContract(prompt, schema) {
  return `${prompt}

────────────────────────────────────────
OUTPUT CONTRACT (mandatory):
Return your result as ONE JSON object matching this JSON Schema:
${JSON.stringify(schema, null, 2)}

Output NOTHING but that JSON object, wrapped EXACTLY between these two marker lines:
${OPEN}
{ ...your JSON here... }
${CLOSE}
No prose, no markdown fences, nothing outside the markers.`
}

function extractJson(text) {
  let body = text
  const mi = text.indexOf(OPEN)
  const ci = text.lastIndexOf(CLOSE)
  if (mi !== -1 && ci !== -1 && ci > mi) body = text.slice(mi + OPEN.length, ci)
  body = body.trim()
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) body = fence[1].trim()
  try { return JSON.parse(body) } catch { /* fall through to brace scan */ }
  const s = body.indexOf('{')
  const e = body.lastIndexOf('}')
  if (s !== -1 && e > s) {
    try { return JSON.parse(body.slice(s, e + 1)) } catch { /* fall through to a clear error */ }
  }
  throw new Error('no parseable JSON object found in subagent output')
}

// ─── Per-runtime permission flags ─────────────────────────────────────────────────────
function permArgs() {
  if (CLI === 'claude') {
    return PERMS === 'all'
      ? ['--permission-mode', 'bypassPermissions']
      : ['--allowedTools', CLAUDE_TOOLS.join(',')]
  }
  // copilot
  return PERMS === 'all'
    ? ['--allow-all-tools']
    : COPILOT_TOOLS.flatMap((t) => ['--allow-tool', t])
}

// runChild: spawn one CLI subprocess with a HARD wall-clock deadline. The promise
// ALWAYS settles by TIMEOUT — execFile's own `timeout` only sends SIGTERM and never
// force-settles, so a child that ignores SIGTERM (or leaves a grandchild holding the
// stdout pipe) would otherwise pin a concurrency slot forever and deadlock the fan-out.
// On the deadline we SIGKILL the child and reject, guaranteeing the slot is released.
// On any failure, err.stdout is preserved (claude prints its error envelope there).
function runChild(bin, args) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer
    const settle = (fn, val) => { if (settled) return; settled = true; clearTimeout(timer); fn(val) }
    const child = execFile(bin, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) { err.stdout = stdout; settle(reject, err) } else settle(resolve, stdout)
    })
    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      settle(reject, new Error(`timed out after ${TIMEOUT}ms`))
    }, TIMEOUT)
    if (timer.unref) timer.unref()
  })
}

// ─── CLI invocation (one real subagent per call) ──────────────────────────────────────
async function invokeCli(prompt, model) {
  const m = model || DEFAULT_MODEL
  let args
  if (CLI === 'claude') {
    // prompt placed first (right after -p) so the variadic --allowedTools can't swallow it
    args = ['-p', prompt, '--output-format', 'json', ...permArgs(), ...(m ? ['--model', m] : [])]
  } else { // copilot (and compatible)
    args = ['-p', prompt, '--silent', '--no-color', '--log-level', 'none', ...permArgs(), ...(m ? ['--model', m] : [])]
  }
  let stdout
  try {
    stdout = await runChild(BIN, args)
  } catch (e) {
    // claude prints a JSON error envelope to stdout even on a non-zero exit — recover it
    // so the retry log carries the real reason (auth, usage-limit, …) not a generic spawn error.
    if (CLI === 'claude' && e && typeof e.stdout === 'string' && e.stdout.trim()) {
      let env = null
      try { env = JSON.parse(e.stdout) } catch { /* not an envelope; fall through */ }
      if (env) throw new Error(`claude error: ${(env.subtype || env.type || '').toString()} ${String(env.result || '').slice(0, 200)}`.trim())
    }
    throw new Error(`${CLI} invocation failed${e && e.code != null ? ` (exit ${e.code})` : ''}: ${e && e.message}`)
  }
  if (CLI === 'claude') {
    const env = JSON.parse(stdout)
    if (env.is_error) throw new Error(`claude error: ${env.subtype || ''} ${String(env.result || '').slice(0, 200)}`)
    return env.result || ''
  }
  return stdout
}

// ─── agent(): dispatch one subagent; with `schema`, returns validated object ───────────
export async function agent(prompt, opts = {}) {
  const { schema, model, label } = opts
  const name = label || prompt.replace(/\s+/g, ' ').slice(0, 48)
  await acquire()
  const id = ++launched
  process.stderr.write(`  → [${id}] ${name}\n`)
  try {
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      const promptForTry = !schema
        ? prompt
        : (attempt === 0
            ? withContract(prompt, schema)
            : withContract(prompt, schema) + '\n\nYour previous reply could not be parsed. Return ONLY the JSON between the markers.')
      try {
        const out = await invokeCli(promptForTry, model)
        if (!schema) return out.trim()
        const obj = extractJson(out)
        const missing = (schema.required || []).filter((k) => !(k in obj))
        if (missing.length) throw new Error(`missing required keys: ${missing.join(', ')}`)
        return obj
      } catch (e) {
        warn(`[${id}] ${name} attempt ${attempt + 1}/${RETRIES + 1} failed: ${e.message}`)
        if (attempt === RETRIES) { warn(`[${id}] ${name} → null (gave up)`); return null }
      }
    }
    return null // defensive: never resolve undefined even if the loop range is empty
  } finally {
    release()
  }
}

// ─── parallel(): run thunks concurrently, await all (BARRIER). Failures → null. ────────
export async function parallel(thunks) {
  return Promise.all(thunks.map((t) =>
    Promise.resolve().then(t).catch((e) => { warn(`parallel task failed: ${e.message}`); return null })))
}

// ─── pipeline(): each item flows through all stages independently, NO barrier. ─────────
// stage signature: (prevResult, originalItem, index) => next. A throwing stage drops
// that item to null and skips its remaining stages.
export async function pipeline(items, ...stages) {
  return Promise.all(items.map(async (item, i) => {
    let v = item
    try {
      for (const stage of stages) v = await stage(v, item, i)
      return v
    } catch (e) { warn(`pipeline item ${i} dropped: ${e.message}`); return null }
  }))
}

// ─── run(): execute a workflow body; print its return value as JSON to stdout. ─────────
export async function run(main) {
  try {
    const result = await main()
    process.stdout.write(JSON.stringify(result ?? null, null, 2) + '\n')
  } catch (e) {
    process.stderr.write(`workflow failed: ${e.stack || e.message}\n`)
    process.exitCode = 1
  }
}
