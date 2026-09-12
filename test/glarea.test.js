// <glarea>: the GL surface element. Hermetic — node-x11's in-process X
// server with its GLX emulator (x11/browser/glx) registered as an extension,
// so the GL commands a frame emits land as calls on a RecordingBackend and
// the whole path (visual query -> child window -> context tag -> frame) is
// asserted without a display or a GPU.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import React from 'react';
import x11 from 'x11';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';
import { WHEEL_NOTCH_PX } from '../src/events.js';
import { GlAreaNode } from '../src/glnodes.js';

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
  return { app, backend, xErrors, server };
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
      // the node's origin in the drawable being drawn into — a <glarea>
      // draws into its own X window, so zero even though yoga put the
      // node at 20,20 in the parent
      x: 0,
      y: 0,
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
    // …nor one for the hit test to answer with: a point there is the tree's
    assert.deepEqual(instance._reactX11Node._surfaces, []);
    assert.equal(area.hitSurface(10, 10), null);

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

// --- the pointer over the surface ---------------------------------------------
//
// Every test below injects through the in-process server rather than
// emitting on an ntk window, because *where X delivers each event* is the
// whole of this feature: the surface selects no pointer input, so the server
// reports what happens over it to the window the tree lives in — in that
// window's coordinates, under that window's implicit grab — and the window's
// hit test names the <glarea>. An `emit` on a window would skip the one step
// that used to go wrong: the surface selected ButtonPress to hear the wheel,
// and every press over it then ended at the surface.

const POINTER_INPUT =
  x11.eventMask.ButtonPress |
  x11.eventMask.ButtonRelease |
  x11.eventMask.PointerMotion;

/**
 * `build(onDraw)` mounted, its surface made and a frame drawn. `at(x, y)`
 * parks the pointer at a point of the window, `press`/`release` a button —
 * all through the server.
 */
async function mountSurface(build) {
  const { app, server } = await createGlApp();
  const x11Root = await createRoot({ app });
  let drew = false;
  const instance = await render(
    build(() => {
      drew = true;
    }),
    x11Root,
  );
  // the GL window is made once the visual query answers
  await waitFor(() => drew, 'the first frame');
  await settle(app);
  const windowNode = instance._reactX11Node;
  const find = (n) =>
    n.kind === 'glarea' ? n : n.children.map(find).find(Boolean);
  const area = find(windowNode);
  assert.ok(area?.window, 'the surface has a window of its own');
  const at = (x, y) => {
    const wnd = windowNode.window;
    const origin = wnd._screenOrigin ?? { x: wnd.x ?? 0, y: wnd.y ?? 0 };
    server.injectPointerMove(origin.x + x, origin.y + y);
  };
  return {
    app,
    windowNode,
    area,
    at,
    press: (button = 1) => server.injectButton(button, true),
    release: (button = 1) => server.injectButton(button, false),
    async close() {
      await x11Root.unmount();
      await app.close();
    },
  };
}

test('the pointer over the surface is dispatched at the <glarea>, and bubbles', async () => {
  const seen = [];
  const log = (who) => (ev) =>
    seen.push({
      who,
      type: ev.type,
      target: ev.target,
      at: [ev.x, ev.y],
      local: [ev.localX, ev.localY],
      button: ev.button,
      detail: ev.detail,
    });
  const s = await mountSurface((onDraw) =>
    h(
      'window',
      { width: 320, height: 240 },
      h(
        'box',
        {
          style: { flexGrow: 1, padding: 20 },
          focusable: true,
          onMouseDown: log('pane'),
          onClick: log('pane'),
        },
        h('glarea', {
          style: { flexGrow: 1 },
          onDraw,
          onMouseDown: log('area'),
          onMouseMove: log('area'),
          onMouseUp: log('area'),
          onClick: log('area'),
        }),
      ),
    ),
  );
  try {
    const { area } = s;
    const pane = area.parent;
    const of = (who, type) =>
      seen.filter((e) => e.who === who && e.type === type);
    assert.equal(area.forwardsPointer, true);
    assert.equal(
      GlAreaNode.prototype.forwardsPointer,
      true,
      'askable without rendering anything',
    );
    // the mechanism, pinned: the surface's own window selects no pointer
    // input, so none of it stops there
    assert.equal(area.window.eventMask & POINTER_INPUT, 0);

    s.at(60, 70);
    await waitFor(() => of('area', 'mouseMove').length > 0, 'a move over it');
    s.press();
    await waitFor(() => of('area', 'mouseDown').length > 0, 'the press');
    s.at(90, 100);
    await waitFor(() => of('area', 'mouseMove').length > 1, 'the drag');
    s.release();
    await waitFor(() => of('area', 'click').length > 0, 'the click');

    const [down] = of('area', 'mouseDown');
    assert.equal(down.target, area, 'the <glarea>, not the box behind it');
    // the owning window's coordinates, and the surface's own corner
    assert.deepEqual(down.at, [60, 70]);
    assert.deepEqual(down.local, [40, 50]);
    assert.equal(down.button, 1);
    assert.equal(of('pane', 'mouseDown')[0]?.target, area, 'it bubbled');
    assert.deepEqual(of('area', 'mouseMove').at(-1).at, [90, 100]);
    assert.equal(of('area', 'mouseUp').length, 1);
    const [click] = of('area', 'click');
    assert.equal(click.target, area);
    assert.equal(click.detail, 1);
    assert.equal(of('pane', 'click')[0]?.target, area);
    // and the press focused the nearest focusable ancestor, as anywhere
    assert.equal(pane.focused, true);
  } finally {
    await s.close();
  }
});

