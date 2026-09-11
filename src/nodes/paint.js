// The paint walk: the order children paint in, clipping, and culling against
// the frame's damage. WindowNode's half paints a damaged region of the
// window, background first.

import { isPlaced } from '../layouts.js';
import { isPaintedColor } from './boxpaint.js';
import { DAMAGE_SLOP } from './damage.js';
import { DRAWN_KINDS } from './kinds.js';
import { rectsOverlap } from './rects.js';
import { DEV } from './util.js';
import { devWarnWindowShadow } from './window/capabilities.js';
import { FLASH_COLORS, debugPaint } from './window/debugpaint.js';

/** Node's half of the paint walk, installed onto `Node.prototype` by node.js. */
export class NodePaint {
  /** Drawn, visible children in paint order (stable sort by zIndex). */
  paintOrder() {
    // Hit testing asks at every node it visits and painting at every node
    // it draws, so the filter-map-sort-map here was steady per-event
    // allocation (issue #188). Cached — and verified against the live
    // children on every read rather than invalidated: membership and
    // z-keys are the same reads the filter always did, so a fresh cache
    // costs no allocation and a stale one is impossible, whatever mutates
    // children, styles, visibility or DRAWN_KINDS.
    const cache = this._paintOrderCache;
    if (cache && this._paintOrderFresh(cache)) return cache.order;
    // `display: 'none'` takes a node out of the layout, and it has to leave
    // the paint with it. They were separate before because the only way to
    // hide something was the `hidden` flag, which does both — until a size
    // query started setting `display` from a style block, and the hidden
    // node carried on painting at the position it no longer had.
    const drawn = [];
    const z = [];
    // A placed child — sticky, or a registered position — is lifted over its
    // in-flow siblings of the same `zIndex`, the way CSS paints a positioned
    // or transformed box over non-positioned ones: a header held at the top
    // of a pane sits over the rows that scroll under it, which are its later
    // siblings and would otherwise paint on top. Hit testing walks the same
    // order backwards, so the header also takes the press.
    const lift = [];
    for (const c of this.children) {
      if (
        DRAWN_KINDS.has(c.kind) &&
        c.yoga &&
        !c.hidden &&
        c.style.display !== 'none'
      ) {
        drawn.push(c);
        z.push(c.style.zIndex ?? 0);
        lift.push(isPlaced(c.style) ? 1 : 0);
      }
    }
    // document order already answers the usual no-zIndex case; the sort is
    // only paid when some key actually disagrees with it
    let order = drawn;
    for (let i = 1; i < z.length; i++) {
      if (z[i] < z[i - 1] || (z[i] === z[i - 1] && lift[i] < lift[i - 1])) {
        order = drawn
          .map((node, j) => ({ node, z: z[j], lift: lift[j], j }))
          .sort((a, b) => a.z - b.z || a.lift - b.lift || a.j - b.j)
          .map((e) => e.node);
        break;
      }
    }
    this._paintOrderCache = { order, drawn, z, lift };
    return order;
  }

  /** Do the cached drawn children and their sort keys still match the tree? */
  _paintOrderFresh({ drawn, z, lift }) {
    let j = 0;
    for (const c of this.children) {
      if (
        !DRAWN_KINDS.has(c.kind) ||
        !c.yoga ||
        c.hidden ||
        c.style.display === 'none'
      ) {
        continue;
      }
      if (
        j >= drawn.length ||
        drawn[j] !== c ||
        z[j] !== (c.style.zIndex ?? 0) ||
        lift[j] !== (isPlaced(c.style) ? 1 : 0)
      ) {
        return false;
      }
      j++;
    }
    return j === drawn.length;
  }

  clipsChildren() {
    return this.style.overflow === 'hidden' || this.style.overflow === 'scroll';
  }

