// The retained layer presenter — Tier L of docs/macos.md: one CALayer per
// drawn node, React commits landing as property sets inside a single
// disabled-actions CATransaction per frame, the WindowServer compositing.
//
// The node tree stays the model (layout, hit testing, events, focus); the
// layer tree is write-only presentation. Three visual kinds cover the whole
// vocabulary:
//
//   PropBox      a plain <box> — backgroundColor, uniform border, radius,
//                clip — expressed entirely as layer properties. Zero raster.
//   Raster       every painted-code node (text, textinput, canvas, svg,
//                images, registered elements) and any box whose self-paint
//                exceeds the property vocabulary (gradients, shadows,
//                per-edge borders, focus outlines): its OWN paint replayed
//                through the CG context into a bitmap layer. Children are
//                never inside — they get visuals of their own.
//   Bars         a scroller's scrollbars, rastered into an overlay sublayer
//                above the content (zPosition keeps it on top).
//
// Sibling order is zPosition, assigned from the node's own paintOrder() —
// no sublayer-list surgery, ever. Dirt arrives on the invalidate channel
// (`noteInvalidate`): a node means that node, a bare rect means that part
// of every raster it touches, null means everything (the same "no bound
// named repaints everything" rule the X11 damage model has), and geometry
// is re-diffed every frame because comparing four numbers is cheaper than
// knowing.
import { cssColorStraight } from 'ntk';

import { Node } from '../nodes/node.js';
import { addDamageRect, damageToPaint } from '../nodes/damage.js';
import { intersectRects } from '../nodes/rects.js';
import { EASING_CONTROL_POINTS, TRANSITION_CONTROL_POINTS } from '../styles.js';
import { CocoaContext2D } from './context2d.js';

export const RASTER_PAD = 2; // antialiasing/italic overhang outside the ink bounds

/**
 * A recording "context" for ntk's SvgView.draw: instead of rasterizing, it
 * captures every fill/stroke as a flat op the bridge's CAShapeLayer path
 * vocabulary can take verbatim. SVG is CA's native tongue — a path per
 * layer, composited and tintable by the render server — and this recorder
 * is what turns the existing, fully-debugged SvgView traversal into that
 * without reimplementing SVG. Anything it cannot express (gradients,
 * images, text, clips) flips `unsupported` and the node falls back to the
 * raster visual, so correctness never depends on coverage.
 */
class ShapeRecorder {
  constructor(matrix) {
    this.ops = [];
    this.unsupported = false;
    this._stack = [];
    this._m = matrix; // [a, b, c, d, e, f]
    this._alpha = 1;
    this.fillStyle = '#000';
    this.strokeStyle = 'none';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this._dash = [];
  }

  _apply(x, y) {
    const [a, b, c, d, e, f] = this._m;
    return [a * x + c * y + e, b * x + d * y + f];
  }

  _scaleFactor() {
    const [a, b, c, d] = this._m;
    return Math.sqrt(Math.abs(a * d - b * c));
  }

  save() {
    this._stack.push({ m: [...this._m], alpha: this._alpha });
  }

  restore() {
    const prev = this._stack.pop();
    if (prev) {
      this._m = prev.m;
      this._alpha = prev.alpha;
    }
  }

  translate(x, y) {
    const [a, b, c, d, e, f] = this._m;
    this._m = [a, b, c, d, a * x + c * y + e, b * x + d * y + f];
  }

  scale(x, y) {
    const [a, b, c, d, e, f] = this._m;
    this._m = [a * x, b * x, c * y, d * y, e, f];
  }

  rotate(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const [a, b, c, d, e, f] = this._m;
    this._m = [
      a * cos + c * sin,
      b * cos + d * sin,
      c * cos - a * sin,
      d * cos - b * sin,
      e,
      f,
    ];
  }

  transform(a2, b2, c2, d2, e2, f2) {
    const [a, b, c, d, e, f] = this._m;
    this._m = [
      a * a2 + c * b2,
      b * a2 + d * b2,
      a * c2 + c * d2,
      b * c2 + d * d2,
      a * e2 + c * f2 + e,
      b * e2 + d * f2 + f,
    ];
  }

  getTransform() {
    const [a, b, c, d, e, f] = this._m;
    return { a, b, c, d, e, f };
  }

  set globalAlpha(value) {
    if (typeof value === 'number') this._alpha = value;
  }

  get globalAlpha() {
    return this._alpha;
  }

  setLineDash(segments) {
    this._dash = Array.isArray(segments) ? segments : [];
  }

  /**
   * A recording gradient: SvgView resolves an SVG paint server to canvas
   * gradient calls, and CAGradientLayer speaks the same vocabulary — a
   * line, stops, colours — so a linear fill stays retained instead of
   * pushing the whole document to the raster fallback. The line is mapped
   * through the current matrix at creation, which is also where SvgView
   * computes it.
   */
  createLinearGradient(x0, y0, x1, y1) {
    return {
      __shapeGradient: true,
      a: this._apply(x0, y0),
      b: this._apply(x1, y1),
      stops: [],
      addColorStop(offset, color) {
        this.stops.push([offset, color]);
      },
    };
  }

