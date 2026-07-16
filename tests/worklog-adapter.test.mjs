/**
 * Tests the shell-free worklog adapter.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = dirname(TEST_DIRECTORY);
const ADAPTER_PATH = join(REPOSITORY_ROOT, 'skills', 'worklog', 'scripts', 'run-wl.mjs');
let fixtureSequence = 0;

/**
 * Creates a fake wl executable in a project-local fixture directory.
 *
 * @param {import('node:test').TestContext} context - Node test context.
 * @returns {{ directory: string, recordPath: string }} Fixture paths.
 */
function createFakeWorklog(context) {
  fixtureSequence += 1;
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), `claude-skills-worklog-${process.pid}-${fixtureSequence}-`),
  );
  const binaryPath = join(directory, 'wl');
  const recordPath = join(directory, 'argv.json');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    binaryPath,
    `#!${process.execPath}
import { spawn, spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';

if (process.env.FAKE_WL_GRANDCHILD === '1') {
  writeFileSync(process.env.FAKE_WL_GRANDCHILD_READY, String(process.pid));
  const stopGrandchild = (signal) => {
    writeFileSync(process.env.FAKE_WL_GRANDCHILD_SIGNAL, signal);
    if (process.env.FAKE_WL_GRANDCHILD_IGNORE_FIRST === '1') {
      return;
    }
    process.exit(0);
  };
  process.on('SIGINT', () => stopGrandchild('SIGINT'));
  process.on('SIGTERM', () => stopGrandchild('SIGTERM'));
  setInterval(() => {}, 1_000);
} else {
  if (process.env.FAKE_WL_RECORD) {
    writeFileSync(process.env.FAKE_WL_RECORD, JSON.stringify(process.argv.slice(2)));
  }
  if (process.argv[2] === 'server' && process.env.FAKE_WL_SERVER_PORT) {
    const port = Number(process.env.FAKE_WL_SERVER_PORT);
    const server = createServer((socket) => {
      if (process.env.FAKE_WL_SERVER_CANCEL_ON_CONNECTION === '1') {
        process.kill(process.ppid, 'SIGTERM');
      }
      if (process.env.FAKE_WL_SERVER_EXIT_ON_CONNECTION === '1') {
        socket.end();
        server.close(() => process.exit(0));
      }
    });
    server.listen(port, '127.0.0.1', () => {
      if (process.env.FAKE_WL_SERVER_LOG_PATH) {
        renameSync(process.env.FAKE_WL_SERVER_LOG_PATH, \`\${process.env.FAKE_WL_SERVER_LOG_PATH}.moved\`);
        writeFileSync(
          process.env.FAKE_WL_SERVER_LOG_PATH,
          'Listening on http://127.0.0.1:1\\n',
        );
      }
      process.stderr.write(\`Listening on http://127.0.0.1:\${port}\\n\`);
    });
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  } else if (process.env.FAKE_WL_WAIT_FOR_SIGNAL === '1') {
    spawn(process.execPath, [process.argv[1]], {
      env: { ...process.env, FAKE_WL_GRANDCHILD: '1' },
      stdio: process.env.FAKE_WL_GRANDCHILD_IGNORE_FIRST === '1'
        ? ['ignore', 'inherit', 'inherit']
        : 'ignore',
    });
    writeFileSync(process.env.FAKE_WL_PARENT_READY, String(process.pid));
    const stopParent = (signal) => {
      writeFileSync(process.env.FAKE_WL_PARENT_SIGNAL, signal);
      process.exit(0);
    };
    process.on('SIGINT', () => stopParent('SIGINT'));
    process.on('SIGTERM', () => stopParent('SIGTERM'));
    setInterval(() => {}, 1_000);
  } else {
    let ownedStagePath;
    if (process.argv[2] === 'storage' && process.argv[3] === 'export') {
      const pathArgument = process.argv.find((argument) => argument.startsWith('--path='));
      const exportPath = pathArgument.slice('--path='.length);
      ownedStagePath = exportPath;
      mkdirSync(exportPath, { recursive: true });
      if (process.env.FAKE_WL_EXPORT_SYMLINK_TARGET) {
        symlinkSync(process.env.FAKE_WL_EXPORT_SYMLINK_TARGET, \`\${exportPath}/people.yaml\`);
      } else if (process.env.FAKE_WL_EXPORT_HARDLINK_TARGET) {
        linkSync(process.env.FAKE_WL_EXPORT_HARDLINK_TARGET, \`\${exportPath}/people.yaml\`);
      } else {
        writeFileSync(\`\${exportPath}/people.yaml\`, 'exported people');
        writeFileSync(\`\${exportPath}/projects.yaml\`, 'exported projects');
      }
    }
    if (process.argv[2] === 'takeout' && process.env.FAKE_WL_TAKEOUT_NAME) {
      writeFileSync(process.env.FAKE_WL_TAKEOUT_NAME, 'new archive');
      ownedStagePath = process.cwd();
    }
    if (ownedStagePath && process.env.FAKE_WL_SWAP_STAGE === '1') {
      renameSync(ownedStagePath, \`\${ownedStagePath}-moved\`);
      mkdirSync(ownedStagePath);
      writeFileSync(\`\${ownedStagePath}/attacker-file\`, 'replacement stage');
    }
    if (process.env.FAKE_WL_STDOUT) {
      process.stdout.write(process.env.FAKE_WL_STDOUT);
    }
    if (process.env.FAKE_WL_RUBY_LOGGER === '1') {
      const ruby = spawnSync(
        'ruby',
        [
          '-r',
          'logger',
          '-e',
          'Logger.new($stdout).debug("hidden\\\\ncontinuation"); puts "visible one\\\\nvisible two"',
        ],
        { encoding: 'utf8', env: process.env },
      );
      process.stdout.write(ruby.stdout);
      process.stderr.write(ruby.stderr);
      process.exitCode = ruby.status;
    }
    if (process.env.FAKE_WL_STDERR) {
      process.stderr.write(process.env.FAKE_WL_STDERR);
    }
    process.exitCode = Number(process.env.FAKE_WL_EXIT || 0);
  }
}
`,
  );
  chmodSync(binaryPath, 0o755);
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, recordPath };
}

