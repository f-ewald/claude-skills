/**
 * Tests the cross-harness Session Lessons normalizer and safety helpers.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  fsyncSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildCopilotDiscoveryQuery,
  claudeTranscriptPath,
  copilotTranscriptPath,
  discoverClaudeSessions,
  discoverCopilotSessions,
  encodeClaudeCwd,
  inferSource,
  loadNormalizedSession,
  normalizeClaudeRecords,
  normalizeCopilotRecords,
  parseJsonLines,
  redactText,
  resolveTranscript,
  sanitizeTopLevelError,
} from '../skills/session-lessons/scripts/normalize-session.mjs';
import {
  compareRuleToExisting,
  confidenceForSignals,
  createWritePlan,
  detectManagedMarker,
  inspectDirtyState,
  preflightTarget,
  previewExactDiff,
  reconcileInstructionPair,
  resolveTargetPath,
  routeInstructionTargets,
  targetLockPath,
  writeVerifiedTarget,
} from '../skills/session-lessons/scripts/lesson-helpers.mjs';

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(TEST_DIRECTORY, '..');
const FIXTURE_DIRECTORY = join(REPOSITORY_ROOT, 'skills', 'session-lessons', 'fixtures');
let scratchSequence = 0;

/**
 * Reads and parses a checked-in JSONL fixture.
 *
 * @param {string} name - Fixture file name.
 * @returns {object[]} Parsed records.
 */
function fixtureRecords(name) {
  return parseJsonLines(readFileSync(join(FIXTURE_DIRECTORY, name), 'utf8')).records;
}

/**
 * Creates an exact project-local scratch directory and removes its known files after the test.
 *
 * @param {import('node:test').TestContext} context - Node test context.
 * @param {string} label - Directory label.
 * @returns {string} Scratch directory.
 */
function localScratchDirectory(context, label) {
  scratchSequence += 1;
  const directory = join(TEST_DIRECTORY, `.session-lessons-${label}-${process.pid}-${scratchSequence}`);
  mkdirSync(directory);
  context.after(() => {
    for (const name of readdirSync(directory)) {
      unlinkSync(join(directory, name));
    }
    rmdirSync(directory);
  });
  return directory;
}

test('normalizes observable Claude records and excludes thinking blocks', () => {
  const events = normalizeClaudeRecords(fixtureRecords('claude-session.jsonl'));
  assert.deepEqual(events.map((event) => event.actor), ['system', 'user', 'assistant', 'tool', 'tool']);
  assert.equal(events.some((event) => event.text.includes('PRIVATE_REASONING_MUST_NOT_APPEAR')), false);
  assert.equal(events.some((event) => event.text.includes('super-secret-value')), false);
  assert.equal(events.some((event) => event.text.includes('alice@example.com')), false);
  const toolCall = events.find((event) => event.kind === 'tool_call');
  const toolResult = events.find((event) => event.kind === 'tool_result');
  assert.match(toolCall.toolCallId, /^tool-[0-9a-f]{12}$/);
  assert.equal(events.some((event) => JSON.stringify(event).includes('tool-use-private-42')), false);
  assert.equal(toolResult.toolCallId, toolCall.toolCallId);
  assert.equal(toolResult.toolName, 'Read');
  assert.equal(toolResult.arguments, toolCall.arguments);
  assert.equal(toolResult.arguments.includes('fixture-client-value'), false);
});

test('normalizes Copilot records without ever exposing reasoningText', () => {
  const records = fixtureRecords('copilot-session.jsonl');
  const events = normalizeCopilotRecords(records);
  assert.equal(inferSource(records), 'copilot');
  assert.equal(events.some((event) => event.text.includes('PRIVATE_COPILOT_REASONING')), false);
  assert.equal(events.some((event) => event.text.includes('abcdef123456')), false);
  assert.equal(events.some((event) => event.kind === 'abort'), true);
  const toolCall = events.find((event) => event.kind === 'tool_call');
  const toolResult = events.find((event) => event.kind === 'tool_result');
  assert.match(toolCall.toolCallId, /^tool-[0-9a-f]{12}$/);
  assert.equal(events.some((event) => JSON.stringify(event).includes('call-17')), false);
  assert.equal(toolResult.toolCallId, toolCall.toolCallId);
  assert.equal(toolResult.toolName, 'view');
  assert.equal(toolResult.arguments, toolCall.arguments);
  assert.equal(toolResult.arguments.includes('fixture-value'), false);
  assert.equal(toolResult.arguments.includes('C:\\Users\\bob'), false);
  assert.equal(toolResult.success, false);
});