  createRadialGradient() {
    // CA's radial type does not speak canvas's two-circle geometry; wrong
    // pixels are worse than rastered ones, so this stays the fallback.
    this.unsupported = true;
    return { addColorStop() {} };
  }

  drawImage() {
    this.unsupported = true;
  }

  fillText() {
    this.unsupported = true;
  }

  clip() {
    this.unsupported = true;
  }

  _pathOps(path) {
    const cmds = path?._cmds;
    if (!Array.isArray(cmds)) {
      this.unsupported = true;
      return null;
    }
    const out = [];
    for (const c of cmds) {
      if (c.type === 'M') out.push(['move', ...this._apply(c.x, c.y)]);
      else if (c.type === 'L') out.push(['line', ...this._apply(c.x, c.y)]);
      else if (c.type === 'C')
        out.push([
          'curve',
          ...this._apply(c.x1, c.y1),
          ...this._apply(c.x2, c.y2),
          ...this._apply(c.x, c.y),
        ]);
      else if (c.type === 'Q')
        out.push([
          'quad',
          ...this._apply(c.x1, c.y1),
          ...this._apply(c.x, c.y),
        ]);
      else if (c.type === 'Z') out.push(['close']);
    }
    return out;
  }

  _color(style) {
    if (typeof style !== 'string') {
      this.unsupported = true;
      return null;
    }
    const parsed = cssColorStraight(style);
    if (!parsed) return null;
    const [r, g, b, a] = parsed;
    return [r, g, b, a * this._alpha];
  }

  fill(path, rule) {
    const ops = this._pathOps(path);
    if (!ops) return;
    const style = this.fillStyle;
    if (style && style.__shapeGradient) {
      const stops = [];
      for (const [offset, color] of style.stops) {
        const parsed = cssColorStraight(String(color));
        if (!parsed) continue;
        const [r, g, b, a] = parsed;
        stops.push([
          Math.min(1, Math.max(0, offset)),
          [r, g, b, a * this._alpha],
        ]);
      }
      if (stops.length === 0) return;
      stops.sort((p, q) => p[0] - q[0]);
      this.ops.push({
        kind: 'gradientFill',
        path: ops,
        a: style.a,
        b: style.b,
        stops,
        rule: rule ?? 'nonzero',
      });
      return;
    }
    const color = this._color(style);
    if (!color || color[3] === 0) return;
    this.ops.push({ kind: 'fill', path: ops, color, rule: rule ?? 'nonzero' });
  }

  stroke(path) {
    const ops = this._pathOps(path);
    const color = this._color(this.strokeStyle);
    if (!ops || !color || color[3] === 0) return;
    this.ops.push({
      kind: 'stroke',
      path: ops,
      color,
      lineWidth: this.lineWidth * this._scaleFactor(),
      lineCap: this.lineCap,
      dash: this._dash.map((v) => v * this._scaleFactor()),
    });
  }
}

/**
 * Paint everything a node draws itself — Node.paint minus the children.
 *
 * An element that overrides `paint` (every drawing element in
 * @react-x11/components does: `super.paint(ctx)` for the box, then the
 * scene) has its content nowhere but in that override, so the override is
 * what a raster replays — with the children held back by `_ownPaintOnly`,
 * the one presenter-side flag `Node._paintChildren` honours, because they
 * have visuals of their own. Everything else paints piecewise, which is
 * what `Node.paint` would do minus the child walk.
 */
function paintSelf(node, ctx) {
  if (node.paint !== Node.prototype.paint) {
    node._ownPaintOnly = true;
    try {
      node.paint(ctx);
    } finally {
      node._ownPaintOnly = false;
    }
    return;
  }
  node._paintShadow(ctx);
  node._paintBackground(ctx);
  node.paintContent(ctx);
  node._paintBorder(ctx);
  node._paintOutline(ctx);
}

// Past this many bare-rect claims in one frame the overlap test costs more
// than it saves, and the answer is the one a null claim gives: everything.
const MAX_DIRTY_RECTS = 64;

// The pass list of a raster that repaints in full: one pass, unbounded.
const FULL_PASS = Object.freeze([null]);

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

const EDGE_PROPS = [
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
  'borderStartColor',
  'borderEndColor',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderStartWidth',
  'borderEndWidth',
];

/**
 * Does `style` draw as a plain box — the property vocabulary of a layer
 * (background, a uniform solid border, one radius), nothing that needs a
 * raster? What decides whether a node is a PropBox on the layer presenter,
 * and whether the surface presenter can promote it (src/cocoa/promotion.js).
 */
export function stylePaintsPlain(node, style = node.style ?? {}) {
  if (node.kind !== 'box') return false;
  if (style.backgroundImage || style.boxShadow || style.outlineWidth) {
    return false;
  }
  for (const prop of EDGE_PROPS) if (style[prop] !== undefined) return false;
  if (style.borderStyle !== undefined && style.borderStyle !== 'solid') {
    return false;
  }
  if (style.borderWidth !== undefined && typeof style.borderWidth !== 'number')
    return false;
  return uniformRadius(style.borderRadius) !== null;
}

