// Graphics tablets: `zwp_tablet_manager_v2`, the seat's tablet seat, and
// its tools.
//
// A pen is not a pointer to Wayland, and almost exactly one to react-x11.
// The protocol gives every `wl_seat` a *tablet seat* that announces
// tablets, tools and pads as objects of their own. A tool has a type (pen,
// eraser, airbrush, the puck the protocol calls a "mouse"), the set of axes
// it can report, and a life of its own: `proximity_in` names the surface it
// is over, `motion`/`pressure`/`tilt`/... describe the frame, `down`/`up`
// say whether it touches the tablet, `button` is a barrel button, and
// `frame(time)` closes the group. As with `wl_pointer`, the client owns the
// cursor while the tool is over its surface — through cursor-shape's
// tablet-tool device, with the same shape names the pointer uses.
//
// What this does with it is emulate the pointer, the way X does: on X11 a
// tablet is an XI2 slave of the master pointer and every control in the
// tree sees a pen as presses and motion with no idea a pen was involved. So
// proximity is an `enter`, `down`/`up` are button 1 carrying the down's
// serial (what `xdg_toplevel.move` wants when the pen lands on the
// titlebar), the barrel buttons are 3 and 2 — BTN_STYLUS and BTN_STYLUS2,
// the desktop's own mapping — a puck's buttons are themselves, and
// `proximity_out` releases anything still held before it leaves. The
// emulated events are the seat's own pointer events and take the same
// route through `input.js`; the axes ride along on them in the DOM's names
// and ranges — `pointerType`, `pressure`, `tiltX`/`tiltY`, `rotation`,
// `distance`, `tangentialPressure` — on these events only, so a mouse event
// is unchanged and the X11 backend never sees a field it did not send.
//
// Everything a frame reports is accumulated and emitted at `frame`, in the
// order a pointer would have produced it: enter, motion, presses, releases,
// leave. Pads (the buttons, rings and strips on the tablet itself) are
// accepted and left alone: the tree has no vocabulary for them.

import { BUTTON_NUMBER, BUTTON_MASK, CURSOR_SHAPES, PRESSED } from './seat.js';
import { BTN_TOUCH } from './touch.js';

/** `zwp_tablet_tool_v2.type`. */
export const TOOL_TYPE = {
  PEN: 0x140,
  ERASER: 0x141,
  BRUSH: 0x142,
  PENCIL: 0x143,
  AIRBRUSH: 0x144,
  FINGER: 0x145,
  MOUSE: 0x146,
  LENS: 0x147,
};

const TOOL_NAME = {
  [TOOL_TYPE.PEN]: 'pen',
  [TOOL_TYPE.ERASER]: 'eraser',
  [TOOL_TYPE.BRUSH]: 'brush',
  [TOOL_TYPE.PENCIL]: 'pencil',
  [TOOL_TYPE.AIRBRUSH]: 'airbrush',
  [TOOL_TYPE.FINGER]: 'finger',
  [TOOL_TYPE.MOUSE]: 'mouse',
  [TOOL_TYPE.LENS]: 'lens',
};

/** The DOM `pointerType` a tool type stands for. */
const POINTER_TYPE = {
  pen: 'pen',
  eraser: 'eraser',
  brush: 'pen',
  pencil: 'pen',
  airbrush: 'pen',
  finger: 'touch',
  mouse: 'mouse',
  lens: 'mouse',
};

/** `zwp_tablet_tool_v2.capability`. */
export const TOOL_CAP = {
  TILT: 1,
  PRESSURE: 2,
  DISTANCE: 3,
  ROTATION: 4,
  SLIDER: 5,
  WHEEL: 6,
};

const CAP_NAME = {
  [TOOL_CAP.TILT]: 'tilt',
  [TOOL_CAP.PRESSURE]: 'pressure',
  [TOOL_CAP.DISTANCE]: 'distance',
  [TOOL_CAP.ROTATION]: 'rotation',
  [TOOL_CAP.SLIDER]: 'slider',
  [TOOL_CAP.WHEEL]: 'wheel',
};

/** The stylus buttons, as evdev numbers them. */
export const BTN_STYLUS = 0x14b;
export const BTN_STYLUS2 = 0x14c;
export const BTN_STYLUS3 = 0x149;

/**
 * Tool button -> the button number the tree speaks: the barrel buttons as
 * the desktop maps them (side button is a right click, the second a middle
 * click, a third the "back" button), a puck's as themselves.
 */
