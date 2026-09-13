// Routing seat events into the window tree, in the vocabulary react-x11's
// `events.js` already speaks.
//
// The renderer subscribes to ntk-shaped window events — `mousedown`,
// `mousemove`, `wheel`, `keydown`, `focus` and so on, with X-style fields:
// device-pixel `x`/`y`, a `buttons` state mask, a `keycode`, a server
// timestamp. The Cocoa backend translates NSEvents into that shape; this
// translates `wl_seat`'s. The tree above never knows which.
//
// Three things are this file's own:
//
// - **Coordinates.** Seat events are surface-local, logical, and relative to
//   the whole surface including the client-side decorations. The tree wants
//   content-relative device pixels. Every event goes through one function
//   that subtracts the frame and multiplies by the scale.
// - **The frame.** Presses on the titlebar and edges never reach the tree:
//   they start compositor moves and resizes, toggle maximise, or hit the
//   buttons. Hover over the frame drives the resize cursors; hover over
//   content hands the cursor back to whatever the tree last set.
// - **Which window.** A seat event names a `wl_surface`; the map from
//   surface to window lives on the app. Keys go to the keyboard-focused
//   surface, pointer events to the one under the pointer, and a popup with a
//   grab receives the outside press that should dismiss it as an ordinary
//   `mousedown` outside its bounds — which is what its `<popup grab>` logic
//   on X11 expects from a grab.

import { Decorations } from './decorations.js';
import { XkbKeymap } from './xkb.js';
import { TOPLEVEL_STATE } from './window.js';

export class InputRouter {
  /**
   * @param {import('./app.js').WaylandApp} app
   */
  constructor(app) {
    this.app = app;
    this.seat = app.seat;
    /** the backend window under the pointer */
    this.pointerWindow = null;
    /** the backend window with keyboard focus */
    this.focusWindow = null;
    /** what the frame's hover last asked the cursor to be, or null */
    this._frameCursor = null;
    /** touch points that began on the frame, which the tree never sees */
    this._frameTouches = new Set();
    this._wire();
  }

  _wire() {
    const s = this.seat;
    s.on('enter', (ev) => this._onEnter(ev));
    s.on('leave', (ev) => this._onLeave(ev));
    s.on('motion', (ev) => this._onMotion(ev));
    s.on('buttonpress', (ev) => this._onButton(ev, true));
    s.on('buttonrelease', (ev) => this._onButton(ev, false));
    s.on('wheel', (ev) => this._onWheel(ev));
    s.on('keydown', (ev) => this._onKey('keydown', ev));
    s.on('keyup', (ev) => this._onKey('keyup', ev));
    s.on('focus', (ev) => this._onFocus(ev, true));
    s.on('blur', (ev) => this._onFocus(ev, false));
    // touch.js and tablet.js emit the pointer events above for the finger or
    // tool that is standing in for the pointer; only the raw points are new
    for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel'])
      s.on(n, (ev) => this._onTouch(ev));
    s.on('keymap', (_km, xkb) => {
      if (xkb) this.app.X.keycode2keysyms = xkb.keycode2keysyms;
      this.app.X.emit('mapping');
    });
  }

  _window(surfaceId) {
    return surfaceId == null ? null : (this.app.windows.get(surfaceId) ?? null);
  }

  /** The X-style state mask: modifiers and held buttons together. */
  _state() {
    return (
      XkbKeymap.stateOf(this.seat.mods, this.seat.group) | this.seat.buttonMask
    );
  }

  /** Surface-local logical -> content-relative device pixels. */
  _point(win, x, y) {
    const i = win.insets;
    const s = win.scale;
    return { x: Math.round((x - i.left) * s), y: Math.round((y - i.top) * s) };
  }

  _emit(win, name, ev) {
    if (!win || win._destroyed) return;
    win.emit(name, ev);
    this.app.afterInput?.();
  }

  // ---- pointer ----------------------------------------------------------

