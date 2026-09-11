// <canvas>: an element that draws with a 2d context, and the putImageData
// path into it.

import { ownerName } from '../errors.js';
import { isPaintedColor } from './boxpaint.js';
import { Node } from './node.js';
import { DEV } from './util.js';

/**
 * The one call `onDraw`'s translation cannot reach (#366).
 *
 * `putImageData` ignores the context's transform and clip — the HTML canvas
 * rule, kept by ntk — so inside `onDraw`, whose whole contract is "you are at
 * the node's origin", it is the one call whose coordinates are still the
 * drawable's own. Nothing errors; the pixels simply land at the window
 * origin instead of in the node. `DrawInfo.x`/`.y` is the way to say it
 * right, and development watches for the write that says it wrong: a
 * destination outside the node's box. Once per process — one thread to pull
 * is enough, and `onDraw` runs on every repaint.
 */
let warnedPutImageData = false;
export function resetPutImageDataWarningForTests() {
  warnedPutImageData = false;
}

/** The rect `putImageData(data, x, y, …dirty)` actually writes — the spec's
 *  dirty-rect normalisation, reproduced so the watch judges the write and
 *  not the whole source image (a correct call may blit a window of a bigger
 *  atlas). Null when the write is empty. */
function putImageDataDest(data, x, y, dx = 0, dy = 0, dw, dh) {
  const width = data?.width ?? 0;
  const height = data?.height ?? 0;
  dw ??= width;
  dh ??= height;
  if (dw < 0) {
    dx += dw;
    dw = -dw;
  }
  if (dh < 0) {
    dy += dh;
    dh = -dh;
  }
  const sx = Math.max(0, dx);
  const sy = Math.max(0, dy);
  const sw = Math.min(width, dx + dw) - sx;
  const sh = Math.min(height, dy + dh) - sy;
  if (!(sw > 0) || !(sh > 0)) return null;
  return { x: x + sx, y: y + sy, width: sw, height: sh };
}

/** Escape hatch: a retained node whose content is painted by props.onDraw. */
export class CanvasNode extends Node {
  constructor(props, app) {
    super('canvas', props, app);
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    super.applyProps(newProps, oldProps);
    // onDraw is read at paint time, so a new closure means new content — but
    // it also matches /^on[A-Z]/, which is how the base class recognises an
    // event handler, so `paintChanged` skips it and this is the only place
    // that notices. Damage is bounded to this canvas: an unbounded call here
    // made every re-render of a component that draws through <canvas> repaint
    // the whole window, which is what a Checkbox's tick and a Select's chevron
    // both do.
    if (newProps.onDraw !== before.onDraw) {
      this.root?.invalidate(false, this, 'props');
    }
  }

  /**
   * The ink a `mono` drawing is painted in: the node's own `color`, then what
   * it inherits, then the palette's — exactly as `<text>` and `<svg>` resolve
   * theirs, because it is literally the same resolution. An `<Icon>` in a
   * row that dims itself dims with it, with nothing handed over at the call
   * site.
   */
  _monoColor() {
    return this.resolvedTextStyle().color;
  }

  /** Preset the ink a `mono` drawing inherits, so `onDraw` never names a
   *  colour of its own. Called inside the `save()`/`restore()` pair. */
  _presetMono(ctx, color) {
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
  }

