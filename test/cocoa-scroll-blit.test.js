// The Cocoa swapchain's scroll blit, in pixels (issue #458).
//
// `CocoaWindow.scrollRegion` shifts a band inside the BACK buffer of the
// IOSurface swapchain — the buffer nobody is looking at — and the frame
// repaints only the strips the shift exposed. What carries that band into
// the *other* buffer is the flip's catch-up copy (`present`), fed by the
// rects the flush reported (`noteFrameDamage`). Get that wrong by one frame
// and a pan smears: a band one shift stale, blitted again next frame, and
// again — a staircase of duplicated content at increasing offsets.
//
// The other tests here count calls, which is the right shape for a frame
// clock. This one is about the picture, so the bridge holds real rasters:
// a byte per pixel, the natives' own clamping and copy semantics, and a
// record of which buffer is on glass. The proof obligation is one line —
// **the buffer handed to the layer must hold the same picture a backend
// with no fast path would have painted** — and the way to check it is to
// render the same pane twice in one app, deleting `scrollRegion` on the
// second window, which is exactly how nodes.js feature-detects a backend
// without the blit (`typeof wnd?.scrollRegion !== 'function'`).
//
// Then the frames a pan actually meets: several pans coalesced into one
// frame, frames the pump paints but does not present, a window held or
// occluded across a blit, and a resize landing mid-gesture.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import { CocoaApp } from '../src/cocoa/app.js';
import { setCompositingForTests } from '../src/compositing.js';
import { registerElement } from '../src/host.js';
import { createRoot } from '../src/index.js';
import { Node } from '../src/node.js';
import { setScaleForTests } from '../src/scale.js';
import { setScreensForTests } from '../src/screens.js';

process.env.NO_AT_BRIDGE ??= '1';

const h = React.createElement;
const SCALE = 2;

// --- the bridge, with pixels in it -------------------------------------------

/**
 * A raster: one byte per pixel, which is enough to tell a wrong picture from
 * a right one and keeps the whole window comparable with `Buffer.equals`.
 * The verbs below are @windowkit/appkit's, with its clamping — a rect that
 * pokes out of the surface is trimmed, not refused (src/backend.mm
 * `ScrollSurface`, `CopySurfaceRegion`).
 */
function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

function raster(width, height) {
  return { width, height, px: new Uint8Array(width * height) };
}

function fillRect(surface, x, y, w, h, value, clip) {
  let x0 = Math.round(x);
  let y0 = Math.round(y);
  let x1 = x0 + Math.round(w);
  let y1 = y0 + Math.round(h);
  if (clip) {
    x0 = Math.max(x0, clip.x);
    y0 = Math.max(y0, clip.y);
    x1 = Math.min(x1, clip.x + clip.width);
    y1 = Math.min(y1, clip.y + clip.height);
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(surface.width, x1);
  y1 = Math.min(surface.height, y1);
  // an empty rect is nothing at all — and `TypedArray.fill` reads an end
  // index below the start as one counted back from the end of the array,
  // which would paint the whole row
  if (x1 <= x0 || y1 <= y0) return;
  for (let row = y0; row < y1; row++) {
    surface.px.fill(value, row * surface.width + x0, row * surface.width + x1);
  }
}

/** `ScrollSurface`: dest = clamped rect ∩ (clamped rect + delta), copied in
 *  the order that keeps a memmove correct. */
function scrollSurface(s, x, y, w, h, dx, dy) {
  if (!dx && !dy) return false;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const x0 = clamp(x, 0, s.width);
  const y0 = clamp(y, 0, s.height);
  const x1 = clamp(x + w, 0, s.width);
  const y1 = clamp(y + h, 0, s.height);
  const dstX0 = Math.max(x0, x0 + dx);
  const dstY0 = Math.max(y0, y0 + dy);
  const dstX1 = Math.min(x1, x1 + dx);
  const dstY1 = Math.min(y1, y1 + dy);
  if (dstX1 <= dstX0 || dstY1 <= dstY0) return false;
  const width = dstX1 - dstX0;
  const rows = [];
  for (let ty = dstY0; ty < dstY1; ty++) {
    rows.push(
      s.px.slice(
        (ty - dy) * s.width + dstX0 - dx,
        (ty - dy) * s.width + dstX0 - dx + width,
      ),
    );
  }
  for (let i = 0; i < rows.length; i++) {
    s.px.set(rows[i], (dstY0 + i) * s.width + dstX0);
  }
  return true;
}

/** `CopySurfaceRegion`: same-size surfaces, rects clamped, no rects at all
 *  (or a null list) copying everything. */
function copySurfaceRegion(src, dst, rects) {
  assert.equal(src.width, dst.width, 'copySurfaceRegion: size mismatch');
  assert.equal(src.height, dst.height, 'copySurfaceRegion: size mismatch');
  const one = (x, y, w, h) => {
    let x0 = x;
    let y0 = y;
    let x1 = x + w;
    let y1 = y + h;
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > src.width) x1 = src.width;
    if (y1 > src.height) y1 = src.height;
    for (let row = y0; row < y1; row++) {
      dst.px.set(
        src.px.subarray(row * src.width + x0, row * src.width + x1),
        row * src.width + x0,
      );
    }
  };
  if (!rects || rects.length === 0) {
    dst.px.set(src.px);
    return;
  }
  for (let i = 0; i + 3 < rects.length; i += 4) {
    one(rects[i], rects[i + 1], rects[i + 2], rects[i + 3]);
  }
}

