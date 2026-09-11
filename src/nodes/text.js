// <text> and its chunks: shaped, wrapped and elided text, the line bands a
// selection paints, and the glyph strip.

import { localTextStyleChanged, TEXT_REMEASURE } from '../styles.js';
import { cssColorStraight } from 'ntk';
import { hooks as a11yHooks } from '../a11y.js';
import { codePointAtOffset, codeUnitOffsets } from '../textrange.js';
import { NO_DAMAGE } from './damage.js';
import { Node } from './node.js';

/**
 * Yoga's measure modes, in words. Indexed by the integer yoga hands a
 * measure function, so `MEASURE_MODES[widthMode]` is the name.
 *
 * The names are the public vocabulary (`measureContent`) and the integers
 * are not: an element that wrote `widthMode === 0` would be pinned to
 * yoga's ABI through us, which is exactly what the seam exists to stop.
 */
/**
 * Text smaller than this many logical pixels is painted as a strip in its
 * ink instead of as glyphs (`TextNode._paintsStrip`). Six is under the
 * smallest size any UI sets on purpose and over what a zoomed-out view
 * shrinks its labels to; `createRoot({ textStripBelow })` is the seam.
 */
export const TEXT_STRIP_BELOW = 6;
// The band a strip covers, in ems around the baseline — the x-height and a
// little of the ascenders above it, the descenders below — and the share of
// the ink it is painted at, which is roughly how much of that band small
// text actually inks.
const STRIP_ABOVE_BASELINE = 0.6;
const STRIP_BELOW_BASELINE = 0.1;
const STRIP_COVERAGE = 0.45;

const textStripBelow = new WeakMap();

/** The size under which this connection's text is painted as strips. */
export function setTextStripBelow(app, below) {
  if (below === undefined) return;
  if (typeof below !== 'number' || !(below >= 0)) {
    throw new Error(
      `react-x11: createRoot({ textStripBelow: ${JSON.stringify(below)} }) ` +
        '— a size in logical pixels, or 0 to paint glyphs at every size.',
    );
  }
  textStripBelow.set(app, below);
}

// `REACT_X11_TEXT_STRIP_BELOW` is the same line for a process that cannot
// reach `createRoot` — a bench comparing the strip against glyphs, an app
// run under a harness — read once
const textStripBelowEnv = Number(process.env.REACT_X11_TEXT_STRIP_BELOW);

const textStripBelowFor = (app) =>
  textStripBelow.get(app) ??
  (Number.isFinite(textStripBelowEnv) && textStripBelowEnv >= 0
    ? textStripBelowEnv
    : TEXT_STRIP_BELOW);

/**
 * Downward shift that recreates CSS "half-leading". ntk's TextLayout puts
 * the first baseline at exactly `ascent` and packs each line's leading
 * (font line gap + any lineHeight surplus) entirely *below* the glyphs, so
 * a layout drawn at the top of its measured box rides visually high —
 * most noticeable centered in buttons/inputs (fonts like Helvetica carry a
 * 0.5em line gap). CSS instead splits that leading evenly above and below
 * the ink (see seek-oss capsize for the metrics background).
 */
function halfLeading(layout) {
  const last = layout.lines?.[layout.lines.length - 1];
  if (!last) return 0;
  return Math.max(0, (layout.height - (last.baseline + last.descent)) / 2);
}

/** A selected line with nothing on it still shows, so a blank line inside a
 * selection does not read as the highlight having stopped. */
const EMPTY_LINE_BAND = 4;

/**
 * The rectangles a highlight over `[start, end)` code points fills, in the
 * layout's own coordinates — one per line, and one per **direction run**
 * inside a line.
 *
 * The per-run walk is the whole reason this is not four lines of caret
 * arithmetic. A selection is contiguous in *logical* order and a line is
 * laid out in *visual* order, so in "the file مرحبا here" a range that
 * crosses into the Arabic covers two disjoint stretches of pixels, and a
 * single rect from one caret x to the other paints over text nobody
 * selected. Each run is intersected with the range in code units — the space
 * ntk reports run extents in — and only a boundary falling *inside* a run
 * costs a `caretPosition`; a fully covered run is its own two edges, which
 * with the merge below is what keeps a plain paragraph at one rect per line.
 *
 * It belongs in ntk's `TextLayout`, beside the private offset table it
 * rebuilds here. It is here because the selection needs it now.
 */