/**
 * Runs the adapter with a fake wl executable.
 *
 * @param {import('node:test').TestContext} context - Node test context.
 * @param {object | ((fixture: object) => object)} request - JSON request or fixture-aware factory.
 * @param {Record<string, string>} [environment={}] - Fake process environment.
 * @returns {{ process: import('node:child_process').SpawnSyncReturns<string>, response: object, fixture: object }}
 * Adapter execution details.
 */
function runAdapter(context, request, environment = {}) {
  const fixture = createFakeWorklog(context);
  const resolvedRequest = typeof request === 'function' ? request(fixture) : request;
  const path = `${fixture.directory}:${dirname(process.execPath)}:${process.env.PATH}`;
  const child = spawnSync(process.execPath, [ADAPTER_PATH], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...environment,
      PATH: path,
      FAKE_WL_RECORD: fixture.recordPath,
    },
    input: JSON.stringify(resolvedRequest),
  });
  assert.equal(child.error, undefined);
  return {
    process: child,
    response: JSON.parse(child.stdout),
    fixture,
  };
}

/**
 * Runs the adapter using its request-file fallback.
 *
 * @param {import('node:test').TestContext} context - Node test context.
 * @param {object} request - JSON adapter request.
 * @returns {{ process: import('node:child_process').SpawnSyncReturns<string>, response: object, fixture: object }}
 * Adapter execution details.
 */
function runAdapterFromRequestFile(context, request) {
  const fixture = createFakeWorklog(context);
  const requestPath = join(fixture.directory, `worklog-request-${fixtureSequence}.json`);
  const path = `${fixture.directory}:${dirname(process.execPath)}:${process.env.PATH}`;
  writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
  const child = spawnSync(process.execPath, [ADAPTER_PATH, '--request-file', requestPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: path,
      FAKE_WL_RECORD: fixture.recordPath,
    },
  });
  assert.equal(child.error, undefined);
  return {
    process: child,
    response: JSON.parse(child.stdout),
    fixture: { ...fixture, requestPath },
  };
}

/**
 * Runs the adapter against a caller-prepared request path.
 *
 * @param {import('node:test').TestContext} context - Node test context.
 * @param {(fixture: object) => string} preparePath - Creates and returns the request path.
 * @returns {{ process: import('node:child_process').SpawnSyncReturns<string>, response: object, fixture: object }}
 * Adapter execution details.
 */
function runAdapterWithRequestPath(context, preparePath) {
  const fixture = createFakeWorklog(context);
  const requestPath = preparePath(fixture);
  const path = `${fixture.directory}:${dirname(process.execPath)}:${process.env.PATH}`;
  const child = spawnSync(process.execPath, [ADAPTER_PATH, '--request-file', requestPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: path,
      FAKE_WL_RECORD: fixture.recordPath,
    },
  });
  assert.equal(child.error, undefined);
  return {
    process: child,
    response: JSON.parse(child.stdout),
    fixture: { ...fixture, requestPath },
  };
}

/**
 * Parses add argv through the real Thor gem without loading or mutating worklog data.
 *
 * @param {string[]} argv - Adapter-produced wl argv.
 * @returns {{ message: string, options: Record<string, unknown> }} Parsed values.
 */
