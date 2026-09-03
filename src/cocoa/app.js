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
import { BezelStore } from './bezels.js';
import { CocoaGLArea, cocoaGLConfig, resolveCocoaGLRuntime } from './glarea.js';
import { CocoaGlobalMenuExport } from './globalmenu.js';
import { CocoaPaneHost } from './panehost.js';
import { CocoaPaneWindow } from './panewindow.js';
import { CocoaFontManager } from './fonts.js';
import { CocoaSurface } from './surface.js';
import { CocoaWindow } from './window.js';
import { decodeKey, modifierMask } from './keymap.js';
import { loadNative } from './native.js';

// The frame interval: how often a scheduled frame may paint, in ms. The
// default is the period of the display the window is on — `listScreens`
// reports each panel's `fps` (NSScreen.maximumFramesPerSecond, bridge 0.4),
// so a 120Hz panel paints every 8.3ms and a 60Hz monitor every 16.7 —
// and `createRoot({ cocoa: { frameInterval } })` overrides it for every
// window. 16 stands in where the OS cannot say (`fps: 0`) and under a
// bridge that does not report it: a 60Hz floor every Mac clears.
const RAF_INTERVAL_MS = 16;
const PUMP_INTERVAL_MS = 8;
// How early a pump tick may take a frame that is not quite due, in ms — the
// drift of a timer, not a fraction of the pump (`_frameDue`).
const FRAME_SLACK_MS = 1;

export class CocoaApp {
  constructor(native, options = {}) {
    this._native = native;
    this.options = options;
    this._windows = new Map(); // windowNumber -> CocoaWindow
    this._grabWindow = null;
    this._rafQueue = []; // [{ cb, wnd }]
    // the app's own frame clock, for a frame no window owns (a pane's)
    this._rafLast = 0;
    // an explicit interval applies to every window; null means each
    // window paces itself on its own display (`frameIntervalFor`)
    this._frameInterval = options.cocoa?.frameInterval ?? null;
    this._pumpInterval = PUMP_INTERVAL_MS;
    // the one-shot that runs a frame due between two pump ticks, and when
    // it is due (`_armFrameTimer`)
    this._frameTimer = null;
    this._frameTimerAt = 0;
    this._geometryFlushQueued = false;
    this._shadowStale = new Set();
    this._pump = null;
    this._closed = false;

    const screens = native.listScreens();
    this.scale = screens[0]?.scale ?? 1;
    this._screens = screens;

    // 'surface' (the measured default) or 'layers' — the retained CALayer
    // presenter, opt-in while docs/macos.md's measure-first gate is open.
    this._presenterMode =
      options.cocoa?.presenter ??
      process.env.REACT_X11_COCOA_PRESENTER ??
      'surface';

    // the app's own bridge, so an app over a fake one (the tests) needs no
    // real bridge on the machine — the manager's default loads it only when
    // it is built standalone
    this.fonts = new CocoaFontManager(native);

    // AppKit-rendered control bezels. Its *presence* is the capability:
    // `useSupports('nativeControls')` and the widget set's `controls:
    // 'auto'` policy both test for this property, so a backend without it
    // (X11, the headless mock) draws the themed controls with no further
    // branching.
    this.nativeBezels = new BezelStore(native);

    // The GL policy, glbackend.js's shape. No GLX exists here, so the
    // default is 'auto' (the direct backend where the runtime loads);
    // useSupports('shaders') stays false until the first <glarea> resolves
    // the runtime and settles _glCapsResolved.
    this.glPolicy = { mode: options.glPolicy ?? 'auto' };
    this._cocoaGL = null;

    // the global-menu exports, newest active: the macOS menu bar is one per
    // app, so the most recent MenuBar owns it (per-focused-window switching
    // is the follow-up — docs/macos.md §Menus)
    this._globalMenus = [];
    this._activeGlobalMenu = null;

    // Frame-pane mode: this process renders a pane whose pixels a host
    // composites (REACT_X11_FRAME is what the Frame host sets on the fork).
    this._paneMode = options.pane ?? process.env.REACT_X11_FRAME === '1';
    this._paneSend = null;

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
    // A frame pane's window: no NSWindow at all — the pane paints into
    // shared IOSurfaces and the HOST composites them (src/cocoa/
    // panewindow.js). Chosen by the same prop the X11 pane uses.
    if (this._paneMode && attributes.embeddable) {
      return new CocoaPaneWindow(this, attributes);
    }
    if (attributes.parent) {
      // A parented "window" here is a GL child surface — GlAreaNode's
      // contract, the one child-window consumer this backend has. It is a
      // sublayer, not an NSWindow; nested <window> elements proper are
      // still not supported.
      if (attributes.parent instanceof CocoaWindow) {
        return new CocoaGLArea(this, attributes);
      }
      throw new Error(
        'react-x11: nested <window> elements are not supported on the ' +
          'cocoa backend yet — track docs/macos.md.',
      );
    }
    return new CocoaWindow(this, attributes);
  }