/**
 * Style property → the key path on a PropBox's own layer, for the
 * animations the presenter takes off the frame clock and hands to the
 * render server (docs/architecture/animation.md §4.2). Only what the layer
 * expresses as a property of itself qualifies: a colour on `<text>` is a
 * re-raster per frame, a layout property moves the siblings, and both stay
 * on the JS loop. `scaled` values go out in points, as `_syncPropBox`
 * sends them.
 */
const ANIMATED_KEY_PATHS = Object.freeze({
  backgroundColor: { keyPath: 'backgroundColor', colour: true },
  borderColor: { keyPath: 'borderColor', colour: true },
  borderWidth: { keyPath: 'borderWidth', scaled: true },
  borderRadius: { keyPath: 'cornerRadius', scaled: true },
});

// the ids the bridge reports an animation's end under: unique per process,
// looked up per app (`_animationEnds`)
let animationSeq = 0;

export function uniformRadius(radius) {
  if (radius === undefined) return 0;
  if (typeof radius === 'number') return radius;
  return null; // per-corner shapes go to raster
}

export class Visual {
  constructor(presenter, node) {
    this.presenter = presenter;
    this.node = node;
    this.layer = presenter.native.createLayer();
    this.parentVisual = null;
    this.props = {}; // last-sent layer properties, diffed against
  }

  set(next) {
    const diff = {};
    let changed = false;
    for (const key of Object.keys(next)) {
      const value = next[key];
      const prev = this.props[key];
      const same = Array.isArray(value)
        ? Array.isArray(prev) &&
          prev.length === value.length &&
          value.every((v, i) => v === prev[i])
        : value === prev;
      if (!same) {
        diff[key] = value;
        this.props[key] = value;
        changed = true;
      }
    }
    if (changed) this.presenter.native.setLayerProps(this.layer, diff);
  }

  attach(parentVisual) {
    if (this.parentVisual === parentVisual) return;
    this.presenter.native.removeFromSuperlayer(this.layer);
    this.presenter.native.addSublayer(parentVisual.layer, this.layer);
    this.parentVisual = parentVisual;
    // a reparented layer re-sends everything: the new superlayer changes
    // what `frame` is relative to
    this.props = {};
  }

  destroy() {
    this.presenter.native.removeFromSuperlayer(this.layer);
  }
}

export class RasterState {
  constructor() {
    this.surface = null;
    this.gen = 0;
    this.width = 0;
    this.height = 0;
    this.ctx = null;
  }

  ensure(presenter, width, height, scale) {
    if (!this.surface || this.width !== width || this.height !== height) {
      // the layer holds its own copy of what it shows, so the bitmap a
      // resize retires can go now rather than with the handle's finalizer
      this.release(presenter.native);
      this.surface = presenter.native.createSurface(width, height, scale);
      this.width = width;
      this.height = height;
      this.gen++;
      if (!this.ctx) {
        this.ctx = new CocoaContext2D(
          presenter.native,
          () => this.surface,
          () => this.gen,
        );
        this.ctx._fonts = presenter.fonts;
      }
    }
    return this.ctx;
  }

  /** Free the bitmap now (bridge 0.4's `releaseSurface`); older bridges
   * free it from the handle's finalizer, and this is then just the drop. */
  release(native) {
    const surface = this.surface;
    this.surface = null;
    if (surface && typeof native.releaseSurface === 'function') {
      native.releaseSurface(surface);
    }
  }
}

/**
 * A plain box as the properties of its layer — what a PropBox visual sends
 * on the layer presenter and what a promoted node's layer is set from on
 * the surface presenter (src/cocoa/promotion.js): one function, so a box
 * reads the same on either. `parentOrigin` is what `frame` is relative to,
 * in window coordinates; everything goes out in points.
 */
export function propBoxProps(node, app, scale, parentOrigin, order) {
  const abs = node.abs;
  const style = node.style ?? {};
  const border = typeof style.borderWidth === 'number' ? style.borderWidth : 0;
  const colour = (value) =>
    value ? (app._parseColor(String(value)) ?? [0, 0, 0, 0]) : [0, 0, 0, 0];
  return {
    frame: [
      (abs.x - parentOrigin.x) / scale,
      (abs.y - parentOrigin.y) / scale,
      Math.max(0, abs.width) / scale,
      Math.max(0, abs.height) / scale,
    ],
    zPosition: order,
    hidden: Boolean(node.hidden),
    masksToBounds: Boolean(node.clipsChildren?.()) && !node.isScroller?.(),
    cornerRadius: (uniformRadius(style.borderRadius) ?? 0) / scale,
    backgroundColor: colour(style.backgroundColor),
    borderWidth: border / scale,
    borderColor: colour(style.borderColor),
  };
}

// --- animations the render server runs ---------------------------------------
//
// The node model keeps deciding what is animating and when it ends
// (nodes.js `_retarget` / `_updateLoops`); what moves here is who
// interpolates. Taken means the node's style goes to its target — the
// layer's model value, sent by the next frame's property diff — and that
// frame attaches an explicit animation carrying the pixels there; no frame
// after it is scheduled for the property, and a loop costs no JS frames at
// all. Declined means the frame clock runs it exactly as before, so
// nothing here is load-bearing for correctness.
//
// Kept apart from the presenter because two of them hand animations over:
// the layer presenter, where every plain box has a layer, and the surface
// presenter's promotion (src/cocoa/promotion.js), where only the nodes
// that animate do. They differ in which node has a layer and agree on
// everything from there — `layerOf(node)` is the whole of the difference.

