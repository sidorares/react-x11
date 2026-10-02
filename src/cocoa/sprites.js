// Sprites on the surface presenter (issue #819): the parts of an element's
// drawing it offers (`Node.sprites()`, src/nodes/sprites.js), each on a
// CALayer of its own above the window's bitmap, with the animations it
// carries run by the render server — a CSS animation inside `<Html>`, say,
// at no JavaScript frame at all.
//
// It is layer promotion with an element's part in place of a node, and it
// is promotion's to run (src/cocoa/promotion.js): the same z-order test,
// asked of the element at everywhere the part can draw (`_clear`), the same
// claim of the bitmap under it on the way onto a layer and off it, one order
// among every layer above the bitmap, and the same rule that declining is
// always safe — a part the frame refuses is one the element draws itself,
// as it would anywhere else. What is the element's and nobody else's is its
// inside: it offers only a part nothing it draws after the part overlaps,
// and it leaves a hole where a lifted one is (`spritesLifted`).
//
// A part's content is a raster the presenter paints by calling the part's
// own `paint`, at opacity 1 and untransformed, and paints again when its
// `version` changes; its opacity and its transform are the layer's, and so
// are its animations, keyframes the bridge hands to Core Animation. A
// transform is CSS's matrix, which the bridge takes from
// `@windowkit/appkit` 0.19 (`transformForms()`) along with the negative
// delay a part joined half way through needs, so that is the bridge sprites
// ask for: on an older one nothing is asked and every part is drawn by its
// element.

import { RASTER_PAD, RasterState } from './presenter.js';
import { intersectRects } from '../nodes/rects.js';
import { DEV } from '../nodes/util.js';

// Past this many device pixels on a side a part is drawn by its element: a
// layer's contents are a bitmap, and a page-sized one is a page-sized
// upload for every new version.
const MAX_SIDE = 8192;

// Sorted after the element's children, which its own drawing comes after
// (`Node.paint` paints the children first), and before its next sibling.
const AFTER_CHILDREN = Number.MAX_SAFE_INTEGER;

const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

// what a part's raster holds before its first paint
const UNPAINTED = Symbol('unpainted');

// the ids the bridge reports an animation's end under: unique per process,
// looked up per app (`_animationEnds`), like LayerAnimations'
let spriteSeq = 0;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

const isRect = (r) =>
  r != null &&
  finite(r.x) &&
  finite(r.y) &&
  finite(r.width) &&
  finite(r.height) &&
  r.width > 0 &&
  r.height > 0;

const isMatrix = (m) => Array.isArray(m) && m.length === 6 && m.every(finite);

const isCurve = (t) =>
  typeof t === 'string' ||
  (Array.isArray(t) &&
    t.length === 4 &&
    t.every(finite) &&
    t[0] >= 0 &&
    t[0] <= 1 &&
    t[2] >= 0 &&
    t[2] <= 1);

/** Is `a` an animation the bridge will take as it is — so that a bad one
 *  is refused here rather than thrown from inside a frame? */
function isAnimation(a) {
  if (a == null || typeof a.id !== 'string') return false;
  if (a.property !== 'opacity' && a.property !== 'transform') return false;
  if (!finite(a.duration) || !(a.duration > 0)) return false;
  const values = a.values;
  if (!Array.isArray(values) || values.length < 2) return false;
  const value = a.property === 'opacity' ? finite : isMatrix;
  if (!values.every(value)) return false;
  if (a.keyTimes !== undefined) {
    const t = a.keyTimes;
    if (!Array.isArray(t) || t.length !== values.length || t[0] !== 0) {
      return false;
    }
    for (let i = 0; i < t.length; i++) {
      if (!finite(t[i]) || t[i] > 1 || (i > 0 && t[i] < t[i - 1])) {
        return false;
      }
    }
  }
  if (a.timings !== undefined) {
    const t = a.timings;
    if (!Array.isArray(t) || t.length !== values.length - 1) return false;
    if (!t.every(isCurve)) return false;
  }
  if (a.delay !== undefined && !finite(a.delay)) return false;
  if (
    a.repeat !== undefined &&
    !(a.repeat === Infinity || (finite(a.repeat) && a.repeat > 0))
  ) {
    return false;
  }
  return true;
}

