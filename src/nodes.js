// Retained node tree: one lightweight JS node per host element, one yoga node
// per drawn element, painted into the owning <window>'s single 2d context on
// ntk's frame clock. Only <window> owns a real X11 window (see NEXT_STEPS.md
// §4 for the rationale).
import {
  Yoga,
  applyLayoutStyle,
  paintPropsChanged,
  textStyleFrom,
  DEFAULT_TEXT_STYLE,
  TEXT_LAYOUT_PROPS,
} from './styles.js';
import { EventManager } from './events.js';
import { runWithPriority, DiscreteEventPriority } from './priority.js';

const DRAWN_KINDS = new Set([
  'box',
  'text',
  'image',
  'canvas',
  'scrollview',
  'textinput',
  'textarea',
  'markdown',
  'html',
  'svg',
  'tex',
]);

// DevTools' measureHostInstance dereferences instance.ownerDocument
// unconditionally once getClientRects exists; a null documentElement and
// defaultView give it zero scroll offsets and no crash.
export const DEVTOOLS_FAKE_DOCUMENT = {
  documentElement: null,
  defaultView: null,
};

/** Equality for props that may be a scalar, an array or a plain object
 *  (window hints are all three shapes), so an unchanged inline object
 *  literal does not re-send the property every render. */
function shallowEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

export class Node {
  get ownerDocument() {
    return DEVTOOLS_FAKE_DOCUMENT;
  }

  constructor(kind, props, app, { yoga = true } = {}) {
    this.kind = kind;
    this.props = props;
    this.app = app;
    this.parent = null;
    this.children = [];
    this.root = null; // owning WindowNode once attached
    this.hidden = false;
    this.destroyed = false;
    // absolute rect within the owning window, filled by absolutize()
    this.abs = { x: 0, y: 0, width: 0, height: 0 };
    this.yoga = yoga ? Yoga.Node.create() : null;
    if (this.yoga) {
      applyLayoutStyle(this.yoga, props);
    }
  }

  get isWindow() {
    return this.kind === 'window';
  }

  /** Number of yoga-bearing children before `index` (window children and
   * text spans/chunks do not join the parent's yoga tree). */
  _yogaIndexAt(index) {
    let n = 0;
    for (let i = 0; i < index; i++) {
      if (this._joinsYoga(this.children[i])) n++;
    }
    return n;
  }

  _joinsYoga(child) {
    return Boolean(this.yoga && child.yoga && !child.isWindow);
  }

  appendChild(child) {
    this.insertBefore(child, null);
  }