  /**
   * The `<glarea>` config seam (src/glnodes.js): resolve the GL runtime and
   * answer which rung of the API ladder this area draws through. See
   * src/cocoa/glarea.js for the ladder.
   */
  chooseGLConfig(spec) {
    return cocoaGLConfig(this, spec);
  }

  /**
   * The Frame host seam (src/frame/index.js): a pane's composited region
   * in this window. Its presence is what routes <Frame> to the shared-
   * memory pane path instead of the X foreign-window embed.
   */
  createPaneHost(wnd) {
    return new CocoaPaneHost(this, wnd);
  }

  /**
   * The offscreen-surface seam `react-x11/ntk`'s `Surface` dispatches on:
   * ntk's `Surface` contract over a CG bitmap (src/cocoa/surface.js). Its
   * presence is what makes `new Surface(app, { width, height })` answer a
   * surface here rather than ntk's pixmap, which needs an X connection — a
   * backend without the method gets ntk's, so an X app is never asked.
   */
  createSurface(options) {
    return new CocoaSurface(this, options);
  }

  /**
   * The `useGlobalMenu` transport seam: same owner shape as the D-Bus
   * GlobalMenuExport (start/stop/update), pointed at the macOS menu bar.
   */
  createGlobalMenuExport(options) {
    return new CocoaGlobalMenuExport(this, options);
  }

  _registerGlobalMenu(exporter) {
    this._globalMenus.push(exporter);
    this._activeGlobalMenu = exporter;
  }

  _unregisterGlobalMenu(exporter) {
    this._globalMenus = this._globalMenus.filter((e) => e !== exporter);
    if (this._activeGlobalMenu === exporter) {
      this._activeGlobalMenu = this._globalMenus.at(-1) ?? null;
      if (this._activeGlobalMenu) this._activeGlobalMenu._install();
      else this._native.setMainMenu([{ title: 'App', items: [] }]);
    }
  }

  /**
   * What the machine can do, `useSupports('shaders')`'s slow half: ntk
   * settles this during its connect handshake, and here it settles on the
   * first ask — watchDirectGL calls it exactly when a component subscribes
   * before any <glarea> forced the probe (src/glbackend.js).
   */
  glCapabilities() {
    return resolveCocoaGLRuntime(this).then(
      () => this._glCapsResolved,
      () => this._glCapsResolved,
    );
  }

  _registerWindow(wnd) {
    this._windows.set(wnd.windowNumber, wnd);
  }

  /**
   * How often `wnd` may paint, in ms: the explicit `frameInterval` when the
   * root was given one, else the period of the screen under the window's
   * centre — the display's own rate is the only honest cadence, and on a
   * desk with a 120Hz panel and a 60Hz monitor the two windows differ. A
   * window on no screen (mid-drag between two, or off the edge) and a
   * screen the OS reports no rate for take the primary's, then 16ms.
   */
  frameIntervalFor(wnd) {
    if (this._frameInterval != null) return this._frameInterval;
    const s = this.scale;
    const screens = this._screens ?? [];
    let screen = null;
    if (wnd) {
      const cx = (wnd.x + wnd.width / 2) / s;
      const cy = (wnd.y + wnd.height / 2) / s;
      screen =
        screens.find(
          (sc) =>
            cx >= sc.x &&
            cx < sc.x + sc.width &&
            cy >= sc.y &&
            cy < sc.y + sc.height,
        ) ?? null;
    }
    const fps = screen?.fps || screens[0]?.fps || 0;
    return fps > 0 ? 1000 / fps : RAF_INTERVAL_MS;
  }

