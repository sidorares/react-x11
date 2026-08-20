// examples/viewer3d.jsx — asserted on the GL commands a frame executes.
//
// Hermetic, like `test/glarea.test.js`: node-x11's in-process X server with
// its GLX emulator registered, so a frame's GL calls land on a
// `RecordingBackend`. No display, no GPU, no addon.
//
// **What this harness cannot see, and where that claim is checked instead.**
// The app exists to show that geometry crosses the wire *once* — compiled
// into a display list, replayed with one `CallList` a frame. The emulator
// keeps display lists on the client side and `CallList` **replays** their
// contents into the backend (`x11/browser/glx/render-decoder.js`), so the
// recording shows the full geometry every frame either way: a compiled list
// and per-frame immediate mode are byte-for-byte identical here, and
// `newList`/`callList` never reach the backend at all. Filed as
// [node-x11#279](https://github.com/sidorares/node-x11/issues/279).
//
// So that claim is measured on a real server rather than asserted here —
// `REACT_X11_TRACE=summary npm run examples:viewer3d`, which reports
// **1614 requests (118.9KB out)** for ~460 frames of a 12-triangle cube:
// ~258 bytes a frame, which is matrices and a `CallList`. Re-sending the
// cube would be about 1KB a frame. What is left for this file is everything
// around it, which the harness models exactly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test, describe } from 'node:test';

import React from 'react';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';

process.env.REACT_X11_NO_AUTORUN = '1';

const { ViewerPanel } = await import('../examples/viewer3d.jsx');

const require = createRequire(import.meta.url);
const { createGlxExtension, RecordingBackend } = require('x11/browser/glx');

// The panel has text in it, so the source needs a face — `glarea.test.js`
// gets away with an empty one because it renders nothing but the surface.
const FACE = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
  'KaTeX_Main-Regular.ttf',
);

const h = React.createElement;

/** Two triangles with distinguishable positions — enough to count vertices. */
const TINY = [
  { p: [0, 0, 0], n: [0, 0, 1], f: [0, 0, 1] },
  { p: [1, 0, 0], n: [0, 0, 1], f: [0, 0, 1] },
  { p: [0, 1, 0], n: [0, 0, 1], f: [0, 0, 1] },
  { p: [0, 0, 1], n: [1, 0, 0], f: [1, 0, 0] },
  { p: [0, 1, 1], n: [1, 0, 0], f: [1, 0, 0] },
  { p: [0, 1, 0], n: [1, 0, 0], f: [1, 0, 0] },
];
const MODELS = [
  { id: 'tiny', label: 'Tiny', build: () => TINY },
  { id: 'tinier', label: 'Tinier', build: () => TINY.slice(0, 3) },
];

async function glApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const backend = new RecordingBackend();
  const surfaces = new Map();
  server.registerExtension(
    'GLX',
    createGlxExtension({
      backend,
      indirectContexts: true,
      getDrawableSurface: (xid) => surfaces.get(xid) || null,
    }),
  );
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const source = new StaticFontSource();
  source.add(readFileSync(FACE), { family: 'KaTeX_Main' });
  source.alias('sans-serif', 'katex_main');
  const app = await createClient({
    stream: clientEnd,
    fontSource: source,
    onXError: () => {},
  });
  return { app, backend };
}

const render = (element, root) =>
  new Promise((resolve) => root.render(element, resolve));

async function waitFor(check, what, timeout = 4000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const names = (backend) => backend.calls.map((c) => c[0]);
const count = (backend, name) =>
  names(backend).filter((c) => c === name).length;

async function mountViewer(extra = {}) {
  const { app, backend } = await glApp();
  const root = await createRoot({ app });
  const instance = await render(
    h(
      'window',
      { width: 480, height: 360 },
      h(ViewerPanel, { models: MODELS, ...extra }),
    ),
    root,
  );
  await waitFor(() => count(backend, 'clear') > 0, 'the first frame');
  return { app, backend, root, instance };
}

describe('examples/viewer3d', () => {
  test('one-time GL state is set once, not per frame', async () => {
    // `onCreated` is where lights and depth testing belong. Doing this per
    // frame would be a fistful of commands a frame that never change — and
    // unlike the display list, this *is* visible here, because the calls
    // reach the backend directly rather than through a replay.
    const { backend } = await mountViewer();
    const frames = count(backend, 'clear');
    await waitFor(() => count(backend, 'clear') >= frames + 3, 'three frames');

    assert.equal(count(backend, 'enable'), 5, 'five enables, once');
    assert.equal(count(backend, 'light'), 3, 'three light parameters, once');
    assert.equal(count(backend, 'colorMaterial'), 1);
  });

  test('a frame is a camera: matrices, then the model', async () => {
    const { backend } = await mountViewer();
    const from = backend.calls.length;
    const frames = count(backend, 'clear');
    await waitFor(() => count(backend, 'clear') >= frames + 2, 'two frames');

    const since = backend.calls.slice(from).map((c) => c[0]);
    for (const expected of [
      'matrixMode',
      'loadIdentity',
      'frustum',
      'translate',
      'rotate',
    ]) {
      assert.ok(since.includes(expected), `a frame emits ${expected}`);
    }
    // The projection and the modelview are two matrices, so two of each per
    // frame — the camera is the only thing a frame actually carries.
    const perFrame = since.filter((c) => c === 'matrixMode').length;
    assert.ok(perFrame >= 4, `two matrices a frame, saw ${perFrame}`);
  });

  test('the model that is drawn is the model that was chosen', async () => {
    // The geometry in the recording is the *replayed* list, so its size per
    // frame is how this harness can tell which list `CallList` named.
    const perFrame = (backend, from) => {
      const since = backend.calls.slice(from).map((c) => c[0]);
      const frames = since.filter((c) => c === 'clear').length;
      const verts = since.filter((c) => c === 'vertex').length;
      return frames ? Math.round(verts / frames) : 0;
    };

    const measure = async (initialModel, expected) => {
      const { backend } = await mountViewer({ initialModel });
      const from = backend.calls.length;
      await waitFor(
        () =>
          backend.calls.slice(from).filter((c) => c[0] === 'clear').length >= 3,
        `three frames of ${initialModel}`,
      );
      assert.equal(perFrame(backend, from), expected, initialModel);
    };

    await measure('tiny', TINY.length);
    await measure('tinier', 3);
  });

  test('with Spin off, an untouched viewer draws nothing more', async () => {
    // `frameLoop` is the difference between a viewer nobody is touching
    // costing a frame's worth of traffic forever and costing nothing.
    const { backend } = await mountViewer({ initialSpin: false });
    await new Promise((r) => setTimeout(r, 400));
    const settled = count(backend, 'clear');
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(
      count(backend, 'clear'),
      settled,
      'on demand, nothing redraws until something changes',
    );
  });
});
