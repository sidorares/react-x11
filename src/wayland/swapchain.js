// The swap chain behind the Wayland direct rendering context: GPU buffers in,
// `wl_buffer`s out, and the bookkeeping that keeps the two in step.
//
// A frame's life:
//
//   draw into the backing target (target.js)
//   blit the changed rectangles into the swapchain's back buffer
//   surface.swap()  ->  dma-buf fd (first time only)
//                   ->  zwp_linux_dmabuf_v1  -> a wl_buffer for that buffer
//                   ->  attach + damage_buffer + commit
//                   <-  wl_buffer.release    -> the buffer is ours again
//
// This is ntk's `GLSwapchain` with three substitutions — `PixmapFromBuffer`
// becomes the dmabuf import, `Present.Pixmap` becomes attach/damage/commit,
// and `PresentIdleNotify` becomes `wl_buffer.release`.
//
// The rule that shapes it survives the port unchanged: **a buffer belongs to
// the compositor until it says otherwise** — drawing into one before then
// paints whatever is on screen — so a buffer goes back to GBM on
// `wl_buffer.release` and nowhere else.
//
// ## Buffer age, and why painting happens elsewhere
//
// An shm client owns one piece of memory and can repaint exactly the rows it
// touched. A swapchain rotates buffers, so the buffer a frame lands in last
// showed the frame before last (or earlier), and a partial repaint into it
// leaves stale pixels everywhere it did not touch. react-x11's renderer is
// built around partial repaints, so the frame is *not* painted into the
// swapchain buffer: it is painted into a persistent target and copied across.
// What has to be copied is everything that changed since *this buffer* was
// last shown — which is tracked per buffer below — and what has to be told
// to the compositor is the same set, so it re-composites no more than it
// must.
//
// There is one wrinkle: GBM names the buffer only *after* `swap()`, and the
// copy has to happen before. So the copy uses `blitHint()`: the union of
// every known buffer's debt, which is at least what the next one needs; and
// while the chain is still meeting new buffers — after creation or a resize —
// everything, since a buffer never seen has no known debt. Steady state is
// reached once a full rotation has passed without a new buffer, and from then
// on the copy is the tight union.
//
// ## What x11-dri 0.8.0 changed here
//
// This file used to carry a `Generation` class that retired the whole GBM
// surface on every resize and swept it as buffers came back, because there
// was no in-place resize (node-x11-dri#20). `Surface.resize()` replaced all
// of it: the surface keeps its identity and its GL objects, only the buffers
// change, and resizing to the size it already has is free.
//
// The same release fixed a hazard this code was exposed to. Buffer `key`s
// are unique only *within* a generation and GEM handles are recycled, so a
// cache keyed on `key` alone can hand a stale entry to a live buffer, and a
// late `release(key)` can free the wrong one. Keys are namespaced by
// `generation` and releases pass `{ key, generation }`.

import { importDmabuf, DmabufRefused } from './dmabuf.js';

/** How many frames may be in the compositor's hands at once. */
const DEFAULT_MAX_IN_FLIGHT = 2;

/**
 * Damage sets are kept small: past a handful of rectangles the bookkeeping
 * costs more than the full-surface copy it is trying to avoid, and the
 * compositor clips to the surface anyway.
 */
const MAX_RECTS = 8;

export class WaylandSwapchain {
  /**
   * @param {object} opts
   * @param {object} opts.surface the `wl_surface` presented to
   * @param {object} opts.dmabuf a bound `zwp_linux_dmabuf_v1`
   * @param {object} opts.gpu an x11-dri `Gpu`
   * @param {object} opts.dri the x11-dri module
   * @param {number} opts.format a DRM fourcc, matching the Gpu's
   * @param {object} [opts.policy]
   */
  constructor({ surface, dmabuf, gpu, dri, format, policy = {} }) {
    this.surface = surface;
    this.dmabuf = dmabuf;
    this.gpu = gpu;
    this.dri = dri;
    this.format = format;
    this.policy = {
      maxInFlight: DEFAULT_MAX_IN_FLIGHT,
      linearFallback: true,
      ...policy,
    };

    /** the one GBM swapchain, resized in place */
    this.gbm = null;
    /** `${generation}:${key}` -> { wlBuffer, busy, damage, key, generation } */
    this.buffers = new Map();
    this.width = 0;
    this.height = 0;
    /** set once the compositor has refused a tiled buffer */
    this.linear = false;
    /** swaps since a buffer was last seen for the first time */
    this._swapsSinceNew = 0;

    this.inFlight = 0;
    this.importing = false;
    this.starved = false;
    this.destroyed = false;
    this.error = null;
    this.onReady = null;
    this.onError = null;
  }