test('tolerates only a partial final JSONL line', () => {
  const parsed = parseJsonLines('{"type":"user"}\n{"type":"assistant"');
  assert.deepEqual(parsed.records, [{ type: 'user' }]);
  assert.equal(parsed.ignoredPartialLine, true);
  assert.throws(
    () => parseJsonLines('{"type":"user"}\nnot-json\n{"type":"assistant"}\n'),
    /Invalid JSONL at line 2/,
  );
  assert.throws(
    () => parseJsonLines('{"type":"user"}\nnot-json'),
    /Invalid JSONL at line 2/,
  );
  assert.throws(
    () => parseJsonLines('{"type":"user"}\n{"type": nope'),
    /Invalid JSONL at line 2/,
  );
  assert.throws(
    () => parseJsonLines('{"type":"user"}\n{"type":"assistant",}'),
    /Invalid JSONL at line 2/,
  );
  assert.throws(
    () => parseJsonLines('{"type":"user"}\n{"type":"assistant"]'),
    /Invalid JSONL at line 2/,
  );
  assert.throws(
    () => parseJsonLines('{"type":"user"}\n{"type":"assistant"},'),
    /Invalid JSONL at line 2/,
  );
  assert.equal(
    parseJsonLines('{"type":"user"}\n{"type":"assistant",').ignoredPartialLine,
    true,
  );
  assert.equal(
    parseJsonLines('{"type":"user"}\n{"complete":tru').ignoredPartialLine,
    true,
  );
});

test('reports sanitized JSONL parse errors without transcript content', () => {
  const malformed = [
    '{"type":"user","token":"fixture-secret-value",',
    '"path":"/Users/alice/.claude/projects/-Users-alice-work-project/session.jsonl",nope}',
  ].join('');
  assert.throws(
    () => parseJsonLines(malformed, { source: 'claude' }),
    (error) => {
      assert.match(error.message, /Invalid JSONL at line 1 \(source: claude\)/);
      assert.match(error.message, /malformed complete record/);
      assert.equal(error.message.includes('fixture-secret-value'), false);
      assert.equal(error.message.includes('alice'), false);
      assert.equal(error.message.includes('nope'), false);
      return true;
    },
  );
});

test('classifies incomplete JSON token prefixes without accepting malformed tokens', () => {
  const incompletePrefixes = [
    '-',
    '1.',
    '1e',
    '1e+',
    '-0.',
    '2E-',
    'fals',
    'nul',
    '"' + '\\',
    String.raw`"\u12`,
    '{"number":-',
    '{"number":1e',
    '{"number":-2.3E+',
    String.raw`{"text":"\u`,
    String.raw`{"text":"\u12`,
    '[1e',
  ];
  for (const prefix of incompletePrefixes) {
    assert.equal(parseJsonLines(prefix).ignoredPartialLine, true, prefix);
  }

  const malformedRecords = [
    '1e+}',
    '1e--2',
    '-x',
    String.raw`"\u12G"`,
    String.raw`"\u12xz"`,
    '{"number":01',
    '{"number":1.}',
    '{"number":1e+}',
    '[1,]',
    '{"value":true,}',
    `{${String.fromCharCode(0x0b)}`,
  ];
  for (const record of malformedRecords) {
    assert.throws(() => parseJsonLines(record), /Invalid JSONL at line 1/, record);
  }
});

