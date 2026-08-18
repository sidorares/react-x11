// Content-keyed cache of rendered node content (issue #149).
//
// Damage culling already skips subtrees *outside* the damage rect, so an
// unchanged icon in an untouched region costs nothing. This is for the other
// case: a node **inside damage but unchanged**. A theme change, an expose, a
// resize, a sibling's damage rect covering a row of icons, the strip a scroll
// exposes — all of them repaint content that is byte-identical to last frame.
//
// ## Keyed by content, not by node
//
// Per-node ownership would make 400 cells of the same icon into 400 identical
// surfaces. Keying on what is drawn collapses them to one entry per distinct
// drawing — the icon wall's 400 cells become 8 — and it removes invalidation
// entirely: a changed prop produces a different key, so there is never a stale
// entry to detect and evict.
//
// ## Coverage, where the drawing allows it
//
// A drawing that commits to a single colour is cached as an a8 coverage
// surface and painted through the current fill colour, so hover, `:disabled`
// and a theme flip all reuse one entry and the colour stays out of the key.
// Multi-colour drawings bake their colours in, which is right, because those
// colours belong to the drawing. `SvgView.paintKind` decides which is which.
//
// ## Self-limiting, on purpose
//
// X gives no back-pressure: the first sign of overspending is `BadAlloc` on
// `CreatePixmap`, delivered as an async error with no useful attribution. So
// there is a byte budget with LRU eviction (copying `trimGlyphPages` and its
// 8MB), a per-item area cap so one big illustration cannot evict the whole
// useful set, and a "seen twice" gate, because a node painted once and never
// again is a pure loss under a cache.
// Namespace import, not a named one: `Surface` arrives in a later ntk than
// this package pins, and a named import of something absent is a *load-time*
// SyntaxError — the whole renderer, not just the cache. Same shape as the
// `typeof wnd?.scrollRegion !== 'function'` guard for ntk without #139.
import * as ntk from 'ntk';

/** Stale pixels are undebuggable, and every other optimization here has an
 * escape hatch — see NO_SCROLL_BLIT. */
const DISABLED = process.env.REACT_X11_NO_PAINT_CACHE === '1';

/**
 * `verify` re-renders every hit and compares a digest of the drawing calls
 * against the one recorded when the entry was made. A key that fails to name
 * something the paint depends on then fails *loudly*, at the moment it would
 * otherwise have shown a stale pixel — which is the one bug this design can
 * have, and the one that is hardest to find by looking. Slow by construction:
 * it does all the work the cache exists to avoid, plus the comparison.
 */
const VERIFY = process.env.REACT_X11_PAINT_CACHE === 'verify';

const DEBUG = process.env.REACT_X11_DEBUG_PAINT_CACHE === '1';

/** Same budget as ntk's server-side glyph cache, for the same reason: it is
 * enough for any real working set and small enough that a runaway shows up
 * as eviction churn rather than as server memory. */
const DEFAULT_BUDGET = 8 << 20;

/**
 * No single entry may take more than this. One 800x600 illustration is 1.9MB
 * of argb32 and would evict the entire useful set for something drawn once.
 * Widget-sized things stay well under it.
 */
const MAX_ITEM_PIXELS = 256 * 256;

/** How many distinct keys the "seen twice" gate remembers before starting
 * over. Bounded because a page cycling through unique content would otherwise
 * grow this forever; the cost of forgetting is one extra live paint. */
const MAX_PENDING = 4096;

/** Whether a context is drawing 1:1 into device space.
 *
 * A cached surface is pixels at a fixed size and orientation. Under a scaled
 * or rotated CTM, compositing it would *resample* those pixels where a live
 * paint would re-rasterize at the right size, so the cache has to stand
 * aside. react-x11 only ever translates during paint, and only inside
 * `<canvas>`, so this is insurance rather than a live case.
 */
function isDeviceSpace(ctx) {
  const m = ctx.getTransform?.();
  if (!m) return true;
  return (
    m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0
  );
}

// --- the verify-mode digest ------------------------------------------------