  insertBefore(child, beforeChild) {
    if (child.isPopup) {
      // popups live anywhere in the JSX tree but are independent
      // override-redirect windows: bookkeeping only, no yoga, no paint
      const at =
        beforeChild == null
          ? this.children.length
          : this.children.indexOf(beforeChild);
      this.children.splice(at, 0, child);
      child.parent = this;
      return;
    }
    if (child.isWindow) {
      throw new Error(
        `react-x11: <window> cannot be nested inside <${this.kind}>; ` +
          'windows may only appear at the root or inside another <window>.',
      );
    }
    const index =
      beforeChild == null
        ? this.children.length
        : this.children.indexOf(beforeChild);
    this.children.splice(index, 0, child);
    child.parent = this;
    if (this._joinsYoga(child)) {
      this.yoga.insertChild(child.yoga, this._yogaIndexAt(index));
    }
    child._setRoot(this.root);
    this._textContentChanged();
    this.root?.invalidate(true);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index === -1) return;
    this.children.splice(index, 1);
    if (this._joinsYoga(child)) {
      this.yoga.removeChild(child.yoga);
    }
    child.parent = null;
    child.destroySubtree();
    if (child.yoga && !child.isWindow) {
      child.yoga.freeRecursive();
      child.yoga = null;
    }
    this._textContentChanged();
    this.root?.invalidate(true);
  }

  /** Destroy real resources (X windows) in this subtree. Yoga nodes are
   * freed by the caller via freeRecursive on the subtree top. */
  destroySubtree() {
    this.destroyed = true;
    for (const child of this.children) child.destroySubtree();
  }

  _setRoot(root) {
    if (this.root === root) return;
    this.root = root;
    for (const child of this.children) {
      if (!child.isWindow) child._setRoot(root);
    }
  }

  /** Called when descendant text content may have changed; overridden by
   * TextNode, forwarded upward by spans/chunks. */
  _textContentChanged() {}

  applyProps(newProps, oldProps) {
    const prev = this.props;
    this.props = newProps;
    let layoutChanged = false;
    if (this.yoga) {
      layoutChanged = applyLayoutStyle(this.yoga, newProps, oldProps ?? prev);
    }
    this.root?.invalidate(layoutChanged);
  }

  setHidden(hidden) {
    this.hidden = hidden;
    if (this.yoga) {
      this.yoga.setDisplay(
        hidden || this.props.display === 'none'
          ? Yoga.DISPLAY_NONE
          : Yoga.DISPLAY_FLEX,
      );
    }
    this.root?.invalidate(true);
  }

  /** Drawn, visible children in paint order (stable sort by zIndex). */
  paintOrder() {
    const drawn = this.children.filter(
      (c) => DRAWN_KINDS.has(c.kind) && c.yoga && !c.hidden,
    );
    return drawn
      .map((node, i) => ({ node, i }))
      .sort(
        (a, b) =>
          (a.node.props.zIndex ?? 0) - (b.node.props.zIndex ?? 0) || a.i - b.i,
      )
      .map((e) => e.node);
  }

  clipsChildren() {
    return this.props.overflow === 'hidden' || this.props.overflow === 'scroll';
  }

  containsPoint(x, y) {
    return (
      x >= this.abs.x &&
      y >= this.abs.y &&
      x < this.abs.x + this.abs.width &&
      y < this.abs.y + this.abs.height
    );
  }

  /** DOM-ish rect accessor. React DevTools' Highlighter requires host
   * instances to expose getClientRects() with a non-empty rect before it
   * emits showNativeHighlight — without this, hovering the tree silently
   * no-ops. Anything with getClientRects is also measured at mount via
   * `instance.ownerDocument.documentElement` (see ownerDocument below). */
  getClientRects() {
    const r = this.abs;
    if (!(r.width > 0 || r.height > 0)) return [];
    return [
      {
        x: r.x,
        y: r.y,
        left: r.x,
        top: r.y,
        width: r.width,
        height: r.height,
        right: r.x + r.width,
        bottom: r.y + r.height,
      },
    ];
  }

  /** Front-to-back hit test. Returns the deepest hit node or null. */
  hitTest(x, y) {
    if (this.hidden || this.props.pointerEvents === 'none') return null;
    const inside = this.containsPoint(x, y);
    if (!inside && this.clipsChildren()) return null;
    const order = this.paintOrder();
    for (let i = order.length - 1; i >= 0; i--) {
      const hit = order[i].hitTest(x, y);
      if (hit) return hit;
    }
    return inside ? this : null;
  }

  absolutize(originX, originY) {
    if (!this.yoga) return;
    this.abs = {
      x: originX + this.yoga.getComputedLeft(),
      y: originY + this.yoga.getComputedTop(),
      width: this.yoga.getComputedWidth(),
      height: this.yoga.getComputedHeight(),
    };
    for (const child of this.children) {
      if (!child.isWindow) child.absolutize(this.abs.x, this.abs.y);
    }
  }

  contentBox() {
    const padL =
      this.yoga.getComputedPadding(Yoga.EDGE_LEFT) +
      this.yoga.getComputedBorder(Yoga.EDGE_LEFT);
    const padT =
      this.yoga.getComputedPadding(Yoga.EDGE_TOP) +
      this.yoga.getComputedBorder(Yoga.EDGE_TOP);
    const padR =
      this.yoga.getComputedPadding(Yoga.EDGE_RIGHT) +
      this.yoga.getComputedBorder(Yoga.EDGE_RIGHT);
    const padB =
      this.yoga.getComputedPadding(Yoga.EDGE_BOTTOM) +
      this.yoga.getComputedBorder(Yoga.EDGE_BOTTOM);
    return {
      x: this.abs.x + padL,
      y: this.abs.y + padT,
      width: Math.max(0, this.abs.width - padL - padR),
      height: Math.max(0, this.abs.height - padT - padB),
    };
  }

  paint(ctx) {
    if (this.hidden) return;
    this._paintBackground(ctx);
    this._paintContent(ctx);
    this._paintChildren(ctx);
    this._paintBorder(ctx);
  }

  _roundedPath(ctx, radius) {
    ctx.beginPath();
    if (radius > 0 && typeof ctx.roundRect === 'function') {
      ctx.roundRect(
        this.abs.x,
        this.abs.y,
        this.abs.width,
        this.abs.height,
        radius,
      );
    } else {
      ctx.rect(this.abs.x, this.abs.y, this.abs.width, this.abs.height);
    }
  }

  _paintBackground(ctx) {
    const { backgroundColor, borderRadius = 0 } = this.props;
    if (!backgroundColor) return;
    ctx.fillStyle = backgroundColor;
    if (borderRadius > 0) {
      this._roundedPath(ctx, borderRadius);
      ctx.fill();
    } else {
      ctx.fillRect(this.abs.x, this.abs.y, this.abs.width, this.abs.height);
    }
  }

  _paintBorder(ctx) {
    const { borderWidth = 0, borderColor, borderRadius = 0 } = this.props;
    if (!(borderWidth > 0) || !borderColor) return;
    // dashed borders need ntk >= 3.2.0 (setLineDash); solid fallback below
    const dashed =
      this.props.borderStyle === 'dashed' &&
      typeof ctx.setLineDash === 'function';
    if (dashed) {
      ctx.setLineDash([borderWidth * 2 + 2, borderWidth + 2]);
    }
    ctx.strokeStyle = borderColor;
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

  _paintContent(ctx) {}

  _paintChildren(ctx) {
    const order = this.paintOrder();
    if (order.length === 0) return;
    const clip = this.clipsChildren();
    if (clip) {
      ctx.save();
      this._roundedPath(ctx, this.props.borderRadius ?? 0);
      ctx.clip();
    }
    for (const child of order) child.paint(ctx);
    if (clip) ctx.restore();
  }
}

export class BoxNode extends Node {
  constructor(props, app) {
    super('box', props, app);
  }
}

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

/** Raw string/number children of <text>. */
export class TextChunkNode extends Node {
  constructor(text, app) {
    super('textchunk', {}, app, { yoga: false });
    this.text = String(text);
  }

  setText(text) {
    this.text = String(text);
    this.parent?._textContentChanged();
    this.root?.invalidate(true);
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
    if (this.yoga) {
      this.yoga.setMeasureFunc((width, widthMode) => {
        const maxWidth =
          widthMode === Yoga.MEASURE_MODE_UNDEFINED ? Infinity : width;
        const layout = this._layoutFor(maxWidth);
        if (!layout) return { width: 0, height: 0 };
        return {
          width: Math.ceil(layout.width),
          height: Math.ceil(layout.height),
        };
      });
    }
  }

  _textContentChanged() {
    if (this.isSpan) {
      this.parent?._textContentChanged();
      return;
    }
    this._layouts.clear();
    if (this.yoga) this.yoga.markDirty();
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    let textChanged = newProps.color !== before.color;
    for (const key of TEXT_LAYOUT_PROPS) {
      if (newProps[key] !== before[key]) textChanged = true;
    }
    if (textChanged) this._textContentChanged();
    super.applyProps(newProps, oldProps);
  }

  collectSpans(inherited, out) {
    const style = textStyleFrom(this.props, inherited);
    for (const child of this.children) {
      if (child.kind === 'textchunk') {
        out.push({
          text: child.text,
          family: style.family,
          size: style.size,
          weight: style.weight,
          style: style.style,
          color: style.color,
        });
      } else if (child.kind === 'text') {
        child.collectSpans(style, out);
      }
    }
    return out;
  }

