/**
 * Deterministic offline tests for the ultracode orchestration engine and template.
 */

import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  agent,
  buildAdapterArguments,
  deterministicSort,
  ENGINE_CAPABILITIES,
  map,
  pipeline,
  validateSchemaDefinition,
  validateStructuredValue,
} from '../skills/ultracode/orchestrate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = mkdtempSync(
  join(realpathSync(tmpdir()), `claude-skills-ultracode-${process.pid}-`),
);
const FAKE_CLI = join(RUNTIME, 'fake-cli.mjs');
const WORKFLOW_CLI = join(RUNTIME, 'workflow-cli.mjs');
const CALLS = join(RUNTIME, 'calls.jsonl');
const COUNTER = join(RUNTIME, 'counter.txt');
const CLEANUP_MARKER = join(RUNTIME, 'grandchild-survived.txt');
const ENGINE = join(ROOT, 'skills', 'ultracode', 'orchestrate.mjs');
const TEMPLATE = join(ROOT, 'skills', 'ultracode', 'workflow.template.mjs');
const OPEN = '<<<ULTRACODE_JSON>>>';
const CLOSE = '<<<ULTRACODE_END>>>';

mkdirSync(RUNTIME, { recursive: true });
writeFileSync(
  FAKE_CLI,
  `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const sequence = JSON.parse(process.env.FAKE_CLI_SEQUENCE || '[]');
const counterPath = process.env.FAKE_CLI_COUNTER_PATH;
const callsPath = process.env.FAKE_CLI_CALLS_PATH;
const current = existsSync(counterPath) ? Number.parseInt(readFileSync(counterPath, 'utf8'), 10) : 0;
const behavior = sequence[Math.min(current, sequence.length - 1)] || {};
writeFileSync(counterPath, String(current + 1));
appendFileSync(callsPath, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');

if (behavior.ignoreSignals) {
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});
}
if (behavior.spawnGrandchild) {
  const code = "const {writeFileSync}=require('node:fs');" +
    (behavior.ignoreSignals ? "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});" : "") +
    "setTimeout(()=>writeFileSync(process.env.FAKE_CLEANUP_MARKER,'survived'),400)";
  const child = spawn(process.execPath, ['-e', code], {
    env: process.env,
    stdio: 'ignore',
  });
  child.unref();
}
if (behavior.delayMs) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, behavior.delayMs));
}
if (behavior.stderr) {
  process.stderr.write(behavior.stderr);
}
for (const chunk of behavior.stderrHexChunks || []) {
  process.stderr.write(Buffer.from(chunk, 'hex'));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
}
if (behavior.output) {
  process.stdout.write(behavior.output);
}
for (const chunk of behavior.stdoutHexChunks || []) {
  process.stdout.write(Buffer.from(chunk, 'hex'));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
}
process.exitCode = behavior.exitCode || 0;
`,
);
writeFileSync(
  WORKFLOW_CLI,
  `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
appendFileSync(process.env.FAKE_CLI_CALLS_PATH, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
let value;
let delay = 0;
if (prompt.includes('review it only for correctness')) {
  delay = 60;
  value = { findings: [{
    title: 'Zulu issue',
    severity: 'medium',
    location: 'z.mjs:2',
    explanation: 'Confirmed correctness issue.',
  }] };
} else if (prompt.includes('review it only for security')) {
  delay = 5;
  value = { findings: [{
    title: 'Alpha issue',
    severity: 'high',
    location: 'a.mjs:1',
    explanation: 'Confirmed security issue.',
  }] };
} else if (prompt.includes('review it only for robustness')) {
  value = { findings: [] };
} else if (prompt.includes('critique the completeness')) {
  value = { complete: true, missing: [] };
} else if (prompt.includes('Act as independent skeptic') && prompt.includes('Alpha issue')) {
  process.stderr.write('verifier unavailable');
  process.exitCode = 2;
} else if (prompt.includes('Act as independent skeptic')) {
  value = { isReal: true, confidence: 'high', reasoning: 'The local code confirms it.' };
} else {
  value = { unexpected: true };
}
if (delay) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
}
if (value !== undefined) {
  process.stdout.write('${OPEN}\\n' + JSON.stringify(value) + '\\n${CLOSE}');
}
`,
);
chmodSync(FAKE_CLI, 0o755);
chmodSync(WORKFLOW_CLI, 0o755);

