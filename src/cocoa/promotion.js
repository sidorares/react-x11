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
// focus ring, no scrollbar — and only when every clipping ancestor holds
// the whole of it, because the layer would not be clipped. Declining is
// always safe: the frame clock runs the animation exactly as it does
// without this file. And the same test runs again every frame, so a node
// that becomes overlapped, hidden, clipped or non-plain returns to the
// bitmap in the frame that finds it, the animation handed back to the
// clock. Overlays, toasts, drag ghosts, spinners and floating cards pass by
// construction; a hover fade on a row in the middle of a list does not,
// and stays on the clock. docs/macos.md §"Layer promotion" is the account.
import {
  BoxNode,
  addDamageRect,
  damageToPaint,
  intersectRects,
} from '../nodes.js';
import { resolveBorderWidths } from '../styles.js';
import {
  LayerAnimations,
  RASTER_PAD,
  RasterState,
  Visual,
  propBoxProps,
  stylePaintsPlain,
} from './presenter.js';

const ORIGIN = Object.freeze({ x: 0, y: 0 });

// REACT_X11_DEBUG_PROMOTION=1: a line per decision — a node promoted, one
// taken back and why, one declined and what was in the way. The z-order
// rule is the one thing here a reader cannot see from a style, and "why
// is my card on the clock?" is answered by exactly this. Read at each
// decision rather than once (the way nodes.js reads REACT_X11_DEBUG_PAINT):
// decisions are rare where paints are per frame, and a test can flip it.
const debug = () => process.env.REACT_X11_DEBUG_PROMOTION === '1';

/** A node the way a debug line names it: its kind, and the test name or
 * the first few words of its text when it has one. */
function describe(node) {
  const name = node.props?.['data-testname'];
  if (name) return `<${node.kind} ${name}>`;
  const text = node.children?.find((c) => c.kind === 'text')?.props?.children;
  if (typeof text === 'string') {
    return `<${node.kind} "${text.length > 24 ? text.slice(0, 24) + '…' : text}">`;
  }
  const a = node.abs;
  return a
    ? `<${node.kind} ${a.width}x${a.height}@${a.x},${a.y}>`
    : `<${node.kind}>`;
}

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

