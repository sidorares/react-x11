// `VideoFrames`: a sink an application pushes decoded video frames into,
// and a `<video frames>` shows (docs/architecture/video.md §6.3).
//
// react-x11 decodes nothing. Where the bytes come from — an `ffmpeg` child
// writing rawvideo to a pipe, a WASM decoder, an addon over libmpv — is the
// application's business, and every one of them ends in `push`. What this
// module owns is the contract between that decoder and whatever shows the
// frame, which is one of two things per element and per frame:
//
// - **lifted**, on a backend that can put a frame on a layer of its own
//   (Cocoa, over `@windowkit/appkit`'s video surfaces): `push` writes the
//   frame into a surface the render server scans out and repoints the layer,
//   right there, and react-x11's frame clock is not involved at all
//   (src/cocoa/video.js);
// - **drawn**, everywhere else and whenever something is painted over the
//   video: `push` claims the element's picture, and the next frame copies
//   the newest frame into a surface of the element's own and composites it
//   in paint order (src/nodes/video.js).
//
// Three rules, each of which is a cost somewhere:
//
// - **The newest frame is the frame.** A push while the last one is not yet
//   shown replaces it; nothing queues. A sink mirrors a decoder's output —
//   the decoder's own clock is the pacing, as a `<canvas>` animation's is.
// - **A push hands the planes over until the next push.** The drawn path
//   reads them at the next frame, not at the call, so a frame pushed faster
//   than the display shows is never converted at all. A decoder that writes
//   every frame into one buffer pushes that buffer again after writing it,
//   which is exactly when the old contents stop mattering.
// - **Every format is accepted everywhere; the cheap one differs.** NV12 is
//   what a hardware decoder emits and what a layer shows as it is; BGRA is
//   what a 2D context draws. `preferredFormats` is this display's order, for
//   a decoder that can choose (`ffmpeg -pix_fmt`); one that cannot still
//   works, with the conversion charged where it happens.
//
// Pure: no node, no backend. The app is asked for its formats
// (`app.videoFormats()`, the Cocoa app's answer from the bridge) and nothing
// else.

export const VIDEO_FORMATS = Object.freeze(['NV12', 'I420', 'BGRA']);
const COLOR_SPACES = ['bt709', 'bt601', 'bt2020'];
const RANGES = ['video', 'full'];
// The largest side a frame may have: a surface's limit on every backend, and
// a number past which a size is a bug rather than a video.
const MAX_SIDE = 16384;

/**
 * The planes of a `format` frame at `width` x `height`: how many bytes of
 * picture a row of each holds, and how many rows. A 4:2:0 chroma plane is
 * half the size, rounded up.
 */
export function planeLayout(format, width, height) {
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  switch (format) {
    case 'NV12':
      return [
        { rowBytes: width, rows: height },
        { rowBytes: cw * 2, rows: ch },
      ];
    case 'I420':
      return [
        { rowBytes: width, rows: height },
        { rowBytes: cw, rows: ch },
        { rowBytes: cw, rows: ch },
      ];
    case 'BGRA':
      return [{ rowBytes: width * 4, rows: height }];
  }
  throw new TypeError(`react-x11: unknown video format ${format}`);
}

const isBytes = (v) => ArrayBuffer.isView(v) && !(v instanceof DataView);

const asBytes = (v) =>
  v instanceof Uint8Array || v instanceof Uint8ClampedArray
    ? v
    : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

/**
 * `push`'s argument as planes: one `Uint8Array` view per plane (no copy)
 * and each one's stride, checked to hold every row it claims. `planes` is
 * an array of them, or one buffer holding them back to back — what an
 * `ffmpeg -f rawvideo` pipe delivers per frame.
 */