after(() => {
  rmSync(RUNTIME, { recursive: true, force: true });
});

const OBJECT_SCHEMA = {
  type: 'object',
  properties: {
    result: { type: 'string' },
  },
  required: ['result'],
};

/**
 * Wraps a JSON value in the engine's output markers.
 *
 * @param {unknown} value - JSON value.
 * @returns {string} Contracted fake CLI output.
 */
function marked(value) {
  return `${OPEN}\n${JSON.stringify(value)}\n${CLOSE}`;
}

/**
 * Encodes text as hexadecimal UTF-8 bytes for exact pipe chunk tests.
 *
 * @param {string} value - Text to encode.
 * @returns {string} Hexadecimal bytes.
 */
function utf8Hex(value) {
  return Buffer.from(value, 'utf8').toString('hex');
}

/**
 * Runs an operation with deterministic fake CLI behavior.
 *
 * @param {object[]} sequence - Per-attempt behavior sequence.
 * @param {() => Promise<unknown>} operation - Operation to run.
 * @returns {Promise<unknown>} Operation result.
 */
async function withFakeCli(sequence, operation) {
  writeFileSync(COUNTER, '0');
  writeFileSync(CALLS, '');
  const previous = {
    sequence: process.env.FAKE_CLI_SEQUENCE,
    counter: process.env.FAKE_CLI_COUNTER_PATH,
    calls: process.env.FAKE_CLI_CALLS_PATH,
    cleanup: process.env.FAKE_CLEANUP_MARKER,
  };
  process.env.FAKE_CLI_SEQUENCE = JSON.stringify(sequence);
  process.env.FAKE_CLI_COUNTER_PATH = COUNTER;
  process.env.FAKE_CLI_CALLS_PATH = CALLS;
  process.env.FAKE_CLEANUP_MARKER = CLEANUP_MARKER;
  try {
    return await operation();
  } finally {
    restoreEnvironment('FAKE_CLI_SEQUENCE', previous.sequence);
    restoreEnvironment('FAKE_CLI_COUNTER_PATH', previous.counter);
    restoreEnvironment('FAKE_CLI_CALLS_PATH', previous.calls);
    restoreEnvironment('FAKE_CLEANUP_MARKER', previous.cleanup);
  }
}

/**
 * Restores one environment variable.
 *
 * @param {string} name - Environment variable name.
 * @param {string|undefined} value - Previous value.
 * @returns {void}
 */
function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

/**
 * Reads recorded fake CLI calls.
 *
 * @returns {object[]} Recorded calls.
 */
function recordedCalls() {
  return readFileSync(CALLS, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Waits for a deterministic local condition.
 *
 * @param {() => boolean} predicate - Completion condition.
 * @param {number} [timeoutMs=2000] - Maximum wait.
 * @returns {Promise<void>} Completion promise.
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for test condition');
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

test('validates the bounded recursive schema subset', () => {
  const schema = {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['low', 'high'] },
          },
          required: ['severity'],
        },
      },
    },
    required: ['findings'],
  };
  assert.deepEqual(validateSchemaDefinition(schema), { ok: true });
  assert.deepEqual(validateStructuredValue({ findings: [{ severity: 'high' }] }, schema), { ok: true });
  const invalid = validateStructuredValue({ findings: [{ severity: 'medium' }] }, schema);
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /enum values/);
  const unsupported = validateSchemaDefinition({ type: 'object', additionalProperties: false });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.errors.join('\n'), /unsupported keyword/);
});

