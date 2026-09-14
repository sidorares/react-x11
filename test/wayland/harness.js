// The router's side of a window, without a GPU.
//
// `InputRouter` reads a handful of things off a `WaylandBackendWindow`: the
// shell object (for the frame's hit-testing and for move/resize requests),
// the decorations, the insets and scale that make up the coordinate rule,
// and an emitter to deliver into. This dresses any emitter that way — a
// fresh one, or a mock app's window with a real React tree listening on it
// — so a test can read exactly the events a tree would, over the real
// protocol, with nothing painted.

import { EventEmitter } from 'node:events';
import { Decorations } from '../../src/wayland/decorations.js';

/**
 * Make `target` look like a backend window over the shell window `wl`.
 *
 * @template T
 * @param {T} target an emitter: `on`/`emit` is all the router calls
 * @param {import('../../src/wayland/window.js').WaylandWindow} wl
 * @returns {T}
 */
export function asBackendWindow(target, wl, { decorations = true } = {}) {
  Object.assign(target, {
    wl,
    decor: decorations ? new Decorations() : null,
    treeCursor: 'default',
    _destroyed: false,
    repaintFrame() {},
    requestClose() {},
  });
  Object.defineProperty(target, 'insets', {
    configurable: true,
    get: () =>
      target.decor?.insets() ?? { top: 0, left: 0, right: 0, bottom: 0 },
  });
  Object.defineProperty(target, 'scale', {
    configurable: true,
    get: () => wl.scale,
  });
  return target;
}

/** A bare routed window: an emitter over `wl`. */
export function routedWindow(wl, opts) {
  return asBackendWindow(new EventEmitter(), wl, opts);
}

/** What `InputRouter` reads off the app: the seat, the window map, `X`. */
export function routerApp(seat, windows = []) {
  const X = new EventEmitter();
  X.keycode2keysyms = [];
  return {
    seat,
    X,
    windows: new Map(windows.map((w) => [w.wl.surface.id, w])),
    afterInput() {},
  };
}

/**
 * Record named events off a window, in arrival order, as `{ n, ev }`.
 * `got.count(name)` is how many of one kind so far.
 */
export function record(win, names) {
  const got = [];
  for (const n of names) win.on(n, (ev) => got.push({ n, ev }));
  got.count = (n) => got.filter((g) => g.n === n).length;
  got.of = (n) => got.filter((g) => g.n === n).map((g) => g.ev);
  return got;
}

export const POINTER_EVENTS = [
  'mouseover',
  'mousedown',
  'mousemove',
  'mouseup',
  'mouseout',
  'wheel',
];

export const TOUCH_EVENTS = [
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',
];
