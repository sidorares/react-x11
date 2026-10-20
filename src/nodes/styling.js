// A node's own style: `props.style` resolved against its states, tokens,
// queries and scale into `this.style`, and the style names an element
// claims as its own semantics.

import {
  flattenStyle,
  validateStyle,
  resolveStyleStates,
  resolveComputedStyle,
  scaleResolvedStyle,
  hasStateStyles,
  isStyleProp,
  EMPTY_STYLE,
  styleUsesTokens,
  resolveTokens,
  queryKinds,
  QUERY_SIZE,
  QUERY_SUPPORTS,
  QUERY_CONTAINER,
  containerQueryNames,
  containerAnswers,
  resolveQueries,
} from '../styles.js';
import { readLength, UNIT_EM, UNIT_REM, UNIT_VIEWPORT } from '../shorthands.js';
import { DEFAULT_TEXT_STYLE } from '../styles.js';
import { CUSTOM_SEMANTIC_NAMES } from './kinds.js';
import { DEV, shallowEqual } from './util.js';

/**
 * What a relative length on one node resolves against — `em`, `rem` and the
 * viewport units (src/shorthands.js, `RELATIVE`) — in logical pixels, the
 * unit everything an app writes is in. Lazy: a style written in pixels asks
 * none of it, and pays one allocation. Each answer it gives is recorded in
 * `deps`, which is how the node knows to resolve the style again when that
 * answer moves (`_noteUnits`).
 *
 * `style` is the one being resolved, not the one in force: a `padding:
 * '1em'` beside a `fontSize: '20px'` is 20, whichever the style had before.
 */
class Units {
  constructor(node, style) {
    this.node = node;
    this.style = style;
    this.deps = 0;
    this.parentEmRead = undefined;
    this.emRead = undefined;
  }

  /** The font size this node inherits — what `em` is on `fontSize`
   *  itself, as in CSS. Device pixels down the cascade, at this node's
   *  scale, so one divide brings it back. */
  get parentEm() {
    this.deps |= UNIT_EM;
    if (this.parentEmRead === undefined) {
      const node = this.node;
      this.parentEmRead = node.inheritedTextStyle.size / (node.scale || 1);
    }
    return this.parentEmRead;
  }

  /** This node's own font size — its `fontSize`, read against what it
   *  inherits where that is relative, or the inherited one. Depends on the
   *  inheritance only when it reads it. */
  get em() {
    if (this.emRead === undefined) {
      const size = this.style.fontSize;
      let own;
      if (size != null && size !== '') {
        try {
          own = readLength('fontSize', size, undefined, this);
        } catch {
          // the text inherits past a size it cannot read, and so does `em`
        }
      }
      this.emRead = typeof own === 'number' && own >= 0 ? own : this.parentEm;
    }
    return this.emRead;
  }

  /** The palette's `fontSize`: the root font size here, the size every label
   *  that names none of its own is set in. */
  get rem() {
    this.deps |= UNIT_REM;
    return this.node.theme?.fontSize ?? DEFAULT_TEXT_STYLE.size;
  }

