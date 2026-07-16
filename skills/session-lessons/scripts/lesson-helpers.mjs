/**
 * Deterministic lesson de-duplication, routing, and write preflight helpers.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'before', 'by', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'the', 'to', 'when', 'with', 'you', 'your',
]);
const POSITIVE_WORDS = new Set(['always', 'must', 'require', 'required', 'should']);
const NEGATIVE_WORDS = new Set(['avoid', 'disallow', 'forbid', 'never', 'not', 'prohibit']);
const MANAGED_MARKERS = [
  /\bcompany[- ]managed\b/i,
  /\bcentrally managed\b/i,
  /\benterprise[- ]managed\b/i,
  /\bmanaged by\b/i,
  /\bdo not edit\b/i,
  /\bmanaged by (?:your )?(?:company|organization|administrator)\b/i,
  /\bdo not edit\b.*\bmanaged\b/i,
  /\bgenerated file\b.*\bdo not edit\b/i,
];

/**
 * Produces stable SHA-256 text fingerprints for concurrent-change checks.
 *
 * @param {string} content - File content.
 * @returns {string} Hex digest.
 */
export function contentDigest(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Reduces rule wording to comparable tokens without claiming semantic embeddings.
 *
 * @param {string} rule - Instruction rule.
 * @returns {string[]} Sorted unique comparable tokens.
 */
export function normalizeRuleTokens(rule) {
  const tokens = rule.toLowerCase()
    .replace(/don't/g, 'do not')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !STOP_WORDS.has(token))
    .filter((token) => !POSITIVE_WORDS.has(token) && !NEGATIVE_WORDS.has(token))
    .map((token) => token.replace(/(?:ing|ed|es|s)$/i, ''))
    .filter((token) => token.length > 1);
  return [...new Set(tokens)].sort();
}

/**
 * Computes a token-overlap similarity suitable for conservative rule de-duplication.
 *
 * @param {string} leftRule - First rule.
 * @param {string} rightRule - Second rule.
 * @returns {number} Jaccard/containment score from zero to one.
 */
export function ruleSimilarity(leftRule, rightRule) {
  const left = new Set(normalizeRuleTokens(leftRule));
  const right = new Set(normalizeRuleTokens(rightRule));
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  const jaccard = intersection / union;
  const containment = intersection / Math.min(left.size, right.size);
  return Math.max(jaccard, containment * 0.9);
}

/**
 * Determines whether a rule is affirmative, prohibitive, or neutral.
 *
 * @param {string} rule - Instruction rule.
 * @returns {'positive'|'negative'|'neutral'} Rule polarity.
 */
function rulePolarity(rule) {
  const words = new Set(rule.toLowerCase().replace(/don't/g, 'do not').match(/[a-z]+/g) ?? []);
  if ([...NEGATIVE_WORDS].some((word) => words.has(word))) {
    return 'negative';
  }
  if ([...POSITIVE_WORDS].some((word) => words.has(word))) {
    return 'positive';
  }
  return 'neutral';
}

/**
 * Applies existing-rule precedence and detects likely contradictions.
 *
 * @param {string} candidate - Proposed rule.
 * @param {string[]} existingRules - Existing instruction bullets.
 * @returns {object} Comparison status and strongest match.
 */
export function compareRuleToExisting(candidate, existingRules) {
  let strongest = { rule: null, similarity: 0 };
  for (const existingRule of existingRules) {
    const similarity = ruleSimilarity(candidate, existingRule);
    if (similarity > strongest.similarity) {
      strongest = { rule: existingRule, similarity };
    }
  }

  const candidatePolarity = rulePolarity(candidate);
  const existingPolarity = strongest.rule ? rulePolarity(strongest.rule) : 'neutral';
  const oppositePolarity = candidatePolarity !== 'neutral'
    && existingPolarity !== 'neutral'
    && candidatePolarity !== existingPolarity;
  if (oppositePolarity && strongest.similarity >= 0.55) {
    return { status: 'contradiction', ...strongest };
  }
  if (strongest.similarity >= 0.72) {
    return { status: 'covered-by-existing', ...strongest };
  }
  return { status: 'new', ...strongest };
}

/**
 * Assigns conservative confidence from observable correction signals.
 *
 * Abort-only evidence is deliberately weaker because interruption intent is ambiguous.
 *
 * @param {string[]} signals - Signal labels.
 * @returns {number} Confidence from zero to one.
 */
export function confidenceForSignals(signals) {
  const signalSet = new Set(signals);
  if (signalSet.has('repeated-correction')) {
    return 0.98;
  }
  if (signalSet.has('user-correction')) {
    return 0.9;
  }
  if (signalSet.has('model-self-correction')) {
    return signalSet.has('abort') ? 0.68 : 0.62;
  }
  if (signalSet.has('abort')) {
    return 0.35;
  }
  if (signalSet.has('tool-failure')) {
    return 0.45;
  }
  return 0.2;
}

/**
 * Resolves an existing symlink target portably, or the nearest existing parent for a new file.
 *
 * @param {string} targetPath - Requested instruction path.
 * @returns {string} Canonical target path.
 */
export function resolveTargetPath(targetPath) {
  const absolutePath = resolve(targetPath);
  const targetStat = lstatOrNull(absolutePath);
  if (targetStat) {
    if (targetStat.isSymbolicLink() && !existsSync(absolutePath)) {
      const linkTarget = readlinkSync(absolutePath);
      throw new Error(`Refusing dangling instruction symlink: ${absolutePath} -> ${linkTarget}`);
    }
    return realpathSync.native(absolutePath);
  }

  const missingSegments = [basename(absolutePath)];
  let parent = dirname(absolutePath);
  let parentStat = lstatOrNull(parent);
  while (!parentStat) {
    missingSegments.unshift(basename(parent));
    const nextParent = dirname(parent);
    if (nextParent === parent) {
      return absolutePath;
    }
    parent = nextParent;
    parentStat = lstatOrNull(parent);
  }
  if (parentStat.isSymbolicLink() && !existsSync(parent)) {
    const linkTarget = readlinkSync(parent);
    throw new Error(`Refusing dangling instruction symlink: ${parent} -> ${linkTarget}`);
  }
  return join(realpathSync.native(parent), ...missingSegments);
}

/**
 * Reads path metadata without following symlinks.
 *
 * @param {string} path - Path to inspect.
 * @returns {import('node:fs').Stats|null} Path metadata.
 */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Finds a company-managed marker that should block automatic edits.
 *
 * @param {string} content - Instruction file content.
 * @returns {string|null} Matching marker text.
 */
export function detectManagedMarker(content) {
  const match = MANAGED_MARKERS.map((pattern) => content.match(pattern)).find(Boolean);
  return match?.[0] ?? null;
}

/**
 * Checks whether a target is already dirty in its repository.
 *
 * @param {string} targetPath - Canonical file path.
 * @param {string} repositoryRoot - Repository root.
 * @param {Function} [execFile=execFileSync] - Injectable execFileSync implementation.
 * @returns {string} Porcelain status output, or an empty string outside the repository.
 * @throws {Error} If Git cannot determine the target's dirty state.
 */
export function inspectDirtyState(targetPath, repositoryRoot, execFile = execFileSync) {
  const relativePath = relative(repositoryRoot, targetPath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return '';
  }
  try {
    return execFile(
      'git',
      ['-C', repositoryRoot, 'status', '--porcelain=v1', '--', relativePath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch (error) {
    throw new Error(`Unable to inspect repository dirty state: ${error.message}`);
  }
}

/**
 * Routes an accepted rule to harness-appropriate global or repository instructions.
 *
 * @param {object} options - Routing options.
 * @param {'global'|'repository'} options.scope - Rule scope.
 * @param {'claude'|'copilot'|'shared'} options.harness - Harness applicability.
 * @param {string} options.homeDirectory - User home directory.
 * @param {string} options.repositoryRoot - Repository root.
 * @returns {string[]} Requested instruction targets.
 */
export function routeInstructionTargets({
  scope,
  harness,
  homeDirectory,
  repositoryRoot,
}) {
  if (!['global', 'repository'].includes(scope)) {
    throw new Error(`Unsupported scope: ${scope}`);
  }
  if (!['claude', 'copilot', 'shared'].includes(harness)) {
    throw new Error(`Unsupported harness: ${harness}`);
  }

  const targets = [];
  if (scope === 'global' && ['claude', 'shared'].includes(harness)) {
    targets.push(join(homeDirectory, '.claude', 'CLAUDE.md'));
  }
  if (scope === 'global' && ['copilot', 'shared'].includes(harness)) {
    targets.push(join(homeDirectory, '.copilot', 'copilot-instructions.md'));
  }
  if (scope === 'repository' && ['claude', 'shared'].includes(harness)) {
    targets.push(join(repositoryRoot, 'CLAUDE.md'));
  }
  if (scope === 'repository' && ['copilot', 'shared'].includes(harness)) {
    targets.push(join(repositoryRoot, '.github', 'copilot-instructions.md'));
  }
  return targets;
}

/**
 * Adds this repository's distributed CLAUDE.md/COPILOT.md counterpart when either is targeted.
 *
 * @param {string[]} targets - Requested paths.
 * @param {string} repositoryRoot - Current repository root.
 * @param {object} [options] - Pairing options.
 * @param {Function} [options.resolver=resolveTargetPath] - Injectable path resolver.
 * @param {'global'|'repository'} [options.scope='repository'] - Requested rule scope.
 * @returns {string[]} Canonical, de-duplicated targets.
 */
export function reconcileInstructionPair(
  targets,
  repositoryRoot,
  {
    resolver = resolveTargetPath,
    scope = 'repository',
  } = {},
) {
  const canonical = targets.map((target) => resolver(target));
  const isDistributionRepository = existsSync(
    join(repositoryRoot, 'skills', 'session-lessons', 'SKILL.md'),
  );
  if (scope !== 'global' || !isDistributionRepository) {
    return [...new Set(canonical)];
  }

  const claudePath = resolve(repositoryRoot, 'CLAUDE.md');
  const copilotPath = resolve(repositoryRoot, 'COPILOT.md');
  const resolvedClaude = resolver(claudePath);
  const resolvedCopilot = resolver(copilotPath);
  if (canonical.some((target) => target === resolvedClaude || target === resolvedCopilot)) {
    canonical.push(resolvedClaude, resolvedCopilot);
  }
  return [...new Set(canonical)];
}

/**
 * Captures all state needed before displaying a diff and requesting write approval.
 *
 * @param {string} targetPath - Requested instruction path.
 * @param {object} [options] - Preflight options.
 * @param {string} [options.repositoryRoot] - Repository root for dirty checks.
 * @param {Function} [options.execFile=execFileSync] - Injectable execFileSync implementation.
 * @returns {object} Immutable preflight snapshot.
 * @throws {Error} If the target is unsafe or Git dirty-state inspection fails.
 */
export function preflightTarget(targetPath, {
  repositoryRoot,
  execFile = execFileSync,
} = {}) {
  const resolvedPath = resolveTargetPath(targetPath);
  const exists = existsSync(resolvedPath);
  const content = exists ? readFileSync(resolvedPath, 'utf8') : '';
  return {
    requestedPath: resolve(targetPath),
    resolvedPath,
    exists,
    content,
    mode: exists ? statSync(resolvedPath).mode & 0o777 : undefined,
    digest: contentDigest(content),
    managedMarker: detectManagedMarker(content),
    dirtyState: repositoryRoot ? inspectDirtyState(resolvedPath, repositoryRoot, execFile) : '',
  };
}

/**
 * Produces an exact full-file unified diff for approval.
 *
 * @param {string} filePath - Display path.
 * @param {string} before - Existing content.
 * @param {string} after - Proposed content.
 * @returns {string} Exact diff text.
 */
export function previewExactDiff(filePath, before, after) {
  if (before === after) {
    return '';
  }
  const beforeLines = before.endsWith('\n') ? before.slice(0, -1).split('\n') : before.split('\n');
  const afterLines = after.endsWith('\n') ? after.slice(0, -1).split('\n') : after.split('\n');
  const oldCount = before === '' ? 0 : beforeLines.length;
  const newCount = after === '' ? 0 : afterLines.length;
  return [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...beforeLines.filter((line) => before !== '').map((line) => `-${line}`),
    ...afterLines.filter((line) => after !== '').map((line) => `+${line}`),
  ].join('\n');
}

/**
 * Binds a preview to the exact proposed replacement content.
 *
 * @param {object} preflight - Snapshot from preflightTarget.
 * @param {string} nextContent - Fully rendered proposed content.
 * @returns {object} Immutable approval plan with exact diff and content digest.
 */
export function createWritePlan(preflight, nextContent) {
  return Object.freeze({
    requestedPath: preflight.requestedPath,
    resolvedPath: preflight.resolvedPath,
    currentDigest: preflight.digest,
    proposedDigest: contentDigest(nextContent),
    diff: previewExactDiff(preflight.resolvedPath, preflight.content, nextContent),
  });
}

const ATOMIC_FILE_OPERATIONS = Object.freeze({
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
});

/**
 * Returns the deterministic same-directory advisory lock path for a target.
 *
 * @param {string} targetPath - Canonical instruction target.
 * @returns {string} Advisory lock path.
 */
export function targetLockPath(targetPath) {
  return join(dirname(targetPath), `.${basename(targetPath)}.session-lessons.lock`);
}

/**
 * Runs a write operation while holding an exclusive same-directory advisory lock.
 *
 * @param {string} targetPath - Canonical instruction target.
 * @param {Function} operation - Locked operation.
 * @param {object} [fileSystem] - Injectable file-operation overrides.
 * @returns {unknown} Operation result.
 */
function withTargetLock(targetPath, operation, fileSystem = {}) {
  const operations = { ...ATOMIC_FILE_OPERATIONS, ...fileSystem };
  const lockPath = targetLockPath(targetPath);
  let descriptor;
  let ownsLock = false;
  let operationError;

  try {
    operations.mkdirSync(dirname(targetPath), { recursive: true });
    try {
      descriptor = operations.openSync(lockPath, 'wx', 0o600);
      ownsLock = true;
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error(`Instruction target is locked; refusing to remove unknown lock: ${lockPath}`);
      }
      throw error;
    }
    operations.writeFileSync(descriptor, `session-lessons pid=${process.pid}\n`, 'utf8');
    operations.fsyncSync(descriptor);
    operations.closeSync(descriptor);
    descriptor = undefined;
    return operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (descriptor !== undefined) {
      try {
        operations.closeSync(descriptor);
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (ownsLock) {
      try {
        operations.unlinkSync(lockPath);
      } catch (unlinkError) {
        cleanupErrors.push(unlinkError);
      }
    }
    if (cleanupErrors.length > 0) {
      const errors = operationError ? [operationError, ...cleanupErrors] : cleanupErrors;
      throw new AggregateError(errors, 'Instruction lock cleanup failed');
    }
  }
}

/**
 * Writes verified content through an exclusive same-directory file and atomic rename.
 *
 * @param {string} targetPath - Canonical destination path.
 * @param {string} content - Complete destination content.
 * @param {object} options - Atomic write options.
 * @param {number} [options.mode] - Existing target mode to preserve.
 * @param {Function} options.beforeRename - Concurrent-change gate run immediately before rename.
 * @param {object} [options.fileSystem] - Injectable file-operation overrides.
 */
function writeAtomicFile(targetPath, content, {
  mode,
  beforeRename,
  fileSystem = {},
}) {
  const operations = { ...ATOMIC_FILE_OPERATIONS, ...fileSystem };
  const directory = dirname(targetPath);
  const temporaryPath = join(
    directory,
    `.${basename(targetPath)}.session-lessons-${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  let ownsTemporaryPath = false;

  try {
    operations.mkdirSync(directory, { recursive: true });
    descriptor = operations.openSync(temporaryPath, 'wx', mode ?? 0o600);
    ownsTemporaryPath = true;
    operations.writeFileSync(descriptor, content, 'utf8');
    if (mode !== undefined && process.platform !== 'win32') {
      operations.fchmodSync(descriptor, mode);
    }
    operations.fsyncSync(descriptor);
    operations.closeSync(descriptor);
    descriptor = undefined;

    if (operations.readFileSync(temporaryPath, 'utf8') !== content) {
      throw new Error('Atomic instruction temp-file verification failed');
    }
    beforeRename();
    operations.renameSync(temporaryPath, targetPath);
    ownsTemporaryPath = false;
  } catch (error) {
    const cleanupErrors = [];
    if (descriptor !== undefined) {
      try {
        operations.closeSync(descriptor);
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (ownsTemporaryPath) {
      try {
        operations.unlinkSync(temporaryPath);
      } catch (unlinkError) {
        cleanupErrors.push(unlinkError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'Atomic instruction write and cleanup failed');
    }
    throw error;
  }
}

/**
 * Re-reads, writes, and verifies an explicitly approved target.
 *
 * @param {object} preflight - Snapshot from preflightTarget.
 * @param {string} nextContent - Fully rendered new file content.
 * @param {object} options - Write gates.
 * @param {boolean} options.approved - Explicit user approval.
 * @param {string} options.approvedDigest - Approved proposed-content digest.
 * @param {boolean} [options.allowDirty=false] - Whether the approved diff includes prior dirty state.
 * @param {object} [options.fileSystem] - Injectable atomic file-operation overrides.
 * @returns {object} Verified write result.
 */
export function writeVerifiedTarget(preflight, nextContent, {
  approved,
  approvedDigest,
  allowDirty = false,
  fileSystem = {},
}) {
  if (!approved) {
    throw new Error('Refusing to write without explicit approval');
  }
  if (!approvedDigest) {
    throw new Error('Refusing to write without an approved proposed-content digest');
  }
  const suppliedDigest = contentDigest(nextContent);
  if (approvedDigest !== suppliedDigest) {
    throw new Error('Approved proposed-content digest does not match supplied content');
  }
  if (preflight.managedMarker) {
    throw new Error(`Refusing to edit company-managed instructions: ${preflight.managedMarker}`);
  }
  if (preflight.dirtyState && !allowDirty) {
    throw new Error('Refusing to overwrite a dirty repository instruction file without approval');
  }

  return withTargetLock(preflight.resolvedPath, () => {
    const currentResolvedPath = resolveTargetPath(preflight.requestedPath);
    if (currentResolvedPath !== preflight.resolvedPath) {
      throw new Error('Instruction target changed after preview; rerun preflight');
    }
    const currentContent = existsSync(preflight.resolvedPath)
      ? readFileSync(preflight.resolvedPath, 'utf8')
      : '';
    if (contentDigest(currentContent) !== preflight.digest) {
      throw new Error('Instruction file changed after preview; rerun preflight');
    }

    writeAtomicFile(preflight.resolvedPath, nextContent, {
      mode: preflight.mode,
      fileSystem,
      beforeRename: () => {
        const latestResolvedPath = resolveTargetPath(preflight.requestedPath);
        const latestContent = existsSync(latestResolvedPath)
          ? readFileSync(latestResolvedPath, 'utf8')
          : '';
        if (latestResolvedPath !== preflight.resolvedPath
          || contentDigest(latestContent) !== preflight.digest) {
          throw new Error('Instruction file changed during atomic write; rerun preflight');
        }
      },
    });
    const verifiedContent = readFileSync(preflight.resolvedPath, 'utf8');
    if (verifiedContent !== nextContent) {
      throw new Error('Instruction write verification failed');
    }
    return {
      resolvedPath: preflight.resolvedPath,
      digest: contentDigest(verifiedContent),
    };
  });
}