export function readPlanes(sink, planes, strides) {
  const { format, width, height } = sink;
  const layout = planeLayout(format, width, height);
  if (strides !== undefined) {
    if (
      !Array.isArray(strides) ||
      strides.length !== layout.length ||
      !strides.every((s, i) => Number.isInteger(s) && s >= layout[i].rowBytes)
    ) {
      throw new TypeError(
        `react-x11: VideoFrames.push: strides must be ${layout.length} ` +
          `whole numbers of bytes, at least ` +
          `[${layout.map((p) => p.rowBytes).join(', ')}] for a ` +
          `${width}x${height} ${format} frame`,
      );
    }
  }
  const pitch = layout.map((p, i) => strides?.[i] ?? p.rowBytes);
  const sizes = layout.map((p, i) => pitch[i] * (p.rows - 1) + p.rowBytes);
  let views;
  if (isBytes(planes)) {
    // one buffer: the planes back to back, each a whole number of strides
    // except the last row of the last
    const all = asBytes(planes);
    views = [];
    let at = 0;
    for (let i = 0; i < layout.length; i++) {
      const length =
        i === layout.length - 1 ? sizes[i] : pitch[i] * layout[i].rows;
      views.push(all.subarray(at, at + length));
      at += length;
    }
    if (at > all.length) {
      throw new TypeError(
        `react-x11: VideoFrames.push: a ${width}x${height} ${format} frame ` +
          `in one buffer needs ${at} bytes, and this one has ${all.length}`,
      );
    }
  } else if (Array.isArray(planes) && planes.length === layout.length) {
    views = planes.map((p, i) => {
      if (!isBytes(p)) {
        throw new TypeError(
          `react-x11: VideoFrames.push: plane ${i} is not a Buffer or a typed array`,
        );
      }
      return asBytes(p);
    });
  } else {
    throw new TypeError(
      `react-x11: VideoFrames.push: a ${format} frame is ` +
        (layout.length === 1
          ? 'one buffer'
          : `an array of ${layout.length} planes (${format === 'NV12' ? 'Y, CbCr' : 'Y, Cb, Cr'}), or one buffer holding them back to back`),
    );
  }
  views.forEach((view, i) => {
    if (view.length < sizes[i]) {
      throw new TypeError(
        `react-x11: VideoFrames.push: plane ${i} of a ${width}x${height} ` +
          `${format} frame needs ${sizes[i]} bytes, and has ${view.length}`,
      );
    }
  });
  return { planes: views, strides: pitch };
}

/**
 * Where decoded video frames go to be shown — `createVideoFrames(app, …)`,
 * or `useVideoFrames(…)` in a component — and what `<video frames>` takes.
 *
 * A sink owns nothing native. What shows it — a `<video>`'s surface, a
 * layer's ring of video surfaces — owns that, and lets it go when it stops
 * showing it, so a sink that is dropped needs no call.
 */
export class VideoFrames {
  constructor(app, options = {}) {
    const {
      width,
      height,
      format = 'BGRA',
      colorSpace = 'bt709',
      range = 'video',
    } = options;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > MAX_SIDE ||
      height > MAX_SIDE
    ) {
      throw new TypeError(
        'react-x11: createVideoFrames: width and height are the frame size ' +
          `in whole pixels, 1 to ${MAX_SIDE} (got ${width}x${height})`,
      );
    }
    if (!VIDEO_FORMATS.includes(format)) {
      throw new TypeError(
        `react-x11: createVideoFrames: format ${JSON.stringify(format)} — ` +
          `expected one of ${VIDEO_FORMATS.join(', ')}`,
      );
    }
    if (!COLOR_SPACES.includes(colorSpace)) {
      throw new TypeError(
        `react-x11: createVideoFrames: colorSpace ${JSON.stringify(colorSpace)} ` +
          `— expected one of ${COLOR_SPACES.join(', ')}`,
      );
    }
    if (!RANGES.includes(range)) {
      throw new TypeError(
        `react-x11: createVideoFrames: range ${JSON.stringify(range)} — ` +
          "expected 'video' or 'full'",
      );
    }
    this.app = app;
    this.width = width;
    this.height = height;
    this.format = format;
    this.colorSpace = colorSpace;
    this.range = range;
    /** frames pushed; what a presentation compares to know it is behind */
    this.version = 0;
    this.closed = false;
    this._frame = null;
    this._listeners = new Set();
    this._preferred = null;
  }

  /**
   * This display's formats, cheapest first: what a decoder that can choose
   * should emit. NV12 first where a frame can go on a layer as it is
   * (Cocoa); BGRA first wherever a 2D context draws it.
   */
  get preferredFormats() {
    if (this._preferred === null) {
      const asked = this.app?.videoFormats?.();
      this._preferred = Object.freeze(
        Array.isArray(asked) && asked.length !== 0
          ? asked.filter((f) => VIDEO_FORMATS.includes(f))
          : ['BGRA'],
      );
    }
    return this._preferred;
  }

  /** The newest frame — `{ planes, strides, time, version }` — or null. */
  get frame() {
    return this._frame;
  }

  /**
   * One decoded frame: a Buffer per plane (`[y, uv]` for NV12, `[y, u, v]`
   * for I420, `[bgra]`), or one Buffer holding the planes back to back.
   * `strides` are the planes' bytes per row when a decoder pads them;
   * `time` is the frame's presentation time in seconds, kept as `frame.time`
   * for whoever wants it. Replaces the frame before it, shown or not.
   * Ignored once `close()` has run, so a decoder racing an unmount does not
   * have to know it lost.
   */
  push(planes, { strides, time } = {}) {
    if (this.closed) return;
    const frame = readPlanes(this, planes, strides);
    this.version += 1;
    frame.time = typeof time === 'number' ? time : null;
    frame.version = this.version;
    this._frame = frame;
    for (const fn of [...this._listeners]) fn(frame);
  }

  /** Drop the frame and take no more: what shows the sink shows its poster
   *  or its background from the next frame on. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this._frame = null;
    this.version += 1;
    for (const fn of [...this._listeners]) fn(null);
    this._listeners.clear();
  }

  /** `fn(frame)` on every push, and `fn(null)` on `close()`; answers the
   *  unsubscribe. For what shows a sink, not for applications. */
  _subscribe(fn) {
    if (this.closed) return () => {};
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
}

