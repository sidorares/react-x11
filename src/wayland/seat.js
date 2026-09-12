// Input: the seat, its pointer and its keyboard.
//
// The pointer is the easy half and maps almost exactly onto what the X11
// backend already synthesises — enter/leave/motion/button/axis, with
// coordinates in surface-local `wl_fixed` that the codec has already turned
// back into numbers. Three differences are worth knowing:
//
// - Events arrive in *frames*: a `wl_pointer.frame` marks the end of a
//   logically atomic group, so a diagonal motion with a wheel tick is one
//   update rather than three.
// - There is no `QueryPointer`: a client learns where the pointer is by
//   being told, or not at all.
// - **The client owns the cursor.** On `enter` the pointer image over the
//   surface is whatever the client sets — set nothing and there is no
//   cursor at all. `wp_cursor_shape_manager_v1` makes that one request with
//   a shape name; without it a client would have to load a cursor theme and
//   attach image buffers itself.
//
// The keyboard is where this backend earns its transport. The compositor
// does not send keysyms — it sends **the keymap itself, once, as a file
// descriptor**, and every later event is a raw keycode the client interprets
// against that map (xkb.js). Two more things the compositor leaves to the
// client: **key repeat** (`repeat_info` gives the rate and delay; the events
// themselves never repeat) and the modifier state, which arrives as its own
// event rather than on each key.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { XkbKeymap } from './xkb.js';

/** `wl_seat.capability` bits. */
export const SEAT_CAP = { POINTER: 1, KEYBOARD: 2, TOUCH: 4 };

export const RELEASED = 0;
export const PRESSED = 1;

/** Linux evdev button codes, which is what `wl_pointer.button` carries. */
export const BTN = {
  LEFT: 0x110,
  RIGHT: 0x111,
  MIDDLE: 0x112,
  SIDE: 0x113,
  EXTRA: 0x114,
};

/** evdev -> the 1-based numbering the rest of react-x11 speaks. */
const BUTTON_NUMBER = {
  [BTN.LEFT]: 1,
  [BTN.MIDDLE]: 2,
  [BTN.RIGHT]: 3,
  [BTN.SIDE]: 8,
  [BTN.EXTRA]: 9,
};

/** X state-mask bits for held pointer buttons (Button1Mask..). */
const BUTTON_MASK = {
  1: 1 << 8,
  2: 1 << 9,
  3: 1 << 10,
  8: 1 << 15,
  9: 1 << 16,
};

/**
 * The keycode offset between evdev and X.
 *
 * X keycodes are evdev codes plus 8, an artefact of the original protocol's
 * minimum keycode. Every XKB keymap — including the one the compositor hands
 * over — is indexed the X way, so this is the conversion the keymap expects.
 */
export const EVDEV_KEYCODE_OFFSET = 8;

/** `wp_cursor_shape_device_v1.shape`, by the CSS names react-x11 uses. */
export const CURSOR_SHAPES = {
  default: 1,
  context_menu: 2,
  'context-menu': 2,
  help: 3,
  pointer: 4,
  progress: 5,
  wait: 6,
  cell: 7,
  crosshair: 8,
  text: 9,
  vertical_text: 10,
  'vertical-text': 10,
  alias: 11,
  copy: 12,
  move: 13,
  no_drop: 14,
  'no-drop': 14,
  not_allowed: 15,
  'not-allowed': 15,
  grab: 16,
  grabbing: 17,
  e_resize: 18,
  'e-resize': 18,
  n_resize: 19,
  'n-resize': 19,
  ne_resize: 20,
  'ne-resize': 20,
  nw_resize: 21,
  'nw-resize': 21,
  s_resize: 22,
  's-resize': 22,
  se_resize: 23,
  'se-resize': 23,
  sw_resize: 24,
  'sw-resize': 24,
  w_resize: 25,
  'w-resize': 25,
  ew_resize: 26,
  'ew-resize': 26,
  ns_resize: 27,
  'ns-resize': 27,
  nesw_resize: 28,
  'nesw-resize': 28,
  nwse_resize: 29,
  'nwse-resize': 29,
  col_resize: 30,
  'col-resize': 30,
  row_resize: 31,
  'row-resize': 31,
  all_scroll: 32,
  'all-scroll': 32,
  zoom_in: 33,
  'zoom-in': 33,
  zoom_out: 34,
  'zoom-out': 34,
  dnd_ask: 35,
  all_resize: 36,
  'all-resize': 36,
  // X cursor names the tree may still use
  arrow: 1,
  left_ptr: 1,
  hand: 4,
  hand2: 4,
  xterm: 9,
  watch: 6,
  fleur: 13,
  sb_h_double_arrow: 26,
  sb_v_double_arrow: 27,
  top_left_corner: 21,
  top_right_corner: 20,
  bottom_left_corner: 24,
  bottom_right_corner: 23,
  left_side: 25,
  right_side: 18,
  top_side: 19,
  bottom_side: 22,
  question_arrow: 3,
  tcross: 8,
  plus: 7,
};

