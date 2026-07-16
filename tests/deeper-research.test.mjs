/**
 * Deterministic zero-network tests for the deeper-research workflow.
 */

import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  aggregateVerification,
  DEPTH_PRESETS,
  findEngineSpecifier,
  parseModels,
  pickModel,
  RESEARCH_SCHEMA,
  requirePublicEngineIsolation,
  selectDepthPreset,
} from '../skills/deeper-research/research.workflow.template.mjs';
import { validateStructuredValue } from '../skills/ultracode/orchestrate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = join(ROOT, 'tests', `.deeper-research-runtime-${process.pid}`);
const ENGINE = join(ROOT, 'skills', 'ultracode', 'orchestrate.mjs');
const TEMPLATE = join(ROOT, 'skills', 'deeper-research', 'research.workflow.template.mjs');
const WORKFLOW = join(RUNTIME, 'session-workspace', 'deeper-research.mjs');
const FAKE_CLI = join(RUNTIME, 'research-cli.mjs');
const OPEN = '<<<ULTRACODE_JSON>>>';
const CLOSE = '<<<ULTRACODE_END>>>';

mkdirSync(dirname(WORKFLOW), { recursive: true });
copyFileSync(TEMPLATE, WORKFLOW);
writeFileSync(
  FAKE_CLI,
  `#!/usr/bin/env node
import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const scenario = process.env.FAKE_RESEARCH_SCENARIO || 'success';
appendFileSync(process.env.FAKE_CLI_CALLS_PATH, JSON.stringify({
  args,
  cwd: process.cwd(),
  cwdEntries: readdirSync(process.cwd()).sort(),
  internalRepoMarkerVisible: existsSync(
    join(process.cwd(), 'skills', 'deeper-research', 'SKILL.md'),
  ),
  prompt,
}) + '\\n');

function emit(value) {
  process.stdout.write('${OPEN}\\n' + JSON.stringify(value) + '\\n${CLOSE}');
}

function finding(angle, internal) {
  return {
    claim: angle + ' claim',
    evidence: 'Authoritative evidence for ' + angle,
    sources: [internal ? 'internal://approved/' + angle : 'https://docs.example.com/' + angle],
    loadBearing: true,
    confidence: 'high',
    checkedScope: angle + ' primary documentation',
    sourceLimitations: 'Public documentation only',
    negativeFinding: false,
    negativeFindingScope: '',
  };
}

if (prompt.includes('ROLE: researcher')) {
  const angle = prompt.match(/Angle: ([^\\n]+)/)?.[1] || 'unknown';
  const internal = prompt.includes('Source scope: internal');
  if (
    ['research-failure', 'context-evidence', 'mixed-internal-failure'].includes(scenario) &&
    angle === 'technical'
  ) {
    process.stderr.write('required researcher unavailable');
    process.exitCode = 2;
  } else if (scenario === 'quorum-failure' && angle !== 'technical') {
    emit({ findings: [] });
  } else if (scenario === 'critic-bound') {
    emit({ findings: [] });
  } else if (scenario === 'zero-evidence') {
    emit({ findings: [] });
  } else if (scenario === 'invalid-findings') {
    if (angle !== 'technical') {
      emit({ findings: [] });
    } else {
      emit({ findings: [
        { ...finding(angle, internal), claim: 'blank source claim', sources: ['   '] },
        {
          ...finding(angle, internal),
          claim: 'negative scope claim',
          negativeFinding: true,
          negativeFindingScope: '   ',
        },
      ] });
    }
  } else if (scenario === 'out-of-grant') {
    emit({
      findings: angle === 'technical'
        ? [{ ...finding(angle, internal), sources: ['https://outside.example/source'] }]
        : [],
    });
  } else if (scenario === 'http-source') {
    emit({
      findings: angle === 'technical'
        ? [{ ...finding(angle, internal), sources: ['http://docs.example.com/source'] }]
        : [],
    });
  } else if (scenario === 'blank-finding-fields') {
    emit({
      findings: angle === 'technical'
        ? [{
            ...finding(angle, internal),
            claim: ' ',
            evidence: '\\t',
            checkedScope: '',
            sourceLimitations: '   ',
          }]
        : [],
    });
  } else if (
    ['blank-verifier', 'verifier-out-of-grant', 'one-verified'].includes(scenario) &&
    angle !== 'technical'
  ) {
    emit({ findings: [] });
  } else {
    const delay = angle === 'technical' ? 30 : angle === 'evidence' ? 5 : 0;
    if (delay) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }
    emit({ findings: [finding(angle, internal)] });
  }
} else if (prompt.includes('ROLE: completeness critic')) {
  const round = Number.parseInt(prompt.match(/Completeness round (\\d+)/)?.[1] || '1', 10);
  if (scenario === 'critic-bound') {
    const key = round === 2 ? 'alpha-gap' : 'zulu-gap';
    emit({
      complete: false,
      newAngles: [{
        key,
        focus: 'Missing perspective ' + round,
        rationale: 'Deterministic completeness fixture',
        suggestedSourceScope: 'public',
      }],
      newFindings: [],
      remainingGaps: ['gap-' + round],
    });
  } else if (scenario === 'context-evidence') {
    emit({
      complete: round > 1,
      newAngles: round === 1 ? [{
        key: 'known-gap',
        focus: 'Known missing perspective',
        rationale: 'Coverage remains incomplete',
        suggestedSourceScope: 'public',
      }] : [],
      newFindings: [],
      remainingGaps: ['known coverage gap'],
    });
  } else if (scenario === 'critic-scope-injection') {
    emit({
      complete: true,
      newAngles: [{
        key: 'internal-follow-up',
        focus: 'Potential internal follow-up',
        rationale: 'The public critic recommends a later internal check',
        suggestedSourceScope: 'internal',
        sourceScope: 'internal',
      }],
      newFindings: [],
      remainingGaps: [],
    });
  } else {
    emit({ complete: true, newAngles: [], newFindings: [], remainingGaps: [] });
  }
} else if (prompt.includes('ROLE: verifier')) {
  if (scenario === 'quorum-failure' && prompt.includes('ROLE: verifier 2/2')) {
    process.stderr.write('verifier unavailable');
    process.exitCode = 2;
  } else if (scenario === 'context-evidence' && prompt.includes('Claim: evidence claim')) {
    emit({
      status: 'refuted',
      confidence: 'high',
      reasoning: 'The primary source contradicts the claim.',
      checkedScope: 'Exact documented scope',
      sourceLimitations: 'None material',
      bestSource: 'https://docs.example.com/refuted',
    });
  } else if (scenario === 'context-evidence' && prompt.includes('Claim: risks claim')) {
    emit({
      status: 'unconfirmed',
      confidence: 'low',
      reasoning: 'The available source does not establish the claim.',
      checkedScope: 'Exact documented scope',
      sourceLimitations: 'Evidence was incomplete',
      bestSource: 'https://docs.example.com/unconfirmed',
    });
  } else if (scenario === 'blank-verifier') {
    emit({
      status: 'verified',
      confidence: 'high',
      reasoning: '   ',
      checkedScope: '',
      sourceLimitations: ' ',
      bestSource: '   ',
    });
  } else if (scenario === 'verifier-out-of-grant') {
    emit({
      status: 'verified',
      confidence: 'high',
      reasoning: 'The claim appears confirmed.',
      checkedScope: 'Exact documented scope',
      sourceLimitations: 'None material',
      bestSource: 'https://outside.example/verifier',
    });
  } else {
    emit({
      status: 'verified',
      confidence: 'high',
      reasoning: 'The exact primary source confirms the claim.',
      checkedScope: 'Exact documented scope',
      sourceLimitations: 'None material',
      bestSource: 'https://docs.example.com/verified',
    });
  }
} else if (prompt.includes('ROLE: synthesis')) {
  if (scenario === 'blank-synthesis') {
    emit({
      thesis: ' ',
      summary: '\\t',
      analysis: '',
      recommendation: '   ',
      evidenceLimits: [' '],
      confidence: 'high',
    });
  } else {
    emit({
      thesis: 'The verified findings support a bounded thesis.',
      summary: 'Synthesis based only on quorum-verified evidence.',
      analysis: 'The evidence supports a narrow conclusion with explicit limits.',
      recommendation: 'Proceed only within the verified scope.',
      evidenceLimits: ['Only the configured source scope was checked.'],
      confidence: 'high',
    });
  }
} else if (prompt.includes('ROLE: whole-thesis red team')) {
  if (scenario === 'blank-redteam') {
    emit({
      counterThesis: ' ',
      reasoning: '\\t',
      weakPoints: [{ point: '', target: ' ', whyItMatters: '   ' }],
      flipsIfWrong: [' '],
      verdict: 'survives',
      residualDoubts: '',
    });
  } else {
    emit({
      counterThesis: 'The evidence may not generalize beyond the checked scope.',
      reasoning: 'The strongest challenge is limited external validity.',
      weakPoints: [{
        point: 'Scope is bounded',
        target: 'The synthesized thesis',
        whyItMatters: 'Broader populations were not checked.',
      }],
      flipsIfWrong: ['technical claim'],
      verdict: 'qualify',
      residualDoubts: 'External validity remains limited.',
    });
  }
} else {
  process.stderr.write('unexpected fake CLI prompt');
  process.exitCode = 3;
}
`,
);
chmodSync(FAKE_CLI, 0o755);