/** A sink for frames of one size and format, on `app`. */
export function createVideoFrames(app, options) {
  return new VideoFrames(app, options);
}

export const isVideoFrames = (v) => v instanceof VideoFrames;

// --- converting a frame where nothing native will ----------------------------
//
// The drawn path on a backend with no native write (X11, win32, Wayland, a
// Cocoa bridge older than its video surfaces): the frame converted here to
// the straight RGBA `putImageData` takes. Not free — two million pixels a
// frame at 1080p — which is why `preferredFormats` says BGRA first there.
// The matrix and the range are the frame's; no transfer function is
// applied, because none of those backends colour-manages anything else
// either, and a video brighter or darker than every other thing on the
// screen beside it is worse than one that is wrong the same way they are.

const MATRIX = {
  bt709: [0.2126, 0.0722],
  bt601: [0.299, 0.114],
  bt2020: [0.2627, 0.0593],
};

const tables = new Map();

/** Per-byte contributions in 0..255 units, made once per matrix and range:
 *  R = Y + crR, G = Y - cbG - crG, B = Y + cbB. */
function tablesFor(colorSpace, range) {
  const key = `${colorSpace}/${range}`;
  let t = tables.get(key);
  if (t) return t;
  const [kr, kb] = MATRIX[colorSpace];
  const kg = 1 - kr - kb;
  const full = range === 'full';
  const y = new Float32Array(256);
  const crR = new Float32Array(256);
  const crG = new Float32Array(256);
  const cbG = new Float32Array(256);
  const cbB = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    y[i] = full ? i : ((i - 16) * 255) / 219;
    const c = full ? (i - 128) * 1 : ((i - 128) * 255) / 224;
    crR[i] = 2 * (1 - kr) * c;
    cbB[i] = 2 * (1 - kb) * c;
    crG[i] = ((2 * kr * (1 - kr)) / kg) * c;
    cbG[i] = ((2 * kb * (1 - kb)) / kg) * c;
  }
  t = { y, crR, crG, cbG, cbB };
  tables.set(key, t);
  return t;
}

/**
 * `frame` from `sink` as straight RGBA into `out` (a Uint8ClampedArray of
 * width x height x 4, which clamps and rounds what is written into it).
 */
export function frameToRGBA(sink, frame, out) {
  const { width: w, height: h, format } = sink;
  const [p0, p1, p2] = frame.planes;
  const [s0, s1, s2] = frame.strides;
  if (format === 'BGRA') {
    for (let row = 0; row < h; row++) {
      let si = row * s0;
      let di = row * w * 4;
      for (let x = 0; x < w; x++, si += 4, di += 4) {
        out[di] = p0[si + 2];
        out[di + 1] = p0[si + 1];
        out[di + 2] = p0[si];
        out[di + 3] = 255;
      }
    }
    return out;
  }
  const { y: Y, crR, crG, cbG, cbB } = tablesFor(sink.colorSpace, sink.range);
  const nv12 = format === 'NV12';
  for (let row = 0; row < h; row++) {
    const yi = row * s0;
    const ci = (row >> 1) * s1;
    const vi = nv12 ? 0 : (row >> 1) * s2;
    let di = row * w * 4;
    for (let x = 0; x < w; x++, di += 4) {
      const cx = x >> 1;
      let cb;
      let cr;
      if (nv12) {
        cb = p1[ci + cx * 2];
        cr = p1[ci + cx * 2 + 1];
      } else {
        cb = p1[ci + cx];
        cr = p2[vi + cx];
      }
      const l = Y[p0[yi + x]];
      out[di] = l + crR[cr];
      out[di + 1] = l - cbG[cb] - crG[cr];
      out[di + 2] = l + cbB[cb];
      out[di + 3] = 255;
    }
  }
  return out;
}
