# JavaScript Standards

Language-specific standards and libraries for JavaScript code. These build on the
always-on rules in `CLAUDE.md` / `COPILOT.md`; where this file is more specific
(e.g. formatting), it takes precedence over general JavaScript style guidance
where they conflict.

## Language

- Prefer **TypeScript** for all new source code — author `.ts` / `.tsx` files and
  compile to JavaScript, rather than writing plain `.js` by hand.
- Enable `strict` mode in `tsconfig.json`, and avoid `any`; reach for `unknown`
  and precise types instead.
- Plain JavaScript is acceptable only for small config files or when a toolchain
  requires it.
- Every rule below (formatting, components, servers, visualization, testing)
  applies equally to TypeScript.

## Formatting

- **Line length:** hard limit of **120 characters**. Wrap longer lines.
- **Indentation:** always **2 spaces** per level. Never use tabs.
- One statement per line; terminate statements with semicolons.
- Use `const` by default and `let` when reassignment is needed. Never use `var`.
- Use ES modules (`import` / `export`), not CommonJS `require`, in new code.

## Documentation

Use **JSDoc** — the language-specific documentation style for JavaScript.

- Every module, exported class, and exported function/method has a JSDoc block.
- Open with a one-line summary, then optional detail, then `@param` / `@returns`
  / `@throws` tags as applicable.
- Put types in the JSDoc tags for plain JavaScript. In TypeScript, types live in
  the signature, so omit `@param` / `@returns` types and document behavior only.

```javascript
/**
 * Computes a weighted engagement score for a list of events.
 *
 * @param {Event[]} events - The events to score. Must be non-empty.
 * @param {number} [weight=1] - Multiplier applied to the raw score.
 * @returns {number} The weighted engagement score.
 * @throws {Error} If `events` is empty.
 */
function computeScore(events, weight = 1) {
  if (events.length === 0) {
    throw new Error('events must be non-empty');
  }
  return events.reduce((sum, event) => sum + event.value, 0) * weight;
}
```

## Components

Build UI as **Lit** web components (`lit` from [lit.dev](https://lit.dev)).

- **Single responsibility:** each component does exactly one thing, and does it
  well. If a component both fetches data and renders a chart, split it into a
  data component and a presentational one.
- Keep components small and composable; lift shared logic into plain modules
  rather than deep base-class hierarchies.
- One component per file; the file name matches the custom-element tag it defines.

```javascript
import { LitElement, html, css } from 'lit';

/** Renders a single user's avatar — nothing else. */
export class UserAvatar extends LitElement {
  static properties = {
    src: { type: String },
    alt: { type: String },
  };

  static styles = css`
    img { border-radius: 50%; }
  `;

  render() {
    return html`<img src=${this.src} alt=${this.alt} />`;
  }
}
customElements.define('user-avatar', UserAvatar);
```

## Servers & build

- **Frontend dev server & build:** use **Vite** for the dev server, bundling,
  and production builds.
- **Backend HTTP server:** use **Express** for APIs and server-side routes.
- Keep the two concerns separate: Vite owns the client build, Express owns the
  backend; don't couple backend logic into the Vite config.

## Visualization

Use **D3** for data visualization.

- Wrap each D3 visualization inside its own Lit component and let D3 own the SVG
  and DOM within that component's render root, so the "one component, one job"
  rule still holds.
- Keep data transformation (D3 scales, layouts) separate from rendering so the
  transforms stay unit-testable.

## Testing

Use **Vitest** as the test framework and runner (it integrates with Vite).

- Name test files `*.test.js` (co-located with the code or under `test/`).
- Prefer small, isolated tests that are independent of execution order.
- For web components, render into a fixture element and assert against the
  component's shadow DOM.

## Dependencies

Avoid dependency hell: keep the dependency tree small and deliberate.

- Before adding a dependency, weigh it against the cost of its transitive tree,
  supply-chain risk, and long-term maintenance. Prefer the platform (modern
  JS/TS, Web APIs, Node built-ins) over a package.
- If a dependency is small or trivial — a few lines, e.g. `left-pad`-style
  helpers, simple formatters, tiny utilities — do **not** add it. Re-implement the
  functionality yourself and cover it with a test.
- Reserve dependencies for substantial, well-maintained libraries where
  re-implementing would be error-prone or costly (e.g. the ones in the table
  below: Vite, Express, Lit, D3, Vitest).
- Keep re-implemented helpers in a shared, documented, tested `utils/` module
  rather than copy-pasting them across the codebase.

## Libraries & tooling

| Concern | Use |
| --- | --- |
| Frontend dev server & build | Vite |
| Backend HTTP server | Express |
| UI components | Lit (lit.dev web components) |
| Data visualization | D3 |
| Testing | Vitest |