after(() => {
  rmSync(RUNTIME, { recursive: true, force: true });
});

/**
 * Reads fake CLI calls from one run.
 *
 * @param {string} path - Calls file.
 * @returns {object[]} Recorded calls.
 */
function readCalls(path) {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Runs the copied workflow against the deterministic local fake CLI.
 *
 * @param {string} name - Unique run name.
 * @param {object} environment - Scenario environment overrides.
 * @param {number} [expectedStatus=0] - Expected process status.
 * @returns {{envelope: object, calls: object[], stderr: string}} Run result.
 */
function runWorkflow(name, environment, expectedStatus = 0) {
  const callsPath = join(RUNTIME, `${name}-calls.jsonl`);
  writeFileSync(callsPath, '');
  const result = spawnSync(process.execPath, [WORKFLOW, 'Fixture research topic'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ULTRACODE_ENGINE: ENGINE,
      ULTRACODE_CLI: 'copilot',
      ULTRACODE_CLI_BIN: FAKE_CLI,
      ULTRACODE_CWD: ROOT,
      ULTRACODE_RETRIES: '0',
      ULTRACODE_CONCURRENCY: '8',
      ULTRACODE_ALLOWED_URLS: 'https://docs.example.com',
      FAKE_CLI_CALLS_PATH: callsPath,
      ...environment,
    },
    timeout: 15000,
  });
  assert.equal(result.status, expectedStatus, result.stderr);
  return {
    envelope: JSON.parse(result.stdout),
    calls: readCalls(callsPath),
    stderr: result.stderr,
  };
}