test('builds restrictive local and research Copilot profiles', () => {
  assert.equal(ENGINE_CAPABILITIES.copilotReadDisallowTempDir, true);
  const local = buildAdapterArguments('prompt', {
    cli: 'copilot',
    bin: FAKE_CLI,
    cwd: ROOT,
    profile: 'local-read',
    inheritInstructions: false,
  });
  assert.deepEqual(local.slice(local.indexOf('--available-tools'), local.indexOf('--available-tools') + 2), [
    '--available-tools',
    'view,rg,glob',
  ]);
  assert.ok(local.includes('--no-ask-user'));
  assert.ok(local.includes('--no-remote-export'));
  assert.ok(local.includes('--no-custom-instructions'));
  assert.ok(local.includes('--disallow-temp-dir'));
  assert.ok(!local.join(' ').includes('web_fetch'));

  assert.throws(
    () => buildAdapterArguments('prompt', {
      cli: 'copilot',
      bin: FAKE_CLI,
      cwd: ROOT,
      profile: 'research-read',
    }),
    /requires allowedUrls/,
  );
  const research = buildAdapterArguments('prompt', {
    cli: 'copilot',
    bin: FAKE_CLI,
    cwd: ROOT,
    profile: 'research-read',
    inheritInstructions: true,
    allowedUrls: ['https://example.com/docs', 'api.example.com'],
  });
  assert.match(research.join(' '), /view,rg,glob,web_fetch/);
  assert.ok(!research.join(' ').includes('web_search'));
  assert.ok(research.includes('--disallow-temp-dir'));
  assert.deepEqual(
    research.filter((argument, index) => research[index - 1] === '--allow-url'),
    ['https://example.com/docs', 'api.example.com'],
  );
  assert.ok(!research.includes('--no-custom-instructions'));
  assert.throws(
    () => buildAdapterArguments('prompt', {
      cli: 'copilot',
      bin: FAKE_CLI,
      cwd: ROOT,
      profile: 'research-read',
      allowedUrls: ['*'],
    }),
    /must not allow all URLs/,
  );
  assert.throws(
    () => buildAdapterArguments('prompt', {
      cli: 'copilot',
      bin: FAKE_CLI,
      cwd: ROOT,
      profile: 'research-read',
      allowedUrls: ['https://user:secret@example.com'],
    }),
    /invalid research URL grant/,
  );

  const previousUrls = process.env.ULTRACODE_ALLOWED_URLS;
  process.env.ULTRACODE_ALLOWED_URLS =
    'https://docs.example.com,api.example.com,https://docs.example.com';
  try {
    const fromEnvironment = buildAdapterArguments('prompt', {
      cli: 'copilot',
      bin: FAKE_CLI,
      cwd: ROOT,
      profile: 'research-read',
    });
    assert.deepEqual(
      fromEnvironment.filter((argument, index) => fromEnvironment[index - 1] === '--allow-url'),
      ['https://docs.example.com', 'api.example.com'],
    );
  } finally {
    restoreEnvironment('ULTRACODE_ALLOWED_URLS', previousUrls);
  }

  const write = buildAdapterArguments('prompt', {
    cli: 'copilot',
    bin: FAKE_CLI,
    cwd: ROOT,
    profile: 'write',
  });
  assert.ok(write.includes('--allow-all-tools'));
  assert.ok(write.includes('--disallow-temp-dir'));
  assert.ok(!write.includes('--available-tools'));

  const writeWithTemp = buildAdapterArguments('prompt', {
    cli: 'copilot',
    bin: FAKE_CLI,
    cwd: ROOT,
    profile: 'write',
    allowTempDir: true,
  });
  assert.ok(!writeWithTemp.includes('--disallow-temp-dir'));

  const claudeLocal = buildAdapterArguments('prompt', {
    cli: 'claude',
    bin: FAKE_CLI,
    cwd: ROOT,
    profile: 'local-read',
  });
  assert.match(claudeLocal.join(' '), /Read,Grep,Glob/);
  assert.ok(!claudeLocal.join(' ').includes('WebFetch'));
  assert.throws(
    () => buildAdapterArguments('prompt', {
      cli: 'claude',
      bin: FAKE_CLI,
      cwd: ROOT,
      profile: 'research-read',
    }),
    /use Claude native Workflow\/runtime permission controls/,
  );
});