export function rangeBands(layout, text, start, end) {
  const lines = layout.lines;
  if (!lines?.length || end <= start) return [];
  const offsets = codeUnitOffsets(text);
  const last = offsets.length - 1;
  const from = offsets[Math.max(0, Math.min(start, last))];
  const to = offsets[Math.max(0, Math.min(end, last))];
  if (to <= from) return [];
  const bands = [];
  for (const line of lines) {
    if (line.end <= from || line.start >= to) continue;
    const spans = [];
    for (const positioned of line.runs) {
      const a = Math.max(from, positioned.start);
      const b = Math.min(to, positioned.end);
      if (b <= a) continue;
      const rtl = positioned.run?.direction === 'rtl';
      const near = line.x + positioned.x;
      const far = near + positioned.width;
      // a boundary at the run's own logical edge is that edge — which side
      // of the pixels it is on is what the run's direction decides
      const edgeAt = (cu, logicalStart) => {
        if (logicalStart ? cu <= positioned.start : cu >= positioned.end) {
          return rtl === logicalStart ? far : near;
        }
        return layout.caretPosition(codePointAtOffset(offsets, cu)).x;
      };
      const x1 = edgeAt(a, true);
      const x2 = edgeAt(b, false);
      spans.push([Math.min(x1, x2), Math.max(x1, x2)]);
    }
    if (!spans.length) {
      bands.push({
        x: line.x,
        y: line.y,
        width: EMPTY_LINE_BAND,
        height: line.height,
      });
      continue;
    }
    // Runs also split at every style span, so an ordinary line with a bold
    // word in it is three rectangles that touch. Merging keeps the common
    // case at one per line.
    spans.sort((p, q) => p[0] - q[0]);
    let [left, right] = spans[0];
    for (let i = 1; i <= spans.length; i++) {
      const next = spans[i];
      if (next && next[0] <= right + 0.5) {
        right = Math.max(right, next[1]);
        continue;
      }
      if (right > left) {
        bands.push({
          x: left,
          y: line.y,
          width: right - left,
          height: line.height,
        });
      }
      if (next) [left, right] = next;
    }
  }
  return bands;
}

/** Raw string/number children of <text>. */
export class TextChunkNode extends Node {
  constructor(text, app) {
    super('textchunk', {}, app, { yoga: false });
    this.text = String(text);
  }

  setText(text) {
    this.text = String(text);
    this.parent?._textContentChanged();
    a11yHooks.textContent?.(this);
    // the chunk has no geometry of its own — the ancestor that owns a yoga
    // node is the box that rewraps, and its before/after rects are the
    // bound on what a new string can repaint
    let owner = this.parent;
    while (owner && !owner.yoga) owner = owner.parent;
    if (owner) owner._invalidateLayout('text');
    else this.root?.invalidate(true, null, 'text');
  }

  _textContentChanged() {
    this.parent?._textContentChanged();
  }
}

/**
 * <text>. The outermost <text> owns a yoga node with a measure function;
 * nested <text> elements are style spans (no yoga node) — the paragraph is
 * laid out as one run list so wrapping spans the whole content
 * (ntk TextLayout accepts [{ text, ...style overrides, color }] spans).
 */
export class TextNode extends Node {
  constructor(props, app, { span = false } = {}) {
    super('text', props, app, { yoga: !span });
    this.isSpan = span;
    this._layouts = new Map();
  }

  /** Height for a width: the paragraph shaped into whatever is on offer.
   * The offer is `Infinity` when nothing bounds it, which is also what
   * `textWrap: 'nowrap'` asks for, so neither needs a mode.
   *
   * Both answers are **whole pixels**, the trimmed one included — see
   * `_trim` for why the rounding is not cosmetic. The glyphs are placed
   * from the unrounded trim (`_placedLayout`), so what the rounding moves
   * is the bottom edge of the box, by less than half a pixel. */
  measureContent({ width }) {
    const layout = this._layoutFor(this._wrapWidth(width));
    if (!layout) return { width: 0, height: 0 };
    const trim = this._trim(layout);
    return {
      width: Math.ceil(layout.width),
      height: Math.max(
        0,
        trim
          ? Math.round(Math.ceil(layout.height) - (trim.top + trim.bottom))
          : Math.ceil(layout.height),
      ),
    };
  }

