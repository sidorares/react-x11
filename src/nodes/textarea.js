// <textarea>: the multi-line <textinput>, scrolling vertically with a bar of
// its own.

import {
  XK_RETURN,
  XK_KP_ENTER,
  XK_HOME,
  XK_UP,
  XK_DOWN,
  XK_PAGE_UP,
  XK_PAGE_DOWN,
  XK_END,
} from '../keysyms.js';
import {
  scrollbarGeometry,
  scrollbarHit,
  paintScrollbarThumb,
} from './scrollbars.js';
import { rangeBands } from './text.js';
import { CARET_WIDTH, CARET_RESERVE, TextInputNode } from './textinput.js';

/**
 * <textarea>: multi-line editable text on the same editing core as
 * <textinput>. Word-wraps at the content width (ntk TextLayout), Enter
 * inserts a newline (Ctrl+Enter fires onSubmit), Up/Down move the caret
 * between visual lines keeping a goal column, Home/End are wrap-aware,
 * selection spans lines, and the view scrolls vertically to follow the
 * caret (wheel scrolls too). `rows` (default 3) sets the preferred height.
 */
export class TextAreaNode extends TextInputNode {
  /**
   * The bar takes the press before the caret does — otherwise grabbing the
   * thumb would drop the caret into whatever text sits behind it and start
   * a selection drag.
   */
  defaultMouseDown(ev) {
    const bar = this._scrollbar();
    // device coordinates against device bar geometry, as in Scrollable
    const nx = ev.nativeEvent?.x ?? ev.x * this.scale;
    const ny = ev.nativeEvent?.y ?? ev.y * this.scale;
    const hit = scrollbarHit(bar, nx, ny);
    if (!hit) return super.defaultMouseDown(ev);
    if (hit === 'thumb') {
      this._barGrab = ny - bar.thumbStart;
      ev.capturePointer();
      return;
    }
    const page = this.contentBox().height;
    this._scrollTo(this._scrollY + (ny < bar.thumbStart ? -page : page), bar);
  }

  defaultMouseDrag(ev) {
    if (this._barGrab == null) return super.defaultMouseDrag(ev);
    const bar = this._scrollbar();
    if (!bar || bar.travel <= 0) return;
    const ny = ev.nativeEvent?.y ?? ev.y * this.scale;
    this._scrollTo(
      ((ny - this._barGrab - bar.trackStart) / bar.travel) * bar.range,
      bar,
    );
  }

  defaultMouseUp(ev) {
    if (this._barGrab != null) {
      this._barGrab = null;
      return;
    }
    super.defaultMouseUp(ev);
  }

  _scrollTo(y, bar) {
    const next = Math.min(Math.max(0, y), bar.range);
    if (next === this._scrollY) return;
    this._scrollY = next;
    // an inner scroll moves pixels only inside the field's own clip
    this.root?.invalidate(false, this, 'scroll');
  }

  constructor(props, app) {
    super(props, app, 'textarea');
    this._scrollY = 0;
    this._goalX = null;
  }

  /** Wider than a single-line field, and `rows` lines tall — a height that
   * comes from a prop rather than from the style, which is what makes
   * `invalidateMeasure` necessary below. */
  measureContent({ width }) {
    const rows = Math.max(1, this.props.rows ?? 3);
    return {
      width: Math.min(220, width),
      height: Math.ceil(this._lineHeight() * rows),
    };
  }

  /** Multi-line: preserve newlines (normalize CRLF). */
  _normalizeInsert(text) {
    return String(text).replace(/\r\n?/g, '\n');
  }

  /** Undo moves the caret, so the Up/Down goal column no longer applies. */
  _applyHistory(value, caret, anchor) {
    this._goalX = null;
    super._applyHistory(value, caret, anchor);
  }

  /** Wrapped, styled layout of the value (or placeholder), cached per
   * (text, style, width). Used for painting and all caret geometry, so
   * caret math always agrees with what is on screen. */
  _valueLayout() {
    const fonts = this.app?.fonts;
    if (!fonts) return null;
    const text = this._displayValue();
    const isEmpty = text.length === 0;
    const shown = isEmpty ? (this.props.placeholder ?? '') : text;
    const s = this.resolvedTextStyle();
    const color = isEmpty
      ? (this.props.placeholderColor ?? this.theme.textMuted)
      : s.color;
    const direction = this.direction;
    const align = this.style.textAlign ?? 'start';
    // A wrapped field *has* a container, so — unlike `<textinput>` — the
    // alignment is ntk's to apply: every line is placed inside the box it
    // wrapped to, and `start` is resolved against the base direction, which
    // puts an RTL value against the right-hand edge.
    //
    // The container is the content box less the caret's own width, because
    // in RTL every line *starts* flush against that right edge — line 0,
    // column 0 of an empty field included — and a caret is drawn rightwards
    // from the boundary it marks, so with no reserve it lands entirely
    // outside the clip and an RTL textarea shows no caret at all. In LTR the
    // flush edge is the left one, where the caret has the whole box in front
    // of it, and only a line that fills its width exactly could reach the
    // other end — so nothing is taken off a direction that does not need it.
    const width = this.contentBox().width || undefined;
    const container =
      width === undefined || direction !== 'rtl'
        ? width
        : Math.max(0, width - CARET_RESERVE * this.scale);
    const key = `${width}|${color}|${shown}|${s.family}|${s.size}|${s.weight}|${s.style}|${direction}|${align}`;
    if (this._valueLayoutKey !== key) {
      this._valueLayoutKey = key;
      this._valueLayoutCache = fonts.layout([{ text: shown, ...s, color }], s, {
        maxWidth: container,
        align,
        direction,
      });
    }
    return this._valueLayoutCache;
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    super.applyProps(newProps, oldProps);
    if (newProps.rows !== before.rows) this.invalidateMeasure('props');
  }

