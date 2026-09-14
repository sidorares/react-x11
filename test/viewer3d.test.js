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
//
// **The direct half is the other way round.** It runs on the same server
// with nothing behind the surface: `chooseGLConfig` answers direct, and the
// context is a recording of the WebGL-shaped calls a frame makes
// (`fakeDirectGL`). Nothing replays anything there, so the claim the GLX
// emulator hides is the one this half can pin — a buffer is uploaded in the
// frame that first needs it and never again. The pixels are the one thing
// it cannot see; `REACT_X11_WAYLAND_SNAPSHOT` reads those back on a real GPU
// (examples/viewer3d.jsx).
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
  return { app, backend, server };
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
  const { app, backend, server } = await glApp();
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
  return { app, backend, server, root, instance };
}

const findKind = (node, kind) =>
  node.kind === kind
    ? node
    : node.children.map((c) => findKind(c, kind)).find(Boolean);

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

  test('a drag over the stage orbits the model, even with Spin off', async () => {
    // The handlers are on the <glarea>, and on X11 they never ran: the
    // surface selected the wheel's button presses, and with them every
    // press. Injected through the server, so this is the route a real drag
    // takes. Spin is off, so the frames showing the new pitch are the drag's
    // own — a `'demand'` surface draws on a prop change, and the camera is a
    // ref, which is why the viewer loops for as long as a drag lasts.
    const { backend, server, instance } = await mountViewer({
      initialSpin: false,
    });
    const stage = findKind(instance._reactX11Node, 'glarea');
    const degrees = (rad) => (rad * 180) / Math.PI;
    // the pitch is the rotation about x; yaw is about y
    const pitch = () =>
      backend.calls.findLast(
        (c) => c[0] === 'rotate' && c[2] === 1 && c[3] === 0 && c[4] === 0,
      )?.[1];
    assert.ok(Math.abs(pitch() - degrees(0.35)) < 1e-3, `from ${pitch()}`);
    // the window sits at the screen's origin: there is no WM to move it
    const x = Math.round(stage.abs.x + stage.abs.width / 2);
    const y = Math.round(stage.abs.y + stage.abs.height / 2);
    server.injectPointerMove(x, y);
    server.injectButton(1, true);
    // 50px down is half a radian of pitch (examples/viewer3d.jsx)
    server.injectPointerMove(x, y + 50);
    await waitFor(
      () => Math.abs(pitch() - degrees(0.85)) < 1e-3,
      'a frame at the dragged pitch',
    );
    server.injectButton(1, false);
  });
});

/**
 * A direct context with nothing behind it: targets are ids, constants are
 * their own names so the recording reads like the code (bar the two bits
 * the element ORs together), and every call is kept.
 */
function fakeDirectGL() {
  const calls = [];
  let ids = 0;
  const rec =
    (name, answer) =>
    (...args) => {
      calls.push([name, ...args]);
      return answer?.(...args);
    };
  const gl = {
    backend: 'direct',
    ready: Promise.resolve(),
    calls,
    canRender: () => true,
    makeCurrent() {},
    destroy() {},
    SwapBuffers: rec('SwapBuffers'),
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x100,
    createShader: rec('createShader', () => ++ids),
    createProgram: rec('createProgram', () => ++ids),
    createBuffer: rec('createBuffer', () => ++ids),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getAttribLocation: (_program, name) =>
      ['aPosition', 'aNormal'].indexOf(name),
    getUniformLocation: (_program, name) => name,
  };
  for (const name of [
    'ARRAY_BUFFER',
    'STATIC_DRAW',
    'FLOAT',
    'TRIANGLES',
    'LINES',
    'DEPTH_TEST',
    'VERTEX_SHADER',
    'FRAGMENT_SHADER',
    'COMPILE_STATUS',
    'LINK_STATUS',
  ]) {
    gl[name] = name;
  }
  for (const name of [
    'viewport',
    'clearColor',
    'clear',
    'enable',
    'disable',
    'shaderSource',
    'compileShader',
    'attachShader',
    'linkProgram',
    'useProgram',
    'uniform3f',
    'uniformMatrix4fv',
    'uniformMatrix3fv',
    'bindBuffer',
    'bufferData',
    'enableVertexAttribArray',
    'disableVertexAttribArray',
    'vertexAttribPointer',
    'drawArrays',
  ]) {
    gl[name] = rec(name);
  }
  return gl;
}

