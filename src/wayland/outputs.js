// The monitors: every `wl_output` the compositor advertises, published into
// `src/screens.js` so that `useScreens()`, `availableArea()` and everything
// that sizes a window against a monitor works with no X server in the path
// — the way `src/cocoa/app.js`'s `screenLayout()` publishes `NSScreen`.
//
// What a Wayland client can and cannot know about the screen shapes all of
// it:
//
// - **Outputs are plural globals.** Each monitor is its own `wl_output` in
//   the registry, so the layout is a fold over every one of them rather
//   than one query, and hot-plug is a `global`/`global_remove` on the
//   registry — which is what connection.js's `Registry` view exists for.
// - **Position and size are logical.** `wl_output.geometry` places the
//   output in the compositor's global space and `mode` gives the panel's
//   pixels; the logical size is the mode over the scale, turned by the
//   transform — unless `zxdg_output_manager_v1` is there, whose
//   `logical_size` is exact under fractional scaling where that arithmetic
//   is not. The rects are published in the renderer's device pixels
//   (logical × `app.scale`), as cocoa converts points, so `monitorAt()` and
//   the window rects agree; `useScreens()` divides them back.
// - **There is no primary.** The protocol has no notion of one. The output
//   at the origin is the desktop's anchor on every compositor that lays
//   monitors out from (0,0), and the leftmost stands in otherwise.
// - **There is no work area.** No `_NET_WORKAREA`, no per-output strut.
//   What exists is `xdg_toplevel.configure_bounds`, sent to a window ahead
//   of its configure: the size it is recommended to fit in — its monitor
//   less the panels, on GNOME. So a window's bounds become the usable rect
//   (`visible`, which `usable()` prefers) of the output the window is on,
//   positioned at the monitor's own origin because the offset is
//   unknowable and, on a backend where a client cannot place a window,
//   irrelevant. Every monitor carries a `visible` — its whole rect until a
//   window on it says otherwise — so that no head is ever clamped per axis
//   by another's work area (the `_NET_WORKAREA` compromise, issue #453). A
//   window that has bounds but no output yet — the bounds arrive before the
//   first buffer, the output after — is put on the smallest monitor its
//   bounds fit, which is the monitor they describe on any desk whose
//   monitors differ. The primary's usable rect is the desktop's `workArea`.
// - **A surface learns its output by being told.** `wl_surface.enter` and
//   `leave` name the outputs a surface overlaps. That is how `win.output`
//   knows, and where a compositor with neither fractional-scale-v1 nor
//   `wl_surface.preferred_buffer_scale` gets a window's buffer scale from.
//
// Published through `setScreensForTests`, as the cocoa backend does: it is
// the one seam `screens.js` has for a layout that did not come from X, and
// using it leaves the X11 path untouched.

import { EventEmitter } from 'node:events';
import { setScreensForTests } from '../screens.js';
import { monitorScalesOf } from '../scale.js';

/** `wl_output.mode` flags. */
const MODE_CURRENT = 0x1;

/** fractional-scale-v1's granularity; a mode-over-logical ratio snaps to it. */
const SCALE_DENOM = 120;

/** `wl_output.transform` → degrees. The flipped four are ignored as
 *  reflections, the way `screens.js` ignores RandR's reflection bits. */
export function degreesOf(transform) {
  return (transform & 3) * 90;
}

/**
 * Hz from `wl_output.mode`'s millihertz, to two decimals, or null where
 * the compositor did not say: a virtual output reports 0, and anything
 * outside the range a panel can refresh at is the same "unknown" in other
 * clothes (`screens.js`'s `refreshRateOf` draws the line in the same place).
 */
export function refreshHz(millihertz) {
  if (!(millihertz > 0)) return null;
  const hz = millihertz / 1000;
  if (hz < 20 || hz > 1000) return null;
  return Math.round(hz * 100) / 100;
}

