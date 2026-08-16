# Packaging and distribution

Four ways to ship a react-x11 app, cheapest first. Every recipe here was
run; where something does not work, the reason is measured rather than
guessed.

| tier                            | works                      | cost                           |
| ------------------------------- | -------------------------- | ------------------------------ |
| 1. plain `npm install`          | yes                        | a `node_modules` on the target |
| 2. a single `.mjs`              | yes, with one esbuild flag | one file, ~7 MB                |
| 3. Node single executable (SEA) | yes, as CommonJS           | one file, ~142 MB              |
| 4. AppImage / `.deb`            | yes, wrapping tier 1 or 2  | packaging metadata             |

## Tier 1 — `npm install`

The default, and fine for a server-side app, a CI tool, or anything already
deployed with a package manager. Nothing to say beyond: the package is ESM
(`"type": "module"`), it needs Node ≥ 22, and it has **no native
dependencies** — ntk, node-x11 and yoga-layout are pure JavaScript and WASM,
so there is no node-gyp, no prebuild matrix, and `npm install` on a fresh
box just works.

## Tier 2 — one `.mjs` file

```sh
esbuild app.jsx --bundle --platform=node --format=esm --outfile=app.mjs \
  --banner:js="import{createRequire as __cjsRequire}from'node:module';const require=__cjsRequire(import.meta.url);"

node app.mjs
```

Three things about that command are load-bearing.

