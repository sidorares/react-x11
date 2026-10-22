# Testing

Testing Library does not work here and no shim will fix it: its queries are
built on a DOM document. Its five failure modes are in the
[negative-results register](../ecosystem.md#render-time); a jsdom shim only
makes the query fail differently.

The replacement ships in the box: **[`react-x11/test`](../testing.md)** —
`renderX11`, `screen`, `userEvent`, `waitFor` and pixel assertions, over a
real X server running in your test process. Read that page first. Below is
the hand-rolled version, for a test that wants the connection itself, and
the third-party runners and tools that work alongside it.

## The harness, by hand {#harness}

node-x11 ships a pure-JS X server that runs in your test process, so a test
needs no `$DISPLAY`, no Xvfb, and no native dependency. This is what
`renderX11` does, spelled out for a test that holds the pieces directly.

```jsx
// helpers/harness.jsx
import React from 'react';
import { createRoot } from 'react-x11';
import xserver from 'x11/lib/xserver/index.js';

export async function createHeadlessRoot() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  // `stream` reaches a server that is not on the other end of $DISPLAY,
  // which is the whole trick; the root owns the connection and closes it
  // on unmount.
  return await createRoot({ stream: clientEnd });
}

/** The render callback hands back the ntk window instance. `root.render`
 * is synchronous, so this stays a plain helper — only obtaining the root
 * is async, and that happens once. */
export const render = (root, element) =>
  new Promise((resolve) => root.render(element, (wnd) => resolve(wnd)));

export const tick = () => new Promise((r) => setImmediate(r));
```

```jsx
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeadlessRoot, render, tick } from './helpers/harness.jsx';

test('paints a box', async () => {
  const root = await createHeadlessRoot();
  const wnd = await render(
    root,
    <window width={320} height={240} title="probe">
      <box style={{ flexGrow: 1, backgroundColor: '#204080' }} />
    </window>,
  );
  await tick(); // layout runs on the frame clock, after the commit

  const node = wnd._reactX11Node; // the root drawn node
  assert.equal(node.children[0].kind, 'box');
  assert.deepEqual(node.children[0].abs, {
    x: 0,
    y: 0,
    width: 320,
    height: 240,
  });

  await root.unmount();
});
```

**The `tick()` is not optional.** `render`'s callback resolves at commit;
layout runs a task later on the frame clock, so every `abs` rect is
`{x: 0, y: 0, width: 0, height: 0}` until you yield once. Assert on `kind`
and `props` immediately, never on geometry.

`wnd._reactX11Node` is the root of the drawn tree. Each node carries `kind`
(the element name), `props`, `children`, and `abs` (its laid-out rect):
walk it. It is not a DOM; `ownerDocument` and `getClientRects()` exist only
because React DevTools' `measureHostInstance` dereferences them.

A `<text>` node holds `textchunk` children whose `.text` is the string:

```js
export function textOf(node) {
  const out = [];
  (function walk(n) {
    if (n.kind === 'textchunk') out.push(n.text);
    (n.children ?? []).forEach(walk);
  })(node);
  return out.join('');
}
```

To run with no X server at all — faster, and enough for most component
tests — pass `createRoot({ app })` a mock ntk app that records canvas
operations instead of painting them. `react-x11/test` exports the one the
renderer's unit tests use, `createMockApp()`, and
`renderX11(el, { backend: 'mock' })` builds it for you
([mock backend](../testing.md#the-mock-backend)).

## Driving events {#driving-events}

`@testing-library/user-event` throws on `setup()`
([register](../ecosystem.md#render-time)); use `react-x11/test`'s
`userEvent`, or emit the raw ntk event on the window. react-x11 subscribes
to the ntk window's emitter, so this exercises the whole synthetic-event
path: hit testing, capture, bubble, default actions.

```jsx
test('a synthetic click reaches the handler', async () => {
  const root = await createHeadlessRoot();
  let clicks = 0;
  const wnd = await render(
    root,
    <window width={200} height={100}>
      <box style={{ flexGrow: 1 }} onClick={() => (clicks += 1)} />
    </window>,
  );
  await tick();

  wnd.emit('mousedown', { x: 20, y: 20, button: 1, buttons: 1 });
  wnd.emit('mouseup', { x: 20, y: 20, button: 1, buttons: 0 });
  await tick();

  assert.equal(clicks, 1);
  await root.unmount();
});
```

Keyboard input is the same shape — `wnd.emit('keydown', { keycode,
codepoint, buttons })` — with the keysym registered in
`app.X.keycode2keysyms` so the renderer can resolve it. `button` is the X
button number: left is `1`, not `0`.

## Runners {#runners}

**`node:test` (built-in) is the baseline.** react-x11's own suite uses it,
and it handles the ESM graph without configuration. Run `.jsx` files through
`tsx`: `node --import tsx --test 'test/**/*.test.jsx'`.

### Vitest {#vitest}

**Out of the box.** vitest@4.1.10.

Native ESM, built-in JSX and TypeScript transform, watch mode, snapshots. A
`.test.jsx` that mounts a tree, drives a prop update and asserts on the node
tree and the paint-op log runs green with no flags. The one setting that
matters:

```js
// vitest.config.mjs
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node' }, // the default; never 'jsdom'
  esbuild: { jsx: 'automatic' },
});
```

**Never `environment: 'jsdom'`.** It _defines_ `window` and `document`,
which silently flips environment detection in third-party libraries —
`@tanstack/query-core` decides it is in a browser and changes retry and
refetch behaviour, for one. `'node'` is the default; do not copy a web
project's config across.

- Vitest runs test files in worker threads by default. The in-process X
  server works there; `pool: 'forks'` is the escape hatch if long-lived
  server streams misbehave.
- `vi.useFakeTimers()` shares the [sinon caveat](#sinon): pass an explicit
  `toFake` list, or React's scheduling and the renderer's paint scheduling
  freeze.

### Jest {#jest}

**Works, but only in real ESM mode.** jest@30.4.2.

Jest's default CJS path cannot work: `babel-jest` down-compiles to
CommonJS, and `react-x11/src/Reconciler.js` and `src/DevToolsIntegration.js`
call `createRequire(import.meta.url)`, which has no CJS equivalent, so Jest's
own suggestions lead to
`SyntaxError: Cannot use 'import.meta' outside a module`. Both dead ends are
in the [register](../ecosystem.md#install-and-import-time). What works:

```js
// jest.config.mjs — run with NODE_OPTIONS=--experimental-vm-modules
export default {
  extensionsToTreatAsEsm: ['.jsx'],
  transform: {
    '\\.jsx$': [
      'babel-jest',
      {
        presets: [
          [
            '@babel/preset-env',
            { modules: false, targets: { node: 'current' } },
          ],
          ['@babel/preset-react', { runtime: 'automatic' }],
        ],
      },
    ],
  },
};
```

`modules: false` is the load-bearing part: with no CJS transform, Jest runs
the same ESM graph as everything else. `node:test` and Vitest need none of
this.

## msw {#msw}

**Out of the box — `msw/node`.** msw@2.15.0.

Request-level API mocking. In Node, `setupServer` patches `http`, `https`,
`fetch`/undici and `XMLHttpRequest`, so `http.get(url, resolver)` handlers
intercept real requests — no service worker, no DOM. A react-x11 app's data
layer is ordinary Node networking: components call `fetch`, msw answers, the
renderer repaints.

```jsx
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const server = setupServer(
  http.get('https://api.example.test/user', () =>
    HttpResponse.json({ name: 'Ada' }),
  ),
);
before(() => server.listen({ onUnhandledRequest: 'error' }));
after(() => server.close());

function User() {
  const [name, setName] = React.useState('loading');
  React.useEffect(() => {
    let alive = true;
    fetch('https://api.example.test/user')
      .then((r) => r.json())
      .then((d) => alive && setName(d.name));
    return () => {
      alive = false;
    };
  }, []);
  return <text>{name}</text>;
}
```

- The fetch → `setState` → commit round trip is asynchronous, and one
  `setImmediate` tick is **not** enough. Poll the tree with a deadline.
- `server.listen()` patches process-wide networking. Call `server.close()`
  in `after`, or the harness and msw can leave process state between files.
- The in-process X server connection is a plain stream, not HTTP; msw never
  touches it.
- `onUnhandledRequest: 'error'` makes any unmocked request a loud failure —
  the right default for hermetic UI tests.
- nock also works; prefer it only for its scope-level assertions
  (`scope.done()`) on legacy `http.request`-based clients.

## fast-check {#fast-check}

**Out of the box.** fast-check@4.9.0.

Property-based testing: generators plus a property, run against hundreds
of random inputs, with any failure _shrunk_ to a minimal counterexample and
a replay seed. The renderer has two oracles that cannot lie:

- **Convergence** — `mount(A)` then `update(A → B)` must produce the same
  tree as a fresh `mount(B)`.
- **Damage soundness** — a partial repaint must equal a forced full repaint.

```jsx
import fc from 'fast-check';

const { node } = fc.letrec((tie) => ({
  node: fc.oneof(
    { maxDepth: 3 },
    fc.record({
      kind: fc.constant('text'),
      label: fc.constantFrom('a', 'hello x11'),
    }),
    fc.record({
      kind: fc.constant('box'),
      style: fc.record(
        {
          width: fc.integer({ min: 10, max: 120 }),
          flexDirection: fc.constantFrom('row', 'column'),
        },
        { requiredKeys: [] },
      ),
      children: fc.array(tie('node'), { maxLength: 3 }),
    }),
  ),
}));

const toEl = (s, key) =>
  s.kind === 'text' ? (
    <text key={key}>{s.label}</text>
  ) : (
    <box key={key} style={s.style}>
      {s.children.map(toEl)}
    </box>
  );
const win = (kids) => (
  <window width={320} height={240}>
    {kids.map(toEl)}
  </window>
);
const snap = (n) => ({
  kind: n.kind,
  abs: { ...n.abs },
  children: n.children.map(snap),
});

await fc.assert(
  fc.asyncProperty(
    fc.array(node, { maxLength: 4 }),
    fc.array(node, { maxLength: 4 }),
    async (a, b) => {
      const root1 = await createHeadlessRoot();
      const w1 = await render(root1, win(a));
      await tick();
      await render(root1, win(b)); // update path
      await tick();
      const root2 = await createHeadlessRoot();
      const w2 = await render(root2, win(b)); // fresh-mount path
      await tick();
      assert.deepStrictEqual(snap(w1._reactX11Node), snap(w2._reactX11Node));
    },
  ),
  { numRuns: 30 },
);
```

- Compare structure (`kind` plus `abs` rects), not paint-op logs: op logs
  accumulate across paints on the update path, so they only match after a
  forced full repaint on both sides.
- Keep trees shallow; each run is a real yoga layout pass.
- Include a mid-sequence unmount/remount and `key` permutations in the
  generators; index keys exercise much less of `insertBefore`/`removeChild`
  than keyed reorders.
- A seeded PRNG would also do with no dependency; fast-check buys shrinking
  and `{ seed, path }` replay.

## sinon {#sinon}

**Out of the box, with one required restriction.** sinon@22.1.0.

Spies, stubs and `@sinonjs/fake-timers`. Fake timers work — a toast that
auto-dismisses via `setTimeout` dismisses on `clock.tick(1000)` — but the
default configuration is a trap.

**Never fake `setImmediate` or `queueMicrotask`.** Sinon's default `toFake`
list includes them; React's scheduler drives work with them in Node, and the
renderer schedules paints via `setImmediate` when there is no frame clock.
Faked, every render, effect flush and repaint freezes until a `clock.tick` —
usually a test that hangs at the first `await`. Pass an explicit list:

```js
const clock = sinon.useFakeTimers({
  toFake: ['setTimeout', 'clearTimeout', 'Date'],
});
```

The renderer's animation clock reads `Date.now()` at call time, so a fake
`Date` reaches style transitions.

```jsx
test('toast auto-dismisses', async () => {
  const clock = sinon.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'Date'],
  });
  try {
    const root = await createHeadlessRoot();
    const wnd = await render(
      root,
      <window width={100} height={50}>
        <Toast />
      </window>,
    );
    await tick(); // mount + passive effect
    clock.tick(1000); // fires the timeout synchronously
    await tick();
    await tick(); // setState -> commit -> repaint: two tasks
    assert.strictEqual(wnd._reactX11Node.children.length, 0);
  } finally {
    clock.restore(); // always; a leaked fake Date poisons the file
  }
});
```

- Two `setImmediate` ticks after `clock.tick`, not one — the timer
  callback's `setState` commits a task later.
- `clock.restore()` in `finally`, every time. A leaked fake `Date` breaks
  later tests' transitions and timestamps in the same process.
- The text-input caret blink uses `setInterval`; faking it without ticking
  leaves the caret timer pending — harmless, but it shows in
  `clock.countTimers()`.
- **Versus `node:test` mock timers**: `t.mock.timers.enable({ apis:
['setTimeout'] })` plus `t.mock.timers.tick(1000)` handles the plain-timer
  case with no dependency and auto-restores. Prefer it; use sinon for fake
  `Date` (the animation clock), `clock.countTimers()`, or spies and stubs.

## pixelmatch {#pixelmatch}

**Out of the box.** pixelmatch@7.2.0.

Perceptual image diff: two RGBA buffers plus an output buffer in,
changed-pixel count and a painted diff image out. Anti-aliasing aware, zero
dependencies. Render through the harness and read pixels back with
`getImageData` — no display needed. `jest-image-snapshot` cannot do this (it
wants a Buffer and receives a window object;
[register](../ecosystem.md#render-time)), but the pipeline under it is four
lines.

`ctx.getImageData(x, y, w, h)` resolves to a canvas `ImageData`; hand
pixelmatch its `.data`, already straight RGBA in a `Uint8ClampedArray` with
opaque pixels at alpha 255. Readback races the paint: poll a known pixel
before taking the comparison frame.

```jsx
import fs from 'node:fs';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const ctx = wnd.getContext('2d');
const diff = new PNG({ width: 320, height: 240 });

const before = (await ctx.getImageData(0, 0, 320, 240)).data;
// ...re-render with the changed prop, wait for the repaint...
const after = (await ctx.getImageData(0, 0, 320, 240)).data;
const changed = pixelmatch(before, after, diff.data, 320, 240, {
  threshold: 0.1,
});
if (changed > 0) fs.writeFileSync('diff.png', PNG.sync.write(diff));
```

- **Fonts are the determinism problem.** Glyph indices travel on the wire,
  so pin every family with ntk's `StaticFontSource`; never let a snapshot script fall through to
  `FontconfigFontSource`. Pinned, two renders of the same tree diff to zero
  pixels; unpinned, the diff is noise.
- `threshold` is a per-pixel colour distance, not a pass/fail budget; gate
  on the returned count.
- Buffers must have identical dimensions, or pixelmatch throws. After a
  window resize, re-read rather than crop.
- fontkit version bumps change hinting and advance rounding. Treat pixel
  diffs as tolerance-based regression tests; gate CI exactly on tree or
  op-log assertions.
- Under Xvfb, expect nonzero noise from the server's own rendering; the
  zero-noise floor is specific to the in-process JS server.

## react-test-renderer {#react-test-renderer}

**Works, but do not build on it.** react-test-renderer@19.2.8.

React's headless renderer treats _any_ string element type as a host
element, so react-x11 vocabulary passes through and coarse JSON snapshots
work. But:

1. **It is deprecated.** Importing it prints
   `react-test-renderer is deprecated`; it still ships in 19.2.x, but React
   discourages new usage.
2. **It bypasses the actual renderer.** No prop validation, style
   resolution, yoga layout or paint, so a tree that snapshots fine can still
   throw `react-x11: <box width=…> is a style property` or lay out wrong
   under react-x11.

The harness above is barely more code and exercises the real
`createInstance`/`commitUpdate` path with layout. Use react-test-renderer
only as a bridge when porting an existing suite.

- Set `globalThis.IS_REACT_ACT_ENVIRONMENT = true` in test setup, or every
  `act` call warns.
- `toJSON()` records the raw props, so snapshots are of _input_, not of what
  would render.