  _textContentChanged() {
    if (this.isSpan) {
      this.parent?._textContentChanged();
      return;
    }
    this._layouts.clear();
    if (this.yoga) this.yoga.markDirty();
  }

  /**
   * The cached layout is stale, but the box it reported cannot have moved.
   *
   * `textRendering` rides on the spans inside a layout, so a cached one keeps
   * answering with the old value and has to go — but it decides only how
   * glyph origins are rounded at draw time, and ntk's layout measures
   * byte-identically whichever way it is set. So the layout is dropped
   * without marking yoga dirty: the next paint calls `_layoutFor` and
   * rebuilds it, and nothing reflows on the way.
   */
  _textPaintChanged() {
    if (this.isSpan) {
      this.parent?._textPaintChanged();
      return;
    }
    this._layouts.clear();
  }

  /**
   * The base direction is an input to shaping, not just to painting: it sets
   * the level every neutral character resolves against and the edge
   * `textAlign: 'start'` means. So a paragraph whose direction moved is a
   * paragraph that has to be laid out again, at the same cost as a font
   * change.
   */
  _directionMoved() {
    this._textContentChanged();
    const owner = this._textBoxOwner();
    if (owner) owner._invalidateLayout('direction');
    else this.root?.invalidate(true, null, 'direction');
  }

  /** The node that owns the box this text flows in. A span has none of its
   * own, so its geometry — and its damage — belong to the nearest ancestor
   * with a yoga node. */
  _textBoxOwner() {
    let owner = this;
    while (owner && !owner.yoga) owner = owner.parent;
    return owner;
  }

  /**
   * The type this text is set in moved, from its own style or from an
   * ancestor's. The two costs differ by a layout pass.
   *
   * A re-measure has to *ask* for one. None of `fontSize`, `fontWeight`,
   * `fontFamily` or `fontStyle` is a yoga property, so `applyLayoutStyle`
   * sees nothing move, and none is a paint prop either, so the node
   * contributes no damage — the frame is already decided by the time the
   * layout is dropped. They are all inputs to the *measure function*, and the
   * dirty flag `_textContentChanged` sets is only read by a layout pass:
   * without asking for one the cleared layout is never rebuilt and the old
   * glyphs stay on screen with nothing reporting an error.
   */
  _textStyleMoved(cost) {
    const owner = this._textBoxOwner();
    if (cost === TEXT_REMEASURE) {
      this._textContentChanged();
      if (owner) owner._invalidateLayout('text');
      else this.root?.invalidate(true, null, 'text');
      return;
    }
    // Only the ink or the glyph rounding. Both ride on the spans inside the
    // cached layout, so it still has to go — but the box cannot have moved,
    // and `false` here is the whole point: this is the path a `:hover`
    // arrives by, once per pointer move, and a transitioned colour by, once
    // per frame.
    this._textPaintChanged();
    this.root?.invalidate(false, owner ?? NO_DAMAGE, 'text');
  }

  applyProps(newProps, oldProps) {
    const before = this.style;
    super.applyProps(newProps, oldProps);
    // The inherited half of the text style — the face, the size, the ink —
    // travels through `_retarget` and lands in `_textStyleMoved`, whichever
    // route it arrived by. What is left here is what only this node's own box
    // cares about: how its lines are aligned, how tall they are, whether they
    // wrap at all.
    if (!localTextStyleChanged(this.style, before)) return;
    this._textContentChanged();
    const owner = this._textBoxOwner();
    if (owner) owner._invalidateLayout('text');
    else this.root?.invalidate(true, null, 'text');
  }

  /**
   * The paragraph as a flat run list: one entry per chunk of text, carrying
   * the style resolved where that chunk is written.
   *
   * A nested `<text>` is a span, and it inherits from the `<text>` around it
   * by the same mechanism a `<text>` inherits from the `<box>` around it —
   * `resolvedTextStyle()` walks the parents either way, so a span needs no
   * inheritance rule of its own. It also has to *ask*, rather than be handed
   * the answer: filling the cache here is what makes `:hover` on a span work,
   * since an unresolved node is one `_retext` skips.
   */
  collectSpans(out) {
    const style = this.resolvedTextStyle();
    for (const child of this.children) {
      if (child.kind === 'textchunk') {
        out.push({
          text: child.text,
          family: style.family,
          size: style.size,
          weight: style.weight,
          style: style.style,
          variations: style.variations,
          textRendering: style.textRendering,
          color: style.color,
        });
      } else if (child.kind === 'text') {
        child.collectSpans(out);
      }
    }
    return out;
  }