  _layoutFor(maxWidth) {
    const fonts = this.app?.fonts;
    if (!fonts) return null; // mock container in tests: no text metrics
    const key = String(maxWidth);
    let layout = this._layouts.get(key);
    if (!layout) {
      const spans = this.collectSpans(DEFAULT_TEXT_STYLE, []);
      const base = textStyleFrom(this.props, DEFAULT_TEXT_STYLE);
      layout = fonts.layout(spans, base, {
        maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
        align: this.props.textAlign,
        lineHeight: this.props.lineHeight,
      });
      if (this._layouts.size > 32) this._layouts.clear();
      this._layouts.set(key, layout);
    }
    return layout;
  }

  _paintContent(ctx) {
    const content = this.contentBox();
    const layout = this._layoutFor(content.width || Infinity);
    if (layout) layout.draw(ctx, content.x, content.y + halfLeading(layout));
  }
}

export class ImageNode extends Node {
  constructor(props, app) {
    super('image', props, app);
    this.image = null;
    this._loadToken = 0;
    this._configureMeasure();
    this._load(props.src);
  }

  _configureMeasure() {
    const fixed = this.props.width != null && this.props.height != null;
    if (fixed) {
      this.yoga.unsetMeasureFunc();
      return;
    }
    this.yoga.setMeasureFunc((width, widthMode) => {
      const natW = this.image?.width ?? 0;
      const natH = this.image?.height ?? 0;
      let w = natW;
      if (widthMode !== Yoga.MEASURE_MODE_UNDEFINED && width < w) w = width;
      return { width: w, height: natW > 0 ? (w * natH) / natW : natH };
    });
  }

  async _load(src) {
    if (!src) return;
    const token = ++this._loadToken;
    try {
      const { loadImage } = await import('ntk');
      const image = await loadImage(src);
      if (token !== this._loadToken || this.destroyed) return;
      this.image = image;
      if (this.yoga) {
        this.yoga.markDirty?.();
        this.root?.invalidate(true);
      }
    } catch (err) {
      console.error(`react-x11: failed to load image ${src}:`, err.message);
    }
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    super.applyProps(newProps, oldProps);
    this._configureMeasure();
    if (newProps.src !== before.src) {
      this.image = null;
      this._load(newProps.src);
    }
  }

  _paintContent(ctx) {
    if (!this.image) return;
    const content = this.contentBox();
    ctx.drawImage(
      this.image,
      content.x,
      content.y,
      content.width,
      content.height,
    );
  }
}

/**
 * <scrollview>: a clipped viewport over its (overflowing) children. The
 * scroll offset is applied during absolutize, so painting and hit testing
 * see already-shifted rects. Wheel events scroll it by default (see
 * EventManager); scrollTo/scrollBy are available on the ref.
 */
export class ScrollViewNode extends Node {
  constructor(props, app) {
    super('scrollview', props, app);
    this.scrollY = 0;
    this.contentHeight = 0;
    if (props.overflow === undefined) {
      this.yoga.setOverflow(Yoga.OVERFLOW_SCROLL);
    }
    // yoga's default flexShrink is 0, which would size the viewport to its
    // content; a scroll container must yield to the outer layout instead
    if (props.flexShrink === undefined) {
      this.yoga.setFlexShrink(1);
    }
  }

  clipsChildren() {
    return true;
  }

  absolutize(originX, originY) {
    if (!this.yoga) return;
    this.abs = {
      x: originX + this.yoga.getComputedLeft(),
      y: originY + this.yoga.getComputedTop(),
      width: this.yoga.getComputedWidth(),
      height: this.yoga.getComputedHeight(),
    };
    let bottom = 0;
    for (const child of this.children) {
      if (child.yoga && !child.isWindow) {
        bottom = Math.max(
          bottom,
          child.yoga.getComputedTop() + child.yoga.getComputedHeight(),
        );
      }
    }
    this.contentHeight =
      bottom + this.yoga.getComputedPadding(Yoga.EDGE_BOTTOM);
    this._resolveScrollIntoView();
    this.scrollY = Math.min(
      Math.max(0, this.scrollY),
      Math.max(0, this.contentHeight - this.abs.height),
    );
    for (const child of this.children) {
      if (!child.isWindow) {
        child.absolutize(this.abs.x, this.abs.y - this.scrollY);
      }
    }
  }

  scrollTo(y) {
    const max = Math.max(0, this.contentHeight - this.abs.height);
    const next = Math.min(Math.max(0, y), max);
    if (next === this.scrollY) return;
    this.scrollY = next;
    this.props.onScroll?.({
      scrollY: next,
      contentHeight: this.contentHeight,
      viewportHeight: this.abs.height,
    });
    this.root?.invalidate(true);
  }

  scrollBy(dy) {
    this.scrollTo(this.scrollY + dy);
  }

  /**
   * Scroll the minimum amount that brings a descendant fully into view.
   * The request is queued rather than applied immediately: absolute rects
   * only exist after a layout pass, so a caller reacting to a mount (a
   * list widget moving its selection, say) would otherwise measure a node
   * that has no geometry yet. `absolutize` resolves it against freshly
   * computed yoga positions.
   */
  scrollIntoView(node) {
    if (!node) return;
    this._scrollIntoViewTarget = node;
    this.root?.invalidate(true);
  }

  _resolveScrollIntoView() {
    const target = this._scrollIntoViewTarget;
    if (!target) return;
    this._scrollIntoViewTarget = null;
    if (target.destroyed || !target.yoga) return;
    // offset of the target within our content box, summed up the chain so
    // targets nested below a direct child work too
    let top = 0;
    for (let n = target; n && n !== this; n = n.parent) {
      if (!n.yoga) return; // not (or no longer) inside this scrollview
      top += n.yoga.getComputedTop();
      if (!n.parent) return;
    }
    const bottom = top + target.yoga.getComputedHeight();
    const viewport = this.abs.height;
    if (bottom > this.scrollY + viewport) this.scrollY = bottom - viewport;
    if (top < this.scrollY) this.scrollY = top;
  }

  paint(ctx) {
    super.paint(ctx);
    this._paintScrollbar(ctx);
  }