/**
 * The animations one presenter has handed to the render server: what
 * `take` accepted and is waiting for the frame that attaches it, and what
 * is running on a layer. `onIdle(node)`, when given, hears that the last
 * animation running for a node ended on the bridge's word — the one end
 * no frame follows on its own.
 */
export class LayerAnimations {
  constructor({ native, app, scale, layerOf, onIdle = null }) {
    this.native = native;
    this.app = app;
    this.scale = scale;
    this.layerOf = layerOf;
    this.onIdle = onIdle;
    this.pending = new Map(); // node -> Map(prop -> entry)
    this.live = new Map(); // node -> Map(id -> { prop, key, entry })
  }

  /**
   * Take `prop`'s animation for `node`, or decline. Decided against the
   * *target* style: a `:hover` that adds a shadow turns the node into a
   * raster in the same swap that starts a fade, and a raster's background
   * is in its bitmap, not on its layer.
   */
  take(node, prop, entry) {
    const map = ANIMATED_KEY_PATHS[prop];
    if (!map || !stylePaintsPlain(node, node._targetStyle ?? node.style)) {
      return false;
    }
    if (this._value(map, entry.from) == null) return false;
    if (this._value(map, entry.to) == null) return false;
    let pending = this.pending.get(node);
    if (!pending) this.pending.set(node, (pending = new Map()));
    pending.set(prop, entry);
    return true;
  }

  /** Stop what runs for `prop` on `node`: a loop the window lost sight of,
   *  a declaration that changed, a transition the clock takes back. */
  cancel(node, prop) {
    this.pending.get(node)?.delete(prop);
    this._removeLive(node, prop);
  }

  /** Is anything taken for `node` — waiting for a frame, or running? */
  has(node) {
    return this.pending.has(node) || this.live.has(node);
  }

  _ends() {
    return (this.app._animationEnds ??= new Map());
  }

  /** A style value as the layer takes it — a colour as components, a
   *  length in points — or null for one the layer cannot animate. */
  _value(map, value) {
    if (map.colour) {
      return typeof value === 'string'
        ? (this.app._parseColor(value) ?? null)
        : null;
    }
    return typeof value === 'number'
      ? value / (map.scaled ? this.scale : 1)
      : null;
  }

  /** The frame's half: attach what `take` accepted to `layer`, after the
   *  model value went out, inside the same transaction. */
  apply(node, layer) {
    const pending = this.pending.get(node);
    if (!pending) return;
    this.pending.delete(node);
    for (const [prop, entry] of pending) {
      const map = ANIMATED_KEY_PATHS[prop];
      const id = `rx${++animationSeq}`;
      const key = `${prop}:${id}`;
      const opts = { duration: entry.duration / 1000, id };
      if (entry.loop) {
        // a loop replaces whatever ran for the property: its declaration
        // changed, and a loop restarts from the top when it does
        this._removeLive(node, prop);
        opts.from = this._value(map, entry.from);
        opts.to = this._value(map, entry.to);
        opts.timing = EASING_CONTROL_POINTS[entry.easing];
        opts.repeat = Infinity;
        opts.autoreverse = entry.alternate;
      } else if (map.colour) {
        // From where the pixels are — which is what "an interrupted
        // transition reverses from where it got to" means here. A colour
        // cannot be additive, so the one before it is replaced.
        this._removeLive(node, prop);
        const shown = this.native.presentationValue?.(layer, map.keyPath);
        opts.from = Array.isArray(shown) ? shown : this._value(map, entry.from);
        opts.to = this._value(map, entry.to);
        opts.timing = TRANSITION_CONTROL_POINTS;
      } else {
        // Additive: a delta over the model value, (old − new) → 0, and the
        // ones before it keep running and sum. Continuity on a retarget with
        // nothing read back, however many are in flight.
        opts.from = this._value(map, entry.from) - this._value(map, entry.to);
        opts.to = 0;
        opts.additive = true;
        opts.timing = TRANSITION_CONTROL_POINTS;
      }
      this.native.addAnimation(layer, map.keyPath, opts, key);
      // looked up after the removals above, which may have pruned the map
      let live = this.live.get(node);
      if (!live) this.live.set(node, (live = new Map()));
      live.set(id, { prop, key, entry });
      this._ends().set(id, (ev) => this._animationEnded(node, id, ev));
    }
  }

  /** Every animation running for `prop` on `node`, off the layer and out
   *  of the books. */
  _removeLive(node, prop) {
    const live = this.live.get(node);
    if (!live) return;
    const layer = this.layerOf(node);
    for (const [id, run] of live) {
      if (run.prop !== prop) continue;
      live.delete(id);
      this._ends().delete(id);
      if (layer) this.native.removeAnimation(layer, run.key);
    }
    if (live.size === 0) this.live.delete(node);
  }

