// Touch: `wl_touch`, the seat's third capability.
//
// A touchscreen speaks in *points*. `down` names a surface and gives the
// point an id, `motion` and `up` refer to the id, and `frame` closes a group
// of events that happened together — two fingers landing at once are two
// `down`s and one `frame`. Nothing about a point is a button, there is no
// cursor, and `cancel` means the compositor took the gesture for itself
// (a three-finger swipe to the overview) and the client is to forget every
// point it had.
//
// Two things come out of this file, kept deliberately apart:
//
// - **Pointer emulation.** Every control in the tree is written against
//   `mousedown`/`mousemove`/`mouseup`, and a finger has to work on all of
//   them without each learning about touch. So the first point of a gesture
//   *becomes the pointer*, the way XI2's pointer emulation makes it the core
//   pointer on X: its `down` is an `enter` and a button-1 press carrying the
//   down's serial (which is what `xdg_toplevel.move` needs when the finger
//   lands on the titlebar), its `motion` is pointer motion, its `up` — or a
//   `cancel` — a release and a `leave`. A second finger while the first is
//   down emulates nothing, so a two-finger gesture never turns into a
//   second click. The emulated events are the seat's own pointer events,
//   shaped identically and routed by `input.js` through exactly the same
//   path — frame hit-testing, popup grabs, cursor hover and all — with
//   `pointerType: 'touch'` and the `touchId` on them, so a handler that
//   cares can tell a finger from a mouse and nothing else has to.
// - **Raw touch events.** `touchstart`/`touchmove`/`touchend`/`touchcancel`
//   — ntk's names for XI2's TouchBegin/Update/End, with its `touchId` — for
//   every point, each carrying the list of active `touches`, so a gesture
//   that wants more than one finger can be built from them. They ride the
//   same batch as the emulated events and are flushed at `frame`.
//
// Coordinates stay surface-local and logical here, as the pointer's are;
// `input.js` owns the conversion to content-relative device pixels.

import { SEAT_CAP, BUTTON_MASK } from './seat.js';

/** evdev's code for a touch contact, filling the slot a pointer button has. */
export const BTN_TOUCH = 0x14a;

const BUTTON1 = BUTTON_MASK[1];

export class WaylandTouch {
  /**
   * Attach to a seat: `get_touch` now if the capability is already there
   * (the first `capabilities` event arrived during `WaylandSeat.bind`), and
   * follow it as touchscreens come and go.
   *
   * @param {import('./seat.js').WaylandSeat} seat
   */
  static attach(seat) {
    const touch = new WaylandTouch(seat);
    seat.touch = touch;
    touch._sync(seat.capabilities);
    seat.on('capabilities', touch._onCapabilities);
    return touch;
  }

  constructor(seat) {
    this.seat = seat;
    /** the `wl_touch`, or null while the seat has no touch capability */
    this.touch = null;
    /**
     * Active points by id: `{ id, serial, time, surface, x, y, major, minor,
     * orientation }`, surface-local logical.
     */
    this.points = new Map();
    /** the id of the point standing in for the pointer, or null */
    this.emulated = null;
    this._batch = [];
    this._onCapabilities = (caps) => this._sync(caps);
  }

  _sync(caps) {
    if (caps & SEAT_CAP.TOUCH) this._acquire();
    else this._release();
  }