  _onEnter(ev) {
    const win = this._window(ev.surface);
    this.pointerWindow = win;
    if (!win) return;
    this._updateFrameHover(win, ev.x, ev.y);
    const p = this._point(win, ev.x, ev.y);
    this._emit(win, 'mouseover', {
      ...p,
      rootx: p.x,
      rooty: p.y,
      buttons: this._state(),
      time: 0,
      // a finger or a pen standing in for the pointer says so (touch.js,
      // tablet.js); a mouse adds nothing, as on the other backends
      ...ev.device,
    });
  }

  _onLeave(ev) {
    const win = this._window(ev.surface);
    if (this.pointerWindow === win) this.pointerWindow = null;
    if (!win) return;
    if (win.decor && win.decor.hover) {
      win.decor.hover = null;
      win.repaintFrame();
    }
    this._frameCursor = null;
    this._emit(win, 'mouseout', {
      x: 0,
      y: 0,
      rootx: 0,
      rooty: 0,
      buttons: this._state(),
      time: 0,
      ...ev.device,
    });
  }

  _onMotion(ev) {
    const win = this.pointerWindow ?? this._window(ev.surface);
    if (!win) return;
    const hit = this._updateFrameHover(win, ev.x, ev.y);
    if (hit.kind !== 'content' && !this.seat.buttonMask) return;
    const p = this._point(win, ev.x, ev.y);
    this._emit(win, 'mousemove', {
      ...p,
      rootx: p.x,
      rooty: p.y,
      buttons: this._state(),
      time: ev.time,
      ...ev.device,
    });
  }

  /**
   * Frame hover: the button under the pointer (for its highlight) and the
   * cursor the edge wants. Returns the hit so callers can skip the tree.
   */
  _updateFrameHover(win, x, y) {
    if (!win.decor) return { kind: 'content' };
    const hit = win.decor.hitTest(x, y, win.wl.width, win.wl.height);
    const hoverId = hit.kind === 'button' ? hit.id : null;
    if (win.decor.hover !== hoverId) {
      win.decor.hover = hoverId;
      win.repaintFrame();
    }
    const want = hit.kind === 'content' ? null : Decorations.cursorFor(hit);
    if (want !== this._frameCursor) {
      this._frameCursor = want;
      this.seat.setCursor(want ?? win.treeCursor ?? 'default');
    }
    return hit;
  }

  _onButton(ev, pressed) {
    const win = this.pointerWindow ?? this._window(ev.surface);
    if (!win) return;
    if (win.decor && pressed && !this.seat.buttonMask) {
      // buttonMask already includes this press; the frame decides on a
      // fresh press only, never mid-drag
    }
    if (win.decor) {
      const hit = win.decor.hitTest(ev.x, ev.y, win.wl.width, win.wl.height);
      if (hit.kind !== 'content') {
        if (pressed) this._framePress(win, hit, ev);
        else this._frameRelease(win, hit, ev);
        return;
      }
    }
    const p = this._point(win, ev.x, ev.y);
    this._emit(win, pressed ? 'mousedown' : 'mouseup', {
      ...p,
      rootx: p.x,
      rooty: p.y,
      keycode: ev.button,
      buttons: ev.state | XkbKeymap.stateOf(this.seat.mods, this.seat.group),
      time: ev.time,
      serial: ev.serial,
      ...ev.device,
    });
  }

  _framePress(win, hit, ev) {
    const seat = this.seat.seat;
    if (hit.kind === 'resize' && ev.button === 1) {
      win.wl.startResize(seat, ev.serial, hit.edges);
      return;
    }
    if (hit.kind === 'button') {
      win.decor.pressed = hit.id;
      return;
    }
    // titlebar
    if (ev.button === 1) {
      const now = ev.time;
      if (win._lastTitlePress && now - win._lastTitlePress < 400) {
        win._lastTitlePress = 0;
        win.wl.maximize(!win.decor.maximized);
        return;
      }
      win._lastTitlePress = now;
      win.wl.startMove(seat, ev.serial);
    } else if (ev.button === 3) {
      win.wl.showWindowMenu(seat, ev.serial, ev.x, ev.y);
    }
  }

