// `<video frames>` on X11 with the server doing the conversion: an XVideo
// port where the display has an image adaptor (ntk/xv;
// design/architecture/video.md §2.6).
//
// The drawn path converts each YCbCr frame in a JavaScript loop over every
// pixel and puts four bytes a pixel on the wire. Through Xv the frame
// crosses as the decoder made it — 1.5 bytes a pixel for NV12 and I420,
// through shared memory on a local display — and the matrix is the server's
// GPU's: glamor's textured adaptor, which Xorg's modesetting driver and
// Xwayland both ship.
//
// Where the frame goes is the record's open question, answered by
// measurement: an adaptor takes no pixmap (`BadWindow` into one on
// Xwayland), so the frame goes into a `VideoTarget` — a manually redirected
// child window outside the window it belongs to, shown nowhere — and from
// there, in one RENDER copy, into the `<video>`'s own surface. Everything
// after that is the drawn path unchanged: the surface is composited in paint
// order, under the window's popups and inside its scroll panes, and painted
// again from without a frame.
//
// Declined, and the frame goes the JavaScript way, where the server has no
// image adaptor (Xvfb, XQuartz, most remote displays), where ntk predates
// ntk/xv, for a full-range frame or a colour space the port cannot be told
// (every adaptor reads video range; one without XV_COLORSPACE reads BT.601
// alone), while the window is not on screen, and for the first frame of a
// size, while the port says how it wants it laid out.
//
// Nothing is asked of the server until a sink or a `<video>` asks: an app
// that shows no video grabs no port and pays no round trip.

const writers = new WeakMap();

/** The writer for `app`'s connection, made on first ask. */
export function xvVideoFor(app) {
  let writer = writers.get(app);
  if (!writer) writers.set(app, (writer = new XvVideo(app)));
  return writer;
}

const same = (planes) => planes;
const swapChroma = (planes) => planes && [planes[0], planes[2], planes[1]];

/** A sink's format, as the formats a port may take it in — the planes put
 *  in the port's order — cheapest first. */
const PORT_FORMATS = {
  NV12: [['NV12', same]],
  I420: [
    ['I420', same],
    ['YV12', swapChroma],
  ],
  BGRA: [['AR24', same]],
};

class XvVideo {
  constructor(app) {
    this.app = app;
    /** `undefined` while it is being asked for, then a VideoPort or null */
    this.port = undefined;
    this._opening = null;
    /** the sizes asked about before the port answered, to lay out once it does */
    this._waiting = [];
    /** surface -> { target, window }: where each `<video>`'s frames go */
    this._targets = new Map();
  }

  /**
   * Start asking for a port, and — for a sink — for the layout of its
   * frames, so its first frame is the only one drawn the slow way. Cheap
   * and idempotent: a sink calls it when it is made.
   */
  prepare(sink) {
    if (this.port === undefined) {
      if (sink) this._waiting.push(sink);
      if (!this._opening) this._open();
      return;
    }
    if (this.port && sink) this._layout(sink);
  }

  _open() {
    this._opening = import('ntk/xv')
      .then(({ openVideoPort }) => openVideoPort(this.app))
      .catch(() => null)
      .then((port) => {
        // a port with nowhere to put a frame — no Composite, so no target —
        // is no port: given back, and the formats are JavaScript's
        if (port && !port.targets) {
          port.close();
          port = null;
        }
        this.port = port;
        const waiting = this._waiting;
        this._waiting = [];
        if (port) for (const sink of waiting) this._layout(sink);
      });
  }

  /** Ask the port how it lays out `sink`'s frames, if it takes them at all. */
  _layout(sink) {
    const choice = this._formatFor(sink);
    if (choice) this.port.layout(choice[0], sink.width, sink.height);
  }

  /**
   * `preferredFormats` on X11 (src/videoframes.js): `null` while the port is
   * being asked for — an answer not to keep — then the YCbCr formats the
   * port takes ahead of BGRA, or BGRA alone where there is no port and every
   * frame is drawn in JavaScript.
   */
  videoFormats() {
    if (this.port === undefined) {
      this.prepare();
      return null;
    }
    if (this.port === null) return ['BGRA'];
    const takes = (name) =>
      PORT_FORMATS[name].some(([format]) => this.port.formats.includes(format));
    return [...['NV12', 'I420'].filter(takes), 'BGRA'];
  }

  /** The port's format for `sink` and how its planes go, or null where the
   *  port cannot show it as the sink means it. */
  _formatFor(sink) {
    const port = this.port;
    if (sink.format !== 'BGRA') {
      if (sink.range !== 'video') return null;
      if (!port.colorSpaces.includes(sink.colorSpace)) return null;
    }
    return (
      PORT_FORMATS[sink.format]?.find(([format]) =>
        port.formats.includes(format),
      ) ?? null
    );
  }

  /**
   * A `<video>`'s frame into `surface`, its drawn presentation: through the
   * port into the node's target, then copied into the surface. False — and
   * the node converts the frame itself — wherever this cannot (see the top).
   */
  writeVideoFrame(surface, sink, frame, node) {
    const port = this.port;
    if (!port) {
      if (port === undefined) this.prepare(sink);
      return false;
    }
    if (port.closed) return false;
    const choice = this._formatFor(sink);
    const window = node?.root?.window;
    if (!choice || !window || typeof window.id !== 'number') return false;
    const [format, order] = choice;
    const { width, height } = sink;
    let kept = this._targets.get(surface);
    if (kept && (kept.window !== window || kept.target.destroyed)) {
      // the node is in another window now, or its window took the target
      // with it
      kept.target.destroy();
      this._targets.delete(surface);
      kept = undefined;
    }
    if (!kept) {
      // the first frame of a size: asked, and drawn the other way meanwhile
      if (!port.layout(format, width, height)) return false;
      const target = port.createTarget(window, { width, height });
      if (!target) return false;
      kept = { target, window };
      this._targets.set(surface, kept);
    }
    const sent = kept.target.put({
      format,
      width,
      height,
      planes: order(frame.planes),
      strides: order(frame.strides),
      colorSpace: sink.colorSpace,
    });
    if (!sent) return false;
    kept.target.copyTo(surface);
    return true;
  }

  /** The node let `surface` go: so does its target. */
  releaseVideoFrame(surface) {
    const kept = this._targets.get(surface);
    if (!kept) return;
    this._targets.delete(surface);
    kept.target.destroy();
  }
}
