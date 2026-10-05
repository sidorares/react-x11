// The Wayland backend's pure pieces: colour and font parsing, the rectangle
// batch's argument shapes, damage merging, the decorations' geometry and
// hit-testing. No compositor, no GPU.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';

import {
  WaylandContext2D,
  parseColor,
  parseFont,
} from '../../src/wayland/context2d.js';
import {
  flushDevice,
  glDevice,
  releaseDevice,
} from '../../src/wayland/device.js';
import { unionDamage } from '../../src/wayland/swapchain.js';
import { Decorations, RESIZE_MARGIN } from '../../src/wayland/decorations.js';
import { RESIZE_EDGE, TOPLEVEL_STATE } from '../../src/wayland/window.js';

const close = (a, b, eps = 1 / 255) => Math.abs(a - b) <= eps;

test('parseColor: hex, rgba, names, premultiplied', () => {
  assert.deepEqual([...parseColor('#ff0000')], [1, 0, 0, 1]);
  assert.deepEqual([...parseColor('#f00')], [1, 0, 0, 1]);
  const half = parseColor('#00ff0080');
  assert.ok(
    close(half[1], 128 / 255) && close(half[3], 128 / 255),
    'alpha premultiplies the channels',
  );
  assert.ok(close(half[0], 0));
  const rgba = parseColor('rgba(0, 0, 255, 0.5)');
  assert.ok(close(rgba[2], 0.5) && close(rgba[3], 0.5));
  assert.deepEqual([...parseColor('rgb(255 128 0)')], [1, 128 / 255, 0, 1]);
  assert.deepEqual([...parseColor('transparent')], [0, 0, 0, 0]);
  assert.deepEqual([...parseColor('white')], [1, 1, 1, 1]);
  assert.deepEqual(
    [...parseColor('nonsense')],
    [0, 0, 0, 1],
    'unknown colours are opaque black, not a throw',
  );
  assert.equal(
    parseColor('#abcdef'),
    parseColor('#abcdef'),
    'memoised: the same string is the same frozen array',
  );
});

test('parseFont: the CSS shorthand a UI writes', () => {
  assert.deepEqual(parseFont('16px sans-serif'), {
    italic: false,
    weight: 400,
    size: 16,
    family: 'sans-serif',
  });
  assert.deepEqual(parseFont('bold 14px "Inter", sans-serif'), {
    italic: false,
    weight: 700,
    size: 14,
    family: 'Inter',
  });
  assert.deepEqual(parseFont('italic 600 12.5px monospace'), {
    italic: true,
    weight: 600,
    size: 12.5,
    family: 'monospace',
  });
  assert.equal(parseFont('12pt serif').size, 16, 'points convert to pixels');
  assert.deepEqual(parseFont('garbage'), {
    italic: false,
    weight: 400,
    size: 16,
    family: 'sans-serif',
  });
});

test('unionDamage: all wins, null is nothing, sets stay small', () => {
  const r = (x) => ({ x, y: 0, width: 1, height: 1 });
  assert.equal(unionDamage('all', [r(1)]), 'all');
  assert.equal(unionDamage(null, null), null);
  assert.deepEqual(unionDamage(null, [r(1)]), [r(1)]);
  assert.deepEqual(unionDamage([r(1)], [r(2)]), [r(1), r(2)]);
  const many = Array.from({ length: 6 }, (_, i) => r(i));
  assert.equal(
    unionDamage(many, many),
    'all',
    'past a handful of rectangles the whole buffer is cheaper',
  );
});

test('decorations: insets, geometry and hit-testing', () => {
  const d = new Decorations();
  // no shell window yet: no margin, just the 47px headerbar and its hairline
  assert.deepEqual(d.insets(), { top: 48, left: 0, right: 0, bottom: 0 });
  const m = { left: 24, top: 20, right: 24, bottom: 30 };
  d.marginsOf = () => m;
  assert.deepEqual(d.insets(), {
    top: 20 + 48,
    left: 24,
    right: 24,
    bottom: 30,
  });
  d.setState(new Set([TOPLEVEL_STATE.FULLSCREEN]));
  assert.deepEqual(
    d.insets(),
    { top: 0, left: 0, right: 0, bottom: 0 },
    'fullscreen has no frame at all',
  );
  d.setState(new Set([TOPLEVEL_STATE.ACTIVATED]));

  const W = 400 + 48;
  const H = 300 + 50;
  // the band outside the window resizes, corners both ways
  assert.deepEqual(d.hitTest(24 - 2, 20 - 2, W, H), {
    kind: 'resize',
    edges: RESIZE_EDGE.TOP_LEFT,
  });
  assert.deepEqual(d.hitTest(24 - RESIZE_MARGIN + 1, 20 + 150, W, H), {
    kind: 'resize',
    edges: RESIZE_EDGE.LEFT,
  });
  assert.deepEqual(d.hitTest(24 + 200, 20 + 300 + 3, W, H), {
    kind: 'resize',
    edges: RESIZE_EDGE.BOTTOM,
  });
  // GNOME's default layout, 'appmenu:close': one button, 24px from the right
  assert.deepEqual(d.hitTest(24 + 400 - 24, 20 + 23, W, H), {
    kind: 'button',
    id: 'close',
  });
  assert.deepEqual(d.hitTest(24 + 100, 20 + 20, W, H), { kind: 'titlebar' });
  assert.deepEqual(d.hitTest(24 + 100, 20 + 100, W, H), { kind: 'content' });
  assert.equal(
    Decorations.cursorFor({ kind: 'resize', edges: RESIZE_EDGE.TOP_LEFT }),
    'nwse-resize',
  );
});