/** Fold a string into a 32-bit FNV-1a hash. */
function fold(hash, text) {
  let h = hash;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** One drawing-call argument, as a string a digest can eat. Coordinates are
 * quantized to 1/64 because that is the fixed-point grid X renders on, so
 * float noise below it is not a difference. */
function stamp(value) {
  if (typeof value === 'number') return String(Math.round(value * 64) / 64);
  if (value && typeof value === 'object') {
    if (value._cmds) return JSON.stringify(value._cmds);
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * A context that records everything drawn through it, then draws it. The
 * digest of that recording is what verify mode compares — client-side, so
 * catching a key bug costs no round trip and needs no pixel readback.
 */
function recordingContext(ctx, state) {
  return new Proxy(ctx, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return (...args) => {
        state.digest = fold(state.digest, prop);
        for (const arg of args) state.digest = fold(state.digest, stamp(arg));
        return value.apply(target, args);
      };
    },
    set(target, prop, value) {
      state.digest = fold(fold(state.digest, `=${String(prop)}`), stamp(value));
      target[prop] = value;
      return true;
    },
  });
}

// --- the cache -------------------------------------------------------------

/**
 * One cache per X connection. Surfaces are server-side resources, so two
 * roots on two displays must not share entries — and two roots on the *same*
 * display should, which is why this hangs off the app rather than the root.
 */
export class PaintCache {
  constructor(app, { budget = DEFAULT_BUDGET, verify = VERIFY } = {}) {
    this.app = app;
    this.budget = budget;
    this.verify = verify;
    /** key -> entry. Map iteration is insertion order, so re-inserting on
     * access makes this an LRU list for free — same trick as getGlyphPage. */
    this.entries = new Map();
    /** keys seen once, waiting to be seen again (the "seen twice" gate) */
    this.pending = new Map();
    this.bytes = 0;
    /** entries touched this frame, which eviction must not take */
    this.inUse = new Set();
    this.stats = {
      hits: 0,
      misses: 0,
      renders: 0,
      evictions: 0,
      tooBig: 0,
      failed: 0,
    };
  }

  beginFrame() {
    this.inUse.clear();
  }

  endFrame() {
    this._trim();
    if (DEBUG) {
      const s = this.stats;
      console.log(
        `react-x11: paint cache ${this.entries.size} entries, ` +
          `${(this.bytes / 1024).toFixed(0)}KB — hits ${s.hits} misses ${s.misses} ` +
          `renders ${s.renders} evictions ${s.evictions}` +
          (s.tooBig ? ` too-big ${s.tooBig}` : '') +
          (s.failed ? ` failed ${s.failed}` : ''),
      );
    }
  }

  /**
   * Paint `node`'s content, through the cache when it can be.
   *
   * Every path here falls back to painting live, so the cache can cost
   * correctness nothing: the worst mistake it can make is not firing.
   */
  paint(node, ctx) {
    const plan = node.paintCachePlan(ctx);
    if (!plan) return node.paintContent(ctx);
    return this.drawing(ctx, {
      ...plan,
      label: `<${node.kind}>`,
      draw: (sctx, box) => node.paintCached(sctx, box),
      live: () => node.paintContent(ctx),
    });
  }

  /**
   * Paint a cacheable **drawing**, which a node's content is one kind of.
   *
   * `plan` is the node protocol's plan (`key`, `x`/`y`, `width`/`height`,
   * `format`, `tint`) plus the three things a node supplies implicitly:
   * `draw(sctx, box)` renders into the surface, `live()` paints the same
   * thing straight to the target for every path that declines to cache, and
   * the optional `after(surface)` runs once on a freshly rendered one — for
   * a filter that belongs to the picture rather than to the pixels, which is
   * how a blurred `boxShadow` is a cache entry at all (issue #345).
   *
   * `maxPixels` overrides the per-item cap for a caller whose drawing is
   * legitimately box-sized rather than icon-sized.
   */
  drawing(ctx, plan) {
    if (!isDeviceSpace(ctx)) return plan.live(ctx);

    if (plan.width * plan.height > (plan.maxPixels ?? MAX_ITEM_PIXELS)) {
      this.stats.tooBig++;
      return plan.live(ctx);
    }

    const hit = this.entries.get(plan.key);
    if (hit) {
      // re-insert to mark recent
      this.entries.delete(plan.key);
      this.entries.set(plan.key, hit);
      this.inUse.add(hit);
      this.stats.hits++;
      if (this.verify) this._verify(hit, plan);
      return this._blit(ctx, hit, plan);
    }

    this.stats.misses++;
    const seen = (this.pending.get(plan.key) ?? 0) + 1;
    if (seen < 2) {
      if (this.pending.size >= MAX_PENDING) this.pending.clear();
      this.pending.set(plan.key, seen);
      return plan.live(ctx);
    }
    this.pending.delete(plan.key);

    const entry = this._render(plan);
    if (!entry) return plan.live(ctx);
    this.entries.set(plan.key, entry);
    this.bytes += entry.bytes;
    this.inUse.add(entry);
    return this._blit(ctx, entry, plan);
  }

  _render(plan) {
    try {
      const surface = new ntk.Surface(this.app, {
        width: plan.width,
        height: plan.height,
        format: plan.format,
      });
      const box = { x: 0, y: 0, width: plan.width, height: plan.height };
      const state = { digest: 0x811c9dc5 };
      surface.render((sctx) =>
        plan.draw(this.verify ? recordingContext(sctx, state) : sctx, box),
      );
      plan.after?.(surface);
      this.stats.renders++;
      return {
        key: plan.key,
        surface,
        bytes: surface.bytes,
        digest: this.verify ? state.digest : 0,
      };
    } catch (err) {
      // A server that will not give us a pixmap, a node whose paint threw:
      // either way the live paint below is still correct.
      this.stats.failed++;
      if (DEBUG)
        console.warn('react-x11: paint cache render failed:', err.message);
      return null;
    }
  }

  _blit(ctx, entry, plan) {
    // an a8 entry is coverage: the fill colour is what actually gets painted
    if (plan.format === 'a8') {
      const before = ctx.fillStyle;
      ctx.fillStyle = plan.tint;
      ctx.drawImage(entry.surface, plan.x, plan.y);
      ctx.fillStyle = before;
      return;
    }
    ctx.drawImage(entry.surface, plan.x, plan.y);
  }

  /**
   * Re-render a hit and compare digests. A mismatch means the key did not
   * name everything the paint reads, which is the one way this design
   * produces a wrong pixel rather than a slow frame.
   */
  _verify(entry, plan) {
    const state = { digest: 0x811c9dc5 };
    let scratch = null;
    try {
      scratch = new ntk.Surface(this.app, {
        width: plan.width,
        height: plan.height,
        format: plan.format,
      });
      scratch.render((sctx) =>
        plan.draw(recordingContext(sctx, state), {
          x: 0,
          y: 0,
          width: plan.width,
          height: plan.height,
        }),
      );
    } catch {
      return; // verification is best-effort; never break a frame over it
    } finally {
      scratch?.destroy();
    }
    if (state.digest === entry.digest) return;
    console.error(
      `react-x11: paint cache key does not cover the paint of ${plan.label ?? plan.key}.\n` +
        `  key: ${plan.key}\n` +
        '  The drawing changed while the key did not, so a cached frame would ' +
        'show stale pixels. Add whatever changed to the key.',
    );
  }

  /** Evict least-recently-used entries until the budget is met. Entries drawn
   * this frame are never taken — evicting one would guarantee re-rendering it
   * next frame. */
  _trim() {
    if (this.bytes <= this.budget) return;
    for (const [key, entry] of this.entries) {
      if (this.bytes <= this.budget) break;
      if (this.inUse.has(entry)) continue;
      this.entries.delete(key);
      this.bytes -= entry.bytes;
      entry.surface.destroy();
      this.stats.evictions++;
    }
  }

  destroy() {
    for (const entry of this.entries.values()) entry.surface.destroy();
    this.entries.clear();
    this.pending.clear();
    this.bytes = 0;
    this.inUse.clear();
  }
}

/** Whether the installed ntk can make the surfaces this needs. Older ones
 * cannot, and the answer is simply that nothing is cached. */
export const paintCacheSupported = () => typeof ntk.Surface === 'function';

/**
 * The cache for an app, created on first use. Null when caching is off, when
 * the installed ntk is too old, or when the app cannot make surfaces — the
 * headless mock in the smoke tests has no Render extension, and every node
 * there must paint live.
 */
export function paintCacheFor(app) {
  if (DISABLED || !paintCacheSupported() || !app?.display?.Render) return null;
  return (app._paintCache ??= new PaintCache(app));
}
