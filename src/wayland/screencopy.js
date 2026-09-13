// Reading the screen: a capture of an output into shared memory, and the
// eyedropper built on it.
//
// A Wayland client cannot read the screen — that is most of the point of
// Wayland — so what this offers depends entirely on what the compositor
// advertises, and it advertises one of two things or neither:
//
//   - `ext_image_copy_capture_manager_v1` (the standard successor, wlroots
//     0.19+, KDE 6.2+): a *session* on a capture source describes the buffer
//     the compositor wants — size and formats — and each *frame* is one
//     capture into a buffer the client attaches.
//   - `zwlr_screencopy_manager_v1` (wlroots since 2018, still what sway 1.10
//     has): one object per frame; the compositor first lists the buffer
//     formats it accepts, the client makes one and asks for the copy.
//
// Both land pixels in a `wl_shm` buffer (shm.js) and both say when it is
// ready; the difference is bookkeeping, and `capture()` hides it. GNOME has
// neither — its screenshots go through the portal, which is a D-Bus dialog
// and lives in src/screencolor.js's ladder above this — so on GNOME
// `createScreenCapture` answers null and this file is inert.
//
// The eyedropper is the part worth having a compositor for. A client cannot
// grab the pointer or read the pixel under it, so the trick every wlroots
// colour picker uses is: freeze the screen into a capture, put that capture
// up as a layer-shell overlay covering the output, and take the click *on the
// overlay*, whose surface coordinates are the output's. The pixel is read out
// of the capture, not the screen — the screen is showing the capture anyway —
// and the overlay comes down. It needs layer-shell as well as a capture
// protocol; `canPick` says whether both are there.

import { WaylandWindow } from './window.js';
import {
  createLayerSurface,
  LAYER,
  ALL_EDGES,
  KEYBOARD,
} from './layershell.js';
import {
  ShmBuffer,
  SHM_FORMAT,
  flipRows,
  isSupportedShmFormat,
  shmPixel,
  shmToRGBA,
} from './shm.js';
import { XK_ESCAPE, XK_KP_ENTER, XK_RETURN, XK_SPACE } from '../keysyms.js';

/** `zwlr_screencopy_frame_v1.flags`. */
const WLR_Y_INVERT = 1;

/** `REACT_X11_WAYLAND_TRACE=1`: the eyedropper's steps on stderr. */
const TRACE = Boolean(process.env.REACT_X11_WAYLAND_TRACE);
const trace = (line) => {
  if (TRACE) process.stderr.write(`react-x11 wayland: eyedropper ${line}\n`);
};

/** A frame's formats, most convenient first: no byte swap, then no alpha. */
const FORMAT_PREFERENCE = [
  SHM_FORMAT.XBGR8888,
  SHM_FORMAT.ABGR8888,
  SHM_FORMAT.XRGB8888,
  SHM_FORMAT.ARGB8888,
];

function pickFormat(offered) {
  for (const f of FORMAT_PREFERENCE) if (offered.includes(f)) return f;
  return offered.find(isSupportedShmFormat) ?? null;
}

function abortReason(signal) {
  return (
    signal?.reason ??
    new DOMException('the screen pick was aborted', 'AbortError')
  );
}

/**
 * Bind what the compositor has and hand back a `ScreenCapture`, or null when
 * it has no capture protocol at all (GNOME) — the shape of every other
 * optional global in app.js.
 *
 * @param {import('./app.js').WaylandApp} app
 */
export async function createScreenCapture(app) {
  const conn = app.conn;
  const shm = await conn.bind('wl_shm');
  if (!shm) return null;
  const ext = await conn.bind('ext_image_copy_capture_manager_v1');
  const extSources = ext
    ? await conn.bind('ext_output_image_capture_source_manager_v1')
    : null;
  // `bind` negotiates the newest version the definition (3) and the
  // compositor share; `_grabWlr` reads `frame.version` for the one place
  // the versions differ in shape.
  const wlr = await conn.bind('zwlr_screencopy_manager_v1');
  if (!(ext && extSources) && !wlr) return null;
  if (!conn.has('wl_output')) return null;
  // An output of our own rather than the shared singleton, so its geometry
  // events arrive here (they are sent once, right after the bind). The
  // library keeps one global per interface name, so on a multi-head desktop
  // this is the output advertised last; `capture({ output })` takes another.
  const output = await conn.display.bind('wl_output');
  output.setMaxListeners?.(0);
  const capture = new ScreenCapture({
    conn,
    shm,
    output,
    ext: ext && extSources ? { manager: ext, sources: extSources } : null,
    wlr,
    compositor: app.compositor,
    viewporter: app.viewporter,
    layerShell: app.layerShell,
    seat: app.seat,
  });
  return capture;
}