test('depth presets deterministically control fan-out, voting, and completeness', () => {
  assert.deepEqual(selectDepthPreset('quick'), {
    depth: 'quick',
    angleCount: 3,
    verifierVotes: 1,
    completenessRounds: 1,
  });
  assert.deepEqual(selectDepthPreset('standard'), {
    depth: 'standard',
    angleCount: 6,
    verifierVotes: 2,
    completenessRounds: 2,
  });
  assert.equal(selectDepthPreset('exhaustive', 4).angleCount, 8);
  assert.equal(selectDepthPreset('exhaustive', 20).angleCount, 12);
  assert.equal(DEPTH_PRESETS.exhaustive.verifierVotes, 3);
  assert.equal(DEPTH_PRESETS.exhaustive.completenessRounds, 3);
});

test('research schema requires sources and explicit load-bearing metadata', () => {
  const finding = {
    claim: 'Claim',
    evidence: 'Evidence',
    sources: ['https://docs.example.com/source'],
    loadBearing: true,
    confidence: 'high',
    checkedScope: 'Exact version',
    sourceLimitations: 'One primary source',
    negativeFinding: false,
    negativeFindingScope: '',
  };
  assert.deepEqual(validateStructuredValue({ findings: [finding] }, RESEARCH_SCHEMA), { ok: true });
  const sourceFree = validateStructuredValue({
    findings: [{ ...finding, sources: [] }],
  }, RESEARCH_SCHEMA);
  assert.equal(sourceFree.ok, false);
  assert.match(sourceFree.errors.join('\n'), /at least 1/);
  const missingLoadBearing = { ...finding };
  delete missingLoadBearing.loadBearing;
  const missing = validateStructuredValue({ findings: [missingLoadBearing] }, RESEARCH_SCHEMA);
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join('\n'), /loadBearing is required/);
});

test('verifier quorum never counts failed calls as refutations', () => {
  const result = aggregateVerification([
    { ok: true, value: { status: 'verified' }, attempts: 1 },
    { ok: false, error: { kind: 'invocation' }, attempts: 1 },
  ], 2);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.verifiedVotes, 1);
  assert.equal(result.refutedVotes, 0);
  assert.equal(result.failures.length, 1);
});

test('model policy uses tiers and cross-family fallback deterministically', () => {
  const models = parseModels(
    'alpha:cheap:alpha-mini,alpha:strong:alpha-pro,beta:strong:beta-pro',
  );
  assert.equal(pickModel(models, 'cheap', 0).id, 'alpha-mini');
  assert.equal(pickModel(models, 'strong', 0, 'alpha').id, 'beta-pro');
  assert.equal(pickModel([], 'strong', 0), undefined);
});