/** One wheel notch, in the scroll units `wl_pointer.axis` reports. */
const NOTCH = 10;

export class WaylandSeat extends EventEmitter {
  constructor(seat, { cursorShapes = null } = {}) {
    super();
    this.seat = seat;
    this.name = null;
    this.capabilities = 0;
    this.pointer = null;
    this.keyboard = null;
    this._cursorShapes = cursorShapes;
    this._cursorDevice = null;
    this._cursor = 'default';
    /** the serial of the most recent input event — what move/resize/popups need */
    this.lastSerial = 0;
    /** serial of the most recent pointer press or key press specifically */
    this.lastPressSerial = 0;
    this.pointerX = 0;
    this.pointerY = 0;
    /** the `wl_surface` id under the pointer, or null */
    this.pointerSurface = null;
    /** the `wl_surface` id with keyboard focus, or null */
    this.focus = null;
    this.keymap = null;
    /** parsed keymap, or null until the fd arrives */
    this.xkb = null;
    /** X-style modifier mask: depressed | latched | locked */
    this.mods = 0;
    this.group = 0;
    /** pointer buttons currently held, as an X state mask */
    this.buttonMask = 0;
    this.repeat = { rate: 25, delay: 600 };
    this._repeatTimer = null;
    this._repeatKey = null;
    this._pending = null;
    this._axis = null;
  }

  /**
   * @param {import('./connection.js').WaylandConnection} conn
   */
  static async bind(conn) {
    // A seat of our own rather than the connection's cached singleton: the
    // capabilities event that says whether there is a pointer and a keyboard
    // arrives once, right after the bind, and a proxy bound earlier by someone
    // else (a popup grab, the clipboard) has already had it. Binding again is
    // legal — wl_seat is a global — and the compositor answers again.
    if (!conn.has('wl_seat')) {
      throw new Error(
        `this compositor does not advertise wl_seat. Available globals: ${[...conn.globals].sort().join(', ')}`,
      );
    }
    const proxy = await conn.display.bind('wl_seat');
    proxy.setMaxListeners?.(0);
    if (!conn._bound.has('wl_seat')) conn._bound.set('wl_seat', proxy);
    const cursorShapes = await conn.bind('wp_cursor_shape_manager_v1');
    const seat = new WaylandSeat(proxy, { cursorShapes });
    seat._wire();
    await conn.roundtrip();
    return seat;
  }

  _wire() {
    const seat = this.seat;
    seat.on('name', (name) => {
      this.name = name;
    });
    seat.on('capabilities', (caps) => {
      this.capabilities = caps;
      if (caps & SEAT_CAP.POINTER && !this.pointer) this._addPointer();
      if (caps & SEAT_CAP.KEYBOARD && !this.keyboard) this._addKeyboard();
      this.emit('capabilities', caps);
    });
  }

  // ---- pointer ----------------------------------------------------------