/** The current mode's pixels with a quarter turn applied. */
function turnedMode(rec) {
  const mode = rec.mode;
  if (!mode) return null;
  return rec.transform & 1
    ? { width: mode.height, height: mode.width }
    : { width: mode.width, height: mode.height };
}

/**
 * The output's rect in logical pixels: xdg_output's where there is one,
 * else geometry's position and the mode over the integer scale.
 */
export function logicalRectOf(rec) {
  const at = rec.logicalPosition ?? { x: rec.x, y: rec.y };
  if (rec.logicalSize?.width > 0 && rec.logicalSize?.height > 0)
    return { ...at, ...rec.logicalSize };
  const mode = turnedMode(rec);
  if (!mode) return null;
  const s = rec.scale > 0 ? rec.scale : 1;
  return {
    ...at,
    width: Math.max(1, Math.round(mode.width / s)),
    height: Math.max(1, Math.round(mode.height / s)),
  };
}

/**
 * Device pixels per logical pixel on this output. `wl_output.scale` is an
 * integer and rounds a fractional desktop up (150% reports 2); the mode
 * against xdg_output's logical size is the fraction itself, snapped to the
 * 1/120 fractional-scale-v1 speaks in so it compares equal to what a
 * surface is told.
 */
export function effectiveScaleOf(rec) {
  const mode = turnedMode(rec);
  const logical = rec.logicalSize;
  if (mode?.width > 0 && logical?.width > 0) {
    const ratio = mode.width / logical.width;
    if (ratio > 0) return Math.round(ratio * SCALE_DENOM) / SCALE_DENOM;
  }
  return rec.scale > 0 ? rec.scale : 1;
}

/**
 * One output as a `screens.js` monitor record, at the app's scale. Pure,
 * and exported for that reason: the layout arithmetic is the part worth
 * pinning without a compositor.
 *
 * `rec` is what the tracker keeps per output: `x`, `y`, `physicalWidth`,
 * `physicalHeight`, `make`, `model`, `transform` from `geometry`; `mode`
 * `{ width, height, refresh }`; `scale`; `name`/`description` (wl_output
 * v4, or xdg_output's `xdgName`/`xdgDescription`); `logicalPosition` and
 * `logicalSize` from xdg_output.
 */
export function monitorOf(rec, scale = 1) {
  const logical = logicalRectOf(rec);
  if (!logical) return null;
  const px = (v) => Math.round(v * scale);
  const name = rec.name ?? rec.xdgName ?? null;
  return {
    name,
    outputs: name ? [name] : [],
    description: rec.description ?? rec.xdgDescription ?? null,
    x: px(logical.x),
    y: px(logical.y),
    width: Math.max(1, px(logical.width)),
    height: Math.max(1, px(logical.height)),
    primary: false,
    widthMM: rec.physicalWidth > 0 ? rec.physicalWidth : null,
    heightMM: rec.physicalHeight > 0 ? rec.physicalHeight : null,
    refreshRate: refreshHz(rec.mode?.refresh),
    rotation: degreesOf(rec.transform),
    scale: effectiveScaleOf(rec),
    make: rec.make || null,
    model: rec.model || null,
  };
}

/** `bounds` (logical) as a usable rect on `m` (device pixels), at its origin. */
function usableOf(m, bounds, scale) {
  return {
    x: m.x,
    y: m.y,
    width: Math.min(m.width, Math.max(1, Math.round(bounds.width * scale))),
    height: Math.min(m.height, Math.max(1, Math.round(bounds.height * scale))),
  };
}

/**
 * The monitor a window with these bounds and no output yet is on: the
 * smallest that fits them — `configure_bounds` is a monitor less its
 * panels, so it fits its own and any larger one — the primary on a tie.
 */
function bestFit(list, bounds, scale) {
  const w = Math.round(bounds.width * scale);
  const h = Math.round(bounds.height * scale);
  let best = null;
  for (const m of list) {
    if (m.width < w || m.height < h) continue;
    const area = m.width * m.height;
    const bestArea = best ? best.width * best.height : Infinity;
    if (area < bestArea || (area === bestArea && m.primary)) best = m;
  }
  return best;
}