  /** The window this node is in, as a size query sees it. Before the window
   *  has been laid out, the size it asked for, where it named one; the
   *  size-query registry resolves the style again when the real one lands. */
  get viewport() {
    this.deps |= UNIT_VIEWPORT;
    const node = this.node;
    const root = node.root ?? (node.isWindow ? node : null);
    if (root?.querySize) return root.querySize;
    const props = root?.props;
    return {
      width: typeof props?.width === 'number' ? props.width : 0,
      height: typeof props?.height === 'number' ? props.height : 0,
    };
  }
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

/** What a style that read no relative length read: nothing. */
const NO_UNITS = Object.freeze({ deps: 0, parentEmRead: undefined });

/** A node's own style, installed onto `Node.prototype` by node.js. */
export class NodeStyling {
  /**
   * Everything that paints or lays out reads `this.style`, never `this.props`
   * — props carry element semantics (`title`, `value`, geometry, handlers)
   * and style carries the CSS-like vocabulary, with no name shared between
   * them. `baseStyle` is the flattened `style` prop; `style` is that with
   * the active state blocks overlaid.
   */
  _syncStyle(props, mounting = false) {
    if (DEV && this.stylable) {
      assertNoFlatStyleProps(props, this.kind, this.semanticNames);
      validateStyle(flattenStyle(props.style), `<${this.kind} style>`);
    }
    this._baseStyle = this.stylable ? flattenStyle(props.style) : EMPTY_STYLE;
    this._usesTokens = this.stylable && styleUsesTokens(this._baseStyle);
    if (this._usesTokens) {
      const theme = this.theme;
      const strict = this.placed;
      const problems = strict ? [] : null;
      this._baseStyle = resolveTokens(
        this._baseStyle,
        theme,
        `<${this.kind} style>`,
        strict,
        problems,
      );
      if (problems?.length) this._tokenProblem(problems, mounting);
    }
    // `disabled` is a prop, not something the pointer does, so it is read
    // straight off props rather than driven by the event manager
    this.states[':disabled'] = Boolean(props.disabled);
    // window size queries fold into the base before state blocks, so a
    // `:hover` inside the wide layout still wins over the wide layout
    const kinds = queryKinds(this._baseStyle);
    // whether a resize re-resolves this node is decided at the end, once the
    // style has said whether it reads the window through a viewport unit
    const queried = (kinds & QUERY_SIZE) !== 0;
    // `@supports` blocks keep their own registry: what re-resolves them is
    // the server's answer changing, not a resize
    // Registered unconditionally rather than on change: a `<window>`'s own
    // style is resolved by the Node constructor, before `root` is even
    // assigned, so the first pass has nowhere to register and a "did it
    // change" guard would keep it unregistered forever. Set.add is
    // idempotent and these blocks are rare.
    const asks = (kinds & QUERY_SUPPORTS) !== 0;
    this._supportsQueried = asks;
    if (this.root?._supportsQueryNodes) {
      if (asks) this.root._supportsQueryNodes.add(this);
      else this.root._supportsQueryNodes.delete(this);
    }
    // Attention candidates keep a registry for the same reason and are
    // registered the same unconditional way — a `<window>`'s own style is
    // resolved before `root` is assigned, so a "did it change" guard would
    // leave it unregistered forever. Unlike hover, attention is *matched*
    // against this set rather than hit-tested, so a node that is not in it
    // is not a candidate at all.
    const wantsAttention = Boolean(
      props.unstable_onAttention || this._baseStyle[':attention'],
    );
    this._wantsAttention = wantsAttention;
    if (this.root?._attentionNodes) {
      if (wantsAttention) this.root._attentionNodes.add(this);
      else this.root._attentionNodes.delete(this);
    }
    // `@container` blocks keep a third registry: what re-resolves them is a
    // layout pass moving the container they ask about — neither a resize
    // nor the server's answer. The record exists only on the nodes that
    // ask, so every other node pays one bit test here and nothing below.
    // Insertion registers through `_registerSizeQueries`; this is for a
    // style that starts or stops asking on a node already in a window.
    const asksContainers = (kinds & QUERY_CONTAINER) !== 0;
    let containers = null;
    if (asksContainers) {
      const base = this._baseStyle;
      let cq = this._cq;
      if (cq === null || cq.style !== base) {
        if (cq === null) {
          cq = this._cq = {
            style: base,
            names: null,
            containers: null,
            answers: '',
            pin: null,
            warned: false,
          };
        } else {
          // a different style asks different questions, and a pin held for
          // the old one is not an answer to the new one
          cq.style = base;
          cq.pin = null;
        }
        cq.names = containerQueryNames(base);
      }
      this.root?._containerQueryNodes?.add(this);
      containers = this._pinnedContainerSizes();
    } else if (this._cq !== null) {
      this._cq = null;
      this.root?._containerQueryNodes?.delete(this);
    }
    if (queried || asks || asksContainers) {
      this._baseStyle = resolveQueries(this._baseStyle, {
        size: this.root?.querySize ?? null,
        // null before the window is realized, which reads as "not
        // supported" — the fallback design is the one that works everywhere
        supports: this.root?.capabilities ?? null,
        containers,
      });
      if (asksContainers) {
        this._cq.containers = containers;
        this._cq.answers = containerAnswers(this._baseStyle, containers);
      }
    }
    this._stateful = hasStateStyles(this._baseStyle);
    const merged = this._stateful
      ? resolveStyleStates(this._baseStyle, this.states)
      : this._baseStyle;
    // The scale multiplies *after* every merge — state blocks, queries,
    // the shorthands, the relative units — so each of those keeps thinking
    // in the logical pixels the app wrote, and device pixels exist only
    // downstream of this line (src/scale.js).
    this._unitsNow = null;
    const target = scaleResolvedStyle(
      resolveComputedStyle(merged, this._unitsMaker()),
      this.scale,
    );
    const units = this._unitsNow ?? NO_UNITS;
    // what a loop's relative end reads (`_syncLoops`) is read through the
    // same context, during the swap
    // …and the basis is in place before the swap, which may walk the text
    // cascade back through this node (`_emMoved`)
    this._units = units;
    this._noteUnits(units, queried, false);
    const out = this._retarget(target);
    this._units = null;
    this._noteUnits(units, queried, true);
    return out;
  }

