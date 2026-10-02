// Layer promotion — the surface presenter's answer to an animation it cannot
// otherwise take off the frame clock (issue #483): the few nodes that
// animate get a CALayer of their own above the window's bitmap, and the
// rest of the scene stays exactly the frame it was.
//
// The mechanism is the one `<glarea>` already uses. The surface presenter's
// pixels are the window root layer's `contents`, and a layer's contents
// draw below its sublayers — so a sublayer on the root composites over the
// bitmap for free, and the paint walk leaves a hole where the node was
// (`Node._promoted`, the way `GlAreaNode.paint` is empty). The node itself
// is a property box, its background, border and radius as properties of
// the layer — exactly the vocabulary the render server animates
// (`LayerAnimations`) — and its children, if it has any, are one raster
// sublayer painted by the node's own `_paintChildren` walk. Hit testing
// never moves: the node tree stays the source of truth for input on every
// presenter, so promotion changes pixels and nothing else.
//
// The policy is not inferred from the scene. A node is promoted because it
// has a transition or a loop on a property a layer can express, for as
// long as it has one and a moment after (`IDLE_GRACE_MS`), and returns to
// the bitmap then; nothing in a style asks for it, and nothing can promote
// two hundred nodes by mistake. What it is careful about is z-order, which is the hard
// part: a promoted layer sits above ALL the 2D content, so a node is
// promoted only when nothing painted after it in the walk reaches into its
// bounds — no later sibling at any level, no ancestor's border ring or
// focus ring — and only when every clipping ancestor with round corners
// holds the whole of it, because the layer is not cut to a curve; one with
// square corners cuts the layer to its box, a row half out of its list as
// much as a spinner inside a card. A scrollbar's thumb drawn over it goes
// on a layer of its own above it instead (`_syncThumbs`). And no ancestor
// may fade, because the layer would not be faded with it. Declining is always
// safe: the frame clock runs the animation exactly as it does without this
// file. The same test runs again every frame, so a node that becomes
// overlapped, hidden, clipped, faded or non-plain returns to the bitmap in
// the frame that finds it, the animation handed back to the clock — and a
// loop the clock runs is offered again once the scene would take it
// (`wouldTake`), where it is in its cycle. docs/macos.md §"Layer
// promotion" is the account.
import { BoxNode } from '../nodes/box.js';
import { addDamageRect, damageToPaint } from '../nodes/damage.js';
import { intersectRects } from '../nodes/rects.js';
import { resolveBorderWidths } from '../styles.js';
import {
  LayerAnimations,
  RASTER_PAD,
  RasterState,
  Visual,
  movesNode,
  propBoxProps,
  stylePaintsPlain,
} from './presenter.js';
import { SpriteLayers } from './sprites.js';

const ORIGIN = Object.freeze({ x: 0, y: 0 });

// A pane's thumbs come after everything inside it in the paint order — the
// bars are painted over the pane's children — and before whatever is
// painted after the pane: its key with this past any child's index.
const AFTER_CHILDREN = 1e9;

// What core paints a thumb in when the pane names no colour
// (`paintScrollbarThumb`).
const THUMB_COLOUR = 'rgba(0, 0, 0, 0.25)';

// How long a node that has stopped animating keeps its layer. A hover card
// fades in and, a moment later, out; a palette step ends one transition and
// starts the next; a toast pulses again. Demoting on the last frame of each
// would cost a layer and a repaint of the hole per round trip, and both are
// frames the bitmap pays for — the presenter bench's `anim` made 96 layers
// for 48 cards. A second is longer than any such gap and shorter than a
// user's attention span for a layer that is only holding still.
const IDLE_GRACE_MS = 1000;

// Past this many bare-rect claims on one raster the passes cost more than
// the repaint they save (the layer presenter's rule, per raster).
const MAX_DIRTY_RECTS = 16;

/** Paint order, for entries carrying a `_paintKey`: a key the walk would
 *  not reach sorts last. */
function byPaintKey(a, b) {
  if (!a.key || !b.key) return (a.key ? 1 : 0) - (b.key ? 1 : 0);
  const n = Math.min(a.key.length, b.key.length);
  for (let i = 0; i < n; i++) {
    if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
  }
  return a.key.length - b.key.length;
}

const rectsOverlap = (a, b) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

// `a` cut to `b`: their overlap, or a clip of no size where they have none,
// which hides what it holds rather than holding it whole
const cutTo = (a, b) =>
  intersectRects(a, b) ?? { x: b.x, y: b.y, width: 0, height: 0 };

const containsRect = (outer, inner) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

const insetRect = (rect, by) => ({
  x: rect.x + by,
  y: rect.y + by,
  width: rect.width - 2 * by,
  height: rect.height - 2 * by,
});