test('public research requires temp-dir isolation capability from ultracode', () => {
  assert.throws(
    () => requirePublicEngineIsolation({}),
    /enforces --disallow-temp-dir/,
  );
  assert.doesNotThrow(() => requirePublicEngineIsolation({
    ENGINE_CAPABILITIES: { copilotReadDisallowTempDir: true },
  }));
});

test('embedded mode returns evidence without creating a report artifact', () => {
  const reportPath = join(RUNTIME, 'embedded-report.md');
  assert.equal(existsSync(reportPath), false);
  const { envelope } = runWorkflow('embedded-evidence', {
    DEEPER_RESEARCH_MODE: 'embedded',
    DEEPER_RESEARCH_DEPTH: 'quick',
    DEEPER_RESEARCH_OUTPUT_PATH: reportPath,
    FAKE_RESEARCH_SCENARIO: 'success',
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.mode, 'embedded');
  assert.equal(envelope.value.evidenceBundleVersion, 1);
  assert.deepEqual(envelope.value.outputDisposition, {
    evidenceOnly: true,
    reportEmission: 'skipped-by-contract',
    filenameConfirmation: 'skipped',
    optionalConversions: 'skipped',
  });
  assert.ok(envelope.value.sources.length > 0);
  assert.ok(envelope.value.verified.length > 0);
  assert.ok(Array.isArray(envelope.value.refuted));
  assert.ok(Array.isArray(envelope.value.unconfirmed));
  assert.ok(envelope.value.assumptionsLedger.length > 0);
  assert.equal(typeof envelope.value.failures, 'object');
  assert.equal(envelope.value.adversarialReview.status, 'completed');
  assert.equal(existsSync(reportPath), false);
});

test('session-workspace workflow resolves the shared engine and preserves ordering', () => {
  assert.equal(findEngineSpecifier({ configured: ENGINE }), new URL(`file://${ENGINE}`).href);
  const { envelope, calls } = runWorkflow('quick-success', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    FAKE_RESEARCH_SCENARIO: 'success',
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.preset.angleCount, 3);
  assert.equal(envelope.value.preset.verifierVotes, 1);
  assert.equal(envelope.value.completeness.roundsCompleted, 1);
  assert.equal(envelope.value.cwd, ROOT);
  assert.deepEqual(
    envelope.value.findings.map((finding) => finding.angle),
    ['evidence', 'risks', 'technical'],
  );
  assert.equal(envelope.value.adversarialReview.status, 'completed');

  const researchCalls = calls.filter((call) => call.prompt.includes('ROLE: researcher'));
  const verifierCalls = calls.filter((call) => call.prompt.includes('ROLE: verifier'));
  const webCalls = calls.filter((call) => {
    return call.prompt.includes('ROLE: researcher')
      || call.prompt.includes('ROLE: verifier')
      || call.prompt.includes('ROLE: completeness critic');
  });
  const reasoningCalls = calls.filter((call) => {
    return call.prompt.includes('ROLE: synthesis')
      || call.prompt.includes('ROLE: whole-thesis red team');
  });
  assert.equal(researchCalls.length, 3);
  assert.equal(verifierCalls.length, 3);
  assert.ok(
    envelope.value.sources.some((source) => source.url === 'https://docs.example.com/verified'),
  );
  const publicCwd = calls[0].cwd;
  assert.notEqual(publicCwd, ROOT);
  assert.equal(existsSync(publicCwd), false);
  for (const call of webCalls) {
    assert.equal(call.cwd, publicCwd);
    assert.deepEqual(call.cwdEntries, []);
    assert.equal(call.internalRepoMarkerVisible, false);
    assert.match(call.args.join(' '), /--available-tools view,rg,glob,web_fetch/);
    assert.doesNotMatch(call.args.join(' '), /web_search/);
    assert.ok(call.args.includes('--disallow-temp-dir'));
    assert.match(call.args.join(' '), /--allow-url https:\/\/docs\.example\.com/);
    assert.ok(!call.args.includes('--allow-all-tools'));
  }
  for (const call of reasoningCalls) {
    assert.equal(call.cwd, publicCwd);
    assert.deepEqual(call.cwdEntries, []);
    assert.equal(call.internalRepoMarkerVisible, false);
    assert.match(call.args.join(' '), /--available-tools view,rg,glob/);
    assert.ok(call.args.includes('--disallow-temp-dir'));
    assert.doesNotMatch(call.args.join(' '), /web_fetch|web_search|--allow-url/);
  }
});

test('critic source-scope injection cannot escalate downstream provenance', () => {
  const { envelope, calls } = runWorkflow('critic-scope-injection', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    FAKE_RESEARCH_SCENARIO: 'critic-scope-injection',
  });
  assert.equal(envelope.ok, true);
  const [suggestion] = envelope.value.completeness.suggestedAngles;
  assert.equal(suggestion.suggestedSourceScope, 'internal');
  assert.equal(suggestion.executionSourceScope, 'public');
  assert.equal(Object.hasOwn(suggestion, 'sourceScope'), false);

  const synthesis = calls.find((call) => call.prompt.includes('ROLE: synthesis'));
  const redTeam = calls.find((call) => call.prompt.includes('ROLE: whole-thesis red team'));
  for (const call of [synthesis, redTeam]) {
    assert.notEqual(call.cwd, ROOT);
    assert.match(call.args.join(' '), /--available-tools view,rg,glob/);
    assert.doesNotMatch(call.args.join(' '), /web_fetch|web_search|--allow-url/);
  }
});