  paint(ctx) {
    if (this.hidden) return;
    // Outside the box and under everything, which is the whole of what makes
    // a shadow different from a colour: it is drawn before this node's own
    // background so a translucent background does not sit on top of it, and
    // it inks pixels this node does not own — see `_ownPaintBounds`.
    this._paintShadow(ctx);
    this._paintBackground(ctx);
    // The paint cache covers a node's *content* — the expensive part — and
    // not its box: background and border are one composite each, and keeping
    // them out keeps their styles out of the key. A node that does not
    // implement the protocol has no `paintCachePlan` and pays one property
    // lookup for the privilege.
    const cache = this.paintCachePlan && this.root?._paintCache;
    if (cache) cache.paint(this, ctx);
    else this.paintContent(ctx);
    this._paintChildren(ctx);
    this._paintBorder(ctx);
    // last, and outside the border box: a ring drawn under the border would
    // be half-hidden by it on a control whose border is thicker than the gap
    this._paintOutline(ctx);
  }

  /**
   * What this element draws of its own, between its background and its
   * children — where every built-in that draws anything draws it, and the
   * seam an element that draws over its own scroll offset needs, since the
   * scrollbars go on after the children and `paint` returning is too late
   * to be underneath them.
   */
  paintContent(ctx) {}

  /**
   * The paint-cache protocol (issue #149). A node implements both methods or
   * neither; the base class has neither, so nothing is cached until it opts
   * in, and no existing or future node changes behaviour by default.
   *
   *   paintCachePlan(ctx) -> null | {
   *     key,             // identity: same key must mean same pixels
   *     x, y,            // where the surface goes, in device pixels
   *     width, height,   // its size, in device pixels
   *     format,          // 'argb32', or 'a8' for coverage that gets tinted
   *     tint,            // the colour an 'a8' surface is painted through
   *   }
   *   paintCached(ctx, box, ink) -> void   // draw at the origin of `box`
   *
   * Returning null opts out for this frame, which is the right answer
   * whenever the paint depends on something the key cannot see.
   *
   * `ink` is the colour a mono drawing — one that asked for `'a8'` — must
   * paint in: white where the surface is coverage and the tint arrives at
   * blit time, the tint itself on a backend without coverage surfaces,
   * where the cache bakes the colour into an argb32 entry and puts it in
   * the key (src/paintcache.js). A multi-colour drawing ignores it.
   *
   * **The key is the entire correctness surface.** It must name every input
   * `paintCached` reads, derived from the same values `applyProps` compares
   * so the two cannot drift. Never cache a paint that depends on state
   * outside the key — a focus ring, a hover, a caret blink, anything
   * animating. Run with `REACT_X11_PAINT_CACHE=verify` to have a key that
   * misses something fail loudly instead of showing a stale pixel.
   *
   * `paintCached` draws in *surface-local* coordinates: `box` is at the
   * origin, not at `this.abs`. Reaching for `this.abs.x` inside it is the
   * mistake to look for first when a cached node draws in the wrong place.
   */

  /**
   * Whether anything in this subtree actually reaches outside the clip box.
   *
   * A clip that clips nothing is far from free: each one rebuilds an a8 mask
   * server-side, which is a FillRectangles plus trapezoid rasterization, and
   * ntk brackets every glyph run under a clip with a SetPictureClipRectangles
   * pair. A table sets `overflow: hidden` on every cell so that *long* text
   * truncates, and then almost every cell's text fits — 191 clips a frame, of
   * which a handful do anything.
   *
   * Rounded corners are never skipped: the clip is not a rectangle then, and
   * the rounding can cut a child that a rect test says fits. The one-pixel
   * inset is for antialiasing, which can put ink just outside a glyph's box.
   */
  _childrenCanOverflow() {
    if (this.style?.borderRadius) return true;
    const box = this.abs;
    for (const child of this.children) {
      if (child.isWindow || !child.yoga || child.hidden) continue;
      if (child.style?.display === 'none') continue;
      const b = child._subtreeBounds();
      if (
        b.x < box.x + 1 ||
        b.y < box.y + 1 ||
        b.x + b.width > box.x + box.width - 1 ||
        b.y + b.height > box.y + box.height - 1
      ) {
        return true;
      }
    }
    return false;
  }