test('a drag that leaves the surface keeps coming, to whatever holds it', async () => {
  // The press lands on the owning window, so the implicit grab is that
  // window's: motion and the release keep arriving however far the pointer
  // goes. Before, the grab was the surface's — it had taken the press — and
  // it had selected neither, so a drag off a <glarea> was simply lost.
  for (const capture of [false, true]) {
    const seen = [];
    const log = (who) => (ev) =>
      seen.push({ who, type: ev.type, target: ev.target, x: ev.x });
    const s = await mountSurface((onDraw) =>
      h(
        'window',
        {
          width: 320,
          height: 240,
          onMouseMove: log('window'),
          onClick: log('window'),
        },
        h(
          'box',
          { style: { flexDirection: 'row', flexGrow: 1 } },
          h('glarea', {
            key: 'gl',
            style: { width: 150 },
            onDraw,
            onMouseDown: (ev) => {
              if (capture) ev.capturePointer();
              log('area')(ev);
            },
            onMouseMove: log('area'),
            onMouseUp: log('area'),
            onClick: log('area'),
          }),
          h('box', {
            key: 'side',
            style: { flexGrow: 1 },
            onMouseMove: log('side'),
          }),
        ),
      ),
    );
    try {
      const { area, windowNode } = s;
      const side = area.parent.children[1];
      const moved = (x) =>
        seen.some((e) => e.type === 'mouseMove' && e.x === x);
      s.at(40, 40);
      await waitFor(() => moved(40), 'a move over the surface');
      s.press();
      await waitFor(() => seen.some((e) => e.type === 'mouseDown'), 'press');
      s.at(200, 40); // over the box beside the surface
      await waitFor(() => moved(200), 'a move beside it');
      s.at(500, 400); // out of the window altogether
      await waitFor(() => moved(500), 'a move outside the window');
      s.release();
      await waitFor(
        () => seen.some((e) => e.type === 'click'),
        'the click the release makes',
      );
      const moveAt = (who, x) =>
        seen.find((e) => e.who === who && e.type === 'mouseMove' && e.x === x);
      const click = seen.find((e) => e.type === 'click');
      if (capture) {
        assert.equal(moveAt('area', 200)?.target, area, capture);
        assert.equal(moveAt('area', 500)?.target, area);
        assert.equal(moveAt('side', 200), undefined, 'the box heard nothing');
        const up = seen.find((e) => e.type === 'mouseUp');
        assert.equal(up?.who, 'area');
        assert.equal(up?.target, area);
        assert.equal(click.target, area, 'released on the captor');
      } else {
        // uncaptured, a move is whatever it is over — the box beside, then
        // the window itself — as for a drag that started anywhere else
        assert.equal(moveAt('side', 200)?.target, side);
        assert.equal(moveAt('window', 500)?.target, windowNode.window);
        assert.equal(moveAt('area', 500), undefined);
        // and the click is the nearest common ancestor's, the window's
        assert.equal(click.who, 'window');
        assert.equal(click.target, windowNode.window);
      }
    } finally {
      await s.close();
    }
  }
});

test('a double click on the surface counts, and the right button asks for its context menu', async () => {
  const seen = [];
  const log = (ev) =>
    seen.push({
      type: ev.type,
      target: ev.target,
      button: ev.button,
      detail: ev.detail,
    });
  const s = await mountSurface((onDraw) =>
    h(
      'window',
      { width: 320, height: 240 },
      h('glarea', {
        style: { flexGrow: 1 },
        onDraw,
        onClick: log,
        onContextMenu: log,
      }),
    ),
  );
  try {
    s.at(100, 100);
    s.press();
    s.release();
    s.press();
    s.release();
    const clicks = () => seen.filter((e) => e.type === 'click');
    await waitFor(() => clicks().length === 2, 'two clicks');
    assert.deepEqual(
      clicks().map((e) => [e.target, e.detail]),
      [
        [s.area, 1],
        [s.area, 2],
      ],
    );
    s.press(3);
    s.release(3);
    await waitFor(
      () => seen.some((e) => e.type === 'contextMenu'),
      'the context menu',
    );
    const menu = seen.find((e) => e.type === 'contextMenu');
    assert.equal(menu.target, s.area);
    assert.equal(menu.button, 3);
  } finally {
    await s.close();
  }
});