  _acquire() {
    if (this.touch) return;
    const t = this.seat.seat.$.get_touch();
    this.touch = t;

    t.on('down', (serial, time, surfaceId, id, x, y) => {
      const seat = this.seat;
      seat.lastSerial = serial;
      seat.lastPressSerial = serial;
      const pt = {
        id,
        serial,
        time,
        surface: surfaceId,
        x,
        y,
        major: 0,
        minor: 0,
        orientation: 0,
      };
      this.points.set(id, pt);
      this._raw('touchstart', pt, serial);
      if (this.emulated == null) {
        this.emulated = id;
        this._batch.push({
          type: 'enter',
          serial,
          surface: surfaceId,
          x,
          y,
          device: this._device(pt, true),
        });
        const before = seat.buttonMask;
        seat.buttonMask |= BUTTON1;
        this._batch.push(this._button('buttonpress', pt, serial, before, true));
      }
    });
    t.on('motion', (time, id, x, y) => {
      const pt = this.points.get(id);
      if (!pt) return;
      pt.x = x;
      pt.y = y;
      pt.time = time;
      this._raw('touchmove', pt, this.seat.lastSerial);
      if (this.emulated === id) {
        this._batch.push({
          type: 'motion',
          time,
          x,
          y,
          surface: pt.surface,
          device: this._device(pt, true),
        });
      }
    });
    t.on('up', (serial, time, id) => {
      const pt = this.points.get(id);
      if (!pt) return;
      this.seat.lastSerial = serial;
      pt.time = time;
      this.points.delete(id);
      this._raw('touchend', pt, serial);
      if (this.emulated === id) this._endEmulation(pt, serial);
    });
    t.on('cancel', () => {
      // Every point is gone at once, and no frame need follow: finalise
      // them here, the emulated one with its release.
      const gone = [...this.points.values()];
      this.points.clear();
      const serial = this.seat.lastSerial;
      for (const pt of gone) {
        this._raw('touchcancel', pt, serial);
        if (this.emulated === pt.id) this._endEmulation(pt, serial);
      }
      this._flush();
    });
    // The contact's shape (v6): an ellipse, in surface-local units. It can
    // arrive after the point's own event within the frame, so a raw event
    // still waiting in the batch is brought up to date too.
    t.on('shape', (id, major, minor) => {
      const pt = this.points.get(id);
      if (!pt) return;
      pt.major = major;
      pt.minor = minor;
      for (const ev of this._batch) {
        if (ev.touchId === id) {
          ev.radiusX = major / 2;
          ev.radiusY = minor / 2;
        }
      }
    });
    t.on('orientation', (id, orientation) => {
      const pt = this.points.get(id);
      if (!pt) return;
      pt.orientation = orientation;
      for (const ev of this._batch)
        if (ev.touchId === id) ev.rotationAngle = orientation;
    });
    t.on('frame', () => this._flush());
  }

  /** The touchscreen went away: whatever was down is cancelled. */
  _release() {
    const t = this.touch;
    if (!t) return;
    this.touch = null;
    t.emit('cancel');
    t.removeAllListeners();
    // `release` is v3; a compositor older than that just sees us stop asking
    t.$.release?.();
  }

  /**
   * A raw event for the point, with a snapshot of every active point and
   * — as a button event carries it — the buttons held *before* it, so a
   * touchstart does not yet show the press it is about to emulate.
   */
  _raw(type, pt, serial) {
    this._batch.push({
      type,
      id: pt.id,
      touchId: pt.id,
      serial,
      time: pt.time,
      surface: pt.surface,
      x: pt.x,
      y: pt.y,
      state: this.seat.buttonMask,
      radiusX: pt.major / 2,
      radiusY: pt.minor / 2,
      rotationAngle: pt.orientation,
      touches: [...this.points.values()].map((p) => ({
        id: p.id,
        surface: p.surface,
        x: p.x,
        y: p.y,
      })),
    });
  }

  /** The device tag the emulated events carry. */
  _device(pt, down) {
    // the DOM's answer for hardware without pressure: half while in contact
    return { pointerType: 'touch', touchId: pt.id, pressure: down ? 0.5 : 0 };
  }

  _button(type, pt, serial, state, down) {
    return {
      type,
      serial,
      time: pt.time,
      button: 1,
      evdev: BTN_TOUCH,
      x: pt.x,
      y: pt.y,
      surface: pt.surface,
      state,
      device: this._device(pt, down),
    };
  }

  /**
   * The emulating finger lifted: release, leave — and if a real pointer is
   * over one of our surfaces, it is the pointer again, so `input.js` gets
   * its enter back and its window-under-the-pointer is right.
   */
  _endEmulation(pt, serial) {
    const seat = this.seat;
    this.emulated = null;
    const before = seat.buttonMask;
    seat.buttonMask &= ~BUTTON1;
    this._batch.push(this._button('buttonrelease', pt, serial, before, false));
    this._batch.push({
      type: 'leave',
      serial,
      surface: pt.surface,
      device: this._device(pt, false),
    });
    if (seat.pointerSurface != null) {
      this._batch.push({
        type: 'enter',
        serial,
        surface: seat.pointerSurface,
        x: seat.pointerX,
        y: seat.pointerY,
      });
    }
  }

  _flush() {
    const batch = this._batch;
    if (batch.length === 0) return;
    this._batch = [];
    for (const ev of batch) this.seat.emit(ev.type, ev);
    this.seat.emit('frame', batch);
  }

  destroy() {
    this.seat.off('capabilities', this._onCapabilities);
    this.points.clear();
    this._batch.length = 0;
    const t = this.touch;
    this.touch = null;
    t?.removeAllListeners();
  }
}