**`--format=esm` is the easy path, not the only one.** It tolerates top-level
await anywhere in the graph; `cjs` does not, and refuses to build with
`Top-level await is currently not supported with the "cjs" output format`.
Nothing in this stack forces the issue — ntk has had no top-level await
since 5, and the layout engine, which was the other source of one, is loaded
rather than imported here (below). See
[tier 3](#tier-3--node-single-executable), which needs `cjs`; the choice is
only about what your own code does at module scope.

**The `--banner:js` is not optional.** node-x11 is CommonJS and uses dynamic
`require`, which esbuild cannot resolve statically. Without the banner the
bundle builds cleanly and then dies at startup:

```
Error: Dynamic require of "events" is not supported
```

The banner defines the `require` that shim calls. This is an upstream gap —
node-x11 wants an ESM entry point, or `node:`-prefixed requires — and until
it closes, the banner is the fix.

**The banner's import must be aliased.** The obvious form, `import
{createRequire} from 'node:module'`, collides with react-x11's own import of
the same name and the bundle fails to parse with `Identifier 'createRequire'
has already been declared`. Hence `as __cjsRequire` above. That one costs an
afternoon if you meet it without warning.

Two things that are _not_ problems, and are worth knowing because they
usually are:

- **yoga-layout is bundler-safe.** Its WASM is base64-inlined into the
  JavaScript, so nothing is emitted beside the bundle and nothing needs a
  loader rule or a copy step. Verified: no `.wasm` file appears, and the
  bundle renders.
- **`keysym` is gone.** It used to read a JSON file off disk at module load
  and broke every bundle; ntk 4.3.0 no longer depends on it. If you are
  reading an older account of this, that half is fixed.

Verified end to end: bundling an app that imports `react-x11`, `react` and
node-x11's in-process X server produces a 7 MB `app.mjs` that mounts a tree,
paints, and reads its own pixels back.

If you use react-x11's [DevTools](devtools.md) or
[click-to-component](click-to-component.md) integrations, note that they are
dynamically imported behind environment variables. A bundler will pull in
`ws` and `node:child_process` for them; if you do not want that, stub them
out with a resolver plugin the way
`website/scripts/build-demo-bundles.mjs` does.

## Tier 3 — Node single executable

```sh
esbuild app.jsx --bundle --platform=node --format=cjs --outfile=app.cjs
node --build-sea=sea.json          # { "main": "app.cjs", "output": "myapp" }
./myapp
```

```json
{ "main": "app.cjs", "output": "myapp", "disableExperimentalSEAWarning": true }
```

This did not work until recently, and the reason is worth keeping: Node's SEA
evaluates the embedded main as **CommonJS** — there is no `package.json`
inside the blob for it to consult, and the `.mjs` name has no effect on an
embedded script — while the stack forced ESM, because esbuild will not emit
CommonJS for a graph containing top-level await. The await came from the
layout engine: `yoga-layout`'s default entry is
`const Yoga = wrapAssembly(await loadYoga())`, and every app inherited it.
`src/yoga.js` loads the engine through `yoga-layout/load` instead — enums
synchronously, WebAssembly during `createRoot()` — and react-x11 moved its
own three `await import()`s for DevTools, click-to-component and tracing out
of module scope. Nothing in the graph has a top-level await now, and
`test/yoga.test.js` fails the build if an import puts one back.

Verified: a bundle of react-x11, react, ntk and node-x11's in-process X
server mounts a 40-row tree and paints it — 157 requests in 7 socket writes —
from a single 142 MB file, most of which is node itself.

What the CommonJS format costs you, in your own code:

- **No top-level `await`.** Put startup in an `async function main()`;
  `const root = await createRoot()` at the top level of your entry is enough
  to fail the build. esbuild names the file and line, so this is a
  five-second fix rather than a mystery.
- **`import.meta.url` is `undefined`.** Anything resolving paths through it
  needs `process.execPath` or a literal. react-x11 already guards its own
  use of it (the version string DevTools shows falls back rather than
  throwing); check your app for the same pattern.
- **Runtime module loading is out.** Inside a SEA, `require()` _and_
  `import()` resolve **built-in modules only** — a `data:` or `file:` URL
  import fails with `ERR_UNKNOWN_BUILTIN_MODULE`. A bundle has nothing left
  to resolve, so this only bites if you meant to load something later. It
  also closes the obvious workaround for the old ESM problem: you cannot
  carry an ESM bundle as a SEA asset and import it.
- **Assets are not files.** `sea.getAsset()` reads what the config's
  `assets` map embedded; fonts are the usual case, and `StaticFontSource`
  takes bytes directly ([ntk's fonts guide][ntk-fonts]).

On macOS the binary must be re-signed before it runs
(`codesign --remove-signature myapp && codesign --sign - myapp`); on Linux
nothing extra. Measured on Node 26.

[ntk-fonts]: https://github.com/sidorares/ntk/blob/master/docs/fonts.md

## Tier 4 — AppImage, `.deb`, `.rpm`

These wrap tier 1 or tier 2; the packaging is the desktop-integration
metadata rather than anything about JavaScript.

- A **`.desktop` file** — without one, the app has no launcher entry, no
  icon in the dock, and no association with its own windows. Its `StartupWMClass`
  must match the `wmClass` prop on your `<window>`
  ([elements.md](elements.md)), or the desktop groups your window under the
  wrong icon.
- **Icons** at 48, 128 and 256 px under
  `usr/share/icons/hicolor/<size>/apps/`. Set `_NET_WM_ICON` too, which the
  window manager reads for the titlebar and alt-tab; the WM example already
  reads both sources ([AGENTS.md](../AGENTS.md), "Writing a window
  manager").
- **Node itself**, if you are not depending on a system one. That is most of
  the size.

Nothing here is react-x11-specific — any Node desktop app packages the same
way — which is why this section is short rather than absent.

## Checklist

- Pick the format deliberately: `--format=esm` (tier 2, needs the banner) or
  `--format=cjs` (tier 3, needs no top-level await in your own code).
- With `esm`, alias the banner's `createRequire`.
- Do not ship `.Xauthority`, and do not bake `DISPLAY` into an image —
  [security.md](security.md).
- Set `wmClass` and match it in `StartupWMClass`.
- Test on a display you did not develop on. Fonts are the usual surprise:
  family resolution goes through `fc-match`, so `sans-serif` is a different
  face on the target ([remote.md](remote.md#the-other-x-servers), issue #86).

## Upstream

One thing would delete the rest of the friction here:

- **node-x11: ESM sources** ([node-x11#246][x11-246]). That removes tier 2's
  banner, which is now the only real trap on the page. Note the tempting
  cheaper version does not work: `node:`-prefixed requires change nothing,
  because esbuild wraps a CommonJS module either way and its `require` shim
  throws in ESM output regardless of the specifier — measured, not assumed.

ESM support for a SEA's embedded main would be welcome in Node, but it is no
longer load-bearing: tier 3 works as CommonJS.

[x11-246]: https://github.com/sidorares/node-x11/issues/246