export class ScreenCapture {
  constructor({
    conn,
    shm,
    output,
    ext,
    wlr,
    compositor,
    viewporter,
    layerShell,
    seat,
  }) {
    this.conn = conn;
    this.shm = shm;
    this.output = output;
    this.ext = ext;
    this.wlr = wlr;
    this.compositor = compositor;
    this.viewporter = viewporter;
    this.layerShell = layerShell;
    this.seat = seat;
    /** what the compositor said about `output` */
    this.outputInfo = {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      scale: 1,
      transform: 0,
      name: null,
    };
    this._pick = null;
    this.destroyed = false;
    this._wireOutput(output);
  }

  _wireOutput(output) {
    const info = this.outputInfo;
    output.on('geometry', (x, y, _pw, _ph, _sub, _make, _model, transform) => {
      info.x = x;
      info.y = y;
      info.transform = transform;
    });
    output.on('mode', (flags, width, height) => {
      if (flags & 1 /* current */) {
        info.width = width;
        info.height = height;
      }
    });
    output.on('scale', (factor) => {
      info.scale = factor;
    });
    output.on('name', (name) => {
      info.name = name;
    });
    output.on('description', () => {});
    output.on('done', () => {});
  }

  /** Which protocol a capture goes through: 'ext' | 'wlr'. */
  get route() {
    return this.ext ? 'ext' : this.wlr ? 'wlr' : null;
  }

  /** Whether the interactive pick is possible: a capture, and an overlay to click on. */
  get canPick() {
    return Boolean(
      this.route && this.layerShell && this.seat && !this.destroyed,
    );
  }

  // ---- capture -------------------------------------------------------------

  /**
   * One frame of an output, as straight RGBA, top row first — the shape
   * `readback.js`'s `encodePNG` takes.
   *
   * @param {object} [opts]
   * @param {object} [opts.output] a `wl_output` proxy; defaults to the bound one
   * @param {boolean} [opts.cursor=false] paint the pointer into the frame
   * @returns {Promise<{ width:number, height:number, data:Uint8Array }>}
   */
  async capture(opts = {}) {
    const frame = await this._grab(opts);
    try {
      return shmToRGBA({
        bytes: frame.buffer.read(),
        width: frame.width,
        height: frame.height,
        stride: frame.stride,
        format: frame.format,
        yInvert: frame.yInvert,
      });
    } finally {
      frame.buffer.destroy();
    }
  }

  /**
   * The pixel at an output-relative point, in device pixels, as 0–255
   * channels. A capture per call: for many pixels, `capture()` once.
   */
  async pixelAt(x, y, opts = {}) {
    const frame = await this._grab(opts);
    try {
      const bytes = frame.buffer.read();
      if (frame.yInvert) flipRows(bytes, frame.stride, frame.height);
      const px = clamp(Math.round(x), 0, frame.width - 1);
      const py = clamp(Math.round(y), 0, frame.height - 1);
      return shmPixel(bytes, frame, px, py);
    } finally {
      frame.buffer.destroy();
    }
  }

  /**
   * The capture, still in its shm buffer — the overlay attaches that buffer
   * as it is, so the pick never converts a whole screen.
   *
   * @returns {Promise<{ buffer: ShmBuffer, width, height, stride, format, yInvert, transform }>}
   */
  _grab({ output = this.output, cursor = false } = {}) {
    if (this.destroyed) {
      return Promise.reject(new Error('the screen capture was destroyed'));
    }
    if (this.ext) return this._grabExt(output, cursor);
    if (this.wlr) return this._grabWlr(output, cursor);
    return Promise.reject(
      new Error('this compositor advertises no screen capture protocol'),
    );
  }

