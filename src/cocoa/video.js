// A video's frames on a layer of their own (docs/architecture/video.md §7):
// what the surface presenter's sprites (src/cocoa/sprites.js) do with a part
// whose `contents` is a `VideoFrames` sink instead of a `paint`.
//
// Every frame goes into a video surface — an IOSurface the render server
// scans out as it is, NV12 for a YCbCr sink and BGRA for a BGRA one
// (@windowkit/appkit's createVideoSurface) — and the layer is repointed at
// it, inside the `push` that delivered it: a layer change of its own, with
// no react-x11 frame, no paint and nothing for the frame pacer to price. At
// 1080p that is the copy in (0.07ms for NV12, 0.27ms for an I420 frame
// interleaved on the way) and a transaction.
//
// The surfaces are a ring, because a surface the render server is still
// reading — the one on screen, and in threaded mode the one a queued frame
// has not taken off the layer yet — is torn by a write. A frame goes into
// one `videoSurfaceIsInUse` says nothing reads, a new one is made while the
// ring is short, and with every one of them busy the frame waits for the
// next push or a short retry: the newest frame is the frame, and a dropped
// one is the cheapest thing to lose.
//
// The verbs are asked for by name (`canLiftVideo`), and a bridge without
// them lifts nothing: the part is declined and the element draws its frames,
// which is what it does on every other backend.

// Two would do in pump mode — one on screen, one being written — and a
// worker's queued flip holds a third.
const RING_MAX = 4;
// With the whole ring busy, how soon to try the newest frame again: about a
// display frame, since that is how often the render server lets one go.
const RETRY_MS = 8;

/** Has `native` the verbs a lifted video needs? */
export function canLiftVideo(native) {
  return (
    typeof native?.createVideoSurface === 'function' &&
    typeof native.writeVideoSurface === 'function' &&
    typeof native.videoSurfaceIsInUse === 'function' &&
    typeof native.setLayerContentsIOSurface === 'function'
  );
}

/**
 * A sink's frames on `layer`, from the frame it holds now until `release()`.
 * Placing the layer — its bounds, its place among the others, the box that
 * cuts it to a clip — is the presenter's; this only ever sets what it shows.
 */
export class VideoLift {
  constructor(native, sink, layer) {
    this.native = native;
    this.sink = sink;
    this.layer = layer;
    this.ring = []; // { handle, id }
    this.current = null;
    this.shown = 0; // the version on the layer
    this.released = false;
    this._retry = null;
    this._unsubscribe = sink._subscribe((frame) => this._show(frame));
    if (sink.frame) this._show(sink.frame);
  }

  /** A surface nothing reads, or a new one while the ring is short. */
  _free() {
    const native = this.native;
    for (const s of this.ring) {
      if (s !== this.current && !native.videoSurfaceIsInUse(s.handle)) {
        return s;
      }
    }
    if (this.ring.length >= RING_MAX) return null;
    const sink = this.sink;
    const made = native.createVideoSurface(sink.width, sink.height, {
      // a YCbCr frame stays YCbCr, I420 interleaved by the write; the
      // render server converts it, in the colour the sink says it is
      format: sink.format === 'BGRA' ? 'BGRA' : 'NV12',
      colorSpace: sink.colorSpace,
      range: sink.range,
    });
    const s = { handle: made.handle, id: made.iosurfaceId };
    this.ring.push(s);
    return s;
  }

  _show(frame) {
    if (this.released || frame === null) return;
    const s = this._free();
    if (!s) {
      this._again();
      return;
    }
    this.native.writeVideoSurface(s.handle, this.sink.format, frame.planes, {
      strides: frame.strides,
    });
    // its own transaction, actions off, in pump mode; a command of its own
    // from a worker
    this.native.setLayerContentsIOSurface(this.layer, s.id);
    this.current = s;
    this.shown = frame.version;
  }

  _again() {
    if (this._retry) return;
    this._retry = setTimeout(() => {
      this._retry = null;
      const frame = this.sink.frame;
      if (frame && frame.version !== this.shown) this._show(frame);
    }, RETRY_MS);
    this._retry.unref?.();
  }

  /** Off the layer: no more frames, and the surfaces freed — the layer
   *  holds the one it shows until the presenter takes it away. */
  release() {
    if (this.released) return;
    this.released = true;
    this._unsubscribe();
    if (this._retry) clearTimeout(this._retry);
    this._retry = null;
    for (const s of this.ring) this.native.releaseVideoSurface?.(s.handle);
    this.ring = [];
    this.current = null;
  }
}