const TOOL_BUTTON_NUMBER = {
  ...BUTTON_NUMBER,
  [BTN_STYLUS]: 3,
  [BTN_STYLUS2]: 2,
  [BTN_STYLUS3]: 8,
};

/** pressure, distance and the slider are normalised to this by the protocol */
const AXIS_MAX = 65535;

export class WaylandTablet {
  /**
   * Bind the manager and open the seat's tablet seat, or answer null where
   * the compositor has no tablet protocol — which is a missing capability,
   * not an error.
   *
   * @param {import('./connection.js').WaylandConnection} conn
   * @param {import('./seat.js').WaylandSeat} seat
   */
  static async bind(conn, seat) {
    const manager = await conn.bind('zwp_tablet_manager_v2');
    if (!manager) return null;
    const tablet = new WaylandTablet(seat, manager);
    seat.tablet = tablet;
    return tablet;
  }

  constructor(seat, manager) {
    this.seat = seat;
    this.manager = manager;
    this.tabletSeat = manager.$.get_tablet_seat(seat.seat.id);
    /** tablets by proxy id: `{ id, name, vid, pid, path, bustype }` */
    this.tablets = new Map();
    /** tools by proxy id, once their description is complete */
    this.tools = new Map();
    this._pads = new Set();
    // the seat's cursor is the cursor of every pointing device: a tool in
    // proximity follows what the tree (or the frame) last asked for
    this._onCursor = (name) => {
      for (const tool of this.tools.values()) tool.applyCursor(name);
    };
    seat.on('cursor', this._onCursor);
    this._wire();
  }

  _wire() {
    const ts = this.tabletSeat;
    ts.on('tablet_added', (proxy) => {
      const info = {
        id: proxy.id,
        name: null,
        vid: 0,
        pid: 0,
        path: null,
        bustype: null,
      };
      proxy.on('name', (name) => (info.name = name));
      proxy.on('id', (vid, pid) => Object.assign(info, { vid, pid }));
      proxy.on('path', (path) => (info.path = path));
      proxy.on('bustype', (bustype) => (info.bustype = bustype));
      proxy.on('done', () => {
        this.tablets.set(proxy.id, info);
        this.seat.emit('tabletadded', info);
      });
      proxy.on('removed', () => {
        this.tablets.delete(proxy.id);
        proxy.$.destroy();
        this.seat.emit('tabletremoved', info);
      });
    });
    ts.on('tool_added', (proxy) => new TabletTool(this, proxy));
    ts.on('pad_added', (proxy) => {
      this._pads.add(proxy);
      proxy.on('removed', () => {
        this._pads.delete(proxy);
        proxy.$.destroy();
      });
    });
  }

  destroy() {
    this.seat.off('cursor', this._onCursor);
    for (const tool of [...this.tools.values()]) tool._destroy();
    this.tools.clear();
    this.tablets.clear();
    this._pads.clear();
    this.tabletSeat.removeAllListeners();
    try {
      this.tabletSeat.$.destroy();
    } catch {
      /* the connection is going */
    }
  }
}

/**
 * One tool, from `tool_added` to `removed`. Its description (`type`,
 * `capability`, the hardware ids) arrives first and is complete at `done`;
 * only then is it listed on the tablet seat and announced as `tooladded`.
 */
export class TabletTool {
  constructor(tablet, proxy) {
    this.tablet = tablet;
    this.seat = tablet.seat;
    this.proxy = proxy;
    this.id = proxy.id;
    this.type = TOOL_TYPE.PEN;
    /** 'pen' | 'eraser' | 'brush' | 'pencil' | 'airbrush' | 'finger' | 'mouse' | 'lens' */
    this.typeName = 'pen';
    /** the DOM `pointerType` the emulated events carry */
    this.pointerType = 'pen';
    /** axis names the tool reports: 'pressure', 'tilt', ... */
    this.capabilities = new Set();
    this.hardwareSerial = null;
    this.wacomId = null;
    /** the `wl_surface` id the tool is over, or null when out of proximity */
    this.surface = null;
    this.tabletId = null;
    /** the `proximity_in` serial — what `set_cursor` for this tool needs */
    this.proximitySerial = 0;
    this.x = 0;
    this.y = 0;
    this.pressure = 0;
    this.distance = 0;
    this.tiltX = 0;
    this.tiltY = 0;
    this.rotation = 0;
    this.slider = 0;
    /** the tool touches the tablet */
    this.down = false;
    /** buttons held, in press order: `{ num, evdev }` */
    this.held = [];
    this.cursorDevice = this.seat._cursorShapes
      ? this.seat._cursorShapes.$.get_tablet_tool_v2(proxy.id)
      : null;
    this._frame = null;
    this._wire();
  }

