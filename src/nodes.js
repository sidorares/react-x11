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
  flattenStyle,
  validateStyle,
  resolveStyleStates,
  hasStateStyles,
  isStyleProp,
  EMPTY_STYLE,
  transitionFor,
  interpolate,
  ease,
  isLayoutProp,
  styleUsesTokens,
  resolveTokens,
  styleHasSizeQueries,
  resolveSizeQueries,
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

// X ConfigureWindow stack-mode: Below places the window directly under the
// named sibling (X11 protocol, ConfigureWindow).
const STACK_BELOW = 1;

// Windows whose child stacking order may have gone stale during the commit
// in progress; drained by flushWindowRestacks from resetAfterCommit.
const pendingRestack = new Set();

/** Apply any child-window stacking changes the commit produced, once. */
export function flushWindowRestacks() {
  const nodes = [...pendingRestack];
  pendingRestack.clear();
  for (const node of nodes) node._restackWindowChildren();
}

// DevTools' measureHostInstance dereferences instance.ownerDocument
// unconditionally once getClientRects exists; a null documentElement and
// defaultView give it zero scroll offsets and no crash.
export const DEVTOOLS_FAKE_DOCUMENT = {
  documentElement: null,
  defaultView: null,
};

/** CSS's `transparent` keyword means "paint nothing". ntk's colour parser
 *  does not know it and throws deep inside the 2d context, taking the whole
 *  frame with it, so filter it out at the source alongside null/''. */
function isPaintedColor(color) {
  return Boolean(color) && color !== 'transparent';
}

const DEV = process.env.NODE_ENV !== 'production';

// Frame timestamps for transitions. Indirected so tests can drive the clock
// instead of sleeping through real animations.
let now = () => Date.now();
export function setAnimationClock(fn) {
  now = fn;
}

/** Did anything the text stack measures or paints with change? */
function textStyleChanged(style, before) {
  if (style === before) return false;
  if (style.color !== before.color) return true;
  for (const key of TEXT_LAYOUT_PROPS) {
    if (style[key] !== before[key]) return true;
  }
  return false;
}

/**
 * A style property passed flat used to be silently dropped — it was neither
 * a layout prop, a paint prop nor an `on*` handler, so nothing looked at it
 * and nothing said so. Now that style has its own channel there is exactly
 * one place it can go, and the wrong place is an error that names the fix.
 */
function assertNoFlatStyleProps(props, kind, semantic) {
  if (!DEV) return;
  for (const key of Object.keys(props)) {
    if (!isStyleProp(key) || semantic.has(key)) continue;
    throw new Error(
      `react-x11: <${kind} ${key}=…> is a style property — pass it in ` +
        `style: <${kind} style={{ ${key}: … }} />`,
    );
  }
}

// Names an element owns as semantics, which therefore never mean style on
// it. `<window width>` is the X window's width; `<box width>` would be yoga
// style, and there is no element where a name means both.
const NO_SEMANTIC_NAMES = new Set();

