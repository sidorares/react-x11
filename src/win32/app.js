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
import { systemAppearance } from '../appearance.js';
import { setCompositingForTests } from '../compositing.js';
import { setScaleForTests } from '../scale.js';
import { setScreensForTests } from '../screens.js';

import { createBezels } from './bezels.js';
import { Win32InputMethod } from './ime.js';
import { decodeKey, modifierMask } from './keymap.js';
import { Win32PaneHost } from './panehost.js';
import { Win32PaneWindow } from './panewindow.js';
import { Win32Surface } from './surface.js';
import { installGl, Win32GlWindow } from './glarea.js';
import { Win32FontManager } from './fonts.js';
import { loadNative } from './native.js';
import {
  installIdle,
  installNotifications,
  installTaskbar,
  installTaskbarSurfaces,
  Win32FilePanels,
  Win32StatusItem,
} from './shell.js';
import { Win32Window } from './window.js';

// The fallback frame period, for a Windows with no compositor clock to wait
// on (before 10/1803) — and only that, because as a *clock* a JS timer is a
// bad one here. Node rounds a timer up to the next system tick, the default
// tick is 15.6ms, and a 16.67ms request therefore lands on the second one:
// measured, 155 of 200 intervals at 31ms and 24 at 16ms, which is 34.8
// frames a second alternating between one tick and two. Everything paced
// judders at that however cheap its frames are.
//
// So the clock is `frameClockRequest` (windows/src/frameclock.cc), which
// blocks a thread of its own on DCompositionWaitForCompositorClock and tells
// JS when the compositor is ready for a frame. This number is what is left
// when that is unavailable.
const FRAME_INTERVAL_MS = 1000 / 60;

// How long a promised compositor tick may take before the timer takes over
// for the rest of the session. A tick that is asked for and never arrives
// would stop every frame in the application for good — an app frozen with a
// clean event loop, which is the worst kind to be told about — so the clock
// is watched. One timer per frame costs nothing: what was wrong with a timer
// here was never its cost, only its granularity.
const CLOCK_WATCHDOG_MS = 250;

/**
 * A pointer event's position on the screen, which X carries as `rootx`/
 * `rooty` and Windows does not: WM_MOUSEMOVE and the button messages are all
 * client-relative. The window knows where its client area is, so the sum is
 * exact and costs nothing.
 *
 * Anything that places something *outside* the window reads these — a
 * `ContextMenu` opens at the pointer, and a drag's feedback follows it
 * (src/components/Menu.js, src/dnd.js). Without them both fall back to the
 * window-relative coordinate and treat it as a screen one, which puts a
 * right-click menu a whole window-offset away from the pointer.
 */
function rootOf(wnd, event) {
  const origin = wnd._screenOrigin ?? { x: wnd.x ?? 0, y: wnd.y ?? 0 };
  return { rootx: event.a + origin.x, rooty: event.b + origin.y };
}

