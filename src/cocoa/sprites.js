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
// are its animations, keyframes the bridge hands to Core Animation. Or it is
// a **source**, the part's `contents` — a `<video>`'s frames, or its player —
// which the presenter does not paint at all: the source shows itself on the
// layer (src/cocoa/video.js, src/cocoa/player.js), between frames and on its
// own clock, and the layer is exactly the part's rect. A source this bridge
// cannot show is a part declined, drawn by its element like any other. A
// transform is CSS's matrix, which the bridge takes from
// `@windowkit/appkit` 0.19 (`transformForms()`) along with the negative
// delay a part joined half way through needs, so that is the bridge sprites
// ask for: on an older one nothing is asked and every part is drawn by its
// element.
//
// A part none of which shows — scrolled out of its pane, or outside its own
// clip — keeps its layer, cut to show nothing, up to a budget of raster for
// such parts: its element's clock would otherwise run for it, and it is
// already where its animation has it the frame a scroll brings it back. A
// clip with round corners that a square ancestor cuts again is a box of its
// own inside a box of the square one's.
//
// A part may be inside another of its element's (`parent`): a spinner in a
// card that fades. Its layer is lifted inside the parent's, so it fades,
// turns and is cut with it, and the parent's raster leaves it out — the
// presenter hands the parent's `paint` the keys of its children lifted with
// it, and paints it again whenever they change, in the frame they do. The
// parent was asked about everywhere it can be, so a child is asked about
// nothing more where it stays inside the parent's raster, and is its
// element's to draw where it does not, or where its parent is not lifted.

import { RASTER_PAD, RasterState } from './presenter.js';
import { CocoaPlayer, PlayerLift } from './player.js';
import { VideoLift, canLiftVideo } from './video.js';
import { intersectRects, rectContains, rectsOverlap } from '../nodes/rects.js';
import { DEV } from '../nodes/util.js';
import { isVideoFrames } from '../videoframes.js';

// Past this many device pixels on a side a part is drawn by its element: a
// layer's contents are a bitmap, and a page-sized one is a page-sized
// upload for every new version.
const MAX_SIDE = 8192;

// The raster a window keeps for parts that show nothing — scrolled out of
// their pane, or outside their own clip — in device pixels: 32 MB. Past it
// such a part is its element's, which runs it on its own clock.
const HIDDEN_BUDGET = 8 * 1024 * 1024;

// Sorted after the element's children, which its own drawing comes after
// (`Node.paint` paints the children first), and before its next sibling.
const AFTER_CHILDREN = Number.MAX_SAFE_INTEGER;

const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

const ORIGIN = Object.freeze({ x: 0, y: 0 });

// what a part with no part lifted inside it is handed
const NO_KIDS = Object.freeze(new Set());

// keyframes already found good, by the property they were found good for
const CHECKED = new WeakMap();

// where a part can be about its origin, by its one transform animation's
// keyframes, and what that was worked out for (`extentOf`)
const EXTENTS = new WeakMap();

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
  // an element hands the same keyframes over from frame to frame: they
  // are read once
  if (CHECKED.get(values) !== a.property) {
    const value = a.property === 'opacity' ? finite : isMatrix;
    if (!values.every(value)) return false;
    CHECKED.set(values, a.property);
  }
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

/** Is `sprite` a part as `Node.sprites()` documents one? Either it paints
 *  or it has a source to show, never both. */