  /**
   * `textOverflow: 'ellipsis'` — is this paragraph one that ends in a `…`
   * when it does not fit, rather than one that is sliced?
   *
   * Read in four places, because eliding is not only a drawing decision: it
   * changes how many lines there are, which width the paragraph is shaped
   * against, and therefore what the node reports to layout.
   */
  _elides() {
    return this.style.textOverflow === 'ellipsis';
  }

  /**
   * How many lines are kept — CSS's `-webkit-line-clamp` under the name the
   * platforms that got a clean shot at it chose. Unlimited by default.
   *
   * **`textOverflow: 'ellipsis'` on its own means one line.** ntk elides off
   * a line *count* (`truncated = lineTokens.length > maxLines`), so an
   * ellipsis with no cap can never fire: there is nothing over the cap to
   * stand for. Leaving it inert would make `textOverflow: 'ellipsis'` a
   * property that silently does nothing in the case it is most often
   * written for — a name, a path, a status line — so the cap an author
   * almost certainly meant is the default, and `maxLines` is how they say
   * two or three instead.
   *
   * A cap below one keeps one: a `<text>` that renders nothing at all is
   * conditional rendering, not a truncation setting, and it would look like
   * a missing label rather than like a number.
   */
  _maxLines() {
    const { maxLines } = this.style;
    if (Number.isFinite(maxLines)) return Math.max(1, Math.floor(maxLines));
    return this._elides() ? 1 : Infinity;
  }

  /**
   * `textWrap: 'nowrap'` — CSS's, and the reason a table cell is a table cell
   * rather than a paragraph.
   *
   * A `<text>` measures height-for-width: hand it a narrow box and it wraps
   * to fit, which is right for prose and wrong for a row of a list. A cell is
   * a fixed height, so a date that wraps to two lines is not a taller row —
   * it is a line and a half of date with the rest sliced off, top and bottom,
   * and the same is true of any name longer than its column. Measuring at
   * unbounded width makes the overflow horizontal instead, which is what
   * `overflow: 'hidden'` on the cell already knows how to deal with.
   *
   * **Unless it elides.** Then the unbounded measurement is exactly what has
   * to go: at `maxWidth: Infinity` there is one line, one line is never over
   * the cap, and nothing is ever cut — the single-line ellipsis, which is by
   * a distance the common case, could not be spelled at all. So an eliding
   * `nowrap` is shaped against the width on offer, and the two properties
   * divide up cleanly: `textWrap` says the text does not wrap, `maxLines`
   * says how much of it is kept, and the width is the box's either way.
   *
   * The visible consequence is in what the node reports back to layout. A
   * clipping `nowrap` `<text>` measures its whole string at any offer, so
   * its min-content floor is the full width and the box around it is pushed
   * out to fit (and then clips). An eliding one measures inside the offer,
   * so its floor is small and it gives way instead — which is the point: a
   * column that cannot show a file name should show `Applicati…`, not force
   * every other column narrower to avoid saying so.
   */
  _wrapWidth(maxWidth) {
    if (this.style.textWrap !== 'nowrap') return maxWidth;
    return this._elides() ? maxWidth : Infinity;
  }

