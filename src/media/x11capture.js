// The screen over X11 (design/architecture/media-capture.md §4): the one
// capture rung on Linux that is pure JavaScript, and the one that works
// against a remote display.
//
// Everything is `GetImage`, decoded by the server's own pixel layout
// (`pixelLayout`, the rule scripts/capture.js learned the hard way):
//
//   - **a screen** is a monitor's rectangle of the root window
//     (`screensSnapshot`, RandR or Xinerama, the root itself where neither
//     answered) — what the server composited there, every window in it;
//   - **a window** is one a window manager lists in `_NET_CLIENT_LIST`, read
//     from the window itself: its own pixels, whatever overlaps it. A part of
//     it another window covers is undefined on a server with no compositing
//     manager, as it is for every client that reads a window — which is the
//     price of the case that matters more: a server whose root holds nothing
//     at all (below);
//   - **a stream** is one of those read at the asked frame rate, BGRA, while
//     somebody reads frames — a `<video srcObject>`, an encoder — and not at
//     all otherwise; a read still in flight when the next is due drops that
//     one, the newest-wins rule a sink has anyway;
//   - **a screenshot** is one read.
//
// There is no picker: an X server has none, and any client may read the
// root, so the default source is the primary monitor and an app that wants
// the user to choose lists `displaySources()` and draws its own.
//
// **XQuartz has no screen to read.** Its rootless mode draws every X window
// as a Mac window of its own, and the root's pixels are black wherever a
// window is — measured: a window painted magenta read back as magenta from
// the window and as black from the root at the same place. So on a server
// with `Apple-WM` (every XQuartz, and nothing else) screens are refused with
// a `NotSupportedError` that says so, `features.screens` is false once the
// server has answered, and windows are captured as everywhere else. The
// Mac's own screen is the Cocoa backend's to capture (src/cocoa/capture.js).
//
// Not yet: XDamage, to read only what changed between frames, MIT-SHM's
// `GetImage` for the big ones, and XFixes' cursor image — `features.cursor`
// is false until it is drawn in.
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
const WM_NAME = 39;
const DEFAULT_FRAME_RATE = 30;
const MAX_FRAME_RATE = 60;

const ROOTLESS =
  'this X server is XQuartz, whose root window holds nothing of what is on ' +
  'the screen: rootless mode draws each X window as a Mac window of its ' +
  'own. A window can still be captured by its displaySources() id; the ' +
  "Mac's screen needs the app on the Cocoa backend (docs/media.md).";

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

const named = (name, message) => Object.assign(new Error(message), { name });

class X11Capture {
  constructor(app) {
    this.app = app;
    this.backend = 'x11';
    /** true on XQuartz, once the server has said; null until then */
    this._rootless = null;
    this._ready = null;
    this.ready();
  }

  /** Settled once the server has said whether its root can be read. */
  ready() {
    this._ready ??= call(this.app.X, 'QueryExtension', 'Apple-WM').then(
      (reply) => {
        this._rootless = Boolean(reply?.present);
      },
      () => {
        this._rootless = false;
      },
    );
    return this._ready;
  }

