// What a box paints under its content: the background (a colour or a
// gradient), the shadow, the border and the outline. decorations.js parses
// the gradient and shadow grammar; this is the renderer half.

import {
  DEFAULT_FOCUS_RING,
  resolveBorderWidths,
  resolveBorderColors,
} from '../styles.js';
import {
  blurKernel,
  gradientSpec,
  linearGradientGeometry,
  shadowExtent,
  shadowSpecs,
} from '../decorations.js';
// Namespace import for `Surface`, the same shape and the same reason as
// `paintcache.js`: a named import of something an older ntk does not export
// is a *load-time* SyntaxError, which would take the renderer down rather
// than the one feature that needs it.
import * as ntk from 'ntk';
import { isFocusable as a11yFocusable } from '../a11y.js';
import { DEV } from './util.js';

/** CSS's `transparent` keyword means "paint nothing". ntk's colour parser
 *  does not know it and throws deep inside the 2d context, taking the whole
 *  frame with it, so filter it out at the source alongside null/''. */
export function isPaintedColor(color) {
  return Boolean(color) && color !== 'transparent';
}

/**
 * `rect`, rounded, as a path — the one shape the drawn layer is made of.
 * `roundRect` needs ntk >= 3.2.0 and the square fallback is what an older
 * one gets, which is the same degradation `_paintBorder` has always made.
 */
function roundedPath(ctx, rect, radius) {
  ctx.beginPath();
  if (radius > 0 && typeof ctx.roundRect === 'function') {
    ctx.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
  } else {
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
  }
}

/** A style's shadow reach, for the callers that have a style rather than
 *  a node (`_retarget`'s before/after pair). `scale` because the value is a
 *  string the style funnel could not convert (see decorations.js). */
export function shadowExtentOf(style, scale = 1) {
  const value = style?.boxShadow;
  if (!value || value === 'none') return 0;
  return shadowExtent(shadowSpecs(value, scale));
}

// `borderRadius` on a non-uniform border warned about once (`_paintBorderSides`).
let warnedSideRadius = false;

/** Box decorations, installed onto `Node.prototype` by node.js. */
export class NodeBoxPaint {
  /**
   * The focus ring this node would draw: its own `outline*` style, falling
   * back to the theme's focus-ring tokens for anything it leaves out. Null
   * when the node is not focusable and set no outline of its own, and when
   * `outlineWidth: 0` opts out.
   *
   * Resolved here rather than folded into the style so that the default
   * costs nothing until it is asked for — which is once per focused node
   * per frame, not once per node per commit.
   */
  _outline(style = this.style) {
    const explicit = style.outlineWidth !== undefined;
    if (!explicit && !this._focusableForRing()) return null;
    const theme = this.theme;
    const width = style.outlineWidth ?? theme?.focusRingWidth;
    const resolved = width ?? DEFAULT_FOCUS_RING.width;
    if (!(resolved > 0)) return null;
    return {
      width: resolved,
      color: style.outlineColor ?? theme?.focusRing ?? DEFAULT_FOCUS_RING.color,
      offset:
        style.outlineOffset ??
        theme?.focusRingOffset ??
        DEFAULT_FOCUS_RING.offset,
    };
  }

  /**
   * How far outside `abs` this node's ink currently reaches. Zero unless
   * the outline is actually being drawn — every focusable node is a
   * candidate for the default ring, and inflating all of their damage
   * rects for a ring that is not there would widen every claim in the tree
   * and cost the scroll-blit fast path its containment test. The frame that
   * *erases* a ring is the one case where the state has already flipped
   * back, and `EventManager.focus` claims the region before it does.
   */
  _outlineExtent(style = this.style) {
    if (style.outlineWidth === undefined && !this.states[':focus-visible'])
      return 0;
    const outline = this._outline(style);
    return outline ? outline.width + Math.max(0, outline.offset) : 0;
  }

  /**
   * How far outside `abs` this node's `boxShadow` reaches — the offset, the
   * spread and the blur's tail, symmetrically (see `shadowExtent`).
   */
  _shadowExtent() {
    return shadowExtentOf(this.style, this.scale);
  }

  /** Would a keyboard focus land here? The one rule lives in a11y.js —
   * `EventManager._isFocusable` and the AT-SPI FOCUSABLE state read the
   * same function, so the ring, the keyboard and the screen reader cannot
   * disagree. */
  _focusableForRing() {
    return Boolean(a11yFocusable(this));
  }