  _layoutFor(maxWidth) {
    const fonts = this.app?.fonts;
    if (!fonts) return null; // mock container in tests: no text metrics
    const maxLines = this._maxLines();
    const overflow = this.style.textOverflow;
    // Both truncation options are inputs to the shaping, so both belong in
    // the key. They can only change with the style, which clears the whole
    // map on its way past — but a cache keyed on less than it depends on is
    // one refactor away from answering with the wrong paragraph, and the
    // wrong paragraph here is glyphs on screen that no error mentions.
    const key = `${maxWidth}|${maxLines}|${overflow ?? ''}`;
    let layout = this._layouts.get(key);
    if (!layout) {
      const spans = this.collectSpans([]);
      const base = this.resolvedTextStyle();
      layout = fonts.layout(spans, base, {
        maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
        align: this.style.textAlign,
        lineHeight: this.style.lineHeight,
        maxLines: Number.isFinite(maxLines) ? maxLines : undefined,
        // 'clip' is ntk's default, so an unset property and the CSS default
        // are the same request rather than two paths through the layout.
        overflow,
        // The paragraph's **base** direction, which is not the same question
        // as which script the characters are in. UAX#9 resolves a run of
        // neutrals — `"(1) 12:30"`, a filename, a lone bracket — against the
        // paragraph level, and the first-strong-character rule is only what
        // to do when nobody said. So handing the box's direction down is what
        // makes an Arabic paragraph parenthesise and punctuate correctly, and
        // it is also what `textAlign: 'start'` resolves against: ntk aligns
        // `start`/`end` to the base level, so a `<text>` with no strong
        // characters at all lands on the right side of an RTL box.
        direction: this.direction,
      });
      if (this._layouts.size > 32) this._layouts.clear();
      this._layouts.set(key, layout);
    }
    return layout;
  }

  /**
   * `textBoxTrim: 'cap-alphabetic'` — CSS's `text-box-trim: trim-both` with
   * `text-box-edge: cap alphabetic`. How much of the line box to take off
   * the top and the bottom so the box *is* the letters: from the capitals
   * down to the last baseline.
   *
   * A line box is not the text you can see. It is the font's ascent plus
   * descent plus line gap, and the space over a capital differs from the
   * space under a baseline by `(ascent - capHeight) - descent` — a property
   * of the typeface, which is why padding around an untrimmed label is only
   * ever optically even by luck. `lineHeight` cannot fix it: it scales the
   * box and the leading still splits evenly, so it moves both edges alike.
   *
   * Measured in the coordinates the layout is **drawn** in, not the ones it
   * reports: `halfLeading` shifts it, and deriving the baseline from the
   * metrics again would silently disagree the day that shift changes.
   *
   * The amounts are fractions of a pixel and stay that way — the glyphs are
   * placed from them (`_placedLayout`). What must not stay fractional is the
   * **box** they leave behind, which is why `measureContent` rounds the
   * height it reports and this does not (issue #411).
   *
   * A trimmed label measures to the cap band, and a cap height is a fraction
   * of the em — so before the rounding, a column of trimmed titles handed
   * yoga three or four flex items whose main size had a fraction in it and
   * whose content floors (#249) were that same fraction. Yoga freezes a line
   * like that item by item and divides the overflow by a total shrink factor
   * that should have cancelled to zero; a fraction that is not exact in
   * binary leaves a rounding residue there instead, and dividing by it laid
   * the section titles of `examples/configurator` out 5.6 billion pixels
   * tall. See `writeFloors`, which is the other end of it.
   */
  _trim(layout) {
    if (this.style.textBoxTrim !== 'cap-alphabetic') return null;
    const lines = layout?.lines;
    if (!lines?.length) return null;
    const base = this.resolvedTextStyle();
    const font = this.app?.fonts?.match?.(base.family, {
      weight: base.weight,
      style: base.style,
    });
    const measured = font?.metrics?.(base.size)?.capHeight;
    if (!measured) return null; // no metrics: leave the box alone
    // Whole pixels: the trimmed box's top is the baseline less this, so a
    // fractional cap height — 9.15px for a 13px face — puts the baseline
    // between two rows, and the rasteriser lands the letters a row low on
    // one backend and half-covers two rows on the other. Rounded, the
    // baseline sits on a pixel wherever the box does.
    const capHeight = Math.round(measured);
    const shift = halfLeading(layout);
    const firstBaseline = shift + lines[0].baseline;
    const lastBaseline = shift + lines[lines.length - 1].baseline;
    return {
      top: Math.max(0, firstBaseline - capHeight),
      bottom: Math.max(0, Math.ceil(layout.height) - lastBaseline),
    };
  }

  /**
   * The layout as it is on screen: the shaped paragraph, and where its box
   * sits in the window. One place, because painting and every geometry
   * question have to agree about it down to the trim — a caret answered from
   * a differently-placed layout is a caret in the wrong place, and nothing
   * about it would look like a bug in this function.
   */
  _placedLayout() {
    const content = this.contentBox();
    const layout = this._layoutFor(this._wrapWidth(content.width || Infinity));
    if (!layout) return null;
    // the box was shortened from the top, so the glyphs come up with it
    const trim = this._trim(layout);
    return {
      layout,
      x: content.x,
      y: content.y + halfLeading(layout) - (trim ? trim.top : 0),
    };
  }

