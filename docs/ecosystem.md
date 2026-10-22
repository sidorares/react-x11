# Ecosystem

react-x11 is a React renderer with no DOM: no `document`, no `window`
global, no CSSOM, and the host elements are `<box>`/`<text>`/`<svg>`, not
`<div>`/`<span>`. A package that only touches React — hooks, context, state,
reconciliation — works unchanged; one that reaches for `document`, `window`,
`HTMLElement`, CSS, or renders a `<div>` does not.

That rule decides every verdict below. Each was established by running the
library against react-x11 1.2.0, not by reading its documentation; React
DevTools and Fast Refresh, which react-x11 wires up itself, are documented as
working setups instead.

## The 30-second test

Before installing anything, ask four questions in order. Each has a command.

1. **Does it import?** `node --input-type=module -e "import('the-package')"`.
   A package that hard-requires `react-dom`, or whose `exports` map has only
   browser conditions, fails here ([import time](#install-and-import-time)).
   If something else in your tree already pulled in `react-dom`, this passes
   and the problem moves to the [silent](#silent-failures) column — run
   `npm ls react-dom` before you trust a pass.
2. **Does it render host elements?** Grep the shipped code for tag names:

   ```sh
   grep -rEoh '"(div|span|button|input|form|style|a)"' \
     node_modules/the-package --include='*.js' --include='*.mjs' | sort -u
   ```

   Anything that emits DOM tags cannot render here, however headless the
   README says it is. This one is a reliable verdict: zustand and
   `@tanstack/react-table` print nothing; recharts, react-select and Headless
   UI print a list.

3. **Does it read DOM globals?** Same shape, different pattern:

   ```sh
   grep -rnE 'typeof window|typeof document|HTMLElement|getBoundingClientRect' \
     node_modules/the-package --include='*.js' --include='*.mjs'
   ```

   A pointer, not a verdict — _read the hits_. A minified UMD bundle or an
   `isSSR = typeof window === "undefined"` default matches harmlessly. Look
   for an environment probe whose result gates a feature: that is the
   silent-failure shape, where the library decides it is doing SSR and
   quietly turns things off. Check the transitive core too —
   `@tanstack/query-core`, not just `@tanstack/react-query`, which has no
   hits of its own.

4. **Does it expect DOM-shaped events?** Usually fine: `<textinput onChange>`
   passes a synthetic event with `target.value` (writable) and `target.name`,
   so `event.target.value` reads as it does in the DOM. Check the
   **opposite** direction: a library whose field contract is
   value-in/value-out (`field.handleChange(value)`) needs one unwrap per
   field, and a bare `onChange={field.handleChange}` stores the event object
   with no error. Grep your own code for `onChange={` on a `<textinput>`.

A library that passes all four is almost always a drop-in. One that fails 2
or 3 usually has a headless core published separately — the pattern behind
half the adapters on this page.

## What works

Fifty-five packages and two Node built-ins, across 12 categories. **Out of
the box** means install and use; **adapter** means a little glue, written
out in full on the category page.

### State management

| Package                                      | Integration                                          |                                     |
| -------------------------------------------- | ---------------------------------------------------- | ----------------------------------- |
| `zustand`                                    | out of the box                                       | [state](ecosystem/state.md#zustand) |
| `jotai`                                      | out of the box                                       | [state](ecosystem/state.md#jotai)   |
| `valtio`                                     | out of the box                                       | [state](ecosystem/state.md#valtio)  |
| `xstate` + `@xstate/react`                   | out of the box                                       | [state](ecosystem/state.md#xstate)  |
| `redux` + `@reduxjs/toolkit` + `react-redux` | out of the box — **pin react-redux ≥ 9**             | [state](ecosystem/state.md#redux)   |
| `immer`                                      | out of the box                                       | [state](ecosystem/state.md#immer)   |
| `mobx` + `mobx-react-lite`                   | adapter — no code, but `react-dom` must be installed | [state](ecosystem/state.md#mobx)    |

### Data fetching

| Package                 | Integration        |                                                            |
| ----------------------- | ------------------ | ---------------------------------------------------------- |
| `@tanstack/react-query` | adapter, ~12 lines | [data fetching](ecosystem/data-fetching.md#tanstack-query) |
| `swr`                   | adapter, 1 line    | [data fetching](ecosystem/data-fetching.md#swr)            |

### Forms and validation

| Package                | Integration                                                |                                             |
| ---------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| `@tanstack/react-form` | out of the box                                             | [forms](ecosystem/forms.md#tanstack-form)   |
| `zod`                  | out of the box                                             | [forms](ecosystem/forms.md#zod)             |
| `react-hook-form`      | out of the box — `register()` or `<Controller>`            | [forms](ecosystem/forms.md#react-hook-form) |
| `formik`               | out of the box — no `<Form>`; `<Field>` with a render prop | [forms](ecosystem/forms.md#formik)          |
| `downshift`            | out of the box — `getInputProps()` on a `<textinput>`      | [forms](ecosystem/forms.md)                 |

### Icons

| Package                              | Integration                           |                                              |
| ------------------------------------ | ------------------------------------- | -------------------------------------------- |
| `@iconify/utils` + `@iconify-json/*` | out of the box                        | [icons](ecosystem/icons.md#iconify)          |
| `@heroicons/react`                   | out of the box — size it with `style` | [icons](ecosystem/icons.md#heroicons-react)  |
| `lucide`                             | adapter, ~10 lines                    | [icons](ecosystem/icons.md#lucide)           |
| `lucide-static`                      | adapter, ~12 lines (`iconSource`)     | [icons](ecosystem/icons.md#lucide-static)    |
| `react-icons`                        | adapter, ~15 lines                    | [icons](ecosystem/icons.md#react-icons)      |
| `@tabler/icons`                      | adapter — `iconSource`                | [icons](ecosystem/icons.md#tabler-icons)     |
| `@phosphor-icons/core`               | adapter — `iconSource`                | [icons](ecosystem/icons.md#phosphor-icons)   |
| `heroicons` (the asset package)      | adapter — `iconSource`                | [icons](ecosystem/icons.md#heroicons-assets) |
| `feather-icons`                      | adapter, ~5 lines                     | [icons](ecosystem/icons.md#feather-icons)    |

### Theming, palettes and colour

| Package                               | Integration                         |                                                          |
| ------------------------------------- | ----------------------------------- | -------------------------------------------------------- |
| `@radix-ui/colors`                    | out of the box                      | [theming](ecosystem/theming.md#radix-colors)             |
| `@catppuccin/palette`                 | out of the box                      | [theming](ecosystem/theming.md#catppuccin)               |
| `@material/material-color-utilities`  | out of the box from a source colour | [theming](ecosystem/theming.md#material-color-utilities) |
| `colord`                              | out of the box                      | [theming](ecosystem/theming.md#colord)                   |
| `culori`                              | out of the box                      | [theming](ecosystem/theming.md#culori)                   |
| `open-props`                          | out of the box for colours          | [theming](ecosystem/theming.md#open-props)               |
| `tailwindcss` (`/colors` export only) | adapter, ~3 lines — oklch → hex     | [theming](ecosystem/theming.md#tailwind-colors)          |
| `daltonize`                           | adapter, ~4 lines                   | [theming](ecosystem/theming.md#daltonize)                |

### Animation

| Package                            | Integration                       |                                                            |
| ---------------------------------- | --------------------------------- | ---------------------------------------------------------- |
| `popmotion`                        | out of the box                    | [animation](ecosystem/animation.md#popmotion)              |
| `d3-ease`                          | out of the box                    | [animation](ecosystem/animation.md#d3-ease)                |
| `d3-interpolate`                   | out of the box                    | [animation](ecosystem/animation.md#d3-interpolate)         |
| `@tweenjs/tween.js`                | out of the box                    | [animation](ecosystem/animation.md#tweenjs)                |
| `flubber`                          | out of the box                    | [animation](ecosystem/animation.md#flubber)                |
| `react-transition-group`           | out of the box — with `nodeRef`   | [animation](ecosystem/animation.md#react-transition-group) |
| `@react-spring/core` + `/animated` | adapter, ~20 lines (`createHost`) | [animation](ecosystem/animation.md#react-spring)           |

### Headless components

| Package                 | Integration    |                                                  |
| ----------------------- | -------------- | ------------------------------------------------ |
| `react-stately`         | out of the box | [headless](ecosystem/headless.md#react-stately)  |
| `@tanstack/react-table` | out of the box | [headless](ecosystem/headless.md#tanstack-table) |

### Layout and positioning

| Package                  | Integration                                          |                                                |
| ------------------------ | ---------------------------------------------------- | ---------------------------------------------- |
| `@floating-ui/core`      | adapter, ~35 lines (platform object)                 | [layout](ecosystem/layout.md#floating-ui)      |
| `@tanstack/virtual-core` | adapter, ~40 lines — the core, not the React wrapper | [layout](ecosystem/layout.md#tanstack-virtual) |

### Routing

| Package        | Integration                                  |                                              |
| -------------- | -------------------------------------------- | -------------------------------------------- |
| `wouter`       | out of the box — `wouter/memory-location`    | [routing](ecosystem/routing.md#wouter)       |
| `react-router` | out of the box — `MemoryRouter`, no `<Link>` | [routing](ecosystem/routing.md#react-router) |

### Internationalization

| Package                     | Integration    |                           |
| --------------------------- | -------------- | ------------------------- |
| `i18next` + `react-i18next` | out of the box | [i18n](ecosystem/i18n.md) |

### Testing

| Package                | Integration                                        |                                                     |
| ---------------------- | -------------------------------------------------- | --------------------------------------------------- |
| `node:test` (built-in) | out of the box                                     | [testing](ecosystem/testing.md#runners)             |
| `vitest`               | out of the box                                     | [testing](ecosystem/testing.md#vitest)              |
| `msw`                  | out of the box — `msw/node`                        | [testing](ecosystem/testing.md#msw)                 |
| `fast-check`           | out of the box                                     | [testing](ecosystem/testing.md#fast-check)          |
| `sinon`                | out of the box — one required `toFake` restriction | [testing](ecosystem/testing.md#sinon)               |
| `pixelmatch`           | out of the box                                     | [testing](ecosystem/testing.md#pixelmatch)          |
| `react-test-renderer`  | out of the box — but deprecated upstream           | [testing](ecosystem/testing.md#react-test-renderer) |

### Developer tooling

| Package                                    | Integration                                                |                                                            |
| ------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------- |
| `react-devtools-core`                      | out of the box — already wired behind `REACT_X11_DEVTOOLS` | [dev tooling](ecosystem/dev-tooling.md#react-devtools)     |
| `react-refresh` + `hot-module-replacement` | supported — the `react-x11/refresh` entry point            | [dev tooling](ecosystem/dev-tooling.md#react-refresh)      |
| `node --inspect` (built-in)                | out of the box                                             | [dev tooling](ecosystem/dev-tooling.md#node-inspect)       |
| `0x`                                       | out of the box                                             | [dev tooling](ecosystem/dev-tooling.md#0x)                 |
| `@welldone-software/why-did-you-render`    | out of the box                                             | [dev tooling](ecosystem/dev-tooling.md#why-did-you-render) |

## What does not work

Everything below was reproduced against react-x11 1.2.0, and the error text
is verbatim — if you searched for one of these strings, this is the right
page. Failures come in four flavours, by cost:

- **Install and import time** — loud, immediate, cheap.
- **Render time** — loud, immediate; the message usually names the
  offending element.
- **First interaction** — the tree mounts clean and breaks on the first
  keystroke, with a stack trace that points at the library, not the
  renderer.
- **Silent** — no error, ever. By far the most expensive; read that table
  even if nothing is broken yet.

### Install and import time

| Package                                   | Error                                                                                                                                                 | Use instead                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `react-redux@8`                           | `npm error code ERESOLVE` … `peer react@"^16.8 \|\| ^17.0 \|\| ^18.0" from react-redux@8.1.3`                                                         | `react-redux@9` — [state](ecosystem/state.md#redux)                                                          |
| `react-redux@8` (past ERESOLVE)           | `Error: Cannot find module 'react-dom'` from `react-redux/lib/utils/reactBatchedUpdates.js`                                                           | `react-redux@9`                                                                                              |
| `@tanstack/react-virtual`                 | `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'react-dom' imported from node_modules/@tanstack/react-virtual/dist/esm/index.js`                  | `@tanstack/virtual-core` — [layout](ecosystem/layout.md#tanstack-virtual)                                    |
| `styled-components`                       | `TypeError: styled.div is not a function`                                                                                                             | `createStyles`/`ThemeProvider` + a palette package — [theming](ecosystem/theming.md)                         |
| `react-scan`                              | `Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './auto' is not defined by "exports" in node_modules/react-scan/package.json imported from …` | React's own `<Profiler>`, or why-did-you-render — [dev tooling](ecosystem/dev-tooling.md#why-did-you-render) |
| `@testing-library/react` (no `react-dom`) | `Error: Cannot find module 'react-dom/test-utils'`                                                                                                    | `react-x11/test` on `node:test` or `vitest` — [testing](testing.md)                                          |
| `jest` (no ESM config)                    | `Jest encountered an unexpected token` … `SyntaxError: Cannot use import statement outside a module`                                                  | `node:test`/`vitest`, or Jest in ESM mode — [testing](ecosystem/testing.md#jest)                             |
| `jest` (transformed to CJS)               | `SyntaxError: Cannot use 'import.meta' outside a module`                                                                                              | as above                                                                                                     |

The `styled-components` error is misleading: it fires at module evaluation,
mentions neither react-x11 nor the DOM, and looks like a version mismatch.

```js
import styled from 'styled-components';
const Panel = styled.div`
  background: #1e1e2e;
`; // throws right here
```

Under plain Node ESM (how react-x11 apps run, with no bundler) the default
import resolves to the CJS module namespace — an object with
`ServerStyleSheet` and friends, and no `.div`. Fixing the interop with
`const styled = sc.default ?? sc` only moves you to
`react-x11: unknown element type <div>`; `styled('box')` is in
[silent failures](#silent-failures).

The two Jest entries are the same dead end from two directions. Full text:

```
Jest encountered an unexpected token
…
    node_modules/react-x11/src/Reconciler.js:27
    const _require = (0, _nodeModule.createRequire)(import.meta.url);
                                                           ^^^^
    SyntaxError: Cannot use 'import.meta' outside a module
```

react-x11 calls `createRequire(import.meta.url)`, which cannot be
down-compiled to CJS, so Jest runs react-x11 tests only in real ESM mode —
see [testing](ecosystem/testing.md#jest).

### Render time

The renderer's own errors are prefixed `react-x11:` and name the element it
could not create. By far the most common failure; the tag tells you which
library layer broke.

| Package                              | Error                                                                                                                                                                               | Use instead                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `framer-motion`                      | `react-x11: uncaught error Error: react-x11: unknown element type <div>. Supported: <window>, <popup>, <box>, <text>, <image>, <canvas>, <textinput>, <textarea>, <svg>, <glarea>.` | popmotion, `@tweenjs/tween.js`, d3-ease + d3-interpolate — [animation](ecosystem/animation.md)        |
| `framer-motion` (value layer)        | `ReferenceError: HTMLElement is not defined`                                                                                                                                        | popmotion — [animation](ecosystem/animation.md#popmotion)                                             |
| `recharts`                           | `react-x11: uncaught error Error: react-x11: unknown element type <div>. …`                                                                                                         | d3-scale + d3-shape into the `<svg>` host — [below](#charting)                                        |
| `formik` (`<Form>` with a `<Field>`) | `react-x11: uncaught error Error: react-x11: unknown element type <input>. …`                                                                                                       | a `<Field>` render prop onto a `<textinput>` — [forms](ecosystem/forms.md#formik)                     |
| `formik` (`<Form>` alone)            | `react-x11: uncaught error Error: react-x11: unknown element type <form>. …`                                                                                                        | no `<Form>`; call `submitForm()` from a `Button`                                                      |
| `@headlessui/react` (`Switch`)       | `react-x11: uncaught error Error: react-x11: unknown element type <button>. …`                                                                                                      | react-x11's built-in widgets — [components](components.md)                                            |
| `@headlessui/react` (`Dialog`)       | `react-x11: uncaught error Error: react-x11: unknown element type <span>. …`                                                                                                        | react-x11's built-in `Dialog`                                                                         |
| `@radix-ui/react-dialog`             | `react-x11: uncaught error Error: react-x11: unknown element type <button>. …`                                                                                                      | react-x11's built-in `Dialog`                                                                         |
| `react-select`                       | `react-x11: uncaught error Error: react-x11: unknown element type <style>. …`                                                                                                       | react-x11's built-in `Select`                                                                         |
| `@emotion/styled`                    | `react-x11: uncaught error Error: react-x11: unknown element type <style>. …`                                                                                                       | `createStyles` + `ThemeProvider` — [styling](styling.md)                                              |
| `react-dropzone`                     | `react-x11: uncaught error Error: react-x11: unknown element type <input>. …`                                                                                                       | built-in `useDropTarget` / `<box dropAccept onDrop>` — [drag and drop](drag-and-drop.md)              |
| `react-router-dom` (`BrowserRouter`) | `react-x11: uncaught error ReferenceError: document is not defined` at `getUrlBasedHistory`                                                                                         | `MemoryRouter` — [routing](ecosystem/routing.md#react-router)                                         |
| `react-router-dom` (`<Link>`)        | `react-x11: uncaught error Error: react-x11: unknown element type <a>. …`                                                                                                           | `useNavigate()` on a `<box onClick>`                                                                  |
| `lucide-react`                       | `react-x11: uncaught error Error: react-x11: <svg width=…> is a style property — pass it in style: <svg style={{ width: … }} />`                                                    | `@iconify-json/lucide`, or `lucide` — [icons](ecosystem/icons.md)                                     |
| `@tabler/icons-react`                | `react-x11: uncaught error Error: react-x11: <svg width=…> is a style property — pass it in style: <svg style={{ width: … }} />`                                                    | `@iconify-json/tabler`, or `@tabler/icons` — [icons](ecosystem/icons.md#tabler-icons)                 |
| `@phosphor-icons/react`              | `react-x11: uncaught error Error: react-x11: <svg width=…> is a style property — pass it in style: <svg style={{ width: … }} />`                                                    | `@iconify-json/ph`, or `@phosphor-icons/core` — [icons](ecosystem/icons.md#phosphor-icons)            |
| `@testing-library/react`             | `ReferenceError: document is not defined` at `render (node_modules/@testing-library/react/dist/pure.js:256:5)`                                                                      | `renderX11` from `react-x11/test` — [testing](testing.md)                                             |
| `@testing-library/dom` (`within`)    | `TypeError: Expected container to be an Element, a Document or a DocumentFragment but got WindowNode.`                                                                              | `within` from `react-x11/test` — [testing](testing.md)                                                |
| `@testing-library/dom` (`screen`)    | `TypeError: For queries bound to document.body a global document has to be available... Learn more: https://testing-library.com/s/screen-global-error`                              | `screen` from `react-x11/test` — [testing](testing.md)                                                |
| `@testing-library/user-event`        | `TypeError: Cannot read properties of undefined (reading 'Symbol(Node prepared with document state workarounds)')`                                                                  | `userEvent` from `react-x11/test`, or raw ntk events — [testing](ecosystem/testing.md#driving-events) |
| `jest-image-snapshot`                | `TypeError: The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received an instance of Object`                      | `getImageData` + `pngjs` + `pixelmatch` — [testing](ecosystem/testing.md#pixelmatch)                  |
| `react-x11` test selectors           | `Error: Test selector API is not supported by this renderer.`                                                                                                                       | nothing — `supportsTestSelectors` is `false`                                                          |

Four of those need detail, because the obvious workaround fails.

**framer-motion cannot be rescued by dropping to its value layer.** Reaching
past `motion.div` fails too:

```js
import { animate, motionValue } from 'framer-motion';
const mv = motionValue(0);
mv.on('change', (v) => console.log(v));
animate(mv, 100, { duration: 0.1 });
// ReferenceError: HTMLElement is not defined
```

`motion-dom` feature-detects the Web Animations API with
`subject instanceof HTMLElement`, so `animate()` on a plain `motionValue`
still throws, asynchronously, once keyframes resolve (from
`motion-dom/src/animation/waapi/supports/waapi.ts`). Use popmotion's
`animate()` instead.

**The Radix escape hatch is worse than the error.**
`<Dialog.Portal><Dialog.Content /></Dialog.Portal>` produces no error and no
output: `Portal` is SSR-guarded, finds no `document`, and renders nothing.
Every Radix primitive has that shape. (`@radix-ui/colors` is pure data and
[recommended](ecosystem/theming.md#radix-colors).)

**react-dropzone fails twice.** Deleting the `<input>` does not rescue it:
with only `<box {...getRootProps()} />` you get past the reconciler and then
hit `react-x11: uncaught error ReferenceError: window is not defined`,
thrown from react-dropzone's own mount effect.

**The three `*-react` icon packages produce a byte-identical error**, not
"unknown element type": react-x11 has a real `<svg>` host, so the icon gets
further and dies on the flat `width`/`height` props those wrappers always
set. No prop avoids it. `@heroicons/react` is the
[exception](ecosystem/icons.md#heroicons-react): it sizes with a class name,
so it renders.

Index notes for searchers:

- `react-select` reports `<style>`, not `<div>`: it is built on Emotion, and
  the first host it emits is Emotion's injected style tag.
- `formik` reports `<input>` when your `<Form>` has a `<Field>` in it and
  `<form>` when it does not, because the reconciler completes children
  first.
- `react-router-dom`'s `<Link>` with a bare string child hits the raw-text
  error first: `react-x11: raw text "go" must be wrapped in a <text> element
(or be the string child of an SVG <text>).`

#### Charting, without recharts {#charting}

The substitute for `recharts` is small: compute with `d3-scale` +
`d3-shape` and emit the path into react-x11's own `<svg>` host.

```jsx
import { scaleLinear } from 'd3-scale';
import { line } from 'd3-shape';

const data = [
  [0, 3],
  [1, 7],
  [2, 4],
  [3, 9],
  [4, 6],
];
const x = scaleLinear().domain([0, 4]).range([0, 200]);
const y = scaleLinear().domain([0, 10]).range([100, 0]);
const d = line()
  .x((p) => x(p[0]))
  .y((p) => y(p[1]))(data);

<svg style={{ width: 200, height: 100 }} viewBox="0 0 200 100">
  <path d={d} stroke="#89b4fa" fill="none" strokeWidth={2} />
</svg>;
```

The `<canvas>` host with an `onDraw` handler is the other option, and the
better one for dense plots.

### First interaction

These mount without an error; the first sign of trouble is a keystroke.

Nothing currently fails here. `downshift` (a TypeError on the first
keystroke) and `formik`'s `getFieldProps` spread (the field silently never
updated) did on 1.x, when `<textinput>` called `onChange(newString)`; it now
passes a synthetic event and both work ([forms](ecosystem/forms.md)). The
two shapes this class of bug takes:

- A handler that reads `event.nativeEvent.<something>` **unguarded** works
  for a keystroke and throws for a paste or an undo, where there is no X
  event to report. downshift reads
  `event.nativeEvent.preventDownshiftDefault` this way, and is safe only
  because it checks `hasOwnProperty('nativeEvent')` first and the property
  is always present.
- A library that writes through a ref — `ref.value = ''` — needs the node to
  have a value **setter**. `<textinput>` has one; most nodes do not, and the
  TypeError is thrown inside the commit phase, taking the render down rather
  than one handler.

### Silent failures

No error is ever printed. Read this table before you spend an afternoon.

| Package                                                | What happens                                                                                                                                                  | Fix                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `swr`                                                  | `(silent) data never refetches when the X11 window regains focus — no error, no warning, revalidateOnFocus just never fires`                                  | define `globalThis.window` before importing swr, or use `@tanstack/react-query` — [data fetching](ecosystem/data-fetching.md#swr) |
| `@tanstack/react-virtual` (with `react-dom` installed) | `(silent) with react-dom installed the import resolves and the list renders, but the flushSync re-measure applies to react-dom's reconciler, not react-x11's` | `@tanstack/virtual-core` — [layout](ecosystem/layout.md#tanstack-virtual)                                                         |
| `react-scan`                                           | `(silent) no error, no output — onRender never fires and getReport() stays empty`                                                                             | React's own `<Profiler>` (verified working), or why-did-you-render                                                                |
| `@radix-ui/react-dialog` (`Dialog.Portal`)             | renders nothing; the SSR guard finds no `document`                                                                                                            | react-x11's built-in `Dialog`                                                                                                     |
| `styled-components` (`styled('box')`)                  | renders with no error and hands the box a single `className` prop, which react-x11 ignores — the CSS goes nowhere                                             | `createStyles` + `ThemeProvider`                                                                                                  |
| `tailwindcss/colors` (raw values)                      | v4 ships `oklch()` strings; ntk's parser returns null and paints nothing                                                                                      | convert with `culori` — [theming](ecosystem/theming.md#tailwind-colors)                                                           |

The swr one is the most expensive. `useSWR` fetches, caches and dedupes,
but swr decides once at import that a process with no global `window` is a
server and registers no focus or reconnect listeners — not even a custom
`initFocus` passed through `<SWRConfig value={{ provider, initFocus }}>`,
the documented React Native escape hatch. Details and the workaround:
[data fetching](ecosystem/data-fetching.md#swr).

`@tanstack/react-virtual` is subtle differently. `react-dom` is a _required_
peer, so a default `npm i @tanstack/react-virtual` installs it and the
import-time error never appears; `react-dom@19`'s `flushSync()` outside any
react-dom root runs the callback without throwing, so nothing warns you that
the virtualizer's synchronous flush happens in the wrong renderer.

## Adding a library that is not listed

Run the [30-second test](#the-30-second-test) first; it settles most cases
without an install. If it passes, render it:

```jsx
// probe.jsx — needs a display: run under $DISPLAY, or `xvfb-run -a`
import { createRoot } from 'react-x11';
import { TheThing } from 'the-package';

(await createRoot()).render(
  <window width={300} height={200} title="probe">
    <box style={{ flexGrow: 1 }}>
      <TheThing />
    </box>
  </window>,
);
```

Four outcomes:

- **`react-x11: unknown element type <…>`** — the library renders DOM hosts.
  Look for a headless core published as a separate package; that is what
  rescued TanStack Virtual, Floating UI and react-spring.
- **`react-x11: <… width=…> is a style property`** — it reached a real
  react-x11 host and passed a flat style prop. Usually fixable by wrapping
  the component rather than replacing it.
- **`ReferenceError: document is not defined`** (or `window`, or
  `HTMLElement`) — a DOM global at module or mount time. Look for a
  documented environment-override seam, like `@tanstack/react-query`'s
  `environmentManager`.
- **It renders.** Then type into it, click it, and resize the window; the
  event-shape and silent classes only show up here.

If you establish a result either way, open an issue on
[the react-x11 repository](https://github.com/sidorares/react-x11/issues)
with the package name, its exact version, the code you ran, and the verbatim
output. Negative results are as useful as positive ones.
