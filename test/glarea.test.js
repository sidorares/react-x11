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

import { Canvas3D } from '../src/components/index.js';
import { createRoot } from '../src/index.js';

const require = createRequire(import.meta.url);
const { createGlxExtension, RecordingBackend } = require('x11/browser/glx');

const h = React.createElement;

async function createGlApp({ indirectContexts = true } = {}) {
  const server = xserver.createServer({ width: 640, height: 480 });
  const backend = new RecordingBackend();
  const surfaces = new Map();
  server.registerExtension(
    'GLX',
    createGlxExtension({
      backend,
      indirectContexts,
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

const render = (element, x11Root) =>
  new Promise((resolve) => x11Root.render(element, resolve));

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
  const x11Root = await createRoot({ app });
  try {
    const drawn = [];
    const instance = await render(
      h(
        'window',
        { width: 320, height: 240 },
        h('box', { style: { padding: 20, flexGrow: 1 } }, [
          h('glarea', {
            key: 'gl',
            clearColor: '#3366cc',
            onCreated: (gl) => gl.Enable(gl.DEPTH_TEST),
            onDraw: (gl, info) => {
              drawn.push(info);
              gl.Begin(gl.TRIANGLES);
              gl.Vertex3f(0, 0, 0);
              gl.End();
            },
            style: { flexGrow: 1 },
          }),
        ]),
      ),
      x11Root,
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

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

test('<glarea> follows layout changes and redraws once per change', async () => {
  const { app, backend, xErrors } = await createGlApp();
  const x11Root = await createRoot({ app });
  try {
    const frames = [];
    const tree = (padding) =>
      h(
        'window',
        { width: 320, height: 240 },
        h('box', { style: { padding: padding, flexGrow: 1 } }, [
          h('glarea', {
            key: 'gl',
            onDraw: (gl, info) => frames.push([info.width, info.height]),
            style: { flexGrow: 1 },
          }),
        ]),
      );

    const instance = await render(tree(10), x11Root);
    await waitFor(() => frames.length > 0, 'the first frame');
    assert.deepEqual(frames.at(-1), [300, 220]);

    backend.calls.length = 0;
    await render(tree(40), x11Root);
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

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

// A server with indirect GLX disabled is the common case, not an edge case:
// it is the default on Xwayland and on Xorg without +iglx. The emulator's
// indirectContexts:false reproduces it exactly — every query answers, and
// CreateContext alone fails with BadValue 0.
test('<Canvas3D fallback> renders instead of the surface when GL is refused', async () => {
  const { app } = await createGlApp({ indirectContexts: false });
  const x11Root = await createRoot({ app });
  try {
    const errors = [];
    const instance = await render(
      h(
        'window',
        { width: 320, height: 240 },
        h(
          Canvas3D,
          {
            style: { flexGrow: 1 },
            fallback: (err) => {
              errors.push(err);
              // a box, not text: this suite's font source is empty
              return h('box', { name: 'no-gl' });
            },
          },
          h('mesh', null, h('boxGeometry', { args: [1, 1, 1] })),
        ),
      ),
      x11Root,
    );

    await waitFor(() => errors.length > 0, 'the fallback to render');
    await settle(app);

    const err = errors[0];
    assert.equal(
      err.code,
      'GLX_INDIRECT_DISABLED',
      `classified by cause, got ${err.code}: ${err.message}`,
    );
    assert.match(err.message, /indirect GLX/);
    assert.ok(err.hint, 'and carries the remedy for whoever wants to show it');

    const node = instance._reactX11Node;
    const [child] = node.children;
    assert.equal(child.kind, 'box', 'the surface is gone, the fallback is up');
    assert.equal(
      child.children[0].props.name,
      'no-gl',
      'and it is what the fallback returned',
    );

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

test('a failed <glarea> leaves no X window over the fallback', async () => {
  const { app } = await createGlApp({ indirectContexts: false });
  const x11Root = await createRoot({ app });
  try {
    const errors = [];
    const instance = await render(
      h(
        'window',
        { width: 320, height: 240 },
        h('glarea', { style: { flexGrow: 1 }, onError: (e) => errors.push(e) }),
      ),
      x11Root,
    );

    await waitFor(() => errors.length > 0, 'onError');
    await settle(app);

    const area = instance._reactX11Node.children[0];
    assert.equal(area.kind, 'glarea');
    assert.equal(area.error, errors[0], 'the node records why it has no GL');
    assert.equal(area.gl, null, 'no context');
    assert.equal(
      area.window,
      null,
      'and no child window: an unpainted one would cover whatever replaces it',
    );

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

// Why the connection remembers: the reason GL is unavailable is a property
// of the X server, so a second surface asking would get the same answer one
// round trip later — and show an empty box until it arrived.
test('a second <Canvas3D> shows its fallback on the first frame', async () => {
  const { app } = await createGlApp({ indirectContexts: false });
  const x11Root = await createRoot({ app });
  try {
    const first = [];
    const commits = [];
    const canvas = (log) =>
      h(Canvas3D, {
        style: { flexGrow: 1 },
        fallback: (err) => {
          log.push(err);
          return h('box', { name: 'no-gl' });
        },
      });

    await render(
      h('window', { width: 320, height: 240 }, canvas(first)),
      x11Root,
    );
    await waitFor(() => first.length > 0, 'the first surface to find out');
    await settle(app);

    // a second surface, mounted after the answer is known
    const second = [];
    let rendered = 0;
    const Probe = () => {
      rendered++;
      commits.push(second.length);
      return canvas(second);
    };
    await render(h('window', { width: 320, height: 240 }, h(Probe)), x11Root);

    assert.ok(rendered > 0, 'the second tree rendered');
    assert.equal(
      second.length,
      1,
      'its fallback ran on the first commit, with no round trip in between',
    );
    assert.equal(second[0].code, 'GLX_INDIRECT_DISABLED');

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

// A shader that will not compile is a bug in one material, not a machine
// without 3D. Swapping the whole scene for the fallback would send the reader
// off to check their drivers, so the fallback stays reserved for a surface
// that really has no context — src/components/Canvas3D.js.
test('<Canvas3D fallback> ignores a shader failure and keeps the surface', async () => {
  const { app } = await createGlApp();
  const x11Root = await createRoot({ app });
  try {
    const seen = [];
    const instance = await render(
      h(
        'window',
        { width: 320, height: 240 },
        h(
          Canvas3D,
          {
            style: { flexGrow: 1 },
            onError: (err) => seen.push(err),
            fallback: () => h('box', { name: 'no-gl' }),
          },
          h('mesh', null, h('boxGeometry', { args: [1, 1, 1] })),
        ),
      ),
      x11Root,
    );
    await settle(app);

    const surface = instance._reactX11Node.children[0];
    assert.equal(surface.kind, 'glarea', 'GL works here, so the surface is up');

    // exactly what the shader renderer does when a program will not build
    const shaderError = Object.assign(new Error('bad shader'), {
      code: 'GL_SHADER_FAILED',
    });
    surface.props.onError(shaderError);
    await settle(app);

    assert.deepEqual(
      seen.map((e) => e.code),
      ['GL_SHADER_FAILED'],
      'the app still hears about it through onError',
    );
    assert.equal(
      instance._reactX11Node.children[0].kind,
      'glarea',
      'but the surface stays, rather than being replaced by the fallback',
    );

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

// A surface with neither a fallback nor an onError used to fail in total
// silence: <glarea> logs only when nothing claimed the error, and <Canvas3D>
// always claims it. The symptom was a blank 3D area with nothing on the
// console — indistinguishable from "my scene is wrong".
test('<Canvas3D> with no fallback and no onError still says what went wrong', async () => {
  const { app } = await createGlApp({ indirectContexts: false });
  const x11Root = await createRoot({ app });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await render(
      h(
        'window',
        { width: 320, height: 240 },
        h(
          Canvas3D,
          { style: { flexGrow: 1 } },
          h('mesh', null, h('boxGeometry', { args: [1, 1, 1] })),
        ),
      ),
      x11Root,
    );
    await waitFor(
      () => warnings.some((w) => w.includes('Canvas3D')),
      'the failure to reach the console',
    );
    await settle(app);
    assert.match(warnings.join('\n'), /indirect GLX/, 'and names the cause');

    await x11Root.unmount();
    await settle(app);
  } finally {
    console.warn = realWarn;
    await app.close();
  }
});

/**
 * Flush React the way the published harness does — `settle()` only drives the
 * X connection, so a `setState` from an error handler is still in flight when
 * it returns, and an assertion that the tree did *not* change would pass
 * whether or not it was about to.
 */
async function flush(fn) {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await React.act(async () => {
      await fn?.();
    });
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

// Post-processing needs a framebuffer object to render the scene into, and
// GLX encodes none — so `<effectComposer>` is direct-only for the same kind
// of reason `<shaderMaterial>` is, and fails the same way: when the element
// is created, naming what is missing, rather than as a surface that quietly
// composes nothing.
//
// The passes are direct-only in their own right, not merely by being inside
// a composer — a `<bloomPass>` on its own has to say the same thing.
for (const [what, scene] of [
  ['effectComposer', () => h('effectComposer', null)],
  ['bloomPass', () => h('bloomPass', null)],
]) {
  test(`<${what}> without direct rendering throws, naming the reason`, async () => {
    const { app } = await createGlApp();
    const x11Root = await createRoot({ app });
    const realError = console.error;
    console.error = () => {};
    try {
      await assert.rejects(
        () =>
          flush(() =>
            x11Root.render(
              h(
                'window',
                { width: 320, height: 240 },
                h(
                  Canvas3D,
                  { style: { flexGrow: 1 } },
                  h('mesh', null, h('boxGeometry', { args: [1, 1, 1] })),
                  scene(),
                ),
              ),
            ),
          ),
        (err) => {
          assert.match(
            err.message,
            new RegExp(`<${what}> needs direct rendering`),
          );
          assert.match(err.message, /framebuffer objects/);
          // and points at the check a scene that would rather degrade makes
          assert.match(err.message, /useSupports\('shaders'\)/);
          return true;
        },
      );
    } finally {
      console.error = realError;
      await app.close();
    }
  });
}

// What the guard was blurring: ntk's probe answers what the *machine* could
// do and consults glPolicy only for 'off', so a DRI3-capable box resolves
// `direct: true` under the default 'indirect' policy too — while the context
// that draws is still indirect GLX. The element has to refuse there, and the
// reason has to be the policy rather than one of the hardware ones, because
// that is the only one the reader can do anything about (issue #357).
test('a capable machine the policy never asked is not direct rendering', async () => {
  const { app } = await createGlApp();
  // the capabilities such a box caches: addon loaded, DRI3 and Present there
  app._glCapsResolved = {
    direct: true,
    indirect: true,
    device: '/dev/dri/renderD128',
    reason: null,
  };
  const x11Root = await createRoot({ app });
  const realError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      () =>
        flush(() =>
          x11Root.render(
            h(
              'window',
              { width: 320, height: 240 },
              h(
                Canvas3D,
                { style: { flexGrow: 1 } },
                h(
                  'mesh',
                  null,
                  h('boxGeometry', { args: [1, 1, 1] }),
                  h('shaderMaterial', {
                    vertexShader: 'void main() {}',
                    fragmentShader: 'void main() {}',
                  }),
                ),
              ),
            ),
          ),
        ),
      (err) => {
        assert.equal(err.code, 'GL_POLICY_INDIRECT');
        assert.match(err.message, /<shaderMaterial> needs direct rendering/);
        // the policy, named, and the change that would answer differently
        assert.match(err.message, /glPolicy is 'indirect'/);
        assert.match(err.message, /glPolicy: 'auto'/);
        return true;
      },
    );
  } finally {
    console.error = realError;
    await app.close();
  }
});

// The fallback means "this machine has no 3D". A render target that came
// back incomplete, or an addon too old to have framebuffer objects, is one
// broken effect on a surface that is otherwise drawing — swapping the whole
// scene for "no 3D here" would send the reader off to check their drivers.
test('<Canvas3D fallback> ignores a post-processing failure too', async () => {
  const { app } = await createGlApp();
  const x11Root = await createRoot({ app });
  try {
    const seen = [];
    const instance = await render(
      h(
        'window',
        { width: 320, height: 240 },
        h(
          Canvas3D,
          {
            style: { flexGrow: 1 },
            onError: (err) => seen.push(err),
            fallback: () => h('box', { name: 'no-gl' }),
          },
          h('mesh', null, h('boxGeometry', { args: [1, 1, 1] })),
        ),
      ),
      x11Root,
    );
    await settle(app);

    const surface = instance._reactX11Node.children[0];
    assert.equal(surface.kind, 'glarea');

    const codes = [
      'GL_POST_TARGET_FAILED',
      'GL_POST_UNAVAILABLE',
      'GL_SHADER_FAILED',
      'GL_CONTEXT_INCOMPLETE',
    ];
    for (const code of codes) {
      await flush(() =>
        surface.props.onError(Object.assign(new Error(code), { code })),
      );
      await settle(app);
      assert.equal(
        instance._reactX11Node.children[0].kind,
        'glarea',
        `${code} left the surface alone`,
      );
    }
    assert.deepEqual(
      seen.map((e) => e.code),
      codes,
      'and the app heard about every one of them',
    );

    // The control, and the reason the assertions above are not vacuous: a
    // context that never came up *does* switch to the fallback, through this
    // same handler and the same flush.
    await flush(() =>
      surface.props.onError(
        Object.assign(new Error('no context'), {
          code: 'GLX_INDIRECT_DISABLED',
        }),
      ),
    );
    await settle(app);
    const [child] = instance._reactX11Node.children;
    assert.equal(child.kind, 'box', 'the surface is gone, the fallback is up');
    assert.equal(child.children[0].props.name, 'no-gl');

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});