test('a wheel notch over the surface is one Wheel at the <glarea>, and no press', async () => {
  // Buttons 4-7 are the core protocol's wheel. ntk makes a `wheel` of the
  // press on the owning window and the manager drops the press itself on the
  // button path, so a notch over a surface is one event — not a Wheel plus a
  // click nobody made.
  const seen = [];
  const log = (ev) =>
    seen.push({ type: ev.type, target: ev.target, deltaY: ev.deltaY });
  const s = await mountSurface((onDraw) =>
    h(
      'window',
      { width: 320, height: 240 },
      h('glarea', {
        style: { flexGrow: 1 },
        onDraw,
        onWheel: log,
        onMouseDown: log,
        onMouseUp: log,
        onClick: log,
      }),
    ),
  );
  try {
    s.at(100, 100);
    s.press(5);
    s.release(5);
    await waitFor(() => seen.length > 0, 'the wheel');
    await settle(s.app);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      seen.map((e) => e.type),
      ['wheel'],
    );
    assert.equal(seen[0].target, s.area);
    // pixels, not notches — the same conversion every other wheel gets
    assert.equal(seen[0].deltaY, WHEEL_NOTCH_PX);
  } finally {
    await s.close();
  }
});

test('the pointer crossing onto the surface is not a leave', async () => {
  // X reports the crossing into a child window as the parent's LeaveNotify.
  // Over a surface that is not the pointer leaving anything the tree can
  // see: the motion still arrives at the window and names the <glarea>. So
  // the ancestors stay hovered — they used to be told the pointer had gone
  // and then that it was back — and the window hears no mouseOut.
  const counts = {
    paneEnter: 0,
    paneLeave: 0,
    areaEnter: 0,
    areaLeave: 0,
    windowOut: 0,
  };
  const bump = (key) => () => {
    counts[key] += 1;
  };
  const s = await mountSurface((onDraw) =>
    h(
      'window',
      { width: 320, height: 240, onMouseOut: bump('windowOut') },
      h(
        'box',
        {
          style: { flexGrow: 1, padding: 40 },
          onMouseEnter: bump('paneEnter'),
          onMouseLeave: bump('paneLeave'),
        },
        h('glarea', {
          style: { flexGrow: 1 },
          onDraw,
          onMouseEnter: bump('areaEnter'),
          onMouseLeave: bump('areaLeave'),
        }),
      ),
    ),
  );
  try {
    const { area } = s;
    const pane = area.parent;
    s.at(10, 10); // the pane's padding
    await waitFor(() => counts.paneEnter === 1, 'the pane hovered');
    s.at(100, 100); // onto the surface
    await waitFor(() => counts.areaEnter === 1, 'the surface hovered');
    assert.equal(counts.paneLeave, 0, 'the pane was never left');
    assert.equal(counts.windowOut, 0, 'nor the window');
    assert.equal(area.states[':hover'], true);
    assert.equal(pane.states[':hover'], true);
    s.at(10, 10); // and back off it
    await waitFor(() => counts.areaLeave === 1, 'the surface left');
    assert.deepEqual(
      [counts.paneEnter, counts.paneLeave, counts.windowOut],
      [1, 0, 0],
    );
  } finally {
    await s.close();
  }
});

test('a grab that ends over the surface is not a leave; one taken elsewhere is', async () => {
  // The one test here that emits rather than injects: the in-process server
  // sends no crossings for grabs, so these are the LeaveNotify shapes Xvfb
  // sent the owning window, replayed on it.
  //
  // Every click and wheel notch over a surface ends the press's implicit
  // grab — the owning window's — with the pointer still on the surface:
  // detail NotifyInferior, mode NotifyUngrab, no child. Taken for a leave,
  // hover went out from under the pointer after every click. A grab taken
  // by another window while the pointer is on the surface is a real leave:
  // detail NotifyNonlinearVirtual, mode NotifyGrab, the surface as child.
  const counts = { paneLeave: 0, areaEnter: 0, areaLeave: 0, windowOut: 0 };
  const bump = (key) => () => {
    counts[key] += 1;
  };
  const s = await mountSurface((onDraw) =>
    h(
      'window',
      { width: 320, height: 240, onMouseOut: bump('windowOut') },
      h(
        'box',
        {
          style: { flexGrow: 1, padding: 40 },
          onMouseLeave: bump('paneLeave'),
        },
        h('glarea', {
          style: { flexGrow: 1 },
          onDraw,
          onMouseEnter: bump('areaEnter'),
          onMouseLeave: bump('areaLeave'),
        }),
      ),
    ),
  );
  try {
    s.at(100, 100);
    await waitFor(() => counts.areaEnter === 1, 'the surface hovered');
    const wnd = s.windowNode.window;
    const leave = (fields) =>
      wnd.emit('mouseout', { x: 100, y: 100, buttons: 0, ...fields });
    leave({ detail: 2, mode: 2, child: 0 }); // the ungrab after a click
    assert.deepEqual(
      [counts.areaLeave, counts.paneLeave, counts.windowOut],
      [0, 0, 0],
      'still over the surface',
    );
    leave({ detail: 4, mode: 1, child: s.area.window.id }); // a grab elsewhere
    assert.deepEqual(
      [counts.areaLeave, counts.paneLeave, counts.windowOut],
      [1, 1, 1],
      'the pointer is the grab’s now',
    );
  } finally {
    await s.close();
  }
});