  /**
   * Record what this node's style read to resolve its relative lengths, and
   * join or leave what moves each: the size-query registry for the window's
   * size (a viewport unit asks the same question an `'@width'` block does,
   * and is answered by the same re-resolution on a resize); the text cascade
   * for the inherited font size (`_retext` walks it, and stops at a node
   * whose resolution was never cached — so a node that reads it caches one);
   * and the theme walk for the palette's (`_themeChanged`).
   */
  /** What makes this node's unit context, for `resolveComputedStyle` to
   *  call only when a style has something to read; the one it made is
   *  `_unitsNow`. Made once per node, rather than a context per style. */
  _unitsMaker() {
    return (this._makeUnits ??= (style) =>
      (this._unitsNow = new Units(this, style)));
  }

  _noteUnits(units, sizeQueried, settled) {
    this._unitDeps = units.deps;
    this._emBasis = units.parentEmRead;
    this._sizeQueried = sizeQueried;
    const asks = sizeQueried || (units.deps & UNIT_VIEWPORT) !== 0;
    if (asks !== this._queried) {
      this._queried = asks;
      const root = this.root;
      if (root?._sizeQueryNodes) {
        if (asks) root._sizeQueryNodes.add(this);
        else root._sizeQueryNodes.delete(this);
      }
    }
    // asked of the style the swap put in force, never the one before it
    if (settled && units.deps & UNIT_EM && this._resolvedText === undefined) {
      this.resolvedTextStyle();
    }
  }

  /**
   * Resolve the style again because something a relative length read moved
   * — the font size this node inherits — with no commit to do it. The rest
   * is the tail a re-resolution outside a commit always has
   * (`_restyled`), plus the claim a commit would have made.
   */
  _unitsMoved() {
    if (this.destroyed) return;
    const before = this.style;
    this._syncStyle(this.props);
    const moved = this._restyled(
      before,
      'resolved against a font size that moved',
    );
    if (moved) this._invalidateLayout('units');
    else if (this.style !== before) this.root?.invalidate(false, this, 'units');
  }

  /** Whether the font size this node inherits is not the one its relative
   *  lengths were resolved against. */
  _emMoved() {
    if (!(this._unitDeps & UNIT_EM)) return false;
    return this.inheritedTextStyle.size / (this.scale || 1) !== this._emBasis;
  }

  /**
   * A node state changed (hover, focus, press). Only nodes that actually
   * declare a block for it do anything, and what they do is a repaint —
   * no React render, no reflow, since state blocks cannot touch layout.
   */
  setStyleState(name, on) {
    if (this.states[name] === on) return;
    this.states[name] = on;
    // the focus ring's reach is read off `:focus-visible` whether or not
    // the node has a state block of its own (`_outlineExtent`)
    this._clearPaintBounds();
    if (!this._stateful || this.destroyed) return;
    const merged = resolveStyleStates(this._baseStyle, this.states);
    this._unitsNow = null;
    const next = scaleResolvedStyle(
      resolveComputedStyle(merged, this._unitsMaker()),
      this.scale,
    );
    if (shallowEqual(next, this._targetStyle)) return;
    const units = this._unitsNow;
    this._units = units;
    this._retarget(next);
    this._units = null;
    // a state block reads what the base did and may read more — a radius in
    // `rem` on `:hover` — and a node keeps answering to all of it
    if (units !== null) {
      units.deps |= this._unitDeps;
      units.parentEmRead ??= this._emBasis;
      this._noteUnits(units, this._sizeQueried, true);
    }
    // a state block may only set paint properties, so the node's own region
    // is the whole of what changed
    this.root?.invalidate(false, this, 'style-state');
  }

  /** Style names this element claims as its own semantics (see WindowNode).
   * Registered elements declare theirs to `registerElement`, so the common
   * case needs no subclass. */
  get semanticNames() {
    return CUSTOM_SEMANTIC_NAMES.get(this.kind) ?? NO_SEMANTIC_NAMES;
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
}
