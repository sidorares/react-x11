# AGENTS.md

Guidance for AI agents (and new contributors) working on react-x11.

## What this project is

A custom React renderer whose host environment is an X11 server. Rendering a
`<window>` element creates a real X11 window; props like `width`/`height`/`x`/
`y`/`title` map to X11 window operations. All X11 communication happens over
[ntk](https://github.com/sidorares/ntk) /
[node-x11](https://github.com/sidorares/node-x11) — pure JavaScript
implementations of the X11 protocol, no native bridge for the protocol itself.

Status: experimental, recently revived after several years of pause. Only the
`<window>` host component exists. The long-term goal (see README and issues) is
windowless controls, a small widget library, and yoga-layout powered layout.

## Layout

- `src/index.js` — public entry point, re-exports the renderer.
- `src/Reconciler.js` — the whole renderer: react-reconciler host config plus
  `render()` / `unmountComponentAtNode()`. Written against
  react-reconciler 0.33 (React 19). If you upgrade react-reconciler, expect
  host config contract changes; the smoke test is the safety net.
- `src/DevToolsIntegration.js` — opt-in React DevTools bridge, enabled with
  `REACT_X11_DEVTOOLS=1` (needs `react-devtools-core` + `ws`, dev-only).
- `examples/` — runnable demos (need a real X server, see below).
- `test/smoke.test.js` — headless smoke tests using a mock ntk app object.

## Commands

- `npm test` — node:test based smoke tests. **Headless: no X server needed.**
  This is the primary feedback loop; keep it green and extend it when touching
  the host config.
- `npm run lint` / `npm run format` — ESLint 9 (flat config) + Prettier.
- `npm run examples:simple` (JSX via tsx), `examples:simple-nojsx`,
  `examples:xeyes` — need a running X server (`DISPLAY` set; XQuartz on
  macOS, Xvfb works for automation).

## Gotchas

- `ntk` (>= 3.0.0) is a required dependency, currently consumed from git
  (`github:sidorares/ntk`) until the next version is published to npm. It is
  pure JavaScript — no native modules, nothing compiles at install time.
- ntk is **ESM with top-level await** in its module graph, so it cannot be
  `require()`d from this CommonJS codebase — only dynamic `import('ntk')`
  works. That's why `connectAndRender` in `src/Reconciler.js` is async, and
  why `ntk.createClient()` is promise-based there.
- `test/smoke.test.js` renders with a mock container (fast, pins the host
  config contract) — if you use a new ntk window method in the host config,
  add it to the mock. `test/integration.test.js` runs end-to-end against
  node-x11's in-process pure-JS X server (see ntk `docs/xserver.md`), so no
  `$DISPLAY` is needed even for the real-client path.
- Child (non-top-level) windows are created with `overrideRedirect: true`,
  then reparented into their parent and mapped in `commitMount`/`appendChild`.
  That ordering is load-bearing; the first smoke test pins it.
- `render()` uses `updateContainerSync` + `flushSyncWork`, so mounts/updates
  are applied synchronously — tests rely on that.
- Instance bookkeeping uses `__children` arrays and a `_reactFiber` field
  stashed on ntk window objects.
- Text nodes are not supported (`createTextInstance` throws on purpose).

## Style

- CommonJS (`require`/`module.exports`) throughout, except the dynamic
  `import('ntk')` noted above. ESM migration is possible future work.
- Prettier (single quotes) is the formatter; run it before committing.
- Conventional commit messages (`feat:`, `fix:`, `chore:`, ...) — releases are
  automated with release-please, which reads commit messages to compute
  versions and changelogs.

## Roadmap pointers (open GitHub issues)

- #2 / #14 — migrate to a current yoga-layout and add a layout example.
- #13 — consider react-native-dom-like architecture.
- #4 — top-down rendering investigation.
- #3 — window manager example using mosaic.
- #10 — reuse ideas/code from mylittledom.