  _paintScrollbar(ctx) {
    if (this.props.scrollbar === false) return;
    const viewport = this.abs.height;
    if (!(this.contentHeight > viewport)) return;
    const trackWidth = 6;
    const thumbHeight = Math.max(
      20,
      (viewport * viewport) / this.contentHeight,
    );
    const range = this.contentHeight - viewport;
    const thumbY =
      this.abs.y + (this.scrollY / range) * (viewport - thumbHeight);
    const thumbX = this.abs.x + this.abs.width - trackWidth - 2;
    ctx.fillStyle = this.props.scrollbarColor || 'rgba(0, 0, 0, 0.25)';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(thumbX, thumbY, trackWidth, thumbHeight, 3);
    } else {
      ctx.rect(thumbX, thumbY, trackWidth, thumbHeight);
    }
    ctx.fill();
  }
}

/** Escape hatch: a retained node whose content is painted by props.onDraw. */
export class CanvasNode extends Node {
  constructor(props, app) {
    super('canvas', props, app);
  }

  applyProps(newProps, oldProps) {
    super.applyProps(newProps, oldProps);
    // onDraw is read at paint time; a new closure means new content
    this.root?.invalidate(false);
  }

  _paintContent(ctx) {
    const onDraw = this.props.onDraw;
    if (typeof onDraw !== 'function') return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.abs.x, this.abs.y, this.abs.width, this.abs.height);
    ctx.clip();
    ctx.translate(this.abs.x, this.abs.y);
    try {
      onDraw(ctx, {
        width: this.abs.width,
        height: this.abs.height,
        node: this,
      });
    } finally {
      ctx.restore();
    }
  }
}

const XK_BACKSPACE = 0xff08;
const XK_RETURN = 0xff0d;
const XK_KP_ENTER = 0xff8d;
const XK_HOME = 0xff50;
const XK_LEFT = 0xff51;
const XK_UP = 0xff52;
const XK_RIGHT = 0xff53;
const XK_DOWN = 0xff54;
const XK_END = 0xff57;
const XK_DELETE = 0xffff;

/**
 * <textinput>: single-line editable text. Caret/selection via ntk TextLayout
 * prefix measurement, editing via the EventManager default-action hooks
 * (user onKeyDown/onMouseDown handlers run first and can preventDefault).
 * Clipboard: Ctrl+C/X/V on CLIPBOARD, X11-style middle-click paste and
 * select-to-own on PRIMARY (needs ntk >= 3.2.0 app.clipboard; degrades
 * gracefully without it). Controlled (`value` + `onChange`) or uncontrolled
 * (`defaultValue`). Caret indices are in code points, not UTF-16 units.
 */
export class TextInputNode extends Node {
  constructor(props, app, kind = 'textinput') {
    super(kind, props, app);
    this.focusableByDefault = true;
    this.defaultCursor = 'text';
    this._value =
      props.defaultValue != null ? String(props.defaultValue) : null;
    this._caret = this._chars().length;
    this._anchor = this._caret;
    this._scrollX = 0;
    this._focused = false;
    this._caretOn = false;
    this._blinkTimer = null;
    this._dragging = false;
    this.yoga.setMeasureFunc((width, widthMode) => {
      const preferred = 150;
      const w =
        widthMode === Yoga.MEASURE_MODE_UNDEFINED
          ? preferred
          : Math.min(preferred, width);
      return { width: w, height: Math.ceil(this._lineHeight()) };
    });
  }

  get value() {
    if (this.props.value != null) return String(this.props.value);
    return this._value ?? '';
  }

  _chars() {
    return Array.from(this.value);
  }

  _textStyle() {
    return textStyleFrom(this.props, DEFAULT_TEXT_STYLE);
  }

  _layoutOf(text) {
    const fonts = this.app?.fonts;
    if (!fonts) return null;
    const style = this._textStyle();
    return fonts.layout(text, style);
  }

  _lineHeight() {
    const layout = this._layoutOf('Mg');
    if (layout) return layout.height;
    return (this.props.fontSize ?? DEFAULT_TEXT_STYLE.size) * 1.4;
  }

  /** Shaped layout of the current value, cached per (value, style).
   * Caret math rides ntk >= 3.3.0's TextLayout caret API, which is exact
   * across kerning/shaping boundaries, bidi runs and trailing whitespace
   * (replaces the prefix-width measurement this used before). */
  _valueLayout() {
    const fonts = this.app?.fonts;
    if (!fonts) return null;
    const text = this.value;
    const s = this._textStyle();
    const key = `${text}|${s.family}|${s.size}|${s.weight}|${s.style}`;
    if (this._valueLayoutKey !== key) {
      this._valueLayoutKey = key;
      this._valueLayoutCache = fonts.layout(text, s);
    }
    return this._valueLayoutCache;
  }

  /** Visual caret x for a logical code-point index. */
  _prefixWidth(count) {
    const layout = this._valueLayout();
    if (!layout) return 0;
    return layout.caretPosition(count).x;
  }

  _selection() {
    return [
      Math.min(this._caret, this._anchor),
      Math.max(this._caret, this._anchor),
    ];
  }

  _selectedText() {
    const [a, b] = this._selection();
    return this._chars().slice(a, b).join('');
  }

  _repaint() {
    this._caretOn = true;
    this.root?.invalidate(false);
  }

  _commit(nextChars, caret) {
    const next = nextChars.join('');
    const previous = this.value;
    this._caret = caret;
    this._anchor = caret;
    if (this.props.value == null) this._value = next;
    if (next !== previous) {
      this.props.onChange?.(next);
    }
    this._repaint();
  }

  /** Single-line: newlines collapse to spaces (textarea overrides). */
  _normalizeInsert(text) {
    return String(text).replace(/[\r\n]+/g, ' ');
  }

  _insert(text) {
    const insert = Array.from(this._normalizeInsert(text));
    if (this.props.maxLength != null) {
      const room =
        this.props.maxLength -
        (this._chars().length - (this._selection()[1] - this._selection()[0]));
      if (insert.length > room) insert.length = Math.max(0, room);
    }
    const chars = this._chars();
    const [a, b] = this._selection();
    this._commit(
      [...chars.slice(0, a), ...insert, ...chars.slice(b)],
      a + insert.length,
    );
  }

  _deleteRange(from, to) {
    const chars = this._chars();
    this._commit([...chars.slice(0, from), ...chars.slice(to)], from);
  }

