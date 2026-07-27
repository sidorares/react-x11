// <glarea>: the GL surface element. Hermetic — node-x11's in-process X
// server with its GLX emulator (x11/browser/glx) registered as an extension,
// so the GL commands a frame emits land as calls on a RecordingBackend and
// the whole path (visual query -> child window -> context tag -> frame) is
// asserted without a display or a GPU.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import React from 'react';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import ReactX11 from '../src/index.js';

const require = createRequire(import.meta.url);
const { createGlxExtension, RecordingBackend } = require('x11/browser/glx');

const h = React.createElement;

async function createGlApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const backend = new RecordingBackend();
  const surfaces = new Map();
  server.registerExtension(
    'GLX',
    createGlxExtension({
      backend,
      getDrawableSurface: (xid) => surfaces.get(xid) || null,
    }),
  );
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const xErrors = [];
  const app = await createClient({
    stream: clientEnd,
    fontSource: new StaticFontSource(),
    onXError: (err) => xErrors.push(err),
  });
  return { app, backend, xErrors };
}

const render = (element, app) =>
  new Promise((resolve) => ReactX11.render(element, resolve, app));

const settle = async (app, roundTrips = 3) => {
  for (let i = 0; i < roundTrips; i++) {
    await new Promise((resolve, reject) =>
      app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
    );
  }
};

// the frame runs on the child window's frame clock (a fenced round trip),
// so poll rather than guess how many ticks it takes
async function waitFor(check, what, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const getAttributes = (app, wid) =>
  new Promise((resolve, reject) =>
    app.X.GetWindowAttributes(wid, (err, attrs) =>
      err ? reject(err) : resolve(attrs),
    ),
  );

test('<glarea> gets a GL child window and draws a frame', async () => {
  const { app, backend, xErrors } = await createGlApp();
  try {
    const drawn = [];
    const instance = await render(
      h(
        'window',
        { width: 320, height: 240 },
        h('box', { padding: 20, flexGrow: 1 }, [
          h('glarea', {
            key: 'gl',
            flexGrow: 1,
            clearColor: '#3366cc',
            onCreated: (gl) => gl.Enable(gl.DEPTH_TEST),
            onDraw: (gl, info) => {
              drawn.push(info);
              gl.Begin(gl.TRIANGLES);
              gl.Vertex3f(0, 0, 0);
              gl.End();
            },
          }),
        ]),
      ),
      app,
    );

    await waitFor(() => drawn.length > 0, 'the first frame');
    await settle(app);

    const node = instance._reactX11Node;
    const area = node.children[0].children[0];
    assert.equal(area.kind, 'glarea');
    assert.ok(area.window, '<glarea> owns a real X window');
    assert.ok(area.gl.contextTag > 0, 'the GL context is current');

    // yoga sized it: 320x240 window, 20px padding all round
    assert.deepEqual(
      { width: area.rect.width, height: area.rect.height },
      { width: 280, height: 200 },
    );
    assert.deepEqual(drawn[0], {
      width: 280,
      height: 200,
      node: area,
    });

    const attrs = await getAttributes(app, area.window.id);
    assert.equal(
      attrs.visual,
      area.config.visual,
      'the child window uses the GL visual',
    );

    // onCreated first, then viewport/clear/user draw for the frame. A GL
    // window has no backing store, so the Expose that follows MapWindow
    // legitimately repeats the frame — assert the first one.
    const calls = backend.calls.map((c) => c[0]).filter((c) => c !== 'resize');
    assert.deepEqual(
      calls.slice(0, 8),
      [
        'enable',
        'viewport',
        'clearColor',
        'clear',
        'begin',
        'vertex',
        'end',
        'finish',
      ],
      'one frame of GL commands reached the server',
    );
    const [, ...rgba] = backend.calls.find((c) => c[0] === 'clearColor');
    assert.ok(
      Math.abs(rgba[0] - 0x33 / 255) < 1e-3 &&
        Math.abs(rgba[1] - 0x66 / 255) < 1e-3 &&
        Math.abs(rgba[2] - 0xcc / 255) < 1e-3,
      `clearColor parsed from CSS, got ${rgba}`,
    );
    assert.deepEqual(
      backend.calls.find((c) => c[0] === 'viewport').slice(1),
      [0, 0, 280, 200],
    );
    assert.equal(xErrors.length, 0, xErrors.map((e) => e.message).join(', '));

    ReactX11.unmountComponentAtNode(app);
    await settle(app);
  } finally {
    await app.close();
  }
});

test('<glarea> follows layout changes and redraws once per change', async () => {
  const { app, backend, xErrors } = await createGlApp();
  try {
    const frames = [];
    const tree = (padding) =>
      h(
        'window',
        { width: 320, height: 240 },
        h('box', { padding, flexGrow: 1 }, [
          h('glarea', {
            key: 'gl',
            flexGrow: 1,
            onDraw: (gl, info) => frames.push([info.width, info.height]),
          }),
        ]),
      );

    const instance = await render(tree(10), app);
    await waitFor(() => frames.length > 0, 'the first frame');
    assert.deepEqual(frames.at(-1), [300, 220]);

    backend.calls.length = 0;
    await render(tree(40), app);
    await waitFor(
      () => frames.some(([w]) => w === 240),
      'a frame at the new size',
    );
    await settle(app);

    const node = instance._reactX11Node;
    const area = node.children[0].children[0];
    assert.deepEqual(
      { width: area.rect.width, height: area.rect.height },
      { width: 240, height: 160 },
      'the X child window followed the yoga rect',
    );
    // the resize can be preceded by one more frame at the old size (an
    // Expose while the window is being moved), so it is the latest frame
    // that has to match
    assert.deepEqual(
      backend.calls.findLast((c) => c[0] === 'viewport').slice(1),
      [0, 0, 240, 160],
      'and so did the GL viewport',
    );
    // demand-driven by default: a settled scene stops issuing frames
    const before = frames.length;
    await settle(app, 6);
    assert.equal(frames.length, before, 'no frames without a change');
    assert.equal(xErrors.length, 0, xErrors.map((e) => e.message).join(', '));

    ReactX11.unmountComponentAtNode(app);
    await settle(app);
  } finally {
    await app.close();
  }
});