/** Is `sprite` a part as `Node.sprites()` documents one? */
function isSprite(sprite) {
  if (sprite == null || typeof sprite.key !== 'string') return false;
  if (!isRect(sprite.rect) || typeof sprite.paint !== 'function') return false;
  if (sprite.reach !== undefined && !isRect(sprite.reach)) return false;
  if (sprite.clip !== undefined && !isRect(sprite.clip)) return false;
  if (sprite.opacity !== undefined && !finite(sprite.opacity)) return false;
  if (sprite.transform !== undefined && !isMatrix(sprite.transform)) {
    return false;
  }
  if (
    sprite.origin !== undefined &&
    !(
      sprite.origin != null &&
      finite(sprite.origin.x) &&
      finite(sprite.origin.y)
    )
  ) {
    return false;
  }
  const animations = sprite.animations;
  if (animations !== undefined) {
    if (!Array.isArray(animations) || !animations.every(isAnimation)) {
      return false;
    }
  }
  return true;
}

const originOf = (sprite) =>
  sprite.origin ?? {
    x: sprite.rect.x + sprite.rect.width / 2,
    y: sprite.rect.y + sprite.rect.height / 2,
  };

/** `rect` through `m` about `origin`: the bounds of its four corners. */
function mapRect(rect, m, origin) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [px, py] of [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ]) {
    const dx = px - origin.x;
    const dy = py - origin.y;
    const x = m[0] * dx + m[2] * dy + m[4] + origin.x;
    const y = m[1] * dx + m[3] * dy + m[5] + origin.y;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function unionRect(a, b) {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * Everywhere `sprite` can draw while its animations run: its reach through
 * its own transform and every transform it is animated through, out to
 * whole pixels and the antialiasing a raster is padded for. Between two
 * keyframes Core Animation interpolates the matrices by their parts, which
 * stays within a pixel of the two for the densely sampled keyframes a CSS
 * transform arrives as; an element whose keyframes are far apart, or whose
 * curve overshoots, offers a `reach` that covers what is between them.
 */
function extentOf(sprite) {
  const reach = sprite.reach ?? sprite.rect;
  const origin = originOf(sprite);
  let box = mapRect(reach, sprite.transform ?? IDENTITY, origin);
  for (const a of sprite.animations ?? []) {
    if (a.property !== 'transform') continue;
    for (const m of a.values) box = unionRect(box, mapRect(reach, m, origin));
  }
  const x = Math.floor(box.x) - RASTER_PAD;
  const y = Math.floor(box.y) - RASTER_PAD;
  return {
    x,
    y,
    width: Math.ceil(box.x + box.width) + RASTER_PAD - x,
    height: Math.ceil(box.y + box.height) + RASTER_PAD - y,
  };
}

/** The raster a part's content is painted into: its reach, out to whole
 *  pixels and padded for antialiasing, untransformed. */
function rasterRectOf(sprite) {
  const reach = sprite.reach ?? sprite.rect;
  const x = Math.floor(reach.x) - RASTER_PAD;
  const y = Math.floor(reach.y) - RASTER_PAD;
  return {
    x,
    y,
    width: Math.ceil(reach.x + reach.width) + RASTER_PAD - x,
    height: Math.ceil(reach.y + reach.height) + RASTER_PAD - y,
  };
}

const sameMatrix = (a, b) =>
  a === b || (a != null && b != null && a.every((v, i) => v === b[i]));

/**
 * The lifted parts of every element in one window: a layer each, its raster,
 * and what the render server runs on it. `CocoaPromotion` asks, decides and
 * syncs through it inside its own frame.
 */
export class SpriteLayers {
  constructor(promotion) {
    this.promotion = promotion;
    this.native = promotion.native;
    this.scale = promotion.scale;
    this.app = promotion.app;
    // a matrix and a negative delay are what a CSS animation needs from the
    // bridge, and @windowkit/appkit 0.19 is where both are
    this.supported = Boolean(
      this.native.transformForms?.()?.includes?.('matrix'),
    );
    this.hosts = new Map(); // element -> Map(key -> state)
    this._warned = new WeakSet();
  }

  _ends() {
    return (this.app._animationEnds ??= new Map());
  }

  _warn(host, message) {
    if (!DEV || this._warned.has(host)) return;
    this._warned.add(host);
    console.warn(`react-x11: <${host.kind}> ${message}`);
  }

  /**
   * Every element's answer this frame, before anything is decided: the
   * elements that offer a part, and what they offer. An element that throws
   * offers nothing and draws everything, which is what it would do anywhere
   * else.
   */
  ask(root) {
    const offers = new Map();
    if (!this.supported) return offers;
    for (const host of root._spriteNodes ?? []) {
      if (host.destroyed) continue;
      let list = null;
      try {
        list = host.sprites();
      } catch (err) {
        this._warn(
          host,
          `sprites() threw, and its parts are drawn by it: ${err?.message ?? err}`,
        );
      }
      if (Array.isArray(list) && list.length !== 0) offers.set(host, list);
    }
    return offers;
  }

  /**
   * Which offered parts go on layers this frame, against the scene as laid
   * out and the layers promotion has decided on: a part is lifted, kept, or
   * given back. Answers the elements whose set of lifted parts changed.
   */
  decide(root, offers) {
    const changed = new Set();
    for (const [host, lifted] of this.hosts) {
      if (offers.has(host)) continue;
      for (const state of lifted.values()) this._drop(state, root);
      this.hosts.delete(host);
      if (!host.destroyed) changed.add(host);
    }
    for (const [host, list] of offers) {
      const was = this.hosts.get(host);
      const now = new Map();
      // where the element stands in the paint order, or null where none of
      // it may go on a layer: hidden, faded, inside a <glarea>
      const place = this.promotion._spritePlace(host);
      for (let index = 0; place && index < list.length; index++) {
        const sprite = list[index];
        if (!isSprite(sprite)) {
          this._warn(
            host,
            `offered a sprite that is not one (${JSON.stringify(sprite?.key)}); see Node.sprites()`,
          );
          continue;
        }
        if (now.has(sprite.key)) continue;
        const raster = rasterRectOf(sprite);
        if (raster.width > MAX_SIDE || raster.height > MAX_SIDE) continue;
        // what shows of everywhere it can be: inside its own clip, and the
        // clips of its element's ancestors, which cut its layer (`_clear`)
        const cut = { clip: sprite.clip ?? null, bounds: null };
        const extent = extentOf(sprite);
        const bounds = cut.clip ? intersectRects(extent, cut.clip) : extent;
        if (!bounds || !this.promotion._clear(host, bounds, cut)) continue;
        const shown = cut.bounds;
        let state = was?.get(sprite.key);
        // a clip that comes or goes is a layer in a box or out of one: lifted
        // again, rather than a running layer moved between parents
        if (state && Boolean(state.clip) !== Boolean(cut.clip)) {
          this._drop(state, root);
          state = null;
        }
        const lifting = !state;
        if (lifting) state = this._lift(host, sprite.key, cut.clip !== null);
        state.sprite = sprite;
        state.clip = cut.clip;
        state.order = [...place, AFTER_CHILDREN, index];
        // the bitmap under where it shows repaints without it, from this
        // frame on; where it went since, it is the element's own claims
        // that move the hole
        if (lifting) this.promotion._claim(root, shown);
        state.extent = shown;
        now.set(sprite.key, state);
      }
      if (was) {
        for (const [key, state] of was) {
          if (!now.has(key)) this._drop(state, root);
        }
      }
      if (now.size !== 0) this.hosts.set(host, now);
      else this.hosts.delete(host);
      const before = was?.size ?? 0;
      if (before !== now.size || [...now.keys()].some((k) => !was.has(k))) {
        changed.add(host);
      }
    }
    return changed;
  }

  /** Every lifted part, with its place in the paint order. */
  entries() {
    const out = [];
    for (const lifted of this.hosts.values()) {
      for (const state of lifted.values()) out.push(state);
    }
    return out;
  }

  /** Tell each element that changed which of its parts are lifted now —
   *  after the decisions, before the frame paints. */
  notify(changed) {
    for (const host of changed) {
      if (host.destroyed) continue;
      const keys = new Set(this.hosts.get(host)?.keys() ?? []);
      try {
        host.spritesLifted(keys);
      } catch (err) {
        this._warn(host, `spritesLifted() threw: ${err?.message ?? err}`);
      }
    }
  }

  _lift(host, key, clipped) {
    const layer = this.native.createLayer();
    // a part cut to a clip is in a box of the clip's size that masks to it,
    // and the box is what stands among the layers above the bitmap
    let box = null;
    if (clipped) {
      box = this.native.createLayer();
      this.native.addSublayer(this.promotion.rootVisual.layer, box);
      this.native.addSublayer(box, layer);
    } else {
      this.native.addSublayer(this.promotion.rootVisual.layer, layer);
    }
    return {
      host,
      key,
      layer,
      box,
      boxProps: {},
      clip: null, // device pixels, window coordinates
      raster: new RasterState(),
      painted: UNPAINTED,
      rect: null, // the raster's rect, device pixels, window coordinates
      phase: null, // where in a pixel its reach starts
      props: {},
      runs: new Map(), // element's animation id -> { caId, caKey, held }
      // ids the render server is done with, while the element still lists
      // them: an animation is attached once per id, and an end the element
      // has not caught up with must not start it again
      done: new Set(),
      sprite: null,
      extent: null,
      order: null,
    };
  }

  /** Off its layer: the layer and its raster go, its animations are
   *  forgotten, and the bitmap under where it could be repaints with the
   *  element drawing it again. */
  _drop(state, root) {
    this.native.removeFromSuperlayer(state.box ?? state.layer);
    state.raster.release(this.native);
    for (const run of state.runs.values()) this._ends().delete(run.caId);
    state.runs.clear();
    if (!state.host.destroyed && state.extent) {
      this.promotion._claim(root, state.extent);
    }
  }

  /** The layer as the part says, at `z` among the layers above the bitmap. */
  sync(state, z) {
    const sprite = state.sprite;
    const s = this.scale;
    const rect = rasterRectOf(sprite);
    const reach = sprite.reach ?? sprite.rect;
    const phase = `${reach.x - Math.floor(reach.x)},${reach.y - Math.floor(reach.y)}`;
    // painted again for a new version, and for a raster of another size or
    // with the part at another fraction of a pixel; a move by whole pixels
    // is the layer's alone
    if (
      state.painted === UNPAINTED ||
      sprite.version !== state.painted ||
      state.rect?.width !== rect.width ||
      state.rect?.height !== rect.height ||
      state.phase !== phase
    ) {
      this._paint(state, sprite, rect);
      state.phase = phase;
    }
    state.rect = rect;
    const origin = originOf(sprite);
    const m = sprite.transform ?? IDENTITY;
    // in its box, where it is cut to a clip: placed from the clip's corner,
    // and the box at the part's place among the layers
    const clip = state.clip;
    if (state.box) {
      const frame = [clip.x / s, clip.y / s, clip.width / s, clip.height / s];
      const was = state.boxProps;
      if (!sameMatrix(was.frame, frame) || was.zPosition !== z) {
        this.native.setLayerProps(state.box, {
          frame,
          masksToBounds: true,
          zPosition: z,
        });
        state.boxProps = { frame, zPosition: z };
      }
    }
    const ox = state.box ? clip.x : 0;
    const oy = state.box ? clip.y : 0;
    const next = {
      bounds: [0, 0, rect.width / s, rect.height / s],
      anchorPoint: [
        (origin.x - rect.x) / rect.width,
        (origin.y - rect.y) / rect.height,
      ],
      position: [(origin.x - ox) / s, (origin.y - oy) / s],
      zPosition: state.box ? 0 : z,
      opacity: Math.min(1, Math.max(0, sprite.opacity ?? 1)),
      matrix: m,
    };
    const prev = state.props;
    const out = {};
    let any = false;
    for (const key of ['bounds', 'anchorPoint', 'position']) {
      if (!sameMatrix(prev[key], next[key])) {
        out[key] = next[key];
        any = true;
      }
    }
    for (const key of ['zPosition', 'opacity']) {
      if (prev[key] !== next[key]) {
        out[key] = next[key];
        any = true;
      }
    }
    if (!sameMatrix(prev.matrix, m)) {
      out.transform = { matrix: [m[0], m[1], m[2], m[3], m[4] / s, m[5] / s] };
      any = true;
    }
    if (any) this.native.setLayerProps(state.layer, out);
    state.props = next;
    // after the model went out, in the same transaction
    this._syncAnimations(state, sprite);
  }

  _paint(state, sprite, rect) {
    const ctx = state.raster.ensure(
      this.promotion,
      rect.width,
      rect.height,
      this.scale,
    );
    const root = state.host.root;
    ctx.save();
    try {
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.translate(-rect.x, -rect.y);
      // a part paints whole: there is no pass to cull it by
      if (root) root._paintDamage = null;
      sprite.paint(ctx);
    } catch (err) {
      this._warn(
        state.host,
        `a sprite's paint() threw: ${err?.message ?? err}`,
      );
    } finally {
      ctx.restore();
    }
    this.native.surfaceToLayer(state.raster.surface, state.layer);
    state.painted = sprite.version;
  }

  /** What runs on the layer, by the element's ids: one gone from the part
   *  comes off, one new to it goes on, and one already on is left alone —
   *  its `delay` is counted from the frame that asks, so it moves every
   *  frame and means nothing past the first. */
  _syncAnimations(state, sprite) {
    const wanted = sprite.animations ?? [];
    const listed = (id) => wanted.some((a) => a.id === id);
    for (const [id, run] of state.runs) {
      if (listed(id)) continue;
      this.native.removeAnimation(state.layer, run.caKey);
      this._ends().delete(run.caId);
      state.runs.delete(id);
    }
    for (const id of state.done) if (!listed(id)) state.done.delete(id);
    const s = this.scale;
    for (const a of wanted) {
      if (state.runs.has(a.id) || state.done.has(a.id)) continue;
      const caId = `rxs${++spriteSeq}`;
      const caKey = `sprite:${caId}`;
      const opts = {
        values:
          a.property === 'transform'
            ? a.values.map((m) => ({
                matrix: [m[0], m[1], m[2], m[3], m[4] / s, m[5] / s],
              }))
            : a.values,
        duration: a.duration / 1000,
        id: caId,
      };
      if (a.keyTimes) opts.keyTimes = a.keyTimes;
      if (a.timings) opts.timings = a.timings;
      if (a.repeat !== undefined) opts.repeat = a.repeat;
      if (a.autoreverse) opts.autoreverse = true;
      if (a.hold) opts.hold = true;
      // from the frame that asked: ahead, or already that far in
      if (a.delay) opts.delay = a.delay / 1000;
      try {
        this.native.addAnimation(state.layer, a.property, opts, caKey);
      } catch (err) {
        this._warn(
          state.host,
          `the bridge refused sprite animation ${JSON.stringify(a.id)}: ${err?.message ?? err}`,
        );
        continue;
      }
      state.runs.set(a.id, { caId, caKey, held: Boolean(a.hold) });
      this._ends().set(caId, (ev) => this._ended(state, a.id, caId, ev));
    }
  }

  /** The bridge's `animation-end` for one of ours. A held one stays on the
   *  layer, showing its last value, until the element stops listing it. */
  _ended(state, id, caId, ev) {
    this._ends().delete(caId);
    const run = state.runs.get(id);
    if (run?.caId === caId) {
      state.done.add(id);
      if (!run.held) state.runs.delete(id);
    }
    if (state.host.destroyed) return;
    try {
      state.host.spriteAnimationEnded(state.key, id, ev?.finished !== false);
    } catch (err) {
      this._warn(
        state.host,
        `spriteAnimationEnded() threw: ${err?.message ?? err}`,
      );
    }
  }

  /** Everything off the root and freed: the window is going. */
  destroy() {
    for (const lifted of this.hosts.values()) {
      for (const state of lifted.values()) {
        this.native.removeFromSuperlayer(state.box ?? state.layer);
        state.raster.release(this.native);
        for (const run of state.runs.values()) this._ends().delete(run.caId);
      }
    }
    this.hosts.clear();
  }
}