/**
 * Enough of @windowkit/appkit to raster a box tree into a swapchain: the
 * window verbs of cocoa-frames.test.js's fake, plus a 2d context that
 * really draws. The context state is a colour and a clip stack, because
 * that is all the tree below paints with — anything else reaching the
 * bridge is a paint path this test does not model, and it throws rather
 * than quietly rastering nothing.
 */
function pixelBridge() {
  let seq = 0;
  let backendCb = null;
  const onGlass = new Map(); // layer -> the raster the WindowServer holds
  const state = new Map(); // surface -> { fill, clips: [] }
  const inks = new Map(); // "r,g,b,a" -> the byte that stands for it
  const stateOf = (s) => {
    let st = state.get(s);
    if (!st) state.set(s, (st = { fill: 0, clips: [], saved: [], path: null }));
    return st;
  };
  const native = {
    onGlass,
    listScreens: () => [
      {
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        scale: SCALE,
        visible: { x: 0, y: 0, width: 1440, height: 875 },
        primary: true,
      },
    ],
    createWindow2(options) {
      return { id: ++seq, options: { ...options } };
    },
    windowNumber: (handle) => handle.id,
    windowRootLayer: (handle) => ({ root: handle.id }),
    getWindowFrame: (handle) => ({
      x: handle.options.x ?? 0,
      y: handle.options.y ?? 0,
      width: handle.options.width,
      height: handle.options.height,
    }),
    windowIsVisible: () => true,
    showWindow() {},
    hideWindow() {},
    initApp() {},
    setBackendEventCallback(cb) {
      backendCb = cb;
    },
    emit: (ev) => backendCb?.(ev),
    setWindowFrame(handle, x, y, width, height) {
      if (typeof width === 'number') handle.options.width = width;
      if (typeof height === 'number') handle.options.height = height;
    },
    createSurfaceIOSurface(width, height) {
      const id = ++seq;
      return { handle: raster(width, height), iosurfaceId: id };
    },
    surfaceSize: (s) => ({ width: s.width, height: s.height, scale: SCALE }),
    releaseSurface() {},
    surfaceLock() {},
    surfaceUnlock() {},
    setLayerContentsIOSurface(layer, id) {
      onGlass.set(layer.root, id);
    },
    surfaceToLayer() {},
    copySurfaceRegion,
    scrollSurface: (s, ...a) => {
      const moved = scrollSurface(s, ...a);
      if (moved) native.blits++;
      return moved;
    },
    blits: 0,
    // --- the 2d context ----------------------------------------------------
    ctxSave(s) {
      const st = stateOf(s);
      st.saved.push({ fill: st.fill, clips: st.clips.slice() });
    },
    ctxRestore(s) {
      const st = stateOf(s);
      const was = st.saved.pop();
      if (!was) return;
      st.fill = was.fill;
      st.clips = was.clips;
    },
    ctxBeginPath(s) {
      stateOf(s).path = null;
    },
    ctxRect(s, x, y, w, height) {
      stateOf(s).path = {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(w),
        height: Math.round(height),
      };
    },
    ctxClip(s) {
      const st = stateOf(s);
      if (!st.path) return;
      const outer = st.clips[st.clips.length - 1];
      st.clips.push(outer ? intersect(outer, st.path) : st.path);
    },
    ctxSetFillColor(s, r, g, b, a) {
      // a byte per pixel: colours are interned rather than hashed, so two
      // inks are never confused for one and a wrong picture cannot pass
      const key = `${r},${g},${b},${a}`;
      let id = inks.get(key);
      if (id === undefined) inks.set(key, (id = inks.size + 1));
      stateOf(s).fill = id;
    },
    ctxFillRect(s, x, y, w, height) {
      const st = stateOf(s);
      fillRect(s, x, y, w, height, st.fill, st.clips[st.clips.length - 1]);
    },
    ctxClearRect(s, x, y, w, height) {
      fillRect(
        s,
        x,
        y,
        w,
        height,
        0,
        stateOf(s).clips[stateOf(s).clips.length - 1],
      );
    },
    ctxSetLineWidth() {},
    ctxSetLineCap() {},
    ctxSetLineJoin() {},
    ctxSetGlobalAlpha() {},
    ctxSetLineDash() {},
    ctxSetShadow() {},
    destroyWindow2() {},
  };
  return new Proxy(native, {
    get(target, key) {
      if (key in target) return target[key];
      // a paint that reaches a verb this bridge does not raster would
      // compare equal by drawing nothing at all in both windows
      if (typeof key === 'string' && key.startsWith('ctx')) {
        throw new Error(`pixelBridge: unmodelled paint verb ${key}`);
      }
      return () => undefined;
    },
  });
}