/**
 * Sort, pick a primary, and fold the windows' bounds in — everything the
 * layout is beyond one monitor at a time. `bounds` is a list of
 * `{ outputs: Set<id>, bounds: { width, height } }`, most recent last.
 */
export function layoutOf(monitors, { scale = 1, bounds = [] } = {}) {
  // Left to right, then top to bottom — the order the desktop is laid out
  // in, not the order the registry announced them, which is neither.
  const list = [...monitors].sort((a, b) => a.x - b.x || a.y - b.y);
  const primary = list.find((m) => m.x === 0 && m.y === 0) ?? list[0] ?? null;
  for (const m of list) {
    m.primary = m === primary;
    // Its own rect until a window on it says otherwise. Set on every
    // monitor, so `usable()` takes each as the exact rect it is and never
    // falls back to clamping a wider second head by the primary's.
    m.visible = { x: m.x, y: m.y, width: m.width, height: m.height };
  }
  for (const b of bounds) {
    if (!b.bounds) continue;
    let targets = list.filter((m) => b.outputs.has(m.id));
    if (!targets.length) {
      const fit = bestFit(list, b.bounds, scale);
      targets = fit ? [fit] : [];
    }
    for (const m of targets) m.visible = usableOf(m, b.bounds, scale);
  }
  return {
    monitors: list,
    workArea: primary ? { ...primary.visible } : null,
  };
}

/** What `app.outputs` is. */
export class WaylandOutputs extends EventEmitter {
  constructor(conn, app) {
    super();
    this.setMaxListeners(0);
    this.conn = conn;
    this.app = app;
    /** registry name -> record */
    this.byName = new Map();
    /** wl_output proxy id -> record */
    this.byId = new Map();
    this.registry = null;
    /** `zxdg_output_manager_v1`, or null on a compositor without it */
    this.manager = null;
    /** the shell windows (WaylandWindow) whose outputs and bounds count */
    this._watched = new Map();
    this._seq = 0;
    this._monitors = [];
    this._scheduled = false;
    this._publishedKey = null;
    this._lastScale = null;
    this.destroyed = false;
  }

  /**
   * Bind every output and publish the first layout. Two round trips — one
   * for the registry's list, one for the outputs' state — which is the
   * X11 backend's Xinerama tier in cost, and like it awaited by the app.
   *
   * The app assigns `app.outputs` *before* calling this: the first publish
   * asks `app.noteScale()` to seed the scale from the outputs, and it reads
   * them through that property.
   */
  async open() {
    this.manager = await this.conn.bind('zxdg_output_manager_v1');
    this.registry = await this.conn.registry();
    for (const g of this.registry.of('wl_output')) this._add(g.name);
    this._onGlobal = (name, iface) => {
      if (iface === 'wl_output') this._add(name);
    };
    this._onGlobalRemove = (name) => this._remove(name);
    this.registry.on('global', this._onGlobal);
    this.registry.on('global_remove', this._onGlobalRemove);
    // The app's factor multiplies every published rect, so it moving —
    // the first window hearing a fractional scale — is a relayout.
    this._onScale = () => {
      if (this.app.scale !== this._lastScale) this._schedule();
    };
    this.app.on?.('scale', this._onScale);
    // Every output's `done` has scheduled a publish by the time this is
    // back; the explicit one is for a v1 output, which has no `done`.
    await this.conn.roundtrip();
    this.publish();
  }