  /** The bridge's `animation-end` for one of ours — it ran out, or CA
   *  dropped it. An older additive one ending changes nothing: the node
   *  checks the entry is still the one it holds. */
  _animationEnded(node, id) {
    this._ends().delete(id);
    const live = this.live.get(node);
    const run = live?.get(id);
    if (!run) return;
    live.delete(id);
    if (live.size === 0) this.live.delete(node);
    node._offloadEnded(run.prop, run.entry);
    if (!this.has(node)) this.onIdle?.(node);
  }

  /** The layer is going — the visual is destroyed, or turns into a raster —
   *  and every animation on it goes with it. What was still waiting for a
   *  frame goes back to the frame clock when the node stays (`reclaim`);
   *  what was running is over, and the model shows. */
  drop(node, reclaim) {
    const pending = this.pending.get(node);
    if (pending) {
      this.pending.delete(node);
      for (const [prop, entry] of pending) {
        if (reclaim) node._offloadDeclined(prop, entry);
        else node._offloadEnded(prop, entry);
      }
    }
    const live = this.live.get(node);
    if (!live) return;
    this.live.delete(node);
    for (const [id, run] of live) {
      this._ends().delete(id);
      node._offloadEnded(run.prop, run.entry);
    }
  }
}

export class CocoaLayerPresenter {
  constructor(window) {
    this.window = window;
    this.native = window._native;
    this.scale = window.scale;
    this.fonts = window.app.fonts;
    this.visuals = new Map(); // node -> Visual
    this.rasters = new Map(); // node -> RasterState
    this.bars = new Map(); // scroller node -> Map(axis -> { layer, raster })
    // animations taken off the frame clock, by the node's own layer
    this.animations = new LayerAnimations({
      native: this.native,
      app: window.app,
      scale: this.scale,
      layerOf: (node) => this.visuals.get(node)?.layer ?? null,
    });
    // Claims since the last frame — taken at the top of `frame()`, the way
    // the X11 path takes its damage before painting, so a claim made from
    // inside a paint lands in the next frame instead of being cleared with
    // this one.
    this.dirty = new Set(); // nodes
    this.dirtyRects = []; // bare rects, window coordinates
    this.dirtyAll = true; // first frame rasters everything
    this._claims = null; // the frame in progress: { all, nodes, rects }
    this.rootVisual = {
      layer: window._layer,
    };
    this.rootBackground = undefined;
  }

  noteInvalidate(damage, layoutChanged) {
    if (damage == null) {
      this.dirtyAll = true;
    } else if (damage.kind) {
      this.dirty.add(damage);
    } else if (layoutChanged) {
      // A structural claim that names a rect (a child-list mutation's
      // pre-arrangement bound) or nothing at all: the walk finds new and
      // removed nodes by itself, but a SURVIVING node's content can have
      // changed behind an unchanged box — a swapped text child in a
      // flex-grown label was the shot that caught it — and a rect cannot
      // say which node that was. Everything re-rasters; a scroll names its
      // node and stays off this path.
      this.dirtyAll = true;
    } else if (damage.width > 0 && damage.height > 0) {
      // A bare rect with no layout behind it is a claim about pixels — an
      // element's `invalidate(false, rect)` for the box a dragged node
      // moved through, the region `scrollContents` shifts, the strip an
      // animation ticks in — and it cannot name the node it came from
      // either. The frame repaints that part of every raster visual whose
      // ink the rect touches (the same conservative answer the damage model
      // gives a rect: whatever draws there repaints, clipped to it);
      // property boxes carry no raster and re-diff every frame regardless.
      // Copied, because a caller's rect is very often a live `abs` about
      // to be laid out.
      if (this.dirtyRects.length >= MAX_DIRTY_RECTS) {
        this.dirtyAll = true;
      } else {
        this.dirtyRects.push({
          x: damage.x,
          y: damage.y,
          width: damage.width,
          height: damage.height,
        });
      }
    }
  }

  /** The claims a frame consumes, cleared for the next one. */
  _takeClaims() {
    const claims = {
      all: this.dirtyAll,
      nodes: this.dirty,
      rects: this.dirtyAll ? [] : this.dirtyRects,
    };
    this.dirtyAll = false;
    this.dirty = new Set();
    this.dirtyRects = [];
    return claims;
  }

  /**
   * What this frame repaints of the raster covering `rect` for `node`: null
   * for nothing, `FULL_PASS` for all of it, otherwise the window-space rects
   * the frame's bare claims cover inside it, shaped exactly as the X11 path
   * shapes its damage list: whole pixels, disjoint, at most a few of them,
   * and one box instead of several when the several fill most of it —
   * because a node painted in two overlapping passes blends translucent ink
   * over itself, and because each pass is a full replay of the node's paint
   * that only its own culling makes cheap. A pan's shifted region and the
   * two strips beside it come out as the one pass they are.
   */
  _rasterPasses(node, rect, sizeChanged) {
    const claims = this._claims;
    if (sizeChanged || !claims || claims.all || claims.nodes.has(node)) {
      return FULL_PASS;
    }
    let passes = null;
    for (const claimed of claims.rects) {
      const hit = intersectRects(wholePixels(claimed), rect);
      if (hit) passes = addDamageRect(passes, hit);
    }
    return passes && damageToPaint(passes);
  }