  /**
   * Point the chain at a size.
   *
   * @returns the GBM surface to draw into
   */
  surfaceFor(width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (!this.gbm) return this._create(w, h);
    if (w === this.width && h === this.height) return this.gbm;

    // In place: the handle stays valid, the context keeps its GL objects and
    // stays current. Buffers from the old generation are gone, so their
    // `wl_buffer`s go with them — the compositor may still be showing one, so
    // the wl_buffer is destroyed and it will simply never be attached again.
    try {
      this.gbm.resize(w, h);
    } catch (err) {
      this._fail(
        new Error(
          `could not resize the GPU surface to ${w}x${h}: ${err.message}`,
          { cause: err },
        ),
      );
      return this.gbm;
    }
    this._dropBuffers();
    this.width = w;
    this.height = h;
    this.inFlight = 0;
    this._swapsSinceNew = 0;
    return this.gbm;
  }

  _create(w, h) {
    const use = this.linear
      ? this.dri.GBM_USE.RENDERING | this.dri.GBM_USE.LINEAR
      : undefined;
    try {
      this.gbm =
        use === undefined
          ? this.gpu.createSurface(w, h)
          : this.gpu.createSurface(w, h, use);
    } catch (err) {
      throw new Error(
        `could not create a ${w}x${h} GPU surface: ${err.message}`,
        { cause: err },
      );
    }
    this.width = w;
    this.height = h;
    this._swapsSinceNew = 0;
    return this.gbm;
  }

  /** Can a frame be drawn and presented right now? */
  canRender() {
    if (this.destroyed || this.error) return false;
    if (this.importing) return false;
    return this.inFlight < this.policy.maxInFlight;
  }

  /** Whether every buffer of the chain has been seen at least once. */
  get steady() {
    return this.buffers.size > 0 && this._swapsSinceNew >= this.buffers.size;
  }

  /**
   * What the next buffer might need copied into it, given what this frame
   * changed: `'all'`, or a list of rectangles.
   */
  blitHint(frameDamage) {
    if (!this.steady) return 'all';
    let acc =
      frameDamage === 'all' || !frameDamage
        ? (frameDamage ?? null)
        : [...frameDamage];
    if (acc === 'all') return 'all';
    for (const entry of this.buffers.values()) {
      acc = unionDamage(acc, entry.damage);
      if (acc === 'all') return 'all';
    }
    return acc ?? [];
  }

  /**
   * Show what was just drawn.
   *
   * Returns false when the frame could not go out. The caller must still
   * commit something — see `WaylandGLContext.endFrame`, which owns that rule.
   */
  async swap(damage) {
    if (this.destroyed || this.error || this.importing) return false;
    if (!this.gbm) return false;

    let out;
    try {
      out = this.gbm.swap();
    } catch (err) {
      this._fail(
        new Error(`GPU buffer swap failed: ${err.message}`, { cause: err }),
      );
      return false;
    }
    if (!out) {
      // every buffer is still on the compositor's side of the fence
      this.starved = true;
      return false;
    }
    this.starved = false;

    const generation = this.gbm.generation;
    const id = `${generation}:${out.key}`;
    const known = this.buffers.get(id);
    if (known) {
      this._swapsSinceNew++;
      this._present(known, damage);
      return true;
    }
    this._swapsSinceNew = 0;
    return await this._import(id, out, generation, damage);
  }

  /**
   * A buffer the compositor has not seen: hand over its descriptor, and only
   * attach once it has taken it.
   */
  async _import(id, out, generation, damage) {
    this.importing = true;
    let wlBuffer;
    try {
      wlBuffer = await importDmabuf(this.dmabuf, out, this.format);
    } catch (err) {
      this.importing = false;
      if (this.destroyed) return false;
      return await this._importFailed(err);
    }
    this.importing = false;
    if (this.destroyed) {
      wlBuffer.$.destroy?.();
      return false;
    }

    // A resize while the import was in flight retires this buffer before it
    // was ever shown. Its GBM buffer is already gone with the old generation;
    // only the wl_buffer needs freeing.
    if (this.gbm.generation !== generation) {
      wlBuffer.$.destroy?.();
      this.onReady?.();
      return false;
    }

    const entry = {
      wlBuffer,
      busy: false,
      damage: null,
      key: out.key,
      generation,
    };
    wlBuffer.on('release', () => this._released(id, entry));
    this.buffers.set(id, entry);
    this._present(entry, damage);
    this.onReady?.();
    return true;
  }

