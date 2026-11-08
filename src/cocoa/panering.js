// A picture a `<Frame>` host makes for its pane: a ring of shared IOSurfaces
// the host fills and names, and the pane looks up by id and copies out of —
// the pane's own presents, the other way round. Two things are shown down
// this way: a pane's `<video src>`, whose player is the host's
// (src/cocoa/paneplayer.js), and a pane's `<video srcObject>` of a camera,
// whose session is (src/cocoa/panecapture.js).
//
// The ring is three deep because the two processes do not wait on each
// other: the host writes the buffer after the one it last named, so the one
// the pane is told about is not written again for two frames — some 66ms at
// 30fps, against a pane that copies within a display frame of hearing.
//
// A buffer is named by its IOSurface id, and the system gives a freed id to
// the next surface anyone makes, in either process. So the pane answers
// each frame once it has looked the buffer up (`seen`), the host keeps a
// buffer of a ring it retired until the frame naming it is answered
// (`HostRing._freeRing`), and the pane keeps nothing a lookup found at
// another size than the frame says (`PaneRing.lookUp`) — the pane's own
// presents are kept the same way (`CocoaPaneWindow._releaseRing`).

export const RING = 3;

/** `fn()` with a shared buffer's memory locked for the CPU, as IOSurface
 *  asks of anything that reads or writes its bytes; the bridge's verbs are
 *  optional, as they are for the pane's own ring. */
export function locked(native, handle, fn) {
  const lock = typeof native.surfaceLock === 'function';
  if (lock) native.surfaceLock(handle);
  try {
    return fn();
  } finally {
    if (lock) native.surfaceUnlock?.(handle);
  }
}

/** Can a host's ring be read over this bridge? The pane looks the host's
 *  buffers up and copies out of them. */
export function canReadRing(native) {
  return (
    typeof native?.surfaceFromIOSurfaceID === 'function' &&
    typeof native.blitSurface === 'function'
  );
}

/** The host's end: the buffers, which of them a frame in the channel names,
 *  and the ones a retired ring keeps for it. */
export class HostRing {
  constructor(native) {
    this._native = native;
    this._ring = [];
    this._next = 0;
    // Each frame's number, the newest the pane has looked up (`seen`), and
    // the buffers of retired rings a frame it has not looked up yet names:
    // freed as it does (`_freeRing`).
    this._seq = 0;
    this._seenSeq = 0;
    this._retired = [];
  }

  /**
   * The ring's next buffer at `width` x `height`, filled by `fill(handle)` —
   * a bridge verb that copies a frame into a surface and answers `{ width,
   * height, written, … }`, or null for no new frame — under the buffer's
   * lock. `got` is what it answered; `named` is there when it wrote: the
   * buffer's IOSurface id as `surface` and the frame's number as `seq`, both
   * for the message that tells the pane, which answers `seq` once it has
   * looked the buffer up.
   */
  fill(width, height, fill) {
    const buffer = this._buffer(width, height);
    const got = locked(this._native, buffer.handle, () => fill(buffer.handle));
    if (!got?.written) return { got: got ?? null, named: null };
    this._next = (this._next + 1) % RING;
    // the buffer is named in the channel until the pane says otherwise
    // (`_freeRing`)
    buffer.namedSeq = ++this._seq;
    return { got, named: { surface: buffer.iosurfaceId, seq: this._seq } };
  }

  /** The ring's next buffer, at `width` x `height`: a new ring at another
   *  size. Shared, so the pane can look each one up by its id. */
  _buffer(width, height) {
    if (
      this._ring.length === 0 ||
      this._ring[0].width !== width ||
      this._ring[0].height !== height
    ) {
      this._freeRing();
      for (let i = 0; i < RING; i += 1) {
        const made = this._native.createSurfaceIOSurface(
          width,
          height,
          1,
          true,
        );
        this._ring.push({ ...made, width, height });
      }
      this._next = 0;
    }
    return this._ring[this._next];
  }

