// A @windowkit/appkit-shaped bridge under a real CocoaApp: windows with a
// number and a frame, the surface swapchain, a layer tree that remembers
// its shape, and the font natives a `<text>` needs — so the surface
// presenter runs end to end over it, headless, on any OS, and a test pins
// what reached the natives and which frame it reached them in. The window
// half is test/cocoa-frames.test.js's fake, the font half
// test/cocoa-glyph-runs.test.js's; the layer half models what
// src/cocoa/promotion.js and the layer presenter both assert against.
import React from 'react';

import { CocoaApp, screenLayout } from '../../src/cocoa/app.js';
import { setCompositingForTests } from '../../src/compositing.js';
import { createRoot } from '../../src/index.js';
import { setScaleForTests } from '../../src/scale.js';
import { setScreensForTests } from '../../src/screens.js';

const h = React.createElement;

export function fakeCocoaBridge({ screens } = {}) {
  const calls = [];
  const released = new Set();
  const players = new Map();
  const fonts = new Map();
  // layout handle -> the text and lines it was laid out as
  const layouts = new WeakMap();
  let seq = 0;
  let backendCb = null;
  let presentation = null;
  const fontFor = (key, props) => {
    let font = fonts.get(key);
    if (!font) fonts.set(key, (font = { key, ...props }));
    return font;
  };
  const base = {
    calls,
    released,
    /** every recorded call of `name`, as its argument list */
    of: (name) => calls.filter((c) => c.name === name).map((c) => c.args),
    visible: true,
    emit: (ev) => backendCb?.(ev),
    setPresentation: (value) => {
      presentation = value;
    },

    // --- the app and its windows ---------------------------------------------
    listScreens: () =>
      screens ?? [
        {
          x: 0,
          y: 0,
          width: 1440,
          height: 900,
          scale: 2,
          visible: { x: 0, y: 0, width: 1440, height: 875 },
          primary: true,
        },
      ],
    /** The desk changed under the app: what `listScreens()` answers from
     *  now on. A monitor plugged in, unplugged or rearranged is exactly
     *  this and nothing else — the real bridge republishes its copy on
     *  macOS's notification and emits no event for it (#617). */
    setScreens: (next) => {
      screens = next;
    },
    initApp() {},
    setBackendEventCallback(cb) {
      backendCb = cb;
    },
    createWindow2(options) {
      const id = ++seq;
      return {
        id,
        options: { ...options },
        root: { layer: `root${id}`, props: {}, sublayers: [], parent: null },
      };
    },
    windowNumber: (handle) => handle.id,
    windowRootLayer: (handle) => handle.root,
    getWindowFrame: (handle) => ({
      x: handle.options.x ?? 0,
      y: handle.options.y ?? 0,
      width: handle.options.width,
      height: handle.options.height,
    }),
    showWindow() {},
    hideWindow() {},
    destroyWindow2() {},
    windowIsVisible: () => base.visible,
    setWindowFrame(handle, x, y, width, height) {
      if (typeof x === 'number') handle.options.x = x;
      if (typeof y === 'number') handle.options.y = y;
      if (typeof width === 'number') handle.options.width = width;
      if (typeof height === 'number') handle.options.height = height;
      backendCb?.({
        type: 'window-resize',
        windowNumber: handle.id,
        width: handle.options.width,
        height: handle.options.height,
        x: handle.options.x ?? 0,
        y: handle.options.y ?? 0,
        live: false,
      });
    },

    // --- surfaces --------------------------------------------------------------
    createSurfaceIOSurface(width, height, scale) {
      const id = ++seq;
      return { handle: { id, width, height, scale }, iosurfaceId: id };
    },
    createSurface(width, height, scale) {
      return { id: ++seq, width, height, scale };
    },
    releaseSurface(handle) {
      released.add(handle.id);
    },
    surfaceSize: (handle) => ({
      width: handle.width,
      height: handle.height,
      scale: handle.scale,
    }),
    setLayerContentsIOSurface(layer, id) {
      if (released.has(id)) {
        throw new Error('IOSurfaceLookup: no surface with that id');
      }
      layer.ioSurface = id;
    },

    // --- video surfaces (@windowkit/appkit's createVideoSurface and the
    // rest): a handle that remembers what it was made as, and whether the
    // render server is reading it, which a test sets ----------------------------
    createVideoSurface(width, height, options = {}) {
      const id = ++seq;
      return {
        handle: { video: id, width, height, ...options, inUse: false },
        iosurfaceId: id,
      };
    },
    writeVideoSurface() {},
    videoSurfaceIsInUse: (handle) => Boolean(handle.inUse),
    releaseVideoSurface(handle) {
      released.add(handle.video);
    },
    videoFormats: () => ({
      surfaces: ['NV12', 'BGRA'],
      frames: ['NV12', 'I420', 'BGRA'],
    }),

    // --- the player (@windowkit/appkit's createPlayer and the rest): an id,
    // its AVPlayerLayer as a layer, and a frame to copy whenever the test
    // says one is new (`playerFrame`); its events are the test's to emit -------
    createPlayer(url, options) {
      const id = ++seq;
      const layer = { layer: ++seq, props: {}, sublayers: [], parent: null };
      players.set(id, { url, options, layer, fresh: false, size: null });
      return { id, layer };
    },
    playerSet() {},
    playerSeek() {},
    playerCopyFrame(id, surface) {
      const p = players.get(id);
      if (!p?.fresh || !p.size) return null;
      p.fresh = false;
      const written =
        p.size.width === surface.width && p.size.height === surface.height;
      return { ...p.size, time: 0, written };
    },
    releasePlayer(id) {
      players.delete(id);
    },
    /** A new frame of `width` x `height` is showing in player `id`. */
    playerFrame(id, width, height) {
      const p = players.get(id);
      if (p) Object.assign(p, { fresh: true, size: { width, height } });
    },
    players,
    scrollSurface: () => true,

    // --- native bezels (the shape of cocoa-bezel-cache.test.js's fake) ---------
    measureControl: () => ({ width: 20, height: 20 }),
    drawControlIntoSurface() {},
    // every pixel inked, so the bezel scan finds the whole frame
    ctxGetImageData: (surface, x, y, w, hh) =>
      new Uint8Array(w * hh * 4).fill(255),

    // --- layers ----------------------------------------------------------------
    createLayer: () => ({
      layer: ++seq,
      props: {},
      sublayers: [],
      parent: null,
    }),
    addSublayer(parent, child) {
      if (child.parent) {
        child.parent.sublayers = child.parent.sublayers.filter(
          (l) => l !== child,
        );
      }
      child.parent = parent;
      parent.sublayers.push(child);
    },
    removeFromSuperlayer(layer) {
      if (!layer.parent) return;
      layer.parent.sublayers = layer.parent.sublayers.filter(
        (l) => l !== layer,
      );
      layer.parent = null;
    },
    setLayerProps(layer, props) {
      Object.assign(layer.props, props);
    },
    // a shape layer — a sprite's shadows are masked by one — keeps what it
    // was given as `shape`
    createShapeLayer: () => ({
      layer: ++seq,
      props: {},
      shape: {},
      sublayers: [],
      parent: null,
    }),
    setShapeProps(layer, props) {
      Object.assign(layer.shape, props);
    },
    surfaceToLayer(surface, layer) {
      layer.contents = surface.id;
    },
    presentationValue: () => presentation,
    // the bridge draws a layer's colour and a rastered one in the same
    // space (windowkit/appkit's colorSpace verb), which is what lets the
    // surface presenter promote by default
    colorSpace: () => 'sRGB',
    // a transform may be a whole matrix (windowkit/appkit#97), which is what
    // the surface presenter's sprites ask for before lifting any
    transformForms: () => [
      'translate',
      'rotate',
      'scale',
      'matrix',
      'matrix3d',
    ],
    txBegin() {},
    txCommit() {},

    // --- fonts (the shape of cocoa-glyph-runs.test.js's fake) ------------------
    matchFont({ families, size, weight, italic }) {
      const family = families[0];
      return fontFor(`${family}|${weight}|${italic}|${size}`, {
        ps: `${family}-${weight}${italic ? 'Italic' : ''}`,
        family,
        size,
      });
    },
    fontMetrics(f) {
      return {
        ascent: f.size * 0.8,
        descent: f.size * 0.2,
        leading: f.size * 0.1,
        capHeight: f.size * 0.7,
        xHeight: f.size * 0.5,
        size: f.size,
        familyName: f.family,
        postScriptName: f.ps,
      };
    },
    fontHasGlyph: (f, text) => text.codePointAt(0) < 0x80,
    fontGlyphForCodepoint: (f, cp) => (cp < 0x80 ? cp + 1 : null),
    fontGlyphAdvances: (f, glyphs) =>
      Float64Array.from(glyphs, () => f.size * 0.6),
    fontFallbackFor: (f) => f,
    fontWithSize: (f, size) =>
      fontFor(`${f.ps}@${size}`, { ps: f.ps, family: f.family, size }),
    // the face with OpenType features set: a font of its own, carrying them
    fontApplyFeatures: (f, features) =>
      fontFor(`${f.key}+${JSON.stringify(features)}`, { ...f, features }),
    // SF Symbols: a symbol is 1.25 × its point size across and 1 × down, and
    // one name, `no.such.symbol`, is not in the catalogue
    symbolSize: (name, { pointSize = 13 } = {}) =>
      name === 'no.such.symbol'
        ? null
        : { width: pointSize * 1.25, height: pointSize },
    ctxDrawSymbol: (surface, name) => name !== 'no.such.symbol',
    // a line per hard break and no wrapping, 8px a code point, the ascent
    // and descent of the metrics above: enough for a `<text>` to measure,
    // lay out and be painted — with each line's one left-to-right run, to
    // paint a selection over — and for a `<textarea>` to find a caret's line
    // and the index at a point, the way CoreText answers both
    createLayout({ spans }) {
      const text = spans.map((span) => span.text).join('');
      const size = spans[0]?.size ?? 14;
      const height = Math.round(size * 1.1);
      const parts = text.split('\n');
      let start = 0;
      const lines = parts.map((part, i) => {
        const width = [...part].length * 8;
        // a line's range takes its break, as a CTLine's does
        const end = start + part.length + (i < parts.length - 1 ? 1 : 0);
        const line = {
          start,
          end,
          x: 0,
          y: i * height,
          width,
          height,
          baseline: size * 0.8,
          ascent: size * 0.8,
          descent: size * 0.2,
          runs: [{ x: 0, width, start, end, rtl: false }],
        };
        start = end;
        return line;
      });
      const handle = { layout: ++seq };
      layouts.set(handle, { text, lines, height });
      return {
        handle,
        width: Math.max(...lines.map((line) => line.width)),
        height: height * lines.length,
        lines,
      };
    },
    /** the UTF-16 index nearest (x, y): the line under y, the column at x */
    layoutIndexAt(handle, x, y) {
      const laid = layouts.get(handle);
      if (!laid) return 0;
      const { text, lines, height } = laid;
      const li = Math.max(
        0,
        Math.min(lines.length - 1, Math.floor(y / height)),
      );
      const line = lines[li];
      const last = li === lines.length - 1 ? line.end : line.end - 1;
      const points = [...text.slice(line.start, last)];
      const column = Math.max(0, Math.min(points.length, Math.round(x / 8)));
      return line.start + points.slice(0, column).join('').length;
    },
    /** the caret at a UTF-16 index: on the line whose range holds it */
    layoutCaret(handle, cu) {
      const laid = layouts.get(handle);
      if (!laid) return { x: 0, y: 0, height: 14, line: 0 };
      const { text, lines } = laid;
      let li = lines.findIndex((line) => cu >= line.start && cu < line.end);
      if (li < 0) li = lines.length - 1;
      const line = lines[li];
      const x = [...text.slice(line.start, cu)].length * 8;
      return { x, y: line.y, height: line.height, line: li };
    },
    fontShapeText(f, text) {
      const cps = [...text].map((ch) => ch.codePointAt(0));
      return {
        width: cps.length * 8,
        runs: cps.length
          ? [
              {
                font: null,
                glyphs: Uint16Array.from(cps, (cp) => cp + 1),
                positions: Float64Array.from(cps.flatMap((_, i) => [i * 8, 0])),
                advances: Float64Array.from(cps, () => 8),
              },
            ]
          : [],
      };
    },
  };
  // every call is recorded, answered by the base where it has an answer
  return new Proxy(base, {
    get(target, name) {
      if (typeof name !== 'string') return target[name];
      if (name in target && typeof target[name] !== 'function') {
        return target[name];
      }
      return (...args) => {
        calls.push({ name, args });
        return name in target ? target[name](...args) : undefined;
      };
    },
  });
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));

