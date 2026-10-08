/**
 * Verifies automatic council model discovery and "latest flagship" selection.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildCandidates,
  describeModelId,
  discoverRoster,
  parseCatalog,
  selectRoster,
} from '../skills/pr-review/scripts/lib/models.mjs';

const FAKE_COPILOT = join(resolve(dirname(fileURLToPath(import.meta.url))), 'fixtures', 'fake-copilot.mjs');

/**
 * Builds a models.list entry.
 *
 * @param {string} id - Model ID.
 * @param {string} category - Picker category.
 * @param {object} [extra] - Overrides.
 * @returns {object} Entry.
 */
function listed(id, category, extra = {}) {
  return {
    id,
    name: id,
    policy: { state: 'enabled' },
    modelPickerCategory: category,
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    ...extra,
  };
}

const TODAY = [
  { id: 'auto', name: 'Auto' },
  listed('claude-sonnet-5', 'versatile'),
  listed('claude-opus-5.5', 'powerful'),
  listed('claude-opus-4.8-fast', 'powerful'),
  listed('claude-sonnet-5.5', 'versatile'),
  listed('gpt-6.1-sol', 'powerful'),
  listed('gpt-6-astra', 'powerful'),
  listed('gpt-5.6-luna', 'lightweight'),
  listed('gpt-5.4-mini', 'lightweight'),
  listed('gpt-5.3-codex', 'powerful', { policy: undefined }),
  listed('mai-code-1.1-flash', 'lightweight', { supportedReasoningEfforts: ['low', 'medium', 'high'] }),
];
const TODAY_CATALOG = ['claude-fable-5.1', 'claude-opus-5.5', 'gpt-6.1-sol', 'gemini-3.8-flash', 'gemini-3.7-flash',
  'grok-4.6', 'kimi-k3'];

/**
 * Selects the primary model per vendor.
 *
 * @param {object[]} rpcModels - models.list entries.
 * @param {string[]} catalogIds - Catalog IDs.
 * @returns {Record<string, object>} Vendor to primary roster entry.
 */
function primaries(rpcModels, catalogIds) {
  const roster = selectRoster(buildCandidates({ rpcModels, catalogIds }));
  return Object.fromEntries(roster.members.map((member) => [member.vendor, member.chain[0]]));
}

test('selects the newest flagship per vendor for today and future line-ups', () => {
  const cases = [
    {
      name: 'today: Opus 5.5, GPT-6.1 Sol, Gemini 3.8 Flash (catalog-only, effort probed)',
      rpc: TODAY,
      catalog: TODAY_CATALOG,
      expect: { anthropic: 'claude-opus-5.5', openai: 'gpt-6.1-sol', google: 'gemini-3.8-flash' },
    },
    {
      name: 'a newer mid-tier model does not displace the flagship',
      rpc: [...TODAY, listed('claude-sonnet-6', 'versatile')],
      catalog: TODAY_CATALOG,
      expect: { anthropic: 'claude-opus-5.5' },
    },
    {
      name: 'a newer flagship, a Gemini Pro, and an eligible newest codex model win',
      rpc: [...TODAY, listed('claude-opus-6', 'powerful'), listed('gpt-7-codex', 'powerful')],
      catalog: [...TODAY_CATALOG, 'gemini-4-flash', 'gemini-4-pro'],
      expect: { anthropic: 'claude-opus-6', openai: 'gpt-7-codex', google: 'gemini-4-pro' },
    },
    {
      name: 'fast and small variants and disabled models are never selected',
      rpc: [...TODAY, listed('claude-opus-6-fast', 'powerful'), listed('gpt-7-mini', 'powerful'),
        listed('gpt-7-sol', 'powerful', { policy: { state: 'disabled' } })],
      catalog: [...TODAY_CATALOG, 'gemini-9-flash-lite'],
      expect: { anthropic: 'claude-opus-5.5', openai: 'gpt-6.1-sol', google: 'gemini-3.8-flash' },
    },
  ];
  for (const { name, rpc, catalog, expect } of cases) {
    const selected = primaries(rpc, catalog);
    for (const [vendor, id] of Object.entries(expect)) {
      assert.equal(selected[vendor]?.id, id, `${name}: ${vendor}`);
    }
  }
  const today = primaries(TODAY, TODAY_CATALOG);
  assert.deepEqual(
    [today.anthropic.effort, today.openai.effort, today.google.effortProbe, today.google.verified],
    ['max', 'max', true, false],
  );
});

test('prefers verified models and reports vendors without candidates', () => {
  const roster = selectRoster(buildCandidates({
    rpcModels: [listed('claude-opus-5.5', 'powerful'), listed('gpt-5.3-codex', 'powerful', { policy: undefined })],
    catalogIds: ['claude-fable-5.1'],
  }));
  assert.deepEqual(roster.members.map((member) => member.chain.map((entry) => entry.id)), [
    ['claude-opus-5.5'],
    ['gpt-5.3-codex'],
  ]);
  assert.deepEqual(roster.missingVendors, ['google']);
});

test('parses model IDs and the help-config catalog defensively', () => {
  const cases = [
    ['o3-mini', { vendor: 'openai', variant: 'small', version: [3] }],
    ['gemini-2.5-flash-lite', { vendor: 'google', variant: 'small', tokenTier: 2 }],
    ['claude-opus-4.8-fast', { vendor: 'anthropic', variant: 'fast', version: [4, 8] }],
    ['claude-constructor-1', { vendor: 'anthropic', tokenTier: 0, variant: null }],
    ['grok-4.6', { vendor: null }],
  ];
  for (const [id, expected] of cases) {
    const described = describeModelId(id);
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(described[key], value, `${id}.${key}`);
    }
  }
  const help = [
    'Configuration Settings:',
    '  `model`: AI model to use.',
    '    - "claude-opus-5.5"',
    '    - "Not A Valid ID"',
    '    - "claude-opus-5.5"',
    '    - "gemini-3.8-flash"',
    '',
    '    - "after-the-list"',
  ].join('\n');
  assert.deepEqual(parseCatalog(help), ['claude-opus-5.5', 'gemini-3.8-flash']);
  assert.deepEqual(parseCatalog('no model setting here'), []);
});

test('discovers the roster through headless JSON-RPC and survives an RPC failure', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'pr-review-models-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = join(directory, 'copilot');
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_COPILOT}" "$@"\n`, { mode: 0o755 });
  const scenarioPath = join(directory, 'scenario.json');
  const discover = (scenario) => {
    writeFileSync(scenarioPath, JSON.stringify(scenario));
    const env = { ...process.env, FAKE_COPILOT_SCENARIO: scenarioPath };
    return discoverRoster({ binary, cwd: directory, env, timeoutMs: 10_000 });
  };

  const healthy = await discover({ modelsList: TODAY, catalog: TODAY_CATALOG });
  assert.deepEqual(healthy.members.map((member) => member.chain[0].id),
    ['claude-opus-5.5', 'gpt-6.1-sol', 'gemini-3.8-flash']);
  assert.deepEqual(healthy.diagnostics, []);
  assert.equal(healthy.sources.modelsList.protocolVersion, 3);

  const degraded = await discover({ rpcFail: true, catalog: TODAY_CATALOG });
  assert.equal(degraded.diagnostics[0].source, 'models.list');
  assert.equal(degraded.sources.modelsList, null);
  assert.deepEqual(degraded.members.map((member) => [member.chain[0].id, member.chain[0].verified]), [
    ['claude-opus-5.5', false],
    ['gpt-6.1-sol', false],
    ['gemini-3.8-flash', false],
  ]);
});