  _paintChildren(ctx) {
    // A retained presenter replays a node's `paint` into a visual of that
    // node's own — its children have visuals of their own, so it sets this
    // for the duration of the call (src/cocoa/presenter.js, `paintSelf`).
    // Never set on the X11 or surface paths, where a frame is one walk.
    if (this._ownPaintOnly) return;
    const order = this.paintOrder();
    if (order.length === 0) return;
    const clip = this.clipsChildren() && this._childrenCanOverflow();
    if (clip) {
      ctx.save();
      this._roundedPath(ctx, this.style.borderRadius ?? 0);
      ctx.clip();
    }
    for (const child of order) {
      if (child._promoted) continue; // on a layer of its own: a hole here
      if (child._offscreen(child.abs, DAMAGE_SLOP)) continue;
      if (child._outsideDamage()) continue;
      child.paint(ctx);
    }
    if (clip) ctx.restore();
  }

  /**
   * Nothing this subtree draws lands in the region being repainted, so its
   * drawing does not need to be sent at all. This is where the protocol
   * saving comes from — the clip alone would still put every request on the
   * wire for the server to throw away.
   *
   * Tested against the subtree's bounds, not `abs`: see `paintBounds`. And
   * with the pixel of `DAMAGE_SLOP` to spare. A claim is grown by it before
   * it gets here, but a rect that never was a claim — the strip a scroll
   * blit exposes, a scrollbar's repair — is exact, and antialiasing puts
   * ink just outside a glyph's box (`_childrenCanOverflow` allows the same
   * pixel). Text whose box ends where such a rect begins inks its first
   * column; culled, that column keeps what was under the text where a full
   * repaint has the ink. The pass is clipped to the rect, so painting the
   * text lets that ink land and nothing else.
   */
  _outsideDamage() {
    const damage = this.root?._paintDamage;
    if (!damage) return false;
    return !rectsOverlap(this._subtreeBounds(), damage, DAMAGE_SLOP);
  }

  /**
   * Entirely outside the window, or entirely outside some nearer ancestor
   * that clips its children — either way there is nothing to draw. Worth
   * doing for its own sake, but it is also a correctness fix: X's render
   * traps are 16.16 fixed point, so a coordinate past ±32767 overflows the
   * request. A scrolled list is exactly how you get there — the frame
   * between a scroll and the re-render that follows it can hold rows
   * ninety thousand pixels above the viewport.
   *
   * The ancestor walk matters on its own (issue #211): a scrolling box's
   * own box is often much smaller than the window around it, and its
   * `ctx.clip()` in `_paintChildren` only keeps the *pixels* off the visible
   * surface — every child below the fold still ran its full paint (canvas
   * `onDraw`, text/tex layout, the XRender/PutImage requests that go with
   * them) for the server to then discard. Checking the window alone missed
   * that: a node can sit well inside the window and still be entirely past
   * a scrolling ancestor whose own bounds are the real limit.
   *
   * `rect` asks the same question about part of the node instead — window
   * coordinates, the node's own rect by default. What wants it is anchoring
   * (`src/anchor.js`): a popup pointed at a caret has to know when *the
   * caret* has scrolled out of the editor, which happens many screens before
   * the editor itself goes anywhere.
   *
   * `slop` is how near counts as reaching in. The paint walk passes
   * `DAMAGE_SLOP`, for the reason `_outsideDamage` does: antialiasing puts
   * a glyph's ink a fraction of a pixel past its box, so right-aligned or
   * RTL text whose box ends exactly at a pane's edge, or the window's, inks
   * the first column inside it. Culled, that column goes without the ink in
   * every pass, full repaints included, and the scroll blit carries it: a
   * notch that moves the text in shows the bare column where a full repaint
   * paints the text, and a notch the other way carries the ink onto a
   * column whose full repaint culls it. The pixel's cost is a node whose box
   * touches the edge, such as a list row abutting the viewport, painted and
   * clipped away; its children further out are still culled. Anchoring
   * asks with none, since a caret a pixel past the viewport is out of view.
   */
  _offscreen(rect = this.abs, slop = 0) {
    const window = this.root?.abs;
    if (!window) return false;
    const { x, y, width, height } = rect;
    if (
      x + width <= -slop ||
      y + height <= -slop ||
      x >= window.width + slop ||
      y >= window.height + slop
    ) {
      return true;
    }
    for (let n = this.parent; n && n !== this.root; n = n.parent) {
      if (n.clipsChildren() && !rectsOverlap(rect, n.abs, slop)) return true;
    }
    return false;
  }
}