test('required researcher failure remains visible in final metadata', () => {
  const { envelope } = runWorkflow('research-failure', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    FAKE_RESEARCH_SCENARIO: 'research-failure',
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.incomplete, true);
  assert.equal(envelope.value.coverage.successfulAngles, 2);
  assert.equal(envelope.value.failures.researchers.length, 1);
  assert.equal(envelope.value.failures.researchers[0].angle, 'technical');
  assert.equal(envelope.value.failures.researchers[0].envelope.ok, false);
});

test('internal research remains local-read and never receives public URL grants', () => {
  const { envelope, calls } = runWorkflow('internal-only', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    DEEPER_RESEARCH_SENSITIVITY: 'internal',
    ULTRACODE_ALLOWED_URLS: '',
    FAKE_RESEARCH_SCENARIO: 'success',
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.sourcePolicy.sensitivity, 'internal');
  assert.deepEqual(envelope.value.sourcePolicy.publicAllowedUrls, []);
  for (const call of calls) {
    assert.equal(call.cwd, ROOT);
    assert.equal(call.internalRepoMarkerVisible, true);
    assert.match(call.args.join(' '), /--available-tools view,rg,glob/);
    assert.doesNotMatch(call.args.join(' '), /web_fetch|web_search|--allow-url/);
  }
});

test('internal angle keys are canonicalized before source assignment', () => {
  const { envelope, calls } = runWorkflow('canonical-internal-angle', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    DEEPER_RESEARCH_INTERNAL_ANGLES: 'Technical',
    FAKE_RESEARCH_SCENARIO: 'success',
  });
  assert.equal(envelope.ok, true);
  const technical = calls.find((call) => {
    return call.prompt.includes('ROLE: researcher') && call.prompt.includes('Angle: technical');
  });
  assert.match(technical.prompt, /Source scope: internal/);
  assert.equal(technical.cwd, ROOT);
});

test('duplicate and unknown internal angle keys fail preflight together', () => {
  const { envelope, calls } = runWorkflow('invalid-internal-angles', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    DEEPER_RESEARCH_INTERNAL_ANGLES: 'technical,Technical,typo,ANOTHER',
    FAKE_RESEARCH_SCENARIO: 'success',
  }, 1);
  assert.equal(envelope.ok, false);
  assert.match(envelope.error.message, /duplicate internal angle "technical"/);
  assert.match(envelope.error.message, /unknown internal angle "typo"/);
  assert.match(envelope.error.message, /unknown internal angle "another"/);
  assert.deepEqual(calls, []);
});

test('mixed internal failure forces internal local-only synthesis and red team', () => {
  const { envelope, calls } = runWorkflow('mixed-internal-failure', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    DEEPER_RESEARCH_INTERNAL_ANGLES: 'technical',
    FAKE_RESEARCH_SCENARIO: 'mixed-internal-failure',
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.synthesis.status, 'completed');
  assert.equal(envelope.value.adversarialReview.status, 'completed');
  assert.equal(envelope.value.failures.researchers[0].sourceScope, 'internal');

  const publicResearch = calls.filter((call) => call.prompt.includes('Source scope: public'));
  const internalResearch = calls.find((call) => call.prompt.includes('Source scope: internal'));
  const synthesis = calls.find((call) => call.prompt.includes('ROLE: synthesis'));
  const redTeam = calls.find((call) => call.prompt.includes('ROLE: whole-thesis red team'));
  const publicCwd = publicResearch[0].cwd;
  assert.notEqual(publicCwd, ROOT);
  assert.equal(existsSync(publicCwd), false);
  assert.equal(internalResearch.cwd, ROOT);
  for (const call of [synthesis, redTeam]) {
    assert.equal(call.cwd, ROOT);
    assert.equal(call.internalRepoMarkerVisible, true);
    assert.match(call.args.join(' '), /--available-tools view,rg,glob/);
    assert.doesNotMatch(call.args.join(' '), /web_fetch|web_search|--allow-url/);
    assert.match(call.prompt, /required researcher unavailable/);
  }
});