function unionRect(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** A rect grown outward to whole pixels — a pass clears and clips to its
 * edges, and a fractional edge would antialias the clip into a seam. */
function wholePixels(rect) {
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  return {
    x,
    y,
    width: Math.ceil(rect.x + rect.width) - x,
    height: Math.ceil(rect.y + rect.height) - y,
  };
}

/** The widest of a node's four borders, or 0. */
function borderReach(node) {
  const style = node.style ?? {};
  const w = resolveBorderWidths(style, node.direction);
  return Math.max(0, w.top, w.right, w.bottom, w.left);
}

/** Would `_paintOutline` draw a ring on this node right now? Counted as
 * ink whatever its colour: a wrong "no" here is a ring drawn under a layer. */
function paintsOutline(node) {
  const style = node.style ?? {};
  if (style.outlineWidth === undefined && !node.states?.[':focus-visible']) {
    return null;
  }
  return node._outline?.() ?? null;
}

/** A `<box>` painting as core paints one — not an element with a paint of
 * its own, whose content exists nowhere but in that override. */
const plainBox = (node) =>
  node.kind === 'box' && node.paint === BoxNode.prototype.paint;

/**
 * Does this node put any ink of its own on the bitmap? A layout-only box —
 * no background, no border, no shadow, no ring — overlaps nothing, however
 * big its rect; everything else is taken to paint its whole box.
 */
function paintsSomething(node) {
  if (!plainBox(node)) return true;
  const style = node.style ?? {};
  if (style.backgroundColor || style.backgroundImage || style.boxShadow) {
    return true;
  }
  if (borderReach(node) > 0 || paintsOutline(node)) return true;
  return Boolean(node.isScroller?.());
}

/**
 * Inside a `<glarea>`: drawn on a pane above the surface (src/gloverlay.js).
 * A layer of its own would sit on the root layer *under* the GL layer, so a
 * promoted node there would vanish behind the surface it is drawn over.
 */
function insideGlArea(node) {
  for (let n = node.parent; n && !n.isWindow; n = n.parent) {
    if (n.isGlArea) return true;
  }
  return false;
}

const faded = (style) => style?.opacity !== undefined && !(style.opacity >= 1);

/**
 * A box whose `opacity` is below 1, now or on its way there, is a group:
 * the box and everything in it drawn once and faded as one. The bitmap
 * composites one (`NodePaint._paintGroup`), and so does Core Animation — a
 * layer under an opacity below 1 is drawn with its sublayers and faded as
 * one (`allowsGroupOpacity`, YES by default on macOS), and a promoted box's
 * children are a sublayer of its layer. So a faded box may be promoted;
 * what may not is a box inside one, whose layer would be flat on the window
 * root, outside the group and at full strength (`_clear`).
 */
function fadesAsGroup(node) {
  return (
    faded(node.style) ||
    faded(node._targetStyle) ||
    Boolean(node._anim?.has('opacity')) ||
    Boolean(node._loops?.some((loop) => loop.prop === 'opacity'))
  );
}

/**
 * Can this node be a property box on a layer at all — the static half of
 * the answer, the same whatever the scene around it does: a plain box by
 * its target style, not a scroller (its bars and clip host are the layer
 * presenter's business), no ring lit on it, no paint of its own.
 */
function promotableNode(node) {
  if (node.destroyed || !plainBox(node)) return false;
  if (insideGlArea(node)) return false;
  if (!stylePaintsPlain(node, node._targetStyle ?? node.style)) return false;
  if (node.isScroller?.()) return false;
  return !paintsOutline(node);
}

/** Where a scrollbar puts ink: its thumb, with the pad the thumb's
 * antialiasing needs. The track is not drawn, so a layer beside the thumb
 * covers nothing of the bar's; one the thumb is drawn over has the thumb
 * lifted above it (`_thumbsLiftable`). */
function scrollbarInk(bar, scale) {
  const pad = Math.ceil(2 * scale);
  return {
    x: bar.x - pad,
    y: bar.y - pad,
    width: bar.width + 2 * pad,
    height: bar.height + 2 * pad,
  };
}

/** …and everywhere the thumb can go, which a lifted thumb's layer may come
 *  to stand over as the pane scrolls. */
function scrollbarTrack(bar, scale) {
  const pad = Math.ceil(2 * scale);
  return bar.axis === 'x'
    ? {
        x: bar.trackStart - pad,
        y: bar.crossStart - pad,
        width: bar.trackLength + 2 * pad,
        height: bar.height + 2 * pad,
      }
    : {
        x: bar.crossStart - pad,
        y: bar.trackStart - pad,
        width: bar.width + 2 * pad,
        height: bar.trackLength + 2 * pad,
      };
}

/**
 * The clip a node's layer is cut to: the one `_clear` narrowed its reach to
 * through the clipping ancestors around it, where that leaves any of the
 * node out — and null where every one of them holds it whole, which keeps a
 * node clear of its pane's edges on the window root as before. A rounded
 * clip comes with its radius, and with the square clips that cut it again
 * (`outer`), as an element's part's does.
 */
function clipOf(cut, reach) {
  if (!cut.clip) return null;
  const radius = cut.radius > 0 ? cut.radius : 0;
  const held = radius > 0 ? insetRect(cut.clip, radius) : cut.clip;
  if (!cut.outer && containsRect(held, reach)) return null;
  return { rect: cut.clip, radius, outer: cut.outer ?? null };
}

/**
 * Where a node's layer can be. Where the layout put it and what it holds
 * reach — or, for a node a loop moves (an inset on a node out of the flow,
 * which the render server runs as the layer's position, presenter.js
 * `INSET_KEY_PATHS`), anywhere in the nearest box that clips it, the reach
 * every frame of the loop stays inside (nodes/animation.js `_loopReach`).
 * Null where nothing short of the window holds it, which no layer is
 * cleared for.
 */
function reachOf(node) {
  if (!node._loops?.some((loop) => movesNode(loop.prop))) {
    return node._subtreeBounds();
  }
  return node._loopReach?.()?.rect ?? null;
}

/**
 * The surface window's promoted nodes: which ones have a layer, what each
 * layer shows, and the animations the render server runs on them.
 * `frame()` is the whole of the per-frame work, called by the window from
 * the `prepareFrame` seam in nodes/window/flush.js — after layout, before the damage is taken.
 */
export class CocoaPromotion {
  constructor(window) {
    this.window = window;
    this.native = window._native;
    this.scale = window.scale;
    this.app = window.app;
    this.fonts = window.app.fonts;
    this.rootVisual = { layer: window._layer };
    this.promoted = new Map(); // node -> { visual, content, dirty }
    // nodes whose animation was taken and have no layer yet: the frame
    // decides, against the scene as laid out
    this.candidates = new Set();
    // a refusal, by the layout it was decided in: the same scene answers
    // the same way, and every refusal a frame makes restarts the entry
    this.denied = new WeakMap(); // node -> layout generation
    this.layoutGen = 0;
    // nodes whose last animation ended, waiting out the grace before the
    // frame that takes them back into the bitmap; and the ones that frame
    // is owed for
    this.idle = new Map(); // node -> timer
    this.releasing = new Set();
    this.animations = new LayerAnimations({
      native: this.native,
      app: this.app,
      scale: this.scale,
      layerOf: (node) => this.promoted.get(node)?.visual.layer ?? null,
      onIdle: (node) => this._idle(node),
    });
    // the parts of elements' drawing they offer (`Node.sprites()`), each on
    // a layer of its own under the same rules (src/cocoa/sprites.js)
    this.sprites = new SpriteLayers(this);
    // the scroll panes whose thumbs are on layers of their own, above the
    // layers they are drawn over (`_syncThumbs`), and the ones this frame's
    // layers are under
    this.thumbs = new Map(); // pane -> Map(axis -> { layer, props })
    this._thumbsWanted = null;
    this._claiming = false;
  }

  // --- the window's animation seam -------------------------------------------

  /**
   * Take `prop`'s animation for `node` off the frame clock, or decline.
   * Taken here means only that the node is a candidate: whether it gets a
   * layer is decided by the next frame, with the scene laid out, and a
   * frame that decides against it hands the entry back to the clock from
   * the top — before anything was painted at the target, so nothing shows.
   */
  animate(node, prop, entry) {
    if (this.window.destroyed) return false;
    if (!this.promoted.has(node)) {
      if (this.denied.get(node) === this.layoutGen) return false;
      if (!promotableNode(node)) return false;
    }
    if (!this.animations.take(node, prop, entry)) return false;
    if (this.promoted.has(node)) this._keep(node);
    else this.candidates.add(node);
    return true;
  }

  /** Stop what runs for `prop` on `node`. The layer stays: a node with
   *  nothing left running on it waits out the grace like one whose
   *  animation ended, and the frame after that takes it back. */
  cancel(node, prop) {
    this.animations.cancel(node, prop);
    if (this.promoted.has(node) && !this.animations.has(node)) {
      this._idle(node);
    }
  }

  /** Nothing runs on `node`'s layer any more: keep it for the grace, then
   *  ask for the frame that takes the node back into the bitmap. */
  _idle(node) {
    if (!this.promoted.has(node) || this.idle.has(node)) return;
    const timer = setTimeout(() => {
      this.idle.delete(node);
      this._release(node);
    }, IDLE_GRACE_MS);
    timer.unref?.();
    this.idle.set(node, timer);
  }

  /** Something runs on `node`'s layer again: it stays. */
  _keep(node) {
    const timer = this.idle.get(node);
    if (timer) {
      clearTimeout(timer);
      this.idle.delete(node);
    }
    this.releasing.delete(node);
  }

  _release(node) {
    if (!this.promoted.has(node) || node.destroyed) return;
    if (this.animations.has(node)) return; // taken again meanwhile
    this.releasing.add(node);
    const root = this.window._reactX11Node;
    if (root && !root.destroyed) root.invalidate(false, node, 'animation');
  }

  /** Every idle node back into the bitmap on the next frame, grace or no
   *  grace — for the tests, which do not wait a second. */
  releaseIdle() {
    for (const node of [...this.idle.keys()]) {
      clearTimeout(this.idle.get(node));
      this.idle.delete(node);
      this._release(node);
    }
  }

  // --- the invalidate channel ----------------------------------------------

  /**
   * A claim against the bitmap, seen on its way there: what it says about
   * a promoted node's own layer needs no note — the model is re-diffed
   * every frame — but its children's raster repaints only what is claimed
   * inside it. A node claim inside a promoted subtree is a pass over that
   * node's reach; a layout change anywhere in the subtree, or a claim with
   * no bound, repaints the raster in full; a bare rect repaints that part
   * of every raster it reaches into (the layer presenter's rule).
   */
  noteInvalidate(damage, layoutChanged) {
    if (this._claiming || this.promoted.size === 0) return false;
    if (damage == null) {
      for (const p of this.promoted.values()) p.dirty.all = true;
      return false;
    }
    if (damage.kind) {
      let owner = null;
      for (let n = damage; n && !n.isWindow; n = n.parent) {
        if (this.promoted.has(n)) {
          owner = n;
          break;
        }
      }
      if (!owner) return false;
      const p = this.promoted.get(owner);
      if (layoutChanged) {
        p.dirty.all = true;
        return false;
      }
      if (owner !== damage) this._dirtyRect(p, damage.paintBounds());
      // answered here — the model re-diffed, the raster repainted — and the
      // bitmap owes nothing: it holds a hole where this node is
      return true;
    }
    if (!(damage.width > 0 && damage.height > 0)) return false;
    for (const p of this.promoted.values()) {
      if (p.content && rectsOverlap(p.content.rect, damage)) {
        this._dirtyRect(p, damage);
      }
    }
    return false;
  }

  _dirtyRect(p, rect) {
    if (p.dirty.all) return;
    if (p.dirty.rects.length >= MAX_DIRTY_RECTS) {
      p.dirty.all = true;
      return;
    }
    // copied: a caller's rect is very often a live `abs` about to move
    p.dirty.rects.push({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }

  // --- the frame -------------------------------------------------------------

  /**
   * The presenter's half of a frame. Three passes, all inside one
   * disabled-actions transaction: every promoted node is asked again
   * whether it may stay, the candidates are decided, and what remains is
   * synced — frame, properties, the animations waiting to attach, the
   * children's raster. A node taken off a layer here is painted back into
   * the bitmap by this same frame, which is why this runs before the
   * damage is taken (`_claim`).
   */
  frame(root, layoutRan) {
    if (layoutRan) this.layoutGen++;
    // what elements offer, asked before anything is decided: an answer is
    // about the element's own drawing, not about the layers
    const offers = this.sprites.ask(root);
    if (
      this.promoted.size === 0 &&
      this.candidates.size === 0 &&
      offers.size === 0 &&
      this.sprites.hosts.size === 0 &&
      this.thumbs.size === 0
    ) {
      return;
    }
    const native = this.native;
    let lifted = null;
    const wanted = (this._thumbsWanted = new Set());
    native.txBegin({ disableActions: true });
    try {
      // Later-painted first: a node painted after this one that is coming
      // off its layer is what this one would be overlapped by, and the
      // answer has to be known in the same frame, not the next.
      const keyed = this._inPaintOrder([...this.promoted.keys()]);
      for (let i = keyed.length - 1; i >= 0; i--) {
        const { node, key } = keyed[i];
        if (!this._mayStay(node, key)) this._demote(node, root, true);
      }
      if (this.candidates.size) {
        const candidates = this._inPaintOrder([...this.candidates]);
        this.candidates.clear();
        for (let i = candidates.length - 1; i >= 0; i--) {
          const { node, key } = candidates[i];
          if (this.promoted.has(node) || !this.animations.has(node)) continue;
          const cut = { thumbs: new Set(), round: true };
          const reach = key && promotableNode(node) ? reachOf(node) : null;
          if (reach && this._clear(node, reach, cut)) {
            for (const pane of cut.thumbs) wanted.add(pane);
            this._promote(node, root, clipOf(cut, reach));
          } else {
            this.denied.set(node, this.layoutGen);
            this.animations.drop(node, true);
          }
        }
      }
      // Then the parts, against the layers this frame keeps: a node
      // promoted over a part is a layer above it, not ink on it.
      lifted = this.sprites.decide(root, offers);
      // A thumb no layer is under any more goes back into the bitmap.
      for (const pane of [...this.thumbs.keys()]) {
        if (!wanted.has(pane)) this._dropThumbs(pane, root);
      }
      // One order for every layer above the bitmap, nodes, parts and
      // thumbs alike.
      const order = this._inPaintOrder([...this.promoted.keys()]);
      for (const state of this.sprites.entries()) {
        order.push({ state, key: state.order });
      }
      for (const pane of wanted) {
        const key = this._paintKey(pane);
        if (key) order.push({ pane, key: [...key, AFTER_CHILDREN] });
      }
      order.sort(byPaintKey);
      for (let i = 0; i < order.length; i++) {
        const { node, state, pane } = order[i];
        if (node) this._sync(node, i, root, layoutRan);
        else if (pane) this._syncThumbs(pane, i, root);
        else this.sprites.sync(state, i);
      }
    } finally {
      this._thumbsWanted = null;
      native.txCommit();
    }
    // An element told which of its parts are on layers now may claim,
    // restyle or ask for frames; the frame has not taken its damage yet.
    if (lifted?.size) this.sprites.notify(lifted);
  }

  _mayStay(node, key) {
    if (!key || !promotableNode(node)) return false;
    if (this.releasing.has(node)) return false; // its grace ran out
    const cut = { thumbs: new Set(), round: true };
    const reach = reachOf(node);
    if (!reach || !this._clear(node, reach, cut)) return false;
    for (const pane of cut.thumbs) this._thumbsWanted?.add(pane);
    this.promoted.get(node).clip = clipOf(cut, reach);
    return true;
  }

  /**
   * Would a frame put `node` on a layer now? Asked of a loop the clock runs
   * because a frame turned it down or gave it back (nodes/animation.js
   * `_offerLoopsAgain`): the scene that refused it may have moved on — a
   * fading ancestor arrived, a sibling went, a scroll took the thumb away —
   * and nothing about the loop itself would ever ask again. The frame
   * decides as it always does; this is what keeps a loop that would only
   * be turned down again from being offered every frame.
   */
  wouldTake(node) {
    if (this.window.destroyed || node.destroyed) return false;
    if (this.promoted.has(node)) return true;
    if (!promotableNode(node) || !this._paintKey(node)) return false;
    const reach = reachOf(node);
    if (!reach) return false;
    if (!this._clear(node, reach, { thumbs: new Set(), round: true })) {
      return false;
    }
    // asked of the scene as it is now, so a refusal from an earlier one —
    // kept for the layout it was made in, and a fade that arrives lays
    // nothing out — no longer stands
    this.denied.delete(node);
    return true;
  }

  _promote(node, root, clip = null) {
    const p = {
      visual: new Visual(this, node),
      content: null,
      dirty: { all: true, rects: [] },
      // the clip a clipping ancestor cuts it to, or null (`clipOf`), the box
      // that masks to it, and the box of the square clips around a rounded
      // one
      clip,
      box: null,
      boxProps: {},
      outerBox: null,
      outerProps: {},
    };
    this.promoted.set(node, p);
    this._place(p);
    node._promoted = true;
    // the bitmap under it repaints without it, from this frame on — and so
    // does the raster of a promoted node it is in, which the claim that
    // handed us its animation reached (`noteInvalidate`)
    this._claim(root, node.paintBounds());
  }

  /**
   * Off its layer and back into the bitmap, in this frame. `reclaim` hands
   * what was waiting for a frame back to the clock; what was running is
   * over either way, and the model shows — a loop comes back to the clock
   * through `_offloadEnded`'s own rule.
   */
  _demote(node, root, reclaim) {
    const p = this.promoted.get(node);
    if (!p) return;
    this.promoted.delete(node);
    this._keep(node);
    node._promoted = false;
    this.animations.drop(node, reclaim && !node.destroyed);
    this._dropContent(p);
    p.visual.destroy();
    if (p.box) this.native.removeFromSuperlayer(p.outerBox ?? p.box);
    if (!node.destroyed && node.abs) {
      this._repaintHolder(node);
      this._claim(root, node.paintBounds());
    }
  }

  /**
   * The node's layer on the window root, or in a box of its clip's size
   * that masks to it, where a clipping ancestor with square corners cuts it
   * (`clipOf`) — a row half scrolled out of its list, as an element's part
   * is cut (src/cocoa/sprites.js). A layer moved into or out of the box
   * sends everything again (`Visual.attach`).
   */
  _place(p) {
    const want = p.clip ? (p.clip.outer ? 2 : 1) : 0;
    const have = p.outerBox ? 2 : p.box ? 1 : 0;
    if (want === have) {
      if (!want) p.visual.attach(this.rootVisual);
      return;
    }
    if (p.box) {
      p.visual.attach(this.rootVisual);
      this.native.removeFromSuperlayer(p.outerBox ?? p.box);
      p.box = null;
      p.outerBox = null;
    }
    if (!want) return;
    p.box = this.native.createLayer();
    p.boxProps = {};
    if (want === 2) {
      p.outerBox = this.native.createLayer();
      p.outerProps = {};
      this.native.addSublayer(this.rootVisual.layer, p.outerBox);
      this.native.addSublayer(p.outerBox, p.box);
    } else {
      this.native.addSublayer(this.rootVisual.layer, p.box);
    }
    p.visual.attach({ layer: p.box });
  }

  /** A box's properties, sent where they changed. */
  _setBox(layer, p, field, next) {
    const was = p[field];
    for (const key of Object.keys(next)) {
      const a = was[key];
      const b = next[key];
      const same = Array.isArray(b)
        ? Array.isArray(a) && b.every((v, i) => v === a[i])
        : a === b;
      if (!same) {
        this.native.setLayerProps(layer, next);
        p[field] = next;
        return;
      }
    }
  }

  /**
   * A node coming off its layer inside a promoted node: the bitmap holds a
   * hole there, and the node's pixels belong in that node's raster — so the
   * raster repaints where the node reaches, taking it back, in this frame.
   * Nothing else would ask: `_claim` keeps our claims off our own books, a
   * raster's layout key is compared only in a frame that ran layout, and
   * what gives a node back claims its own layer (the grace ran out) or
   * nothing (an ancestor began to fade, a sibling came over it). Going onto
   * a layer needs no such call — the claim that handed us the animation
   * reached the raster. The nearest promoted node alone, since a raster
   * leaves out the whole subtree of a promoted child.
   */
  _repaintHolder(node) {
    for (let n = node.parent; n && !n.isWindow; n = n.parent) {
      const holder = this.promoted.get(n);
      if (holder) {
        this._dirtyRect(holder, node.paintBounds());
        return;
      }
    }
  }

  _dropContent(p) {
    if (!p.content) return;
    this.native.removeFromSuperlayer(p.content.layer);
    p.content.raster.release(this.native);
    p.content = null;
  }

  /** A claim of our own against the bitmap, kept off our own books. */
  _claim(root, rect) {
    if (!root || root.destroyed) return;
    this._claiming = true;
    try {
      root.invalidate(false, rect, 'animation');
    } finally {
      this._claiming = false;
    }
  }

  // --- where a node stands in the walk ----------------------------------------

  /**
   * The node's place in the window's paint order — its index in each
   * ancestor's `paintOrder()`, top down — or null when the walk would not
   * reach it: hidden, `display: none`, or not attached to a window.
   */
  _paintKey(node) {
    const key = [];
    for (let n = node; !n.isWindow; n = n.parent) {
      const parent = n.parent;
      if (!parent) return null;
      const i = parent.paintOrder().indexOf(n);
      if (i < 0) return null;
      key.push(i);
    }
    return key.reverse();
  }

  _inPaintOrder(nodes) {
    const keyed = nodes.map((node) => ({ node, key: this._paintKey(node) }));
    keyed.sort(byPaintKey);
    return keyed;
  }

  /**
   * Where an element offering parts stands in the paint order, or null when
   * none of them may go on a layer: hidden, inside a `<glarea>`, or itself
   * faded — its group on the bitmap would leave a part's layer out of it. A
   * faded ancestor is `_clear`'s to find, as it is for a node.
   */
  _spritePlace(host) {
    if (host.destroyed || host.hidden) return null;
    if (insideGlArea(host) || fadesAsGroup(host)) return null;
    return this._paintKey(host);
  }

  /**
   * Is nothing painted over this node, is all of it visible, and is it in
   * no faded group? Walked up the chain: at every level, what the parent
   * paints after the child on the way to this node — later siblings, then
   * the parent's own border and ring, then its bars — must keep out of the
   * node's reach, the parent's clip, if it has one, must hold the whole of
   * it, and the parent must not fade: its group is drawn on the bitmap or on
   * its own layer, and either way a layer of the node's would be outside it.
   *
   * With `cut`, the layer can be cut to a rectangle — a node's
   * (`clipOf`), or an element's part's (src/cocoa/sprites.js): a clipping
   * ancestor with square
   * corners narrows `cut.clip` to its padding box — its border is drawn
   * over what it holds anyway — instead of having to hold the part whole,
   * and every test from there up is asked of what shows through the clip.
   * `cut.bounds` comes back as that. A clip that leaves nothing showing is
   * a refusal.
   */
  _clear(node, bounds = node._subtreeBounds(), cut = null) {
    // the exact reach, not `paintBounds()`: that one carries the damage
    // model's pixel of slop, and a section laid out flush under a card
    // would read as reaching into it. An element's part is asked about at
    // everywhere it can draw (src/cocoa/sprites.js).
    for (let n = node; !n.isWindow; n = n.parent) {
      const parent = n.parent;
      if (!parent) return false;
      if (
        cut &&
        !parent.isWindow &&
        parent.clipsChildren?.() &&
        !(parent.style?.borderRadius > 0)
      ) {
        const inner = insetRect(parent.abs, borderReach(parent));
        // a clip with round corners cut again is no one box's shape: the
        // square ones go in a box of their own around it (`outer`)
        if (cut.radius > 0 && cut.clip) {
          if (cut.outer || !containsRect(inner, cut.clip)) {
            cut.outer = cut.outer ? cutTo(cut.outer, inner) : inner;
          }
        } else {
          cut.clip = cut.clip ? cutTo(cut.clip, inner) : inner;
        }
        bounds = intersectRects(bounds, cut.clip);
        if (bounds && cut.outer) bounds = intersectRects(bounds, cut.outer);
        // nothing of the part shows: its layer is kept, cut to show nothing,
        // and there is nothing it could be under or over until it does
        if (!bounds) {
          cut.bounds = null;
          return true;
        }
      }
      // A node's layer may be cut to one rounded clip, the innermost that
      // does not hold it — a block sliding along a bar's rounded track. Its
      // padding box, with the corners its border leaves, and every square
      // clip above it cuts it again as above (`outer`).
      let roundCut = false;
      if (
        cut?.round &&
        !cut.clip &&
        !parent.isWindow &&
        parent.clipsChildren?.() &&
        typeof parent.style?.borderRadius === 'number' &&
        parent.style.borderRadius > 0 &&
        !containsRect(insetRect(parent.abs, parent.style.borderRadius), bounds)
      ) {
        const border = borderReach(parent);
        cut.clip = insetRect(parent.abs, border);
        cut.radius = Math.max(0, parent.style.borderRadius - border);
        roundCut = true;
        bounds = intersectRects(bounds, cut.clip);
        if (!bounds) {
          cut.bounds = null;
          return true;
        }
      }
      const order = parent.paintOrder();
      for (let j = order.indexOf(n) + 1; j < order.length; j++) {
        if (this._reaches(order[j], bounds)) return false;
      }
      if (!parent.isWindow) {
        if (fadesAsGroup(parent)) return false;
        const border = borderReach(parent);
        if (
          border > 0 &&
          !containsRect(insetRect(parent.abs, border), bounds)
        ) {
          return false;
        }
        const ring = paintsOutline(parent);
        if (ring) {
          const inside = Math.max(0, ring.width / 2 - ring.offset) + 1;
          if (!containsRect(insetRect(parent.abs, inside), bounds))
            return false;
        }
        if (parent.clipsChildren?.() && !roundCut) {
          const radius = parent.style?.borderRadius;
          const clip =
            typeof radius === 'number' && radius > 0
              ? insetRect(parent.abs, radius)
              : parent.abs;
          if (!containsRect(clip, bounds)) return false;
        }
      }
      if (typeof parent._scrollbars === 'function') {
        for (const bar of parent._scrollbars()) {
          if (!rectsOverlap(scrollbarInk(bar, this.scale), bounds)) continue;
          // a thumb drawn over a node's layer goes on a layer of its own
          // above it, where it can (`_thumbsLiftable`); an element's part
          // keeps clear of it
          if (!cut?.thumbs || !this._thumbsLiftable(parent)) return false;
          cut.thumbs.add(parent);
        }
      }
    }
    if (cut) cut.bounds = bounds;
    return true;
  }

  /**
   * Does anything in `n`'s subtree put ink inside `rect`? A promoted
   * subtree does not: it is on a layer of its own, above this one since it
   * is painted later. A subtree whose reach misses the rect is answered
   * from the cached reach without a walk.
   */
  _reaches(n, rect) {
    if (!rectsOverlap(n._subtreeBounds(), rect)) return false;
    if (this.promoted.has(n)) return false;
    if (paintsSomething(n) && rectsOverlap(n._ownPaintBounds(), rect)) {
      return true;
    }
    if (n.kind === 'text') return true; // its spans are its own ink
    for (const child of n.paintOrder()) {
      if (this._reaches(child, rect)) return true;
    }
    return false;
  }

  // --- a pane's thumbs above the rows they are drawn over ----------------------

  /**
   * Can `pane`'s thumbs go on a layer above everything inside it? The bars
   * are painted after the pane's children, so a layer of theirs stands over
   * the layers of the rows in the pane as the thumb stands over the rows —
   * where nothing painted after the pane reaches anywhere the thumb can go,
   * nothing above it fades, and every clip above it holds the track whole:
   * `_clear` asked of the pane at its tracks. A pane that fades has its
   * bars in its group.
   */
  _thumbsLiftable(pane) {
    if (fadesAsGroup(pane)) return false;
    for (const bar of pane._scrollbars()) {
      if (!this._clear(pane, scrollbarTrack(bar, this.scale))) return false;
    }
    return true;
  }

  /** `pane`'s thumbs on layers of their own at `z` among the layers above
   *  the bitmap, which stops painting them (`Scrollable._paintScrollbars`):
   *  a colour and a radius, as core paints one, where the thumb is now. */
  _syncThumbs(pane, z, root) {
    let layers = this.thumbs.get(pane);
    if (!layers) {
      layers = new Map();
      this.thumbs.set(pane, layers);
      pane._thumbsLifted = true;
      // the bitmap under it, repainted without it
      for (const bar of pane._scrollbars()) {
        this._claim(root, scrollbarInk(bar, this.scale));
      }
    }
    const s = this.scale;
    const backgroundColor = this.app._parseColor(
      String(pane.props.scrollbarColor || THUMB_COLOUR),
    ) ?? [0, 0, 0, 0.25];
    const seen = new Set();
    for (const bar of pane._scrollbars()) {
      seen.add(bar.axis);
      let entry = layers.get(bar.axis);
      if (!entry) {
        entry = { layer: this.native.createLayer(), props: {} };
        this.native.addSublayer(this.rootVisual.layer, entry.layer);
        layers.set(bar.axis, entry);
      }
      const next = {
        frame: [bar.x / s, bar.y / s, bar.width / s, bar.height / s],
        backgroundColor,
        cornerRadius: 3,
        zPosition: z,
      };
      const out = {};
      let any = false;
      for (const key of Object.keys(next)) {
        const was = entry.props[key];
        const value = next[key];
        const same = Array.isArray(value)
          ? Array.isArray(was) && value.every((v, i) => v === was[i])
          : was === value;
        if (!same) {
          out[key] = value;
          any = true;
        }
      }
      if (any) {
        this.native.setLayerProps(entry.layer, out);
        entry.props = next;
      }
    }
    for (const [axis, entry] of layers) {
      if (seen.has(axis)) continue;
      this.native.removeFromSuperlayer(entry.layer);
      layers.delete(axis);
    }
  }

  /** `pane`'s thumbs back into the bitmap, which paints them again where
   *  they are now. */
  _dropThumbs(pane, root) {
    const layers = this.thumbs.get(pane);
    if (!layers) return;
    this.thumbs.delete(pane);
    for (const entry of layers.values()) {
      this.native.removeFromSuperlayer(entry.layer);
    }
    pane._thumbsLifted = false;
    if (pane.destroyed) return;
    for (const bar of pane._scrollbars()) {
      this._claim(root, scrollbarInk(bar, this.scale));
    }
  }

  // --- what the layer shows ----------------------------------------------------

  _sync(node, order, root, layoutRan) {
    const p = this.promoted.get(node);
    this._place(p);
    let origin = ORIGIN;
    let z = order;
    if (p.box) {
      // the box stands at the node's place among the layers — or inside
      // the box of the square clips around it, which does — and the node's
      // layer is placed from the box's corner inside it
      const s = this.scale;
      const { rect: clip, radius, outer } = p.clip;
      let base = ORIGIN;
      let boxZ = order;
      if (p.outerBox) {
        this._setBox(p.outerBox, p, 'outerProps', {
          frame: [outer.x / s, outer.y / s, outer.width / s, outer.height / s],
          masksToBounds: true,
          zPosition: order,
        });
        base = outer;
        boxZ = 0;
      }
      this._setBox(p.box, p, 'boxProps', {
        frame: [
          (clip.x - base.x) / s,
          (clip.y - base.y) / s,
          clip.width / s,
          clip.height / s,
        ],
        masksToBounds: true,
        // a circle's arc, as wide as the box allows, where the clip is
        // rounded
        cornerRadius: Math.min(radius, clip.width / 2, clip.height / 2) / s,
        zPosition: boxZ,
      });
      origin = clip;
      z = 0;
    }
    p.visual.set(propBoxProps(node, this.app, this.scale, origin, z));
    // after the model value went out, inside the same transaction: what
    // moves the node, as the layout has its parent now, then what waits
    this.animations.follow(node, p.visual.layer);
    this.animations.apply(node, p.visual.layer);
    this._syncContent(node, p, root, layoutRan);
  }

  /**
   * The children, rastered into one sublayer at their reach: the node's own
   * `_paintChildren` walk, translated so the reach lands at the bitmap's
   * origin, with `paintDamage()` naming each pass the way the window's
   * paint does. Repainted for the claims that reached into it since the
   * last frame, for a change of size, and for any change in where the
   * children sit inside the node — a layout pass can move them without a
   * claim naming any of them, so a layout frame compares their rects.
   */
  _syncContent(node, p, root, layoutRan) {
    const abs = node.abs;
    let reach = null;
    for (const child of node.paintOrder()) {
      if (child._promoted) continue; // on a layer of its own
      reach = unionRect(reach, child._subtreeBounds());
    }
    if (reach && node.clipsChildren?.()) reach = intersectRects(reach, abs);
    if (!reach || !(reach.width > 0 && reach.height > 0)) {
      this._dropContent(p);
      p.dirty = { all: true, rects: [] };
      return;
    }
    const rect = {
      x: Math.floor(reach.x) - RASTER_PAD,
      y: Math.floor(reach.y) - RASTER_PAD,
      width: Math.ceil(reach.width) + RASTER_PAD * 2,
      height: Math.ceil(reach.height) + RASTER_PAD * 2,
    };
    let content = p.content;
    if (!content) {
      const layer = this.native.createLayer();
      this.native.addSublayer(p.visual.layer, layer);
      content = p.content = {
        layer,
        raster: new RasterState(),
        rect: null,
        layoutKey: null,
        props: {},
      };
    }
    const s = this.scale;
    const frame = [
      (rect.x - abs.x) / s,
      (rect.y - abs.y) / s,
      rect.width / s,
      rect.height / s,
    ];
    if (
      !content.props.frame ||
      frame.some((v, i) => v !== content.props.frame[i])
    ) {
      content.props.frame = frame;
      this.native.setLayerProps(content.layer, { frame, zPosition: 0 });
    }
    const raster = content.raster;
    const sizeChanged =
      raster.width !== rect.width || raster.height !== rect.height;
    const layoutKey =
      layoutRan || !content.layoutKey ? layoutKeyOf(node) : null;
    const moved =
      content.rect && (content.rect.x !== rect.x || content.rect.y !== rect.y);
    const full =
      p.dirty.all ||
      sizeChanged ||
      (layoutKey !== null && layoutKey !== content.layoutKey) ||
      (moved && p.dirty.rects.length > 0);
    let passes = null;
    if (full) {
      passes = [null];
    } else if (p.dirty.rects.length) {
      for (const claimed of p.dirty.rects) {
        const hit = intersectRects(wholePixels(claimed), rect);
        if (hit) passes = addDamageRect(passes, hit);
      }
      if (passes) passes = damageToPaint(passes);
    }
    p.dirty = { all: false, rects: [] };
    content.rect = rect;
    if (layoutKey !== null) content.layoutKey = layoutKey;
    if (!passes) return;
    const ctx = raster.ensure(this, rect.width, rect.height, s);
    ctx.save();
    try {
      ctx.translate(-rect.x, -rect.y);
      for (const pass of passes) {
        const area = pass ?? rect;
        ctx.save();
        try {
          if (pass) {
            ctx.beginPath();
            ctx.rect(area.x, area.y, area.width, area.height);
            ctx.clip();
          }
          ctx.clearRect(area.x, area.y, area.width, area.height);
          root._paintDamage = pass;
          node._paintChildren(ctx);
        } finally {
          root._paintDamage = null;
          ctx.restore();
        }
      }
    } finally {
      ctx.restore();
    }
    this.native.surfaceToLayer(raster.surface, content.layer);
  }

  /** Everything off the root layer and freed: the window is going. */
  destroy() {
    this.sprites.destroy();
    for (const [pane, layers] of this.thumbs) {
      for (const entry of layers.values()) {
        this.native.removeFromSuperlayer(entry.layer);
      }
      pane._thumbsLifted = false;
    }
    this.thumbs.clear();
    for (const timer of this.idle.values()) clearTimeout(timer);
    this.idle.clear();
    this.releasing.clear();
    for (const [node, p] of this.promoted) {
      node._promoted = false;
      this.animations.drop(node, false);
      this._dropContent(p);
      p.visual.destroy();
      if (p.box) this.native.removeFromSuperlayer(p.outerBox ?? p.box);
    }
    this.promoted.clear();
    this.candidates.clear();
  }
}

/**
 * Where a node's drawn descendants sit inside it, as one string: the same
 * arrangement gives the same key, and a raster painted for one is good for
 * the other. Promoted subtrees are left out — they are on layers of their
 * own — and so is anything that is not layout, which claims for itself.
 */
function layoutKeyOf(node) {
  const ox = node.abs.x;
  const oy = node.abs.y;
  let key = '';
  const walk = (n) => {
    for (const child of n.paintOrder()) {
      if (child._promoted) continue;
      const a = child.abs;
      key += `${a.x - ox},${a.y - oy},${a.width},${a.height};`;
      if (child.kind !== 'text') walk(child);
    }
  };
  walk(node);
  return key;
}