/** WindowNode's half of the paint walk, installed onto `WindowNode.prototype` by window/window.js. */
export class WindowPaint {
  /** Repaint one damage rect, or the whole window when `damage` is null. */
  _paintRegion(ctx, damage, width, height) {
    // An element that covers the pass with opaque pixels (`Node.opaqueRect`)
    // makes every fill under it wasted work — the clear, the window's
    // background, the node's own and its ancestors'. The first two are
    // skipped here; `_paintBackground` skips the chain's while
    // `_coverChain` names it.
    const cover = this._coverFor(damage ?? { x: 0, y: 0, width, height });
    // A transparent window erases where an opaque one paints over. Its
    // backing store holds premultiplied ARGB, and compositing a translucent
    // background onto the previous frame would compound towards opaque
    // instead of replacing it — a popup that fades in would stick.
    //
    // Before the clip below, deliberately: clearing exactly the damage rect
    // covers the same pixels, and an unclipped clearRect is one server-side
    // FillRectangles where a clipped one has to rasterize a coverage mask.
    //
    // `transparencyEffective`, not `_transparent`: an ARGB window with
    // nothing compositing it must not clear, because the server would show
    // those zeroed pixels as black rather than as the desktop.
    if (this.transparencyEffective && !cover) {
      if (damage) {
        ctx.clearRect(damage.x, damage.y, damage.width, damage.height);
      } else {
        ctx.clearRect(0, 0, width, height);
      }
    }
    if (damage) {
      // The clip is belt to the culling's braces: it bounds the server-side
      // mask work for whatever *does* paint, and it contains any node that
      // inks slightly outside its own rect. Rectangular clips take ntk's
      // server-side fast path, so this is cheap. The unbounded pass stays
      // unclipped on purpose: a clip would only re-report what ntk already
      // does — its fallback present is clamped to min(window, backing)
      // (ntk >= 5.3, window.js _presentNow) — at two SetPictureClipRectangles
      // per composite, which the protocol bench prices at +207 requests for
      // a hundred-icon full repaint.
      ctx.save();
      ctx.beginPath();
      ctx.rect(damage.x, damage.y, damage.width, damage.height);
      ctx.clip();
    }
    if (!cover) this._paintWindowBackground(ctx, damage, width, height);
    if (cover) {
      const chain = new Set();
      for (let n = cover; n; n = n.parent) chain.add(n);
      this._coverChain = chain;
    }
    this._paintDamage = damage;
    try {
      this._paintChildren(ctx);
      // a scrolling window draws its own bars, which `Node.paint` would have
      // done for a box — the window never goes through it
      this._paintScrollbars(ctx);
      if (process.env.REACT_X11_DEBUG_LAYOUT) {
        this._paintDebugOverlay(ctx, this, 0);
      }
      const highlight = this._highlight;
      if (highlight && !highlight.destroyed) {
        const r = highlight.abs?.width
          ? highlight.abs
          : { x: 0, y: 0, width, height };
        ctx.fillStyle = 'rgba(41, 128, 185, 0.35)';
        ctx.fillRect(r.x, r.y, r.width, r.height);
      }
      if (this._traceUpdates) {
        ctx.lineWidth = 2;
        for (const r of this._traceUpdates) {
          ctx.strokeStyle = r.color;
          ctx.beginPath();
          // inset by the stroke so an outline on a rect flush with the
          // window edge is not half-clipped away
          ctx.rect(r.x + 1, r.y + 1, r.width - 2, r.height - 2);
          ctx.stroke();
        }
      }
      if (debugPaint) {
        // Stroke the pass's rect in this frame's colour ("repaint rainbow"):
        // a region repainting every frame strobes, one that repaints once
        // leaves a single outline behind. Inset a pixel so the stroke
        // survives the clip on all four sides.
        const r = damage ?? { x: 0, y: 0, width, height };
        ctx.strokeStyle =
          FLASH_COLORS[(this._flashTick ?? 0) % FLASH_COLORS.length];
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.rect(r.x + 1, r.y + 1, r.width - 2, r.height - 2);
        ctx.stroke();
      }
    } finally {
      this._paintDamage = null;
      this._coverChain = null;
      if (damage) ctx.restore();
    }
  }