  _wire() {
    const p = this.proxy;
    p.on('type', (type) => {
      this.type = type;
      this.typeName = TOOL_NAME[type] ?? 'pen';
      this.pointerType = POINTER_TYPE[this.typeName] ?? 'pen';
    });
    p.on('hardware_serial', (hi, lo) => (this.hardwareSerial = hex64(hi, lo)));
    p.on('hardware_id_wacom', (hi, lo) => (this.wacomId = hex64(hi, lo)));
    p.on('capability', (cap) => this.capabilities.add(CAP_NAME[cap] ?? cap));
    p.on('done', () => {
      this.tablet.tools.set(this.id, this);
      this.seat.emit('tooladded', this);
    });
    p.on('removed', () => this._remove());

    // The frame's events, accumulated; `frame` turns them into pointer events.
    p.on('proximity_in', (serial, tabletId, surfaceId) => {
      const f = this._open();
      f.proximityIn = serial;
      f.tablet = tabletId;
      f.surface = surfaceId;
    });
    p.on('proximity_out', () => (this._open().proximityOut = true));
    p.on('down', (serial) => (this._open().down = serial));
    p.on('up', () => (this._open().up = true));
    p.on('motion', (x, y) => {
      this.x = x;
      this.y = y;
      this._open().moved = true;
    });
    p.on('pressure', (v) => this._axis('pressure', v / AXIS_MAX));
    p.on('distance', (v) => this._axis('distance', v / AXIS_MAX));
    p.on('tilt', (tx, ty) => {
      this._axis('tiltX', tx);
      this._axis('tiltY', ty);
    });
    p.on('rotation', (degrees) => this._axis('rotation', degrees));
    p.on('slider', (position) => this._axis('slider', position / AXIS_MAX));
    p.on('wheel', (degrees, clicks) => {
      const f = this._open();
      f.wheel = {
        degrees: (f.wheel?.degrees ?? 0) + degrees,
        clicks: (f.wheel?.clicks ?? 0) + clicks,
      };
    });
    p.on('button', (serial, button, state) =>
      this._open().buttons.push({ serial, button, state }),
    );
    p.on('frame', (time) => this._flush(time));
  }

  _open() {
    return (this._frame ??= {
      proximityIn: null,
      proximityOut: false,
      down: null,
      up: false,
      moved: false,
      axes: false,
      buttons: [],
      wheel: null,
    });
  }

  _axis(name, value) {
    this[name] = value;
    this._open().axes = true;
  }

  /** The axes as the emulated events carry them. */
  _device() {
    return {
      pointerType: this.pointerType,
      toolType: this.typeName,
      // the DOM's answer for a tool without a pressure axis: half while it
      // is in contact, none otherwise
      pressure: this.capabilities.has('pressure')
        ? this.pressure
        : this.held.length
          ? 0.5
          : 0,
      tiltX: this.tiltX,
      tiltY: this.tiltY,
      rotation: this.rotation,
      distance: this.distance,
      tangentialPressure: this.slider,
    };
  }

  /**
   * The frame is closed: emit what it described, as the pointer events the
   * router already routes, in the order a pointer would have sent them.
   */
  _flush(time) {
    const f = this._frame;
    this._frame = null;
    if (!f) return;
    const seat = this.seat;
    const batch = [];
    if (f.proximityIn != null) {
      seat.lastSerial = f.proximityIn;
      this.surface = f.surface;
      this.tabletId = f.tablet;
      this.proximitySerial = f.proximityIn;
      batch.push({
        type: 'enter',
        serial: f.proximityIn,
        surface: this.surface,
        x: this.x,
        y: this.y,
        device: this._device(),
      });
      this.applyCursor(seat._cursor);
    }
    // nothing to say about a tool that is not over one of our surfaces
    if (this.surface == null) return;
    if (f.moved || f.axes) {
      batch.push({
        type: 'motion',
        time,
        x: this.x,
        y: this.y,
        surface: this.surface,
        device: this._device(),
      });
    }
    if (f.down != null) {
      seat.lastSerial = f.down;
      seat.lastPressSerial = f.down;
      this.down = true;
      this._press(batch, 1, BTN_TOUCH, f.down, time);
    }
    for (const b of f.buttons) {
      seat.lastSerial = b.serial;
      const num = TOOL_BUTTON_NUMBER[b.button] ?? 0;
      if (!num) continue;
      if (b.state === PRESSED) {
        seat.lastPressSerial = b.serial;
        this._press(batch, num, b.button, b.serial, time);
      } else {
        this._release(batch, num, b.serial, time);
      }
    }
    if (f.up) {
      this.down = false;
      this._release(batch, 1, seat.lastSerial, time);
    }
    if (f.wheel) {
      batch.push({
        type: 'wheel',
        time,
        deltaX: 0,
        deltaY: f.wheel.clicks,
        pixelsX: 0,
        pixelsY: f.wheel.degrees,
        smooth: false,
        x: this.x,
        y: this.y,
        surface: this.surface,
        device: this._device(),
      });
    }
    if (f.proximityOut) this._leave(batch, time);
    this._emit(batch);
  }