test('uses explicit cwd and returns a successful structured envelope', async () => {
  const result = await withFakeCli(
    [{ output: marked({ result: 'ok' }) }],
    () => agent('report cwd', {
      bin: FAKE_CLI,
      cli: 'copilot',
      cwd: RUNTIME,
      profile: 'local-read',
      retries: 0,
      schema: OBJECT_SCHEMA,
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.result, 'ok');
  assert.equal(result.attempts, 1);
  assert.equal(result.meta.cwd, RUNTIME);
  const [call] = recordedCalls();
  assert.equal(call.cwd, RUNTIME);
  assert.equal(call.args[call.args.indexOf('-C') + 1], RUNTIME);
});

test('supports bounded non-object root schemas consistently', async () => {
  const arrayResult = await withFakeCli(
    [{ output: marked([1, 2]) }],
    () => agent('array root', {
      bin: FAKE_CLI,
      cwd: ROOT,
      retries: 0,
      schema: {
        type: 'array',
        minItems: 2,
        items: { type: 'integer' },
      },
    }),
  );
  assert.equal(arrayResult.ok, true);
  assert.deepEqual(arrayResult.value, [1, 2]);

  const nullResult = await withFakeCli(
    [{ output: marked(null) }],
    () => agent('null root', {
      bin: FAKE_CLI,
      cwd: ROOT,
      retries: 0,
      schema: { type: 'null' },
    }),
  );
  assert.equal(nullResult.ok, true);
  assert.equal(nullResult.value, null);
});

test('decodes split multibyte UTF-8 across stdout and stderr chunks', async () => {
  const stdoutPrefix = `${OPEN}\n{"result":"`;
  const stdoutSuffix = `"}\n${CLOSE}`;
  const stdoutResult = await withFakeCli(
    [{
      stdoutHexChunks: [
        `${utf8Hex(stdoutPrefix)}f0`,
        '9f98',
        `80${utf8Hex(stdoutSuffix)}`,
      ],
    }],
    () => agent('split stdout', {
      bin: FAKE_CLI,
      cwd: ROOT,
      retries: 0,
      schema: OBJECT_SCHEMA,
    }),
  );
  assert.equal(stdoutResult.ok, true);
  assert.equal(stdoutResult.value.result, '😀');

  const stderrResult = await withFakeCli(
    [{
      stderrHexChunks: [
        `${utf8Hex('invalid ')}f0`,
        '9f98',
        `80${utf8Hex(' request')}`,
      ],
      exitCode: 2,
    }],
    () => agent('split stderr', {
      bin: FAKE_CLI,
      cwd: ROOT,
      retries: 0,
      schema: OBJECT_SCHEMA,
    }),
  );
  assert.equal(stderrResult.ok, false);
  assert.match(stderrResult.error.message, /invalid 😀 request/);
  assert.match(stderrResult.error.diagnostics[0].stderr, /invalid 😀 request/);
});

test('reports recursive schema and partial parse failures without null success', async () => {
  const schemaFailure = await withFakeCli(
    [{ output: marked({ result: 42 }) }],
    () => agent('bad schema', {
      bin: FAKE_CLI,
      cwd: ROOT,
      retries: 0,
      schema: OBJECT_SCHEMA,
    }),
  );
  assert.equal(schemaFailure.ok, false);
  assert.equal(schemaFailure.error.kind, 'schema');
  assert.equal(schemaFailure.error.incompleteCount, 1);
  assert.equal(schemaFailure.attempts, 1);

  const partial = await withFakeCli(
    [{ output: `${OPEN}\n{"result":"unfinished"}` }],
    () => agent('partial output', {
      bin: FAKE_CLI,
      cwd: ROOT,
      retries: 0,
      schema: OBJECT_SCHEMA,
    }),
  );
  assert.equal(partial.ok, false);
  assert.equal(partial.error.kind, 'parse');
  assert.equal(partial.error.incompleteCount, 1);
  assert.ok(Array.isArray(partial.error.diagnostics));
});

test('retries only eligible failures and requires idempotency for write retries', async () => {
  const readRetry = await withFakeCli(
    [
      { output: `${OPEN}\n{"result":` },
      { output: marked({ result: 'recovered' }) },
    ],
    () => agent('read retry', {
      bin: FAKE_CLI,
      cwd: ROOT,
      retries: 2,
      schema: OBJECT_SCHEMA,
    }),
  );
  assert.equal(readRetry.ok, true);
  assert.equal(readRetry.attempts, 2);
  assert.equal(readRetry.meta.incompleteCount, 1);

  const permanent = await withFakeCli(
    [
      { stderr: 'invalid request', exitCode: 2 },
      { output: marked({ result: 'must not run' }) },
    ],
    () => agent('permanent failure', {
      bin: FAKE_CLI,
      cwd: ROOT,
      retries: 2,
      schema: OBJECT_SCHEMA,
    }),
  );
  assert.equal(permanent.ok, false);
  assert.equal(permanent.error.kind, 'invocation');
  assert.equal(permanent.attempts, 1);

  const writeNoRetry = await withFakeCli(
    [
      { output: `${OPEN}\n{"result":` },
      { output: marked({ result: 'must not run' }) },
    ],
    () => agent('write once', {
      bin: FAKE_CLI,
      cwd: ROOT,
      profile: 'write',
      effect: 'write',
      retries: 2,
      schema: OBJECT_SCHEMA,
    }),
  );
  assert.equal(writeNoRetry.ok, false);
  assert.equal(writeNoRetry.attempts, 1);

  const idempotentWithoutExplicitRetries = await withFakeCli(
    [
      { output: `${OPEN}\n{"result":` },
      { output: marked({ result: 'must not inherit default retries' }) },
    ],
    () => agent('implicit write retry', {
      bin: FAKE_CLI,
      cwd: ROOT,
      profile: 'write',
      effect: 'write',
      idempotent: true,
      schema: OBJECT_SCHEMA,
    }),
  );
  assert.equal(idempotentWithoutExplicitRetries.ok, false);
  assert.equal(idempotentWithoutExplicitRetries.attempts, 1);

  const idempotentWrite = await withFakeCli(
    [
      { output: `${OPEN}\n{"result":` },
      { output: marked({ result: 'retried safely' }) },
    ],
    () => agent('idempotent write', {
      bin: FAKE_CLI,
      cwd: ROOT,
      profile: 'write',
      effect: 'write',
      idempotent: true,
      retries: 1,
      schema: OBJECT_SCHEMA,
    }),
  );
  assert.equal(idempotentWrite.ok, true);
  assert.equal(idempotentWrite.attempts, 2);
});

test('classifies bounded Claude error envelopes before retrying', async () => {
  const transientEnvelope = JSON.stringify({
    is_error: true,
    subtype: 'rate_limit_error',
    result: 'temporarily overloaded',
  });
  const successfulEnvelope = JSON.stringify({
    is_error: false,
    result: marked({ result: 'recovered' }),
  });
  const result = await withFakeCli(
    [
      { output: transientEnvelope, exitCode: 1 },
      { output: successfulEnvelope },
    ],
    () => agent('claude transient', {
      bin: FAKE_CLI,
      cli: 'claude',
      cwd: ROOT,
      retries: 1,
      schema: OBJECT_SCHEMA,
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.meta.diagnostics[0].kind, 'transient');
  assert.match(result.meta.diagnostics[0].stdout, /rate_limit_error/);
});

test('enforces one overall deadline and kills the subprocess tree', async () => {
  const deadline = await withFakeCli(
    [
      { delayMs: 30, output: `${OPEN}\n{"result":` },
      { delayMs: 500, output: marked({ result: 'late' }) },
    ],
    () => agent('deadline', {
      bin: FAKE_CLI,
      cwd: ROOT,
      deadlineMs: 250,
      retries: 2,
      schema: OBJECT_SCHEMA,
    }),
  );
  assert.equal(deadline.ok, false);
  assert.equal(deadline.error.kind, 'deadline');
  assert.equal(deadline.attempts, 2);
  assert.equal(deadline.error.incompleteCount, 1);
  assert.ok(deadline.meta.durationMs < 1000);

  if (existsSync(CLEANUP_MARKER)) {
    rmSync(CLEANUP_MARKER);
  }
  const cleanup = await withFakeCli(
    [{ spawnGrandchild: true, delayMs: 5000, output: marked({ result: 'late' }) }],
    () => agent('cleanup tree', {
      bin: FAKE_CLI,
      cwd: ROOT,
      deadlineMs: 100,
      retries: 0,
      schema: OBJECT_SCHEMA,
    }),
  );
  assert.equal(cleanup.ok, false);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
  assert.equal(existsSync(CLEANUP_MARKER), false);
});

test('signal shutdown prevents retries and force-kills the process tree', async () => {
  if (existsSync(CLEANUP_MARKER)) {
    rmSync(CLEANUP_MARKER);
  }
  const exit = await withFakeCli(
    [{
      spawnGrandchild: true,
      ignoreSignals: true,
      delayMs: 5000,
      output: marked({ result: 'must not complete' }),
    }],
    async () => {
      const source = `
        import { agent } from ${JSON.stringify(ENGINE)};
        const result = await agent('wait for shutdown', {
          bin: ${JSON.stringify(FAKE_CLI)},
          cwd: ${JSON.stringify(ROOT)},
          retries: 3,
          schema: ${JSON.stringify(OBJECT_SCHEMA)},
        });
        process.stdout.write(JSON.stringify(result));
      `;
      const runner = spawn(process.execPath, ['--input-type=module', '-e', source], {
        cwd: ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await waitFor(() => readFileSync(CALLS, 'utf8').trim().length > 0);
      runner.kill('SIGTERM');
      return new Promise((resolveExit) => {
        runner.once('close', (code, signal) => resolveExit({ code, signal }));
      });
    },
  );
  assert.deepEqual(exit, { code: 143, signal: null });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  assert.equal(existsSync(CLEANUP_MARKER), false);
  assert.equal(recordedCalls().length, 1);
});

test('rejects unknown adapters before launching a process', async () => {
  const result = await agent('never launch', {
    bin: FAKE_CLI,
    cli: 'unknown-runtime',
    cwd: ROOT,
    schema: OBJECT_SCHEMA,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'adapter');
  assert.equal(result.attempts, 0);
});

test('keeps map and pipeline ordering deterministic and stage failures visible', async () => {
  const mapped = await map([30, 5, 15], async (delay) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    return delay;
  });
  assert.deepEqual(mapped, [30, 5, 15]);

  const piped = await pipeline(
    [1, 2],
    (value) => value + 1,
    (value, original) => {
      if (original === 2) {
        throw new Error('required stage failed');
      }
      return value * 2;
    },
  );
  assert.deepEqual(piped[0].value, 4);
  assert.equal(piped[1].ok, false);
  assert.equal(piped[1].meta.failedStage, 1);

  const sorted = deterministicSort(
    [{ dimension: 'security', title: 'A' }, { dimension: 'correctness', title: 'Z' }],
    ['dimension', 'title'],
  );
  assert.deepEqual(sorted.map((entry) => entry.dimension), ['correctness', 'security']);
});

test('runs the shipped template with deterministic ordering and failure metadata', () => {
  writeFileSync(CALLS, '');
  const result = spawnSync(process.execPath, [TEMPLATE, 'skills/ultracode/orchestrate.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_CLI_CALLS_PATH: CALLS,
      ULTRACODE_CLI: 'copilot',
      ULTRACODE_CLI_BIN: WORKFLOW_CLI,
      ULTRACODE_CWD: ROOT,
      ULTRACODE_ENGINE: ENGINE,
      ULTRACODE_CRITIC_ROUNDS: '1',
      ULTRACODE_VERIFIER_VOTES: '1',
      ULTRACODE_THOROUGH: 'true',
    },
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.target, ENGINE);
  assert.equal(envelope.value.profile, 'local-read');
  assert.equal(envelope.value.incomplete, true);
  assert.deepEqual(
    envelope.value.confirmed.map((finding) => finding.dimension),
    ['correctness'],
  );
  assert.deepEqual(envelope.value.refuted, []);
  assert.deepEqual(
    envelope.value.inconclusive.map((finding) => finding.dimension),
    ['security'],
  );
  assert.equal(envelope.value.failures.reviews.length, 0);
  assert.equal(envelope.value.failures.critics.length, 0);
  assert.equal(envelope.value.failures.verifications.length, 1);
  for (const call of recordedCalls()) {
    assert.equal(call.cwd, ROOT);
    assert.match(call.args.join(' '), /--available-tools view,rg,glob/);
  }
});

test('run prints structured success and failure envelopes', () => {
  const success = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import {run} from ${JSON.stringify(ENGINE)}; await run(() => 7);`],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(success.status, 0);
  assert.deepEqual(JSON.parse(success.stdout), { ok: true, value: 7, attempts: 0 });

  const failure = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {run} from ${JSON.stringify(ENGINE)}; await run(() => { throw new Error('boom'); });`,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(failure.status, 1);
  const envelope = JSON.parse(failure.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.kind, 'workflow');
});
