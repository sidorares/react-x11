// The screen over X11 (design/architecture/media-capture.md §4): the one
// capture rung on Linux that is pure JavaScript, and the one that works
// against a remote display.
//
// Everything is `GetImage` on the root window — what is on the screen in a
// rectangle, composited by the server — decoded by the server's own pixel
// layout (`pixelLayout`, the rule scripts/capture.js learned the hard way):
//
//   - **sources** are the monitors (`screensSnapshot`, RandR or Xinerama, the
//     root itself where neither answered) and the managed windows a window
//     manager lists in `_NET_CLIENT_LIST`; a window is captured as the part
//     of the screen it covers, so what overlaps it is in the picture, as it
//     is in every X11 screen recorder that does not redirect;
//   - **a stream** is that rectangle read at the asked frame rate, BGRA,
//     while somebody reads frames — a `<video srcObject>`, an encoder —
//     and not at all otherwise; a read still in flight when the next is due
//     drops that one, the newest-wins rule a sink has anyway;
//   - **a screenshot** is one read.
//
// There is no picker here: an X server has none, and any client may read the
// root, so the default source is the primary monitor and an app that wants
// the user to choose lists `displaySources()` and draws its own. Not yet:
// XDamage, to read only what changed between frames, MIT-SHM's `GetImage`
// for the big ones, and XFixes' cursor image — `features.cursor` is false
// until it is drawn in.
//
// Gated on the requests it is built out of — an app whose `X` can
// `GetImage` — not on there being an app: the Cocoa app carries an X stub
// that cannot (src/screencolor.js's rule).

import { pixelLayout, toStraightRgba } from 'ntk/imagedata';

import { screensSnapshot } from '../screens.js';

const rungs = new WeakMap();

/** The X11 capture rung for `app`, or null where its connection cannot read
 *  the screen. */
export function x11CaptureFor(app) {
  const X = app?.X;
  if (typeof X?.GetImage !== 'function' || !X.display?.screen?.[0]) {
    return null;
  }
  let rung = rungs.get(app);
  if (!rung) rungs.set(app, (rung = new X11Capture(app)));
  return rung;
}

const ZPIXMAP = 2;
const DEFAULT_FRAME_RATE = 30;
const MAX_FRAME_RATE = 60;

// A request as a promise. The callback answers true for an error: that is
// how node-x11 knows it was handled, and a window gone between the list and
// the read is an answer here, not something to warn about.
const call = (X, name, ...args) =>
  new Promise((resolve, reject) =>
    X[name](...args, (err, value) => {
      if (err) {
        reject(err);
        return true;
      }
      resolve(value);
      return undefined;
    }),
  );

class X11Capture {
  constructor(app) {
    this.app = app;
    this.backend = 'x11';
    this.features = {
      screenCapture: Object.freeze({
        picker: false,
        enumerate: true,
        windows: true,
        cursor: false,
        systemAudio: false,
        excludeWindows: false,
        screenshot: true,
        thumbnails: true,
      }),
    };
  }

  get _screen() {
    return this.app.X.display.screen[0];
  }

  /** The monitors, or the root as one where nothing said more. */
  _monitors() {
    const known = screensSnapshot(this.app).screens;
    if (known.length) return known;
    const s = this._screen;
    return [
      {
        name: null,
        x: 0,
        y: 0,
        width: s.pixel_width,
        height: s.pixel_height,
        primary: true,
      },
    ];
  }

  async _atom(name) {
    return call(this.app.X, 'InternAtom', false, name);
  }

  async _clients() {
    const X = this.app.X;
    try {
      const atom = await this._atom('_NET_CLIENT_LIST');
      const prop = await call(
        X,
        'GetProperty',
        0,
        this._screen.root,
        atom,
        0,
        0,
        4096,
      );
      const data = prop?.data;
      if (!data || prop.format !== 32) return [];
      const ids = [];
      for (let i = 0; i + 4 <= data.length; i += 4)
        ids.push(data.readUInt32LE(i));
      return ids;
    } catch {
      return [];
    }
  }

  async _windowName(wid) {
    const X = this.app.X;
    for (const name of ['_NET_WM_NAME', 'WM_NAME']) {
      try {
        const atom = name === 'WM_NAME' ? 39 : await this._atom(name);
        const prop = await call(X, 'GetProperty', 0, wid, atom, 0, 0, 1024);
        if (prop?.data?.length) return prop.data.toString('utf8');
      } catch {
        // a window that went away between the list and the read
      }
    }
    return '';
  }