  _addPointer() {
    const p = this.seat.$.get_pointer();
    this.pointer = p;
    if (this._cursorShapes) {
      this._cursorDevice = this._cursorShapes.$.get_pointer(p.id);
    }

    p.on('enter', (serial, surfaceId, x, y) => {
      this.lastSerial = serial;
      this.pointerX = x;
      this.pointerY = y;
      this.pointerSurface = surfaceId;
      // The cursor over this surface is ours to set, and now is when.
      this._applyCursor(serial);
      this._queue({ type: 'enter', serial, surface: surfaceId, x, y });
    });
    p.on('leave', (serial, surfaceId) => {
      this.lastSerial = serial;
      if (this.pointerSurface === surfaceId) this.pointerSurface = null;
      this._queue({ type: 'leave', serial, surface: surfaceId });
    });
    p.on('motion', (time, x, y) => {
      this.pointerX = x;
      this.pointerY = y;
      this._queue({ type: 'motion', time, x, y, surface: this.pointerSurface });
    });
    p.on('button', (serial, time, button, state) => {
      this.lastSerial = serial;
      const num = BUTTON_NUMBER[button] ?? 0;
      const bit = BUTTON_MASK[num] ?? 0;
      // the state mask carries the buttons held *before* this event, as X does
      const buttonsBefore = this.buttonMask;
      if (state === PRESSED) {
        this.lastPressSerial = serial;
        this.buttonMask |= bit;
      } else {
        this.buttonMask &= ~bit;
      }
      this._queue({
        type: state === PRESSED ? 'buttonpress' : 'buttonrelease',
        serial,
        time,
        button: num,
        evdev: button,
        x: this.pointerX,
        y: this.pointerY,
        surface: this.pointerSurface,
        state: buttonsBefore,
      });
    });
    // Scrolling, three ways. `axis` is continuous distance; `axis_discrete`
    // (v5-7) and `axis_value120` (v8) are wheel notches, which is what a
    // list expects to page by. Whichever arrives is folded into one wheel
    // event per frame with both a notch count and a smooth delta.
    p.on('axis', (time, axis, value) => {
      const a = (this._axis ??= {
        time,
        dx: 0,
        dy: 0,
        nx: 0,
        ny: 0,
        discrete: false,
        source: null,
      });
      a.time = time;
      if (axis === 0) a.dy += value;
      else a.dx += value;
    });
    p.on('axis_source', (source) => {
      const a = (this._axis ??= {
        dx: 0,
        dy: 0,
        nx: 0,
        ny: 0,
        discrete: false,
        source: null,
      });
      a.source = source; // 0 wheel, 1 finger, 2 continuous, 3 wheel_tilt
    });
    p.on('axis_discrete', (axis, steps) => {
      const a = (this._axis ??= {
        dx: 0,
        dy: 0,
        nx: 0,
        ny: 0,
        discrete: false,
        source: null,
      });
      a.discrete = true;
      if (axis === 0) a.ny += steps;
      else a.nx += steps;
    });
    p.on('axis_value120', (axis, v120) => {
      const a = (this._axis ??= {
        dx: 0,
        dy: 0,
        nx: 0,
        ny: 0,
        discrete: false,
        source: null,
      });
      a.discrete = true;
      if (axis === 0) a.ny += v120 / 120;
      else a.nx += v120 / 120;
    });
    p.on('axis_stop', () => {});
    p.on('axis_relative_direction', () => {});
    p.on('frame', () => this._flush());
  }

  _queue(ev) {
    (this._pending ??= []).push(ev);
    // Compositors before v5 send no frame; flush on the microtask so a real
    // frame still coalesces everything dispatched from one socket read.
    queueMicrotask(() => this._flush());
  }

  _flush() {
    const axis = this._axis;
    if (axis) {
      this._axis = null;
      const smooth = axis.source === 1 || axis.source === 2; // finger/continuous
      const ny = axis.discrete ? axis.ny : axis.dy / NOTCH;
      const nx = axis.discrete ? axis.nx : axis.dx / NOTCH;
      (this._pending ??= []).push({
        type: 'wheel',
        time: axis.time,
        deltaX: nx,
        deltaY: ny,
        pixelsX: axis.dx,
        pixelsY: axis.dy,
        smooth,
        x: this.pointerX,
        y: this.pointerY,
        surface: this.pointerSurface,
      });
    }
    const batch = this._pending;
    if (!batch || batch.length === 0) return;
    this._pending = null;
    for (const ev of batch) this.emit(ev.type, ev);
    this.emit('frame', batch);
  }

  /**
   * Set the pointer image, by CSS/X cursor name. Takes effect over the
   * surface the pointer is in, now and on every later `enter`.
   */
  setCursor(name) {
    this._cursor = name ?? 'default';
    if (this.pointerSurface != null) this._applyCursor(this.lastSerial);
  }

  _applyCursor(serial) {
    if (!this.pointer) return;
    const name = this._cursor;
    if (name === 'none') {
      this.pointer.$.set_cursor(serial, 0, 0, 0);
      return;
    }
    if (this._cursorDevice) {
      const shape = CURSOR_SHAPES[name] ?? CURSOR_SHAPES.default;
      this._cursorDevice.$.set_shape(serial, shape);
    }
    // Without cursor-shape there is no way to name a cursor; a themed image
    // buffer would have to be loaded and attached, which is not done here.
  }

  // ---- keyboard ---------------------------------------------------------