// `fillRects` is the one call react-x11's own paint paths batch through —
// text selection bands, the small-text strip, textarea highlights, preedit
// underlines — and every one of them builds the flat list
// `Render.FillRectangles` takes on the wire. ntk and the Cocoa context both
// accept it, so this backend reading it as one rectangle per element drew
// nothing at all, with no throw to say so (#564).
test('fillRects: the three argument shapes are the same drawing', () => {
  // no GL entry point is touched before the first draw, and `_rect` — the
  // funnel every fill in the context goes through — is stubbed out here
  const drawn = (rects) => {
    const ctx = new WaylandContext2D(null);
    const seen = [];
    ctx._rect = (x, y, w, h, radius, style) =>
      seen.push([x, y, w, h, radius, style]);
    ctx.fillStyle = '#ff0000';
    ctx.fillRects(rects);
    return seen;
  };

  const expected = [
    [0, 0, 64, 64, 0, '#ff0000'],
    [8, 8, 4, 4, 0, '#ff0000'],
  ];
  assert.deepEqual(drawn([0, 0, 64, 64, 8, 8, 4, 4]), expected, 'flat');
  assert.deepEqual(
    drawn([
      [0, 0, 64, 64],
      [8, 8, 4, 4],
    ]),
    expected,
    'one array per rectangle',
  );
  assert.deepEqual(
    drawn([
      { x: 0, y: 0, width: 64, height: 64 },
      { x: 8, y: 8, w: 4, h: 4 },
    ]),
    expected,
    'objects, width/height or w/h',
  );

  assert.deepEqual(drawn([]), [], 'an empty batch draws nothing');
  assert.deepEqual(drawn(undefined), [], 'and neither does no batch at all');
  assert.deepEqual(
    drawn([0, 0, 64, 64, 8, 8]),
    [expected[0]],
    'a trailing partial rectangle is not one',
  );
});

// The bookkeeping the contexts share, without any of them: one record per
// `gl`, an owner that `releaseDevice` drops, and — the case every seam
// above the first draw depends on — a context built with no GL at all
// (`new WaylandContext2D(null)`, the two tests above) getting a record of
// its own instead of an error out of the WeakMap (#566).
test('glDevice: one record per gl, and none to share without one', () => {
  const gl = {};
  assert.equal(glDevice(gl), glDevice(gl), 'the same gl, the same record');
  assert.notEqual(glDevice(gl), glDevice({}), 'another gl, another record');

  const owner = {};
  glDevice(gl).owner = owner;
  assert.equal(glDevice(gl).owner, owner, 'the owner is what was set');
  releaseDevice(gl);
  assert.equal(glDevice(gl).owner, null, 'and released is nobody');

  for (const none of [null, undefined]) {
    const device = glDevice(none);
    assert.deepEqual(device, { owner: null }, `${none}: a record of its own`);
    assert.notEqual(device, glDevice(none), `${none}: shared with nothing`);
    releaseDevice(none); // and saying so of one is not an error
  }
});

/**
 * A GLES that records the objects made and deleted, and answers every other
 * entry point with nothing: enough for `init()` and `destroy()`, which touch
 * no pixels. `fail` names the step that reports failure.
 */
function recordingGl({ fail } = {}) {
  let next = 1;
  const live = { shader: new Set(), program: new Set(), texture: new Set() };
  const calls = {
    createTexture() {
      const t = { texture: next++ };
      live.texture.add(t);
      return t;
    },
    deleteTexture: (t) => live.texture.delete(t),
    createShader(type) {
      const sh = { shader: next++, type };
      live.shader.add(sh);
      return sh;
    },
    deleteShader: (sh) => live.shader.delete(sh),
    createProgram() {
      const p = { program: next++ };
      live.program.add(p);
      return p;
    },
    deleteProgram: (p) => live.program.delete(p),
    getShaderParameter: (sh) =>
      !(fail === 'fragment' && sh.type === 'FRAGMENT_SHADER'),
    getProgramParameter: () => fail !== 'link',
    getShaderInfoLog: () => 'no',
    getProgramInfoLog: () => 'no',
    getAttribLocation: () => 0,
    getUniformLocation: () => ({}),
    createBuffer: () => ({ buffer: next++ }),
  };
  const gl = new Proxy(calls, {
    get: (target, name) =>
      name in target
        ? target[name]
        : /^[A-Z_0-9]+$/.test(name)
          ? name
          : () => undefined,
  });
  return { gl, live };
}

