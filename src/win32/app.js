// The Windows backend's app object: the bridge's event channel on one side,
// the ntk-application shape the renderer expects on the other.
//
// There is no pump here, and that is the point. The Cocoa backend pumps AppKit
// from a libuv timer because AppKit insists on the process's main thread, and
// pays for it — an input waits for the next tick, and a modal loop freezes Node
// outright (#484). Win32 binds a window to the thread that created it, so the
// bridge runs every HWND and every modal loop on a thread of its own and
// reaches this side through a threadsafe function, which wakes Node's loop at
// once. What is left here is routing.
import { setCompositingForTests } from '../compositing.js';
import { setScaleForTests } from '../scale.js';
import { setScreensForTests } from '../screens.js';

import { Win32FontManager } from './fonts.js';
import { loadNative } from './native.js';
import { Win32Window } from './window.js';

// Until the compositor clock is bound (docs/windows.md §"The frame clock":
// DCompositionWaitForCompositorClock on Windows 11, IDXGIOutput::WaitForVBlank
// before it), frames are paced by a timer at a sixty-hertz period. It is the
// one piece of this backend that is a placeholder rather than a decision, and
// it is marked so that the real clock replaces it rather than joining it.
const FRAME_INTERVAL_MS = 1000 / 60;

class Win32App {
  constructor(native, options = {}) {
    this._native = native;
    this.options = options;
    this._windows = new Map();
    this._rafQueue = [];
    this._frameTimer = null;
    this._closed = false;
    this._atoms = new Map();

    this.fonts = new Win32FontManager(native);

    const screens = native.listScreens?.() ?? [];
    const primary = screens[0] ?? {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      scale: 1,
    };
    this.scale = primary.scale ?? 1;
    this._screens = screens.length ? screens : [primary];

    const listeners = {};
    // The X connection's shape, for the code above that reaches into it —
    // atoms, a root window, the connection's own events. Nothing here talks a
    // protocol; it exists so the layers that were written against X do not
    // each need a backend branch.
    this.X = {
      display: { screen: [{ root: 1 }] },
      keycode2keysyms: {},
      InternAtom: (onlyIfExists, name, cb) => {
        if (!this._atoms.has(name))
          this._atoms.set(name, 1000 + this._atoms.size);
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

    // The clipboard is OLE's and is not bound yet (docs/windows.md §"The
    // desktop around the app"). It answers the ntk shape and refuses honestly:
    // a read finds no owner, which is the same thing an empty clipboard says,
    // and a write reports that it did not happen rather than resolving.
    this.clipboard = {
      write() {
        return Promise.reject(
          new Error(
            'react-x11: the win32 backend has no clipboard yet — it is OLE ' +
              'delayed rendering, and is not built.',
          ),
        );
      },
      clear() {
        return Promise.resolve();
      },
      targets() {
        return Promise.resolve([]);
      },
      read() {
        return Promise.reject(new Error('clipboard: nothing to paste'));
      },
      watch() {
        return Promise.resolve(() => {});
      },
    };
  }

  // --- the renderer's app surface -------------------------------------------

  /** Every window is composited by DWM and every surface has an alpha
   * channel, so `<window transparent>` needs nothing found first. */
  findArgbVisual() {
    return { visual: 0x21, depth: 32 };
  }

  createWindow(attributes = {}) {
    return new Win32Window(this, attributes);
  }

  createSurface(options = {}) {
    const width = Math.max(1, Math.round(options.width ?? 1));
    const height = Math.max(1, Math.round(options.height ?? 1));
    return this._native.createSurface(width, height, this.scale);
  }

  close() {
    if (this._closed) return Promise.resolve();
    this._closed = true;
    if (this._frameTimer) clearTimeout(this._frameTimer);
    this._frameTimer = null;
    this._native.stop();
    return Promise.resolve();
  }

  frameIntervalFor() {
    return FRAME_INTERVAL_MS;
  }

  // --- windows --------------------------------------------------------------

  _register(wnd) {
    this._windows.set(wnd.id, wnd);
  }

  _unregister(wnd) {
    this._windows.delete(wnd.id);
  }

  // --- the frame clock ------------------------------------------------------

  _requestFrame(cb, wnd = null) {
    this._rafQueue.push({ cb, wnd });
    if (!this._frameTimer && !this._closed) {
      this._frameTimer = setTimeout(() => {
        this._frameTimer = null;
        this._tickFrames();
      }, FRAME_INTERVAL_MS);
      this._frameTimer.unref?.();
    }
    return this._rafQueue.length;
  }

  _tickFrames() {
    const due = this._rafQueue;
    this._rafQueue = [];
    const now = performance.now();
    for (const { cb } of due) {
      try {
        cb(now);
      } catch (err) {
        // A throw from one window's frame must not take the others' with it;
        // the renderer's own error plumbing has already had its say by here.
        if (process.env.NODE_ENV !== 'production') console.error(err);
      }
    }
  }

  // --- the event channel ----------------------------------------------------

  /**
   * One bridge event. Everything arrives on Node's own loop through the
   * threadsafe function, inside a callback scope that drains microtasks when
   * it closes — so a handler's setState commits on the event that caused it.
   */
  _route(event) {
    const wnd = this._windows.get(event.id);
    if (!wnd) return;
    switch (event.type) {
      case 'window-ready':
        wnd._onReady();
        break;
      case 'resize': {
        const width = Math.max(1, Math.round(event.a));
        const height = Math.max(1, Math.round(event.b));
        if (width === wnd.width && height === wnd.height) break;
        wnd.width = width;
        wnd.height = height;
        if (wnd._composed) this._native.resize(wnd.id, width, height);
        wnd.emit('resize', { width, height });
        break;
      }
      case 'mousemove':
        wnd.emit('mousemove', { x: event.a, y: event.b });
        break;
      case 'mousedown':
        wnd.emit('mousedown', { x: event.a, y: event.b, keycode: 1 });
        break;
      case 'mouseup':
        wnd.emit('mouseup', { x: event.a, y: event.b, keycode: 1 });
        break;
      case 'keydown':
        wnd.emit('keydown', { keycode: event.a, keysym: event.a, buttons: 0 });
        break;
      case 'close':
        wnd.emit('close', {});
        break;
      case 'dpichanged':
        // The renderer cannot re-scale a live window yet (docs/windows.md
        // §Layout, open question 8), so this is recorded and not acted on.
        wnd.emit('statechange', { scale: event.a / 96 });
        break;
      default:
        break;
    }
  }
}

export async function createWin32App(options = {}) {
  const native = loadNative();
  const app = new Win32App(native, options);

  native.start((event) => app._route(event));

  setScaleForTests(app, app.scale, 'win32');
  setScreensForTests(app, {
    monitors: app._screens.map((s) => ({
      x: s.x ?? 0,
      y: s.y ?? 0,
      width: s.width,
      height: s.height,
    })),
  });
  // DWM is always compositing: there is no "no compositor" state to probe for
  // the way there is on X11.
  setCompositingForTests(app, true);

  return app;
}
