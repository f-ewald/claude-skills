/**
 * Deeper-research deterministic workflow template.
 *
 * Copy this file into a session workspace. Set ULTRACODE_ENGINE to the installed
 * ultracode/orchestrate.mjs, configure an explicit public URL allowlist when
 * needed, and run from the repository or workspace being researched.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ANGLE_CATALOG = [
  { key: 'technical', focus: 'mechanics, architecture, capabilities, constraints, and maturity' },
  { key: 'evidence', focus: 'authoritative evidence, measurements, dates, versions, and factual baseline' },
  { key: 'risks', focus: 'security, reliability, safety, compliance, failure modes, and uncertainty' },
  { key: 'adoption', focus: 'users, ecosystem, implementation evidence, and operational experience' },
  { key: 'economics', focus: 'cost, pricing, incentives, licensing, and total cost of ownership' },
  { key: 'alternatives', focus: 'competing approaches, trade-offs, substitution, and opportunity cost' },
  { key: 'governance', focus: 'policy, ownership, accountability, regulation, and decision rights' },
  { key: 'human', focus: 'usability, accessibility, workflows, organizational impact, and incentives' },
  { key: 'historical', focus: 'origins, prior attempts, evolution, and lessons from comparable changes' },
  { key: 'implementation', focus: 'migration path, dependencies, operations, rollout, and reversibility' },
  { key: 'counter', focus: 'strongest criticism, contrary evidence, and arguments against the consensus' },
  { key: 'future', focus: 'durability, likely changes, scenarios, and leading indicators' },
];

export const DEPTH_PRESETS = Object.freeze({
  quick: Object.freeze({
    angleCount: 3,
    verifierVotes: 1,
    completenessRounds: 1,
  }),
  standard: Object.freeze({
    angleCount: 6,
    verifierVotes: 2,
    completenessRounds: 2,
  }),
  exhaustive: Object.freeze({
    angleCount: 10,
    minimumAngles: 8,
    maximumAngles: 12,
    verifierVotes: 3,
    completenessRounds: 3,
  }),
});

const FINDING_PROPERTIES = {
  claim: { type: 'string' },
  evidence: { type: 'string' },
  sources: { type: 'array', minItems: 1, items: { type: 'string' } },
  loadBearing: { type: 'boolean' },
  confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  checkedScope: { type: 'string' },
  sourceLimitations: { type: 'string' },
  negativeFinding: { type: 'boolean' },
  negativeFindingScope: { type: 'string' },
};
const MAX_PUBLIC_SOURCES_PER_FINDING = 32;
const MAX_PUBLIC_SOURCE_LENGTH = 2048;
const MINIMUM_VERIFIED_EVIDENCE = 2;

export const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: FINDING_PROPERTIES,
        required: Object.keys(FINDING_PROPERTIES),
      },
    },
  },
  required: ['findings'],
};

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    complete: { type: 'boolean' },
    newAngles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          focus: { type: 'string' },
          rationale: { type: 'string' },
          suggestedSourceScope: { type: 'string', enum: ['public', 'internal'] },
        },
        required: ['key', 'focus', 'rationale', 'suggestedSourceScope'],
      },
    },
    newFindings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          angle: { type: 'string' },
          ...FINDING_PROPERTIES,
        },
        required: ['angle', ...Object.keys(FINDING_PROPERTIES)],
      },
    },
    remainingGaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['complete', 'newAngles', 'newFindings', 'remainingGaps'],
};

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['verified', 'refuted', 'unconfirmed'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasoning: { type: 'string' },
    checkedScope: { type: 'string' },
    sourceLimitations: { type: 'string' },
    bestSource: { type: 'string' },
  },
  required: [
    'status',
    'confidence',
    'reasoning',
    'checkedScope',
    'sourceLimitations',
    'bestSource',
  ],
};

const SYNTHESIS_SCHEMA = {
  type: 'object',
  properties: {
    thesis: { type: 'string' },
    summary: { type: 'string' },
    analysis: { type: 'string' },
    recommendation: { type: 'string' },
    evidenceLimits: { type: 'array', minItems: 1, items: { type: 'string' } },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: [
    'thesis',
    'summary',
    'analysis',
    'recommendation',
    'evidenceLimits',
    'confidence',
  ],
};

const RED_TEAM_SCHEMA = {
  type: 'object',
  properties: {
    counterThesis: { type: 'string' },
    reasoning: { type: 'string' },
    weakPoints: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          point: { type: 'string' },
          target: { type: 'string' },
          whyItMatters: { type: 'string' },
        },
        required: ['point', 'target', 'whyItMatters'],
      },
    },
    flipsIfWrong: { type: 'array', minItems: 1, items: { type: 'string' } },
    verdict: { type: 'string', enum: ['survives', 'qualify', 'overturn'] },
    residualDoubts: { type: 'string' },
  },
  required: [
    'counterThesis',
    'reasoning',
    'weakPoints',
    'flipsIfWrong',
    'verdict',
    'residualDoubts',
  ],
};

/**
 * Returns the deterministic controls for one research depth.
 *
 * @param {string} depth - quick, standard, or exhaustive.
 * @param {number} [exhaustiveAngleCount=10] - Exhaustive fan-out, bounded to 8-12.
 * @returns {object} Depth configuration.
 * @throws {Error} If the depth is unknown.
 */
export function selectDepthPreset(depth, exhaustiveAngleCount = 10) {
  if (!Object.hasOwn(DEPTH_PRESETS, depth)) {
    throw new Error(`Unknown research depth "${depth}"; use quick, standard, or exhaustive.`);
  }
  const preset = DEPTH_PRESETS[depth];
  if (depth !== 'exhaustive') {
    return { depth, ...preset };
  }
  const angleCount = Math.min(
    preset.maximumAngles,
    Math.max(preset.minimumAngles, exhaustiveAngleCount),
  );
  return { depth, ...preset, angleCount };
}

/**
 * Resolves the one shared ultracode engine from explicit or standard locations.
 *
 * @param {object} [options] - Resolver overrides used by tests or embedded workflows.
 * @returns {string} Importable file URL.
 * @throws {Error} If no engine exists.
 */
export function findEngineSpecifier(options = {}) {
  const home = options.home || homedir();
  const candidates = [
    options.configured ?? process.env.ULTRACODE_ENGINE,
    join(home, '.copilot', 'skills', 'ultracode', 'orchestrate.mjs'),
    join(home, '.agents', 'skills', 'ultracode', 'orchestrate.mjs'),
    join(home, '.claude', 'skills', 'ultracode', 'orchestrate.mjs'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const specifier = engineCandidateSpecifier(candidate);
    if (specifier && existsSync(new URL(specifier))) {
      return specifier;
    }
  }
  throw new Error(
    'Cannot find the shared ultracode engine. Set ULTRACODE_ENGINE to orchestrate.mjs.',
  );
}

/**
 * Converts one engine candidate to a file URL.
 *
 * @param {string|URL} candidate - Candidate path or URL.
 * @returns {string|null} File URL or null for unsupported protocols.
 */
function engineCandidateSpecifier(candidate) {
  if (candidate instanceof URL || String(candidate).startsWith('file:')) {
    const url = candidate instanceof URL ? candidate : new URL(String(candidate));
    return url.protocol === 'file:' ? url.href : null;
  }
  const path = isAbsolute(String(candidate)) ? String(candidate) : resolve(String(candidate));
  return pathToFileURL(path).href;
}

/**
 * Parses the optional heterogeneous model pool.
 *
 * @param {string} spec - Comma-separated family:tier:model entries.
 * @returns {object[]} Valid model descriptors.
 */
export function parseModels(spec) {
  return String(spec || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [family, tier, ...modelParts] = entry.split(':');
      return {
        family: family.trim(),
        tier: tier.trim(),
        id: modelParts.join(':').trim(),
      };
    })
    .filter((model) => model.family && model.id && ['cheap', 'strong'].includes(model.tier));
}