function isSprite(sprite) {
  if (sprite == null || typeof sprite.key !== 'string') return false;
  if (!isRect(sprite.rect)) return false;
  if (
    sprite.contents != null
      ? sprite.paint !== undefined
      : typeof sprite.paint !== 'function'
  ) {
    return false;
  }
  if (sprite.reach !== undefined && !isRect(sprite.reach)) return false;
  if (sprite.clip !== undefined && !isRect(sprite.clip)) return false;
  if (sprite.parent !== undefined && typeof sprite.parent !== 'string') {
    return false;
  }
  if (
    sprite.clipRadius !== undefined &&
    !(finite(sprite.clipRadius) && sprite.clipRadius >= 0)
  ) {
    return false;
  }
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
  const m0 = sprite.transform ?? IDENTITY;
  // About its origin, where it can be is the same for a part that only
  // moved: kept by its keyframes, which an element hands over from frame
  // to frame, rather than every keyframe mapped every frame.
  const rel = {
    x: reach.x - origin.x,
    y: reach.y - origin.y,
    width: reach.width,
    height: reach.height,
  };
  let turns = null;
  for (const a of sprite.animations ?? []) {
    if (a.property !== 'transform') continue;
    turns = turns === null ? a.values : undefined;
  }
  const key = `${rel.x},${rel.y},${rel.width},${rel.height},${m0.join(',')}`;
  let about = turns ? EXTENTS.get(turns) : null;
  if (about?.key !== key) {
    let box = mapRect(rel, m0, ORIGIN);
    for (const a of sprite.animations ?? []) {
      if (a.property !== 'transform') continue;
      for (const m of a.values) box = unionRect(box, mapRect(rel, m, ORIGIN));
    }
    about = { key, box };
    if (turns) EXTENTS.set(turns, about);
  }
  const box = {
    x: about.box.x + origin.x,
    y: about.box.y + origin.y,
    width: about.box.width,
    height: about.box.height,
  };
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
 *  pixels and padded for antialiasing, untransformed. A source's layer is
 *  the part's rect, which the element has already put on whole pixels so
 *  that the hole it leaves and the layer meet. */
function rasterRectOf(sprite) {
  if (sprite.contents != null) return sprite.rect;
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
    // and a video's frames on a layer need its video surfaces
    this.videos = canLiftVideo(this.native);
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
    // the raster kept for parts that show nothing, this frame
    let hidden = 0;
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
        // inside another of the element's parts: lifted with it or not at
        // all, its parent earlier in the list, and neither of them a source
        let parent = null;
        if (sprite.parent !== undefined) {
          parent = now.get(sprite.parent) ?? null;
          if (!parent || parent.contents !== null || sprite.contents != null) {
            continue;
          }
        }
        const contents = sprite.contents ?? null;
        // a source this bridge cannot show: the element draws it
        if (contents !== null && !this._canShow(contents)) continue;
        const raster = rasterRectOf(sprite);
        // a raster's limit; a source's surface is its own size, whatever
        // the layer is scaled to
        if (
          contents === null &&
          (raster.width > MAX_SIDE || raster.height > MAX_SIDE)
        ) {
          continue;
        }
        // what shows of everywhere it can be: inside its own clip, and the
        // clips of its element's ancestors, which cut its layer (`_clear`)
        const cut = {
          clip: sprite.clip ?? null,
          radius: sprite.clip ? (sprite.clipRadius ?? 0) : 0,
          bounds: null,
        };
        const extent = extentOf(sprite);
        const bounds = cut.clip ? intersectRects(extent, cut.clip) : extent;
        if (parent) {
          // the parent was asked about everywhere it can be, and its layer
          // carries this one: nothing more to ask where it stays inside the
          // parent's raster, and its element draws it where it does not
          if (bounds && !rectContains(rasterRectOf(parent.sprite), bounds)) {
            continue;
          }
          cut.bounds = bounds;
        } else if (!bounds) {
          // its own clip shows nothing of it
          cut.bounds = null;
        } else if (!this.promotion._clear(host, bounds, cut)) {
          continue;
        }
        const shown = cut.bounds;
        // A part that shows nothing stays on its layer, cut to show nothing,
        // so that its element's clock is not kept running for it, and is
        // where it should be the frame a scroll brings it into view — but
        // for a source, and past the budget of raster kept for such parts.
        if (!shown) {
          if (contents !== null) continue;
          const px = raster.width * raster.height;
          if (hidden + px > HIDDEN_BUDGET) continue;
          hidden += px;
        }
        let state = was?.get(sprite.key);
        // a clip that comes or goes is a layer in a box or out of one: lifted
        // again, rather than a running layer moved between parents — and so
        // is a part that shows another source, or stops painting to show
        // one, and one in another layer than it was
        if (
          state &&
          (Boolean(state.clip) !== Boolean(cut.clip) ||
            Boolean(state.outer) !== Boolean(cut.outer) ||
            state.contents !== contents ||
            state.parent !== parent)
        ) {
          this._drop(state, root);
          state = null;
        }
        const lifting = !state;
        if (lifting) {
          state = this._lift(
            host,
            sprite.key,
            cut.clip !== null,
            contents,
            parent,
            Boolean(cut.outer),
          );
        }
        state.sprite = sprite;
        state.clip = cut.clip;
        state.outer = cut.outer ?? null;
        state.radius = cut.radius;
        state.order = parent ? null : [...place, AFTER_CHILDREN, index];
        state.kids = [];
        parent?.kids.push(state);
        // the bitmap under where it shows repaints without it, from this
        // frame on; where it went since, it is the element's own claims
        // that move the hole. A child is under its parent's layer, whose
        // raster leaves it out instead (`sync`).
        if (lifting && !parent && shown) this.promotion._claim(root, shown);
        state.extent = shown;
        now.set(sprite.key, state);
      }
      if (place) this._underDrawn(host, list, now, was, root);
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

  /**
   * An element lists its parts in the order it paints them, and its layers
   * stand in that order above the bitmap. A part this frame turned down is
   * the element's to draw, in the bitmap, under every layer, so a part
   * listed before it — painted under it — may not stay on a layer over it
   * where the two meet: the later part's pixels would be under the earlier
   * one's. An element may then offer a part that a later one of its own
   * overlaps, on the word that the later one is lifted too, and this keeps
   * that word. Walked from the end of the list, so a part given back here
   * is under the ones before it in turn. One inside another's layer goes
   * with that layer, and is not asked.
   */
  _underDrawn(host, list, now, was, root) {
    const drawn = []; // where later parts are in the bitmap
    const giveBack = (state) => {
      for (const kid of state.kids) giveBack(kid);
      now.delete(state.key);
      // one lifted in an earlier frame goes with the rest of those
      if (was?.get(state.key) !== state) this._drop(state, root);
    };
    for (let index = list.length - 1; index >= 0; index--) {
      const sprite = list[index];
      if (!isSprite(sprite) || sprite.parent !== undefined) continue;
      const state = now.get(sprite.key);
      if (state?.sprite === sprite) {
        if (!state.extent) continue; // it shows nothing to be over
        if (!drawn.some((rect) => rectsOverlap(rect, state.extent))) continue;
        giveBack(state);
        drawn.push(state.extent);
        continue;
      }
      // the element draws it, where its own clip lets it show
      const extent = extentOf(sprite);
      const shows = sprite.clip ? intersectRects(extent, sprite.clip) : extent;
      if (shows) drawn.push(shows);
    }
  }

  /** Every lifted part above the bitmap, with its place in the paint
   *  order: not one inside another's layer, which goes with it (`sync`). */
  entries() {
    const out = [];
    for (const lifted of this.hosts.values()) {
      for (const state of lifted.values()) if (!state.parent) out.push(state);
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

  /** Can this bridge show `contents` on a layer by itself? A player always
   *  can: it was made by this bridge, with the layer it plays into. */
  _canShow(contents) {
    if (contents instanceof CocoaPlayer) return !contents.released;
    return isVideoFrames(contents) && this.videos;
  }

  _lift(host, key, clipped, contents = null, parent = null, outered = false) {
    const layer = this.native.createLayer();
    // a part cut to a clip is in a box of the clip's size that masks to it,
    // and the box is what stands among the layers above the bitmap — or
    // among its parent's children, for a part inside another's layer. A
    // clip with round corners that a square one cuts again is in a box of
    // its own inside a box of the square one's (`outer`).
    const above = parent ? parent.layer : this.promotion.rootVisual.layer;
    let box = null;
    let outerBox = null;
    if (clipped) {
      box = this.native.createLayer();
      if (outered) {
        outerBox = this.native.createLayer();
        this.native.addSublayer(above, outerBox);
        this.native.addSublayer(outerBox, box);
      } else {
        this.native.addSublayer(above, box);
      }
      this.native.addSublayer(box, layer);
    } else {
      this.native.addSublayer(above, layer);
    }
    return {
      host,
      key,
      layer,
      box,
      outerBox,
      outerProps: {},
      outer: null, // the square clips around a rounded one, device pixels
      // the part whose layer this one is in, and the parts in this one's
      parent,
      kids: [],
      paintedKids: '',
      boxProps: {},
      clip: null, // device pixels, window coordinates
      radius: 0, // the clip's corners, device pixels
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
      // what shows itself on the layer, for a part with a source
      contents,
      lift:
        contents === null
          ? null
          : contents instanceof CocoaPlayer
            ? new PlayerLift(this.native, contents, layer)
            : new VideoLift(this.native, contents, layer),
    };
  }

  /** Off its layer: the layer and its raster go, its animations are
   *  forgotten, and the bitmap under where it could be repaints with the
   *  element drawing it again. */
  _drop(state, root) {
    state.lift?.release();
    this.native.removeFromSuperlayer(
      state.outerBox ?? state.box ?? state.layer,
    );
    state.raster.release(this.native);
    for (const run of state.runs.values()) this._ends().delete(run.caId);
    state.runs.clear();
    // a child's is under its parent's layer, which paints it again or goes
    // with it
    if (!state.host.destroyed && state.extent && !state.parent) {
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
    // the parts lifted inside it, which its raster leaves out
    const kids = state.kids.map((kid) => kid.key).join('\n');
    // painted again for a new version, and for a raster of another size or
    // with the part at another fraction of a pixel, or with other parts
    // lifted inside it; a move by whole pixels is the layer's alone. A
    // source paints nothing: it shows itself.
    if (
      !state.lift &&
      (state.painted === UNPAINTED ||
        sprite.version !== state.painted ||
        state.rect?.width !== rect.width ||
        state.rect?.height !== rect.height ||
        state.phase !== phase ||
        state.paintedKids !== kids)
    ) {
      this._paint(state, sprite, rect);
      state.phase = phase;
      state.paintedKids = kids;
    }
    state.rect = rect;
    const origin = originOf(sprite);
    const m = sprite.transform ?? IDENTITY;
    // where its layer's coordinates start: the window's corner, or the
    // corner of its parent's raster, for a part inside another's layer
    const base = state.parent?.rect ?? ORIGIN;
    // in a box of the square clips around its own, where a square one cuts
    // a rounded clip again: placed from the window's corner, at the part's
    // place among the layers
    const outer = state.outer;
    if (state.outerBox) {
      const frame = [
        (outer.x - base.x) / s,
        (outer.y - base.y) / s,
        outer.width / s,
        outer.height / s,
      ];
      const was = state.outerProps;
      if (!sameMatrix(was.frame, frame) || was.zPosition !== z) {
        this.native.setLayerProps(state.outerBox, {
          frame,
          masksToBounds: true,
          zPosition: z,
        });
        state.outerProps = { frame, zPosition: z };
      }
    }
    // in its box, where it is cut to a clip: placed from the clip's corner,
    // and the box at the part's place among the layers, or from the outer
    // box's corner inside it
    const clip = state.clip;
    if (state.box) {
      const from = state.outerBox ? outer : base;
      const frame = [
        (clip.x - from.x) / s,
        (clip.y - from.y) / s,
        clip.width / s,
        clip.height / s,
      ];
      const boxZ = state.outerBox ? 0 : z;
      // its corners rounded where the clip's are: a circle's arc, as wide
      // as the box allows
      const cornerRadius =
        Math.min(state.radius, clip.width / 2, clip.height / 2) / s;
      const was = state.boxProps;
      if (
        !sameMatrix(was.frame, frame) ||
        was.zPosition !== boxZ ||
        was.cornerRadius !== cornerRadius
      ) {
        this.native.setLayerProps(state.box, {
          frame,
          masksToBounds: true,
          cornerRadius,
          zPosition: boxZ,
        });
        state.boxProps = { frame, zPosition: boxZ, cornerRadius };
      }
    }
    const ox = state.box ? clip.x : base.x;
    const oy = state.box ? clip.y : base.y;
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
    // a source that fills the layer with a layer of its own
    state.lift?.layout?.(next.bounds);
    // after the model went out, in the same transaction
    this._syncAnimations(state, sprite);
    // the parts inside it, in the element's order, over its raster
    for (let i = 0; i < state.kids.length; i++) {
      this.sync(state.kids[i], i + 1);
    }
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
      sprite.paint(
        ctx,
        state.kids.length ? new Set(state.kids.map((kid) => kid.key)) : NO_KIDS,
      );
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
        state.lift?.release();
        this.native.removeFromSuperlayer(
          state.outerBox ?? state.box ?? state.layer,
        );
        state.raster.release(this.native);
        for (const run of state.runs.values()) this._ends().delete(run.caId);
      }
    }
    this.hosts.clear();
  }
}