  _moveCaret(index, extend) {
    const len = this._chars().length;
    this._caret = Math.min(Math.max(0, index), len);
    if (!extend) this._anchor = this._caret;
    this._repaint();
  }

  _clipboardApi() {
    return this.app?.clipboard ?? null;
  }

  _copySelection(selection = 'CLIPBOARD') {
    const text = this._selectedText();
    if (!text) return;
    this._clipboardApi()
      ?.write(text, { selection })
      .catch(() => {});
  }

  _pasteFrom(selection = 'CLIPBOARD') {
    this._clipboardApi()
      ?.read({ selection })
      .then((text) => {
        if (!this.destroyed && text) this._insert(text);
      })
      .catch(() => {});
  }

  // --- default actions (run after user handlers unless preventDefault) ---

  _defaultKeyDown(ev) {
    const [a, b] = this._selection();
    const hasSelection = a !== b;
    const k = ev.keysym;

    if (k === XK_RETURN || k === XK_KP_ENTER) {
      this.props.onSubmit?.(this.value, ev);
      return;
    }
    if (k === XK_BACKSPACE) {
      if (hasSelection) this._deleteRange(a, b);
      else if (a > 0) this._deleteRange(a - 1, a);
      return;
    }
    if (k === XK_DELETE) {
      if (hasSelection) this._deleteRange(a, b);
      else this._deleteRange(a, Math.min(a + 1, this._chars().length));
      return;
    }
    if (k === XK_LEFT) {
      if (!ev.shiftKey && hasSelection) this._moveCaret(a, false);
      else this._moveCaret(this._caret - 1, ev.shiftKey);
      if (ev.shiftKey) this._copySelection('PRIMARY');
      return;
    }
    if (k === XK_RIGHT) {
      if (!ev.shiftKey && hasSelection) this._moveCaret(b, false);
      else this._moveCaret(this._caret + 1, ev.shiftKey);
      if (ev.shiftKey) this._copySelection('PRIMARY');
      return;
    }
    if (k === XK_HOME) {
      this._moveCaret(0, ev.shiftKey);
      return;
    }
    if (k === XK_END) {
      this._moveCaret(this._chars().length, ev.shiftKey);
      return;
    }
    if (ev.ctrlKey) {
      if (ev.codepoint === 0x61 /* a */) {
        this._anchor = 0;
        this._caret = this._chars().length;
        this._repaint();
      } else if (ev.codepoint === 0x63 /* c */) {
        this._copySelection();
      } else if (ev.codepoint === 0x78 /* x */) {
        this._copySelection();
        if (hasSelection) this._deleteRange(a, b);
      } else if (ev.codepoint === 0x76 /* v */) {
        this._pasteFrom();
      }
      return;
    }
    if (ev.codepoint != null && ev.codepoint >= 0x20 && ev.codepoint !== 0x7f) {
      this._insert(String.fromCodePoint(ev.codepoint));
    }
  }

  /** Click-to-caret: logical code-point index for a window x coordinate. */
  _indexAtX(x) {
    const layout = this._valueLayout();
    if (!layout) return this._chars().length;
    const content = this.contentBox();
    return layout.indexAt(x - content.x + this._scrollX, 0);
  }

  /** Click-to-caret for a mouse event (textarea also uses ev.y). */
  _indexAtPoint(ev) {
    return this._indexAtX(ev.x);
  }

  /** Word range around a code-point index (whitespace-delimited). */
  _wordRangeAt(index) {
    const chars = this._chars();
    if (chars.length === 0) return [0, 0];
    let i = Math.min(index, chars.length - 1);
    const isSpace = (c) => /\s/.test(c);
    if (isSpace(chars[i]) && i > 0) i--;
    let a = i;
    let b = i;
    while (a > 0 && !isSpace(chars[a - 1])) a--;
    while (b < chars.length && !isSpace(chars[b])) b++;
    return [a, b];
  }

  _defaultMouseDown(ev) {
    if (ev.button === 2) {
      // X11 middle-click: paste the PRIMARY selection at the click position
      const i = this._indexAtPoint(ev);
      this._caret = i;
      this._anchor = i;
      this._pasteFrom('PRIMARY');
      return;
    }
    const i = this._indexAtPoint(ev);
    if (ev.detail >= 3) {
      this._anchor = 0;
      this._caret = this._chars().length;
      this._ownSelection();
      return;
    }
    if (ev.detail === 2) {
      const [a, b] = this._wordRangeAt(i);
      this._anchor = a;
      this._caret = b;
      this._ownSelection();
      return;
    }
    this._caret = i;
    this._anchor = i;
    this._dragging = true;
    this._repaint();
  }

  _ownSelection() {
    this._repaint();
    if (this._caret !== this._anchor) this._copySelection('PRIMARY');
  }

  _defaultMouseDrag(ev) {
    if (!this._dragging) return;
    this._caret = this._indexAtPoint(ev);
    this._repaint();
  }

  _defaultMouseUp() {
    if (!this._dragging) return;
    this._dragging = false;
    if (this._caret !== this._anchor) this._copySelection('PRIMARY');
  }

  _defaultFocus() {
    this._focused = true;
    this._caretOn = true;
    this._blinkTimer = setInterval(() => {
      this._caretOn = !this._caretOn;
      this.root?.invalidate(false);
    }, 530);
    this._blinkTimer.unref?.();
    this.root?.invalidate(false);
  }

  _defaultBlur() {
    this._focused = false;
    this._caretOn = false;
    clearInterval(this._blinkTimer);
    this._blinkTimer = null;
    this.root?.invalidate(false);
  }

  destroySubtree() {
    clearInterval(this._blinkTimer);
    this._blinkTimer = null;
    super.destroySubtree();
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    super.applyProps(newProps, oldProps);
    const len = Array.from(
      newProps.value != null ? String(newProps.value) : (this._value ?? ''),
    ).length;
    this._caret = Math.min(this._caret, len);
    this._anchor = Math.min(this._anchor, len);
    let metricsChanged = false;
    for (const key of TEXT_LAYOUT_PROPS) {
      if (newProps[key] !== before[key]) metricsChanged = true;
    }
    if (metricsChanged) {
      this.yoga.markDirty();
      this.root?.invalidate(true);
    } else if (newProps.value !== before.value) {
      this.root?.invalidate(false);
    }
  }