  /** Where `wid` is on the root, or null for a window that is gone. */
  async _windowRect(wid) {
    const X = this.app.X;
    try {
      const geom = await call(X, 'GetGeometry', wid);
      const at = await call(
        X,
        'TranslateCoordinates',
        wid,
        this._screen.root,
        0,
        0,
      );
      return {
        x: at.destX,
        y: at.destY,
        width: geom.width,
        height: geom.height,
      };
    } catch {
      return null;
    }
  }

  /** `rect` cut to the root, or null where nothing of it is on screen. */
  _onScreen(rect) {
    const s = this._screen;
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(s.pixel_width, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(s.pixel_height, Math.ceil(rect.y + rect.height));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  async displaySources({ types, thumbnail }) {
    const out = [];
    if (types.includes('screen')) {
      this._monitors().forEach((m, i) => {
        out.push({
          id: `screen:${i}`,
          kind: 'screen',
          name: m.name ?? `Screen ${i + 1}`,
          primary: Boolean(m.primary),
          x: m.x,
          y: m.y,
          width: m.width,
          height: m.height,
        });
      });
    }
    if (types.includes('window')) {
      for (const wid of await this._clients()) {
        const rect = await this._windowRect(wid);
        if (!rect || !this._onScreen(rect)) continue;
        out.push({
          id: `window:${wid}`,
          kind: 'window',
          name: await this._windowName(wid),
          ...rect,
        });
      }
    }
    if (thumbnail) {
      for (const source of out) {
        source.thumbnail = await this._thumbnail(source, thumbnail).catch(
          () => null,
        );
      }
    }
    return out;
  }

  /** The rectangle a source id names now: a monitor's, or a window's where it
   *  is this frame. */
  async _rectOf(source) {
    if (source == null) {
      const monitors = this._monitors();
      return monitors.find((m) => m.primary) ?? monitors[0];
    }
    const [kind, value] = String(source).split(':');
    if (kind === 'screen') {
      const m = this._monitors()[Number(value)];
      if (m) return m;
    } else if (kind === 'window') {
      const rect = await this._windowRect(Number(value));
      if (rect) return rect;
    }
    throw Object.assign(
      new Error(`there is no source ${JSON.stringify(source)}`),
      {
        name: 'NotFoundError',
      },
    );
  }

  /** `rect` of the root as straight RGBA. */
  async _readRGBA(rect) {
    const X = this.app.X;
    const r = this._onScreen(rect);
    if (!r) {
      throw Object.assign(new Error('that part of the screen is off it'), {
        name: 'NotFoundError',
      });
    }
    const img = await call(
      X,
      'GetImage',
      ZPIXMAP,
      this._screen.root,
      r.x,
      r.y,
      r.width,
      r.height,
      0xffffffff,
    );
    const layout = pixelLayout(X.display, img.depth ?? this._screen.root_depth);
    return {
      width: r.width,
      height: r.height,
      data: toStraightRgba(img.data, layout, r.width, r.height),
    };
  }

  async _thumbnail(source, { width, height }) {
    const shot = await this._readRGBA(source);
    return scaleDown(shot, width, height);
  }

  async captureScreenshot({ source, region }) {
    let rect = await this._rectOf(source);
    if (region) {
      rect = {
        x: rect.x + region.x,
        y: rect.y + region.y,
        width: Math.min(region.width, rect.width - region.x),
        height: Math.min(region.height, rect.height - region.y),
      };
    }
    return this._readRGBA(rect);
  }

  async openDisplay({ source, video }) {
    const rect = await this._rectOf(source);
    const frameRate = Math.min(
      MAX_FRAME_RATE,
      Math.max(1, Number(video.frameRate) || DEFAULT_FRAME_RATE),
    );
    const label =
      source == null || String(source).startsWith('screen:')
        ? (rect.name ?? 'Screen')
        : (await this._windowName(Number(String(source).split(':')[1]))) ||
          'Window';
    return { video: new X11ScreenSource(this, source, rect, frameRate, label) };
  }
}

/**
 * A screen or a window read at a frame rate, while anybody reads frames. The
 * pixels go out as BGRA, which on a little-endian server with the standard
 * visual is what the server sent and is handed over without a pass.
 */
class X11ScreenSource {
  constructor(rung, source, rect, frameRate, label) {
    this.kind = 'video';
    this.label = label;
    this._rung = rung;
    this._source = source;
    this._rect = rect;
    this._frameRate = frameRate;
    this._events = null;
    this._timer = null;
    this._busy = false;
    this._wanted = false;
    this._stopped = false;
    this._start = performance.now();
    this._window = String(source ?? '').startsWith('window:');
  }

  listen(events) {
    this._events = events;
    events.muted(false);
  }

  settings() {
    return {
      width: this._rect.width,
      height: this._rect.height,
      frameRate: this._frameRate,
      displaySurface: this._window ? 'window' : 'monitor',
      cursor: 'never',
    };
  }

  capabilities() {
    return {
      width: { min: 1, max: this._rect.width },
      height: { min: 1, max: this._rect.height },
      frameRate: { min: 1, max: MAX_FRAME_RATE },
    };
  }

  async reconfigure({ frameRate }) {
    if (typeof frameRate === 'number' && frameRate > 0) {
      this._frameRate = Math.min(MAX_FRAME_RATE, frameRate);
      this._run();
    }
    return true;
  }

  wantFrames(on) {
    this._wanted = Boolean(on);
    this._run();
  }

  _run() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (!this._wanted || this._stopped) return;
    this._timer = setInterval(() => this._tick(), 1000 / this._frameRate);
    this._timer.unref?.();
    this._tick();
  }

  async _tick() {
    if (this._busy || this._stopped) return;
    this._busy = true;
    try {
      if (this._window) {
        const rect = await this._rung._windowRect(
          Number(String(this._source).split(':')[1]),
        );
        if (!rect) {
          this._end();
          return;
        }
        this._rect = rect;
      }
      const r = this._rung._onScreen(this._rect);
      if (!r || this._stopped) return;
      const X = this._rung.app.X;
      const img = await call(
        X,
        'GetImage',
        ZPIXMAP,
        this._rung._screen.root,
        r.x,
        r.y,
        r.width,
        r.height,
        0xffffffff,
      );
      if (this._stopped || !this._wanted) return;
      this._events?.frame({
        format: 'BGRA',
        width: r.width,
        height: r.height,
        planes: [bgraOf(X.display, img, r.width, r.height, this._rung)],
        strides: [r.width * 4],
        time: (performance.now() - this._start) / 1000,
        colorSpace: 'bt709',
        range: 'full',
      });
    } catch {
      // the server refused a read — a window resized under us; the next
      // tick reads it again
    } finally {
      this._busy = false;
    }
  }

  _end() {
    this.stop();
    this._events?.ended();
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

/** A GetImage reply as BGRA bytes: as it came on the usual server, unpacked
 *  and swapped where its layout is another. */
function bgraOf(display, img, width, height, rung) {
  const layout = pixelLayout(display, img.depth ?? rung._screen.root_depth);
  if (
    layout.byteOrder === 'lsb' &&
    layout.masks.red === 0xff0000 &&
    layout.masks.green === 0xff00 &&
    layout.masks.blue === 0xff
  ) {
    return img.data;
  }
  const rgba = toStraightRgba(img.data, layout, width, height);
  const out = Buffer.allocUnsafe(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i + 2];
    out[i + 1] = rgba[i + 1];
    out[i + 2] = rgba[i];
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

/** `shot` no larger than `maxW` x `maxH`, its ratio kept: a box filter, which
 *  is what a thumbnail of text wants. */
export function scaleDown(shot, maxW, maxH) {
  const scale = Math.min(1, maxW / shot.width, maxH / shot.height);
  const width = Math.max(1, Math.round(shot.width * scale));
  const height = Math.max(1, Math.round(shot.height * scale));
  if (width === shot.width && height === shot.height) return shot;
  const data = new Uint8ClampedArray(width * height * 4);
  const sx = shot.width / width;
  const sy = shot.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * shot.width + xx) * 4;
          r += shot.data[i];
          g += shot.data[i + 1];
          b += shot.data[i + 2];
          a += shot.data[i + 3];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      data[o] = r / n;
      data[o + 1] = g / n;
      data[o + 2] = b / n;
      data[o + 3] = a / n;
    }
  }
  return { width, height, data };
}