  get features() {
    return {
      screenCapture: Object.freeze({
        picker: false,
        enumerate: true,
        screens: this._rootless !== true,
        streams: true,
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

  async _clients() {
    const X = this.app.X;
    try {
      const atom = await call(X, 'InternAtom', false, '_NET_CLIENT_LIST');
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
      for (let i = 0; i + 4 <= data.length; i += 4) {
        ids.push(data.readUInt32LE(i));
      }
      return ids;
    } catch {
      return [];
    }
  }

  async _windowName(wid) {
    const X = this.app.X;
    for (const name of ['_NET_WM_NAME', 'WM_NAME']) {
      try {
        const atom =
          name === 'WM_NAME'
            ? WM_NAME
            : await call(X, 'InternAtom', false, name);
        const prop = await call(X, 'GetProperty', 0, wid, atom, 0, 0, 1024);
        if (prop?.data?.length) return prop.data.toString('utf8');
      } catch {
        // a window that went away between the list and the read
      }
    }
    return '';
  }

  /** Where `wid` is on the root and how big, or null for one that is gone. */
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

  /**
   * What a source id names now: the drawable to read, the rectangle of it
   * that is the picture, and a label. A monitor of the root, the primary
   * one by default — refused on a server whose root holds nothing — or a
   * window, at the size it is this moment.
   */
  async _target(source) {
    if (source == null || String(source).startsWith('screen:')) {
      await this.ready();
      if (this._rootless) throw named('NotSupportedError', ROOTLESS);
      const monitors = this._monitors();
      const m =
        source == null
          ? (monitors.find((one) => one.primary) ?? monitors[0])
          : monitors[Number(String(source).slice('screen:'.length))];
      if (m) {
        return {
          drawable: this._screen.root,
          rect: { x: m.x, y: m.y, width: m.width, height: m.height },
          surface: 'monitor',
          label: m.name ?? 'Screen',
        };
      }
    } else if (String(source).startsWith('window:')) {
      const wid = Number(String(source).slice('window:'.length));
      const rect = await this._windowRect(wid);
      if (rect) {
        return {
          drawable: wid,
          rect: { x: 0, y: 0, width: rect.width, height: rect.height },
          at: rect,
          surface: 'window',
          wid,
        };
      }
    }
    throw named(
      'NotFoundError',
      `there is no source ${JSON.stringify(source)}`,
    );
  }

  /** `region` of a target (all of it without one), as the GetImage reply,
   *  cut to the target; the size it came to. */
  async _read(target, region = null) {
    const { rect } = target;
    const r = region
      ? {
          x: rect.x + region.x,
          y: rect.y + region.y,
          width: region.width,
          height: region.height,
        }
      : rect;
    const bound =
      target.drawable === this._screen.root
        ? {
            x: 0,
            y: 0,
            width: this._screen.pixel_width,
            height: this._screen.pixel_height,
          }
        : rect;
    const x0 = Math.max(bound.x, Math.floor(r.x));
    const y0 = Math.max(bound.y, Math.floor(r.y));
    const x1 = Math.min(bound.x + bound.width, Math.ceil(r.x + r.width));
    const y1 = Math.min(bound.y + bound.height, Math.ceil(r.y + r.height));
    if (x1 <= x0 || y1 <= y0) {
      throw named('NotFoundError', 'that region is outside the source');
    }
    const width = x1 - x0;
    const height = y1 - y0;
    const img = await call(
      this.app.X,
      'GetImage',
      ZPIXMAP,
      target.drawable,
      x0,
      y0,
      width,
      height,
      0xffffffff,
    );
    return { img, width, height };
  }

  async _readRGBA(target, region) {
    const { img, width, height } = await this._read(target, region);
    const layout = pixelLayout(
      this.app.X.display,
      img.depth ?? this._screen.root_depth,
    );
    return {
      width,
      height,
      data: toStraightRgba(img.data, layout, width, height),
    };
  }

  async displaySources({ types, thumbnail }) {
    await this.ready();
    const out = [];
    if (types.includes('screen') && !this._rootless) {
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
        if (!rect || rect.width < 1 || rect.height < 1) continue;
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
        source.thumbnail = await this._target(source.id)
          .then((t) => this._readRGBA(t))
          .then((shot) => scaleDown(shot, thumbnail.width, thumbnail.height))
          .catch(() => null);
      }
    }
    return out;
  }

  async captureScreenshot({ source, region }) {
    return this._readRGBA(await this._target(source), region);
  }

  async openDisplay({ source, video }) {
    const target = await this._target(source);
    const frameRate = Math.min(
      MAX_FRAME_RATE,
      Math.max(1, Number(video.frameRate) || DEFAULT_FRAME_RATE),
    );
    const label =
      target.surface === 'window'
        ? (await this._windowName(target.wid)) || 'Window'
        : target.label;
    return {
      video: new X11ScreenSource(this, source, target, frameRate, label),
    };
  }
}

/**
 * A screen or a window read at a frame rate, while anybody reads frames. The
 * pixels go out as BGRA, which on a little-endian server with the standard
 * visual is what the server sent and is handed over without a pass.
 */
class X11ScreenSource {
  constructor(rung, source, target, frameRate, label) {
    this.kind = 'video';
    this.label = label;
    this._rung = rung;
    this._source = source;
    this._target = target;
    this._frameRate = frameRate;
    this._events = null;
    this._timer = null;
    this._busy = false;
    this._wanted = false;
    this._stopped = false;
    this._start = performance.now();
  }

  listen(events) {
    this._events = events;
    events.muted(false);
  }

  settings() {
    return {
      width: this._target.rect.width,
      height: this._target.rect.height,
      frameRate: this._frameRate,
      displaySurface: this._target.surface,
      cursor: 'never',
    };
  }

  capabilities() {
    return {
      width: { min: 1, max: this._target.rect.width },
      height: { min: 1, max: this._target.rect.height },
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
      if (this._target.surface === 'window') {
        // a window moves and resizes; one that is gone ends the track
        try {
          this._target = await this._rung._target(this._source);
        } catch {
          this._end();
          return;
        }
      }
      const { img, width, height } = await this._rung._read(this._target);
      if (this._stopped || !this._wanted) return;
      this._events?.frame({
        format: 'BGRA',
        width,
        height,
        planes: [bgraOf(this._rung, img, width, height)],
        strides: [width * 4],
        time: (performance.now() - this._start) / 1000,
        colorSpace: 'bt709',
        range: 'full',
      });
    } catch {
      // the server refused a read — a window unmapped or resized under us;
      // the next tick reads it again
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
function bgraOf(rung, img, width, height) {
  const display = rung.app.X.display;
  const layout = pixelLayout(display, img.depth ?? rung._screen.root_depth);
  if (
    layout.byteOrder === 'lsb' &&
    layout.masks.red === 0xff0000 &&
    layout.masks.green === 0xff00 &&
    layout.masks.blue === 0xff &&
    !layout.premultiplied
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