  /**
   * The pane's end of the frame channel (childmain hands it over,
   * feature-detected so the X11 pane path never notices): geometry and
   * input come in, pane-present goes out.
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
        wnd.setPaneSize(msg.width, msg.height, msg.scale);
        this._afterInput();
      } else if (msg?.type === 'pane-event') {
        wnd.emit(msg.name, msg.ev);
        this._afterInput();
      }
    });
  }

  _unregisterWindow(wnd) {
    this._windows.delete(wnd.windowNumber);
    if (this._grabWindow === wnd) this._grabWindow = null;
  }

  // --- the pump ------------------------------------------------------------

  start({ pumpInterval = PUMP_INTERVAL_MS } = {}) {
    if (this._pump) return;
    this._pumpInterval = pumpInterval;
    const native = this._native;
    // A pane process has no NSApplication to pump — no windows, no events,
    // no dock presence. Its loop is frames and presents only.
    if (this._paneMode) {
      this._pump = setInterval(() => {
        this._tickFrames();
        this._presentAll();
      }, pumpInterval);
      return;
    }
    native.initApp();
    native.setBackendEventCallback((ev) => this._route(ev));
    this._pump = setInterval(() => {
      this._endLiveResizes();
      native.pump2(); // flushes the previous tick's CATransaction
      if (this._shadowStale.size) {
        for (const wnd of this._shadowStale) {
          if (!wnd.destroyed) native.invalidateWindowShadow(wnd._h);
        }
        this._shadowStale.clear();
      }
      this._tickFrames();
      this._presentAll();
    }, pumpInterval);
  }

  /**
   * A pump tick means no modal loop owns the thread, so no window is being
   * resized live right now: the flag the delegate set on the last tick of a
   * drag comes off here, ahead of the frames that tick, and the catch-up
   * frame a deferred layout owes (nodes.js) runs on this very tick.
   */
  _endLiveResizes() {
    for (const wnd of this._windows.values()) wnd.liveResizing = false;
  }

  _requestFrame(cb, wnd = null) {
    this._rafQueue.push({ cb, wnd });
    return this._rafQueue.length;
  }

  /**
   * Whether `clock` — a window, or the app for a frame no window owns —
   * is due a frame at `now`, and if so, stamps it.
   *
   * The clock keeps the display's period, not the pump's: a frame that ran
   * is stamped one interval after the last one was due rather than at the
   * moment it happened to run, so a tick that took it a little early or a
   * timer that fired a little late moves nothing — the next frame is still
   * due where the display's next refresh is. A frame that arrives more than
   * an interval late (a slow one) re-anchors the clock instead of owing the
   * frames it missed.
   *
   * The gate is a millisecond of slack under the interval, which is a
   * timer's drift and no more. It used to be half a pump, so that a frame
   * would land on the first tick at or after the interval instead of
   * alternating between the tick before and the one after; that quantized
   * the period to the pump — a 75Hz monitor's 13.3ms gate of 9.3 fell on
   * the 16ms tick, and the window painted at 62.5fps. A frame due between
   * two ticks now gets a timer of its own (`_armFrameTimer`), and the
   * period is the display's whatever the pump's cadence.
   */
  _frameDue(clock, now) {
    const interval =
      clock === this ? this.frameIntervalFor(null) : clock._frameInterval;
    const since = now - clock._rafLast;
    if (since < interval - FRAME_SLACK_MS) return false;
    clock._rafLast = since < 2 * interval ? clock._rafLast + interval : now;
    return true;
  }

  /** How long until `clock` is due, from `now`. */
  _frameWait(clock, now) {
    const interval =
      clock === this ? this.frameIntervalFor(null) : clock._frameInterval;
    return interval - FRAME_SLACK_MS - (now - clock._rafLast);
  }

  /**
   * A frame that falls between two pump ticks gets a tick of its own: a
   * one-shot timer at the moment it is due, which runs the frame queue and
   * presents what it painted. Only when the next pump tick would be late
   * for it — a frame due after that tick waits for the tick, which decides
   * again. One timer at a time, at the soonest of what is owed; a pump tick
   * that comes first runs whatever is due and re-arms for the rest.
   *
   * The timer costs the frame nothing the tick does not: a present commits
   * its own transaction (the bridge flushes on the flip), so what is
   * painted here is on glass without waiting for the next pump. What the
   * tick alone still does is pump AppKit's events, which is what
   * `pumpInterval` stays the cadence of.
   */
  _armFrameTimer(wait, now) {
    if (!(wait > 0 && wait < this._pumpInterval)) return;
    const at = now + wait;
    if (this._frameTimer) {
      if (at >= this._frameTimerAt) return;
      clearTimeout(this._frameTimer);
    }
    this._frameTimerAt = at;
    this._frameTimer = setTimeout(
      () => {
        this._frameTimer = null;
        if (this._closed) return;
        this._tickFrames();
        this._presentAll();
      },
      Math.max(1, Math.round(wait)),
    );
  }