  _add(name) {
    if (this.byName.has(name)) return;
    const proxy = this.registry.bind(name, 'wl_output');
    if (!proxy) return;
    const rec = {
      global: name,
      id: proxy.id,
      proxy,
      version: proxy.version,
      xdg: null,
      x: 0,
      y: 0,
      physicalWidth: 0,
      physicalHeight: 0,
      make: '',
      model: '',
      transform: 0,
      mode: null,
      scale: 1,
      name: null,
      description: null,
      xdgName: null,
      xdgDescription: null,
      logicalPosition: null,
      logicalSize: null,
    };
    this.byName.set(name, rec);
    this.byId.set(proxy.id, rec);

    const touched = () => this._touched(rec);
    proxy.on('geometry', (x, y, pw, ph, _subpixel, make, model, transform) => {
      Object.assign(rec, {
        x,
        y,
        physicalWidth: pw,
        physicalHeight: ph,
        make,
        model,
        transform,
      });
      touched();
    });
    proxy.on('mode', (flags, width, height, refresh) => {
      // A compositor may list every mode the panel has; the current one is
      // the monitor, and failing a flag the last one listed.
      const current = (flags & MODE_CURRENT) !== 0;
      if (current || !rec.mode?.current)
        rec.mode = { width, height, refresh, current };
      touched();
    });
    proxy.on('scale', (factor) => {
      rec.scale = factor > 0 ? factor : 1;
      touched();
    });
    proxy.on('name', (n) => {
      rec.name = n || null;
      touched();
    });
    proxy.on('description', (d) => {
      rec.description = d || null;
      touched();
    });
    proxy.on('done', () => this._schedule());

    if (this.manager) {
      const xdg = this.manager.$.get_xdg_output(proxy.id);
      xdg.setMaxListeners?.(0);
      rec.xdg = xdg;
      xdg.on('logical_position', (x, y) => {
        rec.logicalPosition = { x, y };
        touched();
      });
      xdg.on('logical_size', (width, height) => {
        rec.logicalSize = { width, height };
        touched();
      });
      xdg.on('name', (n) => {
        rec.xdgName = n || null;
        touched();
      });
      xdg.on('description', (d) => {
        rec.xdgDescription = d || null;
        touched();
      });
      // The atom below manager v3; from v3 on it is wl_output.done above.
      xdg.on('done', () => this._schedule());
    }
  }

  /** State moved; `done` is the atom, except on a v1 output that has none. */
  _touched(rec) {
    if (rec.version < 2) this._schedule();
  }

  _remove(name) {
    const rec = this.byName.get(name);
    if (!rec) return;
    this.byName.delete(name);
    this.byId.delete(rec.id);
    this._release(rec);
    this._schedule();
  }

  _release(rec) {
    try {
      rec.xdg?.$.destroy();
      if (rec.version >= 3) rec.proxy.$.release();
      else this.conn.display.deleteId(rec.id);
    } catch {
      /* the connection may already be gone */
    }
  }

  /** One publish per turn, however many events a change arrived as. */
  _schedule() {
    if (this._scheduled || this.destroyed) return;
    this._scheduled = true;
    queueMicrotask(() => {
      this._scheduled = false;
      this.publish();
    });
  }

  // ---- windows ------------------------------------------------------------

  /**
   * Follow a shell window: which outputs it enters (its monitor, and the
   * buffer-scale fallback) and the bounds it is configured with (the work
   * area). Called by the backend window at creation; forgets the window
   * when it is destroyed.
   */
  watchWindow(wl) {
    if (this._watched.has(wl)) return;
    const entry = { seq: 0 };
    this._watched.set(wl, entry);
    const onOutputs = () => {
      this._applyScale(wl);
      this._schedule();
    };
    const onBounds = () => {
      entry.seq = ++this._seq;
      this._schedule();
    };
    wl.on('outputs', onOutputs);
    wl.on('bounds', onBounds);
    wl.once('destroyed', () => {
      wl.off('outputs', onOutputs);
      wl.off('bounds', onBounds);
      this._watched.delete(wl);
      this._schedule();
    });
    if (wl.bounds) entry.seq = ++this._seq;
    if (wl.outputs.size) this._applyScale(wl);
  }