test('mixed research fails closed and cleans up when public cwd is not isolated', () => {
  const before = readdirSync(ROOT).filter((entry) => entry.startsWith('.deeper-research-public-'));
  const { envelope, calls } = runWorkflow('mixed-isolation-failure', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    DEEPER_RESEARCH_INTERNAL_ANGLES: 'technical',
    HOME: ROOT,
    FAKE_RESEARCH_SCENARIO: 'success',
  }, 1);
  const after = readdirSync(ROOT).filter((entry) => entry.startsWith('.deeper-research-public-'));
  assert.equal(envelope.ok, false);
  assert.match(envelope.error.message, /Cannot establish an isolated public research cwd/);
  assert.deepEqual(calls, []);
  assert.deepEqual(after, before);
});

test('public research without an allowlist fails in a structured preflight envelope', () => {
  const { envelope, calls } = runWorkflow('missing-allowlist', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    ULTRACODE_ALLOWED_URLS: '',
    FAKE_RESEARCH_SCENARIO: 'success',
  }, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.kind, 'workflow');
  assert.match(envelope.error.message, /requires ULTRACODE_ALLOWED_URLS/);
  assert.deepEqual(calls, []);
});

test('public deterministic Claude research fails closed before launching agents', () => {
  const { envelope, calls } = runWorkflow('public-claude', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    ULTRACODE_CLI: 'claude',
    FAKE_RESEARCH_SCENARIO: 'success',
  }, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.kind, 'workflow');
  assert.match(envelope.error.message, /Deterministic public Claude research is unsupported/);
  assert.match(envelope.error.message, /native Claude Workflow\/runtime permissions/);
  assert.match(envelope.error.message, /Copilot deterministic engine/);
  assert.deepEqual(calls, []);
});

