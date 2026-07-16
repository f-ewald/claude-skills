/**
 * ultracode review workflow template.
 *
 * Copy this file into a session workspace, set ULTRACODE_ENGINE to the installed
 * orchestrate.mjs path, edit CONFIG, and run it from the repository under review:
 *
 *   ULTRACODE_ENGINE="$HOME/.copilot/skills/ultracode/orchestrate.mjs" \
 *   ULTRACODE_CWD="$PWD" node ./session-workspace/review.mjs src/example.mjs
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Resolves the installed engine while allowing this workflow to live elsewhere.
 *
 * @returns {string} Importable engine file URL.
 * @throws {Error} If no engine can be found.
 */
function findEngineSpecifier() {
  const configured = process.env.ULTRACODE_ENGINE;
  const candidates = [
    configured,
    new URL('./orchestrate.mjs', import.meta.url),
    join(homedir(), '.copilot', 'skills', 'ultracode', 'orchestrate.mjs'),
    join(homedir(), '.agents', 'skills', 'ultracode', 'orchestrate.mjs'),
    join(homedir(), '.claude', 'skills', 'ultracode', 'orchestrate.mjs'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate instanceof URL) {
      if (candidate.protocol === 'file:' && existsSync(candidate)) {
        return candidate.href;
      }
      continue;
    }
    if (String(candidate).startsWith('file:')) {
      const url = new URL(candidate);
      if (existsSync(url)) {
        return url.href;
      }
      continue;
    }
    const path = isAbsolute(candidate) ? candidate : resolve(candidate);
    if (existsSync(path)) {
      return pathToFileURL(path).href;
    }
  }
  throw new Error('Cannot find orchestrate.mjs. Set ULTRACODE_ENGINE to its absolute path.');
}

const {
  agent,
  deterministicSort,
  log,
  map,
  phase,
  resolveTarget,
  run,
} = await import(findEngineSpecifier());

// ─── CONFIG ───────────────────────────────────────────────────────────────────────────
const WORKFLOW_CWD = resolve(process.env.ULTRACODE_CWD || process.cwd());
const TARGET = resolveTarget(process.argv[2] || 'path/to/file/under/review', WORKFLOW_CWD);
const THOROUGH = process.env.ULTRACODE_THOROUGH !== 'false';
const VERIFIER_VOTES = boundedInteger(
  process.env.ULTRACODE_VERIFIER_VOTES,
  THOROUGH ? 3 : 1,
  1,
  5,
);
const CRITIC_ROUNDS = boundedInteger(process.env.ULTRACODE_CRITIC_ROUNDS, THOROUGH ? 2 : 1, 0, 3);
const AGENT_OPTIONS = {
  cwd: WORKFLOW_CWD,
  profile: 'local-read',
  effect: 'read',
};

const DIMENSIONS = [
  {
    key: 'correctness',
    focus: 'logic bugs, wrong mappings, incorrect semantics, data-model mismatches',
  },
  {
    key: 'security',
    focus: 'secret handling, sensitive data in logs, injection, authorization, expiry correctness',
  },
  {
    key: 'robustness',
    focus: 'error handling, transaction safety, races, and resource or session cleanup',
  },
];

const FINDING_PROPERTIES = {
  title: { type: 'string' },
  severity: { type: 'string', enum: ['low', 'medium', 'high'] },
  location: { type: 'string' },
  explanation: { type: 'string' },
};

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: FINDING_PROPERTIES,
        required: ['title', 'severity', 'location', 'explanation'],
      },
    },
  },
  required: ['findings'],
};

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    complete: { type: 'boolean' },
    missing: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          dimension: { type: 'string' },
          ...FINDING_PROPERTIES,
        },
        required: ['dimension', 'title', 'severity', 'location', 'explanation'],
      },
    },
  },
  required: ['complete', 'missing'],
};

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    isReal: { type: 'boolean' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasoning: { type: 'string' },
  },
  required: ['isReal', 'confidence', 'reasoning'],
};

/**
 * Parses an integer environment knob within explicit bounds.
 *
 * @param {string|undefined} raw - Environment value.
 * @param {number} fallback - Default value.
 * @param {number} minimum - Minimum accepted value.
 * @param {number} maximum - Maximum accepted value.
 * @returns {number} Bounded integer.
 */