// --- the pane ----------------------------------------------------------------

const CELL = 24;
const GAP = 10;
const TINTS = [
  '#4c6ef5',
  '#12b886',
  '#fd7e14',
  '#be4bdb',
  '#e03131',
  '#212529',
];

/**
 * An element that owns a scene and pans it — the `<Flow>`/`<Map>` shape the
 * public seam was made for (issue #303). Its colours are a pure function of
 * where a cell sits in the *scene*, so a shifted copy of the last frame and
 * a repaint at the new offset are the same picture; anything else would be
 * this element's bug rather than the renderer's.
 */
class PanePane extends Node {
  constructor(props, app) {
    super('scrollblitpane', props, app);
    this.ox = 0;
    this.oy = 0;
    // The attribution bar's shape (`<Map>._blitPan`): a strip pinned to the
    // pane, carved out of the region that shifts and claimed the ordinary
    // way, so its pixels do not ride the blit.
    this.strip = 0;
    this.stripTint = '#adb5bd';
  }

  /** The region that shifts: everything but the pinned strip. */
  band() {
    const box = this.contentBox();
    return {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height - this.strip,
    };
  }

  pan(dx, dy) {
    if (!dx && !dy) return;
    this.ox += dx;
    this.oy += dy;
    this.scrollContents(this.band(), dx, dy);
    if (this.strip > 0) {
      const box = this.contentBox();
      this.invalidate(
        false,
        {
          x: box.x,
          y: box.y + box.height - this.strip,
          width: box.width,
          height: this.strip,
        },
        'scroll',
      );
    }
  }

  paint(ctx) {
    super.paint(ctx);
    const box = this.contentBox();
    if (!(box.width > 0 && box.height > 0)) return;
    const cell = CELL * this.scale;
    const pitch = (CELL + GAP) * this.scale;
    const damage = this.paintDamage();
    const band = this.band();
    ctx.save();
    ctx.beginPath();
    ctx.rect(band.x, band.y, band.width, band.height);
    ctx.clip();
    const c0 = Math.floor((-this.ox - cell) / pitch);
    const r0 = Math.floor((-this.oy - cell) / pitch);
    for (let r = r0; box.y + this.oy + r * pitch < band.y + band.height; r++) {
      for (let c = c0; box.x + this.ox + c * pitch < box.x + box.width; c++) {
        const x = box.x + this.ox + c * pitch;
        const y = box.y + this.oy + r * pitch;
        // culled against the frame's claim, the way a pane culls tiles: on
        // a blit frame that claim is the strip the shift exposed
        if (
          damage &&
          (x >= damage.x + damage.width ||
            damage.x >= x + cell ||
            y >= damage.y + damage.height ||
            damage.y >= y + cell)
        ) {
          continue;
        }
        ctx.fillStyle =
          TINTS[
            (((r * 7 + c * 3) % TINTS.length) + TINTS.length) % TINTS.length
          ];
        ctx.fillRect(x, y, cell, cell);
      }
    }
    ctx.restore();
    if (this.strip > 0) {
      ctx.fillStyle = this.stripTint;
      ctx.fillRect(
        box.x,
        box.y + box.height - this.strip,
        box.width,
        this.strip,
      );
    }
  }
}

