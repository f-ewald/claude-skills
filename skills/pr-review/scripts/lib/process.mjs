/**
 * Bounded, cancellable child-process execution without a shell.
 *
 * Children run in their own process group (POSIX) so a deadline or abort
 * terminates the whole tree, not only the direct child.
 */

import { spawn } from 'node:child_process';

const KILL_GRACE_MS = 2000;
const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

/** Tracks spawned process groups so they can be terminated together. */
export class ProcessRegistry {
  /** Creates an empty registry. */
  constructor() {
    this.children = new Set();
  }

  /**
   * Registers a child until it exits.
   *
   * @param {import('node:child_process').ChildProcess} child - Spawned child.
   * @returns {import('node:child_process').ChildProcess} The same child.
   */
  track(child) {
    this.children.add(child);
    child.once('exit', () => this.children.delete(child));
    return child;
  }

  /**
   * Sends a signal to every tracked process group.
   *
   * @param {NodeJS.Signals} [signal='SIGTERM'] - Signal to send.
   * @returns {void}
   */
  killAll(signal = 'SIGTERM') {
    for (const child of this.children) {
      killGroup(child, signal);
    }
  }
}

/**
 * Signals a child's process group, falling back to the child itself.
 *
 * @param {import('node:child_process').ChildProcess} child - Target child.
 * @param {NodeJS.Signals} signal - Signal to send.
 * @returns {void}
 */
export function killGroup(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

/**
 * Terminates a child gracefully, escalating to SIGKILL after a grace period.
 *
 * @param {import('node:child_process').ChildProcess} child - Target child.
 * @returns {void}
 */
export function terminate(child) {
  killGroup(child, 'SIGTERM');
  setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS).unref();
}

/**
 * Spawns a binary with an argument array (never a shell) in its own process group.
 *
 * @param {string} binary - Executable name or path.
 * @param {string[]} args - Arguments passed verbatim.
 * @param {object} options - Spawn options.
 * @param {string} [options.cwd] - Working directory.
 * @param {NodeJS.ProcessEnv} [options.env] - Environment.
 * @param {ProcessRegistry} [options.registry] - Registry that tracks the child.
 * @param {Array<string>} [options.stdio] - stdio configuration.
 * @returns {import('node:child_process').ChildProcess} The spawned child.
 */
export function spawnTracked(binary, args, options = {}) {
  const child = spawn(binary, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: false,
  });
  options.registry?.track(child);
  return child;
}

/**
 * Runs a process to completion with a deadline and bounded output capture.
 *
 * @param {string} binary - Executable name or path.
 * @param {string[]} args - Arguments passed verbatim.
 * @param {object} [options] - Execution options.
 * @param {string} [options.cwd] - Working directory.
 * @param {NodeJS.ProcessEnv} [options.env] - Environment.
 * @param {number} [options.deadlineMs] - Wall-clock limit; the process tree is killed when exceeded.
 * @param {number} [options.maxStdoutBytes] - Stdout capture limit; exceeding it kills the process.
 * @param {number} [options.maxStderrBytes] - Stderr tail retained.
 * @param {boolean} [options.binary] - Return stdout as a Buffer instead of UTF-8 text.
 * @param {ProcessRegistry} [options.registry] - Registry that tracks the child.
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string|Buffer, stderr: string,
 *   timedOut: boolean, stdoutTruncated: boolean, spawnError: string|null}>} Never rejects.
 */
export function runProcess(binary, args, options = {}) {
  return new Promise((resolve) => {
    const collector = new OutputCollector(options);
    let child;
    try {
      child = spawnTracked(binary, args, options);
    } catch (error) {
      resolve(collector.result({ spawnError: error.message }));
      return;
    }
    const timer = options.deadlineMs > 0
      ? setTimeout(() => collector.timeout(child), options.deadlineMs)
      : null;
    child.stdout.on('data', (chunk) => collector.stdout(chunk, child));
    child.stderr.on('data', (chunk) => collector.stderr(chunk));
    child.once('error', (error) => collector.settle(resolve, timer, { spawnError: error.message }));
    child.once('close', (code, signal) => collector.settle(resolve, timer, { code, signal }));
  });
}

/** Accumulates bounded output and settles a process result exactly once. */
class OutputCollector {
  /**
   * Creates a collector with the caller's limits.
   *
   * @param {object} options - Limits from runProcess.
   */
  constructor(options) {
    this.maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
    this.maxStderr = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    this.binary = options.binary === true;
    this.chunks = [];
    this.bytes = 0;
    this.stderrText = '';
    this.truncated = false;
    this.timedOut = false;
    this.settled = false;
  }

  /**
   * Records a stdout chunk, killing the child when the limit is exceeded.
   *
   * @param {Buffer} chunk - Output chunk.
   * @param {import('node:child_process').ChildProcess} child - Producing child.
   * @returns {void}
   */
  stdout(chunk, child) {
    if (this.truncated) {
      return;
    }
    if (this.bytes + chunk.length > this.maxStdout) {
      this.truncated = true;
      terminate(child);
      return;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  /**
   * Retains the tail of stderr.
   *
   * @param {Buffer} chunk - Output chunk.
   * @returns {void}
   */
  stderr(chunk) {
    this.stderrText = `${this.stderrText}${chunk.toString('utf8')}`.slice(-this.maxStderr);
  }

  /**
   * Marks the run as timed out and kills the process tree.
   *
   * @param {import('node:child_process').ChildProcess} child - Child to kill.
   * @returns {void}
   */
  timeout(child) {
    this.timedOut = true;
    terminate(child);
  }

  /**
   * Resolves the pending promise once.
   *
   * @param {Function} resolve - Promise resolver.
   * @param {NodeJS.Timeout|null} timer - Deadline timer to clear.
   * @param {object} outcome - Exit details.
   * @returns {void}
   */
  settle(resolve, timer, outcome) {
    if (this.settled) {
      return;
    }
    this.settled = true;
    clearTimeout(timer);
    resolve(this.result(outcome));
  }

  /**
   * Builds the result object.
   *
   * @param {object} outcome - Exit details.
   * @returns {object} Process result.
   */
  result(outcome) {
    const buffer = Buffer.concat(this.chunks);
    return {
      code: outcome.code ?? null,
      signal: outcome.signal ?? null,
      stdout: this.binary ? buffer : buffer.toString('utf8'),
      stderr: this.stderrText,
      timedOut: this.timedOut,
      stdoutTruncated: this.truncated,
      spawnError: outcome.spawnError ?? null,
    };
  }
}