function boundedInteger(raw, fallback, minimum, maximum) {
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

/**
 * Builds a focused review prompt.
 *
 * @param {object} dimension - Review dimension.
 * @returns {string} Review prompt.
 */
function reviewPrompt(dimension) {
  return `Read ${TARGET} and review it only for ${dimension.key}: ${dimension.focus}. ` +
    'Report defensible issues only; return an empty findings array when none exist.';
}

/**
 * Builds an adversarial verification prompt.
 *
 * @param {object} finding - Finding under review.
 * @param {number} vote - Zero-based vote index.
 * @returns {string} Verification prompt.
 */
function verifyPrompt(finding, vote) {
  return `Act as independent skeptic ${vote + 1}/${VERIFIER_VOTES}. Try to refute this finding about ${TARGET}.
Dimension: ${finding.dimension}
Title: ${finding.title}
Location: ${finding.location}
Claim: ${finding.explanation}
Default isReal=false unless the local code unambiguously confirms a material issue.`;
}

/**
 * Builds a bounded completeness-critic prompt.
 *
 * @param {object[]} findings - Findings collected so far.
 * @returns {string} Critic prompt.
 */
function criticPrompt(findings) {
  return `Read ${TARGET} and critique the completeness of this review:
${JSON.stringify(findings, null, 2)}
Return only material findings missed by every listed dimension. Set complete=true and missing=[] when dry.`;
}

/**
 * Deduplicates and deterministically orders findings.
 *
 * @param {object[]} findings - Candidate findings.
 * @returns {object[]} Stable unique findings.
 */
function normalizeFindings(findings) {
  const unique = new Map();
  for (const finding of findings) {
    const key = [finding.dimension, finding.location, finding.title].join('\u0000');
    if (!unique.has(key)) {
      unique.set(key, finding);
    }
  }
  return deterministicSort([...unique.values()], ['dimension', 'location', 'title', 'severity']);
}

/**
 * Runs the configured verifier panel for one finding.
 *
 * @param {object} finding - Finding to verify.
 * @returns {Promise<object>} Finding, vote summary, and failure metadata.
 */
async function verifyFinding(finding) {
  const votes = await map(
    Array.from({ length: VERIFIER_VOTES }, (_, index) => index),
    (vote) => agent(verifyPrompt(finding, vote), {
      ...AGENT_OPTIONS,
      label: `verify:${finding.dimension}:${vote + 1}`,
      schema: VERDICT_SCHEMA,
    }),
  );
  const successful = votes.filter((vote) => vote.ok).map((vote) => vote.value);
  const confirmations = successful.filter((vote) => vote.isReal).length;
  const refutations = successful.filter((vote) => !vote.isReal).length;
  const required = Math.floor(VERIFIER_VOTES / 2) + 1;
  let status = 'inconclusive';
  if (confirmations >= required) {
    status = 'confirmed';
  } else if (refutations >= required) {
    status = 'refuted';
  }
  return {
    ...finding,
    status,
    verification: {
      confirmations,
      refutations,
      required,
      completedVotes: successful.length,
      requestedVotes: VERIFIER_VOTES,
      votes: successful,
      failures: votes.filter((vote) => !vote.ok),
    },
  };
}

run(async () => {
  phase('Review');
  const reviews = await map(DIMENSIONS, (dimension) => agent(reviewPrompt(dimension), {
    ...AGENT_OPTIONS,
    label: `review:${dimension.key}`,
    schema: FINDINGS_SCHEMA,
  }));
  let findings = [];
  const failures = {
    reviews: [],
    critics: [],
    verifications: [],
  };
  reviews.forEach((review, index) => {
    if (!review.ok) {
      failures.reviews.push({ dimension: DIMENSIONS[index].key, envelope: review });
      return;
    }
    findings.push(...review.value.findings.map((finding) => ({
      dimension: DIMENSIONS[index].key,
      ...finding,
    })));
  });
  findings = normalizeFindings(findings);

  phase('Completeness');
  for (let round = 0; round < CRITIC_ROUNDS; round += 1) {
    const critic = await agent(criticPrompt(findings), {
      ...AGENT_OPTIONS,
      label: `completeness:${round + 1}`,
      schema: CRITIC_SCHEMA,
    });
    if (!critic.ok) {
      failures.critics.push({ round: round + 1, envelope: critic });
      break;
    }
    const previousCount = findings.length;
    findings = normalizeFindings([...findings, ...critic.value.missing]);
    if (critic.value.complete || findings.length === previousCount) {
      break;
    }
  }

  phase('Adversarial verification');
  const verified = await map(findings, verifyFinding);
  for (const finding of verified) {
    if (finding.verification.failures.length > 0) {
      failures.verifications.push({
        dimension: finding.dimension,
        title: finding.title,
        failures: finding.verification.failures,
      });
    }
  }
  const ordered = normalizeFindings(verified);
  const confirmed = ordered.filter((finding) => finding.status === 'confirmed');
  const refuted = ordered.filter((finding) => finding.status === 'refuted');
  const inconclusive = ordered.filter((finding) => finding.status === 'inconclusive');
  log(
    `${findings.length} findings → ${confirmed.length} confirmed, ${refuted.length} refuted, ` +
    `${inconclusive.length} inconclusive`,
  );

  return {
    target: TARGET,
    cwd: WORKFLOW_CWD,
    profile: AGENT_OPTIONS.profile,
    thorough: THOROUGH,
    verifierVotes: VERIFIER_VOTES,
    criticRounds: CRITIC_ROUNDS,
    incomplete: Object.values(failures).some((entries) => entries.length > 0),
    failures,
    counts: {
      reviewedDimensions: DIMENSIONS.length,
      rawFindings: findings.length,
      confirmed: confirmed.length,
      refuted: refuted.length,
      inconclusive: inconclusive.length,
    },
    confirmed,
    refuted,
    inconclusive,
  };
});
