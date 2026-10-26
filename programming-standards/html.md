# HTML Standards

Standards for HTML markup, in plain pages and in Lit templates alike. These build on
the always-on rules in `AGENTS.md` and complement `javascript.md`.

## Native first

Before writing JavaScript or ARIA for an interaction, check whether a built-in
element or attribute already does it.

- Native elements bring keyboard handling, focus management, accessibility
  semantics, form participation, and browser fixes for free — custom code has to
  re-implement and maintain all of that.
- Add ARIA only when no native element exists (the first rule of ARIA). Never put
  `role="button"`, `role="link"`, etc. on a `<div>` or `<span>`.
- Style native elements instead of replacing them; reach for a custom component
  only when the native one demonstrably can't meet the requirement.
- Pick elements for meaning, not looks: headings in order, lists for lists,
  `<table>` only for tabular data.

## Reference

All entries below are **Baseline widely available** (work across all major
browsers). Status from the `web-features` dataset; re-check before relying on edge
cases.

| Need | Use | Instead of |
| --- | --- | --- |
| Expand/collapse, accordion, FAQ | `<details>` + `<summary>` (`open` attribute for state) | JS-toggled `display: none` |
| Modal or non-modal dialog | `<dialog>` + `showModal()` / `show()`; `<form method="dialog">` to close | Modal libraries, hand-rolled focus traps |
| Action vs. navigation | `<button type="button">` for actions; `<a href>` for navigation | `<div onclick>`, `<a href="#">` |
| Label and group inputs | `<label for>` (or wrapping), `<fieldset>` + `<legend>` | Placeholder-as-label, styled `<div>`s |
| Form validation | `required`, `pattern`, `min`/`max`, `minlength`/`maxlength`, `step`, typed inputs; Constraint Validation API (`checkValidity()`, `setCustomValidity()`) | Validation libraries, regex on submit |
| Typed inputs & pickers | `<input type="email\|tel\|url\|number\|date\|time\|datetime-local\|range\|file\|search">` | Custom date pickers, sliders, masks |
| Choice from a list | `<select>` (+ `<optgroup>`), radio buttons, checkboxes | Custom dropdown widgets |
| Progress & gauges | `<progress>` (task completion), `<meter>` (measurement in a range) | Styled `<div>` bars |
| Computed result | `<output for>` | `<span>` updated by JS |
| Disable a whole subtree | `inert` | Manually disabling each control, `tabindex="-1"` loops |
| Hide content | `hidden` | Inline `style="display: none"` |
| Page structure | `<header> <nav> <main> <aside> <footer> <article> <section>`, `<search>` | `<div class="nav">`, `role="main"` |
| Images & media | `loading="lazy"`, `srcset`/`sizes`, `<picture>`, `<video>`/`<audio controls>` | Lazy-load scripts, custom players |
| Captioned content & data | `<figure>` + `<figcaption>`; `<table>` with `<caption>`, `<thead>`, `<th scope>` | `<div>` grids |
| Inline meaning | `<time datetime>`, `<abbr title>`, `<kbd>`, `<code>`, `<mark>`, `<q>`, `<cite>` | Styled `<span>`s |
| Reusable markup | `<template>`, `<slot>` (shadow DOM) | HTML strings built in JS |

**Works everywhere, but uneven:** `<datalist>` (autocomplete suggestions) and
`<input type="color">` are supported in all major browsers but are not Baseline
due to partial implementations. Use them for progressive enhancement and test on
Safari and Firefox.

## Check support first

Newer features — prefer them over custom JS when the target browsers allow, and
make the page still work (progressive enhancement) where they don't. Verify the
current status on MDN or [webstatus.dev](https://webstatus.dev) before adopting.

| Feature | Replaces | Status |
| --- | --- | --- |
| `popover` + `popovertarget` | Tooltip/menu/toast JS, light-dismiss and top-layer hacks | Baseline newly available |
| `<details name="…">` | Exclusive-accordion JS | Baseline newly available |
| `command` + `commandfor` (invoker commands) | `onclick` that opens a dialog/popover | Baseline newly available |
| `<dialog closedby="any">` | Click-outside-to-close handlers | Limited |
| `hidden="until-found"` | Collapsed content invisible to find-in-page | Limited |
| Customizable `<select>` (`appearance: base-select`) | Fully custom dropdown components | Limited |
| CSS anchor positioning | Popper/Floating UI positioning libraries | Limited |
| `interestfor` (interest invokers) | Hover/focus tooltip JS | Limited |

## Anti-patterns

- `<div onclick>` / `<span onclick>` — not focusable, not keyboard-operable.
- `role="button"` (or any role) where a native element exists.
- `<a>` without `href`, or `<a href="#">` used as a button.
- Accordions/tabs that toggle `display` from JS when `<details>` fits.
- Hand-rolled modal focus traps and backdrops instead of `<dialog>`.
- Inputs without an associated `<label>`; placeholders used as labels.

## Enforcement

- Lint markup with **html-validate** using the `html-validate:recommended` preset;
  it enables `prefer-native-element`, `prefer-button`, and `no-redundant-role`,
  which catch most of the anti-patterns above.
- In Lit projects, add **eslint-plugin-lit-a11y** to lint `` html`…` `` templates.
- If a project already has an HTML or a11y linter configured, keep it rather than
  layering another one on top.

## Libraries & tooling

| Concern | Use |
| --- | --- |
| HTML linting | html-validate (`html-validate:recommended`) |
| Lit template a11y linting | eslint-plugin-lit-a11y |
| Browser support data | MDN, webstatus.dev (Baseline) |