  _frameRelease(win, hit, ev) {
    const pressed = win.decor.pressed;
    win.decor.pressed = null;
    if (
      !pressed ||
      hit.kind !== 'button' ||
      hit.id !== pressed ||
      ev.button !== 1
    )
      return;
    if (pressed === 'close') win.requestClose();
    else if (pressed === 'maximize') win.wl.maximize(!win.decor.maximized);
    else if (pressed === 'minimize') win.wl.minimize();
  }

  _onWheel(ev) {
    const win = this.pointerWindow ?? this._window(ev.surface);
    if (!win) return;
    if (
      win.decor &&
      win.decor.hitTest(ev.x, ev.y, win.wl.width, win.wl.height).kind !==
        'content'
    )
      return;
    const p = this._point(win, ev.x, ev.y);
    // X's wheel is "down is positive notches"; the seat already has that sign.
    this._emit(win, 'wheel', {
      name: 'wheel',
      ...p,
      rootx: p.x,
      rooty: p.y,
      buttons: this._state(),
      deltaX: ev.deltaX,
      deltaY: ev.deltaY,
      smooth: ev.smooth,
      source: ev.smooth ? 'valuator' : 'button',
      time: ev.time,
      ...ev.device,
    });
  }

  // ---- touch ------------------------------------------------------------

  /**
   * Raw touch points — `touchstart`/`touchmove`/`touchend`/`touchcancel` on
   * the window, each with every active point over it. No emulation here:
   * touch.js makes the first finger the pointer, and those events arrived
   * above as the pointer's own. A point that began on the frame belongs to
   * the frame (its emulated press already started the move or resize) and
   * is kept from the tree for its whole life.
   */
  _onTouch(ev) {
    const win = this._window(ev.surface);
    if (!win) return;
    if (ev.type === 'touchstart' && win.decor) {
      const hit = win.decor.hitTest(ev.x, ev.y, win.wl.width, win.wl.height);
      if (hit.kind !== 'content') this._frameTouches.add(ev.id);
    }
    if (this._frameTouches.has(ev.id)) {
      if (ev.type === 'touchend' || ev.type === 'touchcancel')
        this._frameTouches.delete(ev.id);
      return;
    }
    const p = this._point(win, ev.x, ev.y);
    const s = win.scale;
    this._emit(win, ev.type, {
      ...p,
      rootx: p.x,
      rooty: p.y,
      id: ev.id,
      touchId: ev.id,
      radiusX: ev.radiusX * s,
      radiusY: ev.radiusY * s,
      rotationAngle: ev.rotationAngle,
      touches: ev.touches
        .filter(
          (t) => t.surface === ev.surface && !this._frameTouches.has(t.id),
        )
        .map((t) => ({ id: t.id, ...this._point(win, t.x, t.y) })),
      buttons: ev.state | XkbKeymap.stateOf(this.seat.mods, this.seat.group),
      pointerType: 'touch',
      time: ev.time,
      serial: ev.serial,
    });
  }

  // ---- keyboard ---------------------------------------------------------

  _onKey(name, ev) {
    const win = this.focusWindow ?? this._window(ev.surface);
    if (!win) return;
    this._emit(win, name, {
      keycode: ev.keycode,
      keysym: ev.keysym,
      baseKeysym: ev.baseKeysym,
      codepoint: ev.codepoint,
      buttons: ev.buttons,
      group: ev.group,
      time: ev.time,
      repeat: ev.repeat,
    });
  }

  _onFocus(ev, focused) {
    const win = this._window(ev.surface);
    if (focused) this.focusWindow = win;
    else if (this.focusWindow === win) this.focusWindow = null;
    if (!win) return;
    if (win.decor) {
      const wasActive = win.decor.active;
      win.decor.active = focused || win.wl.states.has(TOPLEVEL_STATE.ACTIVATED);
      if (wasActive !== win.decor.active) win.repaintFrame();
    }
    this._emit(win, focused ? 'focus' : 'blur', { buttons: 0, time: 0 });
  }

  destroy() {
    this.seat.removeAllListeners();
  }
}