test("pointerEvents: 'none' on the surface lets the pointer through to the tree behind it", async () => {
  const seen = [];
  const s = await mountSurface((onDraw) =>
    h(
      'window',
      { width: 320, height: 240 },
      h(
        'box',
        {
          style: { flexGrow: 1, padding: 20 },
          onMouseDown: (ev) => seen.push(ev.target),
        },
        h('glarea', {
          style: { flexGrow: 1, pointerEvents: 'none' },
          onDraw,
        }),
      ),
    ),
  );
  try {
    s.at(100, 100);
    s.press();
    s.release();
    await waitFor(() => seen.length > 0, 'the press');
    assert.equal(seen[0], s.area.parent, 'the box behind the surface took it');
  } finally {
    await s.close();
  }
});

test('a <glarea> paces its frames by the window it is in, or by its own frameRate', async () => {
  const { app } = await createGlApp();
  const x11Root = await createRoot({ app });
  try {
    let drawn = 0;
    const instance = await render(
      h(
        'window',
        { width: 320, height: 240, frameRate: 'adaptive' },
        h('glarea', {
          key: 'gl',
          frameLoop: 'always',
          onDraw: () => {
            drawn += 1;
          },
          style: { flexGrow: 1 },
        }),
      ),
      x11Root,
    );
    await waitFor(() => drawn > 0, 'the first frame');
    const node = instance._reactX11Node;
    const area = node.children[0];
    assert.equal(area.kind, 'glarea');
    // no frameRate of its own: the window's policy is the surface's
    assert.equal(area._pacer.policy.mode, 'adaptive');
    assert.equal(area._pacer.stats.budget, 0.25);
    // the loop runs on the child window's clock; a frame is priced by what
    // onDraw and the swap cost this thread, and a cheap scene never waits
    await waitFor(() => drawn > 5, 'the loop');
    assert.equal(area._pacer.stats.deferred, 0);
    assert.ok(area._pacer.stats.frames >= 5);
    // an expensive scene is held: the pacer's clock, moved by the draw
    // (8ms of GL encoding a frame) and by the waits it asks for — the
    // real wait is a short real timer, so the loop keeps going
    let t = 5000;
    const waits = [];
    area._pacer.clock = {
      now: () => t,
      after(ms, fn) {
        waits.push(ms);
        const timer = setTimeout(() => {
          t += ms;
          fn();
        }, 1);
        return () => clearTimeout(timer);
      },
    };
    const before = drawn;
    const onDraw = () => {
      drawn += 1;
      t += 8;
    };
    x11Root.render(
      h(
        'window',
        { width: 320, height: 240, frameRate: 'adaptive' },
        h('glarea', {
          key: 'gl',
          frameLoop: 'always',
          onDraw,
          style: { flexGrow: 1 },
        }),
      ),
    );
    await waitFor(() => drawn > before + 12, 'a dozen expensive frames');
    assert.ok(area._pacer.stats.deferred > 0, 'held');
    // three times the cost, once the burst is spent
    assert.ok(Math.abs(waits.at(-1) - 24) < 1e-6, `waited ${waits.at(-1)}`);
    assert.ok(
      waits.every((w) => w <= 24 + 1e-6),
      `never more than that: ${waits.slice(-3)}`,
    );
    // its own frameRate wins over the window's
    x11Root.render(
      h(
        'window',
        { width: 320, height: 240, frameRate: 'adaptive' },
        h('glarea', {
          key: 'gl',
          frameLoop: 'always',
          frameRate: 'display',
          onDraw,
          style: { flexGrow: 1 },
        }),
      ),
    );
    await waitFor(() => area._pacer.policy.mode === 'display', 'its own');
    assert.equal(area._pacer.active, false);
    await x11Root.unmount();
    await settle(app);
    assert.equal(area._pacer.deferring, false, 'a wait dies with the node');
  } finally {
    await app.close();
  }
});