  _paintContent(ctx) {
    const fonts = this.app?.fonts;
    if (!fonts) return;
    const content = this.contentBox();
    if (content.width <= 0 || content.height <= 0) return;

    const style = this._textStyle();
    const text = this.value;
    const isEmpty = text.length === 0;
    const shown = isEmpty ? (this.props.placeholder ?? '') : text;
    const color = isEmpty
      ? (this.props.placeholderColor ?? '#9aa0a6')
      : style.color;
    const layout = fonts.layout([{ text: shown, ...style, color }], style);
    // Center the glyph ink (ascent + descent) rather than layout.height:
    // the layout box carries the line's leading entirely below the glyphs,
    // which would push the text visually upward (see halfLeading above).
    const line = layout.lines?.[0];
    const inkHeight = line ? line.ascent + line.descent : layout.height;
    const textY = content.y + Math.max(0, (content.height - inkHeight) / 2);
    // selection/caret read better with breathing room around the glyphs
    // (a DOM input highlights the whole line box, not just the ink)
    const markPad = Math.min(3, Math.max(0, textY - content.y));
    const markY = textY - markPad;
    const markHeight = inkHeight + markPad * 2;

    // keep the caret inside the viewport
    const caretX = this._prefixWidth(this._caret);
    const textWidth = isEmpty ? 0 : layout.width;
    if (caretX - this._scrollX > content.width - 2) {
      this._scrollX = caretX - content.width + 2;
    }
    if (caretX - this._scrollX < 0) {
      this._scrollX = caretX;
    }
    this._scrollX = Math.min(
      this._scrollX,
      Math.max(0, textWidth - content.width + 2),
    );

    ctx.save();
    ctx.beginPath();
    ctx.rect(content.x, content.y, content.width, content.height);
    ctx.clip();
    const originX = content.x - this._scrollX;

    const [a, b] = this._selection();
    if (this._focused && a !== b && !isEmpty) {
      const selStart = this._prefixWidth(a);
      const selEnd = this._prefixWidth(b);
      ctx.fillStyle = this.props.selectionColor ?? '#b3d4fc';
      ctx.fillRect(originX + selStart, markY, selEnd - selStart, markHeight);
    }

    layout.draw(ctx, originX, textY);

    if (this._focused && this._caretOn && a === b) {
      ctx.fillStyle = this.props.caretColor ?? style.color;
      ctx.fillRect(originX + caretX, markY, 1.5, markHeight);
    }
    ctx.restore();
  }
}

/**
 * <textarea>: multi-line editable text on the same editing core as
 * <textinput>. Word-wraps at the content width (ntk TextLayout), Enter
 * inserts a newline (Ctrl+Enter fires onSubmit), Up/Down move the caret
 * between visual lines keeping a goal column, Home/End are wrap-aware,
 * selection spans lines, and the view scrolls vertically to follow the
 * caret (wheel scrolls too). `rows` (default 3) sets the preferred height.
 */
export class TextAreaNode extends TextInputNode {
  constructor(props, app) {
    super(props, app, 'textarea');
    this._scrollY = 0;
    this._goalX = null;
    this.yoga.setMeasureFunc((width, widthMode) => {
      const preferred = 220;
      const w =
        widthMode === Yoga.MEASURE_MODE_UNDEFINED
          ? preferred
          : Math.min(preferred, width);
      const rows = Math.max(1, this.props.rows ?? 3);
      return { width: w, height: Math.ceil(this._lineHeight() * rows) };
    });
  }

  /** Multi-line: preserve newlines (normalize CRLF). */
  _normalizeInsert(text) {
    return String(text).replace(/\r\n?/g, '\n');
  }

  /** Wrapped, styled layout of the value (or placeholder), cached per
   * (text, style, width). Used for painting and all caret geometry, so
   * caret math always agrees with what is on screen. */
  _valueLayout() {
    const fonts = this.app?.fonts;
    if (!fonts) return null;
    const text = this.value;
    const isEmpty = text.length === 0;
    const shown = isEmpty ? (this.props.placeholder ?? '') : text;
    const s = this._textStyle();
    const color = isEmpty
      ? (this.props.placeholderColor ?? '#9aa0a6')
      : s.color;
    const width = this.contentBox().width || undefined;
    const key = `${width}|${color}|${shown}|${s.family}|${s.size}|${s.weight}|${s.style}`;
    if (this._valueLayoutKey !== key) {
      this._valueLayoutKey = key;
      this._valueLayoutCache = fonts.layout([{ text: shown, ...s, color }], s, {
        maxWidth: width,
      });
    }
    return this._valueLayoutCache;
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    super.applyProps(newProps, oldProps);
    if (newProps.rows !== before.rows) {
      this.yoga.markDirty();
      this.root?.invalidate(true);
    }
  }

  _indexAtPoint(ev) {
    const layout = this._valueLayout();
    if (!layout) return this._chars().length;
    const content = this.contentBox();
    return layout.indexAt(ev.x - content.x, ev.y - content.y + this._scrollY);
  }