  /**
   * Let the ring go — all but a buffer a frame names that the pane has not
   * looked up yet. The pane finds a buffer by its IOSurface id, and the
   * system hands a freed id to the next surface anyone makes: the ring of
   * the new size this same call is about to make, the pane's own ring,
   * another process's surface. A frame still in the channel named the id,
   * not the surface, so the pane copied out of whatever had it by the time
   * it looked — the next ring's buffer, unwritten, shown until the next
   * frame came, which for a paused player is the next seek. So that buffer
   * is kept (`_retired`) until the pane says it has looked the frame up
   * (`seen`). One, as a rule, since the pane answers as it reads, and never
   * more than a ring's worth: a pane that stops answering has the oldest
   * freed anyway, the one it is likeliest to have looked up already.
   */
  _freeRing() {
    const ring = this._ring;
    this._ring = [];
    const release = this._native.releaseSurface;
    if (typeof release !== 'function') return;
    for (const buffer of ring) {
      if (buffer.namedSeq > this._seenSeq) this._retired.push(buffer);
      else release.call(this._native, buffer.handle);
    }
    while (this._retired.length > RING) {
      release.call(this._native, this._retired.shift().handle);
    }
  }

  /** The pane has looked up every frame up to `seq`: the retired buffers
   *  they named go. */
  seen(seq) {
    if (!(seq > this._seenSeq)) return;
    this._seenSeq = seq;
    if (this._retired.length === 0) return;
    const release = this._native.releaseSurface;
    this._retired = this._retired.filter((buffer) => {
      if (buffer.namedSeq > seq) return true;
      release.call(this._native, buffer.handle);
      return false;
    });
  }

  /** Every buffer, and what retired rings kept: the pane's end is gone, or
   *  the pane is. */
  release() {
    this._freeRing();
    const release = this._native.releaseSurface;
    for (const buffer of this._retired.splice(0)) {
      release?.call(this._native, buffer.handle);
    }
  }
}

/** The pane's end: the host's buffers, looked up by id, and copied out of. */
export class PaneRing {
  /** `onDrop()` hears that every handle looked up so far is let go — a
   *  ring of another size, or `drop()` — so a frame held by one goes too. */
  constructor(native, { onDrop } = {}) {
    this._native = native;
    this._onDrop = onDrop ?? null;
    /** IOSurface id → surface handle */
    this._buffers = new Map();
    this._bufferSize = null;
  }

  /**
   * The buffer the host named, looked up the first time it is named; null
   * where the lookup found none, or found a surface of another size than
   * the frame, which is not the frame's buffer but whatever the id has gone
   * to since (`HostRing._freeRing` says how) — never kept, and never copied
   * out of.
   */
  lookUp(surface, width, height) {
    // a ring of another size is a new ring: the old one's buffers are the
    // host's to free, and these handles only keep them alive
    if (
      this._bufferSize?.width !== width ||
      this._bufferSize?.height !== height
    ) {
      this.drop();
      this._bufferSize = { width, height };
    }
    const known = this._buffers.get(surface);
    if (known) return known;
    let found;
    try {
      found = this._native.surfaceFromIOSurfaceID(surface, 1);
    } catch {
      // freed before it got here: the next frame is in another buffer
      return null;
    }
    if (found.width !== width || found.height !== height) {
      this._native.releaseSurface?.(found.handle);
      return null;
    }
    this._buffers.set(surface, found.handle);
    return found.handle;
  }

  /** `width` x `height` of the buffer `handle` into the surface `target`
   *  (a `blitSurface` memcpy). */
  copy(handle, width, height, target) {
    locked(this._native, handle, () =>
      this._native.blitSurface(handle, 0, 0, width, height, target, 0, 0),
    );
  }

  drop() {
    const release = this._native.releaseSurface;
    if (typeof release === 'function') {
      for (const handle of this._buffers.values()) {
        release.call(this._native, handle);
      }
    }
    this._buffers.clear();
    this._bufferSize = null;
    this._onDrop?.();
  }
}