export class Win32App {
  constructor(native, options = {}) {
    this._native = native;
    this.options = options;
    this._windows = new Map();
    // The drag this process started, while the shell is carrying it — what
    // an in-app drop reads to keep `e.items` by reference (src/dnd.js).
    this._activeDrag = null;
    this._rafQueue = [];
    this._frameTimer = null;
    /** A frame has been asked for and not yet delivered — one outstanding
     *  request at a time, whether the clock or the timer is answering it. */
    this._framePending = false;
    /** The compositor promised a tick and did not deliver one. Latched: the
     *  timer answers every frame from then on. */
    this._clockLost = false;
    this._closed = false;
    this._atoms = new Map();
    this._appearanceListeners = new Set();
    /** Tray icons by the bridge's handle, so an event can find its item. */
    this._statusItems = new Map();
    /** The input method. Composition is a property of the platform rather
     *  than of a window, so there is one of these and it follows whichever
     *  field is focused (src/win32/ime.js). */
    this.inputMethod = new Win32InputMethod(this);
    /** Popups that asked for a pointer grab. Windows has none to give, so
     *  what the grab was for is watched for instead — see `grabPointer` in
     *  src/win32/window.js and `_dismissOutsidePopups` below. */
    this._dismissOnOutside = new Set();
    /** GL surfaces by the bridge's id, so a 'gl-ready' event finds its own. */
    this._glWindows = new Map();
    /** This process *is* a `<Frame>`'s pane: it has no windows of its own,
     *  only a buffer the host composites (REACT_X11_FRAME is what the Frame
     *  host sets on the fork). */
    this._paneMode = options.pane ?? process.env.REACT_X11_FRAME === '1';
    this._paneSend = null;
    /** The native open/save panels. Its *presence* is what puts the top rung
     * on src/filedialog.js's ladder for this app. */
    this.filePanels =
      typeof native.fileDialog === 'function'
        ? new Win32FilePanels(this)
        : null;
    /** The system's own control bezels, when they would look right — see
     * `_syncBezels`. Read by `useNativeControls()` as a capability. */
    this.nativeBezels = null;

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

    // ntk's clipboard shape over the Windows clipboard. Opened with no owner
    // window, which keeps it off the UI thread; what that gives up is delayed
    // rendering, so a write here is eager rather than lazy. X's other everyday
    // selection, PRIMARY, has no Windows equivalent at all — every name but
    // CLIPBOARD is a selection nobody on this desktop can paste from, and is
    // answered as empty rather than pretended at.
    const isClipboard = (selection) => !selection || selection === 'CLIPBOARD';
    this.clipboard = {
      write: (data, { selection = 'CLIPBOARD' } = {}) => {
        if (!isClipboard(selection)) return Promise.resolve();
        const text =
          typeof data === 'string'
            ? data
            : (data?.['text/plain'] ?? data?.UTF8_STRING ?? data?.STRING);
        if (typeof text !== 'string') {
          return Promise.reject(
            new Error(
              'react-x11: the win32 clipboard writes text only for now — ' +
                'images and file lists need the OLE data object, which is not ' +
                'built. Pass a string, or a map with a text/plain entry.',
            ),
          );
        }
        return native.clipboardWriteText(text)
          ? Promise.resolve()
          : Promise.reject(
              new Error(
                'react-x11: the clipboard refused the write — another program ' +
                  'held it open. Retrying usually succeeds.',
              ),
            );
      },
      clear: (selection = 'CLIPBOARD') => {
        if (isClipboard(selection)) native.clipboardWriteText('');
        return Promise.resolve();
      },
      targets: ({ selection = 'CLIPBOARD' } = {}) =>
        Promise.resolve(
          isClipboard(selection) ? native.clipboardFormats() : [],
        ),
      read: ({ selection = 'CLIPBOARD', target } = {}) => {
        if (!isClipboard(selection)) {
          return Promise.reject(
            new Error(
              `clipboard: nothing to paste — ${selection} has no owner`,
            ),
          );
        }
        const text = native.clipboardReadText();
        if (text === null) {
          return Promise.reject(new Error('clipboard: nothing to paste'));
        }
        if (target === undefined) return Promise.resolve(text);
        if (
          target === 'text/plain' ||
          target === 'UTF8_STRING' ||
          target === 'STRING'
        ) {
          return Promise.resolve(Buffer.from(text, 'utf8'));
        }
        return Promise.reject(
          new Error(`clipboard: owner cannot convert to ${target}`),
        );
      },
      // No owner window means no AddClipboardFormatListener, so a change is
      // noticed by the sequence number rather than announced. Polled slowly
      // and unref'd: this must never be the reason a process stays alive.
      watch: (selection, handler) => {
        if (!isClipboard(selection)) return Promise.resolve(() => {});
        let last = native.clipboardSequence();
        const timer = setInterval(() => {
          const now = native.clipboardSequence();
          if (now === last) return;
          last = now;
          handler({ selection: 'CLIPBOARD', owner: 1, reason: 'new-owner' });
        }, 400);
        timer.unref?.();
        return Promise.resolve(() => clearInterval(timer));
      },
    };
  }

  // --- the desktop ----------------------------------------------------------

  /** Light or dark, the accent, contrast and reduced motion, as one answer —
   * the rung `src/appearance.js` asks for by capability. */
  systemAppearance() {
    return this._native.systemAppearance();
  }

