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
// element. Or it is CSS's `matrix3d()`, a part turned out of the plane and
// seen in a perspective, which Core Animation draws through the whole
// matrix on the GPU: a part none of whose corners is behind the viewer, on a
// bridge that takes one (`matrix3d`).
//
// A part none of which shows — scrolled out of its pane, or outside its own
// clip — keeps its layer, cut to show nothing, up to a budget of raster for
// such parts: its element's clock would otherwise run for it, and it is
// already where its animation has it the frame a scroll brings it back. A
// clip with round corners that a square ancestor cuts again is a box of its
// own inside a box of the square one's.
//
// Or a part is its **shadows** alone (`shadows`): CSS's outer box-shadow,
// which its element would blur a pixel at a time and the render server
// draws on the GPU. Each is a layer that casts it — the shape, its corners
// rounded, moved clear of what shows and its shadow offset back by as much,
// so that no spread shows the shape itself — in a box that shows everything
// but the part's own rect, as an outer shadow is never drawn under the box
// that casts it. Core Animation's `shadowRadius` is the Gaussian's
// deviation, which CSS makes half the blur radius: a glow of 200 CSS pixels
// is a radius of 100 points, and measured against `<Html>`'s own shadow a
// level apart. Their blur, colour and offset animate there too.
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

// what a part with no bounds may reach (`_underDrawn`)
const EVERYWHERE = Object.freeze({
  x: -1e9,
  y: -1e9,
  width: 2e9,
  height: 2e9,
});

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

// CSS's `matrix(a, b, c, d, e, f)`, or its `matrix3d()`'s sixteen numbers
const isMatrix = (m) =>
  Array.isArray(m) && (m.length === 6 || m.length === 16) && m.every(finite);

const isSolid = (m) => m.length === 16;

/** Does `sprite` turn out of the plane, at rest or in an animation? */
function solidSprite(sprite) {
  if (sprite.transform && isSolid(sprite.transform)) return true;
  for (const a of sprite.animations ?? []) {
    if (a.property === 'transform' && a.values.some(isSolid)) return true;
  }
  return false;
}

const isCurve = (t) =>
  typeof t === 'string' ||
  (Array.isArray(t) &&
    t.length === 4 &&
    t.every(finite) &&
    t[0] >= 0 &&
    t[0] <= 1 &&
    t[2] >= 0 &&
    t[2] <= 1);

const isColor = (c) => Array.isArray(c) && c.length === 4 && c.every(finite);

const isPair = (p) => Array.isArray(p) && p.length === 2 && p.every(finite);

const isBlur = (v) => finite(v) && v >= 0;

// what each animated property's keyframes are
const VALUE_OF = {
  opacity: finite,
  transform: isMatrix,
  shadowBlur: isBlur,
  shadowColor: isColor,
  shadowOffset: isPair,
};

const SHADOW_PROPERTIES = new Set([
  'shadowBlur',
  'shadowColor',
  'shadowOffset',
]);

const isShadow = (sh) =>
  sh != null &&
  isRect(sh.rect) &&
  isColor(sh.color) &&
  (sh.radius === undefined || isBlur(sh.radius)) &&
  (sh.x === undefined || finite(sh.x)) &&
  (sh.y === undefined || finite(sh.y)) &&
  (sh.blur === undefined || isBlur(sh.blur));

/** Is `sprite` its shadows alone? */
const castsOnly = (sprite) => Array.isArray(sprite.shadows);

/** Is `a` an animation the bridge will take as it is — so that a bad one
 *  is refused here rather than thrown from inside a frame? */
