// Pointer events on meshes: a ray through the clicked pixel, cast against
// the CPU-side geometry, dispatched to the mesh it hits and bubbled up.
// Hermetic — the in-process X server with node-x11's GLX emulator; pointer
// events are fed to the surface window the way the server would.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import React from 'react';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import ReactX11, { Canvas3D } from '../src/index.js';

const require = createRequire(import.meta.url);
const { createGlxExtension, RecordingBackend } = require('x11/browser/glx');

const h = React.createElement;

async function createGlApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  server.registerExtension(
    'GLX',
    createGlxExtension({
      backend: new RecordingBackend(),
      getDrawableSurface: () => null,
    }),
  );
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({
    stream: clientEnd,
    fontSource: new StaticFontSource(),
  });
  return { app };
}

const render = (element, app) =>
  new Promise((resolve) => ReactX11.render(element, resolve, app));

const settle = async (app, roundTrips = 2) => {
  for (let i = 0; i < roundTrips; i++) {
    await new Promise((resolve, reject) =>
      app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
    );
  }
};

async function waitFor(check, what, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function findSurface(node) {
  if (node.isGlArea) return node;
  for (const child of node.children ?? []) {
    const found = findSurface(child);
    if (found) return found;
  }
  return null;
}

/** Mount a scene and draw one frame, so picking has a camera to work with. */
async function mount(app, scene, size = { width: 400, height: 300 }) {
  const instance = await render(
    h('window', size, h(Canvas3D, { flexGrow: 1, ...scene.canvas }, scene.children)),
    app,
  );
  const surface = findSurface(instance._reactX11Node);
  await waitFor(() => surface.gl?.contextTag > 0, 'the GL context');
  surface.requestFrame = () => {};
  surface._drawFrame();
  await settle(app);
  return surface;
}

// what the X server delivers to the surface window
const pointer = (surface, type, x, y) =>
  surface.window.emit(type, { x, y, type: 0, buttons: 0 });

const CUBE = (props = {}) =>
  h(
    'mesh',
    props,
    h('boxGeometry', { args: [2, 2, 2] }),
    h('meshBasicMaterial', { color: 'tomato' }),
  );

test('a click on a mesh hits it, and a click past it misses', async () => {
  const { app } = await createGlApp();
  try {
    const clicks = [];
    const missed = [];
    const surface = await mount(app, {
      canvas: {
        camera: { position: [0, 0, 6] },
        onPointerMissed: () => missed.push(true),
      },
      children: CUBE({ onClick: (ev) => clicks.push(ev) }),
    });

    // dead centre: the cube fills the middle of a 400x300 viewport
    pointer(surface, 'mousedown', 200, 150);
    pointer(surface, 'mouseup', 200, 150);
    assert.equal(clicks.length, 1, 'one click on the cube');

    const [ev] = clicks;
    assert.equal(ev.object.kind, 'mesh');
    assert.ok(ev.distance > 3 && ev.distance < 6, `distance ${ev.distance}`);
    assert.ok(
      Math.abs(ev.point[0]) < 0.01 && Math.abs(ev.point[1]) < 0.01,
      `the hit point is on the axis: ${ev.point}`,
    );
    assert.ok(ev.point[2] > 0.9, 'and on the near face');

    // a corner of the viewport is past the cube
    pointer(surface, 'mousedown', 5, 5);
    pointer(surface, 'mouseup', 5, 5);
    assert.equal(clicks.length, 1, 'no second click');
    assert.equal(missed.length, 1, 'onPointerMissed instead');
  } finally {
    await app.close();
  }
});

test('hover enters and leaves as the pointer crosses a mesh', async () => {
  const { app } = await createGlApp();
  try {
    const log = [];
    const surface = await mount(app, {
      canvas: { camera: { position: [0, 0, 6] } },
      children: CUBE({
        onPointerOver: () => log.push('over'),
        onPointerOut: () => log.push('out'),
        onPointerMove: () => log.push('move'),
      }),
    });

    pointer(surface, 'mousemove', 200, 150);
    pointer(surface, 'mousemove', 201, 150); // still on the cube
    pointer(surface, 'mousemove', 5, 5); // off it
    pointer(surface, 'mousemove', 200, 150); // back on

    assert.deepEqual(log, [
      'over',
      'move',
      'move',
      'out',
      'over',
      'move',
    ]);
  } finally {
    await app.close();
  }
});

test('the nearest mesh wins, and events bubble to the group', async () => {
  const { app } = await createGlApp();
  try {
    const hits = [];
    const groupClicks = [];
    const surface = await mount(app, {
      canvas: { camera: { position: [0, 0, 10] } },
      children: h(
        'group',
        { onClick: (ev) => groupClicks.push(ev) },
        // same place, one in front of the other
        CUBE({ position: [0, 0, 2], onClick: () => hits.push('near') }),
        CUBE({ position: [0, 0, -2], onClick: () => hits.push('far') }),
      ),
    });

    pointer(surface, 'mousedown', 200, 150);
    pointer(surface, 'mouseup', 200, 150);

    assert.deepEqual(hits, ['near'], 'only the nearest mesh is hit');
    assert.equal(groupClicks.length, 1, 'and the click bubbles to the group');
    assert.equal(groupClicks[0].object.props.position[2], 2, 'with the hit mesh on it');
  } finally {
    await app.close();
  }
});

test('stopPropagation keeps an event off the ancestors', async () => {
  const { app } = await createGlApp();
  try {
    const seen = [];
    const surface = await mount(app, {
      canvas: { camera: { position: [0, 0, 6] } },
      children: h(
        'group',
        { onClick: () => seen.push('group') },
        CUBE({
          onClick: (ev) => {
            seen.push('mesh');
            ev.stopPropagation();
          },
        }),
      ),
    });

    pointer(surface, 'mousedown', 200, 150);
    pointer(surface, 'mouseup', 200, 150);
    assert.deepEqual(seen, ['mesh']);
  } finally {
    await app.close();
  }
});

test('a transform moves what the ray hits', async () => {
  const { app } = await createGlApp();
  try {
    const hits = [];
    const scene = (x) => ({
      canvas: { camera: { position: [0, 0, 6] } },
      children: CUBE({ position: [x, 0, 0], onClick: () => hits.push(x) }),
    });
    const surface = await mount(app, scene(0));

    pointer(surface, 'mousedown', 200, 150);
    pointer(surface, 'mouseup', 200, 150);
    assert.deepEqual(hits, [0], 'centred cube is under the centre pixel');

    // move it far to the left and redraw: the centre pixel now misses
    await render(
      h(
        'window',
        { width: 400, height: 300 },
        h(
          Canvas3D,
          { flexGrow: 1, camera: { position: [0, 0, 6] } },
          CUBE({ position: [-6, 0, 0], onClick: () => hits.push(-6) }),
        ),
      ),
      app,
    );
    surface._drawFrame();
    await settle(app);

    pointer(surface, 'mousedown', 200, 150);
    pointer(surface, 'mouseup', 200, 150);
    assert.deepEqual(hits, [0], 'nothing under the centre any more');
  } finally {
    await app.close();
  }
});

test('X pointer events are only selected when the scene listens', async () => {
  const { app } = await createGlApp();
  try {
    const quiet = await mount(app, {
      canvas: {},
      children: CUBE(),
    });
    assert.equal(
      quiet.pointer.attached,
      false,
      'no handlers: no motion events asked for',
    );

    const listening = await mount(app, {
      canvas: {},
      children: CUBE({ onClick: () => {} }),
    });
    assert.equal(listening.pointer.attached, true);
  } finally {
    await app.close();
  }
});