test('redacts credentials and private identifiers', () => {
  const password = `pass${'word'}=${'fixture-value'}`;
  const bearer = `Bear${'er'} ${'fixture.token.value'}`;
  const redacted = redactText([
    password,
    bearer,
    'person@example.com',
    '123e4567-e89b-12d3-a456-426614174000',
    '/Users/person/private',
  ].join(' '));
  assert.equal(redacted.includes('fixture-value'), false);
  assert.equal(redacted.includes('fixture.token.value'), false);
  assert.equal(redacted.includes('person@example.com'), false);
  assert.equal(redacted.includes('123e4567'), false);
  assert.match(redacted, /~\/private/);

  const sensitiveKey = `pass${'word'}`;
  const windowsPath = String.raw`C:\Users\person\private`;
  assert.equal(redactText(`Open ${windowsPath}`).includes('person'), false);
  const structured = redactText({
    [sensitiveKey]: 'fixture-structured-value',
    path: windowsPath,
  });
  assert.equal(structured.includes('fixture-structured-value'), false);
  assert.equal(structured.includes(String.raw`C:\\Users\\person`), false);
  assert.match(structured, /REDACTED_CREDENTIAL/);

  const quotedJson = JSON.stringify({
    api_key: 'fixture-json-value',
    path: windowsPath,
  });
  const redactedJson = redactText(quotedJson);
  assert.equal(redactedJson.includes('fixture-json-value'), false);
  assert.equal(redactedJson.includes(String.raw`C:\\Users\\person`), false);

  const clientSecret = `client_${'secret'}="fixture value with spaces"`;
  const basicAuthorization = `Authoriz${'ation'}: Basic fixture-basic-value`;
  const plaintext = redactText(
    `${clientSecret} ${basicAuthorization}; basic design principles remain ordinary text.`,
  );
  assert.equal(plaintext.includes('fixture value with spaces'), false);
  assert.equal(plaintext.includes('fixture-basic-value'), false);
  assert.match(plaintext, /Authorization: Basic \[REDACTED_CREDENTIAL]/i);
  assert.match(plaintext, /basic design principles remain ordinary text/);
  assert.equal(redactText('mytoken=public-label Bearer of news'), 'mytoken=public-label Bearer of news');

  const embeddedJson = `payload={"${sensitiveKey}":"fixture-embedded-value"}`;
  assert.equal(redactText(embeddedJson).includes('fixture-embedded-value'), false);

  const suffixKeys = {
    OPENAI_API_KEY: 'fixture-openai-value',
    AWS_SECRET_ACCESS_KEY: 'fixture-aws-value',
    AWS_ACCESS_KEY_ID: 'fixture-access-id-value',
    DATABASE_PASSWORD: 'fixture-database-value',
    MONKEY_BREAD: 'banana',
  };
  const redactedSuffixKeys = redactText(suffixKeys);
  assert.equal(redactedSuffixKeys.includes('fixture-openai-value'), false);
  assert.equal(redactedSuffixKeys.includes('fixture-aws-value'), false);
  assert.equal(redactedSuffixKeys.includes('fixture-access-id-value'), false);
  assert.equal(redactedSuffixKeys.includes('fixture-database-value'), false);
  assert.match(redactedSuffixKeys, /MONKEY_BREAD":"banana/);

  const suffixAssignments = Object.entries(suffixKeys)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  const redactedAssignments = redactText(suffixAssignments);
  assert.equal(redactedAssignments.includes('fixture-openai-value'), false);
  assert.equal(redactedAssignments.includes('fixture-aws-value'), false);
  assert.equal(redactedAssignments.includes('fixture-access-id-value'), false);
  assert.equal(redactedAssignments.includes('fixture-database-value'), false);
  assert.match(redactedAssignments, /MONKEY_BREAD=banana/);

  const privateKey = [
    `-----BEGIN ${'PRIVATE KEY'}-----`,
    'fixture-private-key-material',
    `-----END ${'PRIVATE KEY'}-----`,
  ].join('\n');
  const redactedPrivateKey = redactText(privateKey);
  assert.equal(redactedPrivateKey.includes('fixture-private-key-material'), false);
  assert.match(redactedPrivateKey, /REDACTED_PRIVATE_KEY/);

  const standaloneTokens = [
    `sk-${'a'.repeat(24)}`,
    `sk-proj-${'b'.repeat(24)}`,
    `ghp_${'c'.repeat(24)}`,
    `github_pat_${'d'.repeat(24)}`,
    `AKIA${'E'.repeat(16)}`,
    `glpat-${'f'.repeat(24)}`,
  ];
  const redactedTokens = redactText(standaloneTokens.join(' '));
  for (const token of standaloneTokens) {
    assert.equal(redactedTokens.includes(token), false);
  }
  const benignPrefixes = 'sk-short ghp_example AKIAEXAMPLE ordinary prose';
  assert.equal(redactText(benignPrefixes), benignPrefixes);

  const jwtHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const jwtPayload = Buffer.from(JSON.stringify({ sub: 'fixture-user', exp: 9999999999 }))
    .toString('base64url');
  const compactJwt = `${jwtHeader}.${jwtPayload}.${'g'.repeat(43)}`;
  assert.equal(redactText(`token ${compactJwt}`).includes(compactJwt), false);
  const ordinaryDottedText = `${'z'.repeat(20)}.${'y'.repeat(24)}.${'x'.repeat(32)}`;
  assert.equal(redactText(ordinaryDottedText), ordinaryDottedText);
});