/**
 * Selects a model by tier while rotating families and avoiding one when possible.
 *
 * @param {object[]} models - Available models.
 * @param {string} tier - cheap or strong.
 * @param {number} index - Stable rotation index.
 * @param {string} [avoidFamily] - Family to avoid when alternatives exist.
 * @returns {object|undefined} Selected descriptor or engine default.
 */
export function pickModel(models, tier, index, avoidFamily) {
  if (models.length === 0) {
    return undefined;
  }
  const tierModels = models.filter((model) => model.tier === tier);
  let pool = tierModels.length > 0 ? tierModels : models;
  if (avoidFamily && new Set(pool.map((model) => model.family)).size > 1) {
    pool = pool.filter((model) => model.family !== avoidFamily);
  }
  const families = [...new Set(pool.map((model) => model.family))].sort();
  const family = families[index % families.length];
  const familyModels = pool.filter((model) => model.family === family);
  return familyModels[index % familyModels.length];
}

/**
 * Aggregates verifier envelopes without counting failed calls as refutations.
 *
 * @param {object[]} envelopes - Verifier result envelopes.
 * @param {number} requestedVotes - Configured vote count.
 * @returns {object} Quorum status and visible failures.
 */
export function aggregateVerification(envelopes, requestedVotes) {
  const successful = envelopes.filter((envelope) => envelope.ok).map((envelope) => envelope.value);
  const failures = envelopes.filter((envelope) => !envelope.ok);
  const quorum = Math.floor(requestedVotes / 2) + 1;
  const verifiedVotes = successful.filter((vote) => vote.status === 'verified').length;
  const refutedVotes = successful.filter((vote) => vote.status === 'refuted').length;
  let status = 'unconfirmed';
  if (verifiedVotes >= quorum) {
    status = 'verified';
  } else if (refutedVotes >= quorum) {
    status = 'refuted';
  }
  return {
    status,
    requestedVotes,
    completedVotes: successful.length,
    quorum,
    verifiedVotes,
    refutedVotes,
    unconfirmedVotes: successful.filter((vote) => vote.status === 'unconfirmed').length,
    votes: successful,
    failures,
  };
}

/**
 * Builds the persisted question tree and assumptions ledger.
 *
 * @param {string} topic - Research topic.
 * @returns {object[]} Auto-answered defaults.
 */
function buildQuestionTree(topic) {
  return [
    {
      id: 'scope',
      parentId: null,
      question: 'What scope should the research cover?',
      assumption: `Cover evidence directly material to "${topic}" and exclude tangential history.`,
      rationale: 'A bounded decision scope preserves depth without unrelated expansion.',
      confidence: 'medium',
      status: 'auto-answered',
    },
    {
      id: 'timeframe',
      parentId: 'scope',
      question: 'What timeframe should sources use?',
      assumption: 'Prefer current sources and include older sources only when they remain authoritative.',
      rationale: 'Fresh evidence matters, while primary historical records can still be load-bearing.',
      confidence: 'high',
      status: 'auto-answered',
    },
    {
      id: 'audience',
      parentId: 'scope',
      question: 'Who is the default audience?',
      assumption: 'Write for a technically informed decision-maker who needs evidence and caveats.',
      rationale: 'This supports both actionable synthesis and transparent source limitations.',
      confidence: 'medium',
      status: 'auto-answered',
    },
    {
      id: 'success',
      parentId: 'scope',
      question: 'What counts as a successful answer?',
      assumption: 'A conclusion is useful only when load-bearing claims reach verifier quorum.',
      rationale: 'Unconfirmed evidence must remain distinct from verified or refuted evidence.',
      confidence: 'high',
      status: 'auto-answered',
    },
  ];
}

/**
 * Parses a bounded comma-separated list.
 *
 * @param {string|undefined} value - Environment value.
 * @returns {string[]} Unique entries.
 */
function parseList(value) {
  return [...new Set(String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean))];
}

/**
 * Canonicalizes and validates configured internal angle keys.
 *
 * @param {string|undefined} value - Comma-separated angle keys.
 * @param {object} preset - Selected depth preset.
 * @returns {{keys: string[], errors: string[]}} Canonical keys and all configuration errors.
 */