// Everything a <window> owns: the real geometry, and the WM size hints that
// constrain it. On a <window> these are never style.
export const WINDOW_HINT_PROPS = [
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'widthInc',
  'heightInc',
  'baseWidth',
  'baseHeight',
  'minAspect',
  'maxAspect',
  'gravity',
];
const WINDOW_SEMANTIC_NAMES = new Set([
  'width',
  'height',
  ...WINDOW_HINT_PROPS,
]);

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
    // node states that style blocks can react to, owned by EventManager
    this.states = { ':hover': false, ':focus': false, ':active': false };
    // in-flight transitions: prop -> {from, to, start, duration}
    this._anim = null;
    this._syncStyle(props);
    this.yoga = yoga ? Yoga.Node.create() : null;
    if (this.yoga) {
      applyLayoutStyle(this.yoga, this.style);
    }
  }

  /**
   * Everything that paints or lays out reads `this.style`, never `this.props`
   * — props carry element semantics (`title`, `value`, geometry, handlers)
   * and style carries the CSS-like vocabulary, with no name shared between
   * them. `baseStyle` is the flattened `style` prop; `style` is that with
   * the active state blocks overlaid.
   */
  _syncStyle(props) {
    if (DEV && this.stylable) {
      assertNoFlatStyleProps(props, this.kind, this.semanticNames);
      validateStyle(flattenStyle(props.style), `<${this.kind} style>`);
    }
    this._baseStyle = this.stylable ? flattenStyle(props.style) : EMPTY_STYLE;
    this._usesTokens = this.stylable && styleUsesTokens(this._baseStyle);
    if (this._usesTokens) {
      this._baseStyle = resolveTokens(
        this._baseStyle,
        this.theme,
        `<${this.kind} style>`,
        Boolean(this.root),
      );
    }
    // `disabled` is a prop, not something the pointer does, so it is read
    // straight off props rather than driven by the event manager
    this.states[':disabled'] = Boolean(props.disabled);
    // window size queries fold into the base before state blocks, so a
    // `:hover` inside the wide layout still wins over the wide layout
    const queried = styleHasSizeQueries(this._baseStyle);
    if (queried !== this._queried) {
      this._queried = queried;
      const root = this.root;
      if (root?._sizeQueryNodes) {
        if (queried) root._sizeQueryNodes.add(this);
        else root._sizeQueryNodes.delete(this);
      }
    }
    if (queried) {
      this._baseStyle = resolveSizeQueries(
        this._baseStyle,
        this.root?.querySize ?? null,
      );
    }
    this._stateful = hasStateStyles(this._baseStyle);
    return this._retarget(
      this._stateful
        ? resolveStyleStates(this._baseStyle, this.states)
        : this._baseStyle,
    );
  }

  /**
   * Point the node at a new resolved style. Properties with a `transition`
   * animate there from whatever is on screen right now — which is what makes
   * an interrupted transition reverse from where it got to, rather than
   * jumping to the end first. Everything else takes effect immediately.
   */
  _retarget(target) {
    const displayed = this.style;
    this._targetStyle = target;
    if (displayed === undefined || this.destroyed) {
      this.style = target;
      return this.style;
    }
    for (const prop of Object.keys(target)) {
      const to = target[prop];
      const from = displayed[prop];
      if (from === to || from === undefined) continue;
      const duration = transitionFor(target, prop);
      if (duration <= 0) continue;
      if (interpolate(from, to, 0.5) === null) continue; // no midpoint: snap
      (this._anim ??= new Map()).set(prop, {
        from,
        to,
        duration,
        start: this.root?.frameTime ?? 0,
      });
      this.root?._startAnimating(this);
    }
    this.style = this._anim?.size
      ? { ...target, ...this._animatedValues() }
      : target;
    return this.style;
  }

  _animatedValues() {
    const values = {};
    for (const [prop, a] of this._anim) values[prop] = a.value ?? a.from;
    return values;
  }

  /**
   * Advance every in-flight transition to `now`. Returns true while any is
   * still running, so the window keeps asking for frames.
   */
  _tickAnimations(now) {
    if (!this._anim?.size) return false;
    let layoutChanged = false;
    const before = this.style;
    for (const [prop, a] of this._anim) {
      const t = a.duration > 0 ? Math.min(1, (now - a.start) / a.duration) : 1;
      a.value = t >= 1 ? a.to : (interpolate(a.from, a.to, ease(t)) ?? a.to);
      if (t >= 1) this._anim.delete(prop);
      if (isLayoutProp(prop)) layoutChanged = true;
    }
    this.style = this._anim.size
      ? { ...this._targetStyle, ...this._animatedValues() }
      : this._targetStyle;
    if (layoutChanged && this.yoga) {
      applyLayoutStyle(this.yoga, this.style, before);
      // a transition on a layout property costs a layout pass per frame —
      // the author asked for that by transitioning one (docs/styling.md)
      if (this.root) this.root.needsLayout = true;
    }
    return this._anim.size > 0;
  }

  /**
   * A node state changed (hover, focus, press). Only nodes that actually
   * declare a block for it do anything, and what they do is a repaint —
   * no React render, no reflow, since state blocks cannot touch layout.
   */
  setStyleState(name, on) {
    if (this.states[name] === on) return;
    this.states[name] = on;
    if (!this._stateful || this.destroyed) return;
    const next = resolveStyleStates(this._baseStyle, this.states);
    if (shallowEqual(next, this._targetStyle)) return;
    this._retarget(next);
    this.root?.invalidate(false);
  }

  get isWindow() {
    return this.kind === 'window';
  }

  /** Join the owning window's size-query registry, and take the current
   * size into account — a node mounted after a resize has to match against
   * the size the window is now, not the one it started at. */
  _registerSizeQueries() {
    if (this._queried && this.root?._sizeQueryNodes) {
      this.root._sizeQueryNodes.add(this);
      if (this.root.querySize) this._sizeQueriesChanged();
    }
    for (const child of this.children) {
      if (!child.isWindow) child._registerSizeQueries();
    }
  }

  /** Style names this element claims as its own semantics (see WindowNode). */
  get semanticNames() {
    return NO_SEMANTIC_NAMES;
  }

  /**
   * The theme in force here: the nearest `theme` prop at or above this node,
   * with an inner one merged over the outer so a panel can restate a colour
   * or two without repeating a palette. Popups resolve through their place
   * in the *tree*, not their window, so a menu inherits the theme of the UI
   * that opened it even though it is a separate X window.
   */
  get theme() {
    if (this._theme !== undefined) return this._theme;
    const inherited = this.parent?.theme;
    const own = this.props.theme;
    this._theme = own
      ? inherited
        ? { ...inherited, ...own }
        : own
      : (inherited ?? null);
    return this._theme;
  }

  /** The owning window resized: re-resolve, since a query block may now
   * match that did not, or the other way round. */
  _sizeQueriesChanged() {
    if (!this._queried || this.destroyed) return;
    const before = this.style;
    this._syncStyle(this.props);
    if (textStyleChanged(this.style, before)) this._textContentChanged();
    if (this.yoga && this.style !== before) {
      applyLayoutStyle(this.yoga, this.style, before);
    }
  }

  /** The theme above or on this node changed: drop the caches and restyle
   * the subtree, since a token can appear at any depth. */
  _themeChanged() {
    this._theme = undefined;
    if (this._usesTokens) {
      const before = this.style;
      this._syncStyle(this.props);
      // a token change reaches the node without React re-rendering it, so
      // the invalidation TextNode.applyProps would have done has to happen
      // here too — otherwise the cached layout keeps painting the old colour
      if (textStyleChanged(this.style, before)) this._textContentChanged();
      this.root?.invalidate(true);
    }
    for (const child of this.children) child._themeChanged();
  }

  /**
   * Whether this element is styled at all. The 3D scene elements and the
   * declarative SVG children are not: they carry their own vocabularies —
   * `position`, `color`, `width` mean a transform, a material and a radius
   * there — so the style channel does not apply to them, the same way it
   * does not apply to an `<input type>` in the DOM.
   */
  get stylable() {
    return true;
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

  /** Splice `child` in front of `beforeChild` (end of the list when that is
   * null), first taking it out of its old slot: React reorders a keyed list
   * by calling insertBefore with a child that is *already* mounted here, and
   * without the removal it would appear twice. Returns the new index. */
  _spliceChild(child, beforeChild) {
    const from = this.children.indexOf(child);
    if (from !== -1) this.children.splice(from, 1);
    const before =
      beforeChild == null ? -1 : this.children.indexOf(beforeChild);
    const index = before === -1 ? this.children.length : before;
    this.children.splice(index, 0, child);
    return index;
  }

  insertBefore(child, beforeChild) {
    if (child.isPopup) {
      // popups live anywhere in the JSX tree but are independent
      // override-redirect windows: bookkeeping only, no yoga, no paint —
      // but they do inherit the theme of where they are written
      this._spliceChild(child, beforeChild);
      child.parent = this;
      if (this.theme || child.props.theme) child._themeChanged();
      return;
    }
    if (child.isWindow) {
      throw new Error(
        `react-x11: <window> cannot be nested inside <${this.kind}>; ` +
          'windows may only appear at the root or inside another <window>.',
      );
    }
    // a move has to leave the yoga tree too — yoga aborts on insertChild of
    // a node that still has a parent
    if (this.children.includes(child) && this._joinsYoga(child)) {
      this.yoga.removeChild(child.yoga);
    }
    const index = this._spliceChild(child, beforeChild);
    child.parent = this;
    if (this._joinsYoga(child)) {
      this.yoga.insertChild(child.yoga, this._yogaIndexAt(index));
    }
    child._setRoot(this.root);
    child._registerSizeQueries();
    // it can see its ancestors now, so any token in its style can resolve.
    // With no theme anywhere there is nothing to resolve and nothing to walk
    if (this.theme || child.props.theme) child._themeChanged();
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
    const prevStyle = this.style;
    const themeChanged = newProps.theme !== prev.theme;
    this.props = newProps;
    if (themeChanged) this._themeChanged();
    const style = this._syncStyle(newProps);
    let layoutChanged = false;
    // hoisted styles hit the identity check and skip the whole update
    if (this.yoga && style !== prevStyle) {
      layoutChanged = applyLayoutStyle(this.yoga, style, prevStyle);
    }
    if (Boolean(newProps.trapFocus) !== Boolean((oldProps ?? prev).trapFocus)) {
      this._syncFocusScope();
    }
    this.root?.invalidate(layoutChanged);
  }

  setHidden(hidden) {
    this.hidden = hidden;
    if (this.yoga) {
      this.yoga.setDisplay(
        hidden || this.style.display === 'none'
          ? Yoga.DISPLAY_NONE
          : Yoga.DISPLAY_FLEX,
      );
    }
    this.root?.invalidate(true);
  }

  /**
   * Focus this node, as clicking it would: the owning window's focus moves
   * here, `onBlur` fires on whatever had it, `onFocus` here. Also pulls the
   * X input focus to the window if the window manager gave it away.
   */
  focus() {
    this._focusManager()?.focus(this);
    return this;
  }

  /** Give up focus, leaving the window with nothing focused. */
  blur() {
    const events = this._focusManager();
    if (events?.focused === this) events.focus(null);
    return this;
  }

  /** Whether this node has the owning window's focus. */
  get focused() {
    return this._focusManager()?.focused === this;
  }

  /** Whether focus is on this node or inside it — CSS `:focus-within`. A
   * `<popup>` counts as inside the node it hangs off in the JSX tree, which
   * is what a modal needs to know before taking focus itself. */
  get focusWithin() {
    const focused = this._focusManager()?.focused;
    return Boolean(focused) && this.contains(focused);
  }

  /** Whether `node` is this node or a descendant of it (DOM `contains`). */
  contains(node) {
    for (let n = node; n; n = n.parent) {
      if (n === this) return true;
    }
    return false;
  }

  /** Where focus for this node lives: its own window's EventManager, or —
   * inside a `<popup>`, which never receives the X input focus — the owner
   * window's (see EventManager.focusManager). */
  _focusManager() {
    return this.root?.events?.focusManager ?? null;
  }

  /** Register or drop this node's focus scope to match the `trapFocus` prop.
   * Idempotent: called at mount (commitMount) and on every prop update. */
  _syncFocusScope() {
    const events = this._focusManager();
    if (!events) return;
    if (this.props.trapFocus) events.pushScope(this);
    else events.popScope(this);
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
          (a.node.style.zIndex ?? 0) - (b.node.style.zIndex ?? 0) || a.i - b.i,
      )
      .map((e) => e.node);
  }

  clipsChildren() {
    return this.style.overflow === 'hidden' || this.style.overflow === 'scroll';
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
    if (this.hidden || this.style.pointerEvents === 'none') return null;
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
    const { backgroundColor, borderRadius = 0 } = this.style;
    if (!isPaintedColor(backgroundColor)) return;
    ctx.fillStyle = backgroundColor;
    if (borderRadius > 0) {
      this._roundedPath(ctx, borderRadius);
      ctx.fill();
    } else {
      ctx.fillRect(this.abs.x, this.abs.y, this.abs.width, this.abs.height);
    }
  }

  _paintBorder(ctx) {
    const { borderWidth = 0, borderColor, borderRadius = 0 } = this.style;
    if (!(borderWidth > 0) || !isPaintedColor(borderColor)) return;
    // dashed borders need ntk >= 3.2.0 (setLineDash); solid fallback below
    const dashed =
      this.style.borderStyle === 'dashed' &&
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
      this._roundedPath(ctx, this.style.borderRadius ?? 0);
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
    const before = this.style;
    super.applyProps(newProps, oldProps);
    if (textStyleChanged(this.style, before)) this._textContentChanged();
  }

  collectSpans(inherited, out) {
    const style = textStyleFrom(this.style, inherited);
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
      const base = textStyleFrom(this.style, DEFAULT_TEXT_STYLE);
      layout = fonts.layout(spans, base, {
        maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
        align: this.style.textAlign,
        lineHeight: this.style.lineHeight,
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
    this.yoga.setMeasureFunc((width, widthMode, height, heightMode) => {
      const natW = this.image?.width ?? 0;
      const natH = this.image?.height ?? 0;
      // a height alone should scale the width with it, the way an <img>
      // with only a height set does — not stretch to the container
      if (
        this.props.width == null &&
        this.props.height != null &&
        heightMode !== Yoga.MEASURE_MODE_UNDEFINED &&
        natH > 0
      ) {
        return { width: (height * natW) / natH, height };
      }
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

const SCROLLBAR_WIDTH = 6;
const SCROLLBAR_MIN_THUMB = 20;
// the visible bar is thin; the pointer target is not
const SCROLLBAR_SLOP = 4;

const clampScroll = (v, max) => Math.min(Math.max(0, v), max);

/**
 * Geometry of a scrollbar on either axis, or null when there is nothing to
 * scroll along it. Shared by `<scrollview>` and `<textarea>` so what is
 * painted and what the pointer hits cannot drift apart — and written once
 * for both axes so the two cannot drift from each other either.
 *
 * `viewport`/`content`/`scroll` are along the axis; `across`/`crossSize`
 * place the bar on the other one. `shorten` keeps the two bars out of each
 * other's corner when both are showing.
 */
function scrollbarGeometry({
  axis = 'y',
  start,
  viewport,
  content,
  across: crossStart0,
  crossSize,
  scroll,
  inset = 0,
  shorten = 0,
}) {
  const length = viewport - shorten;
  if (length <= 0 || !(content > viewport)) return null;
  const thumbLength = Math.max(
    SCROLLBAR_MIN_THUMB,
    (length * length) / content,
  );
  const range = content - viewport;
  const travel = Math.max(0, length - thumbLength);
  const thumbStart = start + (range > 0 ? (scroll / range) * travel : 0);
  const crossStart = crossStart0 + crossSize - SCROLLBAR_WIDTH - inset;
  return {
    axis,
    trackStart: start,
    trackLength: length,
    thumbStart,
    thumbLength,
    crossStart,
    range,
    travel,
    // the thumb as a rect, for painting
    x: axis === 'x' ? thumbStart : crossStart,
    y: axis === 'x' ? crossStart : thumbStart,
    width: axis === 'x' ? thumbLength : SCROLLBAR_WIDTH,
    height: axis === 'x' ? SCROLLBAR_WIDTH : thumbLength,
  };
}

/** The coordinate along a bar's own axis, and across it. */
const along = (bar, x, y) => (bar.axis === 'x' ? x : y);
const across = (bar, x, y) => (bar.axis === 'x' ? y : x);

/** Is this point on the bar (with slop), and if so, on the thumb? */
function scrollbarHit(bar, x, y) {
  if (!bar) return null;
  const c = across(bar, x, y);
  if (
    c < bar.crossStart - SCROLLBAR_SLOP ||
    c > bar.crossStart + SCROLLBAR_WIDTH + SCROLLBAR_SLOP
  ) {
    return null;
  }
  const a = along(bar, x, y);
  if (a < bar.trackStart || a > bar.trackStart + bar.trackLength) return null;
  return a >= bar.thumbStart && a <= bar.thumbStart + bar.thumbLength
    ? 'thumb'
    : 'track';
}

function paintScrollbarThumb(ctx, bar, color) {
  ctx.fillStyle = color || 'rgba(0, 0, 0, 0.25)';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(bar.x, bar.y, bar.width, bar.height, 3);
  } else {
    ctx.rect(bar.x, bar.y, bar.width, bar.height);
  }
  ctx.fill();
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
    this.scrollX = 0;
    this.contentHeight = 0;
    this.contentWidth = 0;
    // these defaults fill in for style the author did not set, so they read
    // the resolved style, not the props
    const style = this.style;
    if (style.overflow === undefined) {
      this.yoga.setOverflow(Yoga.OVERFLOW_SCROLL);
    }
    // yoga's default flexShrink is 0, which would size the viewport to its
    // content; a scroll container must yield to the outer layout instead
    if (style.flexShrink === undefined) {
      this.yoga.setFlexShrink(1);
    }
    // …and flexShrink alone is not enough. A flex item's base size is its
    // content, and yoga (unlike CSS) does not shrink items by default — so
    // a window whose scrollview holds more rows than fit grew *past* the
    // window, pushing the footer out of view, however small the window got.
    // `flex-basis: 0` is what CSS's `flex: 1` means, and for a scroll
    // container it is always what is wanted: take the space that is left,
    // and let the content overflow into a scroll. It also fixes the whole
    // ancestor chain at once, since the content no longer counts towards
    // any of their heights.
    const sized = style.height !== undefined || style.width !== undefined;
    if (style.flexBasis === undefined && !sized && (style.flexGrow ?? 0) > 0) {
      this.yoga.setFlexBasis(0);
    }
    // the CSS `min-height: 0` idiom, for the layouts flex-basis cannot save
    if (style.minHeight === undefined) this.yoga.setMinHeight(0);
    if (style.minWidth === undefined) this.yoga.setMinWidth(0);
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
    const { right, bottom } = this._measureContent();
    this.contentHeight =
      bottom + this.yoga.getComputedPadding(Yoga.EDGE_BOTTOM);
    this.contentWidth = right + this.yoga.getComputedPadding(Yoga.EDGE_RIGHT);
    this._resolveScrollIntoView();
    this.scrollY = Math.min(Math.max(0, this.scrollY), this._maxScroll('y'));
    this.scrollX = Math.min(Math.max(0, this.scrollX), this._maxScroll('x'));
    for (const child of this.children) {
      if (!child.isWindow) {
        child.absolutize(this.abs.x - this.scrollX, this.abs.y - this.scrollY);
      }
    }
  }

  /**
   * How far the content actually reaches, measured through the subtree
   * rather than off the direct children. A row that stretches to the
   * viewport while its own cells overflow it — a table, in other words —
   * reports the viewport width at the top level and says nothing about the
   * cells, so a shallow measurement would find nothing to scroll. This is
   * what `scrollWidth`/`scrollHeight` mean in a browser.
   *
   * Anything that clips its own children ends the walk: their overflow is
   * that node's business, not ours.
   */
  _measureContent() {
    let right = 0;
    let bottom = 0;
    const walk = (node, dx, dy) => {
      for (const child of node.children) {
        if (child.isWindow || !child.yoga || child.hidden) continue;
        const x = dx + child.yoga.getComputedLeft();
        const y = dy + child.yoga.getComputedTop();
        right = Math.max(right, x + child.yoga.getComputedWidth());
        bottom = Math.max(bottom, y + child.yoga.getComputedHeight());
        if (!child.clipsChildren()) walk(child, x, y);
      }
    };
    walk(this, 0, 0);
    return { right, bottom };
  }

  _maxScroll(axis) {
    return axis === 'x'
      ? Math.max(0, this.contentWidth - this.abs.width)
      : Math.max(0, this.contentHeight - this.abs.height);
  }

  /**
   * `scrollTo(y)` scrolls vertically, as it always has; `scrollTo({x, y})`
   * moves either axis, leaving out whichever is omitted.
   */
  scrollTo(to) {
    const want = typeof to === 'number' ? { y: to } : { x: to?.x, y: to?.y };
    const next = {
      x:
        want.x == null
          ? this.scrollX
          : clampScroll(want.x, this._maxScroll('x')),
      y:
        want.y == null
          ? this.scrollY
          : clampScroll(want.y, this._maxScroll('y')),
    };
    if (next.x === this.scrollX && next.y === this.scrollY) return;
    this.scrollX = next.x;
    this.scrollY = next.y;
    this.props.onScroll?.({
      scrollX: next.x,
      scrollY: next.y,
      contentWidth: this.contentWidth,
      contentHeight: this.contentHeight,
      viewportWidth: this.abs.width,
      viewportHeight: this.abs.height,
    });
    this.root?.invalidate(true);
  }

  /** `scrollBy(dy)`, or `scrollBy({x, y})` for either axis. */
  scrollBy(by) {
    if (typeof by === 'number') return this.scrollTo(this.scrollY + by);
    this.scrollTo({
      x: by?.x == null ? undefined : this.scrollX + by.x,
      y: by?.y == null ? undefined : this.scrollY + by.y,
    });
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
    let left = 0;
    for (let n = target; n && n !== this; n = n.parent) {
      if (!n.yoga) return; // not (or no longer) inside this scrollview
      top += n.yoga.getComputedTop();
      left += n.yoga.getComputedLeft();
      if (!n.parent) return;
    }
    const bottom = top + target.yoga.getComputedHeight();
    const rightEdge = left + target.yoga.getComputedWidth();
    if (bottom > this.scrollY + this.abs.height) {
      this.scrollY = bottom - this.abs.height;
    }
    if (top < this.scrollY) this.scrollY = top;
    if (rightEdge > this.scrollX + this.abs.width) {
      this.scrollX = rightEdge - this.abs.width;
    }
    if (left < this.scrollX) this.scrollX = left;
  }

  paint(ctx) {
    super.paint(ctx);
    for (const bar of this._scrollbars()) {
      paintScrollbarThumb(ctx, bar, this.props.scrollbarColor);
    }
  }

  /** null when the bar is switched off or there is nothing to scroll on
   * that axis. */
  _scrollbar(axis = 'y') {
    if (this.props.scrollbar === false) return null;
    const horizontal = axis === 'x';
    // when both bars show, each stops short of the other's corner
    const other = horizontal
      ? this.contentHeight > this.abs.height
      : this.contentWidth > this.abs.width;
    return scrollbarGeometry({
      axis,
      start: horizontal ? this.abs.x : this.abs.y,
      viewport: horizontal ? this.abs.width : this.abs.height,
      content: horizontal ? this.contentWidth : this.contentHeight,
      across: horizontal ? this.abs.y : this.abs.x,
      crossSize: horizontal ? this.abs.height : this.abs.width,
      scroll: horizontal ? this.scrollX : this.scrollY,
      inset: 2,
      shorten: other ? SCROLLBAR_WIDTH + 2 : 0,
    });
  }

  _scrollbars() {
    return [this._scrollbar('y'), this._scrollbar('x')].filter(Boolean);
  }

  /**
   * The bar belongs to the scroller, not to the content under it — the same
   * rule a browser applies. Without this a press on the thumb would be
   * delivered to whatever child happens to be painted beneath it.
   */
  hitTest(x, y) {
    for (const bar of this._scrollbars()) {
      if (scrollbarHit(bar, x, y)) return this;
    }
    return super.hitTest(x, y);
  }

  _defaultMouseDown(ev) {
    for (const bar of this._scrollbars()) {
      const hit = scrollbarHit(bar, ev.x, ev.y);
      if (!hit) continue;
      const at = along(bar, ev.x, ev.y);
      if (hit === 'thumb') {
        // remember where in the thumb it was grabbed, so it does not jump
        this._barGrab = { axis: bar.axis, offset: at - bar.thumbStart };
        ev.capturePointer();
        return;
      }
      // a press on the track pages towards it, like PageUp/PageDown
      const page = bar.axis === 'x' ? this.abs.width : this.abs.height;
      const delta = at < bar.thumbStart ? -page : page;
      this.scrollBy(bar.axis === 'x' ? { x: delta } : { y: delta });
      return;
    }
  }

  _defaultMouseDrag(ev) {
    if (this._barGrab == null) return;
    const bar = this._scrollbar(this._barGrab.axis);
    if (!bar || bar.travel <= 0) return;
    const at = along(bar, ev.x, ev.y) - this._barGrab.offset - bar.trackStart;
    const to = (at / bar.travel) * bar.range;
    this.scrollTo(bar.axis === 'x' ? { x: to } : { y: to });
  }

  _defaultMouseUp() {
    this._barGrab = null;
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
const XK_PAGE_UP = 0xff55;
const XK_PAGE_DOWN = 0xff56;
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
    return textStyleFrom(this.style, DEFAULT_TEXT_STYLE);
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
    return (this.style.fontSize ?? DEFAULT_TEXT_STYLE.size) * 1.4;
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
      else if (ev.ctrlKey) this._deleteRange(this._wordBoundary(a, -1), a);
      else if (a > 0) this._deleteRange(a - 1, a);
      return;
    }
    if (k === XK_DELETE) {
      if (hasSelection) this._deleteRange(a, b);
      else if (ev.ctrlKey) this._deleteRange(a, this._wordBoundary(a, 1));
      else this._deleteRange(a, Math.min(a + 1, this._chars().length));
      return;
    }
    if (k === XK_LEFT) {
      if (ev.ctrlKey) {
        this._moveCaret(this._wordBoundary(this._caret, -1), ev.shiftKey);
      } else if (!ev.shiftKey && hasSelection) {
        this._moveCaret(a, false);
      } else {
        this._moveCaret(this._caret - 1, ev.shiftKey);
      }
      if (ev.shiftKey) this._copySelection('PRIMARY');
      return;
    }
    if (k === XK_RIGHT) {
      if (ev.ctrlKey) {
        this._moveCaret(this._wordBoundary(this._caret, 1), ev.shiftKey);
      } else if (!ev.shiftKey && hasSelection) {
        this._moveCaret(b, false);
      } else {
        this._moveCaret(this._caret + 1, ev.shiftKey);
      }
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

  /**
   * Caret index one word away, the way Ctrl+arrow moves in a text editor:
   * skip any run of non-word characters, then the word itself. Word
   * characters are letters, digits and underscore, so "foo-bar" is two
   * words and "foo_bar" is one.
   */
  _wordBoundary(from, dir) {
    const chars = this._chars();
    const isWord = (c) => /[\p{L}\p{N}_]/u.test(c);
    let i = Math.max(0, Math.min(from, chars.length));
    if (dir > 0) {
      while (i < chars.length && !isWord(chars[i])) i++;
      while (i < chars.length && isWord(chars[i])) i++;
    } else {
      while (i > 0 && !isWord(chars[i - 1])) i--;
      while (i > 0 && isWord(chars[i - 1])) i--;
    }
    return i;
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
    // shift+click extends from the existing anchor rather than starting a
    // fresh selection, and keeps dragging from there
    if (ev.shiftKey) {
      this._caret = i;
      this._dragging = true;
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
    const beforeStyle = this.style;
    super.applyProps(newProps, oldProps);
    const len = Array.from(
      newProps.value != null ? String(newProps.value) : (this._value ?? ''),
    ).length;
    this._caret = Math.min(this._caret, len);
    this._anchor = Math.min(this._anchor, len);
    let metricsChanged = false;
    for (const key of TEXT_LAYOUT_PROPS) {
      if (this.style[key] !== beforeStyle[key]) metricsChanged = true;
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
  /**
   * The bar takes the press before the caret does — otherwise grabbing the
   * thumb would drop the caret into whatever text sits behind it and start
   * a selection drag.
   */
  _defaultMouseDown(ev) {
    const bar = this._scrollbar();
    const hit = scrollbarHit(bar, ev.x, ev.y);
    if (!hit) return super._defaultMouseDown(ev);
    if (hit === 'thumb') {
      this._barGrab = ev.y - bar.thumbStart;
      ev.capturePointer();
      return;
    }
    const page = this.contentBox().height;
    this._scrollTo(this._scrollY + (ev.y < bar.thumbStart ? -page : page), bar);
  }

  _defaultMouseDrag(ev) {
    if (this._barGrab == null) return super._defaultMouseDrag(ev);
    const bar = this._scrollbar();
    if (!bar || bar.travel <= 0) return;
    this._scrollTo(
      ((ev.y - this._barGrab - bar.trackStart) / bar.travel) * bar.range,
      bar,
    );
  }

  _defaultMouseUp(ev) {
    if (this._barGrab != null) {
      this._barGrab = null;
      return;
    }
    super._defaultMouseUp(ev);
  }

  _scrollTo(y, bar) {
    const next = Math.min(Math.max(0, y), bar.range);
    if (next === this._scrollY) return;
    this._scrollY = next;
    this.root?.invalidate(false);
  }

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

  /** Thumb for the vertical overflow, same look as <scrollview>'s. */
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
    });
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
    // inside the clip, so the thumb is bounded by the content box
    this._paintScrollbar(ctx, layout);
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
    // ids of the child windows in the order the *server* stacks them,
    // bottom to top — see _restackWindowChildren
    this._xStack = [];
    // nodes with a transition in flight, and the timestamp the current
    // frame is being rendered for
    this._animating = new Set();
    this.frameTime = 0;
    // nodes with `@width`/`@height` blocks, and the size they last matched
    // against
    this._sizeQueryNodes = new Set();
    this.querySize = null;
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
        if (child.window) this._xStack.push(child.window.id);
      }
    }
    this._restackWindowChildren();
    // <glarea>s mounted before the window existed own a child X window too
    this._realizeGlAreas(this);
    wnd.map?.();
    this.invalidate(true);
  }

  /** Walk the drawn subtree and give every <glarea> its child X window. */
  _realizeGlAreas(node) {
    for (const child of node.children) {
      if (child.isWindow) continue;
      if (child.isGlArea) child.realize();
      else this._realizeGlAreas(child);
    }
  }

  /**
   * Window-manager hints that changed since the last render (ntk >= 3.5.0).
   * Creation is handled by ntk's Window constructor — every non-event prop
   * is forwarded there as a creation attribute — so this only has to cover
   * updates.
   *
   * Size hints are flat props — `minWidth`, `maxHeight`, `widthInc`… — and
   * so is the geometry they constrain. They only had to hide inside a
   * `sizeHints` object while yoga style shared this namespace; with style
   * in its own channel the names are free, and `<window minWidth={360}>`
   * means the one thing it can mean.
   */
  _applyWindowHints(next, prev) {
    const wnd = this.window;

    const hints = this._sizeHints(next);
    if (
      next.resizable !== prev.resizable ||
      !shallowEqual(hints, this._sizeHints(prev))
    ) {
      wnd.setSizeHints?.({
        ...hints,
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

  /** The WM size hints among these props. */
  _sizeHints(props) {
    const hints = {};
    for (const key of WINDOW_HINT_PROPS) {
      if (props[key] !== undefined) hints[key] = props[key];
    }
    return hints;
  }

  get semanticNames() {
    return WINDOW_SEMANTIC_NAMES;
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

  /** Child <window>s in the order they should stack, bottom to top: the same
   * rule drawn children paint by (later sibling on top, `zIndex` first). */
  _windowStackOrder() {
    return this.children
      .filter((c) => c.isWindow && !c.isPopup && c.window)
      .map((node, i) => ({ node, i }))
      .sort(
        (a, b) =>
          (a.node.style.zIndex ?? 0) - (b.node.style.zIndex ?? 0) || a.i - b.i,
      )
      .map((e) => e.node);
  }

  /**
   * Make the server's stacking order match the JSX order. X stacks a new
   * window on top of its siblings, so plain mount order already comes out
   * right and this sends nothing; it costs requests only when React moves a
   * child window or a `zIndex` changes. Walking top-down and putting each
   * window directly below the one above it fixes any permutation in one
   * pass — after step i, everything from i upwards is a contiguous run in
   * the right order. Top-level windows are excluded on purpose: they are
   * the window manager's to stack, and it redirects the request anyway;
   * so are popups, which are children of the screen root wherever they sit
   * in the tree. Only `<window>` children are ordered against each other —
   * a `<glarea>`'s X window is a sibling at the server, but it belongs to
   * the drawn tree, which has no stacking relationship with them.
   */
  _restackWindowChildren() {
    const X = this.app?.X;
    if (!this.window || typeof X?.ConfigureWindow !== 'function') return;
    const stack = this._windowStackOrder();
    const ids = stack.map((c) => c.window.id);
    if (
      ids.length === this._xStack.length &&
      ids.every((id, i) => id === this._xStack[i])
    ) {
      return;
    }
    for (let i = stack.length - 2; i >= 0; i--) {
      X.ConfigureWindow(ids[i], {
        sibling: ids[i + 1],
        stackMode: STACK_BELOW,
      });
    }
    this._xStack = ids;
  }

  insertBefore(child, beforeChild) {
    if (child.isPopup) {
      Node.prototype.insertBefore.call(this, child, beforeChild);
      return;
    }
    if (child.isWindow) {
      this._spliceChild(child, beforeChild);
      child.parent = this;
      // Initial children are realized when this window realizes; a child
      // appended to an already-realized window is created immediately,
      // top-down against its real parent — and lands on top of its
      // siblings, which _restackWindowChildren then corrects if the JSX
      // order says otherwise.
      if (this.window && !child.window) {
        child.realize(this.window);
        if (child.window) this._xStack.push(child.window.id);
      }
      if (this.theme || child.props.theme) child._themeChanged();
      // React reorders a keyed list with one insertBefore per moved child;
      // restacking once at the end of the commit skips the intermediate
      // orders, which nobody ever sees.
      pendingRestack.add(this);
      return;
    }
    Node.prototype.insertBefore.call(this, child, beforeChild);
  }

  removeChild(child) {
    if (child.isWindow) {
      const index = this.children.indexOf(child);
      if (index !== -1) this.children.splice(index, 1);
      const id = child.window?.id;
      child.parent = null;
      child.destroySubtree();
      if (id != null) this._xStack = this._xStack.filter((w) => w !== id);
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
    const beforeStyle = this.style;
    const themeChanged = newProps.theme !== before.theme;
    this.props = newProps;
    if (themeChanged) this._themeChanged();
    const style = this._syncStyle(newProps);
    if (Boolean(newProps.trapFocus) !== Boolean(before.trapFocus)) {
      this._syncFocusScope();
    }
    const wnd = this.window;
    if (!wnd) {
      // not realized yet: refresh creation attributes instead
      this.attributes = { ...this.attributes, ...newProps };
      return;
    }

    if (newProps.title !== before.title) {
      wnd.setTitle?.(newProps.title || '');
    }
    // a popup is a child of the screen root, not of the node it is written
    // under, so its zIndex means nothing — and its parent here may well be
    // a drawn node with no children to stack
    if (
      (style.zIndex ?? 0) !== (beforeStyle.zIndex ?? 0) &&
      !this.isPopup &&
      this.parent?._restackWindowChildren
    ) {
      pendingRestack.add(this.parent);
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

    const layoutChanged =
      style !== beforeStyle && applyLayoutStyle(this.yoga, style, beforeStyle);
    this.invalidate(
      layoutChanged || geometryChanged || paintPropsChanged(style, beforeStyle),
    );
  }

  /**
   * Re-evaluate the size-query blocks for this window's current size, just
   * before laying out. This is the whole reason a size query may carry
   * layout properties while a state block may not: it only ever runs inside
   * a layout pass the resize already required.
   */
  _resolveSizeQueries(width, height) {
    if (this._sizeQueryNodes.size === 0) {
      this.querySize = this.querySize ?? { width, height };
      return;
    }
    if (this.querySize?.width === width && this.querySize?.height === height) {
      return;
    }
    this.querySize = { width, height };
    for (const node of [...this._sizeQueryNodes]) {
      if (node.destroyed) this._sizeQueryNodes.delete(node);
      else node._sizeQueriesChanged();
    }
  }

  /** A node in this window started a transition. */
  _startAnimating(node) {
    this._animating.add(node);
  }

  /**
   * Step every in-flight transition to `now`, then keep the frame clock
   * running while any is unfinished — the animation *is* the repaint loop,
   * and it stops on its own the frame the last one lands.
   */
  _advanceAnimations(now) {
    this.frameTime = now;
    if (this._animating.size === 0) return;
    for (const node of [...this._animating]) {
      if (node.destroyed || !node._tickAnimations(now)) {
        this._animating.delete(node);
      }
    }
    this.needsPaint = true;
    if (this._animating.size > 0) this.invalidate(false);
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
    this._advanceAnimations(now());
    const width = this.window.width ?? this.props.width ?? 0;
    const height = this.window.height ?? this.props.height ?? 0;
    if (this.needsLayout) {
      this._resolveSizeQueries(width, height);
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
    ctx.fillStyle = this.style.backgroundColor || 'white';
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
  /**
   * `grab`: hold a pointer grab while this popup is up. That is how menus
   * work on X — without it a press that lands anywhere else (another app,
   * the root, or this app's own window *frame*, which belongs to the window
   * manager) never reaches us, so the menu stays open behind whatever the
   * user clicked. With the grab, that press arrives here instead, outside
   * our bounds, and `onDismiss` fires. Needs ntk >= 3.7.0; without it the
   * popup simply behaves as before.
   */
  realize(parentWindow) {
    super.realize(parentWindow);
    if (this.props.grab && !this.destroyed) {
      this.window?.grabPointer?.({}, () => {});
    }
  }

  destroySubtree() {
    if (this.props.grab) this.window?.ungrabPointer?.();
    super.destroySubtree();
  }

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