test('builds Copilot SQLite discovery without shell interpolation', () => {
  const query = buildCopilotDiscoveryQuery("/work/it's-safe/subdir", 500, "/work/it's-safe");
  assert.match(query, /it''s-safe/);
  assert.match(query, /cwd IN/);
  assert.match(query, /git_root IN/);
  assert.match(query, /subdir/);
  assert.match(query, /LIMIT 100/);
  assert.equal(query.includes('; DROP'), false);
});

test('builds harness-specific transcript paths', () => {
  assert.equal(encodeClaudeCwd('/Users/example/work'), '-Users-example-work');
  assert.equal(
    claudeTranscriptPath({
      homeDirectory: '/home/example',
      cwd: '/repo',
      sessionId: 'claude-id',
    }),
    '/home/example/.claude/projects/-repo/claude-id.jsonl',
  );
  assert.equal(
    copilotTranscriptPath({ homeDirectory: '/home/example', sessionId: 'copilot-id' }),
    '/home/example/.copilot/session-state/copilot-id/events.jsonl',
  );
});

test('redacts transcript metadata returned for display', () => {
  const result = loadNormalizedSession({
    source: 'claude',
    inputPath: join(FIXTURE_DIRECTORY, 'claude-session.jsonl'),
  });
  assert.equal(result.path.includes('/Users/'), false);
  assert.equal(result.events.some((event) => event.text.includes('/Users/')), false);
});

test('sanitizes encoded Claude project identities and filesystem errors', () => {
  const encodedPath = '~/.claude/projects/-Users-alice-work-project/session.jsonl';
  const redactedPath = redactText(encodedPath);
  assert.equal(redactedPath.includes('alice'), false);
  assert.match(redactedPath, /REDACTED_CLAUDE_PROJECT/);

  const homeDirectory = join(FIXTURE_DIRECTORY, 'claude-home');
  const result = loadNormalizedSession({
    source: 'claude',
    sessionId: 'encoded-home-session',
    homeDirectory,
    cwd: '/repo/demo/current-subdirectory',
    repositoryRoot: '/repo/demo',
  });
  assert.equal(result.path.includes('alice'), false);
  assert.match(result.path, /REDACTED_CLAUDE_PROJECT/);

  let missingInputError;
  try {
    resolveTranscript({
      source: 'claude',
      inputPath: '/Users/alice/.claude/projects/-Users-alice-work-project/missing.jsonl',
    });
  } catch (error) {
    missingInputError = error;
  }
  const sanitizedMissingInput = sanitizeTopLevelError(missingInputError);
  assert.equal(sanitizedMissingInput, 'The selected local input was not found.');
  assert.equal(sanitizedMissingInput.includes('alice'), false);

  const normalizerPath = join(
    REPOSITORY_ROOT,
    'skills',
    'session-lessons',
    'scripts',
    'normalize-session.mjs',
  );
  const processResult = spawnSync(process.execPath, [
    normalizerPath,
    '--source',
    'claude',
    '--input',
    '/Users/alice/.claude/projects/-Users-alice-work-project/missing.jsonl',
  ], { encoding: 'utf8' });
  assert.equal(processResult.status, 1);
  assert.match(processResult.stderr, /selected local input was not found/i);
  assert.equal(processResult.stderr.includes('alice'), false);
  assert.equal(processResult.stderr.includes('-Users-'), false);

  const sanitizedUnknownError = sanitizeTopLevelError(new Error(
    'failed at /Users/alice/.claude/projects/-Users-alice-work-project token=fixture-secret',
  ));
  assert.equal(sanitizedUnknownError.includes('alice'), false);
  assert.equal(sanitizedUnknownError.includes('fixture-secret'), false);
});