test('two-vote quorum failure stays unconfirmed and skips success-shaped red team', () => {
  const { envelope } = runWorkflow('quorum-failure', {
    DEEPER_RESEARCH_DEPTH: 'standard',
    FAKE_RESEARCH_SCENARIO: 'quorum-failure',
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.preset.verifierVotes, 2);
  assert.equal(envelope.value.counts.verified, 0);
  assert.equal(envelope.value.counts.refuted, 0);
  assert.equal(envelope.value.counts.unconfirmed, 1);
  assert.equal(envelope.value.failures.verifiers.length, 1);
  assert.equal(envelope.value.unconfirmed[0].verification.failures.length, 1);
  assert.equal(envelope.value.synthesis.status, 'skipped');
  assert.equal(envelope.value.adversarialReview.status, 'skipped');
  assert.match(envelope.value.adversarialReview.reason, /at least 2 verified/);
});

test('synthesis and red team receive failures, gaps, and contrary evidence', () => {
  const { envelope, calls } = runWorkflow('context-evidence', {
    DEEPER_RESEARCH_DEPTH: 'standard',
    FAKE_RESEARCH_SCENARIO: 'context-evidence',
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.synthesis.status, 'completed');
  assert.equal(envelope.value.adversarialReview.status, 'completed');
  assert.equal(envelope.value.counts.refuted, 1);
  assert.equal(envelope.value.counts.unconfirmed, 1);

  const synthesis = calls.find((call) => call.prompt.includes('ROLE: synthesis'));
  const redTeam = calls.find((call) => call.prompt.includes('ROLE: whole-thesis red team'));
  for (const call of [synthesis, redTeam]) {
    assert.ok(call);
    assert.match(call.prompt, /Researcher failures:/);
    assert.match(call.prompt, /"angle": "technical"/);
    assert.match(call.prompt, /Coverage and completeness metadata:/);
    assert.match(call.prompt, /known coverage gap/);
    assert.match(call.prompt, /evidence claim/);
    assert.match(call.prompt, /risks claim/);
  }
  assert.match(redTeam.prompt, /Refuted evidence:/);
  assert.match(redTeam.prompt, /Unconfirmed evidence:/);
});

test('whitespace-only synthesis becomes an inconclusive semantic failure', () => {
  const { envelope } = runWorkflow('blank-synthesis', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    FAKE_RESEARCH_SCENARIO: 'blank-synthesis',
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.synthesis.status, 'inconclusive');
  assert.equal(envelope.value.synthesis.failure.error.kind, 'semantic_validation');
  assert.match(envelope.value.synthesis.failure.error.message, /thesis must be nonblank/);
  assert.match(envelope.value.synthesis.failure.error.message, /analysis must be nonblank/);
  assert.match(envelope.value.synthesis.failure.error.message, /recommendation must be nonblank/);
  assert.match(envelope.value.synthesis.failure.error.message, /evidenceLimits\[0\]/);
  assert.equal(envelope.value.adversarialReview.status, 'skipped');
  assert.equal(envelope.value.failures.synthesis.length, 1);
  assert.equal(envelope.value.incomplete, true);
});

test('whitespace-only red team cannot return a survives-shaped completion', () => {
  const { envelope } = runWorkflow('blank-redteam', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    FAKE_RESEARCH_SCENARIO: 'blank-redteam',
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.synthesis.status, 'completed');
  assert.equal(envelope.value.adversarialReview.status, 'inconclusive');
  assert.equal(envelope.value.adversarialReview.failure.error.kind, 'semantic_validation');
  assert.match(
    envelope.value.adversarialReview.failure.error.message,
    /counterThesis must be nonblank/,
  );
  assert.match(envelope.value.adversarialReview.failure.error.message, /reasoning must be nonblank/);
  assert.match(envelope.value.adversarialReview.failure.error.message, /weakPoints\[0\]\.point/);
  assert.match(envelope.value.adversarialReview.failure.error.message, /flipsIfWrong\[0\]/);
  assert.equal(Object.hasOwn(envelope.value.adversarialReview, 'value'), false);
  assert.equal(envelope.value.failures.redTeam.length, 1);
  assert.equal(envelope.value.incomplete, true);
});

test('semantic finding validation rejects blank sources and negative scopes visibly', () => {
  const { envelope } = runWorkflow('invalid-findings', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    FAKE_RESEARCH_SCENARIO: 'invalid-findings',
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.counts.findings, 0);
  assert.deepEqual(envelope.value.findings, []);
  assert.equal(envelope.value.incomplete, true);
  assert.equal(envelope.value.failures.findingValidation.length, 2);
  assert.match(
    envelope.value.failures.findingValidation[0].errors.join('\n'),
    /nonblank source|nonblank negativeFindingScope/,
  );
  assert.match(
    envelope.value.failures.findingValidation[1].errors.join('\n'),
    /nonblank source|nonblank negativeFindingScope/,
  );
});

test('finding text fields are trimmed and must remain nonblank', () => {
  const { envelope } = runWorkflow('blank-finding-fields', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    FAKE_RESEARCH_SCENARIO: 'blank-finding-fields',
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.counts.findings, 0);
  assert.equal(envelope.value.failures.findingValidation.length, 1);
  const errors = envelope.value.failures.findingValidation[0].errors.join('\n');
  assert.match(errors, /claim must be nonblank/);
  assert.match(errors, /evidence must be nonblank/);
  assert.match(errors, /checkedScope must be nonblank/);
  assert.match(errors, /sourceLimitations must be nonblank/);
});

test('public citations outside configured grants are rejected visibly', () => {
  const { envelope } = runWorkflow('out-of-grant', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    FAKE_RESEARCH_SCENARIO: 'out-of-grant',
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.counts.findings, 0);
  assert.equal(envelope.value.failures.findingValidation.length, 1);
  assert.match(
    envelope.value.failures.findingValidation[0].errors.join('\n'),
    /outside ULTRACODE_ALLOWED_URLS/,
  );
  assert.ok(
    !envelope.value.sources.some((source) => source.url.includes('outside.example')),
  );
});

test('bare domains grant HTTPS only while protocol grants remain exact', () => {
  const bareHttp = runWorkflow('bare-domain-http', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    ULTRACODE_ALLOWED_URLS: 'docs.example.com',
    FAKE_RESEARCH_SCENARIO: 'http-source',
  }).envelope;
  assert.equal(bareHttp.value.counts.findings, 0);
  assert.match(
    bareHttp.value.failures.findingValidation[0].errors.join('\n'),
    /outside ULTRACODE_ALLOWED_URLS/,
  );

  const bareHttps = runWorkflow('bare-domain-https', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    ULTRACODE_ALLOWED_URLS: 'docs.example.com',
    FAKE_RESEARCH_SCENARIO: 'one-verified',
  }).envelope;
  assert.equal(bareHttps.value.counts.findings, 1);

  const httpsOnlyHttp = runWorkflow('https-only-http', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    ULTRACODE_ALLOWED_URLS: 'https://docs.example.com',
    FAKE_RESEARCH_SCENARIO: 'http-source',
  }).envelope;
  assert.equal(httpsOnlyHttp.value.counts.findings, 0);

  const explicitHttp = runWorkflow('explicit-http', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    ULTRACODE_ALLOWED_URLS: 'http://docs.example.com,https://docs.example.com',
    FAKE_RESEARCH_SCENARIO: 'http-source',
  }).envelope;
  assert.equal(explicitHttp.value.counts.findings, 1);
});