  _grabWlr(output, cursor) {
    return new Promise((resolve, reject) => {
      const frame = this.wlr.$.capture_output(cursor ? 1 : 0, output.id);
      const offered = [];
      let chosen = null;
      let buf = null;
      let flags = 0;
      let settled = false;
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        try {
          frame.$.destroy();
        } catch {
          /* gone */
        }
        fn();
      };
      const fail = (message) => {
        buf?.destroy();
        finish(() => reject(new Error(`react-x11 (wayland): ${message}`)));
      };
      const start = () => {
        if (chosen) return;
        const format = pickFormat(offered.map((o) => o.format));
        chosen = offered.find((o) => o.format === format) ?? null;
        if (!chosen) {
          return fail(
            `the compositor offers no shm format this client reads (offered ${offered
              .map((o) => '0x' + o.format.toString(16))
              .join(', ')})`,
          );
        }
        try {
          buf = new ShmBuffer({
            shm: this.shm,
            width: chosen.width,
            height: chosen.height,
            stride: chosen.stride,
            format: chosen.format,
            name: 'react-x11-screencopy',
          });
        } catch (err) {
          return fail(
            `could not make a buffer for the capture: ${err.message}`,
          );
        }
        frame.$.copy(buf.buffer.id);
      };
      frame.on('buffer', (format, width, height, stride) => {
        offered.push({ format, width, height, stride });
        // Before version 3 there is no buffer_done: one buffer event, then copy.
        if (frame.version < 3) queueMicrotask(start);
      });
      frame.on('linux_dmabuf', () => {});
      frame.on('buffer_done', start);
      frame.on('flags', (f) => {
        flags = f;
      });
      frame.on('damage', () => {});
      frame.on('ready', () => {
        finish(() =>
          resolve({
            buffer: buf,
            width: chosen.width,
            height: chosen.height,
            stride: chosen.stride,
            format: chosen.format,
            yInvert: Boolean(flags & WLR_Y_INVERT),
            transform: this.outputInfo.transform,
          }),
        );
      });
      frame.on('failed', () =>
        fail('the compositor refused the screen capture'),
      );
    });
  }

  _grabExt(output, cursor) {
    return new Promise((resolve, reject) => {
      const source = this.ext.sources.$.create_source(output.id);
      const session = this.ext.manager.$.create_session(
        source.id,
        cursor ? 1 : 0,
      );
      let size = null;
      const formats = [];
      let frame = null;
      let buf = null;
      let transform = 0;
      let settled = false;
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        try {
          frame?.$.destroy();
          session.$.destroy();
          source.$.destroy();
        } catch {
          /* gone */
        }
        fn();
      };
      const fail = (message) => {
        buf?.destroy();
        finish(() => reject(new Error(`react-x11 (wayland): ${message}`)));
      };
      session.on('buffer_size', (width, height) => {
        size = { width, height };
      });
      session.on('shm_format', (format) => formats.push(format));
      session.on('dmabuf_device', () => {});
      session.on('dmabuf_format', () => {});
      session.on('stopped', () => fail('the capture session was stopped'));
      session.on('done', () => {
        if (frame) return; // constraints changed mid-capture; this frame stands
        const format = pickFormat(formats);
        if (!size || format == null) {
          return fail(
            `the compositor offers no shm format this client reads (offered ${formats
              .map((f) => '0x' + f.toString(16))
              .join(', ')})`,
          );
        }
        try {
          buf = new ShmBuffer({
            shm: this.shm,
            width: size.width,
            height: size.height,
            format,
            name: 'react-x11-screencopy',
          });
        } catch (err) {
          return fail(
            `could not make a buffer for the capture: ${err.message}`,
          );
        }
        frame = session.$.create_frame();
        frame.on('transform', (t) => {
          transform = t;
        });
        frame.on('damage', () => {});
        frame.on('presentation_time', () => {});
        frame.on('ready', () =>
          finish(() =>
            resolve({
              buffer: buf,
              width: buf.width,
              height: buf.height,
              stride: buf.stride,
              format: buf.format,
              yInvert: false,
              transform,
            }),
          ),
        );
        frame.on('failed', (reason) =>
          fail(
            `the compositor refused the screen capture (${
              ['unknown', 'buffer constraints', 'stopped'][reason] ?? reason
            })`,
          ),
        );
        frame.$.attach_buffer(buf.buffer.id);
        frame.$.damage_buffer(0, 0, buf.width, buf.height);
        frame.$.capture();
      });
    });
  }

  // ---- the eyedropper --------------------------------------------------

  /**
   * Freeze the screen, show it, take a click, answer the colour under it.
   *
   * Resolves `{ r, g, b }` — sRGB in 0–1, the Screenshot portal's `(ddd)`
   * shape, so src/screencolor.js converts it with the same function as the
   * portal's and the cocoa sampler's — or **null** when the user pressed
   * Escape or the compositor took the overlay down. Return, space and
   * KP_Enter pick at the pointer without a click, GTK's shape. Rejects on an
   * abort (with `signal.reason`), after the overlay is gone.
   *
   * One pick at a time: a second call while one is up joins it, the rule
   * the system sampler follows.
   *
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @param {object} [opts.output] which output to freeze; defaults to the bound one
   */
  pickColor({ signal, output = this.output } = {}) {
    if (!this.canPick) {
      return Promise.reject(
        new Error(
          'react-x11 (wayland): no screen pick here — it needs a capture protocol and wlr-layer-shell',
        ),
      );
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this._pick) return this._pick;
    this._pick = this._runPick(signal, output).finally(() => {
      this._pick = null;
    });
    return this._pick;
  }

  async _runPick(signal, output) {
    const frame = await this._grab({ output, cursor: false });
    if (signal?.aborted) {
      frame.buffer.destroy();
      throw abortReason(signal);
    }
    // Rows the right way up, in place: the overlay shows the buffer as it
    // is, and a pointer row indexes straight into it.
    const bytes = frame.buffer.read();
    if (frame.yInvert) {
      flipRows(bytes, frame.stride, frame.height);
      frame.buffer.write(bytes);
    }

    const seat = this.seat;
    const win = createLayerSurface(WaylandWindow, {
      conn: this.conn,
      compositor: this.compositor,
      layerShell: this.layerShell,
      width: frame.width,
      height: frame.height,
      layer: LAYER.OVERLAY,
      anchor: ALL_EDGES,
      exclusiveZone: -1,
      keyboardInteractivity: KEYBOARD.EXCLUSIVE,
      namespace: 'react-x11-eyedropper',
      output,
    });
    // A viewport maps the pixel-sized capture onto whatever logical size the
    // overlay is configured to — which is how a fractional scale comes out
    // right. Without one the integer output scale has to do.
    if (this.viewporter) win.useScaling({ viewporter: this.viewporter });
    else win.scale = Math.max(1, this.outputInfo.scale | 0);

    return new Promise((resolve, reject) => {
      let settled = false;
      const previousCursor = seat._cursor;
      const cleanup = () => {
        seat.off('buttonpress', onPress);
        seat.off('keydown', onKey);
        win.off('configure', onConfigure);
        win.off('close', onClose);
        signal?.removeEventListener('abort', onAbort);
        seat.setCursor(previousCursor ?? 'default');
        win.destroy();
        frame.buffer.destroy();
      };
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const onConfigure = () => {
        // The configured size is the output's logical size; the buffer is
        // its pixel size. Ack, then show the frozen frame.
        win.ackPending();
        const s = win.surface;
        s.$.attach(frame.buffer.buffer.id, 0, 0);
        if (s.version >= 4) s.$.damage_buffer(0, 0, frame.width, frame.height);
        else s.$.damage(0, 0, win.width, win.height);
        s.$.commit();
        win.mapped = true;
        trace(
          `overlay ${win.width}x${win.height} showing a ${frame.width}x${frame.height} frame`,
        );
      };
      const sample = () => {
        const px = clamp(
          Math.floor((seat.pointerX * frame.width) / win.width),
          0,
          frame.width - 1,
        );
        const py = clamp(
          Math.floor((seat.pointerY * frame.height) / win.height),
          0,
          frame.height - 1,
        );
        const { r, g, b } = shmPixel(bytes, frame, px, py);
        trace(`picked (${px}, ${py}) = rgb(${r}, ${g}, ${b})`);
        finish(() => resolve({ r: r / 255, g: g / 255, b: b / 255 }));
      };
      const onPress = (ev) => {
        trace(
          `press button ${ev.button} on surface ${ev.surface} (overlay is ${win.surface.id})`,
        );
        if (ev.surface !== win.surface.id) return;
        // Button 1 picks; the rest are ignored rather than treated as
        // cancel, the X11 rung's rule — Escape is one key away.
        if (ev.button === 1) sample();
      };
      const onKey = (ev) => {
        if (seat.focus !== win.surface.id) return;
        const sym = ev.keysym;
        if (sym === XK_ESCAPE) return finish(() => resolve(null));
        if (
          (sym === XK_RETURN || sym === XK_KP_ENTER || sym === XK_SPACE) &&
          seat.pointerSurface === win.surface.id
        ) {
          sample();
        }
      };
      const onClose = () => finish(() => resolve(null));
      const onAbort = () => finish(() => reject(abortReason(signal)));

      seat.on('buttonpress', onPress);
      seat.on('keydown', onKey);
      win.on('configure', onConfigure);
      win.on('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
      // Applied on the pointer's entry into the overlay, by the seat.
      seat.setCursor('crosshair');
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      if (this.output.version >= 3) this.output.$.release();
    } catch {
      /* gone */
    }
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