  scrollBy(dy) {
    const layout = this._valueLayout();
    const content = this.contentBox();
    const max = layout ? Math.max(0, layout.height - content.height) : 0;
    const next = Math.min(Math.max(0, this._scrollY + dy), max);
    if (next === this._scrollY) return;
    this._scrollY = next;
    this.root?.invalidate(false);
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

  _defaultKeyDown(ev) {
    const k = ev.keysym;
    const layout = this._valueLayout();

    if (k === XK_RETURN || k === XK_KP_ENTER) {
      if (ev.ctrlKey) {
        this.props.onSubmit?.(this.value, ev);
        return;
      }
      this._goalX = null;
      this._insert('\n');
      return;
    }
    if ((k === XK_UP || k === XK_DOWN) && layout && this.value.length > 0) {
      const i = this._verticalMove(layout, k === XK_UP ? -1 : 1);
      this._moveCaret(i, ev.shiftKey);
      if (ev.shiftKey) this._copySelection('PRIMARY');
      return;
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
      return;
    }
    this._goalX = null;
    super._defaultKeyDown(ev);
  }

  _paintContent(ctx) {
    const layout = this._valueLayout();
    if (!layout) return;
    const content = this.contentBox();
    if (content.width <= 0 || content.height <= 0) return;
    const isEmpty = this.value.length === 0;

    // keep the caret line inside the viewport
    const pos = layout.caretPosition(this._caret);
    if (pos.y + pos.height - this._scrollY > content.height) {
      this._scrollY = pos.y + pos.height - content.height;
    }
    if (pos.y - this._scrollY < 0) {
      this._scrollY = pos.y;
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
    if (this._focused && a !== b && !isEmpty) {
      const posA = layout.caretPosition(a);
      const posB = layout.caretPosition(b);
      ctx.fillStyle = this.props.selectionColor ?? '#b3d4fc';
      for (let li = posA.line; li <= posB.line; li++) {
        const line = layout.lines[li];
        const x0 = li === posA.line ? posA.x : line.x;
        const x1 = li === posB.line ? posB.x : line.x + line.width;
        // a selected bare newline still shows as a sliver
        const w = Math.max(x1 - x0, 4);
        ctx.fillRect(
          originX + x0,
          originY + line.y,
          w,
          line.ascent + line.descent,
        );
      }
    }

    layout.draw(ctx, originX, originY);

    if (this._focused && this._caretOn && a === b) {
      ctx.fillStyle = this.props.caretColor ?? this._textStyle().color;
      ctx.fillRect(originX + pos.x, originY + pos.y, 1.5, pos.height);
    }
    ctx.restore();
  }
}

/**
 * <window>: backed by a real X11 window. Acts as the flex root and
 * paint/event root for its drawn subtree. The node is a lightweight handle
 * during the render phase — the real window is created top-down in the
 * commit phase by realize(), so every CreateWindow names its actual parent
 * from the start (no ReparentWindow, no override-redirect staging;
 * issue #4).
 */
export class WindowNode extends Node {
  constructor(app, attributes, props) {
    super('window', props, app, { yoga: true });
    this.root = this;
    this.attributes = attributes;
    this.window = null;
    this.needsLayout = true;
    this.needsPaint = true;
    this._scheduled = false;
    this.events = new EventManager(this);
  }

  /** Create the real X11 window (commit phase only). Children windows are
   * realized against this window, then mapped before it so the whole
   * subtree appears at once when the outermost window maps. */
  realize(parentWindow) {
    if (this.window || this.destroyed) return;
    const attributes = { ...this.attributes };
    if (parentWindow) {
      attributes.parent = parentWindow;
    }
    const wnd = this.app.createWindow(attributes);
    this.window = wnd;
    wnd._reactX11Node = this;
    wnd._reactFiber = this._reactFiber;
    // windows are DevTools public instances too — see Node.getClientRects
    wnd.getClientRects ??= () => [
      { x: 0, y: 0, left: 0, top: 0, width: wnd.width, height: wnd.height },
    ];
    wnd.ownerDocument ??= DEVTOOLS_FAKE_DOCUMENT;
    this._attachWindowListeners();
    for (const child of this.children) {
      if (child.isWindow && !child.isPopup) {
        child.realize(wnd);
      }
    }
    wnd.map?.();
    this.invalidate(true);
  }

  /**
   * Window-manager hints that changed since the last render (ntk >= 3.5.0).
   * Creation is handled by ntk's Window constructor — every non-event prop
   * is forwarded there as a creation attribute — so this only has to cover
   * updates.
   *
   * `sizeHints` is an object rather than flat minWidth/maxWidth props on
   * purpose: those names are yoga layout style, and a `<window>` already
   * has the confusing split where width/height are window state instead.
   */
  _applyWindowHints(next, prev) {
    const wnd = this.window;

    if (
      next.resizable !== prev.resizable ||
      !shallowEqual(next.sizeHints, prev.sizeHints)
    ) {
      wnd.setSizeHints?.({
        ...next.sizeHints,
        ...(next.resizable === false && { resizable: false }),
      });
    }
    if (!shallowEqual(next.wmClass, prev.wmClass) && next.wmClass) {
      const c = next.wmClass;
      if (Array.isArray(c)) wnd.setClass?.(c[0], c[1]);
      else if (typeof c === 'object') wnd.setClass?.(c.instance, c.class);
      else wnd.setClass?.(c);
    }
    if (!shallowEqual(next.windowType, prev.windowType) && next.windowType) {
      wnd.setWindowType?.(next.windowType);
    }
    if (Boolean(next.alwaysOnTop) !== Boolean(prev.alwaysOnTop)) {
      wnd.setAlwaysOnTop?.(Boolean(next.alwaysOnTop));
    }
  }

  // window geometry props are window state, not yoga style — never feed
  // width/height into the root yoga node (flush() sets them from the real
  // window size, which the user may have changed by resizing)
  _yogaProps(props) {
    if (props.width == null && props.height == null) return props;
    return { ...props, width: undefined, height: undefined };
  }

  _attachWindowListeners() {
    const wnd = this.window;
    if (typeof wnd.on !== 'function') return;
    wnd.on('resize', (ev) => {
      this.needsLayout = true;
      this.invalidate(true);
      this.props.onResize?.(ev);
    });
    // the frame clock emits 'draw' when the backing store content is invalid
    wnd.on('draw', () => {
      this.needsPaint = true;
      this.flush();
    });
    wnd.on('expose', (ev) => {
      this.props.onExpose?.(ev);
    });
    // WM close button: with an onCloseRequest prop the window opts into the
    // WM_DELETE_WINDOW protocol and the handler decides what happens
    // (unmount, hide, quit). Without it the WM default stands (the server
    // kills the connection). Opt-in is decided at realize time.
    if (this.props.onCloseRequest && typeof wnd.setActions === 'function') {
      wnd.setActions();
      const X = this.app.X;
      if (typeof X?.InternAtom === 'function') {
        X.InternAtom(false, 'WM_DELETE_WINDOW', (err, atom) => {
          if (!err) this._wmDeleteAtom = atom;
        });
      }
      wnd.on('message', (ev) => {
        if (this._wmDeleteAtom != null && ev.data?.[0] === this._wmDeleteAtom) {
          // a WM close is a user action: discrete priority, like clicks
          runWithPriority(DiscreteEventPriority, () => {
            this.props.onCloseRequest?.(ev);
          });
        }
      });
    }
    this.events.attach();
  }

  insertBefore(child, beforeChild) {
    if (child.isPopup) {
      Node.prototype.insertBefore.call(this, child, beforeChild);
      return;
    }
    if (child.isWindow) {
      this.children.push(child);
      child.parent = this;
      // Initial children are realized when this window realizes; a child
      // appended to an already-realized window is created immediately,
      // top-down against its real parent.
      if (this.window && !child.window) {
        child.realize(this.window);
      }
      return;
    }
    Node.prototype.insertBefore.call(this, child, beforeChild);
  }

  removeChild(child) {
    if (child.isWindow) {
      const index = this.children.indexOf(child);
      if (index !== -1) this.children.splice(index, 1);
      child.parent = null;
      child.destroySubtree();
      return;
    }
    Node.prototype.removeChild.call(this, child);
  }

  destroySubtree() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const child of this.children) child.destroySubtree();
    if (this.window && typeof this.window.destroy === 'function') {
      this.window.destroy();
    }
    this.window = null;
    if (this.yoga) {
      this.yoga.freeRecursive();
      this.yoga = null;
    }
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    this.props = newProps;
    const wnd = this.window;
    if (!wnd) {
      // not realized yet: refresh creation attributes instead
      this.attributes = { ...this.attributes, ...newProps };
      return;
    }

    if (newProps.title !== before.title) {
      wnd.setTitle?.(newProps.title || '');
    }
    this._applyWindowHints(newProps, before);
    const geometryChanged =
      newProps.width !== before.width ||
      newProps.height !== before.height ||
      newProps.x !== before.x ||
      newProps.y !== before.y;
    if (geometryChanged) {
      if (typeof wnd.setState === 'function') {
        wnd.setState({
          x: newProps.x,
          y: newProps.y,
          width: newProps.width,
          height: newProps.height,
        });
      } else {
        if (
          newProps.width !== before.width ||
          newProps.height !== before.height
        ) {
          wnd.resize?.(newProps.width, newProps.height);
        }
        if (newProps.x !== before.x || newProps.y !== before.y) {
          wnd.move?.(newProps.x, newProps.y);
        }
      }
    }

    const layoutChanged = applyLayoutStyle(
      this.yoga,
      this._yogaProps(newProps),
      this._yogaProps(before),
    );
    this.invalidate(
      layoutChanged || geometryChanged || paintPropsChanged(newProps, before),
    );
  }