  _applyScale(wl) {
    const s = this.scaleFor(wl.outputs);
    if (s) wl.noteOutputScale(s);
  }

  /** The integer scale for a surface over these outputs: the densest, as
   *  every toolkit picks it, so nothing is upsampled. 0 for none known. */
  scaleFor(ids) {
    let s = 0;
    for (const id of ids ?? []) {
      const rec = this.byId.get(id);
      if (rec) s = Math.max(s, rec.scale);
    }
    return s;
  }

  /** The monitor for a surface over these outputs (the densest), or null. */
  monitorFor(ids) {
    let best = null;
    for (const id of ids ?? []) {
      const m = this._monitors.find((mon) => mon.id === id);
      if (m && (!best || m.scale > best.scale)) best = m;
    }
    return best ? publicMonitor(best) : null;
  }

  // ---- the layout ---------------------------------------------------------

  /**
   * The densest output's scale: what the app lays out at until a window
   * has heard its own. The fraction where fractional-scale-v1 will hand
   * the windows one, the integer where only `wl_output.scale` exists —
   * seeding 1.5 on a compositor that can only answer 2 would be a layout
   * corrected on the first frame.
   */
  get maxScale() {
    const fractional = Boolean(this.app.fractionalScale);
    let s = 1;
    for (const rec of this.byName.values())
      s = Math.max(s, fractional ? effectiveScaleOf(rec) : rec.scale || 1);
    return s;
  }

  /** The layout in `screens.js`'s shape, at the app's current scale. */
  layout() {
    const scale = this.app.scale > 0 ? this.app.scale : 1;
    const monitors = [];
    for (const rec of this.byName.values()) {
      const m = monitorOf(rec, scale);
      if (m) monitors.push({ id: rec.id, ...m });
    }
    const bounds = [...this._watched]
      .filter(([wl]) => wl.bounds)
      .sort((a, b) => a[1].seq - b[1].seq)
      .map(([wl]) => ({ outputs: wl.outputs, bounds: wl.bounds }));
    return layoutOf(monitors, { scale, bounds });
  }

  /** Every monitor, left to right, as `screens.js` sees it plus
   *  `description`, `scale`, `make` and `model`. */
  list() {
    return this._monitors.map(publicMonitor);
  }

  /**
   * Publish what is known — to `screens.js`, to the per-monitor scale map
   * `useScreens()` joins on, and to anyone listening for `change`. Skipped
   * when nothing moved: a `configure_bounds` repeating the same numbers on
   * every window must not re-render every `useScreens()` subscriber.
   */
  publish() {
    if (this.destroyed) return;
    // A denser output may have arrived before any window: the app's factor
    // follows, and the rects below are computed at the new one.
    this.app.noteScale?.();
    this._lastScale = this.app.scale;
    const { monitors, workArea } = this.layout();
    this._monitors = monitors;
    const published = monitors.map(publicMonitor);
    const key = JSON.stringify({ published, workArea });
    if (key === this._publishedKey) return;
    this._publishedKey = key;

    const scales = monitorScalesOf(this.app);
    scales.clear();
    for (const m of published) {
      if (!m.name) continue;
      scales.set(m.name, {
        scale: m.scale,
        source: 'wl_output',
        primary: m.primary,
        x: m.x,
        y: m.y,
        width: m.width,
        height: m.height,
      });
    }
    setScreensForTests(this.app, { monitors: published, workArea });
    this.emit('change', published);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.registry?.off('global', this._onGlobal);
    this.registry?.off('global_remove', this._onGlobalRemove);
    this.app.off?.('scale', this._onScale);
    for (const rec of this.byName.values()) this._release(rec);
    this.byName.clear();
    this.byId.clear();
    this._watched.clear();
  }
}

/** A monitor record without the proxy id the tracker keys on. */
function publicMonitor(m) {
  // eslint-disable-next-line no-unused-vars
  const { id, ...rest } = m;
  return rest;
}
