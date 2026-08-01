# Packaging and distribution

Four ways to ship a react-x11 app, cheapest first. Every recipe here was
run; where something does not work, the reason is measured rather than
guessed.

| tier                            | works                      | cost                           |
| ------------------------------- | -------------------------- | ------------------------------ |
| 1. plain `npm install`          | yes                        | a `node_modules` on the target |
| 2. a single `.mjs`              | yes, with one esbuild flag | one file, ~7 MB                |
| 3. Node single executable (SEA) | **no** — see below         | —                              |
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

**`--format=esm`, not `cjs` or `iife`.** yoga-layout's WASM loader and ntk's
module graph both use top-level await, and esbuild only emits it in ESM. A
`cjs` build does not produce a broken bundle; it refuses to build, with
`Top-level await is currently not supported with the "cjs" output format`.

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

## Tier 3 — Node single executable: does not work

Building the blob succeeds. Running it does not:

```
Warning: Failed to load the ES module: app.mjs. Make sure to set
"type": "module" in the nearest package.json file or use the .mjs extension.
```

The cause is precise, and it is not fixable from this side. Node's SEA
evaluates the embedded main script as **CommonJS** — there is no
`package.json` inside the blob for it to consult, and the `.mjs` name has no
effect on an embedded script. This stack cannot be CommonJS, because of the
top-level await in tier 2. So the two requirements are in direct conflict:
SEA wants CJS, yoga and ntk require ESM.

Nothing to work around today. It needs ESM support for SEA's embedded main
in Node itself. (Measured on Node 26; the blob builds and `postject` injects
fine, so if that lands, everything else here is already in place.)

For a genuine single file, tier 2 plus a shebang and `chmod +x` gets you
most of the way — it needs a Node on the target, which SEA is what avoids.

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

- `--format=esm`. It is not a preference.
- Alias the banner's `createRequire`.
- Do not ship `.Xauthority`, and do not bake `DISPLAY` into an image —
  [security.md](security.md).
- Set `wmClass` and match it in `StartupWMClass`.
- Test on a display you did not develop on. Fonts are the usual surprise:
  family resolution goes through `fc-match`, so `sans-serif` is a different
  face on the target ([remote.md](remote.md#the-other-x-servers), issue #86).

## Upstream

Two things would delete most of this page:

- **node-x11: an ESM entry point, or `node:`-prefixed requires.** That
  removes the banner, which is the only real trap in tier 2.
- **Node: ESM support for a SEA's embedded main.** That unlocks tier 3
  entirely.