registerElement('scrollblitpane', {
  create: (props, app) => new PanePane(props, app),
});

// --- the harness -------------------------------------------------------------

const tick = () => new Promise((resolve) => setImmediate(resolve));

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

/**
 * Two windows over one app, the same pane in each, and the fast path
 * feature-detected off in the second — `blit` is what the swapchain does,
 * `plain` is what it must agree with.
 */
async function mountPair({
  width = 160,
  height = 120,
  furniture = false,
} = {}) {
  const native = pixelBridge();
  const app = new CocoaApp(native);
  setScaleForTests(app, SCALE, 'cocoa');
  setScreensForTests(app, {
    monitors: [{ x: 0, y: 0, width: 2880, height: 1800 }],
    workArea: { x: 0, y: 0, width: 2880, height: 1750 },
  });
  setCompositingForTests(app, true);
  app._frameInterval = 0;
  const root = await createRoot({ app });
  roots.push(root);
  const win = (title, footer) =>
    h(
      'window',
      { width, height, title },
      h(
        'box',
        { style: { flexGrow: 1, flexDirection: 'column' } },
        h('scrollblitpane', {
          style: { flexGrow: 1, backgroundColor: '#ffffff' },
        }),
        footer
          ? h('box', {
              style: { height: 10, backgroundColor: footer },
            })
          : null,
      ),
    );
  const render = (footer) =>
    root.render(
      h(React.Fragment, null, win('blit', footer), win('plain', footer)),
    );
  render(furniture ? '#f1f3f5' : null);
  await tick();
  const [blit, plain] = [...app._windows.values()];
  plain.scrollRegion = null;
  const paneOf = (wnd) => {
    const walk = (node) => {
      if (node.kind === 'scrollblitpane') return node;
      for (const child of node.children ?? []) {
        const hit = walk(child);
        if (hit) return hit;
      }
      return null;
    };
    return walk(wnd._reactX11Node);
  };
  const frame = () => {
    app._tickFrames();
    app._presentAll();
  };
  // settle: the first frames lay the tree out, and a picture is only
  // comparable once both windows have painted the arrangement they keep
  frame();
  await tick();
  frame();
  await tick();
  frame();
  native.blits = 0;
  return {
    app,
    native,
    blit,
    plain,
    /** Pin a strip to the bottom of both panes, the way a map pins its
     *  attribution bar, and repaint it beside the band that shifts. */
    pinStrip: (device, tint) => {
      for (const pane of [paneOf(blit), paneOf(plain)]) {
        pane.strip = device;
        if (tint) pane.stripTint = tint;
      }
    },
    /** How many frames actually took the fast path — a test comparing two
     *  windows that both repainted would pass while proving nothing. */
    blits: () => native.blits,
    /** Repaint the furniture strip beside the pane — the attribution bar a
     *  map claims edge to edge with the region it shifts. */
    repaintFurniture: (tint) => render(tint),
    /** AppKit's delegate reporting a live-resize tick, for both windows. */
    resize: (w, hgt) => {
      for (const wnd of [blit, plain]) {
        native.emit({
          type: 'window-resize',
          windowNumber: wnd.windowNumber,
          width: w,
          height: hgt,
          x: 0,
          y: 0,
          live: true,
        });
      }
    },
    panes: [paneOf(blit), paneOf(plain)],
    frame,
    pan: (dx, dy) => {
      for (const pane of [paneOf(blit), paneOf(plain)]) pane.pan(dx, dy);
    },
    /** What the WindowServer holds for a window: the buffer of its last flip. */
    glass: (wnd) => {
      const shown = native.onGlass.get(wnd._layer.root);
      for (const buffer of [wnd._chain?.back, wnd._chain?.front]) {
        if (buffer?.iosurfaceId === shown) return buffer.handle;
      }
      throw new Error('no buffer on glass');
    },
  };
}

/** Where the two windows' presented pictures disagree, as a pixel count. */
function pictureDiff(a, b) {
  assert.equal(a.px.length, b.px.length);
  let diff = 0;
  for (let i = 0; i < a.px.length; i++) if (a.px[i] !== b.px[i]) diff++;
  return diff;
}

// --- the tests ---------------------------------------------------------------