  onAppearanceChange(fn) {
    this._appearanceListeners.add(fn);
    return () => this._appearanceListeners.delete(fn);
  }

  /** A pixel off the screen, for `useEyedropper()`. Windows asks no permission
   * and draws no capture border, so the loupe is the renderer's to draw. */
  screenColorAt(x, y) {
    return this._native.screenColorAt(Math.round(x), Math.round(y));
  }

  pointerPosition() {
    return this._native.pointerPosition();
  }

  /** A tray icon. `useTray()` finds this by name, not by platform — the rule
   * AGENTS.md sets for every ladder. */
  /**
   * Close every open `<popup grab>` that this press did not land in.
   *
   * `pressed` is the window the press was delivered to, or null when the
   * application lost activation and there is no window of ours to exclude.
   * Everything else open hears the press as an outside one and answers with
   * `onDismiss` (src/win32/window.js `_dismissFromOutside`).
   *
   * Excluding the pressed window is what makes a submenu work: clicking the
   * menu that opened it closes the submenu and keeps the menu, which is what
   * an X11 grab does by handing the press to the innermost holder.
   *
   * A copy of the set is walked because `onDismiss` is what unmounts the
   * popup, and unmounting runs `ungrabPointer` — which deletes from the set
   * this loop would otherwise still be reading.
   */
  _dismissOutsidePopups(pressed) {
    if (this._dismissOnOutside.size === 0) return;
    for (const wnd of [...this._dismissOnOutside]) {
      if (wnd === pressed) continue;
      if (wnd.destroyed) {
        this._dismissOnOutside.delete(wnd);
        continue;
      }
      wnd._dismissFromOutside();
    }
  }

  /**
   * A drag session's point, as the tree's own units.
   *
   * The bridge reports screen device pixels, like every other event it
   * sends; `DragSession.nativeEnded` multiplies by the node's scale to get
   * back to them, because the cocoa bridge it was written against reports
   * points. So this divides, and the two agree at any scale.
   */
  _dragPoint(event) {
    const s = this.scale || 1;
    return { x: (event.a ?? 0) / s, y: (event.b ?? 0) / s };
  }

  createStatusItem(options) {
    return new Win32StatusItem(this, options);
  }

  /** Installed only where the system's own bezels would actually look right —
   * see src/win32/bezels.js, which measures rather than assumes. */
  _syncBezels(colorScheme) {
    const wanted = colorScheme !== 'dark';
    if (wanted === Boolean(this.nativeBezels)) return;
    this.nativeBezels?.clear?.();
    this.nativeBezels = wanted
      ? createBezels(this._native, { colorScheme, scale: this.scale })
      : null;
  }

  // --- the renderer's app surface -------------------------------------------

  /** Every window is composited by DWM and every surface has an alpha
   * channel, so `<window transparent>` needs nothing found first. */
  findArgbVisual() {
    return { visual: 0x21, depth: 32 };
  }

  /**
   * The offscreen-surface seam `react-x11/ntk`'s `Surface` dispatches on:
   * ntk's `Surface` contract over a Direct2D bitmap (src/win32/surface.js).
   * Its presence is what makes `new Surface(app, { width, height })` answer
   * a surface here rather than ntk's pixmap, which needs an X connection —
   * a backend without the method gets ntk's, so an X app is never asked.
   */
  createSurface(options) {
    return new Win32Surface(this, options);
  }
  createWindow(attributes = {}) {
    // `embeddable` is "created, not shown; somebody else will place me", and
    // on this backend that cannot be a window: a composition target stops
    // presenting the moment its window becomes a child, so an HWND is not
    // something another process can take (docs/windows-embedding.md). What a
    // host can take is the **buffer**, so an embeddable window here is the
    // same shared surface a `<Frame>` pane draws into — whether this process
    // was forked as a pane or is a guest somebody else started.
    //
    // Before the `parent` branch: an embeddable window has no parent, and
    // this is the only place the two could be confused.
    if (attributes.embeddable) {
      return new Win32PaneWindow(this, attributes);
    }
    // A window with a parent is a `<glarea>`'s surface, which is a different
    // thing entirely: a child HWND with a GL context and no DirectComposition
    // surface at all. `glnodes.js` asks for one through this same door, as it
    // does on X11 where a GL surface is also just a child window.
    if (attributes.parent) return new Win32GlWindow(this, attributes);
    return new Win32Window(this, attributes);
  }

