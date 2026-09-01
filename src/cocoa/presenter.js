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
// (`noteInvalidate`): a node means that node, null means everything (the
// same "no bound named repaints everything" rule the X11 damage model has),
// and geometry is re-diffed every frame because comparing four numbers is
// cheaper than knowing.
import { CocoaContext2D } from './context2d.js';

const RASTER_PAD = 2; // antialiasing/italic overhang outside the ink bounds

/** Paint everything a node draws itself — Node.paint minus the children. */
function paintSelf(node, ctx) {
  node._paintShadow(ctx);
  node._paintBackground(ctx);
  node.paintContent(ctx);
  node._paintBorder(ctx);
  node._paintOutline(ctx);
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

function stylePaintsPlain(node) {
  if (node.kind !== 'box') return false;
  const style = node.style ?? {};
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

function uniformRadius(radius) {
  if (radius === undefined) return 0;
  if (typeof radius === 'number') return radius;
  return null; // per-corner shapes go to raster
}

class Visual {
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

class RasterState {
  constructor() {
    this.surface = null;
    this.gen = 0;
    this.width = 0;
    this.height = 0;
    this.ctx = null;
  }

  ensure(presenter, width, height, scale) {
    if (!this.surface || this.width !== width || this.height !== height) {
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
}

export class CocoaLayerPresenter {
  constructor(window) {
    this.window = window;
    this.native = window._native;
    this.scale = window.scale;
    this.fonts = window.app.fonts;
    this.visuals = new Map(); // node -> Visual
    this.rasters = new Map(); // node -> RasterState
    this.bars = new Map(); // scroller node -> { layer, raster, props }
    this.dirty = new Set();
    this.dirtyAll = true; // first frame rasters everything
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
    }
  }

  /** The whole frame: one walk, one transaction, property diffs only. */
  frame(windowNode) {
    const native = this.native;
    native.txBegin({ disableActions: true });
    try {
      this._syncWindowBackground(windowNode);
      const seen = new Set();
      this._syncChildren(windowNode, this.rootVisual, seen);
      for (const [node, visual] of this.visuals) {
        if (!seen.has(node)) {
          visual.destroy();
          this.visuals.delete(node);
          this.rasters.delete(node);
          const bars = this.bars.get(node);
          if (bars) {
            native.removeFromSuperlayer(bars.layer);
            this.bars.delete(node);
          }
        }
      }
    } finally {
      native.txCommit();
    }
    this.dirty.clear();
    this.dirtyAll = false;
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
      this.rasters.delete(node);
      visual = null;
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
    // an inner clip layer at the content box, or `overflow: hidden` under a
    // gradient background would stop clipping.
    let childHost = visual;
    if (wantsRaster && node.clipsChildren?.()) {
      childHost = this._ensureClipHost(node, visual);
    } else if (visual.clipHost) {
      this.native.removeFromSuperlayer(visual.clipHost.layer);
      visual.clipHost = null;
    }
    if (node.isScroller?.()) this._syncBars(node, childHost);
    // A <text>'s spans are painted by the paragraph's own raster
    // (collectSpans walks them); giving them layers would draw them twice.
    if (node.kind !== 'text') this._syncChildren(node, childHost, seen);
  }

  _ensureClipHost(node, visual) {
    if (!visual.clipHost) {
      const layer = this.native.createLayer();
      this.native.addSublayer(visual.layer, layer);
      visual.clipHost = { layer, props: {} };
    }
    const abs = node.abs;
    const host = visual.clipHost;
    const s = this.scale;
    const frame = [
      (abs.x - visual.origin.x) / s,
      (abs.y - visual.origin.y) / s,
      Math.max(0, abs.width) / s,
      Math.max(0, abs.height) / s,
    ];
    const prev = host.props.frame;
    if (!prev || prev.some((value, i) => value !== frame[i])) {
      host.props.frame = frame;
      this.native.setLayerProps(host.layer, {
        frame,
        masksToBounds: true,
        zPosition: 0.5,
      });
    }
    host.origin = { x: abs.x, y: abs.y };
    return host;
  }

  _originOf(visual) {
    return visual.origin ?? { x: 0, y: 0 };
  }

  _syncPropBox(node, visual, parentOrigin, order) {
    const abs = node.abs;
    const style = node.style ?? {};
    const s = this.scale;
    visual.origin = { x: abs.x, y: abs.y };
    const border =
      typeof style.borderWidth === 'number' ? style.borderWidth : 0;
    visual.set({
      frame: [
        (abs.x - parentOrigin.x) / s,
        (abs.y - parentOrigin.y) / s,
        Math.max(0, abs.width) / s,
        Math.max(0, abs.height) / s,
      ],
      zPosition: order,
      hidden: Boolean(node.hidden),
      masksToBounds: Boolean(node.clipsChildren?.()),
      cornerRadius: (uniformRadius(style.borderRadius) ?? 0) / s,
      backgroundColor: style.backgroundColor
        ? (this.window.app._parseColor(String(style.backgroundColor)) ?? [
            0, 0, 0, 0,
          ])
        : [0, 0, 0, 0],
      borderWidth: border / s,
      borderColor: style.borderColor
        ? (this.window.app._parseColor(String(style.borderColor)) ?? [
            0, 0, 0, 0,
          ])
        : [0, 0, 0, 0],
    });
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
    if (!this.dirtyAll && !this.dirty.has(node) && !sizeChanged) return;
    const ctx = raster.ensure(this, rect.width, rect.height, this.window.scale);
    ctx.save();
    try {
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.translate(-rect.x, -rect.y);
      paintSelf(node, ctx);
    } finally {
      ctx.restore();
    }
    this.native.surfaceToLayer(raster.surface, visual.layer);
  }

  _syncBars(node, visual) {
    const scrollbars = node._scrollbars?.() ?? [];
    let bars = this.bars.get(node);
    if (!scrollbars.length) {
      if (bars) this.native.setLayerProps(bars.layer, { hidden: true });
      return;
    }
    if (!bars) {
      bars = { layer: this.native.createLayer(), raster: new RasterState() };
      this.native.addSublayer(visual.layer, bars.layer);
      this.bars.set(node, bars);
    }
    const abs = node.abs;
    const width = Math.max(1, Math.ceil(abs.width));
    const height = Math.max(1, Math.ceil(abs.height));
    this.native.setLayerProps(bars.layer, {
      frame: [0, 0, width / this.scale, height / this.scale],
      zPosition: 1e6,
      hidden: false,
    });
    const ctx = bars.raster.ensure(this, width, height, this.window.scale);
    ctx.save();
    try {
      ctx.clearRect(0, 0, width, height);
      ctx.translate(-abs.x, -abs.y);
      node._paintScrollbars(ctx);
    } finally {
      ctx.restore();
    }
    this.native.surfaceToLayer(bars.raster.surface, bars.layer);
  }
}