test('blank verifier evidence becomes a failed vote and cannot reach quorum', () => {
  const { envelope } = runWorkflow('blank-verifier', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    FAKE_RESEARCH_SCENARIO: 'blank-verifier',
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.counts.verified, 0);
  assert.equal(envelope.value.counts.refuted, 0);
  assert.equal(envelope.value.counts.unconfirmed, 1);
  assert.equal(envelope.value.failures.verifiers.length, 1);
  const [failure] = envelope.value.unconfirmed[0].verification.failures;
  assert.equal(failure.error.kind, 'semantic_validation');
  assert.match(failure.error.message, /reasoning must be nonblank/);
  assert.match(failure.error.message, /bestSource must be nonblank/);
});

test('out-of-grant verifier sources become failed votes', () => {
  const { envelope } = runWorkflow('verifier-out-of-grant', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    FAKE_RESEARCH_SCENARIO: 'verifier-out-of-grant',
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.counts.verified, 0);
  assert.equal(envelope.value.counts.unconfirmed, 1);
  const [failure] = envelope.value.unconfirmed[0].verification.failures;
  assert.equal(failure.error.kind, 'semantic_validation');
  assert.match(failure.error.message, /outside ULTRACODE_ALLOWED_URLS/);
});

test('zero findings and one verified claim remain explicitly inconclusive', () => {
  const zero = runWorkflow('zero-evidence', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    FAKE_RESEARCH_SCENARIO: 'zero-evidence',
  }).envelope;
  assert.equal(zero.value.completeness.remainingGaps.length, 0);
  assert.equal(zero.value.counts.findings, 0);
  assert.equal(zero.value.coverage.incomplete, true);
  assert.equal(zero.value.incomplete, true);
  assert.equal(zero.value.evidenceAssessment.status, 'inconclusive');
  assert.match(zero.value.evidenceAssessment.reason, /No accepted findings/);

  const one = runWorkflow('one-verified', {
    DEEPER_RESEARCH_DEPTH: 'quick',
    FAKE_RESEARCH_SCENARIO: 'one-verified',
  }).envelope;
  assert.equal(one.value.counts.findings, 1);
  assert.equal(one.value.counts.verified, 1);
  assert.equal(one.value.coverage.incomplete, true);
  assert.equal(one.value.incomplete, true);
  assert.equal(one.value.evidenceAssessment.status, 'inconclusive');
  assert.match(one.value.evidenceAssessment.reason, /Insufficient verified evidence: 1\/2/);
});

test('exhaustive completeness loop is bounded and deduplicates angles', () => {
  const { envelope, calls } = runWorkflow('critic-bound', {
    DEEPER_RESEARCH_DEPTH: 'exhaustive',
    DEEPER_RESEARCH_EXHAUSTIVE_ANGLES: '10',
    FAKE_RESEARCH_SCENARIO: 'critic-bound',
  });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.coverage.requiredAngles, 10);
  assert.equal(envelope.value.completeness.maximumRounds, 3);
  assert.equal(envelope.value.completeness.roundsCompleted, 3);
  assert.deepEqual(
    envelope.value.completeness.suggestedAngles.map((angle) => angle.key),
    ['alpha-gap', 'zulu-gap'],
  );
  assert.equal(
    calls.filter((call) => call.prompt.includes('ROLE: researcher')).length,
    10,
  );
  assert.equal(
    calls.filter((call) => call.prompt.includes('ROLE: completeness critic')).length,
    3,
  );
  assert.equal(envelope.value.adversarialReview.status, 'skipped');
  assert.equal(envelope.value.incomplete, true);
});