// Deleting a program detaches its shaders and leaves them (GLES 3.0, 7.3),
// so a context that never deleted the two it linked from left them behind —
// a window's once, and an offscreen surface's every time one is made: a
// resize that makes a surface a frame leaked two shader objects a frame.
test('a context deletes the shaders its program is linked from', () => {
  const { gl, live } = recordingGl();
  const ctx = new WaylandContext2D(gl);
  ctx.init();
  assert.equal(live.shader.size, 0, 'no shader outlives the link');
  assert.equal(live.program.size, 1, 'the program is kept');
  ctx.destroy();
  assert.equal(live.program.size, 0, 'and goes with the context');

  for (let i = 0; i < 5; i++) {
    const another = new WaylandContext2D(gl);
    another.init();
    another.destroy();
  }
  assert.equal(live.shader.size + live.program.size, 0, 'nor five more');
});

// The program is the device's: each offscreen surface's context compiled
// and linked its own, a few milliseconds a surface.
test('the contexts on one device share one program', () => {
  const { gl, live } = recordingGl();
  const contexts = [0, 1, 2].map(() => new WaylandContext2D(gl));
  for (const ctx of contexts) ctx.init();
  assert.equal(live.program.size, 1, 'one program for three contexts');
  contexts[0].destroy();
  contexts[1].destroy();
  assert.equal(live.program.size, 1, 'kept while a context holds it');
  contexts[2].destroy();
  contexts[2].destroy(); // and a second destroy is not a second release
  assert.equal(live.program.size, 0, 'and deleted with the last');
  const again = new WaylandContext2D(gl);
  again.init();
  assert.equal(live.program.size, 1, 'a new context builds it again');
  again.destroy();
  assert.equal(live.shader.size + live.program.size, 0, 'leaving nothing');
});

test('a context that fails to build its program leaves nothing behind', () => {
  for (const fail of ['fragment', 'link']) {
    const { gl, live } = recordingGl({ fail });
    const ctx = new WaylandContext2D(gl);
    assert.throws(
      () => ctx.init(),
      new RegExp(fail === 'link' ? 'link' : 'compile'),
    );
    assert.equal(live.shader.size, 0, `${fail}: no shader left`);
    assert.equal(live.program.size, 0, `${fail}: no program left`);
  }
});

// A gradient's texture and an image's are found by the object, in a
// WeakMap, which cannot say when its key goes: the entry went with the key
// and the texture stayed in the driver. A page that makes its gradients as
// it paints made a texture a paint; a surface's context left behind
// everything it had uploaded.
test('a context deletes the textures it made when it is destroyed', () => {
  const { gl, live } = recordingGl();
  const ctx = new WaylandContext2D(gl);
  ctx.begin(64, 64);
  for (let i = 0; i < 20; i++) {
    const grad = ctx.createLinearGradient(0, 0, 64, 0);
    grad.addColorStop(0, '#ff0000');
    grad.addColorStop(1, '#0000ff');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
  }
  const image = ctx.createImageData(4, 4);
  ctx.drawImage(image, 0, 0);
  ctx.end();
  assert.ok(live.texture.size >= 21, 'a texture a gradient, and the image');
  ctx.destroy();
  assert.equal(live.texture.size, 0, 'and none left behind');
});

test("a gradient's texture goes when the gradient does", async () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const { gl, live } = recordingGl();
  const ctx = new WaylandContext2D(gl);
  ctx.begin(64, 64);
  const paint = () => {
    const grad = ctx.createLinearGradient(0, 0, 64, 0);
    grad.addColorStop(0, '#ff0000');
    grad.addColorStop(1, '#0000ff');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#000000';
  };
  for (let i = 0; i < 10; i++) paint();
  ctx.end();
  assert.equal(live.texture.size, 10, 'one a gradient');
  // a finaliser runs a task or so after the collection that found its key
  for (let turn = 0; turn < 50 && live.texture.size > 0; turn++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(live.texture.size, 0, 'and each went with its gradient');
  ctx.destroy();
});

// The other half of the record: a context buffers its quads, so a target's
// texture is only as current as the last flush. Anything about to *read*
// those pixels flushes the device first — which is one context, because the
// owner is the only one that can be holding anything (#578).
test('flushDevice: the owner draws what it still had buffered', () => {
  const gl = {};
  let flushed = 0;
  const owner = {
    flush() {
      flushed++;
    },
  };

  flushDevice(gl); // nobody owns it: nothing to draw, and not an error
  assert.equal(flushed, 0);

  glDevice(gl).owner = owner;
  flushDevice(gl);
  assert.equal(flushed, 1, 'the owner was asked to draw');

  releaseDevice(gl);
  flushDevice(gl);
  assert.equal(flushed, 1, 'and released, it is not asked again');

  for (const none of [null, undefined]) flushDevice(none); // not an error
});