test('a pan blits the surviving band and presents the picture a repaint would', async () => {
  const { pan, frame, blit, plain, glass, blits } = await mountPair();
  assert.equal(
    pictureDiff(glass(blit), glass(plain)),
    0,
    'the two windows start alike',
  );
  for (let i = 0; i < 40; i++) {
    pan(6, 4);
    frame();
    assert.equal(
      pictureDiff(glass(blit), glass(plain)),
      0,
      `frame ${i}: the blitted picture is not the painted one`,
    );
  }
  assert.equal(blits(), 40, 'every frame took the fast path');
});

test('the flip carries the shifted band into the other buffer', async () => {
  // The band moved inside the back buffer only. Two blits in a row is the
  // case that catches a catch-up copy covering the strips alone: the second
  // frame flips to a buffer whose band never moved.
  const { pan, frame, blit, plain, glass, blits } = await mountPair();
  for (let i = 0; i < 8; i++) {
    pan(9, 0);
    frame();
  }
  assert.equal(pictureDiff(glass(blit), glass(plain)), 0);
  // …and the buffer NOT on glass is the one the next frame blits, so it has
  // to hold the same picture too
  const shown = glass(blit);
  const spare =
    blit._chain.back === shown
      ? blit._chain.front.handle
      : blit._chain.back.handle;
  assert.equal(
    pictureDiff(spare, shown),
    0,
    'the spare buffer is a frame stale',
  );
  assert.equal(blits(), 8);
});

test('a pan across frames the pump does not present', async () => {
  const { app, pan, frame, blit, plain, glass, blits } = await mountPair();
  for (let i = 0; i < 30; i++) {
    pan(5, -3);
    // painted, not presented: the damage accumulates for the next flip
    app._tickFrames();
    pan(-4, 6);
    frame();
    assert.equal(pictureDiff(glass(blit), glass(plain)), 0, `frame ${i}`);
  }
  assert.equal(blits(), 60, 'both pans of every frame blitted');
});

test('a pan across a held and an occluded present', async () => {
  const { pan, frame, blit, plain, glass, blits } = await mountPair();
  for (let i = 0; i < 30; i++) {
    pan(7, 5);
    if (i % 3 === 0) {
      blit._occluded = plain._occluded = true;
      frame();
      blit._occluded = plain._occluded = false;
    } else if (i % 3 === 1) {
      blit._holdPresent = plain._holdPresent = true;
      frame();
      blit._holdPresent = plain._holdPresent = false;
    }
    frame();
    assert.equal(pictureDiff(glass(blit), glass(plain)), 0, `frame ${i}`);
  }
  assert.equal(blits(), 30);
});

test('several pans coalesced into one frame blit once, by the net shift', async () => {
  const { pan, frame, blit, plain, glass, blits } = await mountPair();
  const bursts = [
    [3, 2, -1, 4],
    [8, -5],
    [1, 1, 1, 1, 1],
    [-9, 7, 2],
  ];
  for (const burst of bursts) {
    for (let i = 0; i + 1 < burst.length; i += 2) pan(burst[i], burst[i + 1]);
    frame();
    assert.equal(pictureDiff(glass(blit), glass(plain)), 0);
  }
  assert.equal(blits(), bursts.length, 'one blit per frame, by the net shift');
});

test('a pan whose deltas and skipped frames come off a fuzzer', async () => {
  const { app, pan, frame, blit, plain, glass, blits } = await mountPair({
    width: 200,
    height: 150,
  });
  let seed = 20260904;
  const rng = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 400; i++) {
    const count = 1 + Math.floor(rng() * 3);
    for (let b = 0; b < count; b++) {
      pan(Math.round((rng() * 2 - 1) * 11), Math.round((rng() * 2 - 1) * 9));
    }
    const dice = rng();
    if (dice < 0.15) {
      blit._occluded = plain._occluded = true;
      frame();
      blit._occluded = plain._occluded = false;
    } else if (dice < 0.3) {
      blit._holdPresent = plain._holdPresent = true;
      frame();
      blit._holdPresent = plain._holdPresent = false;
    } else if (dice < 0.45) {
      app._tickFrames();
    }
    frame();
    assert.equal(pictureDiff(glass(blit), glass(plain)), 0, `frame ${i}`);
  }
  assert.ok(blits() > 300, `the fuzzer never took the fast path (${blits()})`);
});

