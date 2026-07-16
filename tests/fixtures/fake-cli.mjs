#!/usr/bin/env node

/**
 * Deterministic fake CLI used by orchestration tests.
 *
 * Configuration is supplied entirely through FAKE_CLI_* environment variables
 * so tests never contact a model provider or external service.
 */

import { appendFileSync } from 'node:fs';

const delay = Number.parseInt(process.env.FAKE_CLI_DELAY_MS || '0', 10);
const exitCode = Number.parseInt(process.env.FAKE_CLI_EXIT_CODE || '0', 10);
const output = process.env.FAKE_CLI_OUTPUT || '<<<ULTRACODE_JSON>>>\n{"result":"ok"}\n<<<ULTRACODE_END>>>';
const stderr = process.env.FAKE_CLI_STDERR || '';
const callsPath = process.env.FAKE_CLI_CALLS_PATH || '';

if (callsPath) {
  appendFileSync(callsPath, `${JSON.stringify(process.argv.slice(2))}\n`);
}
if (delay > 0) {
  await new Promise((resolve) => setTimeout(resolve, delay));
}
if (stderr) {
  process.stderr.write(stderr);
}
process.stdout.write(output);
process.exitCode = exitCode;
