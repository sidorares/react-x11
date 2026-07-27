// The 3D scene: every geometry is compiled into one server-side display
// list, and a frame is matrices + material state + one CallList per mesh —
// never the vertices again. That is a protocol property, so it is asserted
// on the **encoded GLX command stream** (the bytes react-x11 writes), not on
// pixels and not on what the server-side emulator ends up drawing: a display
// list replays into the backend either way, which would hide a regression
// that re-sends geometry every frame.
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

// GLX request minor opcodes (x11 lib/ext/glx.js)
const GLX_RENDER = 1;
const GLX_NEW_LIST = 101;
const GLX_END_LIST = 102;

// GL render-command opcodes (x11 lib/ext/glxrender.js)
const GL = {
  CallList: 1,
  Begin: 4,
  Color3f: 8,
  End: 23,
  Normal3f: 30,
  Vertex3f: 70,
  PolygonMode: 101,
  MultMatrixf: 180,
  PopMatrix: 183,
  PushMatrix: 184,
};

/** Record what the client writes and decode the GLX traffic out of it. */
function tapRequests(stream) {
  const chunks = [];
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    chunks.push(Buffer.from(chunk));
    return write(chunk, ...rest);
  };
  return {
    reset: () => (chunks.length = 0),
    glx(major) {
      const buffer = Buffer.concat(chunks);
      const minors = [];
      const commands = new Map();
      let offset = 0;
      while (offset + 4 <= buffer.length) {
        const words = buffer.readUInt16LE(offset + 2);
        if (words === 0) break; // BigRequests form: not used here
        const end = offset + words * 4;
        if (end > buffer.length) break;
        if (buffer[offset] === major) {
          const minor = buffer[offset + 1];
          minors.push(minor);
          if (minor === GLX_RENDER) {
            // [major][minor][length][contextTag] then GL commands
            let at = offset + 8;
            while (at + 4 <= end) {
              const length = buffer.readUInt16LE(at);
              const opcode = buffer.readUInt16LE(at + 2);
              if (length < 4) break;
              commands.set(opcode, (commands.get(opcode) ?? 0) + 1);
              at += length;
            }
          }
        }
        offset = end;
      }
      return {
        requests: (minor) => minors.filter((m) => m === minor).length,
        count: (opcode) => commands.get(opcode) ?? 0,
        total: [...commands.values()].reduce((a, b) => a + b, 0),
      };
    },
  };
}

async function createGlApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const backend = new RecordingBackend();
  server.registerExtension(
    'GLX',
    createGlxExtension({ backend, getDrawableSurface: () => null }),
  );
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const xErrors = [];
  const app = await createClient({
    stream: clientEnd,
    fontSource: new StaticFontSource(),
    onXError: (err) => xErrors.push(err),
  });
  return { app, backend, xErrors, tap: tapRequests(clientEnd) };
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

