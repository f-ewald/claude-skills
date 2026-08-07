#!/usr/bin/env node

/**
 * Offline stand-in for the `gh` CLI used to execute the pr-review skill's
 * documented command templates.
 *
 * It mirrors the flag validation of a recent real `gh` (notably the rejection
 * of `--slurp` alongside `--jq`/`--template`), routes REST and GraphQL calls to
 * `pr-review-api.json`, and evaluates the small `--jq` projection subset the
 * skill uses. Unknown flags, subcommands, and routes exit nonzero so a
 * documented template that a real CLI would reject fails the test suite.
 *
 * Fixtures model the reported projection mismatch: the review-comments list
 * omits `side`/`line`/`subject_type` while the individual comment endpoint
 * returns them.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pr-review-api.json'), 'utf8'),
);

const VALUE_FLAGS = new Set([
  '--hostname',
  '--jq',
  '-q',
  '--method',
  '-X',
  '-H',
  '-f',
  '-F',
  '--template',
  '--repo',
  '-R',
  '--json',
]);
const BOOLEAN_FLAGS = new Set(['--paginate', '--slurp', '--silent', '-i', '--include']);

/**
 * Fails the process the way `gh` reports a usage error.
 *
 * @param {string} message - Message written to stderr.
 * @returns {never}
 */