  _press(batch, num, evdev, serial, time) {
    if (this.held.some((h) => h.num === num)) return;
    const seat = this.seat;
    const before = seat.buttonMask;
    seat.buttonMask |= BUTTON_MASK[num] ?? 0;
    this.held.push({ num, evdev });
    batch.push(this._button('buttonpress', num, evdev, serial, time, before));
  }

  _release(batch, num, serial, time) {
    const i = this.held.findIndex((h) => h.num === num);
    if (i < 0) return;
    const seat = this.seat;
    const before = seat.buttonMask;
    seat.buttonMask &= ~(BUTTON_MASK[num] ?? 0);
    const [{ evdev }] = this.held.splice(i, 1);
    batch.push(this._button('buttonrelease', num, evdev, serial, time, before));
  }

  _button(type, num, evdev, serial, time, state) {
    return {
      type,
      serial,
      time,
      button: num,
      evdev,
      x: this.x,
      y: this.y,
      surface: this.surface,
      state,
      device: this._device(),
    };
  }

  /**
   * Out of proximity: whatever is still held is released first, newest
   * first, then the pointer leaves — and if a real pointer is over one of
   * our surfaces it is the pointer again, so the router's
   * window-under-the-pointer is right.
   */
  _leave(batch, time) {
    const seat = this.seat;
    for (const { num } of [...this.held].reverse())
      this._release(batch, num, seat.lastSerial, time);
    this.down = false;
    batch.push({
      type: 'leave',
      serial: seat.lastSerial,
      surface: this.surface,
      device: this._device(),
    });
    this.surface = null;
    this.tabletId = null;
    this.proximitySerial = 0;
    if (seat.pointerSurface != null) {
      batch.push({
        type: 'enter',
        serial: seat.lastSerial,
        surface: seat.pointerSurface,
        x: seat.pointerX,
        y: seat.pointerY,
      });
    }
  }

  _emit(batch) {
    if (batch.length === 0) return;
    for (const ev of batch) this.seat.emit(ev.type, ev);
    this.seat.emit('frame', batch);
  }

  /**
   * The cursor over the surface the tool is in, by the same names the
   * pointer uses. Without cursor-shape there is no way to name one, as for
   * the pointer; and hiding it wants a null surface in `set_cursor`, which
   * the client library's argument check refuses today, so `'none'` keeps
   * the last shape.
   */
  applyCursor(name) {
    if (this.surface == null || !this.cursorDevice || name === 'none') return;
    const shape = CURSOR_SHAPES[name] ?? CURSOR_SHAPES.default;
    this.cursorDevice.$.set_shape(this.proximitySerial, shape);
  }

  /** The tool is gone (unplugged mid-stroke, say): finish what it held. */
  _remove() {
    if (this.surface != null) {
      const batch = [];
      this._leave(batch, this.seat.lastSerial);
      this._emit(batch);
    }
    const known = this.tablet.tools.delete(this.id);
    this._destroy();
    if (known) this.seat.emit('toolremoved', this);
  }

  _destroy() {
    this.proxy.removeAllListeners();
    try {
      this.cursorDevice?.$.destroy();
      this.proxy.$.destroy();
    } catch {
      /* the connection is going */
    }
  }
}

/** Two 32-bit halves as one hex string, which is how the ids are read. */
function hex64(hi, lo) {
  return hi
    ? hi.toString(16) + lo.toString(16).padStart(8, '0')
    : lo.toString(16);
}