async function waitFor(check, what, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The <glarea> node under a rendered window instance. */
function findSurface(node) {
  if (node.isGlArea) return node;
  for (const child of node.children ?? []) {
    const found = findSurface(child);
    if (found) return found;
  }
  return null;
}

/** Draw one more frame the way an animation tick or an expose would. */
async function drawFrame(surface, app, tap) {
  const done = new Promise((resolve) => {
    const original = surface._drawFrame.bind(surface);
    surface._drawFrame = (...args) => {
      surface._drawFrame = original;
      original(...args);
      resolve();
    };
  });
  surface.requestFrame();
  await done;
  await settle(app);
  return tap;
}

test('a mesh compiles once, then every frame is one CallList', async () => {
  const { app, tap, xErrors } = await createGlApp();
  try {
    const scene = (rotation) =>
      h(
        'window',
        { width: 320, height: 240 },
        h(
          Canvas3D,
          { flexGrow: 1, camera: { position: [0, 0, 6] } },
          h(
            'mesh',
            { rotation },
            h('boxGeometry', { args: [1, 1, 1] }),
            h('meshBasicMaterial', { color: '#2980b9' }),
          ),
        ),
      );

    const instance = await render(scene([0, 0, 0]), app);
    const surface = findSurface(instance._reactX11Node);
    await waitFor(() => surface.gl?.contextTag > 0, 'the GL context');
    await drawFrame(surface, app, tap);

    const first = tap.glx(app.display.GLX.majorOpcode);
    assert.equal(first.requests(GLX_NEW_LIST), 1, 'one display list compiled');
    assert.equal(first.requests(GLX_END_LIST), 1);
    // a unit box is 12 triangles: 36 vertices, sent once
    assert.equal(first.count(GL.Vertex3f), 36, 'the geometry, sent once');
    assert.equal(first.count(GL.Normal3f), 36);
    assert.ok(first.count(GL.CallList) >= 1, 'and replayed by CallList');

    // a transform change re-sends matrices, never geometry
    tap.reset();
    await render(scene([0, 0.4, 0]), app);
    await drawFrame(surface, app, tap);

    const moved = tap.glx(app.display.GLX.majorOpcode);
    assert.equal(moved.count(GL.Vertex3f), 0, 'no geometry re-sent');
    assert.equal(moved.requests(GLX_NEW_LIST), 0, 'no recompile');
    assert.equal(moved.count(GL.CallList), 1, 'one CallList for the mesh');
    assert.ok(
      moved.count(GL.MultMatrixf) >= 3,
      'projection, view and the model matrix',
    );
    assert.equal(xErrors.length, 0, xErrors.map((e) => e.message).join(', '));

    ReactX11.unmountComponentAtNode(app);
    await settle(app);
  } finally {
    await app.close();
  }
});

test('per-frame cost does not grow with triangle count', async () => {
  const { app, tap } = await createGlApp();
  try {
    const instance = await render(
      h(
        'window',
        { width: 320, height: 240 },
        h(
          Canvas3D,
          { flexGrow: 1 },
          h(
            'mesh',
            {},
            h('sphereGeometry', { args: [1, 32, 32] }),
            h('meshBasicMaterial', { color: 'tomato' }),
          ),
        ),
      ),
      app,
    );
    const surface = findSurface(instance._reactX11Node);
    await waitFor(() => surface.gl?.contextTag > 0, 'the GL context');
    await drawFrame(surface, app, tap);

    const compile = tap.glx(app.display.GLX.majorOpcode);
    assert.ok(
      compile.count(GL.Vertex3f) > 5000,
      `the sphere really is big (${compile.count(GL.Vertex3f)} vertices)`,
    );

    // steady state: the same scene, whatever its triangle count
    tap.reset();
    await drawFrame(surface, app, tap);
    const steady = tap.glx(app.display.GLX.majorOpcode);
    assert.equal(steady.count(GL.Vertex3f), 0, 'no vertices in a steady frame');
    assert.equal(steady.count(GL.CallList), 1);
    assert.ok(
      steady.total < 30,
      `a frame is O(meshes): ${steady.total} GL commands`,
    );
  } finally {
    await app.close();
  }
});

test('changing geometry args recompiles that list once', async () => {
  const { app, tap } = await createGlApp();
  try {
    const scene = (size) =>
      h(
        'window',
        { width: 320, height: 240 },
        h(
          Canvas3D,
          { flexGrow: 1 },
          h(
            'mesh',
            {},
            h('boxGeometry', { args: [size, size, size] }),
            h('meshBasicMaterial', { color: 'white' }),
          ),
        ),
      );

    const instance = await render(scene(1), app);
    const surface = findSurface(instance._reactX11Node);
    await waitFor(() => surface.gl?.contextTag > 0, 'the GL context');
    await drawFrame(surface, app, tap);

    tap.reset();
    await render(scene(2), app);
    await drawFrame(surface, app, tap);
    const resized = tap.glx(app.display.GLX.majorOpcode);
    assert.equal(resized.requests(GLX_NEW_LIST), 1, 'exactly one recompile');
    assert.equal(resized.count(GL.Vertex3f), 36, 'the new box, once');

    tap.reset();
    await drawFrame(surface, app, tap);
    const steady = tap.glx(app.display.GLX.majorOpcode);
    assert.equal(steady.requests(GLX_NEW_LIST), 0, 'back to the cheap frame');
    assert.equal(steady.count(GL.Vertex3f), 0);
  } finally {
    await app.close();
  }
});

test('groups nest transforms and each material switches state once', async () => {
  const { app, tap } = await createGlApp();
  try {
    const instance = await render(
      h(
        'window',
        { width: 320, height: 240 },
        h(
          Canvas3D,
          { flexGrow: 1 },
          h(
            'group',
            { position: [0, 1, 0] },
            h(
              'mesh',
              { position: [-1, 0, 0] },
              h('boxGeometry', { args: [1, 1, 1] }),
              h('meshBasicMaterial', { color: 'red' }),
            ),
            h(
              'mesh',
              { position: [1, 0, 0] },
              h('boxGeometry', { args: [1, 1, 1] }),
              h('meshBasicMaterial', { color: 'blue', wireframe: true }),
            ),
          ),
        ),
      ),
      app,
    );
    const surface = findSurface(instance._reactX11Node);
    await waitFor(() => surface.gl?.contextTag > 0, 'the GL context');
    await drawFrame(surface, app, tap);

    tap.reset();
    await drawFrame(surface, app, tap);
    const frame = tap.glx(app.display.GLX.majorOpcode);
    assert.equal(frame.count(GL.CallList), 2, 'both meshes drawn');
    assert.equal(frame.count(GL.PushMatrix), 3, 'group + two meshes');
    assert.equal(frame.count(GL.PopMatrix), 3);
    assert.equal(frame.count(GL.Color3f), 2, 'one colour per material');
    assert.equal(frame.count(GL.PolygonMode), 2, 'wireframe switches state');
  } finally {
    await app.close();
  }
});

test('unsupported r3f elements fail with the protocol reason', async () => {
  const { app } = await createGlApp();
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await render(
      h(
        'window',
        { width: 100, height: 100 },
        h(Canvas3D, {}, h('mesh', {}, h('shaderMaterial', {}))),
      ),
      app,
    ).catch(() => {});
    assert.match(
      errors.join('\n'),
      /shaderMaterial.*GLSL shaders.*no shader objects/s,
      'the error names the protocol limit',
    );
  } finally {
    console.error = consoleError;
    await app.close();
  }
});

test('3D elements outside a <glarea> say where they belong', async () => {
  const { app } = await createGlApp();
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await render(
      h('window', { width: 100, height: 100 }, h('mesh', {})),
      app,
    ).catch(() => {});
    assert.match(errors.join('\n'), /<mesh> is a 3D element.*<glarea>/s);
  } finally {
    console.error = consoleError;
    await app.close();
  }
});