  /**
   * The focus ring. Drawn on `:focus-visible` — keyboard focus — so a press
   * moves focus without lighting a ring the pointer user did not ask for,
   * and Tab always lights one.
   *
   * A node that sets `outlineWidth` outside a state block gets the ring
   * whenever it is styled to, focused or not; that is the escape hatch for
   * anything wanting an outline for a reason of its own.
   */
  _paintOutline(ctx) {
    const always = this.style.outlineWidth !== undefined;
    if (!always && !this.states[':focus-visible']) return;
    const outline = this._outline();
    if (!outline || !isPaintedColor(outline.color)) return;
    const { width, offset } = outline;
    // stroked centred on the path, like the border, so half the width sits
    // inside the offset gap and half outside it
    const grow = offset + width / 2;
    const radius = this.style.borderRadius ?? 0;
    ctx.strokeStyle = outline.color;
    ctx.lineWidth = width;
    ctx.beginPath();
    const x = this.abs.x - grow;
    const y = this.abs.y - grow;
    const w = this.abs.width + grow * 2;
    const h = this.abs.height + grow * 2;
    if (radius > 0 && typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, radius + grow);
    } else {
      ctx.rect(x, y, w, h);
    }
    ctx.stroke();
  }

  _roundedPath(ctx, radius) {
    roundedPath(ctx, this.abs, radius);
  }

  _paintBackground(ctx) {
    // under an element that covers this pass with opaque pixels, this fill
    // is never seen (`WindowNode._coverFor`)
    if (this.root?._coverChain?.has(this)) return;
    const { backgroundColor, borderRadius = 0 } = this.style;
    const fill = (style) => {
      ctx.fillStyle = style;
      if (borderRadius > 0) {
        this._roundedPath(ctx, borderRadius);
        ctx.fill();
      } else {
        ctx.fillRect(this.abs.x, this.abs.y, this.abs.width, this.abs.height);
      }
    };
    if (isPaintedColor(backgroundColor)) fill(backgroundColor);
    // …and the gradient over it, which is CSS's order and not a detail: a
    // translucent gradient over a solid colour is how a tint is written, and
    // a node that sets only the gradient pays one composite either way.
    const gradient = this._backgroundGradient(ctx);
    if (gradient) fill(gradient);
  }

  /**
   * The `backgroundImage` gradient for this node's current box, as the ntk
   * `CanvasGradient` a fill style takes — or null when there is none, when
   * the box has no area, or when the context cannot make one (the headless
   * mock).
   *
   * Cached on the node and keyed by the value *and the rect*, because the
   * coordinates are absolute. They have to be: a gradient created after a
   * `translate()` ignores the transform (sidorares/ntk#271), and the drawn
   * layer paints in window coordinates anyway, so there is no translation to
   * be wrong about — the cost is that a node which moves rebuilds its
   * gradient, which is one small request and a picture the GC reclaims
   * through ntk's finalizer. Headers, cards and rows are the customers here
   * and they move on layout, not on input.
   */
  _backgroundGradient(ctx, rect = this.abs) {
    const value = this.style.backgroundImage;
    if (!value || value === 'none') return null;
    if (typeof ctx.createLinearGradient !== 'function') return null;
    const spec = gradientSpec(value, this.scale);
    if (!spec) return null;
    const { x, y, width, height } = rect;
    const key = `${value}|${x},${y},${width},${height}`;
    if (this._gradient?.key === key) return this._gradient.value;
    const line = linearGradientGeometry(spec, rect);
    if (!line) return null;
    const gradient = ctx.createLinearGradient(
      line.x0,
      line.y0,
      line.x1,
      line.y1,
    );
    for (const [offset, color] of line.stops)
      gradient.addColorStop(offset, color);
    this._gradient = { key, value: gradient };
    return gradient;
  }

  /**
   * `boxShadow`. Back to front, like CSS: the first shadow in the list is
   * the nearest the viewer, so the list is walked in reverse.
   *
   * A shadow with no blur is a rounded rectangle and costs one composite. A
   * blurred one is coverage — an a8 surface holding the rectangle, blurred
   * server-side by RENDER's convolution filter and then painted *through*
   * the shadow colour, which is the same trick the glyph cache and `<canvas
   * mono>` run on. That is what keeps the colour out of the cache key, so a
   * `:hover` that only darkens the shadow reuses the surface it already
   * rendered.
   */
  _paintShadow(ctx) {
    const value = this.style.boxShadow;
    if (!value || value === 'none') return;
    const shadows = shadowSpecs(value, this.scale);
    if (!shadows?.length) return;
    const radius = this.style.borderRadius ?? 0;
    for (let i = shadows.length - 1; i >= 0; i--) {
      const shadow = shadows[i];
      // CSS's `currentColor`: this node's *resolved* ink, its own `color`
      // over what it inherits — so a shadow written without a colour follows
      // the text it sits under, including down a `:hover` that dims both
      const color = shadow.color ?? this.resolvedTextStyle().color;
      if (!isPaintedColor(color)) continue;
      const rect = {
        x: this.abs.x + shadow.dx - shadow.spread,
        y: this.abs.y + shadow.dy - shadow.spread,
        width: this.abs.width + shadow.spread * 2,
        height: this.abs.height + shadow.spread * 2,
      };
      if (!(rect.width > 0) || !(rect.height > 0)) continue;
      // the spread grows the corner with the box, the way CSS's does
      const r = Math.max(0, radius + shadow.spread);
      if (!(shadow.blur > 0)) {
        ctx.fillStyle = color;
        roundedPath(ctx, rect, r);
        ctx.fill();
        continue;
      }
      this._paintBlurredShadow(ctx, rect, r, shadow.blur, color);
    }
  }

  /**
   * One blurred shadow, through the paint cache when there is one.
   *
   * The surface is the shadow's rectangle plus `pad` on every side, and the
   * padding is load-bearing: a convolution reads outside the picture as
   * transparent, so a kernel that runs off the edge ends the shadow in a
   * straight line. `blurKernel` takes that reach from the same function
   * ntk builds the kernel with, so the two cannot drift apart.
   *
   * The blur is **baked into the pixels** by `blurCoverage` (ntk 8.6,
   * ntk#335) rather than set as a filter on the picture. That is the
   * difference between a cached shadow and a cached shadow that costs
   * nothing to draw: a picture's filter is re-applied by the server on every
   * composite, so the entry would hit, re-render nothing, and still pay its
   * whole kernel every frame — 244M multiply-accumulates for one card-sized
   * shadow, which was 1.6s per `:hover` on XQuartz. Baked, what the cache
   * holds composites as an ordinary mask however wide the blur was, and the
   * two separable passes run once per distinct geometry.
   *
   * `maxPixels` is raised well above the cache's default: a card's shadow is
   * as big as the card, an entry for one is a8 (a byte a pixel), and the
   * thing being avoided is exactly the cost the default cap bounds
   * elsewhere.
   */
  _paintBlurredShadow(ctx, rect, radius, blur, color) {
    const { sigma, pad } = blurKernel(blur);
    // integral, because the surface is pixels; the blur is far wider than
    // the rounding, so nothing about the result is visibly quantized
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    const plan = {
      key: `shadow|${width}x${height}|r${radius}|b${blur}`,
      x: Math.round(rect.x) - pad,
      y: Math.round(rect.y) - pad,
      width: width + pad * 2,
      height: height + pad * 2,
      format: 'a8',
      tint: color,
      maxPixels: 1024 * 1024,
      // Cache on the first sighting rather than the second: what the gate
      // saves elsewhere is a cheap redraw, and what it costs here is a whole
      // gaussian — the one thing this entry exists to avoid running twice.
      eager: true,
      draw: (sctx, box) => {
        // full coverage: the colour arrives at composite time
        sctx.fillStyle = '#ffffff';
        roundedPath(
          sctx,
          { x: box.x + pad, y: box.y + pad, width, height },
          radius,
        );
        sctx.fill();
      },
      after: (surface) => ntk.blurCoverage(surface, sigma),
      live: () => this._paintShadowLive(ctx, plan),
    };
    const cache = this.root?._paintCache;
    if (cache) cache.drawing(ctx, plan);
    else this._paintShadowLive(ctx, plan);
  }

  /**
   * The same drawing with no cache behind it — the paint-cache-disabled
   * build, an entry too big for the budget, and the first frame of a shadow
   * the cache has only seen once. A surface per frame is what a shadow costs
   * without a cache; it is still one composite on the wire, and the
   * alternative is not painting it. The blur is baked here too: two
   * separable passes and a plain composite still beat one composite through
   * a k x k kernel, by the ratio of 2k to k squared.
   */
  _paintShadowLive(ctx, plan) {
    if (typeof ntk.Surface !== 'function' || !this.app?.display?.Render) return;
    let surface = null;
    try {
      surface = new ntk.Surface(this.app, {
        width: plan.width,
        height: plan.height,
        format: 'a8',
      });
      surface.render((sctx) =>
        plan.draw(sctx, { x: 0, y: 0, width: plan.width, height: plan.height }),
      );
      // `after` may hand back a *different* surface — the blur is baked into
      // a second one and the sharp copy destroyed — so both the drawing and
      // the cleanup below follow what it returned.
      surface = plan.after(surface) ?? surface;
      const before = ctx.fillStyle;
      ctx.fillStyle = plan.tint;
      ctx.drawImage(surface, plan.x, plan.y);
      ctx.fillStyle = before;
    } catch {
      // A server that will not give us a pixmap: the frame is still owed
      // everything else in it, and a missing shadow is a cosmetic loss.
    } finally {
      surface?.destroy();
    }
  }

  _paintBorder(ctx) {
    const { borderRadius = 0 } = this.style;
    // Both through the node's resolved direction: a `borderStartWidth` lays
    // out on one side and has to paint on the same one.
    const w = resolveBorderWidths(this.style, this.direction);
    const colors = resolveBorderColors(this.style, this.direction);
    const uniform =
      w.top === w.right &&
      w.top === w.bottom &&
      w.top === w.left &&
      colors.top === colors.right &&
      colors.top === colors.bottom &&
      colors.top === colors.left;
    if (!uniform) {
      this._paintBorderSides(ctx, w, colors);
      return;
    }
    const borderWidth = w.top;
    if (!(borderWidth > 0) || !isPaintedColor(colors.top)) return;
    // dashed borders need ntk >= 3.2.0 (setLineDash); solid fallback below
    const dashed =
      this.style.borderStyle === 'dashed' &&
      typeof ctx.setLineDash === 'function';
    if (dashed) {
      ctx.setLineDash([borderWidth * 2 + 2, borderWidth + 2]);
    }
    ctx.strokeStyle = colors.top;
    ctx.lineWidth = borderWidth;
    // stroke centered on the box edge inset by half the border width
    const inset = borderWidth / 2;
    ctx.beginPath();
    if (borderRadius > 0 && typeof ctx.roundRect === 'function') {
      ctx.roundRect(
        this.abs.x + inset,
        this.abs.y + inset,
        this.abs.width - borderWidth,
        this.abs.height - borderWidth,
        Math.max(0, borderRadius - inset),
      );
    } else {
      ctx.rect(
        this.abs.x + inset,
        this.abs.y + inset,
        this.abs.width - borderWidth,
        this.abs.height - borderWidth,
      );
    }
    ctx.stroke();
    if (dashed) {
      ctx.setLineDash([]);
    }
  }

  /**
   * Non-uniform borders: four independent strokes, square corners. The join
   * rule is CSS-adjacent and deterministic — top and bottom span the full
   * width of the box, left and right run between them — which every square
   * case (bars, rules, accent edges) never notices, because it only has one
   * painted side to begin with.
   *
   * `borderRadius` requires uniform borders in v1: a rounded corner between
   * two sides of different width or colour has no honest square answer, so
   * the radius is ignored here and DEV says so once rather than bending the
   * strokes halfway.
   */
  _paintBorderSides(ctx, w, colors) {
    if (DEV && (this.style.borderRadius ?? 0) > 0 && !warnedSideRadius) {
      warnedSideRadius = true;
      console.warn(
        'react-x11: borderRadius needs uniform borders — same width and ' +
          'colour on all four sides. This border is painted square. Round ' +
          'the corners with a uniform border, or drop the radius.',
      );
    }
    const dashable = typeof ctx.setLineDash === 'function';
    const dashed = this.style.borderStyle === 'dashed' && dashable;
    const { x, y, width, height } = this.abs;
    const side = (sw, color, x1, y1, x2, y2) => {
      if (!(sw > 0) || !isPaintedColor(color)) return;
      if (dashed) ctx.setLineDash([sw * 2 + 2, sw + 2]);
      ctx.strokeStyle = color;
      ctx.lineWidth = sw;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };
    side(w.top, colors.top, x, y + w.top / 2, x + width, y + w.top / 2);
    side(
      w.bottom,
      colors.bottom,
      x,
      y + height - w.bottom / 2,
      x + width,
      y + height - w.bottom / 2,
    );
    side(
      w.left,
      colors.left,
      x + w.left / 2,
      y + w.top,
      x + w.left / 2,
      y + height - w.bottom,
    );
    side(
      w.right,
      colors.right,
      x + width - w.right / 2,
      y + w.top,
      x + width - w.right / 2,
      y + height - w.bottom,
    );
    if (dashed) ctx.setLineDash([]);
  }
}