/**
 * The viewer on the in-process server with the direct backend faked in: the
 * window, the layout and the frame clock are real, and the one surface's
 * context is `fakeDirectGL`.
 */
async function mountDirect(extra = {}) {
  const { app } = await glApp();
  const gl = fakeDirectGL();
  const screen = app.display.screen[0];
  app.chooseGLConfig = async () => ({
    backend: 'direct',
    visual: screen.root_visual,
    depth: screen.root_depth,
  });
  const createWindow = app.createWindow.bind(app);
  app.createWindow = (attrs) => {
    const wnd = createWindow(attrs);
    const getContext = wnd.getContext.bind(wnd);
    wnd.getContext = (kind, config) =>
      kind === 'opengl' ? gl : getContext(kind, config);
    return wnd;
  };
  const root = await createRoot({ app });
  const instance = await render(
    h(
      'window',
      { width: 480, height: 360 },
      h(ViewerPanel, { models: MODELS, ...extra }),
    ),
    root,
  );
  await waitFor(
    () => gl.calls.some((c) => c[0] === 'SwapBuffers'),
    'the first frame',
  );
  return { gl, instance };
}

/** The calls of each frame drawn so far, split at the swap that ends it. */
function framesOf(gl) {
  const frames = [];
  let frame = [];
  for (const call of gl.calls) {
    if (call[0] === 'SwapBuffers') {
      frames.push(frame);
      frame = [];
    } else frame.push(call);
  }
  return frames;
}

const called = (calls, name) => calls.filter((c) => c[0] === name);

const textsOf = (node) =>
  node.kind === 'textchunk'
    ? [node.text]
    : (node.children ?? []).flatMap(textsOf);

// OpenGL 1.x's own definitions, column-major as the spec writes them — the
// matrices the indirect half asks the server for, built here without
// src/mat4.js so the direct half's use of it is what gets checked.
const glMultiply = (a, b) => {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    }
  }
  return out;
};
// prettier-ignore
const glFrustum = (l, r, b, t, n, f) => [
  (2 * n) / (r - l), 0, 0, 0,
  0, (2 * n) / (t - b), 0, 0,
  (r + l) / (r - l), (t + b) / (t - b), -(f + n) / (f - n), -1,
  0, 0, (-2 * f * n) / (f - n), 0,
];
// prettier-ignore
const glTranslate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const glRotateX = (rad) => {
  const [c, s] = [Math.cos(rad), Math.sin(rad)];
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
};
const glRotateY = (rad) => {
  const [c, s] = [Math.cos(rad), Math.sin(rad)];
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
};

const assertClose = (actual, expected, what) => {
  assert.equal(actual.length, expected.length, `${what}: length`);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) < 1e-5,
      `${what}[${i}]: ${actual[i]} against ${expected[i]}`,
    );
  }
};