function parseAddWithThor(argv) {
  const source = `
require 'json'
require 'thor'

class AddProbe < Thor
  desc 'add MESSAGE', 'probe'
  option :date, type: :string
  option :time, type: :string
  option :tags, type: :array, default: []
  option :ticket, type: :string
  option :url, type: :string
  option :epic, type: :boolean, default: false
  option :project, type: :string

  def add(message)
    puts JSON.generate({ message: message, options: options.to_h })
  end
end

AddProbe.start(JSON.parse(ARGV.fetch(0)))
`;
  const result = spawnSync('ruby', ['-e', source, JSON.stringify(argv)], {
    encoding: 'utf8',
    env: { ...process.env, THOR_SILENCE_DEPRECATION: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/**
 * Waits for a project-local fixture file to appear.
 *
 * @param {string} path - Expected file path.
 * @param {number} [timeoutMs=3000] - Timeout.
 * @returns {Promise<void>}
 */
async function waitForFile(path, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${path}`);
}

/**
 * Reserves and releases an ephemeral local port.
 *
 * @returns {Promise<number>} Available port.
 */
async function findAvailablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

/**
 * Waits until a process no longer exists.
 *
 * @param {number} pid - Process ID.
 * @param {number} [timeoutMs=3000] - Timeout.
 * @returns {Promise<void>}
 */
async function waitForProcessExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for PID ${pid}`);
}

test('passes hostile-looking content as literal argv without shell execution', (context) => {
  const fixtureRoot = join(TEST_DIRECTORY, `.worklog-shell-markers-${process.pid}`);
  const markerOne = `${fixtureRoot}-one`;
  const markerTwo = `${fixtureRoot}-two`;
  const markerThree = `${fixtureRoot}-three`;
  const message = `quotes "' and spaces $(touch ${markerOne}) \`touch ${markerTwo}\`; touch ${markerThree}`;
  const result = runAdapter(context, {
    command: 'add',
    message,
    flags: {
      date: '2026-07-15',
      tags: ['one', 'two'],
      project: 'safe-project',
    },
  });

  assert.equal(result.process.status, 0);
  assert.equal(result.response.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(result.fixture.recordPath, 'utf8')), [
    'add',
    '--date=2026-07-15',
    '--project=safe-project',
    '--tags',
    'one',
    'two',
    '--no-epic',
    '--',
    message,
  ]);
  assert.equal(existsSync(markerOne), false);
  assert.equal(existsSync(markerTwo), false);
  assert.equal(existsSync(markerThree), false);
});

test('reads hostile content from a trusted request file without shell interpolation', (context) => {
  const message = 'literal `ticks` $(commands); pipes | and spaces';
  const result = runAdapterFromRequestFile(context, {
    command: 'add',
    message,
    flags: { tags: ['alpha', 'beta'] },
  });

  assert.equal(result.process.status, 0);
  assert.equal(result.response.ok, true);
  assert.equal(existsSync(result.fixture.requestPath), true);
  assert.deepEqual(JSON.parse(readFileSync(result.fixture.recordPath, 'utf8')), [
    'add',
    '--tags',
    'alpha',
    'beta',
    '--no-epic',
    '--',
    message,
  ]);
  unlinkSync(result.fixture.requestPath);
  assert.equal(existsSync(result.fixture.requestPath), false);
});

test('request-file mode rejects symbolic links without reopening their targets', (context) => {
  const result = runAdapterWithRequestPath(context, (fixture) => {
    const target = join(fixture.directory, 'real-request.json');
    const requestPath = join(fixture.directory, 'worklog-request-linked.json');
    writeFileSync(target, JSON.stringify({ command: 'show', flags: {} }), { mode: 0o600 });
    symlinkSync(target, requestPath);
    return requestPath;
  });

  assert.equal(result.process.status, 2);
  assert.match(result.response.stderr, /must not be a symbolic link/);
  assert.equal(existsSync(result.fixture.recordPath), false);
});

test('request-file mode rejects input larger than the bounded descriptor read', (context) => {
  const result = runAdapterWithRequestPath(context, (fixture) => {
    const requestPath = join(fixture.directory, 'worklog-request-oversized.json');
    writeFileSync(requestPath, 'x'.repeat((64 * 1024) + 1), { mode: 0o600 });
    return requestPath;
  });

  assert.equal(result.process.status, 2);
  assert.match(result.response.stderr, /request exceeds 65536 bytes/);
  assert.equal(existsSync(result.fixture.recordPath), false);
});

test('places options before a terminator so leading-dash messages remain positional', (context) => {
  const result = runAdapter(context, {
    command: 'add',
    message: '--not-an-option',
    flags: { date: '2026-07-15', epic: true },
  });

  assert.deepEqual(JSON.parse(readFileSync(result.fixture.recordPath, 'utf8')), [
    'add',
    '--date=2026-07-15',
    '--epic',
    '--',
    '--not-an-option',
  ]);
});

test('uses Thor array argv form for each distinct tag', (context) => {
  const result = runAdapter(context, {
    command: 'show',
    flags: { tags: ['alpha', 'beta'], project: 'project-one' },
  });

  assert.deepEqual(JSON.parse(readFileSync(result.fixture.recordPath, 'utf8')), [
    'show',
    '--tags',
    'alpha',
    'beta',
    '--project=project-one',
  ]);
});

test('real Thor parser preserves multiple tags and leading-dash add messages', (context) => {
  for (const [message, epic] of [['--epic', false], ['--tags', true]]) {
    const result = runAdapter(context, {
      command: 'add',
      message,
      flags: { date: '2026-07-15', tags: ['alpha', 'beta'], epic },
    });
    const argv = JSON.parse(readFileSync(result.fixture.recordPath, 'utf8'));
    const parsed = parseAddWithThor(argv);

    assert.equal(parsed.message, message);
    assert.deepEqual(parsed.options.tags, ['alpha', 'beta']);
    assert.equal(parsed.options.epic, epic);
    assert.equal(parsed.options.date, '2026-07-15');
  }
});

test('preserves a nonzero wl exit status and stderr', (context) => {
  const result = runAdapter(
    context,
    { command: 'show', flags: { date: '2026-07-15' } },
    { FAKE_WL_EXIT: '7', FAKE_WL_STDERR: 'worklog failed\n' },
  );

  assert.equal(result.process.status, 7);
  assert.equal(result.response.ok, false);
  assert.equal(result.response.exitCode, 7);
  assert.equal(result.response.signal, null);
  assert.equal(result.response.stderr, 'worklog failed\n');
});

test('suppresses complete multiline Ruby Logger DEBUG records at source', (context) => {
  const result = runAdapter(
    context,
    { command: 'show', flags: {} },
    { FAKE_WL_RUBY_LOGGER: '1' },
  );

  assert.equal(result.response.stdout, 'visible one\nvisible two\n');
});

test('fallback filtering preserves unprefixed output after a final DEBUG header', (context) => {
  const stdout = [
    'ordinary preface line one',
    'ordinary preface line two',
    'I, [2026-07-15 #123] INFO -- : Kept information',
    'info continuation',
    'D, [2026-07-15 #123] DEBUG -- : Final debug record',
    'legitimate unprefixed output one',
    'legitimate unprefixed output two',
    '',
  ].join('\n');
  const result = runAdapter(context, { command: 'show', flags: {} }, { FAKE_WL_STDOUT: stdout });

  assert.equal(
    result.response.stdout,
    [
      'ordinary preface line one',
      'ordinary preface line two',
      'I, [2026-07-15 #123] INFO -- : Kept information',
      'info continuation',
      'legitimate unprefixed output one',
      'legitimate unprefixed output two',
      '',
    ].join('\n'),
  );
});

test('rejects unsupported commands and flags before invoking wl', (context) => {
  const badCommand = runAdapter(context, { command: 'edit', flags: {} });
  assert.equal(badCommand.process.status, 2);
  assert.match(badCommand.response.stderr, /unsupported command/);
  assert.equal(existsSync(badCommand.fixture.recordPath), false);

  const badFlag = runAdapter(context, { command: 'show', flags: { verbose: true } });
  assert.equal(badFlag.process.status, 2);
  assert.match(badFlag.response.stderr, /unknown field/);
  assert.equal(existsSync(badFlag.fixture.recordPath), false);
});

test('parses retained warnings and write confirmations', (context) => {
  const stdout = [
    'W, [2026-07-15 #123] WARN -- : Person unknown was not found',
    'I, [2026-07-15 #123] INFO -- : Added entry on 2026-07-15: Reviewed code',
    '',
  ].join('\n');
  const result = runAdapter(
    context,
    { command: 'add', message: 'Reviewed code', flags: {} },
    { FAKE_WL_STDOUT: stdout },
  );

  assert.deepEqual(result.response.warnings, ['Person unknown was not found']);
  assert.deepEqual(result.response.confirmation, {
    level: 'INFO',
    message: 'Added entry on 2026-07-15: Reviewed code',
  });
});

test('requires explicit confirmation for destructive and network commands', (context) => {
  for (const command of ['remove', 'init', 'github', 'storage-import']) {
    const flags = command === 'storage-import' ? { path: TEST_DIRECTORY } : {};
    const result = runAdapter(context, { command, flags });
    assert.equal(result.process.status, 2);
    assert.match(result.response.stderr, /requires confirmed: true/);
    assert.equal(existsSync(result.fixture.recordPath), false);
  }
});

test('requires confirmation before exporting into a non-empty directory', (context) => {
  const result = runAdapter(context, {
    command: 'storage-export',
    flags: { path: TEST_DIRECTORY, format: 'yaml' },
  });

  assert.equal(result.process.status, 2);
  assert.match(result.response.stderr, /non-empty directory requires confirmed: true/);
  assert.equal(existsSync(result.fixture.recordPath), false);
});

test('storage export stages outside the destination and publishes validated files', (context) => {
  const result = runAdapter(
    context,
    (fixture) => ({
      command: 'storage-export',
      flags: { path: join(fixture.directory, 'export'), format: 'yaml' },
    }),
    {
      FAKE_WL_STDOUT: 'I, [time #1] INFO -- : Exported yaml data to staging\n',
    },
  );

  assert.equal(result.process.status, 0);
  const destination = join(result.fixture.directory, 'export');
  assert.equal(readFileSync(join(destination, 'people.yaml'), 'utf8'), 'exported people');
  assert.equal(readFileSync(join(destination, 'projects.yaml'), 'utf8'), 'exported projects');
  assert.equal(result.response.confirmation.path, destination);
  const argv = JSON.parse(readFileSync(result.fixture.recordPath, 'utf8'));
  const stagedPath = argv.find((argument) => argument.startsWith('--path=')).slice('--path='.length);
  assert.notEqual(stagedPath, destination);
  assert.match(stagedPath, /\.worklog-export-/);
  assert.equal(existsSync(stagedPath), false);
});

test('storage export rejects a symbolic link in the destination parent chain', (context) => {
  const result = runAdapter(context, (fixture) => {
    const realParent = join(fixture.directory, 'real-parent');
    const linkedParent = join(fixture.directory, 'linked-parent');
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    return {
      command: 'storage-export',
      flags: { path: join(linkedParent, 'export'), format: 'yaml' },
    };
  });

  assert.equal(result.process.status, 2);
  assert.match(result.response.stderr, /parent chain must contain only real directories/);
  assert.equal(existsSync(result.fixture.recordPath), false);
});

test('storage export atomically replaces a destination symlink without following it', (context) => {
  const result = runAdapter(
    context,
    (fixture) => {
      const destination = join(fixture.directory, 'export');
      const outside = join(fixture.directory, 'outside-symlink-target.yaml');
      mkdirSync(destination);
      writeFileSync(outside, 'outside original');
      symlinkSync(outside, join(destination, 'people.yaml'));
      return {
        command: 'storage-export',
        flags: { path: destination, format: 'yaml' },
        confirmed: true,
      };
    },
  );

  const destination = join(result.fixture.directory, 'export');
  const outside = join(result.fixture.directory, 'outside-symlink-target.yaml');
  assert.equal(result.process.status, 0);
  assert.equal(lstatSync(join(destination, 'people.yaml')).isSymbolicLink(), false);
  assert.equal(readFileSync(join(destination, 'people.yaml'), 'utf8'), 'exported people');
  assert.equal(readFileSync(outside, 'utf8'), 'outside original');
});

test('storage export atomically replaces a destination hard link without modifying its peer', (context) => {
  const result = runAdapter(
    context,
    (fixture) => {
      const destination = join(fixture.directory, 'export');
      const outside = join(fixture.directory, 'outside-hardlink-target.yaml');
      mkdirSync(destination);
      writeFileSync(outside, 'outside original');
      linkSync(outside, join(destination, 'people.yaml'));
      return {
        command: 'storage-export',
        flags: { path: destination, format: 'yaml' },
        confirmed: true,
      };
    },
  );

  const destination = join(result.fixture.directory, 'export');
  const outside = join(result.fixture.directory, 'outside-hardlink-target.yaml');
  assert.equal(result.process.status, 0);
  assert.equal(readFileSync(join(destination, 'people.yaml'), 'utf8'), 'exported people');
  assert.equal(readFileSync(outside, 'utf8'), 'outside original');
  assert.notEqual(lstatSync(join(destination, 'people.yaml')).ino, lstatSync(outside).ino);
});

test('storage export rejects and cleans staged symbolic links', (context) => {
  let outside;
  const result = runAdapter(
    context,
    (fixture) => {
      outside = join(fixture.directory, 'outside-stage-symlink.yaml');
      writeFileSync(outside, 'outside original');
      return {
        command: 'storage-export',
        flags: { path: join(fixture.directory, 'export'), format: 'yaml' },
      };
    },
    {
      get FAKE_WL_EXPORT_SYMLINK_TARGET() {
        return outside;
      },
    },
  );

  assert.equal(result.process.status, 2);
  assert.match(result.response.stderr, /staged a symbolic link/);
  assert.equal(readFileSync(outside, 'utf8'), 'outside original');
  assert.equal(existsSync(join(result.fixture.directory, 'export')), false);
  assert.equal(
    readdirSync(result.fixture.directory).some((name) => name.startsWith('.worklog-export-')),
    false,
  );
});

test('storage export rejects and cleans staged hard links', (context) => {
  let outside;
  const result = runAdapter(
    context,
    (fixture) => {
      outside = join(fixture.directory, 'outside-stage-hardlink.yaml');
      writeFileSync(outside, 'outside original');
      return {
        command: 'storage-export',
        flags: { path: join(fixture.directory, 'export'), format: 'yaml' },
      };
    },
    {
      get FAKE_WL_EXPORT_HARDLINK_TARGET() {
        return outside;
      },
    },
  );

  assert.equal(result.process.status, 2);
  assert.match(result.response.stderr, /hard-linked file/);
  assert.equal(readFileSync(outside, 'utf8'), 'outside original');
  assert.equal(lstatSync(outside).nlink, 1);
  assert.equal(existsSync(join(result.fixture.directory, 'export')), false);
});

test('storage export refuses publication when its pinned stage path is swapped', (context) => {
  const result = runAdapter(
    context,
    (fixture) => ({
      command: 'storage-export',
      flags: { path: join(fixture.directory, 'export'), format: 'yaml' },
    }),
    { FAKE_WL_SWAP_STAGE: '1' },
  );

  assert.equal(result.process.status, 2);
  assert.match(result.response.stderr, /staging path identity changed/);
  assert.equal(existsSync(join(result.fixture.directory, 'export')), false);
  const replacement = readdirSync(result.fixture.directory)
    .find((name) => name.startsWith('.worklog-export-') && !name.endsWith('-moved'));
  assert.equal(readFileSync(join(result.fixture.directory, replacement, 'attacker-file'), 'utf8'), 'replacement stage');
});

test('rejects token fields without echoing their values', (context) => {
  const secret = 'should-not-appear-in-output';
  const result = runAdapter(context, {
    command: 'github',
    flags: {},
    confirmed: true,
    token: secret,
  });

  assert.equal(result.process.status, 2);
  assert.match(result.response.stderr, /unknown field/);
  assert.doesNotMatch(result.process.stdout, new RegExp(secret));
  assert.equal(existsSync(result.fixture.recordPath), false);
});

test('rejects conflicting dates and invalid value types', (context) => {
  const conflict = runAdapter(context, {
    command: 'show',
    flags: { date: '2026-07-15', from: '2026-07-01' },
  });
  assert.equal(conflict.process.status, 2);
  assert.match(conflict.response.stderr, /cannot be combined/);

  const dateAndDays = runAdapter(context, {
    command: 'show',
    flags: { date: '2026-07-15', days: '3' },
  });
  assert.equal(dateAndDays.process.status, 2);
  assert.match(dateAndDays.response.stderr, /date cannot be combined with flags.days/);

  const wrongType = runAdapter(context, { command: 'add', message: 'Entry', flags: { tags: 'tag' } });
  assert.equal(wrongType.process.status, 2);
  assert.match(wrongType.response.stderr, /must be a non-empty array/);
});

test('accepts since only for show', (context) => {
  const show = runAdapter(context, {
    command: 'show',
    flags: { since: '2026-07-01', to: '2026-07-15' },
  });
  assert.equal(show.process.status, 0);

  for (const command of ['standup', 'summary', 'tags']) {
    const result = runAdapter(context, { command, flags: { since: '2026-07-01' } });
    assert.equal(result.process.status, 2);
    assert.match(result.response.stderr, /unknown field/);
  }
});

test('takeout rejects an existing explicit output path before execution', (context) => {
  const generatedName = 'worklog_takeout_20260715_175242.tar.gz';
  const result = runAdapter(
    context,
    (fixture) => {
      const outputPath = join(fixture.directory, 'approved-backup.tar.gz');
      writeFileSync(outputPath, 'existing archive');
      return { command: 'takeout', flags: { outputPath } };
    },
    { FAKE_WL_TAKEOUT_NAME: generatedName },
  );

  assert.equal(result.process.status, 2);
  assert.match(result.response.stderr, /confirm overwrite/);
  assert.equal(
    readFileSync(join(result.fixture.directory, 'approved-backup.tar.gz'), 'utf8'),
    'existing archive',
  );
  assert.equal(existsSync(result.fixture.recordPath), false);
  assert.equal(
    readdirSync(result.fixture.directory).some((name) => name.startsWith('.worklog-takeout-')),
    false,
  );
});

test('takeout rejects a symbolic link in the output parent chain', (context) => {
  const result = runAdapter(context, (fixture) => {
    const realParent = join(fixture.directory, 'real-takeout-parent');
    const linkedParent = join(fixture.directory, 'linked-takeout-parent');
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    return {
      command: 'takeout',
      flags: { outputPath: join(linkedParent, 'backup.tar.gz') },
    };
  });

  assert.equal(result.process.status, 2);
  assert.match(result.response.stderr, /parent chain must contain only real directories/);
  assert.equal(existsSync(result.fixture.recordPath), false);
});

test('takeout rejects unsafe writable output parents', (context) => {
  const result = runAdapter(context, (fixture) => {
    const unsafeParent = join(fixture.directory, 'unsafe-takeout-parent');
    mkdirSync(unsafeParent);
    chmodSync(unsafeParent, 0o777);
    return {
      command: 'takeout',
      flags: { outputPath: join(unsafeParent, 'backup.tar.gz') },
    };
  });

  assert.equal(result.process.status, 2);
  assert.match(result.response.stderr, /unsafe writable directories/);
  assert.equal(existsSync(result.fixture.recordPath), false);
});

test('publishes a new takeout to the chosen output path without using wl timestamp name', (context) => {
  const generatedName = 'worklog_takeout_20260715_175241.tar.gz';
  const outputName = 'chosen-backup.tar.gz';
  const result = runAdapter(
    context,
    (fixture) => ({
      command: 'takeout',
      flags: { outputPath: join(fixture.directory, outputName) },
    }),
    {
      FAKE_WL_TAKEOUT_NAME: generatedName,
      FAKE_WL_STDOUT: `I, [time #1] INFO -- : Created takeout archive: ${generatedName}\n`,
    },
  );

  assert.equal(result.process.status, 0);
  const outputPath = join(result.fixture.directory, outputName);
  assert.equal(readFileSync(outputPath, 'utf8'), 'new archive');
  assert.equal(result.response.confirmation.path, outputPath);
  assert.equal(existsSync(join(result.fixture.directory, generatedName)), false);
});

test('publishes staged takeout only to the exact confirmed output path', (context) => {
  const generatedName = 'worklog_takeout_20260715_175243.tar.gz';
  const outputName = 'approved-backup.tar.gz';
  const result = runAdapter(
    context,
    (fixture) => {
      const outputPath = join(fixture.directory, outputName);
      writeFileSync(outputPath, 'existing archive');
      return {
        command: 'takeout',
        flags: { outputPath },
        confirmed: true,
      };
    },
    {
      FAKE_WL_TAKEOUT_NAME: generatedName,
      FAKE_WL_STDOUT: `I, [time #1] INFO -- : Created takeout archive: ${generatedName}\n`,
    },
  );

  assert.equal(result.process.status, 0);
  const outputPath = join(result.fixture.directory, outputName);
  assert.equal(readFileSync(outputPath, 'utf8'), 'new archive');
  assert.equal(result.response.confirmation.path, outputPath);
  assert.equal(existsSync(join(result.fixture.directory, generatedName)), false);
});

test('takeout refuses publication when its pinned stage path is swapped', (context) => {
  const generatedName = 'worklog_takeout_20260715_175244.tar.gz';
  const result = runAdapter(
    context,
    (fixture) => ({
      command: 'takeout',
      flags: { outputPath: join(fixture.directory, 'backup.tar.gz') },
    }),
    {
      FAKE_WL_TAKEOUT_NAME: generatedName,
      FAKE_WL_SWAP_STAGE: '1',
    },
  );

  assert.equal(result.process.status, 2);
  assert.match(result.response.stderr, /staging path identity changed/);
  assert.equal(existsSync(join(result.fixture.directory, 'backup.tar.gz')), false);
});

test('server rejects a symbolic link in the log parent chain', (context) => {
  const result = runAdapter(context, (fixture) => {
    const realParent = join(fixture.directory, 'real-log-parent');
    const linkedParent = join(fixture.directory, 'linked-log-parent');
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    return {
      command: 'server',
      flags: { logPath: join(linkedParent, 'server.log') },
    };
  });

  assert.equal(result.process.status, 2);
  assert.match(result.response.stderr, /parent chain must contain only real directories/);
  assert.equal(existsSync(result.fixture.recordPath), false);
});

test('detects the actual server port from Rackup output and verifies readiness', async (context) => {
  const port = await findAvailablePort();
  const result = runAdapter(
    context,
    (fixture) => ({
      command: 'server',
      flags: { logPath: join(fixture.directory, 'server.log') },
    }),
    { FAKE_WL_SERVER_PORT: String(port) },
  );

  assert.equal(result.process.status, 0);
  assert.equal(result.response.confirmation.url, `http://127.0.0.1:${port}`);
  assert.equal(result.response.confirmation.pid > 0, true);
  process.kill(result.response.confirmation.pid, 'SIGTERM');
  await waitForProcessExit(result.response.confirmation.pid);
});

test('server readiness reads the exact opened log descriptor after path replacement', async (context) => {
  const port = await findAvailablePort();
  let logPath;
  const result = runAdapter(
    context,
    (fixture) => {
      logPath = join(fixture.directory, 'server.log');
      return { command: 'server', flags: { logPath } };
    },
    {
      FAKE_WL_SERVER_PORT: String(port),
      get FAKE_WL_SERVER_LOG_PATH() {
        return logPath;
      },
    },
  );

  assert.equal(result.process.status, 0);
  assert.equal(result.response.confirmation.url, `http://127.0.0.1:${port}`);
  assert.equal(readFileSync(logPath, 'utf8'), 'Listening on http://127.0.0.1:1\n');
  process.kill(result.response.confirmation.pid, 'SIGTERM');
  await waitForProcessExit(result.response.confirmation.pid);
});

test('server does not report success when its process exits after the readiness connection', async (context) => {
  const port = await findAvailablePort();
  const result = runAdapter(
    context,
    (fixture) => ({
      command: 'server',
      flags: { logPath: join(fixture.directory, 'server.log') },
    }),
    {
      FAKE_WL_SERVER_PORT: String(port),
      FAKE_WL_SERVER_EXIT_ON_CONNECTION: '1',
    },
  );

  assert.equal(result.process.status, 1);
  assert.equal(result.response.ok, false);
  assert.match(result.response.stderr, /exited during readiness verification/);
});

test('server readiness cancellation race returns cancellation, not success', async (context) => {
  const port = await findAvailablePort();
  const result = runAdapter(
    context,
    (fixture) => ({
      command: 'server',
      flags: { logPath: join(fixture.directory, 'server.log') },
    }),
    {
      FAKE_WL_SERVER_PORT: String(port),
      FAKE_WL_SERVER_CANCEL_ON_CONNECTION: '1',
    },
  );

  assert.equal(result.process.status, 143);
  assert.equal(result.response.ok, false);
  assert.equal(result.response.signal, 'SIGTERM');
});

test('server startup forwards cancellation to its detached process group', async (context) => {
  const fixture = createFakeWorklog(context);
  const parentReady = join(fixture.directory, 'server-parent-ready');
  const parentSignal = join(fixture.directory, 'server-parent-signal');
  const grandchildReady = join(fixture.directory, 'server-grandchild-ready');
  const grandchildSignal = join(fixture.directory, 'server-grandchild-signal');
  const logPath = join(fixture.directory, 'server.log');
  const path = `${fixture.directory}:${dirname(process.execPath)}:${process.env.PATH}`;
  const child = spawn(process.execPath, [ADAPTER_PATH], {
    env: {
      ...process.env,
      PATH: path,
      FAKE_WL_RECORD: fixture.recordPath,
      FAKE_WL_WAIT_FOR_SIGNAL: '1',
      FAKE_WL_PARENT_READY: parentReady,
      FAKE_WL_PARENT_SIGNAL: parentSignal,
      FAKE_WL_GRANDCHILD_READY: grandchildReady,
      FAKE_WL_GRANDCHILD_SIGNAL: grandchildSignal,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stdin.end(JSON.stringify({ command: 'server', flags: { logPath } }));
  await waitForFile(parentReady);
  await waitForFile(grandchildReady);

  process.kill(child.pid, 'SIGTERM');
  const [exitCode, signal] = await once(child, 'close');
  await waitForFile(parentSignal);
  await waitForFile(grandchildSignal);

  assert.equal(exitCode, 143);
  assert.equal(signal, null);
  assert.equal(JSON.parse(stdout).signal, 'SIGTERM');
  assert.equal(readFileSync(parentSignal, 'utf8'), 'SIGTERM');
  assert.equal(readFileSync(grandchildSignal, 'utf8'), 'SIGTERM');
});

test('escalates retained process groups after leaders exit and descendants hold pipes', async (context) => {
  for (const command of ['show', 'server']) {
    const fixture = createFakeWorklog(context);
    const parentReady = join(fixture.directory, `${command}-parent-ready`);
    const parentSignal = join(fixture.directory, `${command}-parent-signal`);
    const grandchildReady = join(fixture.directory, `${command}-grandchild-ready`);
    const grandchildSignal = join(fixture.directory, `${command}-grandchild-signal`);
    const path = `${fixture.directory}:${dirname(process.execPath)}:${process.env.PATH}`;
    const child = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: path,
        FAKE_WL_RECORD: fixture.recordPath,
        FAKE_WL_WAIT_FOR_SIGNAL: '1',
        FAKE_WL_GRANDCHILD_IGNORE_FIRST: '1',
        FAKE_WL_PARENT_READY: parentReady,
        FAKE_WL_PARENT_SIGNAL: parentSignal,
        FAKE_WL_GRANDCHILD_READY: grandchildReady,
        FAKE_WL_GRANDCHILD_SIGNAL: grandchildSignal,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    const request = command === 'server'
      ? { command, flags: { logPath: join(fixture.directory, 'server.log') } }
      : { command, flags: {} };
    child.stdin.end(JSON.stringify(request));
    await waitForFile(parentReady);
    await waitForFile(grandchildReady);
    const descendantPid = Number(readFileSync(grandchildReady, 'utf8'));

    process.kill(child.pid, 'SIGTERM');
    const [exitCode, signal] = await once(child, 'close');
    await waitForFile(parentSignal);
    await waitForFile(grandchildSignal);
    await waitForProcessExit(descendantPid);

    assert.equal(exitCode, 143);
    assert.equal(signal, null);
    assert.equal(JSON.parse(stdout).signal, 'SIGTERM');
    assert.equal(readFileSync(parentSignal, 'utf8'), 'SIGTERM');
    assert.equal(readFileSync(grandchildSignal, 'utf8'), 'SIGTERM');
  }
});

test('rejects a server start when Rackup default port 9292 is occupied', async (context) => {
  const conflictServer = createServer();
  let ownsConflict = false;
  try {
    conflictServer.listen(9292, '127.0.0.1');
    await once(conflictServer, 'listening');
    ownsConflict = true;
  } catch (error) {
    if (error.code !== 'EADDRINUSE') {
      throw error;
    }
  }
  context.after(() => {
    if (ownsConflict) {
      conflictServer.close();
    }
  });

  const result = runAdapter(context, (fixture) => ({
    command: 'server',
    flags: { logPath: join(fixture.directory, 'server.log') },
  }));
  assert.equal(result.process.status, 2);
  assert.match(result.response.stderr, /port 9292 is already in use/);
  assert.equal(existsSync(result.fixture.recordPath), false);
});

test('forwards SIGINT and SIGTERM to the exact wl process group', async (context) => {
  for (const [sentSignal, expectedExitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const fixture = createFakeWorklog(context);
    const parentReady = join(fixture.directory, 'parent-ready');
    const parentSignal = join(fixture.directory, 'parent-signal');
    const grandchildReady = join(fixture.directory, 'grandchild-ready');
    const grandchildSignal = join(fixture.directory, 'grandchild-signal');
    const path = `${fixture.directory}:${dirname(process.execPath)}:${process.env.PATH}`;
    const child = spawn(process.execPath, [ADAPTER_PATH], {
      env: {
        ...process.env,
        PATH: path,
        FAKE_WL_RECORD: fixture.recordPath,
        FAKE_WL_WAIT_FOR_SIGNAL: '1',
        FAKE_WL_PARENT_READY: parentReady,
        FAKE_WL_PARENT_SIGNAL: parentSignal,
        FAKE_WL_GRANDCHILD_READY: grandchildReady,
        FAKE_WL_GRANDCHILD_SIGNAL: grandchildSignal,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stdin.end(JSON.stringify({ command: 'show', flags: {} }));
    await waitForFile(parentReady);
    await waitForFile(grandchildReady);

    process.kill(child.pid, sentSignal);
    const [exitCode, signal] = await once(child, 'close');
    await waitForFile(parentSignal);
    await waitForFile(grandchildSignal);

    assert.equal(exitCode, expectedExitCode);
    assert.equal(signal, null);
    assert.equal(JSON.parse(stdout).signal, sentSignal);
    assert.equal(readFileSync(parentSignal, 'utf8'), sentSignal);
    assert.equal(readFileSync(grandchildSignal, 'utf8'), sentSignal);
  }
});