const mounted = [];

/** Take down everything `mountCocoa` made — for an `afterEach`. */
export async function cleanupCocoa() {
  for (const root of mounted.splice(0)) await root.unmount();
}

/**
 * A `<window>` with `children` under a CocoaApp over the fake, at scale 2
 * and with no pump: a frame runs when the test says so (`frame()`), and
 * the cadence gate is off. `render(next)` re-renders the window's children.
 */
/**
 * A CocoaApp over the fake, seeded the way `createCocoaApp` seeds the
 * platform stores — scale 2, one screen, a compositor — with no pump: a
 * frame runs when the test says so (`app._tickFrames()`), and the cadence
 * gate is off. `cocoa` is the `createRoot({ cocoa })` bag.
 */
export function fakeCocoaApp(cocoa = {}, { native = fakeCocoaBridge() } = {}) {
  const app = new CocoaApp(native, { cocoa });
  setScaleForTests(app, 2, 'cocoa');
  // The layout the way `createCocoaApp` seeds it: the bridge's own
  // `listScreens()` through `screenLayout`, so a test sees the monitors its
  // fake reports and a re-read of them publishes the same thing again.
  setScreensForTests(app, screenLayout(app._screens, app.scale));
  setCompositingForTests(app, true);
  app._frameInterval = 0;
  native.setBackendEventCallback((ev) => app._route(ev));
  return { native, app };
}