  _tickFrames() {
    if (!this._rafQueue.length) return;
    const now = performance.now();
    // Each window keeps its own clock, so a window on a 120Hz panel paints
    // every refresh while one on a 60Hz monitor paints every other pump
    // tick. Decided once per clock per tick: every frame a window queued
    // runs when it is due, not just the first.
    const due = new Map();
    const queue = this._rafQueue;
    this._rafQueue = [];
    let soonest = Infinity;
    for (const entry of queue) {
      const clock = entry.wnd ?? this;
      if (!due.has(clock)) due.set(clock, this._frameDue(clock, now));
      if (!due.get(clock)) {
        this._rafQueue.push(entry);
        soonest = Math.min(soonest, this._frameWait(clock, now));
        continue;
      }
      // A window nobody can see owes no frame: its callback waits here until
      // it is back on glass, and the damage it answers accumulates on the
      // node — one catch-up frame then, instead of a full paint per tick
      // into a backing store no one reads. `_visible` is the window's own
      // rule (mapped, not ordered out, not miniaturized, not entirely
      // behind another application's window).
      if (entry.wnd && !entry.wnd._visible()) {
        this._rafQueue.push(entry);
        continue;
      }
      try {
        entry.cb(now);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
    this._armFrameTimer(soonest, now);
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
      case 'window-occlusion':
        return this._routeOcclusion(ev);
      case 'menu-activate':
        this._activeGlobalMenu?.activate(ev.id);
        return this._afterInput();
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
    // Painted now, like a press. On X11 the wheel is paced on the frame
    // clock because ntk coalesces a touchpad's dozens of reports per frame
    // into one event; AppKit already delivers scroll events at the
    // display's rate, so answering each one is answering once per refresh
    // — and answering it on the next frame tick instead was a 15ms median
    // between the notch and the scroll, most of a refresh period of nothing.
    this._afterInput();
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
    // The React HALF of the response — an anchored popup following the
    // window, an onResize setState — commits on a microtask AFTER this
    // handler returns, and the pump that would paint it is the thing the
    // modal loop stalled. A second flush queued BEHIND that commit is what
    // lets an open menu resize with the drag instead of on release.
    //
    // One, not one per event: inside the modal loop no microtask runs until
    // the drag ends, so a drag's every tick queued another — and they all
    // ran on the release, each finding the frame the previous one had just
    // paid. Coalesced, the release owes at most one flush.
    if (!this._geometryFlushQueued) {
      this._geometryFlushQueued = true;
      queueMicrotask(() => {
        this._geometryFlushQueued = false;
        if (!this._closed) this._afterInput();
      });
    }
  }

  /**
   * `windowDidChangeOcclusionState`: `visible` is "some pixel of the window
   * is on glass". Off, the window's frames wait in the queue and its
   * present waits with them (`CocoaWindow._visible`); on, the next pump
   * tick runs the catch-up frame and puts it on glass — no early flush,
   * since nothing was asked for and the pump is at most one interval away.
   */
  _routeOcclusion(ev) {
    const wnd = this._window(ev);
    if (!wnd || wnd.destroyed) return;
    wnd._occluded = ev.visible === false;
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
    if (this._frameTimer) clearTimeout(this._frameTimer);
    this._frameTimer = null;
    this._cocoaGL?.destroy();
    this._cocoaGL = null;
    this._native.setBackendEventCallback(null);
    for (const wnd of [...this._windows.values()]) wnd.destroy();
    return Promise.resolve();
  }
}

/**
 * `listScreens()` turned into the screen layout `src/screens.js` publishes.
 *
 * **One scale for every screen, and it is the app's.** macOS lays all the
 * displays out in a single global point space, and `app.scale` is this
 * app's points-to-device-pixels factor for the whole of it — window
 * origins, event coordinates, these rects. Converting a 1x external
 * display by *its own* 1 while windows on it still report `points * 2`
 * would put the monitor somewhere no window ever is, and `monitorAt()`
 * would answer with the wrong head. (What backing scale a window on a
 * mixed-DPI desk should raster at is a real and separate question; the
 * layout is not where it is answered.)
 *
 * **A usable rect per monitor.** `NSScreen.visibleFrame` is per screen —
 * that display's own menu bar and Dock taken off — so each monitor carries
 * its `visible` and `usable()` takes it as a rect. Publishing only the
 * primary's, the way `_NET_WORKAREA` forces on X11, applied the primary's
 * *width* as a bound to every other head: a second display wider than the
 * built-in had its right edge pulled in by the difference, and every
 * anchored popup that reached past it was clamped back (issue #453).
 */
export function screenLayout(screens, scale) {
  const rect = (r) => ({
    x: Math.round(r.x * scale),
    y: Math.round(r.y * scale),
    width: Math.round(r.width * scale),
    height: Math.round(r.height * scale),
  });
  const primary = screens?.[0];
  return {
    monitors: (screens ?? []).map((screen) => ({
      ...rect(screen),
      ...(screen.visible ? { visible: rect(screen.visible) } : null),
    })),
    // Still published for `useScreens().workArea`, which is one rect for
    // the desktop by definition; the primary's is the closest macOS has.
    workArea: primary?.visible ? rect(primary.visible) : null,
  };
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
  setScreensForTests(app, screenLayout(app._screens, app.scale));
  setCompositingForTests(app, true);

  app.start(options.cocoa ?? {});
  return app;
}