  /**
   * The window's own background, painted under the whole tree.
   *
   * An opaque window falls back to white, because "no background" is not
   * something X can show. A transparent one has no fallback and needs none:
   * the clear in `_paintRegion` already left it empty, and empty is the
   * point — a `<popup transparent>` with no `backgroundColor` is a floating
   * tree with nothing behind it.
   *
   * `borderRadius` only means anything here, and only on a transparent
   * window. This fill is the bottom-most thing in the window, so rounding it
   * rounds the window itself, and the corners it gives up are the corners
   * the compositor then shows the desktop through — antialiased, without the
   * Shape extension's hard 1-bit edge.
   */
  _paintWindowBackground(ctx, damage, width, height) {
    const { backgroundColor, borderRadius = 0 } = this.style;
    if (DEV && this.style.boxShadow) devWarnWindowShadow(this.kind);
    // A `backgroundImage` works wherever a `backgroundColor` does, which is
    // the rule worth having — over the whole window, in window coordinates,
    // and still filling only the damage rect: the gradient is a source
    // picture in device space, so a slice of it is the slice that belongs
    // there.
    const gradient = this._backgroundGradient(ctx, {
      x: 0,
      y: 0,
      width,
      height,
    });
    const fill = (style, rounded) => {
      ctx.fillStyle = style;
      if (rounded) {
        // The path is the whole window however small the damage rect is —
        // the clip bounds it — so repainting one corner still draws that
        // corner's curve rather than a square patch of background.
        ctx.beginPath();
        ctx.roundRect(0, 0, width, height, borderRadius);
        ctx.fill();
      } else if (damage) {
        ctx.fillRect(damage.x, damage.y, damage.width, damage.height);
      } else {
        ctx.fillRect(0, 0, width, height);
      }
    };
    if (this.transparencyEffective) {
      if (!isPaintedColor(backgroundColor) && !gradient) return;
      const rounded = borderRadius > 0 && typeof ctx.roundRect === 'function';
      if (isPaintedColor(backgroundColor)) fill(backgroundColor, rounded);
      if (gradient) fill(gradient, rounded);
      return;
    }
    // An ARGB window that nothing is compositing has an alpha channel it
    // must not use. It gets filled edge to edge and square — `borderRadius`
    // is ignored, because giving up the corners here would expose the
    // black those pixels really are. A translucent colour is flattened
    // over white rather than composited onto the last frame, which on a
    // window with alpha would otherwise creep towards opaque a frame at a
    // time and never settle anywhere predictable.
    if (this._transparent) fill('white', false);
    // No `backgroundColor` means the desktop's, not white: a window whose
    // widgets went dark on a dark desktop must not leave a white rectangle
    // behind them. An app that named a colour gets the colour it named.
    //
    // repainting the background only where it is about to be drawn over is
    // the other half of the win: a full-window fill is a full-window
    // composite however little changed
    fill(backgroundColor || this.theme.background, false);
    if (gradient) fill(gradient, false);
  }
}