test('discovers Copilot sessions from local workspace metadata without SQLite', () => {
  const sessions = discoverCopilotSessions({
    homeDirectory: join(FIXTURE_DIRECTORY, 'copilot-home'),
    cwd: '/repo/demo/other-subdirectory',
    repositoryRoot: '/repo/demo',
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].source, 'copilot');
  assert.equal(sessions[0].sessionId, 'copilot-fixture');
  assert.match(sessions[0].path, /events\.jsonl$/);
});

test('discovers and resolves Claude sessions across repository subdirectories', () => {
  const homeDirectory = join(FIXTURE_DIRECTORY, 'claude-home');
  const sessions = discoverClaudeSessions({
    homeDirectory,
    cwd: '/repo/demo/current-subdirectory',
    repositoryRoot: '/repo/demo',
  });
  assert.equal(sessions.some((session) => session.sessionId === 'session-subdir'), true);
  assert.equal(sessions.some((session) => session.path.includes('-other-repository')), false);

  const resolved = resolveTranscript({
    source: 'claude',
    sessionId: 'session-subdir',
    homeDirectory,
    cwd: '/repo/demo/current-subdirectory',
    repositoryRoot: '/repo/demo',
  });
  assert.match(resolved.path, /-repo-demo-session-subdirectory/);
  assert.equal(resolved.path.includes('-other-repository'), false);
  assert.throws(
    () => resolveTranscript({
      source: 'claude',
      sessionId: 'ambiguous-session',
      homeDirectory,
      cwd: '/repo/demo/current-subdirectory',
      repositoryRoot: '/repo/demo',
    }),
    /Ambiguous local Claude session/,
  );
});

test('applies existing-rule precedence and contradiction detection', () => {
  const existing = ['Never commit changes without explicit user approval.'];
  assert.equal(
    compareRuleToExisting('Do not commit changes without explicit approval.', existing).status,
    'covered-by-existing',
  );
  assert.equal(
    compareRuleToExisting('Always commit changes without explicit user approval.', existing).status,
    'contradiction',
  );
  assert.ok(confidenceForSignals(['abort']) < confidenceForSignals(['user-correction']));
});

test('routes shared global rules and reconciles the repository instruction pair', () => {
  const targets = routeInstructionTargets({
    scope: 'global',
    harness: 'shared',
    homeDirectory: '/home/example',
    repositoryRoot: '/repo',
  });
  assert.deepEqual(targets, [
    '/home/example/.claude/CLAUDE.md',
    '/home/example/.copilot/copilot-instructions.md',
  ]);

  const globalTarget = '/home/example/.copilot/copilot-instructions.md';
  const repositoryClaude = join(REPOSITORY_ROOT, 'CLAUDE.md');
  const repositoryCopilot = join(REPOSITORY_ROOT, 'COPILOT.md');
  const reconciled = reconcileInstructionPair(
    [globalTarget],
    REPOSITORY_ROOT,
    {
      scope: 'global',
      resolver: (path) => path === globalTarget ? repositoryCopilot : path,
    },
  );
  assert.deepEqual(reconciled, [repositoryCopilot, repositoryClaude]);

  assert.deepEqual(
    reconcileInstructionPair([repositoryClaude], REPOSITORY_ROOT),
    [repositoryClaude],
  );
  assert.deepEqual(
    reconcileInstructionPair(
      ['/repo/project/CLAUDE.md'],
      '/repo/project',
      { scope: 'global', resolver: (path) => path },
    ),
    ['/repo/project/CLAUDE.md'],
  );
});