/**
 * The pointer over `node`, through the bridge's own event shape (points,
 * window-relative) — the route a real NSEvent takes. `press` adds a
 * button down and up there.
 */
export function pointerOver(app, node, { press = false, dx = 0, dy = 0 } = {}) {
  const wnd = node.root.window;
  const s = wnd.scale;
  const x = (node.abs.x + node.abs.width / 2 + dx) / s;
  const y = (node.abs.y + node.abs.height / 2 + dy) / s;
  const ev = (type, extra = {}) => ({
    type,
    windowNumber: wnd.windowNumber,
    x,
    y,
    gx: wnd.x / s + x,
    gy: wnd.y / s + y,
    time: performance.now(),
    ...extra,
  });
  app._route(ev('mousemove'));
  if (press) {
    app._route(ev('mousedown', { button: 1 }));
    app._route(ev('mouseup', { button: 1 }));
  }
}

export async function mountCocoa(
  children,
  {
    width = 200,
    height = 120,
    promote,
    presenter,
    native: bridge,
    ...attrs
  } = {},
) {
  const cocoa = {};
  if (promote !== undefined) cocoa.promote = promote;
  if (presenter !== undefined) cocoa.presenter = presenter;
  // a bridge of the test's own, for one that lacks a verb
  const { native, app } = fakeCocoaApp(cocoa, bridge ? { native: bridge } : {});
  const root = await createRoot({ app });
  mounted.push(root);
  const windowOf = (kids) => h('window', { width, height, ...attrs }, kids);
  root.render(windowOf(children));
  await tick();
  const wnd = [...app._windows.values()][0];
  const node = wnd._reactX11Node;
  const frames = { count: 0 };
  const flush = node.flush.bind(node);
  node.flush = (...a) => {
    const painting =
      node.needsPaint || node.needsLayout || node._animating.size > 0;
    const out = flush(...a);
    if (painting) frames.count += 1;
    return out;
  };
  const frame = () => {
    app._tickFrames();
    app._presentAll();
  };
  frame();
  return {
    native,
    app,
    root,
    wnd,
    node,
    frames,
    frame,
    promotion: wnd._promotion ?? null,
    render: async (next) => {
      root.render(windowOf(next));
      await tick();
    },
  };
}