  /**
   * The seam `<Frame>` dispatches on (src/frame/index.js): a backend that
   * composites a pane from a shared buffer answers here, and one that
   * reparents the pane's real window does not. Its presence is the whole
   * capability — the element, the props, the fallback and the restart are
   * the same code on every backend.
   */
  createPaneHost(wnd) {
    return new Win32PaneHost(this, wnd);
  }

  /**
   * The pane process's end of the frame channel: geometry and input in,
   * presents out. Feature-detected by the pane bootstrap
   * (src/frame/childmain.js), and a no-op in a process that is not a pane.
   */
  attachPaneChannel(channel) {
    if (!this._paneMode) return;
    this._paneSend = (msg) => {
      try {
        channel.send(msg);
      } catch {
        // the host is going away; its shutdown owns the rest
      }
    };
    channel.onMessage((msg) => {
      const wnd = [...this._windows.values()][0];
      if (!wnd) return;
      if (msg?.type === 'pane-rect') {
        wnd.setPaneSize?.(msg.width, msg.height, msg.scale);
      } else if (msg?.type === 'pane-event') {
        wnd.emit(msg.name, msg.ev);
      }
    });
  }

  close() {
    if (this._closed) return Promise.resolve();
    this._closed = true;
    if (this._frameTimer) clearTimeout(this._frameTimer);
    this._frameTimer = null;
    this._framePending = false;
    this.inputMethod.destroy();
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
    if (this._framePending || this._closed) return this._rafQueue.length;
    this._framePending = true;
    // One tick, from the compositor if this Windows has a clock to wait on.
    // It answers false when it has not, and then — and only then — a timer.
    if (!this._clockLost && this._native.frameClockRequest?.()) {
      this._frameTimer = setTimeout(() => {
        this._frameTimer = null;
        if (!this._framePending || this._closed) return;
        this._clockLost = true;
        this._framePending = false;
        this._tickFrames();
      }, CLOCK_WATCHDOG_MS);
      this._frameTimer.unref?.();
      return this._rafQueue.length;
    }
    this._frameTimer = setTimeout(() => {
      this._frameTimer = null;
      this._framePending = false;
      this._tickFrames();
    }, FRAME_INTERVAL_MS);
    this._frameTimer.unref?.();
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
    // The input method hears about the focused field now, after the frame has
    // laid the tree out and the caret rectangle is one a candidate list can
    // be put next to (src/win32/ime.js). Once per window, however many
    // callbacks it had.
    const seen = new Set();
    for (const { wnd } of due) {
      if (!wnd || seen.has(wnd)) continue;
      seen.add(wnd);
      this.inputMethod.sync(wnd);
    }
  }

  // --- the event channel ----------------------------------------------------