const rectsOverlap = (a, b) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

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
 * Can this node be a property box on a layer at all — the static half of
 * the answer, the same whatever the scene around it does: a plain box by
 * its target style, not a scroller (its bars and clip host are the layer
 * presenter's business), no ring lit on it, no paint of its own.
 */
function promotableNode(node) {
  if (node.destroyed || !plainBox(node)) return false;
  if (!stylePaintsPlain(node, node._targetStyle ?? node.style)) return false;
  if (node.isScroller?.()) return false;
  return !paintsOutline(node);
}

/** The strip a scrollbar's track occupies, with the pad the thumb's
 * antialiasing needs. Mirrors the layer presenter's bar strip. */
function scrollbarStrip(bar, scale) {
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
 * The surface window's promoted nodes: which ones have a layer, what each
 * layer shows, and the animations the render server runs on them.
 * `frame()` is the whole of the per-frame work, called by the window from
 * nodes.js's `prepareFrame` seam — after layout, before the damage is taken.
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
    if (this.promoted.size === 0 && this.candidates.size === 0) return;
    const native = this.native;
    native.txBegin({ disableActions: true });
    try {
      // Later-painted first: a node painted after this one that is coming
      // off its layer is what this one would be overlapped by, and the
      // answer has to be known in the same frame, not the next.
      const keyed = this._inPaintOrder([...this.promoted.keys()]);
      for (let i = keyed.length - 1; i >= 0; i--) {
        const { node, key } = keyed[i];
        const why = this._stayBlocker(node, key);
        if (why) {
          if (debug())
            console.log(`react-x11: demoted ${describe(node)}: ${why}`);
          this._demote(node, root, true);
        }
      }
      if (this.candidates.size) {
        const candidates = this._inPaintOrder([...this.candidates]);
        this.candidates.clear();
        for (let i = candidates.length - 1; i >= 0; i--) {
          const { node, key } = candidates[i];
          if (this.promoted.has(node) || !this.animations.has(node)) continue;
          const why = !key
            ? 'not in the paint walk'
            : !promotableNode(node)
              ? 'not a plain box'
              : this._blocker(node);
          if (!why) {
            this._promote(node, root);
          } else {
            if (debug())
              console.log(`react-x11: declined ${describe(node)}: ${why}`);
            this.denied.set(node, this.layoutGen);
            this.animations.drop(node, true);
          }
        }
      }
      const order = this._inPaintOrder([...this.promoted.keys()]);
      for (let i = 0; i < order.length; i++) {
        this._sync(order[i].node, i, root, layoutRan);
      }
    } finally {
      native.txCommit();
    }
  }

  /** Why a promoted node has to come back — null while it may stay. */
  _stayBlocker(node, key) {
    if (node.destroyed) return 'unmounted';
    if (!key) return 'not in the paint walk';
    if (!promotableNode(node)) return 'not a plain box any more';
    if (this.releasing.has(node)) return 'still for a second'; // its grace ran out
    return this._blocker(node);
  }

  _promote(node, root) {
    if (debug()) {
      const props = [...(this.animations.pending.get(node)?.keys() ?? [])];
      console.log(
        `react-x11: promoted ${describe(node)} for ${props.join(', ')}`,
      );
    }
    const visual = new Visual(this, node);
    visual.attach(this.rootVisual);
    this.promoted.set(node, {
      visual,
      content: null,
      dirty: { all: true, rects: [] },
    });
    node._promoted = true;
    // the bitmap under it repaints without it, from this frame on
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
    if (!node.destroyed && node.abs) this._claim(root, node.paintBounds());
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
    keyed.sort((a, b) => {
      if (!a.key || !b.key) return (a.key ? 1 : 0) - (b.key ? 1 : 0);
      const n = Math.min(a.key.length, b.key.length);
      for (let i = 0; i < n; i++) {
        if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
      }
      return a.key.length - b.key.length;
    });
    return keyed;
  }

  /**
   * What is painted over this node, or clips it — null when nothing is.
   * Walked up the chain: at every level, what the parent paints after the
   * child on the way to this node — later siblings, then the parent's own
   * border and ring, then its bars — must keep out of the node's reach,
   * and the parent's clip, if it has one, must hold the whole of it. The
   * answer names the first thing in the way, for the debug line.
   */
  _blocker(node) {
    // the exact reach, not `paintBounds()`: that one carries the damage
    // model's pixel of slop, and a section laid out flush under a card
    // would read as reaching into it
    const bounds = node._subtreeBounds();
    for (let n = node; !n.isWindow; n = n.parent) {
      const parent = n.parent;
      if (!parent) return 'not attached to a window';
      const order = parent.paintOrder();
      for (let j = order.indexOf(n) + 1; j < order.length; j++) {
        const ink = this._reaches(order[j], bounds);
        if (ink) return `painted over by ${describe(ink)}`;
      }
      if (!parent.isWindow) {
        const border = borderReach(parent);
        if (
          border > 0 &&
          !containsRect(insetRect(parent.abs, border), bounds)
        ) {
          return `under the border of ${describe(parent)}`;
        }
        const ring = paintsOutline(parent);
        if (ring) {
          const inside = Math.max(0, ring.width / 2 - ring.offset) + 1;
          if (!containsRect(insetRect(parent.abs, inside), bounds)) {
            return `under the focus ring of ${describe(parent)}`;
          }
        }
        if (parent.clipsChildren?.()) {
          const radius = parent.style?.borderRadius;
          const clip =
            typeof radius === 'number' && radius > 0
              ? insetRect(parent.abs, radius)
              : parent.abs;
          if (!containsRect(clip, bounds)) {
            return `clipped by ${describe(parent)}`;
          }
        }
      }
      if (typeof parent._scrollbars === 'function') {
        for (const bar of parent._scrollbars()) {
          if (rectsOverlap(scrollbarStrip(bar, this.scale), bounds)) {
            return `under a scrollbar of ${describe(parent)}`;
          }
        }
      }
    }
    return null;
  }

  /** Is nothing painted over this node, and is all of it visible? */
  _clear(node) {
    return this._blocker(node) === null;
  }

  /**
   * The node in `n`'s subtree that puts ink inside `rect`, or null. A
   * promoted subtree puts none: it is on a layer of its own, above this
   * one since it is painted later. A subtree whose reach misses the rect
   * is answered from the cached reach without a walk.
   */
  _reaches(n, rect) {
    if (!rectsOverlap(n._subtreeBounds(), rect)) return null;
    if (this.promoted.has(n)) return null;
    if (paintsSomething(n) && rectsOverlap(n._ownPaintBounds(), rect)) {
      return n;
    }
    if (n.kind === 'text') return n; // its spans are its own ink
    for (const child of n.paintOrder()) {
      const ink = this._reaches(child, rect);
      if (ink) return ink;
    }
    return null;
  }

  // --- what the layer shows ----------------------------------------------------

  _sync(node, order, root, layoutRan) {
    const p = this.promoted.get(node);
    p.visual.set(propBoxProps(node, this.app, this.scale, ORIGIN, order));
    // after the model value went out, inside the same transaction
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
    for (const timer of this.idle.values()) clearTimeout(timer);
    this.idle.clear();
    this.releasing.clear();
    for (const [node, p] of this.promoted) {
      node._promoted = false;
      this.animations.drop(node, false);
      this._dropContent(p);
      p.visual.destroy();
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
