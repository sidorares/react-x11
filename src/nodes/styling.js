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
import { CUSTOM_SEMANTIC_NAMES } from './kinds.js';
import { DEV, shallowEqual } from './util.js';

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
    const queried = (kinds & QUERY_SIZE) !== 0;
    if (queried !== this._queried) {
      this._queried = queried;
      const root = this.root;
      if (root?._sizeQueryNodes) {
        if (queried) root._sizeQueryNodes.add(this);
        else root._sizeQueryNodes.delete(this);
      }
    }
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
    // The scale multiplies *after* every merge — state blocks, queries,
    // the flex shorthand — so each of those keeps thinking in the logical
    // pixels the app wrote, and device pixels exist only downstream of
    // this line (src/scale.js).
    return this._retarget(
      scaleResolvedStyle(
        resolveComputedStyle(
          this._stateful
            ? resolveStyleStates(this._baseStyle, this.states)
            : this._baseStyle,
        ),
        this.scale,
      ),
    );
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
    const next = scaleResolvedStyle(
      resolveComputedStyle(resolveStyleStates(this._baseStyle, this.states)),
      this.scale,
    );
    if (shallowEqual(next, this._targetStyle)) return;
    this._retarget(next);
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