  /** Does this frame re-raster the visual covering `rect` for `node`? */
  _needsRaster(node, rect) {
    return this._rasterPasses(node, rect, false) !== null;
  }

  /** The whole frame: one walk, one transaction, property diffs only. */
  frame(windowNode) {
    const native = this.native;
    const claims = (this._claims = this._takeClaims());
    let presented = false;
    native.txBegin({ disableActions: true });
    try {
      this._syncWindowBackground(windowNode);
      const seen = new Set();
      this._syncChildren(windowNode, this.rootVisual, seen);
      for (const [node, visual] of this.visuals) {
        if (!seen.has(node)) {
          visual.destroy();
          this.visuals.delete(node);
          this._dropRaster(node);
          this.animations.drop(node, false);
          const bars = this.bars.get(node);
          if (bars) {
            for (const entry of bars.values()) {
              native.removeFromSuperlayer(entry.layer);
              entry.raster.release(native);
            }
            this.bars.delete(node);
          }
        }
      }
      presented = true;
    } finally {
      native.txCommit();
      this._claims = null;
      // a frame that threw half-way presents what it got to; the claims it
      // was answering are still owed, so the next frame answers them again
      if (!presented) this._restoreClaims(claims);
    }
  }

  _restoreClaims(claims) {
    this.dirtyAll ||= claims.all;
    for (const node of claims.nodes) this.dirty.add(node);
    if (this.dirtyRects.length + claims.rects.length > MAX_DIRTY_RECTS) {
      this.dirtyAll = true;
    } else {
      this.dirtyRects.push(...claims.rects);
    }
  }

  _dropRaster(node) {
    const raster = this.rasters.get(node);
    if (!raster) return;
    raster.release(this.native);
    this.rasters.delete(node);
  }

  _syncWindowBackground(windowNode) {
    const color = windowNode._windowBackground?.();
    if (color === this.rootBackground) return;
    this.rootBackground = color;
    const parsed =
      typeof color === 'string' ? this.window.app._parseColor(color) : null;
    this.native.setLayerProps(this.rootVisual.layer, {
      backgroundColor: parsed ?? [0, 0, 0, 0],
    });
  }

  _syncChildren(node, parentVisual, seen) {
    let order = 0;
    for (const child of node.paintOrder()) {
      if (child.isWindow || !child.yoga) continue; // popups are windows
      this._syncNode(child, parentVisual, order++, seen);
    }
  }

  _syncNode(node, parentVisual, order, seen) {
    if (node.style?.display === 'none') return;
    seen.add(node);
    const wantsRaster = !stylePaintsPlain(node);
    let visual = this.visuals.get(node);
    if (visual && visual.isRaster !== wantsRaster) {
      visual.destroy();
      this._dropRaster(node);
      // a layer that turns into a raster takes its animations with it; the
      // frame clock can still run them over the bitmap
      if (wantsRaster) this.animations.drop(node, true);
      visual = null;
    }
    if (wantsRaster && this.animations.pending.has(node)) {
      this.animations.drop(node, true);
    }
    if (!visual) {
      visual = new Visual(this, node);
      visual.isRaster = wantsRaster;
      this.visuals.set(node, visual);
    }
    visual.attach(parentVisual);

    const parentOrigin = this._originOf(parentVisual);
    if (wantsRaster) {
      this._syncRaster(node, visual, parentOrigin, order);
    } else {
      this._syncPropBox(node, visual, parentOrigin, order);
    }
    // Children live inside the node's CONTENT box. A property box clips on
    // its own layer; a rastered box whose layer covers its ink bounds needs
    // an inner clip layer at the content box — and a SCROLLER always gets
    // one, because the clip host is where Core Animation's native scroll
    // lives: children sit at content coordinates and the host's bounds
    // origin is the offset, so a wheel notch is one property set and the
    // render server shifts what it already has.
    const scroller = Boolean(node.isScroller?.());
    let childHost = visual;
    if (scroller || (wantsRaster && node.clipsChildren?.())) {
      childHost = this._ensureClipHost(node, visual, scroller);
    } else if (visual.clipHost) {
      this.native.removeFromSuperlayer(visual.clipHost.layer);
      visual.clipHost = null;
    }
    if (scroller) this._syncBars(node, visual);
    // A <text>'s spans are painted by the paragraph's own raster
    // (collectSpans walks them); giving them layers would draw them twice.
    if (node.kind !== 'text') this._syncChildren(node, childHost, seen);
  }