function isAnimation(a) {
  if (a == null || typeof a.id !== 'string') return false;
  const value = Object.hasOwn(VALUE_OF, a.property)
    ? VALUE_OF[a.property]
    : null;
  if (!value) return false;
  if (!finite(a.duration) || !(a.duration > 0)) return false;
  const values = a.values;
  if (!Array.isArray(values) || values.length < 2) return false;
  // an element hands the same keyframes over from frame to frame: they
  // are read once
  if (CHECKED.get(values) !== a.property) {
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
  const shadows = sprite.shadows;
  if (shadows !== undefined) {
    // its shadows alone: nothing painted, nothing shown
    if (sprite.paint !== undefined || sprite.contents != null) return false;
    if (!Array.isArray(shadows) || shadows.length === 0) return false;
    if (!shadows.every(isShadow)) return false;
  } else if (
    sprite.contents != null
      ? sprite.paint !== undefined
      : typeof sprite.paint !== 'function'
  ) {
    return false;
  }
  if (sprite.rectRadius !== undefined && !isBlur(sprite.rectRadius)) {
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
    // a shadow's animation is of one of the part's shadows
    for (const a of animations) {
      if (!SHADOW_PROPERTIES.has(a.property)) continue;
      const i = a.shadow ?? 0;
      if (!Number.isInteger(i) || i < 0 || !(i < (shadows?.length ?? 0))) {
        return false;
      }
    }
  }
  return true;
}

const originOf = (sprite) =>
  sprite.origin ?? {
    x: sprite.rect.x + sprite.rect.width / 2,
    y: sprite.rect.y + sprite.rect.height / 2,
  };

/** `rect` through `m` about `origin`: the bounds of its four corners, or
 *  null where `m` is a matrix3d that puts a corner behind the viewer, past
 *  which the plane's picture has no bounds. */
function mapRect(rect, m, origin) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const solid = isSolid(m);
  for (const [px, py] of [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ]) {
    const dx = px - origin.x;
    const dy = py - origin.y;
    let x;
    let y;
    if (solid) {
      // column-major, as `matrix3d()` writes it: the point (dx, dy, 0, 1)
      const w = m[3] * dx + m[7] * dy + m[15];
      if (!(w > W_NEAR)) return null;
      x = (m[0] * dx + m[4] * dy + m[12]) / w + origin.x;
      y = (m[1] * dx + m[5] * dy + m[13]) / w + origin.y;
    } else {
      x = m[0] * dx + m[2] * dy + m[4] + origin.x;
      y = m[1] * dx + m[3] * dy + m[5] + origin.y;
    }
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// A corner whose w is this close to the viewer's plane is as good as behind
// it: projected that near, it lands off any window.
const W_NEAR = 1e-6;

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
 * How far past its rect a shadow blurred by `blur` shows: three of its
 * deviations, half the blur each (CSS Backgrounds 3, 7.1.1), past which the
 * tail is a fraction of a level; and a pixel more for the antialiased edge
 * of the shape.
 */
const shadowReach = (blur) => Math.ceil(1.5 * blur) + 1;

// where a shadow part's shadows can reach, by its shadows and keyframes
const SHADOW_REACH = new WeakMap();

/**
 * What a part draws, untransformed: its `reach`, or its `rect` — and for a
 * part that is its shadows, everywhere they can be through every keyframe
 * of their blur and offset, with its own `reach` if it gives one.
 */
function reachOf(sprite) {
  if (!castsOnly(sprite)) return sprite.reach ?? sprite.rect;
  const shadows = sprite.shadows;
  const animations = sprite.animations ?? [];
  const kept = SHADOW_REACH.get(shadows);
  if (kept && kept.animations === animations && kept.reach === sprite.reach) {
    return kept.box;
  }
  let box = sprite.reach ?? null;
  for (let i = 0; i < shadows.length; i++) {
    const sh = shadows[i];
    let blur = sh.blur ?? 0;
    let x0 = sh.x ?? 0;
    let x1 = x0;
    let y0 = sh.y ?? 0;
    let y1 = y0;
    for (const a of animations) {
      if ((a.shadow ?? 0) !== i) continue;
      if (a.property === 'shadowBlur') {
        for (const v of a.values) blur = Math.max(blur, v);
      } else if (a.property === 'shadowOffset') {
        for (const [x, y] of a.values) {
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      }
    }
    const pad = shadowReach(blur);
    box = unionRect(box, {
      x: sh.rect.x + x0 - pad,
      y: sh.rect.y + y0 - pad,
      width: sh.rect.width + x1 - x0 + 2 * pad,
      height: sh.rect.height + y1 - y0 + 2 * pad,
    });
  }
  SHADOW_REACH.set(shadows, { animations, reach: sprite.reach, box });
  return box;
}

/**
 * Everywhere `sprite` can draw while its animations run: its reach through
 * its own transform and every transform it is animated through, out to
 * whole pixels and the antialiasing a raster is padded for — or null, where
 * one of those puts a corner of it behind the viewer. Between two
 * keyframes Core Animation interpolates the matrices by their parts, which
 * stays within a pixel of the two for the densely sampled keyframes a CSS
 * transform arrives as; an element whose keyframes are far apart, or whose
 * curve overshoots, offers a `reach` that covers what is between them.
 */
function extentOf(sprite) {
  const reach = reachOf(sprite);
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
      if (a.property !== 'transform' || !box) continue;
      for (const m of a.values) {
        const at = mapRect(rel, m, ORIGIN);
        box = at && unionRect(box, at);
        if (!box) break;
      }
    }
    about = { key, box };
    if (turns) EXTENTS.set(turns, about);
  }
  // a corner behind the viewer, at rest or on the way: nowhere bounded
  if (!about.box) return null;
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
  const reach = reachOf(sprite);
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
  a === b ||
  (a != null &&
    b != null &&
    a.length === b.length &&
    a.every((v, i) => v === b[i]));

/**
 * A part's matrix in device pixels as the bridge takes it, in points: its
 * translation over the scale and, for a matrix3d, its perspective row times
 * it — S⁻¹·M·S, with S scaling x, y and z, so that a turn and a perspective
 * of so many CSS pixels look the same at any scale.
 */
function inPoints(m, s) {
  if (!isSolid(m)) {
    return { matrix: [m[0], m[1], m[2], m[3], m[4] / s, m[5] / s] };
  }
  const p = m.slice();
  p[12] /= s;
  p[13] /= s;
  p[14] /= s;
  p[3] *= s;
  p[7] *= s;
  p[11] *= s;
  return { matrix3d: p };
}

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
    const forms = this.native.transformForms?.();
    this.supported = Boolean(forms?.includes?.('matrix'));
    // and a part turned out of the plane, its matrix3d, the same release
    this.solid = Boolean(forms?.includes?.('matrix3d'));
    // and a video's frames on a layer need its video surfaces
    this.videos = canLiftVideo(this.native);
    // and a part that is its shadows, a box masked by a shape: every
    // bridge that lifts anything has both, but a fake one may not
    this.shadows =
      typeof this.native.createShapeLayer === 'function' &&
      typeof this.native.setShapeProps === 'function';
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
          if (
            !parent ||
            parent.contents !== null ||
            parent.shadow ||
            sprite.contents != null
          ) {
            continue;
          }
        }
        const contents = sprite.contents ?? null;
        // a source this bridge cannot show: the element draws it
        if (contents !== null && !this._canShow(contents)) continue;
        // shadows this bridge cannot mask: the element draws them
        const casts = castsOnly(sprite);
        if (casts && (!this.shadows || parent)) continue;
        const raster = rasterRectOf(sprite);
        // a raster's limit; a source's surface is its own size, whatever
        // the layer is scaled to, and shadows have none
        if (
          contents === null &&
          !casts &&
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
        // turned out of the plane, on a bridge that takes no matrix3d
        if (!this.solid && solidSprite(sprite)) continue;
        const extent = extentOf(sprite);
        // a corner behind the viewer: the element draws it, which it can cut
        // where the plane meets the viewer's
        if (!extent) continue;
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
          const px = casts ? 0 : raster.width * raster.height;
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
            state.parent !== parent ||
            Boolean(state.shadow) !== casts)
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
            casts,
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
      // the element draws it, where its own clip lets it show — anywhere,
      // for one with a corner behind the viewer and no clip
      const extent = extentOf(sprite) ?? EVERYWHERE;
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

  _lift(
    host,
    key,
    clipped,
    contents = null,
    parent = null,
    outered = false,
    casts = false,
  ) {
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
      // the box the casters of a part that is its shadows are in
      shadow: casts ? this._shadowBox(layer) : null,
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
      !state.shadow &&
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
      out.transform = inPoints(m, s);
      any = true;
    }
    if (any) this.native.setLayerProps(state.layer, out);
    state.props = next;
    // a source that fills the layer with a layer of its own
    state.lift?.layout?.(next.bounds);
    // shadows, cast in the layer's coordinates
    if (state.shadow) this._syncShadows(state, sprite, rect);
    // after the model went out, in the same transaction
    this._syncAnimations(state, sprite);
    // the parts inside it, in the element's order, over its raster
    for (let i = 0; i < state.kids.length; i++) {
      this.sync(state.kids[i], i + 1);
    }
  }

  /** The box a shadow part's casters are in, on its layer, and the mask
   *  that shows everything in it but the part's own rect. */
  _shadowBox(layer) {
    const box = this.native.createLayer();
    const mask = this.native.createShapeLayer();
    this.native.addSublayer(layer, box);
    this.native.setLayerProps(box, { mask });
    return { box, mask, casters: [], shape: '', props: [] };
  }

  /**
   * A shadow part's casters, as its shadows say, in the layer's points:
   * each the shadow's shape, rounded, moved left past the layer's edge —
   * out of the box's mask, which only shows inside the layer — and its
   * shadow offset back by as much, so the shape itself never shows,
   * whatever its spread; blurred by a radius half the CSS blur, which is
   * the deviation of the Gaussian CSS blurs by (calibrated against
   * `<Html>`'s own: a level apart). The first shadow is on top: added last.
   */
  _syncShadows(state, sprite, rect) {
    const s = this.scale;
    const sh = state.shadow;
    const shadows = sprite.shadows;
    const w = rect.width / s;
    const h = rect.height / s;
    // the box, and its mask: all of the layer but the part's rect
    const hole = sprite.rect;
    const hw = hole.width / s;
    const hh = hole.height / s;
    const hr = Math.min((sprite.rectRadius ?? 0) / s, hw / 2, hh / 2);
    const shape = [
      ['rect', 0, 0, w, h],
      ['roundRect', (hole.x - rect.x) / s, (hole.y - rect.y) / s, hw, hh, hr],
    ];
    const key = JSON.stringify(shape);
    if (sh.shape !== key) {
      this.native.setLayerProps(sh.box, { frame: [0, 0, w, h] });
      this.native.setLayerProps(sh.mask, { frame: [0, 0, w, h] });
      this.native.setShapeProps(sh.mask, {
        path: shape,
        fillRule: 'evenodd',
        fillColor: [0, 0, 0, 1],
      });
      sh.shape = key;
    }
    // one caster a shadow, the first added last
    if (sh.casters.length !== shadows.length) {
      for (const caster of sh.casters) this.native.removeFromSuperlayer(caster);
      sh.casters = shadows.map(() => this.native.createLayer());
      for (let i = shadows.length - 1; i >= 0; i--) {
        this.native.addSublayer(sh.box, sh.casters[i]);
      }
      sh.props = [];
    }
    for (let i = 0; i < shadows.length; i++) {
      const shadow = shadows[i];
      const r = shadow.rect;
      const cw = r.width / s;
      const ch = r.height / s;
      const aside = this._aside(rect, r);
      const next = {
        frame: [(r.x - rect.x) / s - aside, (r.y - rect.y) / s, cw, ch],
        backgroundColor: [0, 0, 0, 1],
        cornerRadius: Math.min((shadow.radius ?? 0) / s, cw / 2, ch / 2),
        shadowColor: shadow.color,
        shadowOpacity: 1,
        shadowRadius: (shadow.blur ?? 0) / (2 * s),
        shadowOffset: [aside + (shadow.x ?? 0) / s, (shadow.y ?? 0) / s],
      };
      const was = sh.props[i] ?? {};
      const out = {};
      let any = false;
      for (const k of Object.keys(next)) {
        const v = next[k];
        if (Array.isArray(v) ? !sameMatrix(was[k], v) : was[k] !== v) {
          out[k] = v;
          any = true;
        }
      }
      if (any) this.native.setLayerProps(sh.casters[i], out);
      sh.props[i] = next;
    }
  }

  /** How far, in points, a caster of a shape at `r` in a layer at `rect`
   *  moves left to be clear of the layer: its right edge a point past the
   *  layer's left. */
  _aside(rect, r) {
    return (r.x + r.width - rect.x) / this.scale + 1;
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
      this.native.removeAnimation(run.layer, run.caKey);
      this._ends().delete(run.caId);
      state.runs.delete(id);
    }
    for (const id of state.done) if (!listed(id)) state.done.delete(id);
    const s = this.scale;
    for (const a of wanted) {
      if (state.runs.has(a.id) || state.done.has(a.id)) continue;
      const caId = `rxs${++spriteSeq}`;
      const caKey = `sprite:${caId}`;
      // a shadow's goes on its caster, in the caster's terms
      let layer = state.layer;
      let keyPath = a.property;
      let values = a.values;
      if (a.property === 'transform') {
        values = a.values.map((m) => inPoints(m, s));
      } else if (SHADOW_PROPERTIES.has(a.property)) {
        const i = a.shadow ?? 0;
        layer = state.shadow?.casters[i];
        if (!layer) continue;
        if (a.property === 'shadowBlur') {
          keyPath = 'shadowRadius';
          values = a.values.map((v) => v / (2 * s));
        } else if (a.property === 'shadowOffset') {
          const aside = this._aside(state.rect, sprite.shadows[i].rect);
          values = a.values.map(([x, y]) => [aside + x / s, y / s]);
        }
      }
      const opts = {
        values,
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
        this.native.addAnimation(layer, keyPath, opts, caKey);
      } catch (err) {
        this._warn(
          state.host,
          `the bridge refused sprite animation ${JSON.stringify(a.id)}: ${err?.message ?? err}`,
        );
        continue;
      }
      state.runs.set(a.id, { caId, caKey, layer, held: Boolean(a.hold) });
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
