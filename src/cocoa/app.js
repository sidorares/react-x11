// The Cocoa application object — what `createRoot({ backend: 'cocoa' })`
// hands the renderer instead of an ntk connection. It answers the same
// contract the headless mock proves closed (src/testing/mock-app.js):
// createWindow / fonts / clipboard / X-stub / close, plus the event pump
// that stands in for the X socket.
//
// The run loop is deliberately the simple version (docs/macos.md §"Input
// and the run loop", option 1): Node's loop is master and a timer pumps
// AppKit. Input latency is the pump cadence; AppKit's internal modal loops
// (live resize, menu tracking) stall JS timers — but not the delegate
// callbacks, which is why live resize still relayouts: the resize event
// flushes the frame synchronously on its way through (`flushPendingFrames`,
// the same early-flush a click gets). The CFRunLoop drain (option 2) is the
// measured upgrade, not the first version.
import { cssColorStraight } from 'ntk';

import { flushPendingFrames } from '../frames.js';
import { setCompositingForTests } from '../compositing.js';
import { setScreensForTests } from '../screens.js';
import { setScaleForTests } from '../scale.js';
import { CocoaFontManager } from './fonts.js';
import { CocoaWindow } from './window.js';
import { decodeKey, modifierMask } from './keymap.js';
import { loadNative } from './native.js';

const RAF_INTERVAL_MS = 16;

class CocoaApp {
  constructor(native, options = {}) {
    this._native = native;
    this.options = options;
    this._windows = new Map(); // windowNumber -> CocoaWindow
    this._grabWindow = null;
    this._rafQueue = [];
    this._rafLast = 0;
    this._pump = null;
    this._closed = false;

    const screens = native.listScreens();
    this.scale = screens[0]?.scale ?? 1;
    this._screens = screens;

    this.fonts = new CocoaFontManager();

    // The X stub: just enough for the modules that carry an X escape hatch
    // to no-op the way they do against the headless mock.
    const listeners = {};
    this.X = {
      display: { screen: [{ root: 1 }] },
      keycode2keysyms: {},
      InternAtom: (onlyIfExists, name, cb) => {
        if (!this._atoms.has(name)) {
          this._atoms.set(name, 1000 + this._atoms.size);
        }
        cb(null, this._atoms.get(name));
      },
      ConfigureWindow() {},
      SendClientMessage() {},
      on(event, fn) {
        (listeners[event] ??= []).push(fn);
      },
      emit(event, ...args) {
        for (const fn of listeners[event] ?? []) fn(...args);
      },
    };
    this._atoms = new Map();

    this.clipboard = {
      write: (data) => {
        const text =
          typeof data === 'string'
            ? data
            : (data?.UTF8_STRING ?? data?.STRING ?? '');
        native.pasteboardWriteText(String(text));
        return Promise.resolve();
      },
      clear: () => {
        native.pasteboardClear();
        return Promise.resolve();
      },
      targets: () => {
        const text = native.pasteboardReadText();
        return Promise.resolve(text == null ? [] : ['UTF8_STRING', 'STRING']);
      },
      read: ({ target } = {}) => {
        const text = native.pasteboardReadText();
        if (text == null) {
          return Promise.reject(
            new Error('clipboard: nothing to paste — the pasteboard is empty'),
          );
        }
        if (target === undefined) return Promise.resolve(text);
        if (target === 'UTF8_STRING' || target === 'STRING') {
          return Promise.resolve(Buffer.from(text, 'utf8'));
        }
        return Promise.reject(
          new Error(`clipboard: cannot convert the pasteboard to ${target}`),
        );
      },
      watch: () => Promise.resolve(() => {}),
    };
  }

  _parseColor(value) {
    return typeof value === 'string' ? cssColorStraight(value) : null;
  }

  findArgbVisual() {
    // every Cocoa window composites; the "visual" is a formality
    return { visual: 1, depth: 32 };
  }

  createWindow(attributes = {}) {
    if (attributes.parent) {
      throw new Error(
        'react-x11: nested <window> elements are not supported on the ' +
          'cocoa backend yet — track docs/macos.md.',
      );
    }
    return new CocoaWindow(this, attributes);
  }