function parseInternalAngleConfiguration(value, preset) {
  const rawKeys = String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const canonicalKeys = rawKeys.map((key) => key.toLowerCase());
  const catalogKeys = new Set(ANGLE_CATALOG.map((angle) => angle.key));
  const selectedKeys = new Set(ANGLE_CATALOG.slice(0, preset.angleCount).map((angle) => angle.key));
  const counts = new Map();
  for (const key of canonicalKeys) {
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const errors = [];
  for (const [key, count] of counts) {
    if (count > 1) {
      errors.push(`duplicate internal angle "${key}"`);
    }
    if (!catalogKeys.has(key)) {
      errors.push(`unknown internal angle "${key}"`);
    } else if (!selectedKeys.has(key)) {
      errors.push(`internal angle "${key}" is not selected by the ${preset.depth} preset`);
    }
  }
  return {
    keys: [...counts.keys()],
    errors,
  };
}

/**
 * Reads an integer with a deterministic fallback.
 *
 * @param {string|undefined} value - Environment value.
 * @param {number} fallback - Default.
 * @returns {number} Parsed value.
 */
function integer(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Creates the selected angle list and assigns isolated source scopes.
 *
 * @param {object} preset - Selected depth preset.
 * @param {string} sensitivity - public or internal.
 * @param {string[]} internalAngles - Explicit internal-only angle keys.
 * @returns {object[]} Selected angles.
 */
function selectAngles(preset, sensitivity, internalAngles) {
  const internal = new Set(internalAngles);
  return ANGLE_CATALOG.slice(0, preset.angleCount).map((angle) => ({
    ...angle,
    sourceScope: sensitivity === 'internal' || internal.has(angle.key) ? 'internal' : 'public',
  }));
}

/**
 * Validates workflow safety before any subagent is launched.
 *
 * @param {object} config - Effective workflow configuration.
 * @param {object} engine - Shared ultracode engine.
 * @returns {void}
 * @throws {Error} If the workflow would violate its source or workspace contract.
 */
function preflight(config, engine) {
  if (Number.parseInt(process.versions.node.split('.')[0], 10) < 18) {
    throw new Error('deeper-research requires Node.js 18 or newer.');
  }
  if (!existsSync(config.cwd) || !statSync(config.cwd).isDirectory()) {
    throw new Error(`Research working directory does not exist: ${config.cwd}`);
  }
  if (!['public', 'internal'].includes(config.sensitivity)) {
    throw new Error('DEEPER_RESEARCH_SENSITIVITY must be public or internal.');
  }
  if (!['heterogeneous', 'single'].includes(config.modelPolicy)) {
    throw new Error('DEEPER_RESEARCH_MODEL_POLICY must be heterogeneous or single.');
  }
  if (!['standalone', 'embedded'].includes(config.mode)) {
    throw new Error('DEEPER_RESEARCH_MODE must be standalone or embedded.');
  }
  if (config.internalAngleConfiguration.errors.length > 0) {
    throw new Error(
      `Invalid DEEPER_RESEARCH_INTERNAL_ANGLES: ` +
      config.internalAngleConfiguration.errors.join('; '),
    );
  }
  const publicAngles = config.angles.filter((angle) => angle.sourceScope === 'public');
  if (config.cli === 'claude' && publicAngles.length > 0) {
    throw new Error(
      'Deterministic public Claude research is unsupported because the ultracode Claude adapter ' +
      'cannot enforce URL allowlists. Use native Claude Workflow/runtime permissions or the ' +
      'Copilot deterministic engine. Internal/local-only Claude deterministic runs remain allowed.',
    );
  }
  if (config.sensitivity === 'internal' && publicAngles.length > 0) {
    throw new Error('Internal/private research must not dispatch public-web agents.');
  }
  if (config.cli === 'copilot' && publicAngles.length > 0) {
    requirePublicEngineIsolation(engine);
  }
  if (publicAngles.length > 0 && config.allowedUrls.length === 0) {
    throw new Error(
      'Public research requires ULTRACODE_ALLOWED_URLS with explicit bounded URLs or domains.',
    );
  }
  if (config.allowedUrls.includes('*')) {
    throw new Error('Public research must never grant all URLs.');
  }
  if (config.blockingQuestions.some((question) => question.status !== 'resolved')) {
    throw new Error('Resolve genuinely blocking start-checkpoint questions before fan-out.');
  }
}

/**
 * Requires an engine that disables Copilot's automatic system-temp access.
 *
 * @param {object} engine - Shared ultracode engine.
 * @returns {void}
 * @throws {Error} If the engine cannot enforce the public read boundary.
 */
export function requirePublicEngineIsolation(engine) {
  if (engine.ENGINE_CAPABILITIES?.copilotReadDisallowTempDir === true) {
    return;
  }
  throw new Error(
    'Public Copilot research requires an ultracode engine that enforces ' +
    '--disallow-temp-dir for read profiles. Upgrade ultracode before running public research.',
  );
}

/**
 * Tests whether a path is equal to or nested under a parent path.
 *
 * @param {string} candidate - Candidate absolute path.
 * @param {string} parent - Parent absolute path.
 * @returns {boolean} Whether the candidate is within the parent.
 */
function isWithin(candidate, parent) {
  const path = relative(resolve(parent), resolve(candidate));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/**
 * Creates an empty public-agent workspace outside the internal working tree.
 *
 * @param {object} config - Workflow configuration.
 * @returns {string|null} Generated public cwd, or null for internal-only runs.
 * @throws {Error} If isolation cannot be established.
 */
function createPublicWorkspace(config) {
  if (!config.angles.some((angle) => angle.sourceScope === 'public')) {
    return null;
  }
  let publicCwd;
  try {
    publicCwd = mkdtempSync(join(homedir(), '.deeper-research-public-'));
    if (isWithin(publicCwd, config.cwd) || readdirSync(publicCwd).length !== 0) {
      throw new Error('generated public workspace was not empty and isolated');
    }
    return publicCwd;
  } catch (error) {
    const expectedPrefix = join(homedir(), '.deeper-research-public-');
    if (publicCwd?.startsWith(expectedPrefix) && existsSync(publicCwd)) {
      rmSync(publicCwd, { recursive: true, force: true });
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot establish an isolated public research cwd: ${message}`);
  }
}

/**
 * Removes exactly the generated public-agent workspace.
 *
 * @param {object} config - Workflow configuration.
 * @returns {void}
 */
function cleanupPublicWorkspace(config) {
  if (!config.publicCwd) {
    return;
  }
  const expectedPrefix = join(homedir(), '.deeper-research-public-');
  if (!config.publicCwd.startsWith(expectedPrefix) || isWithin(config.publicCwd, config.cwd)) {
    throw new Error('Refusing to remove an unrecognized public research workspace.');
  }
  rmSync(config.publicCwd, { recursive: true, force: true });
}

/**
 * Returns read-only engine options for one isolated source scope.
 *
 * @param {object} config - Workflow configuration.
 * @param {string} sourceScope - public or internal.
 * @param {object|undefined} model - Selected model.
 * @returns {object} Safe agent options.
 */
function readOptions(config, sourceScope, model) {
  const cwd = sourceScope === 'public' ? config.publicCwd : config.cwd;
  if (!cwd) {
    throw new Error(`No isolated cwd is available for ${sourceScope} research.`);
  }
  const options = {
    cwd,
    profile: sourceScope === 'public' ? 'research-read' : 'local-read',
    effect: 'read',
    model: model?.id,
  };
  if (sourceScope === 'public') {
    options.allowedUrls = config.allowedUrls;
  }
  return options;
}

/**
 * Returns local-read options for synthesis and red-team reasoning.
 *
 * @param {object} config - Workflow configuration.
 * @param {boolean} containsInternal - Whether any prompt payload is internal.
 * @param {object|undefined} model - Selected model.
 * @returns {object} Local-only reasoning options.
 */
function localReasoningOptions(config, containsInternal, model) {
  const cwd = containsInternal ? config.cwd : config.publicCwd;
  if (!cwd) {
    throw new Error('No safe local cwd is available for synthesis or red-team reasoning.');
  }
  return {
    cwd,
    profile: 'local-read',
    effect: 'read',
    model: model?.id,
  };
}

/**
 * Builds a source-isolated researcher prompt.
 *
 * @param {object} config - Workflow configuration.
 * @param {object} angle - Research angle.
 * @returns {string} Contracted research instructions.
 */
function researchPrompt(config, angle) {
  const sourceRules = angle.sourceScope === 'public'
    ? 'Use only allowlisted web_fetch for public, non-sensitive material. Do not use web search.'
    : 'Use only already configured approved internal/local read-only sources. Never use public web tools.';
  return `ROLE: researcher
Topic: ${config.topic}
Angle: ${angle.key}
Focus: ${angle.focus}
Source scope: ${angle.sourceScope}

${sourceRules}
Do not probe speculative tool names or request broader permissions. Never send internal/private
content to a public tool. Prefer authoritative primary sources and resolve exact versions, dates,
prices, configuration, or commits instead of inferring them. Every finding must have at least one
source URL or stable source URI. Preserve checked scope, confidence, source limitations, and the
exact scope of every negative finding. Set loadBearing explicitly. Return no finding without a source.`;
}

/**
 * Builds a completeness critic prompt.
 *
 * @param {object} config - Workflow configuration.
 * @param {object[]} findings - Findings collected so far.
 * @param {number} round - One-based round.
 * @returns {string} Critic prompt.
 */
function criticPrompt(config, findings, round) {
  const publicRule = config.angles.every((angle) => angle.sourceScope === 'public')
    ? 'Public access is allowlisted web_fetch only; web search is unavailable.'
    : 'Use only the internal/local read-only scope provided for this critic.';
  return `ROLE: completeness critic
Completeness round ${round}/${config.preset.completenessRounds} for: ${config.topic}
Selected angles: ${config.angles.map((angle) => angle.key).join(', ')}
Current findings:
${JSON.stringify(findings, null, 2)}

Identify genuinely missing angles and sourced findings. Deduplicate against the supplied material.
Use only the source scope available to you. Do not speculate, probe tool names, or move private
content to public tools. For each new angle, suggestedSourceScope is only a follow-up recommendation,
not provenance. ${publicRule} Set complete=true only when no material gap remains.`;
}

/**
 * Builds one adversarial verification prompt.
 *
 * @param {object} config - Workflow configuration.
 * @param {object} finding - Load-bearing finding.
 * @param {number} vote - Zero-based vote.
 * @returns {string} Verification prompt.
 */
function verificationPrompt(config, finding, vote) {
  const sourceRule = finding.sourceScope === 'public'
    ? 'Use allowlisted web_fetch only; web search is unavailable.'
    : 'Use only approved internal/local read-only sources.';
  return `ROLE: verifier ${vote + 1}/${config.preset.verifierVotes}
Topic: ${config.topic}
Claim: ${finding.claim}
Evidence: ${finding.evidence}
Sources: ${finding.sources.join(', ')}
Checked scope: ${finding.checkedScope}
Source limitations: ${finding.sourceLimitations}

Try to refute the claim from authoritative sources. Return verified only if the exact claim is
established, refuted only if evidence contradicts it, and unconfirmed otherwise. Failed access or
missing evidence is unconfirmed, never refuted. ${sourceRule} Preserve the exact checked scope and
limitations.`;
}

/**
 * Builds a strong-model synthesis prompt.
 *
 * @param {object} config - Workflow configuration.
 * @param {object[]} verified - Quorum-verified findings.
 * @param {object[]} refuted - Quorum-refuted findings.
 * @param {object[]} unconfirmed - Findings without quorum.
 * @param {object} evidenceContext - Coverage, completeness, and failure context.
 * @returns {string} Synthesis prompt.
 */
function synthesisPrompt(config, verified, refuted, unconfirmed, evidenceContext) {
  return `ROLE: synthesis
Topic: ${config.topic}
Verified findings: ${JSON.stringify(verified, null, 2)}
Refuted findings: ${JSON.stringify(refuted, null, 2)}
Unconfirmed findings: ${JSON.stringify(unconfirmed, null, 2)}
Non-load-bearing accepted findings: ${JSON.stringify(
    evidenceContext.nonLoadBearingFindings,
    null,
    2,
  )}
Coverage and completeness metadata: ${JSON.stringify(evidenceContext.coverage, null, 2)}
Completeness details: ${JSON.stringify(evidenceContext.completeness, null, 2)}
Researcher failures: ${JSON.stringify(evidenceContext.researcherFailures, null, 2)}
Finding validation failures: ${JSON.stringify(evidenceContext.findingValidationFailures, null, 2)}

Form the narrowest defensible thesis from verified evidence. Keep refuted and unconfirmed evidence
distinct, preserve source limitations, and do not imply complete coverage when failures or gaps
exist. Return a nonblank thesis, summary, analysis, recommendation, and at least one evidence limit.`;
}

/**
 * Builds the gated whole-thesis red-team prompt.
 *
 * @param {object} config - Workflow configuration.
 * @param {object} synthesis - Successful synthesis.
 * @param {object[]} verified - Verified findings.
 * @param {object[]} refuted - Refuted findings.
 * @param {object[]} unconfirmed - Unconfirmed findings.
 * @param {object} evidenceContext - Coverage, completeness, and failure context.
 * @returns {string} Red-team prompt.
 */
function redTeamPrompt(config, synthesis, verified, refuted, unconfirmed, evidenceContext) {
  return `ROLE: whole-thesis red team
Topic: ${config.topic}
Thesis: ${synthesis.thesis}
Verified evidence: ${JSON.stringify(verified, null, 2)}
Refuted evidence: ${JSON.stringify(refuted, null, 2)}
Unconfirmed evidence: ${JSON.stringify(unconfirmed, null, 2)}
Non-load-bearing accepted evidence: ${JSON.stringify(
    evidenceContext.nonLoadBearingFindings,
    null,
    2,
  )}
Evidence limits: ${JSON.stringify(synthesis.evidenceLimits)}
Coverage and completeness metadata: ${JSON.stringify(evidenceContext.coverage, null, 2)}
Completeness details: ${JSON.stringify(evidenceContext.completeness, null, 2)}
Researcher failures: ${JSON.stringify(evidenceContext.researcherFailures, null, 2)}
Finding validation failures: ${JSON.stringify(evidenceContext.findingValidationFailures, null, 2)}

Assume the thesis is false and present the strongest good-faith counter-case. Attack reasoning,
selection bias, scope, alternatives, and dependence on load-bearing claims. Return survives,
qualify, or overturn without manufacturing doubt. Include nonblank reasoning, at least one fully
explained weak point, at least one claim that would flip the conclusion, and residual doubts.`;
}

/**
 * Tests whether one configured grant covers a public source URL.
 *
 * @param {URL} source - Parsed public source.
 * @param {string} grant - Configured URL or domain grant.
 * @returns {boolean} Whether the source is covered.
 */
function grantCoversSource(source, grant) {
  if (/^https?:\/\//i.test(grant)) {
    let granted;
    try {
      granted = new URL(grant);
    } catch {
      return false;
    }
    if (granted.username || granted.password || granted.origin !== source.origin) {
      return false;
    }
    const basePath = granted.pathname.endsWith('/')
      ? granted.pathname
      : `${granted.pathname}/`;
    return source.pathname === granted.pathname || source.pathname.startsWith(basePath);
  }
  const wildcard = grant.startsWith('*.');
  const hostPort = wildcard ? grant.slice(2) : grant;
  const separator = hostPort.lastIndexOf(':');
  const hasPort = separator > -1 && /^\d+$/.test(hostPort.slice(separator + 1));
  const hostname = (hasPort ? hostPort.slice(0, separator) : hostPort).toLowerCase();
  const port = hasPort ? hostPort.slice(separator + 1) : '';
  const hostnameMatches = wildcard
    ? source.hostname.toLowerCase().endsWith(`.${hostname}`)
    : source.hostname.toLowerCase() === hostname;
  return source.protocol === 'https:' && hostnameMatches && (!port || source.port === port);
}

/**
 * Semantically validates one normalized source identifier.
 *
 * @param {string} source - Normalized source.
 * @param {string} sourceScope - public or internal.
 * @param {string[]} allowedUrls - Configured public grants.
 * @returns {string[]} Validation errors.
 */
function sourceValidationErrors(source, sourceScope, allowedUrls) {
  if (!source) {
    return ['source identifier must be nonblank'];
  }
  if (sourceScope !== 'public') {
    return [];
  }
  if (source.length > MAX_PUBLIC_SOURCE_LENGTH) {
    return [`public source exceeds ${MAX_PUBLIC_SOURCE_LENGTH} characters`];
  }
  let url;
  try {
    url = new URL(source);
  } catch {
    return ['public source must be an absolute HTTP(S) URL'];
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return ['public source must be credential-free HTTP(S)'];
  }
  if (!allowedUrls.some((grant) => grantCoversSource(url, grant))) {
    return ['public source is outside ULTRACODE_ALLOWED_URLS'];
  }
  return [];
}

/**
 * Converts a schema-valid but semantically invalid result into a visible failure.
 *
 * @param {object} envelope - Successful structured envelope.
 * @param {string[]} errors - Semantic validation errors.
 * @returns {object} Failed semantic-validation envelope.
 */
function semanticFailureEnvelope(envelope, errors) {
  return {
    ok: false,
    error: {
      kind: 'semantic_validation',
      message: errors.join('; '),
      retryable: false,
      incompleteCount: 0,
    },
    attempts: envelope.attempts,
    meta: {
      ...(envelope.meta || {}),
      semanticErrors: errors,
      invalidValue: envelope.value,
    },
  };
}

/**
 * Converts a semantically invalid successful verifier vote into a visible failure.
 *
 * @param {object} envelope - Structured verifier envelope.
 * @param {object} finding - Finding being verified.
 * @param {string[]} allowedUrls - Configured public grants.
 * @returns {object} Original envelope or semantic failure envelope.
 */
function validateVerifierEnvelope(envelope, finding, allowedUrls) {
  if (!envelope.ok) {
    return envelope;
  }
  const vote = envelope.value;
  const errors = [];
  for (const field of ['reasoning', 'checkedScope', 'sourceLimitations', 'bestSource']) {
    if (!vote[field].trim()) {
      errors.push(`${field} must be nonblank`);
    }
  }
  const bestSource = vote.bestSource.trim();
  if (bestSource) {
    errors.push(...sourceValidationErrors(bestSource, finding.sourceScope, allowedUrls));
  }
  if (errors.length === 0) {
    return {
      ...envelope,
      value: { ...vote, bestSource },
    };
  }
  return semanticFailureEnvelope(envelope, errors);
}

/**
 * Trims and semantically validates a successful synthesis envelope.
 *
 * @param {object} envelope - Structured synthesis envelope.
 * @returns {object} Normalized success or visible semantic failure.
 */
function validateSynthesisEnvelope(envelope) {
  if (!envelope.ok) {
    return envelope;
  }
  const value = envelope.value;
  const normalized = {
    ...value,
    thesis: value.thesis.trim(),
    summary: value.summary.trim(),
    analysis: value.analysis.trim(),
    recommendation: value.recommendation.trim(),
    evidenceLimits: value.evidenceLimits.map((limit) => limit.trim()),
  };
  const errors = [];
  for (const field of ['thesis', 'summary', 'analysis', 'recommendation']) {
    if (!normalized[field]) {
      errors.push(`${field} must be nonblank`);
    }
  }
  normalized.evidenceLimits.forEach((limit, index) => {
    if (!limit) {
      errors.push(`evidenceLimits[${index}] must be nonblank`);
    }
  });
  return errors.length === 0
    ? { ...envelope, value: normalized }
    : semanticFailureEnvelope(envelope, errors);
}

/**
 * Trims and semantically validates a successful whole-thesis red-team envelope.
 *
 * @param {object} envelope - Structured red-team envelope.
 * @returns {object} Normalized success or visible semantic failure.
 */
function validateRedTeamEnvelope(envelope) {
  if (!envelope.ok) {
    return envelope;
  }
  const value = envelope.value;
  const weakPoints = value.weakPoints.map((weakPoint) => ({
    point: weakPoint.point.trim(),
    target: weakPoint.target.trim(),
    whyItMatters: weakPoint.whyItMatters.trim(),
  }));
  const normalized = {
    ...value,
    counterThesis: value.counterThesis.trim(),
    reasoning: value.reasoning.trim(),
    weakPoints,
    flipsIfWrong: value.flipsIfWrong.map((claim) => claim.trim()),
    residualDoubts: value.residualDoubts.trim(),
  };
  const errors = [];
  for (const field of ['counterThesis', 'reasoning', 'residualDoubts']) {
    if (!normalized[field]) {
      errors.push(`${field} must be nonblank`);
    }
  }
  weakPoints.forEach((weakPoint, index) => {
    for (const field of ['point', 'target', 'whyItMatters']) {
      if (!weakPoint[field]) {
        errors.push(`weakPoints[${index}].${field} must be nonblank`);
      }
    }
  });
  normalized.flipsIfWrong.forEach((claim, index) => {
    if (!claim) {
      errors.push(`flipsIfWrong[${index}] must be nonblank`);
    }
  });
  return errors.length === 0
    ? { ...envelope, value: normalized }
    : semanticFailureEnvelope(envelope, errors);
}

/**
 * Deduplicates and deterministically orders findings.
 *
 * @param {object[]} findings - Candidate findings.
 * @param {Function} deterministicSort - Shared engine sorter.
 * @param {string[]} allowedUrls - Configured public URL/domain grants.
 * @returns {{findings: object[], failures: object[]}} Valid findings and semantic failures.
 */
function normalizeFindings(findings, deterministicSort, allowedUrls) {
  const unique = new Map();
  const failures = [];
  for (const finding of findings) {
    const claim = finding.claim.trim();
    const evidence = finding.evidence.trim();
    const checkedScope = finding.checkedScope.trim();
    const sourceLimitations = finding.sourceLimitations.trim();
    const sources = [...new Set(finding.sources.map((source) => source.trim()).filter(Boolean))].sort();
    const negativeFindingScope = finding.negativeFindingScope.trim();
    const errors = [];
    for (const [field, value] of Object.entries({
      claim,
      evidence,
      checkedScope,
      sourceLimitations,
    })) {
      if (!value) {
        errors.push(`${field} must be nonblank`);
      }
    }
    if (sources.length === 0) {
      errors.push('finding has no nonblank source URL or URI');
    }
    if (finding.sourceScope === 'public' && sources.length > MAX_PUBLIC_SOURCES_PER_FINDING) {
      errors.push(`public finding exceeds ${MAX_PUBLIC_SOURCES_PER_FINDING} sources`);
    }
    for (const source of sources) {
      errors.push(...sourceValidationErrors(source, finding.sourceScope, allowedUrls));
    }
    if (finding.negativeFinding && !negativeFindingScope) {
      errors.push('negative findings require a nonblank negativeFindingScope');
    }
    const normalized = {
      ...finding,
      claim,
      evidence,
      checkedScope,
      sourceLimitations,
      sources,
      negativeFindingScope,
    };
    if (errors.length > 0) {
      failures.push({
        stage: finding.findingStage || 'unknown',
        round: finding.findingRound || 0,
        angle: finding.angle,
        sourceScope: finding.sourceScope,
        claim,
        errors,
        finding: normalized,
      });
      continue;
    }
    const key = [finding.angle, claim, sources.join('|')].join('\u0000').toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, normalized);
    }
  }
  return {
    findings: deterministicSort([...unique.values()], ['angle', 'claim', 'evidence']),
    failures: deterministicSort(failures, ['stage', 'round', 'angle', 'claim']),
  };
}

/**
 * Deduplicates critic-suggested angles.
 *
 * @param {object[]} angles - Suggested angles.
 * @param {Function} deterministicSort - Shared engine sorter.
 * @returns {object[]} Stable unique angles.
 */
function normalizeAngles(angles, deterministicSort) {
  const unique = new Map();
  for (const angle of angles) {
    const key = angle.key.trim().toLowerCase();
    if (key && !unique.has(key)) {
      unique.set(key, { ...angle, key });
    }
  }
  return deterministicSort([...unique.values()], ['key', 'focus']);
}

/**
 * Returns the dominant model family for cross-family selection.
 *
 * @param {object[]} findings - Findings with researchFamily metadata.
 * @returns {string|undefined} Dominant family.
 */
function dominantFamily(findings) {
  const counts = new Map();
  for (const finding of findings) {
    if (finding.researchFamily) {
      counts.set(finding.researchFamily, (counts.get(finding.researchFamily) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => {
    return right[1] - left[1] || left[0].localeCompare(right[0], 'en');
  })[0]?.[0];
}

/**
 * Explains why the evidence base cannot support a complete conclusion.
 *
 * @param {object[]} findings - Accepted findings.
 * @param {object[]} verified - Quorum-verified findings.
 * @returns {string} Inconclusive reason, or an empty string when sufficient.
 */
function evidenceDeficitReason(findings, verified) {
  if (findings.length === 0) {
    return 'No accepted findings remained after source and semantic validation.';
  }
  if (verified.length < MINIMUM_VERIFIED_EVIDENCE) {
    return `Insufficient verified evidence: ${verified.length}/${MINIMUM_VERIFIED_EVIDENCE} ` +
      'load-bearing claims reached quorum.';
  }
  return '';
}

/**
 * Creates a deduplicated source register with preserved scope metadata.
 *
 * @param {object[]} findings - All findings.
 * @param {Function} deterministicSort - Shared engine sorter.
 * @returns {object[]} Source register.
 */
function buildSourceRegister(findings, deterministicSort) {
  const sources = [];
  for (const finding of findings) {
    for (const url of finding.sources) {
      sources.push({
        url,
        angle: finding.angle,
        confidence: finding.confidence,
        checkedScope: finding.checkedScope,
        sourceLimitations: finding.sourceLimitations,
        negativeFindingScope: finding.negativeFinding ? finding.negativeFindingScope : '',
      });
    }
    for (const vote of finding.verification?.votes || []) {
      const bestSource = vote.bestSource.trim();
      if (!bestSource) {
        continue;
      }
      sources.push({
        url: bestSource,
        angle: finding.angle,
        confidence: vote.confidence,
        checkedScope: vote.checkedScope,
        sourceLimitations: vote.sourceLimitations,
        negativeFindingScope: '',
      });
    }
  }
  const unique = new Map();
  for (const source of sources) {
    const key = [source.url, source.checkedScope, source.angle].join('\u0000');
    if (!unique.has(key)) {
      unique.set(key, source);
    }
  }
  return deterministicSort([...unique.values()], ['url', 'angle', 'checkedScope']);
}

/**
 * Creates configuration from the copied workflow's environment.
 *
 * @param {string} topic - Research topic.
 * @returns {object} Effective configuration.
 */
function createConfiguration(topic) {
  const depth = String(process.env.DEEPER_RESEARCH_DEPTH || 'standard').toLowerCase();
  const exhaustiveCount = integer(process.env.DEEPER_RESEARCH_EXHAUSTIVE_ANGLES, 10);
  const preset = selectDepthPreset(depth, exhaustiveCount);
  const sensitivity = String(process.env.DEEPER_RESEARCH_SENSITIVITY || 'public').toLowerCase();
  const internalAngleConfiguration = parseInternalAngleConfiguration(
    process.env.DEEPER_RESEARCH_INTERNAL_ANGLES,
    preset,
  );
  const modelPolicy = process.env.DEEPER_RESEARCH_MODEL_POLICY || 'heterogeneous';
  const configuredModels = parseModels(process.env.ULTRACODE_MODELS);
  const models = modelPolicy === 'single' ? configuredModels.slice(0, 1) : configuredModels;
  return {
    topic,
    mode: String(process.env.DEEPER_RESEARCH_MODE || 'standalone').toLowerCase(),
    depth,
    preset,
    sensitivity,
    cli: String(process.env.ULTRACODE_CLI || 'copilot').toLowerCase(),
    cwd: resolve(process.env.ULTRACODE_CWD || process.cwd()),
    allowedUrls: parseList(process.env.ULTRACODE_ALLOWED_URLS),
    angles: selectAngles(preset, sensitivity, internalAngleConfiguration.keys),
    internalAngleConfiguration,
    models,
    modelPolicy,
    questionTree: buildQuestionTree(topic),
    blockingQuestions: [],
  };
}

/**
 * Runs initial angle researchers and preserves required failures.
 *
 * @param {object} engine - Shared ultracode API.
 * @param {object} config - Workflow configuration.
 * @returns {Promise<object>} Findings, failures, and successful angle count.
 */
async function runResearchers(engine, config) {
  const results = await engine.map(config.angles, async (angle, index) => {
    const model = pickModel(config.models, 'cheap', index);
    const envelope = await engine.agent(researchPrompt(config, angle), {
      ...readOptions(config, angle.sourceScope, model),
      label: `research:${angle.key}${model ? ` @${model.id}` : ''}`,
      schema: RESEARCH_SCHEMA,
    });
    return { angle, model, envelope };
  });
  const findings = [];
  const failures = [];
  for (const result of results) {
    if (!result.envelope.ok) {
      failures.push({
        angle: result.angle.key,
        sourceScope: result.angle.sourceScope,
        required: true,
        envelope: result.envelope,
      });
      continue;
    }
    findings.push(...result.envelope.value.findings.map((finding) => ({
      ...finding,
      angle: result.angle.key,
      sourceScope: result.angle.sourceScope,
      researchFamily: result.model?.family,
      researchModel: result.model?.id,
      findingStage: 'researcher',
      findingRound: 0,
    })));
  }
  return {
    findings,
    failures,
    successfulAngles: config.angles.length - failures.length,
  };
}

/**
 * Runs the depth-bounded completeness critic loop.
 *
 * @param {object} engine - Shared ultracode API.
 * @param {object} config - Workflow configuration.
 * @param {object[]} initialFindings - Researcher findings.
 * @returns {Promise<object>} Expanded findings, gaps, rounds, and failures.
 */
async function runCompleteness(engine, config, initialFindings) {
  const initial = normalizeFindings(
    initialFindings,
    engine.deterministicSort,
    config.allowedUrls,
  );
  let findings = initial.findings;
  let suggestedAngles = [];
  let remainingGaps = [];
  const failures = [];
  const findingValidationFailures = [...initial.failures];
  let roundsCompleted = 0;
  const containsInternal = config.angles.some((angle) => angle.sourceScope === 'internal');
  const sourceScope = containsInternal ? 'internal' : 'public';
  for (let round = 1; round <= config.preset.completenessRounds; round += 1) {
    const model = pickModel(config.models, 'cheap', round - 1);
    const envelope = await engine.agent(criticPrompt(config, findings, round), {
      ...readOptions(config, sourceScope, model),
      label: `completeness:${round}${model ? ` @${model.id}` : ''}`,
      schema: CRITIC_SCHEMA,
    });
    roundsCompleted = round;
    if (!envelope.ok) {
      failures.push({ round, sourceScope, required: true, envelope });
      break;
    }
    const beforeFindings = findings.length;
    const beforeAngles = suggestedAngles.length;
    const criticFindings = envelope.value.newFindings.map((finding) => ({
      ...finding,
      sourceScope,
      researchFamily: model?.family,
      researchModel: model?.id,
      findingStage: 'completeness-critic',
      findingRound: round,
    }));
    const normalizedCritic = normalizeFindings(
      criticFindings,
      engine.deterministicSort,
      config.allowedUrls,
    );
    findingValidationFailures.push(...normalizedCritic.failures);
    findings = normalizeFindings(
      [...findings, ...normalizedCritic.findings],
      engine.deterministicSort,
      config.allowedUrls,
    ).findings;
    const criticAngles = envelope.value.newAngles.map((angle) => ({
      key: angle.key,
      focus: angle.focus,
      rationale: angle.rationale,
      suggestedSourceScope: angle.suggestedSourceScope,
      executionSourceScope: sourceScope,
      provenanceStage: 'completeness-critic',
      provenanceRound: round,
    }));
    suggestedAngles = normalizeAngles(
      [...suggestedAngles, ...criticAngles],
      engine.deterministicSort,
    );
    remainingGaps = [...new Set(envelope.value.remainingGaps)].sort();
    const noNovelty = findings.length === beforeFindings && suggestedAngles.length === beforeAngles;
    if (envelope.value.complete || noNovelty) {
      break;
    }
  }
  return {
    findings,
    suggestedAngles,
    remainingGaps,
    failures,
    findingValidationFailures,
    sourceScope,
    roundsCompleted,
  };
}

/**
 * Verifies every load-bearing finding with the preset quorum.
 *
 * @param {object} engine - Shared ultracode API.
 * @param {object} config - Workflow configuration.
 * @param {object[]} findings - Deduplicated findings.
 * @returns {Promise<object[]>} Findings with quorum outcomes.
 */
async function runVerification(engine, config, findings) {
  const loadBearing = findings.filter((finding) => finding.loadBearing);
  return engine.map(loadBearing, async (finding, findingIndex) => {
    const rawEnvelopes = await engine.map(
      Array.from({ length: config.preset.verifierVotes }, (_, index) => index),
      async (vote) => {
        const model = pickModel(
          config.models,
          'strong',
          findingIndex + vote,
          finding.researchFamily,
        );
        return engine.agent(verificationPrompt(config, finding, vote), {
          ...readOptions(config, finding.sourceScope, model),
          label: `verify:${finding.angle}:${vote + 1}${model ? ` @${model.id}` : ''}`,
          schema: VERDICT_SCHEMA,
        });
      },
    );
    const envelopes = rawEnvelopes.map((envelope) => {
      return validateVerifierEnvelope(envelope, finding, config.allowedUrls);
    });
    return {
      ...finding,
      verification: aggregateVerification(envelopes, config.preset.verifierVotes),
    };
  });
}

/**
 * Runs strong-model synthesis when verified evidence exists.
 *
 * @param {object} engine - Shared ultracode API.
 * @param {object} config - Workflow configuration.
 * @param {object[]} verified - Verified findings.
 * @param {object[]} refuted - Refuted findings.
 * @param {object[]} unconfirmed - Unconfirmed findings.
 * @param {object} evidenceContext - Coverage, completeness, and failure context.
 * @returns {Promise<object>} Completed, skipped, or inconclusive synthesis.
 */
async function runSynthesis(engine, config, verified, refuted, unconfirmed, evidenceContext) {
  if (verified.length === 0) {
    return { status: 'skipped', reason: 'No load-bearing claim reached verifier quorum.' };
  }
  const avoidFamily = dominantFamily(verified);
  const model = pickModel(config.models, 'strong', 0, avoidFamily);
  const prompt = synthesisPrompt(config, verified, refuted, unconfirmed, evidenceContext);
  const rawEnvelope = await engine.agent(prompt, {
    ...localReasoningOptions(config, evidenceContext.containsInternal, model),
    label: `synthesis${model ? ` @${model.id}` : ''}`,
    schema: SYNTHESIS_SCHEMA,
  });
  const envelope = validateSynthesisEnvelope(rawEnvelope);
  if (!envelope.ok) {
    return { status: 'inconclusive', reason: 'Required synthesis call failed.', failure: envelope };
  }
  return {
    status: 'completed',
    value: envelope.value,
    containsInternal: evidenceContext.containsInternal,
    modelFamily: model?.family,
    model: model?.id,
  };
}

/**
 * Runs the final red team only when the evidence gate is satisfied.
 *
 * @param {object} engine - Shared ultracode API.
 * @param {object} config - Workflow configuration.
 * @param {object[]} verified - Verified findings.
 * @param {object[]} refuted - Refuted findings.
 * @param {object[]} unconfirmed - Unconfirmed findings.
 * @param {number} successfulAngles - Successful required researchers.
 * @param {object} synthesis - Synthesis state.
 * @param {object} evidenceContext - Coverage, completeness, and failure context.
 * @returns {Promise<object>} Completed, skipped, or inconclusive red-team state.
 */
async function runRedTeam(
  engine,
  config,
  verified,
  refuted,
  unconfirmed,
  successfulAngles,
  synthesis,
  evidenceContext,
) {
  const minimumCoverage = Math.ceil(config.angles.length / 2);
  if (verified.length < MINIMUM_VERIFIED_EVIDENCE) {
    return {
      status: 'skipped',
      reason: `Whole-thesis red team requires at least ${MINIMUM_VERIFIED_EVIDENCE} ` +
        'verified load-bearing claims.',
    };
  }
  if (successfulAngles < minimumCoverage) {
    return {
      status: 'skipped',
      reason: `Only ${successfulAngles}/${config.angles.length} required researchers succeeded.`,
    };
  }
  if (synthesis.status !== 'completed') {
    return { status: 'skipped', reason: 'No completed thesis was available to red-team.' };
  }
  const model = pickModel(config.models, 'strong', 1, synthesis.modelFamily);
  const prompt = redTeamPrompt(
    config,
    synthesis.value,
    verified,
    refuted,
    unconfirmed,
    evidenceContext,
  );
  const rawEnvelope = await engine.agent(prompt, {
    ...localReasoningOptions(config, evidenceContext.containsInternal, model),
    label: `red-team${model ? ` @${model.id}` : ''}`,
    schema: RED_TEAM_SCHEMA,
  });
  const envelope = validateRedTeamEnvelope(rawEnvelope);
  if (!envelope.ok) {
    return { status: 'inconclusive', reason: 'Whole-thesis red-team call failed.', failure: envelope };
  }
  return { status: 'completed', value: envelope.value, modelFamily: model?.family, model: model?.id };
}

/**
 * Executes the deeper-research workflow with the shared ultracode engine.
 *
 * @param {object} engine - Imported ultracode engine API.
 * @param {string} topic - Research question.
 * @returns {Promise<object>} Complete structured research state.
 */
export async function executeResearch(engine, topic) {
  const config = createConfiguration(topic);
  preflight(config, engine);
  config.publicCwd = createPublicWorkspace(config);
  try {
    return await executeConfiguredResearch(engine, config);
  } finally {
    cleanupPublicWorkspace(config);
  }
}

/**
 * Executes a preflighted research run inside its configured isolated workspaces.
 *
 * @param {object} engine - Imported ultracode engine API.
 * @param {object} config - Preflighted workflow configuration.
 * @returns {Promise<object>} Complete structured research state.
 */
async function executeConfiguredResearch(engine, config) {
  engine.phase(`Research: ${config.depth}`);
  const research = await runResearchers(engine, config);

  engine.phase('Completeness');
  const completeness = await runCompleteness(engine, config, research.findings);
  const findings = completeness.findings;

  engine.phase('Verification');
  const verification = await runVerification(engine, config, findings);
  const verified = verification.filter((finding) => finding.verification.status === 'verified');
  const refuted = verification.filter((finding) => finding.verification.status === 'refuted');
  const unconfirmed = verification.filter((finding) => finding.verification.status === 'unconfirmed');
  const nonLoadBearing = findings.filter((finding) => !finding.loadBearing);
  const inconclusiveReason = evidenceDeficitReason(findings, verified);
  const incompleteCoverage = Boolean(inconclusiveReason)
    || research.failures.length > 0
    || completeness.failures.length > 0
    || completeness.findingValidationFailures.length > 0
    || completeness.suggestedAngles.length > 0
    || completeness.remainingGaps.length > 0;
  const containsInternal = findings.some((finding) => finding.sourceScope === 'internal')
    || research.failures.some((failure) => failure.sourceScope === 'internal')
    || completeness.findingValidationFailures.some((failure) => {
      return failure.sourceScope === 'internal';
    })
    || completeness.sourceScope === 'internal';
  const evidenceContext = {
    containsInternal,
    coverage: {
      requiredAngles: config.angles.length,
      successfulAngles: research.successfulAngles,
      incomplete: incompleteCoverage,
    },
    completeness: {
      maximumRounds: config.preset.completenessRounds,
      roundsCompleted: completeness.roundsCompleted,
      suggestedAngles: completeness.suggestedAngles,
      remainingGaps: completeness.remainingGaps,
      failures: completeness.failures,
    },
    researcherFailures: research.failures,
    findingValidationFailures: completeness.findingValidationFailures,
    nonLoadBearingFindings: nonLoadBearing,
  };

  engine.phase('Synthesis');
  const synthesis = await runSynthesis(
    engine,
    config,
    verified,
    refuted,
    unconfirmed,
    evidenceContext,
  );
  engine.phase('Whole-thesis red team');
  const adversarialReview = await runRedTeam(
    engine,
    config,
    verified,
    refuted,
    unconfirmed,
    research.successfulAngles,
    synthesis,
    evidenceContext,
  );

  const verificationFailures = verification
    .filter((finding) => finding.verification.failures.length > 0)
    .map((finding) => ({
      angle: finding.angle,
      claim: finding.claim,
      failures: finding.verification.failures,
    }));
  const failures = {
    researchers: research.failures,
    completenessCritics: completeness.failures,
    findingValidation: completeness.findingValidationFailures,
    verifiers: verificationFailures,
    synthesis: synthesis.failure ? [synthesis.failure] : [],
    redTeam: adversarialReview.failure ? [adversarialReview.failure] : [],
  };
  const incomplete = incompleteCoverage
    || unconfirmed.length > 0
    || Object.values(failures).some((entries) => entries.length > 0);

  engine.log(
    `${findings.length} findings; ${verified.length} verified, ${refuted.length} refuted, ` +
    `${unconfirmed.length} unconfirmed`,
  );
  return {
    skill: 'deeper-research',
    evidenceBundleVersion: 1,
    mode: config.mode,
    outputDisposition: {
      evidenceOnly: config.mode === 'embedded',
      reportEmission: config.mode === 'embedded'
        ? 'skipped-by-contract'
        : 'caller-managed-after-end-checkpoint',
      filenameConfirmation: config.mode === 'embedded' ? 'skipped' : 'required',
      optionalConversions: config.mode === 'embedded' ? 'skipped' : 'available-after-markdown',
    },
    topic: config.topic,
    depth: config.depth,
    preset: config.preset,
    cwd: config.cwd,
    sourcePolicy: {
      deterministicCli: config.cli,
      sensitivity: config.sensitivity,
      publicAllowedUrls: config.allowedUrls,
      publicAgentIsolation: config.publicCwd ? 'sanitized-temporary-cwd' : 'not-needed',
      automaticSystemTempAccess: config.publicCwd ? 'disabled-by-engine' : 'not-applicable',
      internalPublicSeparation: true,
      speculativeToolProbes: false,
    },
    evidenceAssessment: {
      status: inconclusiveReason ? 'inconclusive' : 'sufficient',
      minimumVerifiedClaims: MINIMUM_VERIFIED_EVIDENCE,
      reason: inconclusiveReason,
    },
    modelPolicy: {
      mode: config.models.length > 1 ? config.modelPolicy : 'single-model-fallback',
      configuredModels: config.models,
      assignment: {
        discovery: 'cheap',
        completenessCritic: 'cheap',
        verification: 'strong',
        synthesis: 'strong',
        redTeam: 'strong',
      },
    },
    questionTree: config.questionTree,
    assumptionsLedger: config.questionTree.map((entry) => ({
      assumption: entry.assumption,
      rationale: entry.rationale,
      confidence: entry.confidence,
      status: entry.status,
    })),
    blockingQuestions: config.blockingQuestions,
    angles: config.angles,
    completeness: {
      maximumRounds: config.preset.completenessRounds,
      roundsCompleted: completeness.roundsCompleted,
      suggestedAngles: completeness.suggestedAngles,
      remainingGaps: completeness.remainingGaps,
    },
    coverage: {
      requiredAngles: config.angles.length,
      successfulAngles: research.successfulAngles,
      incomplete: incompleteCoverage,
    },
    counts: {
      findings: findings.length,
      loadBearing: verification.length,
      verified: verified.length,
      refuted: refuted.length,
      unconfirmed: unconfirmed.length,
      nonLoadBearing: nonLoadBearing.length,
    },
    findings,
    verified,
    refuted,
    unconfirmed,
    nonLoadBearing,
    synthesis,
    adversarialReview,
    sources: buildSourceRegister(
      [...verification, ...nonLoadBearing],
      engine.deterministicSort,
    ),
    incomplete,
    failures,
  };
}

/**
 * Loads and validates the shared engine API.
 *
 * @returns {Promise<object>} Ultracode engine module.
 * @throws {Error} If required exports are absent.
 */
async function loadEngine() {
  const engine = await import(findEngineSpecifier());
  const required = ['agent', 'map', 'phase', 'log', 'run', 'deterministicSort'];
  const missing = required.filter((name) => typeof engine[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`Shared ultracode engine is missing exports: ${missing.join(', ')}`);
  }
  return engine;
}

/**
 * Reports a preflight failure before the engine run wrapper is available.
 *
 * @param {unknown} error - Startup failure.
 * @returns {void}
 */
function printStartupFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: {
      kind: 'workflow_preflight',
      message,
      retryable: false,
      incompleteCount: 0,
    },
    attempts: 0,
  }, null, 2)}\n`);
  process.exitCode = 1;
}

/**
 * Runs this copied template as a command-line workflow.
 *
 * @returns {Promise<void>} Completion promise.
 */
async function main() {
  try {
    const engine = await loadEngine();
    const topic = process.argv[2] || 'Your research question or topic';
    await engine.run(() => executeResearch(engine, topic));
  } catch (error) {
    printStartupFailure(error);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