  _addKeyboard() {
    const k = this.seat.$.get_keyboard();
    this.keyboard = k;

    k.on('keymap', (format, fd, size) => {
      // THE fd receive. Everything about this backend's transport exists so
      // that this number is a real descriptor rather than -1.
      if (typeof fd !== 'number' || fd < 0) {
        this.emit(
          'error',
          new Error(
            'the compositor sent a keymap but no descriptor arrived with it',
          ),
        );
        return;
      }
      try {
        const buf = Buffer.allocUnsafe(size);
        let read = 0;
        while (read < size) {
          const n = fs.readSync(fd, buf, read, size - read, read);
          if (n <= 0) break;
          read += n;
        }
        const text =
          format === 1
            ? buf.toString('utf8', 0, read).replace(/\0+$/, '')
            : null;
        this.keymap = { format, size, text };
        this.xkb = text ? XkbKeymap.parse(text) : null;
        this.emit('keymap', this.keymap, this.xkb);
      } catch (err) {
        this.emit(
          'error',
          new Error(`could not read the keymap: ${err.message}`, {
            cause: err,
          }),
        );
      } finally {
        // The descriptor is ours once taken, and nothing else will close it.
        try {
          fs.closeSync(fd);
        } catch {
          /* already gone */
        }
      }
    });

    k.on('enter', (serial, surfaceId, keys) => {
      this.lastSerial = serial;
      this.focus = surfaceId;
      this.emit('focus', {
        serial,
        surface: surfaceId,
        keys: decodeKeys(keys),
      });
    });
    k.on('leave', (serial, surfaceId) => {
      this.lastSerial = serial;
      this._stopRepeat();
      if (this.focus === surfaceId) this.focus = null;
      this.emit('blur', { serial, surface: surfaceId });
    });
    k.on('modifiers', (serial, depressed, latched, locked, group) => {
      this.lastSerial = serial;
      this.mods = (depressed | latched | locked) & 0xff;
      this.group = group;
      this.emit('modifiers', {
        mods: this.mods,
        depressed,
        latched,
        locked,
        group,
      });
    });
    k.on('key', (serial, time, key, state) => {
      this.lastSerial = serial;
      const keycode = key + EVDEV_KEYCODE_OFFSET;
      if (state === PRESSED) {
        this.lastPressSerial = serial;
        const ev = this._keyEvent('keydown', keycode, time, serial);
        this.emit('keydown', ev);
        this._startRepeat(keycode, time);
      } else {
        if (this._repeatKey === keycode) this._stopRepeat();
        this.emit('keyup', this._keyEvent('keyup', keycode, time, serial));
      }
    });
    k.on('repeat_info', (rate, delay) => {
      this.repeat = { rate, delay };
      this.emit('repeat_info', this.repeat);
    });
  }

  /** A key event in the shape events.js reads, decoded against the keymap. */
  _keyEvent(type, keycode, time, serial, repeat = false) {
    const state = XkbKeymap.stateOf(this.mods, this.group);
    const decoded = this.xkb?.decode(keycode, this.mods, this.group);
    return {
      type,
      keycode,
      keysym: decoded?.keysym ?? 0,
      baseKeysym: decoded?.baseKeysym ?? 0,
      codepoint: decoded?.codepoint,
      buttons: state | this.buttonMask,
      group: this.group,
      time,
      serial,
      repeat,
      surface: this.focus,
    };
  }

  /**
   * Key repeat, which the compositor does not do for us. X servers
   * auto-repeat and every text control here is written against that, so
   * repeated presses are synthesised at the seat's advertised rate.
   * Modifier keys do not repeat, and losing focus stops everything.
   */
  _startRepeat(keycode, time) {
    this._stopRepeat();
    if (!(this.repeat.rate > 0)) return;
    const sym = this.xkb?.decode(keycode, this.mods, this.group)?.keysym ?? 0;
    if (isModifierKeysym(sym)) return;
    this._repeatKey = keycode;
    const interval = 1000 / this.repeat.rate;
    let t = time;
    this._repeatTimer = setTimeout(() => {
      const tick = () => {
        if (this._repeatKey !== keycode) return;
        t += interval;
        this.emit(
          'keydown',
          this._keyEvent(
            'keydown',
            keycode,
            Math.round(t),
            this.lastSerial,
            true,
          ),
        );
        this._repeatTimer = setTimeout(tick, interval);
      };
      tick();
    }, this.repeat.delay);
    this._repeatTimer.unref?.();
  }

  _stopRepeat() {
    if (this._repeatTimer) clearTimeout(this._repeatTimer);
    this._repeatTimer = null;
    this._repeatKey = null;
  }

  destroy() {
    this._stopRepeat();
    this.removeAllListeners();
  }
}

/** Shift, Control, Alt, Super, Caps/Num Lock, ISO_Level3: 0xffe1..0xffee and 0xfe03. */
function isModifierKeysym(sym) {
  return (sym >= 0xffe1 && sym <= 0xffee) || sym === 0xfe03 || sym === 0xfe11;
}

/** `wl_keyboard.enter`'s pressed-key array is a wl_array of uint32. */
function decodeKeys(keys) {
  const out = [];
  if (!keys) return out;
  const bytes = keys instanceof Uint8Array ? keys : new Uint8Array(keys);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 4 <= bytes.byteLength; i += 4)
    out.push(view.getUint32(i, true) + EVDEV_KEYCODE_OFFSET);
  return out;
}