  /** The wrapped value flows from the top of the content box, scrolled —
   * there is no single line to centre, so none of `_lineMetrics` applies.
   * Everything written against this (`textIndexAt`, `textCaretRect`,
   * `textRangeRects`, click-to-caret) needs no override. */
  _placedValue() {
    const layout = this._valueLayout();
    if (!layout) return null;
    const content = this.contentBox();
    return { layout, x: content.x, y: content.y - this._scrollY };
  }

  /** How far the wrapped text reaches past the viewport. The measurement a
   * `Scrollable` takes off its children, taken off the layout that is
   * actually painted — which is what makes a self-painting element a member
   * of the scroll protocol rather than a special case in it. */
  _maxScrollY() {
    const layout = this._valueLayout();
    if (!layout) return 0;
    return Math.max(0, layout.height - this.contentBox().height);
  }

  /**
   * The chain protocol's first half (issue #253). Vertical only — the text
   * wraps, so there is never anything to the right — and false when the
   * value fits, which is what lets the wheel chain outward to the pane or
   * the window behind a short field instead of dying on it.
   */
  canScroll(dx, dy) {
    return Boolean(dy) && this._maxScrollY() > 0;
  }

  /** `scrollBy(dy)`, or `scrollBy({x, y})` — the shape `Scrollable` takes,
   * so the wheel's default action calls every scroller the same way. `x` is
   * accepted and ignored: wrapped text has no horizontal extent. */
  scrollBy(by) {
    // logical, like Scrollable's — the public unit
    const dy = typeof by === 'number' ? by : (by?.y ?? 0);
    this._scrollByDevice(0, dy * this.scale);
  }

  /** Device-pixel core, the wheel's entry (see Scrollable). */
  _scrollByDevice(dx, dy) {
    if (!dy) return;
    const next = Math.min(Math.max(0, this._scrollY + dy), this._maxScrollY());
    if (next === this._scrollY) return;
    this._scrollY = next;
    // an inner scroll moves pixels only inside the field's own clip
    this.root?.invalidate(false, this, 'scroll');
  }

  /** Visual lines that fit in the viewport — one Page keypress worth. */
  _pageLines() {
    const height = this.contentBox().height;
    const line = this._lineHeight() || 1;
    return Math.max(1, Math.floor(height / line));
  }

  /** Caret index on an adjacent visual line, keeping the goal column. */
  _verticalMove(layout, delta) {
    const pos = layout.caretPosition(this._caret);
    const li = pos.line + delta;
    if (li < 0) {
      this._goalX = null;
      return 0;
    }
    if (li >= layout.lines.length) {
      this._goalX = null;
      return this._chars().length;
    }
    const x = this._goalX ?? pos.x;
    this._goalX = x;
    const line = layout.lines[li];
    return layout.indexAt(x, line.y + (line.ascent + line.descent) / 2);
  }

  _editKeyDown(ev) {
    const k = ev.keysym;
    const layout = this._valueLayout();

    if (k === XK_RETURN || k === XK_KP_ENTER) {
      if (ev.ctrlKey) {
        this._fireValueEvent('onSubmit', this.value, ev.nativeEvent);
        return true;
      }
      this._goalX = null;
      this._insert('\n');
      return true;
    }
    if ((k === XK_UP || k === XK_DOWN) && layout && this.value.length > 0) {
      const i = this._verticalMove(layout, k === XK_UP ? -1 : 1);
      this._moveCaret(i, ev.shiftKey);
      if (ev.shiftKey) this._copySelection('PRIMARY');
      return true;
    }
    if (
      (k === XK_PAGE_UP || k === XK_PAGE_DOWN) &&
      layout &&
      this.value.length > 0
    ) {
      const i = this._verticalMove(
        layout,
        this._pageLines() * (k === XK_PAGE_UP ? -1 : 1),
      );
      this._moveCaret(i, ev.shiftKey);
      if (ev.shiftKey) this._copySelection('PRIMARY');
      return true;
    }
    if ((k === XK_HOME || k === XK_END) && layout && this.value.length > 0) {
      const pos = layout.caretPosition(this._caret);
      const line = layout.lines[pos.line];
      const y = line.y + (line.ascent + line.descent) / 2;
      // indexAt clamps into the line: far left = line start; just past the
      // right edge = end of visible content (before the newline)
      const i =
        k === XK_HOME
          ? layout.indexAt(-1e6, y)
          : layout.indexAt(line.x + line.width + 0.01, y);
      this._goalX = null;
      this._moveCaret(i, ev.shiftKey);
      return true;
    }
    this._goalX = null;
    return super._editKeyDown(ev);
  }