  setHidden(hidden) {
    if (hidden) this.window?.unmap?.();
    else this.window?.map?.();
  }

  invalidate(layoutChanged) {
    if (this.destroyed || !this.window) return;
    if (layoutChanged) this.needsLayout = true;
    this.needsPaint = true;
    if (this._scheduled) return;
    this._scheduled = true;
    const schedule =
      typeof this.window.requestAnimationFrame === 'function'
        ? (cb) => this.window.requestAnimationFrame(cb)
        : (cb) => setImmediate(cb);
    schedule(() => {
      this._scheduled = false;
      this.flush();
    });
  }

  flush() {
    if (this.destroyed || !this.yoga || !this.window) return;
    const width = this.window.width ?? this.props.width ?? 0;
    const height = this.window.height ?? this.props.height ?? 0;
    if (this.needsLayout) {
      this.yoga.setWidth(width);
      this.yoga.setHeight(height);
      this.yoga.calculateLayout(width, height, Yoga.DIRECTION_LTR);
      this.abs = { x: 0, y: 0, width, height };
      for (const child of this.children) {
        if (!child.isWindow) child.absolutize(0, 0);
      }
      this.needsLayout = false;
      this.needsPaint = true;
    }
    if (!this.needsPaint) return;
    this.needsPaint = false;
    if (typeof this.window.getContext !== 'function') return; // headless mock
    // ntk getContext creates a fresh context (with window-event
    // subscriptions) on every call — cache one per window
    const ctx = (this._ctx ??= this.window.getContext('2d'));
    ctx.fillStyle = this.props.backgroundColor || 'white';
    ctx.fillRect(0, 0, width, height);
    this._paintChildren(ctx);
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
  }

  /** DevTools hover highlight: tint a node's rect on the next paint. */
  setHighlight(node) {
    if (this._highlight === node) return;
    this._highlight = node;
    this.invalidate(false);
  }

  /** REACT_X11_DEBUG_LAYOUT=1: outline every drawn node, color by depth. */
  _paintDebugOverlay(ctx, node, depth) {
    const colors = ['#e74c3c', '#27ae60', '#2980b9', '#8e44ad', '#f39c12'];
    for (const child of node.paintOrder()) {
      ctx.strokeStyle = colors[depth % colors.length];
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(
        child.abs.x + 0.5,
        child.abs.y + 0.5,
        child.abs.width - 1,
        child.abs.height - 1,
      );
      ctx.stroke();
      this._paintDebugOverlay(ctx, child, depth + 1);
    }
  }
}

/**
 * <popup>: an override-redirect top-level window (needs ntk >= 3.1.0, which
 * forwards the attribute — sidorares/ntk#55). The window manager ignores it:
 * no decorations, no focus stealing — menus, tooltips, dropdowns. `x`/`y`
 * are screen coordinates (anchor with ev.nativeEvent.rootx/rooty or a ref's
 * abs rect + owner window position). It may appear anywhere in the JSX tree
 * but is always its own paint/event root, realized against the screen root
 * in commitMount.
 */
export class PopupNode extends WindowNode {
  constructor(app, attributes, props) {
    // override-redirect stays: it is what keeps the window manager from
    // repositioning or decorating a menu. The EWMH type hint is additive —
    // the spec asks for it on override-redirect windows too, so compositing
    // managers can give menus and tooltips consistent shadows/animations.
    // `windowType` overrides the default (e.g. "tooltip", "popup_menu").
    super(
      app,
      {
        ...attributes,
        overrideRedirect: true,
        windowType: attributes.windowType ?? 'dropdown_menu',
      },
      props,
    );
    this.isPopup = true;
  }
}