test('detects managed markers and reports repository dirty state', () => {
  assert.match(detectManagedMarker('Company-managed file. Do not edit.'), /company-managed/i);
  const calls = [];
  const dirty = inspectDirtyState('/repo/CLAUDE.md', '/repo', (binary, args) => {
    calls.push({ binary, args });
    return ' M CLAUDE.md\n';
  });
  assert.equal(dirty, 'M CLAUDE.md');
  assert.deepEqual(calls[0], {
    binary: 'git',
    args: ['-C', '/repo', 'status', '--porcelain=v1', '--', 'CLAUDE.md'],
  });
  assert.throws(
    () => inspectDirtyState('/repo/CLAUDE.md', '/repo', () => {
      throw new Error('git unavailable');
    }),
    /Unable to inspect repository dirty state: git unavailable/,
  );
});

test('preflights checked-in targets and previews exact full diffs', () => {
  const target = join(FIXTURE_DIRECTORY, 'claude-session.jsonl');
  const preflight = preflightTarget(target);
  assert.equal(preflight.exists, true);
  assert.equal(preflight.managedMarker, null);
  assert.equal(preflight.digest.length, 64);

  const diff = previewExactDiff('instructions.md', 'old\n', 'new\n');
  assert.equal(diff, [
    '--- instructions.md',
    '+++ instructions.md',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
  ].join('\n'));
  const plan = createWritePlan({
    requestedPath: 'instructions.md',
    resolvedPath: 'instructions.md',
    digest: 'current-digest',
    content: 'old\n',
  }, 'new\n');
  assert.equal(plan.diff, diff);
  assert.equal(plan.proposedDigest.length, 64);
  assert.equal(Object.isFrozen(plan), true);
  assert.throws(
    () => preflightTarget(target, {
      repositoryRoot: REPOSITORY_ROOT,
      execFile: () => {
        throw new Error('status unavailable');
      },
    }),
    /Unable to inspect repository dirty state: status unavailable/,
  );
});

test('rejects dangling instruction symlinks before preflight', () => {
  const danglingLink = join(FIXTURE_DIRECTORY, 'dangling-instructions.md');
  assert.throws(
    () => resolveTargetPath(danglingLink),
    /Refusing dangling instruction symlink/,
  );
  assert.throws(
    () => preflightTarget(danglingLink),
    /Refusing dangling instruction symlink/,
  );
  assert.throws(
    () => {
      const preflight = {
        requestedPath: danglingLink,
        resolvedPath: danglingLink,
        managedMarker: null,
        dirtyState: '',
        digest: 'unused',
        content: '',
      };
      const plan = createWritePlan(preflight, 'content');
      return writeVerifiedTarget(preflight, 'content', {
        approved: true,
        approvedDigest: plan.proposedDigest,
      });
    },
    /Refusing dangling instruction symlink/,
  );
});

test('atomically replaces instructions and preserves target mode', (context) => {
  const directory = localScratchDirectory(context, 'atomic-success');
  const target = join(directory, 'instructions.md');
  writeFileSync(target, 'before\n');
  chmodSync(target, 0o640);
  const preflight = preflightTarget(target);
  const plan = createWritePlan(preflight, 'after\n');
  let fsyncCalls = 0;

  writeVerifiedTarget(preflight, 'after\n', {
    approved: true,
    approvedDigest: plan.proposedDigest,
    fileSystem: {
      fsyncSync: (descriptor) => {
        fsyncCalls += 1;
        fsyncSync(descriptor);
      },
    },
  });

  assert.equal(readFileSync(target, 'utf8'), 'after\n');
  assert.equal(statSync(target).mode & 0o777, 0o640);
  assert.equal(fsyncCalls, 1);
  assert.deepEqual(readdirSync(directory), ['instructions.md']);
});