  _registerWindow(wnd) {
    this._windows.set(wnd.windowNumber, wnd);
  }

  _unregisterWindow(wnd) {
    this._windows.delete(wnd.windowNumber);
    if (this._grabWindow === wnd) this._grabWindow = null;
  }

  // --- the pump ------------------------------------------------------------

  start({ pumpInterval = 8 } = {}) {
    if (this._pump) return;
    const native = this._native;
    native.initApp();
    native.setBackendEventCallback((ev) => this._route(ev));
    this._pump = setInterval(() => {
      native.pump2();
      this._tickFrames();
      this._presentAll();
    }, pumpInterval);
  }

  _requestFrame(cb) {
    this._rafQueue.push(cb);
    return this._rafQueue.length;
  }

  _tickFrames() {
    if (!this._rafQueue.length) return;
    const now = Date.now();
    if (now - this._rafLast < RAF_INTERVAL_MS) return;
    this._rafLast = now;
    const queue = this._rafQueue;
    this._rafQueue = [];
    for (const cb of queue) {
      try {
        cb(now);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  _presentAll() {
    for (const wnd of this._windows.values()) wnd.present();
  }

  /** After any synchronously dispatched input: paint the response now (the
   * same early flush a discrete event gets on X11) and put it on glass. */
  _afterInput() {
    flushPendingFrames();
    this._presentAll();
  }

  // --- event routing -------------------------------------------------------

  _route(ev) {
    if (this._closed) return;
    switch (ev.type) {
      case 'mousedown':
      case 'mouseup':
        return this._routeButton(ev);
      case 'mousemove':
        return this._routeMotion(ev, 'mousemove');
      case 'mouseleave':
        return this._routeMotion(ev, 'mouseout');
      case 'mouseenter':
        return this._routeMotion(ev, 'mousemove');
      case 'wheel':
        return this._routeWheel(ev);
      case 'keydown':
      case 'keyup':
        return this._routeKey(ev);
      case 'window-resize':
      case 'window-move':
        return this._routeGeometry(ev);
      case 'window-close-request':
        return this._routeClose(ev);
      case 'window-focus':
        return this._routeFocus(ev, 'focus');
      case 'window-blur':
        return this._routeFocus(ev, 'blur');
      default:
        return undefined;
    }
  }

  _window(ev) {
    return ev.windowNumber != null
      ? (this._windows.get(ev.windowNumber) ?? null)
      : null;
  }

  /**
   * The grab rule, X-shaped: while a popup holds the "pointer grab", a press
   * in any other window of ours is delivered to the grab holder in the grab
   * holder's coordinates — landing outside its bounds, which is what its
   * event manager reads as a dismissal (events.js `_pressOutside`).
   */
  _grabTarget(ev, wnd) {
    const grab = this._grabWindow;
    if (!grab || grab.destroyed || grab === wnd) return null;
    const s = this.scale;
    return {
      wnd: grab,
      x: Math.round(ev.gx * s) - grab._screenOrigin.x,
      y: Math.round(ev.gy * s) - grab._screenOrigin.y,
    };
  }

  _routeButton(ev) {
    const wnd = this._window(ev);
    if (!wnd) return;
    const s = this.scale;
    const buttons = modifierMask(ev);
    const redirect = ev.type === 'mousedown' ? this._grabTarget(ev, wnd) : null;
    const target = redirect?.wnd ?? wnd;
    target.emit(ev.type, {
      x: redirect ? redirect.x : Math.round(ev.x * s),
      y: redirect ? redirect.y : Math.round(ev.y * s),
      rootx: Math.round(ev.gx * s),
      rooty: Math.round(ev.gy * s),
      keycode: ev.button,
      buttons,
      time: ev.time,
    });
    this._afterInput();
  }

  _routeMotion(ev, name) {
    const wnd = this._window(ev);
    if (!wnd) return;
    const s = this.scale;
    wnd.emit(name, {
      x: Math.round(ev.x * s),
      y: Math.round(ev.y * s),
      rootx: Math.round(ev.gx * s),
      rooty: Math.round(ev.gy * s),
      buttons: modifierMask(ev),
      time: ev.time,
    });
    // motion is paced on the frame clock, not flushed per event
  }

  _routeWheel(ev) {
    const wnd = this._window(ev);
    if (!wnd) return;
    const s = this.scale;
    // AppKit: positive deltas scroll toward the top (natural direction
    // already folded in); the renderer's notches are the X convention,
    // positive = content advancing downward. Precise deltas are points —
    // 48 device pixels is one notch, so a swipe maps 1:1 onto pixels.
    const toNotches = (delta) =>
      ev.precise
        ? (-delta * s) / 48
        : -Math.sign(delta) * Math.ceil(Math.abs(delta));
    const deltaX = toNotches(ev.dx);
    const deltaY = toNotches(ev.dy);
    if (!deltaX && !deltaY) return;
    wnd.emit('wheel', {
      name: 'wheel',
      x: Math.round(ev.x * s),
      y: Math.round(ev.y * s),
      rootx: Math.round(ev.gx * s),
      rooty: Math.round(ev.gy * s),
      buttons: modifierMask(ev),
      deltaX,
      deltaY,
      deltaMode: 'line',
      smooth: Boolean(ev.precise),
      source: ev.precise ? 'valuator' : 'button',
    });
  }

  _routeKey(ev) {
    // keys go to the key window; without one (all popups) the last focused
    // toplevel keeps the keyboard, which matches the focus model upstairs
    const wnd = this._window(ev) ?? this._lastKeyWindow;
    if (!wnd) return;
    const decoded = decodeKey(ev);
    wnd.emit(ev.type, {
      keycode: ev.keyCode,
      keysym: decoded.keysym,
      baseKeysym: decoded.baseKeysym,
      codepoint: decoded.codepoint,
      buttons: modifierMask(ev),
      group: 0,
      time: ev.time,
    });
    this._afterInput();
  }

  _routeGeometry(ev) {
    const wnd = this._window(ev);
    if (!wnd || wnd.destroyed) return;
    wnd._nativeResized(ev);
    wnd.emit('resize', {
      width: wnd.width,
      height: wnd.height,
      x: wnd.x,
      y: wnd.y,
      moved: true,
      resized: ev.type === 'window-resize',
    });
    // During a live resize AppKit's modal loop owns the thread and Node
    // timers stall; flushing here is what keeps layout tracking the drag.
    this._afterInput();
  }

  _routeClose(ev) {
    const wnd = this._window(ev);
    if (!wnd) return;
    wnd.emit('close', {
      preventDefault() {},
    });
    this._afterInput();
  }

  _routeFocus(ev, name) {
    const wnd = this._window(ev);
    if (!wnd) return;
    if (name === 'focus') this._lastKeyWindow = wnd;
    wnd.emit(name, { buttons: 0, time: ev.time });
    this._afterInput();
  }

  // --- teardown ------------------------------------------------------------

  close() {
    if (this._closed) return Promise.resolve();
    this._closed = true;
    if (this._pump) clearInterval(this._pump);
    this._pump = null;
    this._native.setBackendEventCallback(null);
    for (const wnd of [...this._windows.values()]) wnd.destroy();
    return Promise.resolve();
  }
}

/**
 * Build the app and seed the platform stores the way the mock seeds them —
 * `beginScale`/`beginScreens`/`beginCompositing` find a session already
 * open and leave it alone, so `createRoot`'s shared flow runs unchanged.
 */
export async function createCocoaApp(options = {}) {
  const native = loadNative();
  const app = new CocoaApp(native, options);

  setScaleForTests(app, app.scale, 'cocoa');
  const s = app.scale;
  const monitors = app._screens.map((screen) => ({
    x: Math.round(screen.x * s),
    y: Math.round(screen.y * s),
    width: Math.round(screen.width * s),
    height: Math.round(screen.height * s),
  }));
  const primary = app._screens[0];
  setScreensForTests(app, {
    monitors,
    workArea: primary
      ? {
          x: Math.round(primary.visible.x * s),
          y: Math.round(primary.visible.y * s),
          width: Math.round(primary.visible.width * s),
          height: Math.round(primary.visible.height * s),
        }
      : null,
  });
  setCompositingForTests(app, true);

  app.start(options.cocoa ?? {});
  return app;
}