function usageError(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * Splits argv into recognized flags and positional arguments.
 *
 * @param {string[]} argv - Arguments following the subcommand.
 * @returns {{flags: Map<string, string[]>, positional: string[]}} Parsed arguments.
 * @throws Exits nonzero on an unrecognized flag or a missing flag value.
 */
function parseArguments(argv) {
  const flags = new Map();
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('-')) {
      positional.push(argument);
      continue;
    }
    if (BOOLEAN_FLAGS.has(argument)) {
      flags.set(argument, ['true']);
      continue;
    }
    if (!VALUE_FLAGS.has(argument)) {
      usageError(`unknown flag: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      usageError(`flag needs an argument: ${argument}`);
    }
    index += 1;
    flags.set(argument, [...(flags.get(argument) || []), value]);
  }
  return { flags, positional };
}

/**
 * Reads the effective `--jq` filter, rejecting the flag combinations a recent
 * real `gh` refuses.
 *
 * @param {Map<string, string[]>} flags - Parsed flags.
 * @returns {string|undefined} The jq filter, when one was supplied.
 */
function resolveFilter(flags) {
  const filter = flags.get('--jq')?.[0] ?? flags.get('-q')?.[0];
  const template = flags.get('--template')?.[0];
  if (flags.has('--slurp') && (filter !== undefined || template !== undefined)) {
    usageError('the `--slurp` option is not supported with `--jq` or `--template`');
  }
  return filter;
}

/**
 * Reads a dotted jq path such as `.user.login` from a value.
 *
 * @param {unknown} value - Source value.
 * @param {string} path - Leading-dot path expression.
 * @returns {unknown} The resolved value, or undefined when any segment is absent.
 */
function readPath(value, path) {
  return path
    .replace(/^\./, '')
    .split('.')
    .filter(Boolean)
    .reduce((current, key) => (current == null ? undefined : current[key]), value);
}

/**
 * Builds an object from a jq `{a, b, alias: .x.y}` construction.
 *
 * @param {unknown} value - Source value.
 * @param {string} source - Construction text including braces.
 * @returns {Record<string, unknown>} The projected object; absent keys are omitted.
 */
function project(value, source) {
  const projected = {};
  for (const entry of source.slice(1, -1).split(',')) {
    const text = entry.trim();
    if (!text) {
      continue;
    }
    const separator = text.indexOf(':');
    const key = separator === -1 ? text : text.slice(0, separator).trim();
    const path = separator === -1 ? `.${text}` : text.slice(separator + 1).trim();
    const resolved = readPath(value, path);
    if (resolved !== undefined) {
      projected[key] = resolved;
    }
  }
  return projected;
}

/**
 * Applies one non-iterating jq stage.
 *
 * @param {unknown} value - Input value.
 * @param {string} stage - Trimmed stage source.
 * @returns {unknown} The stage result, or undefined when a select rejects it.
 * @throws Exits nonzero on an unsupported stage.
 */
function applyStage(value, stage) {
  if (stage.startsWith('{')) {
    return project(value, stage);
  }
  const select = stage.match(/^select\(\s*(\.[\w.]+)\s*==\s*"([^"]*)"\s*\)$/);
  if (select) {
    return readPath(value, select[1]) === select[2] ? value : undefined;
  }
  if (stage.startsWith('.')) {
    return readPath(value, stage);
  }
  usageError(`unsupported jq expression: ${stage}`);
  return undefined;
}

/**
 * Evaluates the jq subset the skill's templates use and returns the printable
 * lines, matching `gh`'s raw output for string results.
 *
 * @param {unknown} data - Decoded response body.
 * @param {string} filter - jq filter source.
 * @returns {string[]} Output lines.
 */
function applyFilter(data, filter) {
  const stages = filter
    .split('|')
    .map((stage) => stage.trim())
    .filter(Boolean);
  const iterate = stages[0] === '.[]';
  const rest = iterate ? stages.slice(1) : stages;
  const inputs = iterate ? data : [data];
  const lines = [];
  for (const input of inputs) {
    let current = input;
    for (const stage of rest) {
      current = current === undefined ? undefined : applyStage(current, stage);
    }
    if (current === undefined) {
      continue;
    }
    lines.push(typeof current === 'string' ? current : JSON.stringify(current));
  }
  return lines;
}

const REST_ROUTES = [
  { pattern: /^user$/, method: 'GET', body: () => fixtures.user },
  {
    pattern: /^repos\/[\w.-]+\/[\w.-]+\/compare\/[0-9a-f]+\.\.\.[0-9a-f]+$/,
    method: 'GET',
    body: (_match, flags) =>
      (flags.get('-H') || []).some((header) => header.includes('vnd.github.diff'))
        ? fixtures.diff
        : fixtures.compare,
  },
  {
    pattern: /^repos\/[\w.-]+\/[\w.-]+\/git\/blobs\/[0-9a-f]+$/,
    method: 'GET',
    body: () => fixtures.blob,
  },
  {
    pattern: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/reviews$/,
    method: 'GET',
    pages: () => fixtures.reviewPages,
  },
  {
    pattern: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/reviews$/,
    method: 'POST',
    body: () => fixtures.createdReview,
  },
  {
    pattern: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/reviews\/\d+$/,
    method: 'GET',
    body: () => fixtures.review,
  },
  {
    pattern: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/reviews\/\d+\/comments$/,
    method: 'GET',
    pages: () => fixtures.reviewCommentPages,
  },
  {
    pattern: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/reviews\/\d+\/events$/,
    method: 'POST',
    body: () => fixtures.submittedReview,
  },
  {
    pattern: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/comments\/(\d+)$/,
    method: 'GET',
    body: (route) => fixtures.comments[route.match(/(\d+)$/)[1]],
  },
];

/**
 * Rejects a GraphQL request whose variable declarations, usages, and supplied
 * fields disagree.
 *
 * @param {string} query - Query source.
 * @param {Map<string, string[]>} flags - Parsed flags.
 * @returns {void}
 * @throws Exits nonzero on an undeclared usage, unknown field, or missing required variable.
 */
function validateGraphqlVariables(query, flags) {
  const signature = query.match(/(?:query|mutation)\s*\w*\s*\(([\s\S]*?)\)\s*\{/);
  const declared = new Map();
  for (const part of (signature?.[1] ?? '').split(',')) {
    const declaration = part.trim().match(/^\$(\w+)\s*:\s*(.+)$/);
    if (declaration) {
      declared.set(declaration[1], declaration[2].trim());
    }
  }
  const body = signature ? query.slice(signature.index + signature[0].length) : query;
  for (const [, name] of body.matchAll(/\$(\w+)/g)) {
    if (!declared.has(name)) {
      usageError(`undeclared GraphQL variable: $${name}`);
    }
  }
  const supplied = new Set(
    [...(flags.get('-f') || []), ...(flags.get('-F') || [])]
      .map((field) => field.split('=')[0])
      .filter((name) => name !== 'query'),
  );
  for (const name of supplied) {
    if (!declared.has(name)) {
      usageError(`unknown GraphQL variable field: ${name}`);
    }
  }
  for (const [name, type] of declared) {
    if (type.endsWith('!') && !supplied.has(name)) {
      usageError(`required GraphQL variable not supplied: $${name}`);
    }
  }
}

/**
 * Serves a GraphQL request from the fixture matching its operation.
 *
 * @param {Map<string, string[]>} flags - Parsed flags.
 * @returns {unknown} The GraphQL response body.
 * @throws Exits nonzero when no query field or matching fixture exists.
 */
function serveGraphql(flags) {
  const query = (flags.get('-f') || []).find((field) => field.startsWith('query='))?.slice(6);
  if (!query) {
    usageError('GraphQL requires a query field');
  }
  validateGraphqlVariables(query, flags);
  const operation = ['addPullRequestReviewThread', 'statusCheckRollup', 'reviewThreads'].find((name) =>
    query.includes(name),
  );
  const fixture = fixtures.graphql[operation ?? (query.includes('Blob') ? 'blob' : '')];
  if (!fixture) {
    usageError('no GraphQL fixture matches this query');
  }
  return fixture;
}

/**
 * Serves an `api` invocation. Paginated routes return only their first page
 * unless `--paginate` is supplied, exactly as the real CLI does.
 *
 * @param {string[]} argv - Arguments after `api`.
 * @returns {void}
 * @throws Exits nonzero on an unsupported route or method.
 */
function runApi(argv) {
  const { flags, positional } = parseArguments(argv);
  const filter = resolveFilter(flags);
  const [endpoint] = positional;
  if (!endpoint) {
    usageError('api requires an endpoint');
  }
  const method = (flags.get('--method')?.[0] ?? flags.get('-X')?.[0] ?? 'GET').toUpperCase();
  const route = endpoint.split('?')[0];
  const handler =
    route === 'graphql'
      ? undefined
      : REST_ROUTES.find((candidate) => candidate.pattern.test(route) && candidate.method === method);
  let body;
  if (route === 'graphql') {
    body = serveGraphql(flags);
  } else if (handler?.pages) {
    const pages = handler.pages();
    body = flags.has('--paginate') ? pages.flat() : pages[0];
  } else {
    body = handler?.body(route, flags);
  }
  if (body === undefined) {
    usageError(`no fixture for ${method} ${route}`);
  }
  const lines =
    filter === undefined
      ? [typeof body === 'string' ? body : JSON.stringify(body)]
      : applyFilter(body, filter);
  process.stdout.write(lines.length ? `${lines.join('\n')}\n` : '');
}

/**
 * Serves `pr view`, projecting the fixture onto the requested `--json` fields.
 *
 * @param {string[]} argv - Arguments after `pr view`.
 * @returns {void}
 * @throws Exits nonzero when `--repo` or `--json` is missing.
 */
function runPrView(argv) {
  const { flags, positional } = parseArguments(argv);
  if (!positional[0] || !/^\d+$/.test(positional[0])) {
    usageError('pr view requires a decimal pull request number');
  }
  if (!flags.has('--repo') && !flags.has('-R')) {
    usageError('pr view requires --repo');
  }
  const fields = (flags.get('--json')?.[0] ?? '').split(',').filter(Boolean);
  if (!fields.length) {
    usageError('pr view requires --json fields');
  }
  const selected = {};
  for (const field of fields) {
    if (!(field in fixtures.pullRequest)) {
      usageError(`unknown JSON field: ${field}`);
    }
    selected[field] = fixtures.pullRequest[field];
  }
  process.stdout.write(`${JSON.stringify(selected)}\n`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'api') {
  runApi(rest);
} else if (command === 'auth' && rest[0] === 'status') {
  process.stdout.write('Logged in to the fixture host\n');
} else if (command === 'pr' && rest[0] === 'view') {
  runPrView(rest.slice(1));
} else {
  usageError(`unsupported gh invocation: ${[command, ...rest].join(' ')}`);
}