  paintContent(ctx) {
    const onDraw = this.props.onDraw;
    if (typeof onDraw !== 'function') return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.abs.x, this.abs.y, this.abs.width, this.abs.height);
    ctx.clip();
    ctx.translate(this.abs.x, this.abs.y);
    if (this.props.mono) this._presetMono(ctx, this._monoColor());
    const unwatch = DEV ? this._watchPutImageData(ctx) : null;
    try {
      // Device pixels, the browser's own canvas contract: the backing
      // store is the panel's grid and `scale` says how many of its pixels
      // one logical pixel is worth. Deliberately NOT a ctx.scale() — ntk
      // positions glyphs through the transform but sizes them from the
      // font, so a scaled transform would move an app's fillText without
      // growing it (src/scale.js).
      onDraw(ctx, {
        width: this.abs.width,
        height: this.abs.height,
        // the translation above, said out loud: raw-pixel calls address the
        // drawable itself, so they are written at `info.x + x` (#366)
        x: this.abs.x,
        y: this.abs.y,
        scale: this.scale,
        node: this,
      });
    } finally {
      unwatch?.();
      ctx.restore();
    }
  }

  /**
   * Shadow `ctx.putImageData` for the length of one `onDraw`, and warn on a
   * write whose destination escapes the node's box — either coordinates
   * that were never offset by `info.x`/`info.y`, which is the trap the
   * watch exists for, or a drawing genuinely reaching outside bounds every
   * other call is clipped to. The box test has a pixel of slack per edge:
   * `abs` can sit on a fractional grid, and a rounded `info.x` must not
   * read as an escape. Development only, and the shadow is not installed
   * again once the warning has fired, so steady state costs nothing.
   */
  _watchPutImageData(ctx) {
    const original = ctx.putImageData;
    if (warnedPutImageData || typeof original !== 'function') return null;
    const hadOwn = Object.hasOwn(ctx, 'putImageData');
    const node = this;
    ctx.putImageData = function (data, x, y, ...dirty) {
      const dest = putImageDataDest(data, x, y, ...dirty);
      const box = node.abs;
      if (
        !warnedPutImageData &&
        dest &&
        (dest.x < box.x - 1 ||
          dest.y < box.y - 1 ||
          dest.x + dest.width > box.x + box.width + 1 ||
          dest.y + dest.height > box.y + box.height + 1)
      ) {
        warnedPutImageData = true;
        const owner = ownerName(node);
        console.warn(
          `react-x11: putImageData in <canvas onDraw>${owner ? ` (in ${owner})` : ''} ` +
            `wrote ${dest.width}x${dest.height} at ${dest.x},${dest.y} — outside the ` +
            `node, which is ${box.width}x${box.height} at ${box.x},${box.y}. ` +
            "putImageData ignores the context's transform (the HTML canvas rule), " +
            "so unlike every other call in onDraw its coordinates are the drawable's, " +
            "not the node's. Add the node's origin, which onDraw is handed: " +
            'ctx.putImageData(data, info.x + x, info.y + y). Better, draw through an ' +
            'image source — it honours the transform and the clip, and caches its ' +
            'upload server-side: ctx.drawImage(new Image({ width, height, data }), x, y), ' +
            'with Image from \'react-x11/ntk\'. See docs/elements.md, "<canvas>".',
        );
      }
      return original.call(ctx, data, x, y, ...dirty);
    };
    return () => {
      if (hadOwn) ctx.putImageData = original;
      else delete ctx.putImageData;
    };
  }

  /**
   * `<canvas cacheKey>` opts a drawing into the paint cache.
   *
   * This one has to be opt-in, and the reason is worth stating: `onDraw` is
   * an opaque closure. Nothing here can know what it reads — a prop, a ref, a
   * clock, a module variable — and its identity changes on every render
   * unless the app memoizes it, so it is not a key either. Only the author
   * knows, so the author says:
   *
   *   <canvas cacheKey={`spark:${series.id}:${w}x${h}`} onDraw={draw} />
   *
   * The rule is the protocol's rule: the key must name every input the
   * drawing reads. A `cacheKey` that leaves one out shows stale pixels, so
   * develop with `REACT_X11_PAINT_CACHE=verify`, which turns exactly that
   * mistake into a loud complaint.
   *
   * `<canvas>` needs no `paintCached` of its own beyond the mono preset: it
   * already draws origin-relative, so the cached render and the live one are
   * the same code.
   *
   * ## `mono`: coverage, and the colour out of the key
   *
   * `<canvas mono>` is a promise about the drawing — *everything I paint is
   * one colour, and it is not mine to choose*. `onDraw` then names no colour
   * at all: `fillStyle` and `strokeStyle` arrive preset from `style.color`.
   *
   * That promise is what lets the entry be an **a8 coverage** surface with
   * the colour applied at blit time, so the colour leaves the key: one
   * rendered copy of a chevron serves the resting row, the highlighted row,
   * the disabled one and both schemes. Without it each colour is a separate
   * argb32 entry, which for an icon in four states is four rasterizations
   * and four pixmaps of the same shape. `SvgView.paintKind` decides the same
   * thing by scanning the document; a closure cannot be scanned, so here the
   * author says it.
   *
   * A drawing that sets its own `fillStyle` under `mono` is a bug the digest
   * catches: colour is out of the key, so two colours of one drawing collide
   * on one entry and `REACT_X11_PAINT_CACHE=verify` complains.
   *
   * Needs **ntk ≥ 7.3.3**, and the floor is not cosmetic. Coverage
   * composites through ntk's `_drawCoverage`, which routes a clip it cannot
   * express as a rectangle through a scratch mask — and before 7.3.3 that
   * path read the surface-sized mask from the origin rather than from the
   * destination, so anything not drawn at (0, 0) was masked out entirely
   * (sidorares/ntk#243). Nested rounded clips are the common case, not an
   * exotic one: `examples/tasks.jsx` puts a checkbox tick under a rounded
   * card, a scrolled list, a rounded row and a rounded well, and five of its
   * six ticks came out blank. `package.json` carries the floor.
   */
  paintCachePlan() {
    const { cacheKey, onDraw, mono } = this.props;
    if (cacheKey == null || typeof onDraw !== 'function') return null;
    const width = Math.ceil(this.abs.width);
    const height = Math.ceil(this.abs.height);
    if (width <= 0 || height <= 0) return null;
    const tint = mono ? this._monoColor() : null;
    // Nothing to composite through: an unpainted colour would blit the
    // coverage as-is, which is not what "invisible" looks like.
    if (mono && !isPaintedColor(tint)) return null;
    return {
      key: `canvas|${width}x${height}@1|${mono ? 'mono|' : ''}${cacheKey}`,
      x: Math.round(this.abs.x),
      y: Math.round(this.abs.y),
      width,
      height,
      format: mono ? 'a8' : 'argb32',
      tint,
    };
  }

  paintCached(ctx, box, ink = '#ffffff') {
    const onDraw = this.props.onDraw;
    if (typeof onDraw !== 'function') return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.width, box.height);
    ctx.clip();
    ctx.translate(box.x, box.y);
    // Into a coverage surface only the alpha of a paint survives and the
    // tint arrives at blit time, so any opaque colour renders the same mask
    // — and the cache says white then, or the tint where it bakes colour.
    if (this.props.mono) this._presetMono(ctx, ink);
    try {
      onDraw(ctx, {
        width: box.width,
        height: box.height,
        // the drawing goes into a surface of its own here, so the node's
        // origin in it *is* the origin — and a raw-pixel write offset by
        // `info.x`/`info.y` for the live path stays correct under a cacheKey
        x: box.x,
        y: box.y,
        node: this,
      });
    } finally {
      ctx.restore();
    }
  }
}