test('cleans the exact atomic temp file when rename fails', (context) => {
  const directory = localScratchDirectory(context, 'atomic-failure');
  const target = join(directory, 'instructions.md');
  writeFileSync(target, 'before\n');
  const preflight = preflightTarget(target);
  const plan = createWritePlan(preflight, 'after\n');
  let observedTemporaryPath;

  assert.throws(
    () => writeVerifiedTarget(preflight, 'after\n', {
      approved: true,
      approvedDigest: plan.proposedDigest,
      fileSystem: {
        renameSync: (temporaryPath, destinationPath) => {
          observedTemporaryPath = temporaryPath;
          assert.equal(destinationPath, target);
          assert.equal(readFileSync(temporaryPath, 'utf8'), 'after\n');
          assert.equal(readFileSync(destinationPath, 'utf8'), 'before\n');
          throw new Error('simulated rename failure');
        },
      },
    }),
    /simulated rename failure/,
  );

  assert.equal(readFileSync(target, 'utf8'), 'before\n');
  assert.deepEqual(readdirSync(directory), ['instructions.md']);
  assert.equal(observedTemporaryPath.startsWith(`${directory}/.`), true);
});

test('aborts atomic replacement when the target changes during the write', (context) => {
  const directory = localScratchDirectory(context, 'atomic-concurrent');
  const target = join(directory, 'instructions.md');
  writeFileSync(target, 'before\n');
  const preflight = preflightTarget(target);
  const plan = createWritePlan(preflight, 'after\n');

  assert.throws(
    () => writeVerifiedTarget(preflight, 'after\n', {
      approved: true,
      approvedDigest: plan.proposedDigest,
      fileSystem: {
        fsyncSync: (descriptor) => {
          fsyncSync(descriptor);
          writeFileSync(target, 'concurrent\n');
        },
      },
    }),
    /Instruction file changed during atomic write/,
  );

  assert.equal(readFileSync(target, 'utf8'), 'concurrent\n');
  assert.deepEqual(readdirSync(directory), ['instructions.md']);
});

test('fails closed without deleting an existing unknown advisory lock', (context) => {
  const directory = localScratchDirectory(context, 'existing-lock');
  const target = join(directory, 'instructions.md');
  writeFileSync(target, 'before\n');
  const preflight = preflightTarget(target);
  const plan = createWritePlan(preflight, 'after\n');
  const lockPath = targetLockPath(target);
  writeFileSync(lockPath, 'owned by another writer\n', { flag: 'wx' });

  assert.throws(
    () => writeVerifiedTarget(preflight, 'after\n', {
      approved: true,
      approvedDigest: plan.proposedDigest,
    }),
    /Instruction target is locked; refusing to remove unknown lock/,
  );

  assert.equal(readFileSync(target, 'utf8'), 'before\n');
  assert.equal(readFileSync(lockPath, 'utf8'), 'owned by another writer\n');
});

test('requires approval of the exact proposed replacement digest before locking', (context) => {
  const directory = localScratchDirectory(context, 'approved-digest');
  const target = join(directory, 'instructions.md');
  writeFileSync(target, 'before\n');
  const preflight = preflightTarget(target);
  const plan = createWritePlan(preflight, 'after\n');

  assert.throws(
    () => writeVerifiedTarget(preflight, 'after\n', { approved: true }),
    /without an approved proposed-content digest/,
  );
  assert.throws(
    () => writeVerifiedTarget(preflight, 'tampered\n', {
      approved: true,
      approvedDigest: plan.proposedDigest,
    }),
    /does not match supplied content/,
  );

  assert.equal(readFileSync(target, 'utf8'), 'before\n');
  assert.deepEqual(readdirSync(directory), ['instructions.md']);
});