  /** Thumb for the vertical overflow, same look as a scroll box's. */
  _paintScrollbar(ctx, layout) {
    const bar = this._scrollbar(layout);
    if (bar) paintScrollbarThumb(ctx, bar, this.props.scrollbarColor);
  }

  _scrollbar(layout = this._valueLayout()) {
    if (this.props.scrollbar === false || !layout) return null;
    const box = this.contentBox();
    return scrollbarGeometry({
      axis: 'y',
      start: box.y,
      viewport: box.height,
      content: layout.height,
      across: box.x,
      crossSize: box.width,
      scroll: this._scrollY,
      scale: this.scale,
    });
  }

  paintContent(ctx) {
    const layout = this._valueLayout();
    if (!layout) return;
    const content = this.contentBox();
    if (content.width <= 0 || content.height <= 0) return;
    const isEmpty = this._displayValue().length === 0;

    // Keep the caret line inside the viewport, and only while focused — the
    // caret starts at the end of the value, so chasing it unconditionally
    // opened a textarea already scrolled past its first lines. Unlike
    // <textinput> this does not reset the offset when focus leaves: a
    // textarea scrolls on the wheel and has a scrollbar, so where an
    // unfocused one is scrolled to is the reader's business.
    const pos = layout.caretPosition(this._displayIndex(this._caret));
    if (this._focused) {
      if (pos.y + pos.height - this._scrollY > content.height) {
        this._scrollY = pos.y + pos.height - content.height;
      }
      if (pos.y - this._scrollY < 0) {
        this._scrollY = pos.y;
      }
    }
    this._scrollY = Math.min(
      this._scrollY,
      Math.max(0, layout.height - content.height),
    );
    this._scrollY = Math.max(0, this._scrollY);

    ctx.save();
    ctx.beginPath();
    ctx.rect(content.x, content.y, content.width, content.height);
    ctx.clip();
    const originX = content.x;
    const originY = content.y - this._scrollY;

    const [a, b] = this._selection();
    if (this._showsSelection() && a !== b && !isEmpty) {
      // A **translucent** accent rather than an opaque light blue. The ink
      // on top is `style.color`, which this fill does not control, so an
      // opaque highlight has to be picked to contrast with it — and no one
      // colour does that on both a light and a dark palette. `#b3d4fc`
      // under the dark palette's near-white ink is 1.3:1, which is nothing.
      // Tinting the surface instead leaves the ink's own contrast intact.
      ctx.fillStyle = this.props.selectionColor ?? this.theme.selection;
      // The bands `textRangeRects` reports — one per line and one per
      // direction run inside a line, which is what a selection crossing into
      // an Arabic word actually covers. Two caret positions and a rectangle
      // between them, which is what this was, paints over text nobody
      // selected on a line that has runs going both ways.
      //
      // Only the lines on screen are *sent*, and all of them in one request.
      // Ctrl+A in a 5000-line value selects 5000 lines and shows twenty: the
      // clip throws the rest away *after* they have been sent, which is the
      // one cost a clip cannot save.
      const bottom = this._scrollY + content.height;
      const rects = [];
      for (const band of rangeBands(
        layout,
        this._displayValue(),
        this._displayIndex(a),
        this._displayIndex(b),
      )) {
        if (band.y > bottom) break;
        if (band.y + band.height < this._scrollY) continue;
        rects.push(originX + band.x, originY + band.y, band.width, band.height);
      }
      // one `Render.FillRectangles` for the whole highlight, where a fill per
      // line is a full-surface-masked composite per line (ntk >= 7.6)
      if (rects.length) ctx.fillRects(rects);
    }

    layout.draw(ctx, originX, originY);
    this._paintPreedit(ctx, originX, originY, this.resolvedTextStyle());

    if (this._focused && this._caretOn && a === b) {
      ctx.fillStyle = this.props.caretColor ?? this.resolvedTextStyle().color;
      ctx.fillRect(
        originX + pos.x,
        originY + pos.y,
        CARET_WIDTH * this.scale,
        pos.height,
      );
    }
    // inside the clip, so the thumb is bounded by the content box
    this._paintScrollbar(ctx, layout);
    ctx.restore();
  }
}