  _ensureClipHost(node, visual, scroller = false) {
    if (!visual.clipHost) {
      const layer = this.native.createLayer();
      this.native.addSublayer(visual.layer, layer);
      visual.clipHost = { layer, props: {} };
    }
    const abs = node.abs;
    const host = visual.clipHost;
    const s = this.scale;
    const scrollX = scroller ? (node.scrollX ?? 0) : 0;
    const scrollY = scroller ? (node.scrollY ?? 0) : 0;
    const frame = [
      (abs.x - visual.origin.x) / s,
      (abs.y - visual.origin.y) / s,
      Math.max(0, abs.width) / s,
      Math.max(0, abs.height) / s,
    ];
    const bounds = [
      scrollX / s,
      scrollY / s,
      Math.max(0, abs.width) / s,
      Math.max(0, abs.height) / s,
    ];
    const prev = host.props;
    const frameChanged =
      !prev.frame || prev.frame.some((value, i) => value !== frame[i]);
    const boundsChanged =
      !prev.bounds || prev.bounds.some((value, i) => value !== bounds[i]);
    if (frameChanged || boundsChanged) {
      prev.frame = frame;
      prev.bounds = bounds;
      this.native.setLayerProps(host.layer, {
        frame,
        bounds,
        masksToBounds: true,
        zPosition: 0.5,
      });
    }
    // Children position against CONTENT coordinates: node.abs already has
    // the scroll subtracted (absolutize applies the offset), so adding it
    // back here means a pure scroll changes nothing about any child's
    // frame — only the bounds origin above moves.
    host.origin = { x: abs.x - scrollX, y: abs.y - scrollY };
    return host;
  }

  _originOf(visual) {
    return visual.origin ?? { x: 0, y: 0 };
  }

  _syncPropBox(node, visual, parentOrigin, order) {
    const abs = node.abs;
    visual.origin = { x: abs.x, y: abs.y };
    visual.set(
      propBoxProps(node, this.window.app, this.scale, parentOrigin, order),
    );
    // after the model value went out, inside the same transaction
    this.animations.apply(node, visual.layer);
  }

  /** The window's animation seam (src/cocoa/window.js): take `prop`'s
   *  animation for `node` off the frame clock, or decline. */
  animate(node, prop, entry) {
    return this.animations.take(node, prop, entry);
  }

  /** …and stop what runs for `prop` on `node`. */
  cancel(node, prop) {
    this.animations.cancel(node, prop);
  }

  /**
   * `<svg>` as CAShapeLayers: record SvgView's own traversal through the
   * ShapeRecorder and hand each captured fill/stroke to a shape layer. One
   * icon becomes two or three server-composited paths instead of a bitmap;
   * anything the recorder cannot express falls back to the raster visual.
   * Returns whether the shape route handled the node.
   */
  _trySvgShapes(node, visual, rect, sizeChanged) {
    const s = this.scale;
    if (
      !sizeChanged &&
      visual.shapeSignature &&
      !this._needsRaster(node, rect)
    ) {
      return true; // shapes are current
    }
    const recorder = new ShapeRecorder([
      1 / s,
      0,
      0,
      1 / s,
      -rect.x / s,
      -rect.y / s,
    ]);
    try {
      node.paintContent(recorder);
    } catch {
      return false;
    }
    if (recorder.unsupported) return false;
    const signature = JSON.stringify(recorder.ops);
    if (signature === visual.shapeSignature) return true;
    visual.shapeSignature = signature;
    const native = this.native;
    visual.shapeLayers ??= [];
    while (visual.shapeLayers.length > recorder.ops.length) {
      native.removeFromSuperlayer(visual.shapeLayers.pop().layer);
    }
    const w = rect.width / s;
    const h = rect.height / s;
    recorder.ops.forEach((op, i) => {
      const wantGradient = op.kind === 'gradientFill';
      let entry = visual.shapeLayers[i];
      if (entry && entry.gradient !== wantGradient) {
        native.removeFromSuperlayer(entry.layer);
        entry = null;
      }
      if (!entry) {
        entry = wantGradient
          ? {
              gradient: true,
              layer: native.createGradientLayer(),
              // the mask is not in the sublayer tree — CA owns the
              // relationship, and the External's finalizer owns the memory
              mask: native.createShapeLayer(),
            }
          : { gradient: false, layer: native.createShapeLayer() };
        native.addSublayer(visual.layer, entry.layer);
        visual.shapeLayers[i] = entry;
      }
      native.setLayerProps(entry.layer, {
        frame: [0, 0, w, h],
        zPosition: i,
        ...(wantGradient ? { mask: entry.mask } : {}),
      });
      if (wantGradient) {
        native.setLayerProps(entry.mask, { frame: [0, 0, w, h] });
        native.setShapeProps(entry.mask, {
          path: op.path,
          fillColor: [0, 0, 0, 1],
          strokeColor: null,
          fillRule: op.rule,
        });
        // start/end are unit coordinates across the layer's bounds
        native.setGradientProps(entry.layer, {
          colors: op.stops.map(([, color]) => color),
          locations: op.stops.map(([offset]) => offset),
          startPoint: [op.a[0] / (w || 1), op.a[1] / (h || 1)],
          endPoint: [op.b[0] / (w || 1), op.b[1] / (h || 1)],
          type: 'axial',
        });
        return;
      }
      native.setShapeProps(
        entry.layer,
        op.kind === 'fill'
          ? {
              path: op.path,
              fillColor: op.color,
              strokeColor: null,
              fillRule: op.rule,
            }
          : {
              path: op.path,
              fillColor: null,
              strokeColor: op.color,
              lineWidth: op.lineWidth,
              lineCap: op.lineCap,
              ...(op.dash.length ? { lineDashPattern: op.dash } : {}),
            },
      );
    });
    return true;
  }

  _dropSvgShapes(visual) {
    if (!visual.shapeLayers) return;
    for (const entry of visual.shapeLayers) {
      this.native.removeFromSuperlayer(entry.layer);
    }
    visual.shapeLayers = null;
    visual.shapeSignature = null;
  }