test('a strip the element pins and repaints itself stays a blit', async () => {
  // The `<Map>` shape (react-x11#309/#310): the pane carves its attribution
  // bar out of the region it shifts and claims it exactly, edge to edge. The
  // claim lands beside the rect rather than inside it, so the frame stays a
  // blit — and the bar still repaints.
  const tints = ['#adb5bd', '#868e96', '#495057'];
  const { pan, frame, blit, plain, glass, panes, pinStrip, blits } =
    await mountPair();
  pinStrip(20, tints[0]);
  for (let i = 0; i < 24; i++) {
    pan(5, 3);
    for (const pane of panes) pane.stripTint = tints[i % tints.length];
    frame();
    assert.equal(pictureDiff(glass(blit), glass(plain)), 0, `frame ${i}`);
  }
  assert.equal(blits(), 24, 'the pinned strip cost the pan its fast path');
});

test('furniture whose claim reaches into the region falls back to a repaint', async () => {
  // The other side of the same seam: a sibling below the pane claims its
  // paint bounds, which carry a pixel of slop on every side for the ink that
  // bleeds out of a box — so the claim overlaps the region and the frame is
  // not a blit. Declining is the whole safety story of this fast path, and
  // the picture is what it always was.
  const tints = ['#f1f3f5', '#dee2e6', '#ced4da'];
  const { pan, frame, blit, plain, glass, repaintFurniture, blits } =
    await mountPair({ furniture: true });
  for (let i = 0; i < 24; i++) {
    pan(5, 3);
    repaintFurniture(tints[i % tints.length]);
    await tick();
    frame();
    assert.equal(pictureDiff(glass(blit), glass(plain)), 0, `frame ${i}`);
  }
  assert.ok(
    blits() <= 2,
    `a claim reaching the region blitted anyway (${blits()})`,
  );
});

test('a pan across a resize', async () => {
  // A live-resize tick replaces the swapchain pair under a gesture: the
  // frame that follows has a fresh surface holding nothing, which is what
  // `_freshSurface`/`_holdPresent` are for. A blit must not carry a band
  // out of a buffer that no longer exists.
  const { pan, frame, resize, blit, plain, glass, blits } = await mountPair();
  for (let i = 0; i < 12; i++) {
    pan(6, 4);
    frame();
    resize(160 + (i % 3) * 8, 120 + (i % 2) * 6);
    frame();
    pan(-7, 5);
    frame();
    assert.equal(pictureDiff(glass(blit), glass(plain)), 0, `frame ${i}`);
  }
  assert.ok(blits() >= 12, `the resizes ate every blit (${blits()})`);
});

test('a pan whose every frame the fuzzer picks apart', async () => {
  // Everything above at once, on an odd-sized window: bursts, furniture,
  // resizes, and presents the pump holds, skips or never runs.
  const tints = ['#f1f3f5', '#dee2e6', '#ced4da', '#adb5bd'];
  const {
    app,
    pan,
    frame,
    resize,
    repaintFurniture,
    pinStrip,
    panes,
    blit,
    plain,
    glass,
    blits,
  } = await mountPair({ width: 173, height: 131, furniture: true });
  pinStrip(18, '#adb5bd');
  let seed = 458;
  const rng = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 300; i++) {
    for (let b = 0, n = 1 + Math.floor(rng() * 3); b < n; b++) {
      pan(Math.round((rng() * 2 - 1) * 13), Math.round((rng() * 2 - 1) * 11));
    }
    if (rng() < 0.4) repaintFurniture(tints[Math.floor(rng() * tints.length)]);
    if (rng() < 0.5) {
      const tint = tints[Math.floor(rng() * tints.length)];
      for (const pane of panes) pane.stripTint = tint;
    }
    const dice = rng();
    if (dice < 0.12) {
      blit._occluded = plain._occluded = true;
      frame();
      blit._occluded = plain._occluded = false;
    } else if (dice < 0.24) {
      blit._holdPresent = plain._holdPresent = true;
      frame();
      blit._holdPresent = plain._holdPresent = false;
    } else if (dice < 0.36) {
      app._tickFrames();
    } else if (dice < 0.42) {
      resize(160 + Math.floor(rng() * 30), 120 + Math.floor(rng() * 20));
    }
    frame();
    assert.equal(pictureDiff(glass(blit), glass(plain)), 0, `frame ${i}`);
  }
  assert.ok(blits() > 50, `the fuzzer never took the fast path (${blits()})`);
});