  /**
   * One bridge event. Everything arrives on Node's own loop through the
   * threadsafe function, inside a callback scope that drains microtasks when
   * it closes — so a handler's setState commits on the event that caused it.
   */
  _route(event) {
    // The shell's events are not a window's: a tray icon, a file dialog and a
    // hotkey each carry an id of their own, and looking one up in the window
    // map would drop it.
    switch (event.type) {
      // The compositor is ready for a frame. Carries no id and belongs to no
      // window: it is the clock, and every window that asked for a frame in
      // the meantime is paced by this one tick.
      case 'frame-clock':
        if (this._frameTimer) clearTimeout(this._frameTimer);
        this._frameTimer = null;
        this._framePending = false;
        if (!this._closed) this._tickFrames();
        return;
      case 'tray-click':
        this._statusItems.get(event.id)?._emit('click', event);
        return;
      case 'tray-action':
        this._statusItems.get(event.id)?._activate(event.text ?? '');
        return;
      case 'tray-ready':
      case 'tray-failed':
        return;
      case 'gl-ready':
        this._glWindows.get(event.id)?._onReady(event.a === 1, event.b);
        return;
      case 'file-dialog':
        this.filePanels?._answer(event.id, event.a === 1, event.text ?? '');
        return;
      case 'hotkey':
      case 'hotkey-registered':
        return;
      default:
        break;
    }

    const wnd = this._windows.get(event.id);
    if (!wnd) return;
    switch (event.type) {
      case 'window-ready':
        wnd._onReady(event.a, event.b);
        break;
      case 'move':
        wnd._noteOrigin(event.a, event.b);
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
        wnd.emit('mousemove', {
          x: event.a,
          y: event.b,
          ...rootOf(wnd, event),
        });
        break;
      case 'mouseout':
        wnd.emit('mouseout', {});
        break;
      case 'wheel': {
        const deltaX = event.c;
        const deltaY = event.d;
        wnd.emit('wheel', {
          name: 'wheel',
          x: event.a,
          y: event.b,
          rootx: event.a,
          rooty: event.b,
          buttons: 0,
          deltaX,
          deltaY,
          deltaMode: 'line',
          // A precision touchpad sends fractions of a notch by default and an
          // addon cannot opt out of them, so a fraction is exactly the signal
          // that this came from one.
          smooth: !Number.isInteger(deltaX) || !Number.isInteger(deltaY),
          source: 'wheel',
        });
        break;
      }
      case 'mousedown':
      case 'mouseup':
        // `keycode` is the button, numbered as X numbers them — the bridge
        // already speaks that vocabulary. It used to be hardcoded to 1, so
        // a right-click arrived as a left-click and no context menu ever
        // opened.
        wnd.emit(event.type, {
          x: event.a,
          y: event.b,
          keycode: event.c || 1,
          buttons: modifierMask(event.d),
          ...rootOf(wnd, event),
        });
        // A press in one window is a press *outside* every open menu but the
        // one it landed in — which on X11 the grab would have delivered to
        // the menu instead of to this window.
        if (event.type === 'mousedown') this._dismissOutsidePopups(wnd);
        break;
      case 'keydown':
      case 'keyup': {
        // The bridge asked the active layout what the key types before the
        // modifiers were stripped from it, because that question can only be
        // answered where the keyboard state is (src/win32.cc, EmitKey).
        const decoded = decodeKey(event);
        wnd.emit(event.type, {
          keycode: event.a,
          keysym: decoded.keysym,
          baseKeysym: decoded.baseKeysym,
          codepoint: decoded.codepoint,
          buttons: modifierMask(event.d),
          group: 0,
          time: Date.now(),
        });
        break;
      }
      // The shell's drag, on its way through one of our windows. The
      // transport answers each of these before returning — for a motion the
      // answer is remembered for the next one, and for the drop the bridge's
      // UI thread is waiting inside `IDropTarget::Drop` for exactly it.
      case 'drag-enter':
      case 'drag-over':
      case 'drag-leave':
      case 'drag-drop':
        wnd._routeDrag(event);
        return;
      // Our own drag, which the shell is carrying. `DoDragDrop` reports no
      // motion of its own, so these come from the source's feedback
      // callback — the only news of the gesture while the shell owns the
      // pointer, and what a `<popup dragPreview>` follows.
      case 'drag-session-moved':
        this._activeDrag?.nativeMoved(this._dragPoint(event));
        return;
      case 'drag-session-ended': {
        const drag = this._activeDrag;
        this._activeDrag = null;
        drag?.nativeEnded({
          ...this._dragPoint(event),
          operation: event.c ? String(event.text ?? '') || null : null,
        });
        return;
      }
      // Activation, which the tree reads as focus: a caret blinks, a focus
      // ring is drawn, and a `<window>`'s `focused` state follows it.
      // A thumbnail toolbar button. The shell sends the index it was given;
      // the caller's own id for that button is what the handler wants.
      case 'thumbbutton': {
        const ids = this._thumbButtons?.get(event.id) ?? [];
        wnd.emit('thumbbutton', {
          id: ids[event.a] ?? event.a,
          index: event.a,
        });
        return;
      }
      case 'window-focus':
      case 'window-blur':
        wnd.emit(event.type === 'window-focus' ? 'focus' : 'blur', {
          buttons: 0,
          time: Date.now(),
        });
        // A field focused before the window got the keyboard should compose
        // from the first key rather than from the first frame after it.
        // Nothing is done on blur: Windows deactivates the IME for a window
        // that is not in front, and a composition left open is one the user
        // comes back to, which is what every other application does.
        if (event.type === 'window-focus') this.inputMethod.sync(wnd);
        // Losing activation is the other half of the grab this platform does
        // not have: the press went to another application or to the desktop.
        // A popup never takes activation (`WS_EX_NOACTIVATE`), so opening one
        // raises no blur and this cannot fire on the menu's own appearance.
        if (event.type === 'window-blur' && !this._dismissOnOutside.has(wnd)) {
          this._dismissOutsidePopups(null);
        }
        return;
      case 'ime-start':
      case 'ime-preedit':
      case 'ime-commit':
      case 'ime-end':
        this.inputMethod.handle(event, wnd);
        return;
      case 'uia-wanted':
        // A screen reader just attached to this window. The tree it reads is
        // built now rather than left at whatever the last commit produced.
        this._a11y?.wanted(event.id);
        return;
      case 'uia-action':
        // A screen reader asking for something to happen. A request, not a
        // change: the tree decides, through the same click a pointer makes.
        this._a11y?.action(event);
        return;
      case 'close':
        // The same shape Cocoa sends. `preventDefault` is a no-op because
        // nothing has happened yet to prevent: WM_CLOSE is answered with 0
        // and the window is still there, so the request is the app's to
        // grant. The listener calls it before deciding, and a close event
        // without it throws before `onCloseRequest` is ever reached.
        wnd.emit('close', { preventDefault() {} });
        break;
      case 'appearance': {
        // Re-read whole, and the cached bezels go with it: every one of them
        // was drawn in the appearance that just stopped being true.
        const next = this.systemAppearance();
        this._syncBezels(next?.colorScheme);
        for (const fn of [...this._appearanceListeners]) {
          try {
            fn(next);
          } catch (err) {
            if (process.env.NODE_ENV !== 'production') console.error(err);
          }
        }
        break;
      }
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

  // Before the first window, so a control's very first frame is drawn with the
  // bezels it will keep rather than swapping to them a frame later.
  app._syncBezels(app.systemAppearance()?.colorScheme);
  // What each shell rung is actually built on. `src/capabilities.js` reports
  // this as a capability's `backend`, and it has to be declared rather than
  // inferred: this backend installs the same method names AppKit does -- that
  // is what makes `useTray` and `useBadge` one hook each -- so a probe reading
  // `createStatusItem` called Shell_NotifyIcon `cocoa` and handed out AppKit's
  // feature map with it. Mechanisms, never platforms (AGENTS.md).
  app.shellMechanisms = { tray: 'shellnotifyicon', launcher: 'taskbar' };
  // The accessibility bridge this backend has of its own. Its presence is
  // what `startA11y()` reads to know not to climb toward an AT-SPI bus that
  // is not there; the import is deferred so a process with no screen reader
  // never loads it (src/win32/a11y.js).
  app.startAccessibility = async () => {
    const { startWin32Accessibility } = await import('./a11y.js');
    return startWin32Accessibility(app);
  };
  installTaskbar(app);
  // A notification centre and the two session-wide facts — whether anybody is
  // at the keyboard, and whether the screen may sleep. All three are seams the
  // core looks for on the app and finds on no backend but the one it is on.
  installNotifications(app);
  installIdle(app);
  // The three the taskbar has and no other desktop does. Installing them is
  // what the launcher capability's `tasks`, `thumbnailToolbar` and
  // `recentDocuments` features read, so an app asks what this desktop has
  // rather than which platform it is on.
  installTaskbarSurfaces(app);
  // The GL ladder, which decides whether <glarea> has a rung here at all.
  installGl(app);

  // The ladder is otherwise climbed only when something asks — and its Windows
  // rung needs an app to ask, which nothing but this has. Started here and not
  // awaited: the first frame is drawn from the answer this machine gave last
  // time and the live one lands behind it, which is the direction
  // AGENTS.md asks appearance to settle in. A failure is the ladder's own to
  // report; there is nothing useful to do with it here.
  void systemAppearance({ app }).catch(() => {});

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