  /**
   * The compositor would not take the buffer. Almost always this means client
   * and compositor are on different DRM devices; a linear buffer fixes it, at
   * the cost of some bandwidth. Worth one retry before giving up.
   */
  async _importFailed(err) {
    if (
      err instanceof DmabufRefused &&
      this.policy.linearFallback &&
      !this.linear
    ) {
      const { width, height } = this;
      this.linear = true;
      this._dropBuffers();
      try {
        this.gbm.destroy();
      } catch {
        /* already gone */
      }
      this.gbm = null;
      try {
        this._create(width, height);
      } catch (retryErr) {
        this._fail(retryErr);
        return false;
      }
      this.onReady?.();
      return false;
    }
    this._fail(
      new Error(
        `${err.message}. Client and compositor are probably on different DRM devices; ` +
          "name the compositor's device with glPolicy: { devicePath: '/dev/dri/renderD###' }.",
        { cause: err },
      ),
    );
    return false;
  }

  /**
   * Attach, damage and commit — synchronously, through the library's `$`
   * path: three writes, no promises, and nothing for the frame to wait on.
   *
   * Damage is accumulated per buffer: what this buffer must repaint is
   * everything that changed since it was last on screen, which is the union
   * of every frame's damage in between.
   */
  _present(entry, damage) {
    for (const other of this.buffers.values()) {
      if (other === entry) continue;
      other.damage = unionDamage(other.damage, damage);
    }
    const owed = unionDamage(entry.damage, damage);
    entry.damage = null;

    entry.busy = true;
    this.inFlight++;

    const s = this.surface.$;
    s.attach(entry.wlBuffer.id, 0, 0);
    if (owed === 'all' || !owed) {
      // `damage_buffer` takes buffer coordinates, which is what a GL frame is
      // drawn in — the older `damage` request is in surface coordinates and
      // would need the scale factor applied.
      s.damage_buffer(0, 0, this.width, this.height);
    } else {
      for (const r of owed)
        s.damage_buffer(
          r.x | 0,
          r.y | 0,
          Math.ceil(r.width),
          Math.ceil(r.height),
        );
    }
    // The caller commits: a frame request and the configure ack ride the
    // same commit, and the caller owns those.
  }

  _released(id, entry) {
    if (!entry.busy) return;
    entry.busy = false;
    this.inFlight = Math.max(0, this.inFlight - 1);
    // Pass the reference, not the key: keys are unique only within a
    // generation and GEM handles are recycled, so a bare key arriving late
    // would free whichever live buffer inherited that handle. `release`
    // answers false for a buffer whose generation is gone, which is the
    // normal outcome after a resize and not an error.
    try {
      this.gbm?.release({ key: entry.key, generation: entry.generation });
    } catch {
      /* the surface may already be gone */
    }
    if (this.starved || this.inFlight < this.policy.maxInFlight)
      this.onReady?.();
  }

  /** Forget every wl_buffer — after a resize, or on the way out. */
  _dropBuffers() {
    for (const entry of this.buffers.values()) {
      try {
        entry.wlBuffer.$.destroy?.();
      } catch {
        /* connection gone */
      }
    }
    this.buffers.clear();
  }

  _fail(err) {
    if (this.error) return;
    this.error = err;
    this.onError?.(err);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._dropBuffers();
    try {
      this.gbm?.destroy();
    } catch {
      /* already gone */
    }
    this.gbm = null;
  }
}

/** Merge damage, where `'all'` means the whole buffer and `null` means none. */
export function unionDamage(a, b) {
  if (a === 'all' || b === 'all') return 'all';
  if (!a) return b ? [...b] : null;
  if (!b) return a;
  const merged = [...a, ...b];
  return merged.length > MAX_RECTS ? 'all' : merged;
}