  /** The paragraph as one string — what the indices below index into. A
   * nested `<text>` is a span of this one, so its characters are in here too,
   * at the position they are written at. */
  textContent() {
    return this.collectSpans([])
      .map((span) => span.text)
      .join('');
  }

  textIndexAt(x, y) {
    const placed = this._placedLayout();
    if (!placed) return 0;
    return placed.layout.indexAt(x - placed.x, y - placed.y);
  }

  textCaretRect(index) {
    const placed = this._placedLayout();
    if (!placed) return null;
    const caret = placed.layout.caretPosition(index);
    return {
      x: placed.x + caret.x,
      y: placed.y + caret.y,
      width: 0,
      height: caret.height,
    };
  }

  textRangeRects(start, end) {
    const placed = this._placedLayout();
    if (!placed) return [];
    return rangeBands(placed.layout, this.textContent(), start, end).map(
      (band) => ({
        x: placed.x + band.x,
        y: placed.y + band.y,
        width: band.width,
        height: band.height,
      }),
    );
  }

  paintContent(ctx) {
    const placed = this._placedLayout();
    if (!placed) return;
    this._paintSelection(ctx);
    if (this._paintsStrip()) {
      this._paintStrip(ctx, placed);
      return;
    }
    placed.layout.draw(ctx, placed.x, placed.y);
  }

  /**
   * Whether this paragraph is too small to read, and is painted as a strip
   * where its lines are instead of as glyphs (`_paintStrip`).
   *
   * A zoomed-out view — a minimap, a graph at a tenth of its size, a grid
   * of five thousand cells — is a screen full of labels nobody can read,
   * each of which costs a `CTLineDraw` or a glyph-run composite at exactly
   * the price of a legible one. Below a legible size a label is a smudge
   * of its ink, and a strip of that ink at the coverage of small text is
   * the same smudge for one fill. The size is in logical pixels: what is
   * legible is a physical question, and a 5px label is the same size on a
   * 2x panel as on a 1x monitor. `textStripBelow` on `createRoot` moves
   * the line, and `0` keeps glyphs at every size.
   */
  _paintsStrip() {
    const below = textStripBelowFor(this.app);
    return below > 0 && this.resolvedTextStyle().size / this.scale < below;
  }

  /**
   * One rectangle per line, over the band the letters sit in — from a
   * little above the x-height down past the baseline — in the ink at a
   * coverage that reads the way small text does: solid ink would be a bar,
   * and a paragraph is mostly white space at any size.
   */
  _paintStrip(ctx, { layout, x, y }) {
    const lines = layout.lines;
    if (!lines?.length) return;
    const style = this.resolvedTextStyle();
    const em = style.size;
    const ink = cssColorStraight(style.color);
    if (!ink) return;
    const rects = [];
    for (const line of lines) {
      if (!(line.width > 0)) continue;
      rects.push(
        x + line.x,
        y + line.baseline - em * STRIP_ABOVE_BASELINE,
        line.width,
        em * (STRIP_ABOVE_BASELINE + STRIP_BELOW_BASELINE),
      );
    }
    if (!rects.length) return;
    ctx.fillStyle = `rgba(${Math.round(ink[0] * 255)}, ${Math.round(ink[1] * 255)}, ${Math.round(ink[2] * 255)}, ${ink[3] * STRIP_COVERAGE})`;
    ctx.fillRects(rects);
  }

  /** The band under the glyphs, when a document selection reaches this
   * paragraph. Drawn from the same accessors a registered element would use,
   * so the built-in and the custom surface cannot drift apart. */
  _paintSelection(ctx) {
    const range = this._selRange;
    if (!range || range.end <= range.start) return;
    const rects = [];
    for (const r of this.textRangeRects(range.start, range.end)) {
      rects.push(r.x, r.y, r.width, r.height);
    }
    if (!rects.length) return;
    ctx.fillStyle = range.color;
    // one Render.FillRectangles for the whole highlight, however many lines
    // and however many direction changes it took (ntk >= 7.6)
    ctx.fillRects(rects);
  }
}
