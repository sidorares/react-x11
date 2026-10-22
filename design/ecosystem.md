# Ecosystem: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/ecosystem.md](../docs/ecosystem.md), the reference, and keep
their original headings so code comments that cite them still resolve.

## The 30-second test

Original wording of the fourth question, with its 2.0.0 history:

4. **Does it expect DOM-shaped events?** Since 2.0.0 the answer is usually
   fine: `<textinput onChange>` hands over a synthetic event with
   `target.value`, `target.name` and a writable `target.value`, so
   `event.target.value` reads the way it does in the DOM. What to check
   instead is the **opposite** direction — a library whose field contract is
   value-in/value-out (`field.handleChange(value)`) now needs one unwrap per
   field, and a bare `onChange={field.handleChange}` stores the event object
   with no error. Grep your own code for `onChange={` on a `<textinput>`.

## What does not work

### Install and import time

The two Jest entries are the same dead end from two directions. Full text:

```
Jest encountered an unexpected token
…
    node_modules/react-x11/src/Reconciler.js:27
    const _require = (0, _nodeModule.createRequire)(import.meta.url);
                                                           ^^^^
    SyntaxError: Cannot use 'import.meta' outside a module
```

`react-x11/src/Reconciler.js` and `src/DevToolsIntegration.js` both call
`createRequire(import.meta.url)`, which cannot be down-compiled to CJS. Jest
_can_ run react-x11 tests, but only in real ESM mode — see
[testing](../docs/ecosystem/testing.md#jest). `node:test` and `vitest` need no
transform at all.

### First interaction

**Two entries left this table in 2.0.0.** `downshift` (a TypeError on the
first keystroke) and `formik`'s `getFieldProps` spread (silent, no error,
the field simply never updated) both had one cause: `<textinput>` called
`onChange(newString)` rather than `onChange(event)`. It now passes a
synthetic event, and both work — see
[forms](../docs/ecosystem/forms.md). They are recorded here because the
symptoms are what a 1.x user searches for.

### Silent failures

The swr one is the most expensive, so here it is in full. `useSWR` fetches
on mount, caches and dedupes correctly. What never happens is focus
revalidation, because swr computes its environment once at import:

```js
// swr/dist/_internal/config-context-*.mjs
const IS_SERVER = !isWindowDefined || isLegacyDeno;
```

In Node there is no global `window`, so `initCache`'s `if (!IS_SERVER)`
branch never runs and neither `initFocus` nor `initReconnect` is ever
called — swr registers zero listeners. The documented React Native escape
hatch does not help either: a custom `initFocus` passed through
`<SWRConfig value={{ provider, initFocus }}>` is never called, because the
guard sits above it. The workaround, and its one gotcha, are on the
[data fetching](../docs/ecosystem/data-fetching.md#swr) page.
