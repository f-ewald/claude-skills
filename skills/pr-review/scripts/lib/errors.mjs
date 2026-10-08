/**
 * Classified errors shared by the pr-review council modules.
 */

/** Exit codes the council CLI reports for each error kind. */
export const EXIT_CODES = Object.freeze({
  usage: 2,
  'council-unavailable': 3,
  'below-quorum': 3,
  stale: 4,
  input: 5,
  api: 5,
  'incomplete-diff': 5,
  workspace: 5,
  state: 5,
  'chairman-missing': 6,
  'chairman-invalid': 6,
});

/** An error with a stable machine-readable kind and optional structured details. */
export class CouncilError extends Error {
  /**
   * Creates a classified council error.
   *
   * @param {string} kind - Stable error kind; see EXIT_CODES.
   * @param {string} message - Human-readable, bounded message.
   * @param {object} [details] - JSON-serializable diagnostic details.
   */
  constructor(kind, message, details = undefined) {
    super(message);
    this.name = 'CouncilError';
    this.kind = kind;
    this.details = details;
  }
}

/**
 * Returns the exit code for an error kind.
 *
 * @param {string} kind - Error kind.
 * @returns {number} Process exit code; 1 for unclassified kinds.
 */
export function exitCodeFor(kind) {
  return EXIT_CODES[kind] ?? 1;
}

/**
 * Truncates text for inclusion in an error message or report.
 *
 * @param {string} text - Source text.
 * @param {number} [limit=500] - Maximum length.
 * @returns {string} The bounded text.
 */
export function bounded(text, limit = 500) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