describe('examples/viewer3d on the direct backend', () => {
  test('a mesh is uploaded once, and a frame is two matrices and one draw', async () => {
    // What the indirect harness cannot see, visible here: the geometry is in
    // the first frame's `bufferData` and in no frame after it, however many
    // the spinning model draws.
    const { gl } = await mountDirect();
    await waitFor(() => framesOf(gl).length >= 5, 'five frames');

    const [first, ...rest] = framesOf(gl);
    assert.equal(called(gl.calls, 'linkProgram').length, 1, 'one program');
    assert.equal(called(gl.calls, 'bufferData').length, 1, 'one upload');
    assert.equal(called(first, 'bufferData').length, 1, 'in the first frame');
    // the light is the program's, set with it, never again
    assert.equal(called(gl.calls, 'uniform3f').length, 4);

    for (const [i, frame] of rest.entries()) {
      const names = frame.map((c) => c[0]);
      assert.deepEqual(
        names.filter((n) => /^(uniformMatrix|drawArrays|buffer)/.test(n)),
        ['uniformMatrix4fv', 'uniformMatrix3fv', 'drawArrays'],
        `frame ${i + 2}: the camera, then one draw`,
      );
      // The context is shared (on Wayland with the window's 2D renderer),
      // so what the draw depends on is asserted in the frame, and the arrays
      // pointing into this buffer are switched off after it.
      const draw = names.indexOf('drawArrays');
      const depth = frame.findIndex(
        (c) => c[0] === 'enable' && c[1] === 'DEPTH_TEST',
      );
      assert.ok(depth !== -1 && depth < draw, `frame ${i + 2}: depth test`);
      assert.equal(
        names.slice(draw).filter((n) => n === 'disableVertexAttribArray')
          .length,
        2,
        `frame ${i + 2}: both arrays off after the draw`,
      );
    }
  });

  test('the panel counts uploads, and says which backend it counted on', async () => {
    const { gl, instance } = await mountDirect({ initialSpin: false });
    const node = instance._reactX11Node;
    await waitFor(
      () => textsOf(node).includes('1 buffer uploaded · 1 draw per frame'),
      'the upload counted',
    );
    const texts = textsOf(node);
    assert.ok(texts.includes('On the GPU'), texts.join(' | '));
    assert.ok(texts.includes('direct'), texts.join(' | '));
    assert.equal(called(gl.calls, 'bufferData').length, 1);
  });

  test('the camera is the indirect half’s two matrices', async () => {
    // Spin off, so every frame is the initial camera: yaw 0.6, pitch 0.35,
    // distance 5 (examples/viewer3d.jsx).
    const { gl } = await mountDirect({ initialSpin: false });
    const [frame] = framesOf(gl);
    const [, , , width, height] = called(frame, 'viewport')[0];
    const a = height / width;
    const modelView = glMultiply(
      glMultiply(glTranslate(0, 0, -5), glRotateX(0.35)),
      glRotateY(0.6),
    );
    const mvp = glMultiply(glFrustum(-1, 1, -a, a, 2.2, 60), modelView);
    const [, uMvp, transpose, sent] = called(frame, 'uniformMatrix4fv')[0];
    assert.equal(uMvp, 'uMvp');
    assert.equal(transpose, false);
    assertClose(sent, mvp, 'the MVP');
    // rigid, so the normal matrix is the modelview's own upper 3x3
    const [, uNormal, , normal] = called(frame, 'uniformMatrix3fv')[0];
    assert.equal(uNormal, 'uNormalMatrix');
    // prettier-ignore
    assertClose(normal, [0, 1, 2, 4, 5, 6, 8, 9, 10].map((i) => modelView[i]), 'the normal matrix');
  });

  test('shading is baked into the upload: face normals, vertex normals, or lines', async () => {
    // One triangle whose vertex normals all differ from its face's, so each
    // shading's buffer can be told apart from the others.
    const BENT = [
      { p: [0, 0, 0], n: [0, 0.6, 0.8], f: [0, 0, 1] },
      { p: [1, 0, 0], n: [0.6, 0, 0.8], f: [0, 0, 1] },
      { p: [0, 1, 0], n: [0, -0.6, 0.8], f: [0, 0, 1] },
    ];
    const models = [{ id: 'bent', label: 'Bent', build: () => BENT }];
    const upload = async (initialShading) => {
      const { gl } = await mountDirect({
        models,
        initialShading,
        initialSpin: false,
      });
      const [, target, data, usage] = called(gl.calls, 'bufferData')[0];
      assert.equal(target, 'ARRAY_BUFFER');
      assert.equal(usage, 'STATIC_DRAW');
      const [, mode, first, count] = called(gl.calls, 'drawArrays')[0];
      assert.equal(first, 0);
      assert.equal(data.length, count * 6, 'six floats a vertex');
      return { mode, data: Array.from(data) };
    };
    const vertex = (v, normal) => [...v.p, ...normal];
    const f32 = (values) => Array.from(new Float32Array(values));

    const smooth = await upload('smooth');
    assert.equal(smooth.mode, 'TRIANGLES');
    assert.deepEqual(smooth.data, f32(BENT.flatMap((v) => vertex(v, v.n))));

    const flat = await upload('flat');
    assert.equal(flat.mode, 'TRIANGLES');
    assert.deepEqual(flat.data, f32(BENT.flatMap((v) => vertex(v, v.f))));

    // GLES has no PolygonMode: the outline is three segments, a-b b-c c-a,
    // each end lit with its vertex normal as the indirect wireframe is
    const wire = await upload('wire');
    assert.equal(wire.mode, 'LINES');
    const [a, b, c] = BENT;
    assert.deepEqual(
      wire.data,
      f32([a, b, b, c, c, a].flatMap((v) => vertex(v, v.n))),
    );
  });
});