  _syncRaster(node, visual, parentOrigin, order) {
    const bounds = node._ownPaintBounds
      ? node._ownPaintBounds()
      : { ...node.abs };
    const rect = {
      x: Math.floor(bounds.x) - RASTER_PAD,
      y: Math.floor(bounds.y) - RASTER_PAD,
      width: Math.ceil(bounds.width) + RASTER_PAD * 2,
      height: Math.ceil(bounds.height) + RASTER_PAD * 2,
    };
    // the layer's local origin is the ink rect's corner, and that is what
    // children (and the clip host) position against
    visual.origin = { x: rect.x, y: rect.y };
    const s = this.scale;
    visual.set({
      frame: [
        (rect.x - parentOrigin.x) / s,
        (rect.y - parentOrigin.y) / s,
        rect.width / s,
        rect.height / s,
      ],
      zPosition: order,
      hidden: Boolean(node.hidden),
      // the layer covers the ink bounds; clipping (if any) belongs to the
      // CONTENT box, which a raster self cannot express — scrolling
      // containers that also raster keep clipping via a child guard below
      masksToBounds: false,
    });

    let raster = this.rasters.get(node);
    if (!raster) {
      raster = new RasterState();
      this.rasters.set(node, raster);
    }
    const sizeChanged =
      raster.width !== rect.width || raster.height !== rect.height;
    if (node.kind === 'svg') {
      if (this._trySvgShapes(node, visual, rect, sizeChanged)) {
        raster.width = rect.width;
        raster.height = rect.height;
        return;
      }
      this._dropSvgShapes(visual);
    }
    const passes = this._rasterPasses(node, rect, sizeChanged);
    if (!passes) return;
    const ctx = raster.ensure(this, rect.width, rect.height, this.window.scale);
    // The bitmap is this visual's composition cache, the way the window's
    // backing store is the surface presenter's: a pass over part of it
    // clears and clips to that part and leaves the rest as last frame drew
    // it, and `paintDamage()` names the pass, so an element culls a drag
    // step or an animation tick exactly as it does on X11 (docs/extending.md,
    // "Drawing a scene into one node") instead of replaying its whole scene
    // into a clip that throws almost all of it away. The full pass is the
    // same loop with nothing to clip.
    const root = node.root;
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
          if (root) root._paintDamage = pass;
          paintSelf(node, ctx);
        } finally {
          if (root) root._paintDamage = null;
          ctx.restore();
        }
      }
    } finally {
      ctx.restore();
    }
    this.native.surfaceToLayer(raster.surface, visual.layer);
  }

  /**
   * One thin overlay layer per scroll axis, rastered at the bar's own strip
   * — never at the scroller's size. The strip is the track extent by the
   * bar width plus an antialiasing pad, so a scroll frame re-rasters a few
   * thousand pixels instead of the viewport: the first run of the
   * presenter bench caught the full-size version costing more than the
   * content it decorated (scripts/bench/presenters.js, `scroll`).
   *
   * The painter is still `_paintScrollbars` — both bars, one call — with
   * the other axis's ink falling outside this strip's surface, where
   * CoreGraphics clips it for free. Cheaper than a per-bar painting seam,
   * and the corner case where both bars show costs two thin rasters
   * instead of one bounding box that would be nearly the scroller again.
   */
  _syncBars(node, visual) {
    const scrollbars = node._scrollbars?.() ?? [];
    let bars = this.bars.get(node);
    if (!scrollbars.length) {
      if (bars) {
        for (const entry of bars.values()) {
          this.native.setLayerProps(entry.layer, { hidden: true });
        }
      }
      return;
    }
    if (!bars) {
      bars = new Map();
      this.bars.set(node, bars);
    }
    const s = this.scale;
    const pad = Math.ceil(2 * s);
    const seen = new Set();
    for (const bar of scrollbars) {
      seen.add(bar.axis);
      let entry = bars.get(bar.axis);
      if (!entry) {
        entry = { layer: this.native.createLayer(), raster: new RasterState() };
        this.native.addSublayer(visual.layer, entry.layer);
        bars.set(bar.axis, entry);
      }
      const strip =
        bar.axis === 'x'
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
      const width = Math.max(1, Math.ceil(strip.width));
      const height = Math.max(1, Math.ceil(strip.height));
      this.native.setLayerProps(entry.layer, {
        frame: [
          (strip.x - visual.origin.x) / s,
          (strip.y - visual.origin.y) / s,
          width / s,
          height / s,
        ],
        zPosition: 1e6,
        hidden: false,
      });
      const ctx = entry.raster.ensure(this, width, height, this.window.scale);
      ctx.save();
      try {
        ctx.clearRect(0, 0, width, height);
        ctx.translate(-strip.x, -strip.y);
        node._paintScrollbars(ctx);
      } finally {
        ctx.restore();
      }
      this.native.surfaceToLayer(entry.raster.surface, entry.layer);
    }
    for (const [axis, entry] of bars) {
      if (!seen.has(axis)) {
        this.native.setLayerProps(entry.layer, { hidden: true });
      }
    }
  }
}
