// Rich-content elements: thin retained-node wrappers over ntk's document
// widgets in standalone mode (`layout(width)` + `draw(ctx, x, y)` +
// `contentHeight`). One yoga measure function per node feeds the widget's
// own layout into flexbox; async content (HtmlView images and SVGs) arrives
// through the widget's `onInvalidate` hook (ntk >= 3.4.0).
import { MarkdownView, HtmlView, SvgView, layoutTex } from 'ntk';

import { Node, intrinsicSize } from './nodes.js';
import { isLayoutProp, isPaintProp } from './styles.js';

/** Joined text of string children (react-markdown style), or null when the
 * element has none — then the `source` prop is the content. */
function stringChildrenOf(node) {
  let text = null;
  for (const child of node.children) {
    if (child.kind === 'textchunk') text = (text ?? '') + child.text;
  }
  return text;
}

// Fallback width for measuring under an unconstrained yoga width
// (position: absolute without width, unbounded row). Flowed documents have
// no natural width, so pick something readable.
const PREFERRED_WIDTH = 480;

/**
 * Base for <markdown> and <html>: width-driven document flow. Subclasses
 * implement _createView() (a widget with layout/draw/contentHeight) and
 * _setSource(view). Content is a string child (like react-markdown:
 * <markdown>{`# Hi`}</markdown> — use a template-literal expression, JSX
 * literal text collapses newlines) or the `source` prop; children win.
 * The view is created lazily because the headless mock app in smoke tests
 * has no font manager — everything measures 0×0 there, like <text>.
 */
class DocumentViewNode extends Node {
  constructor(kind, props, app) {
    super(kind, props, app);
    this.view = null;
    this._laidOutWidth = -1;
  }

  /** Height for a width, through the document widget's own layout. A flowed
   * document has no natural width, so an unbounded offer gets a readable
   * one rather than one long line. */
  measureContent({ width }) {
    const view = this._ensureView();
    if (!view) return { width: 0, height: 0 };
    const bounded = Number.isFinite(width) && width > 0;
    const w = Math.max(1, Math.ceil(bounded ? width : PREFERRED_WIDTH));
    return { width: w, height: Math.ceil(this._layoutAt(w)) };
  }

  _ensureView() {
    if (this.view || !this.app?.fonts) return this.view;
    this.view = this._createView();
    if (this.view) {
      // ntk >= 3.4.0 notifies here when async content (an HtmlView image or
      // SVG) invalidates the widget layout; MarkdownView never fires it —
      // its layout is synchronous — and the assignment is a harmless no-op
      this.view.onInvalidate = () => this._contentInvalidated();
      this._setSource(this.view);
    }
    return this.view;
  }

  _contentInvalidated() {
    if (this.destroyed) return;
    this._laidOutWidth = -1;
    this.invalidateMeasure('content');
  }

  _source() {
    return stringChildrenOf(this) ?? this.props.source ?? '';
  }

  /** String children changed (chunk added/removed/edited). */
  _textContentChanged() {
    if (this.view) this._setSource(this.view);
    this._contentInvalidated();
  }

  /** A document sets its own type — headings, code, body, all decided by the
   * widget's `theme` prop — so the enclosing element's ink and face are not
   * something it reads, and a change in them costs it nothing. */
  _textStyleMoved() {}

  _layoutAt(width) {
    if (this._laidOutWidth !== width) {
      this.view.layout(width);
      this._laidOutWidth = width;
    }
    return this.view.contentHeight;
  }

  /** Props that require rebuilding the view (theme and loader options are
   * constructor-only in the ntk widgets). Subclasses extend. */
  _viewProps() {
    return ['theme'];
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    super.applyProps(newProps, oldProps);
    if (!this.view) return;
    if (this._viewProps().some((key) => newProps[key] !== before[key])) {
      this.view = null; // rebuilt (and re-sourced) on next measure/paint
      this._contentInvalidated();
      return;
    }
    if (newProps.source !== before.source) {
      this._setSource(this.view);
      this._contentInvalidated();
    }
  }

  paintContent(ctx) {
    const view = this._ensureView();
    if (!view) return;
    const content = this.contentBox();
    if (content.width <= 0) return;
    this._layoutAt(Math.max(1, Math.ceil(content.width)));
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.abs.x, this.abs.y, this.abs.width, this.abs.height);
    ctx.clip();
    // links recorded by draw() are in window coordinates, so linkAt can
    // take synthetic-event coordinates directly (defaultMouseDown)
    view.draw(ctx, content.x, content.y);
    ctx.restore();
  }

  defaultMouseDown(ev) {
    if (ev.button !== 1 || !this.view || !this.props.onLink) return;
    const hit = this.view.linkAt(ev.x, ev.y);
    if (!hit) return;
    // MarkdownView.linkAt returns the href, HtmlView an { href, element }
    if (typeof hit === 'string') this.props.onLink(hit, ev);
    else this.props.onLink(hit.href, ev, hit.element);
  }
}

/**
 * <markdown source>: ntk MarkdownView — headings, emphasis, lists, quotes,
 * tables, syntax-highlighted fences, math fences.
 * Props: source, theme, onLink(href, ev). Spacing comes from the box model
 * (padding prop), not the widget's own page padding.
 */
export class MarkdownNode extends DocumentViewNode {
  constructor(props, app) {
    super('markdown', props, app);
  }

  _createView() {
    return new MarkdownView(null, {
      fonts: this.app.fonts,
      theme: this.props.theme,
      padding: 0,
    });
  }

  _setSource(view) {
    view.setMarkdown(this._source());
  }
}

/**
 * <html source>: ntk HtmlView — its own CSS cascade (document <style>s plus
 * the `stylesheet` prop), flexbox/block layout, images. Props: source,
 * stylesheet, baseUrl, loadResource, theme, onLink(href, ev, element).
 */
export class HtmlNode extends DocumentViewNode {
  constructor(props, app) {
    super('html', props, app);
  }

  _viewProps() {
    return ['theme', 'stylesheet', 'baseUrl', 'loadResource'];
  }

  _createView() {
    return new HtmlView(null, {
      fonts: this.app.fonts,
      theme: this.props.theme,
      stylesheet: this.props.stylesheet,
      baseUrl: this.props.baseUrl,
      loadResource: this.props.loadResource,
    });
  }

  _setSource(view) {
    view.setHtml(this._source(), { baseUrl: this.props.baseUrl });
  }
}

// SVG attributes that are camelCase in SVG itself; every other camelCase
// prop (strokeWidth, fillRule, textAnchor, …) kebab-cases, like React DOM.
const SVG_CAMEL_ATTRS = new Set([
  'viewBox',
  'preserveAspectRatio',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'patternUnits',
  'patternContentUnits',
  'patternTransform',
  'clipPathUnits',
  'maskUnits',
  'maskContentUnits',
  'markerWidth',
  'markerHeight',
  'markerUnits',
  'refX',
  'refY',
  'textLength',
  'lengthAdjust',
  'stdDeviation',
]);

const toSvgAttrib = (name) =>
  SVG_CAMEL_ATTRS.has(name)
    ? name
    : name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

function svgAttribs(props, skip) {
  const attribs = {};
  for (const key of Object.keys(props)) {
    const value = props[key];
    if (key === 'children' || value == null) continue;
    if (typeof value === 'function') continue;
    if (skip && skip(key)) continue;
    attribs[toSvgAttrib(key)] = String(value);
  }
  return attribs;
}

/**
 * An element inside <svg>: no yoga node, no painting of its own — it only
 * carries a tag name and props, and is serialized into the htmlparser2-style
 * DOM that SvgView consumes. Prop/child changes bubble to the owning
 * SvgNode via the _textContentChanged channel (also used by text chunks,
 * so string children of an SVG <text> invalidate the same way).
 */
export class SvgChildNode extends Node {
  constructor(tag, props, app) {
    super(tag, props, app, { yoga: false });
    this.isSvgChild = true;
  }

  // <circle cx r fill>… is SVG's vocabulary, not the style channel's
  get stylable() {
    return false;
  }

  _textContentChanged() {
    this.parent?._textContentChanged();
  }

  applyProps(newProps, oldProps) {
    super.applyProps(newProps, oldProps);
    this._textContentChanged();
  }

  toDom() {
    return {
      type: 'tag',
      name: this.kind,
      attribs: svgAttribs(this.props),
      children: this.children
        .map((c) =>
          c.kind === 'textchunk'
            ? { type: 'text', data: c.text }
            : c.isSvgChild
              ? c.toDom()
              : null,
        )
        .filter(Boolean),
    };
  }
}

/**
 * <svg>: ntk SvgView. Content is either JSX children (React-DOM style —
 * <svg viewBox="0 0 24 24"><circle cx={12} … />; children win when both
 * are present) or a `source` markup string. Sized like <image>: natural
 * (viewBox) size, kept to its aspect ratio when the style constrains only
 * one axis; scales to the content box.
 */
export class SvgNode extends Node {
  constructor(props, app) {
    super('svg', props, app);
    this.view = null;
    this._stale = true;
    /** Bumped every time the document is rebuilt, and sampled at paint time,
     * so `paintCachePlan` can tell an animated document from a settled one.
     * See the note there. */
    this._docRevision = 0;
    this._paintedRevision = -1;
  }

  /** The viewBox is the natural size; `<image>`'s rules do the rest. */
  measureContent(constraints) {
    const view = this._ensureView();
    return intrinsicSize(
      {
        width: view?.naturalWidth ?? 0,
        height: view?.naturalHeight ?? 0,
      },
      constraints,
    );
  }

  /** Any change to the svg subtree (props, children, text) lands here. */
  _textContentChanged() {
    this._stale = true;
    this.invalidateMeasure('props');
  }

  _ensureView() {
    if (!this._stale) return this.view;
    this._stale = false;
    this._docRevision++;
    this.view = null;
    this._docKey = null;
    try {
      const children = this.children.filter(
        (c) => c.isSvgChild || c.kind === 'textchunk',
      );
      if (children.length > 0) {
        const skip = (key) =>
          key === 'source' ||
          isLayoutProp(key) ||
          isPaintProp(key) ||
          key === 'cursor' ||
          key === 'focusable' ||
          key === 'pointerEvents';
        const dom = {
          type: 'tag',
          name: 'svg',
          attribs: svgAttribs(this.props, skip),
          children: children.map((c) =>
            c.kind === 'textchunk' ? { type: 'text', data: c.text } : c.toDom(),
          ),
        };
        // The document's identity, for the paint cache. Built here rather
        // than at paint time on purpose: this runs once per content change,
        // where paint runs every frame — and it is the serialization that
        // makes two cells holding the same drawing one cache entry instead
        // of two. Key order follows prop order, so two logically identical
        // documents written differently miss rather than collide, which is
        // the harmless direction.
        this._docKey = JSON.stringify(dom);
        this.view = new SvgView(null).setSvgDom(dom);
      } else if (this.props.source) {
        this._docKey = String(this.props.source);
        this.view = new SvgView(null).setSvg(this._docKey);
      }
    } catch (err) {
      console.error('react-x11: <svg> failed to parse:', err.message);
    }
    return this.view;
  }

  applyProps(newProps, oldProps) {
    super.applyProps(newProps, oldProps);
    // attributes live in props (children form) or in `source`; either way
    // the SvgView is cheap to rebuild on the next measure/paint
    this._textContentChanged();
  }

  paintContent(ctx) {
    const view = this._ensureView();
    if (!view) return;
    const content = this.contentBox();
    if (content.width <= 0 || content.height <= 0) return;
    view.draw(ctx, content.x, content.y, content.width, content.height, {
      color: this._currentColor(),
    });
  }

  /**
   * What `fill="currentColor"` resolves to here.
   *
   * The node's own `color`, then what it inherits, then the palette's — the
   * same resolution `<text>` and `<canvas mono>` use, and it has to be, or
   * `currentColor` means something different depending on which element is
   * drawing. It used to stop at a hardcoded black, which is invisible on a
   * dark desktop and does not follow a `<box style={{ color }}>` either.
   */
  _currentColor() {
    return this.resolvedTextStyle().color;
  }

  /**
   * Cache plan (see `Node.paintContent` for the protocol).
   *
   * The key is the document, the size it is drawn at, and the device scale.
   * Everything else that could change the pixels is either handled at blit
   * time or deliberately excluded:
   *
   *  - `globalAlpha`, the clip and any ancestor translation are applied by
   *    `drawImage`, so an ancestor animating opacity is a cache *hit*;
   *  - colour is out of the key for a `mono` document, because the entry is
   *    coverage and the colour arrives at blit time — one entry then serves
   *    hover, `:disabled` and every theme;
   *  - a `multi` document bakes its colours, so the resolved colour joins the
   *    key. It rarely varies, so the extra component costs nothing.
   *
   * Sizes are rounded so the blit is unscaled: a scaled `drawImage` brackets
   * every composite with SetPictureTransform and a filter change, which for
   * a wall of icons is four extra requests each. The cost is that a cached
   * drawing sits on the pixel grid where a live one could straddle it, which
   * for icon-sized content is not visible.
   *
   * ## Animated documents opt themselves out
   *
   * A document that was rebuilt since this node's last paint is being
   * animated, and caching it is a pure loss: the entry is written, composited
   * once at most, and never matched again. The cache has a "seen twice" gate
   * for exactly this, but content keying defeats it here — a wall of the same
   * animated drawing at different phases produces documents that recur across
   * *nodes* by coincidence, which is enough sightings to pass the gate and
   * never enough to pay it back. Measured on a wall of 30 animated gauges:
   * 450 of 1076 distinct documents recurred, 12% of lookups hit, and each
   * miss-that-cached bought a CreatePixmap plus a second rasterization of a
   * drawing that had already been painted live. On a server where offscreen
   * rasterization is a software fallback that doubled the frame's fence.
   *
   * So the revision has to match the one this node last painted. A node that
   * has never painted has nothing to compare and stays speculative, exactly
   * as before — the "seen twice" gate is still the thing deciding, so a wall
   * of identical icons fills on its first frame from its own sibling cells.
   * Only a document that then *changes* opts out, which is the signal that it
   * was never going to be matched again.
   */
  paintCachePlan() {
    const view = this._ensureView();
    if (!view || !this._docKey) return null;
    const painted = this._paintedRevision;
    this._paintedRevision = this._docRevision;
    if (painted >= 0 && painted !== this._docRevision) return null;
    const content = this.contentBox();
    const width = Math.round(content.width);
    const height = Math.round(content.height);
    if (width <= 0 || height <= 0) return null;

    const mono = view.paintKind === 'mono';
    // a mono document paints in exactly one colour: its own, or ours
    const tint = !mono
      ? null
      : view.soloPaint === 'currentColor'
        ? this._currentColor()
        : view.soloPaint;
    if (mono && !tint) return null; // nothing in the document paints at all

    const size = `${width}x${height}@1`;
    return {
      key: mono
        ? `svg|${size}|${this._docKey}`
        : `svg|${size}|${this._currentColor()}|${this._docKey}`,
      x: Math.round(content.x),
      y: Math.round(content.y),
      width,
      height,
      format: mono ? 'a8' : 'argb32',
      tint,
    };
  }

  paintCached(ctx, box) {
    const view = this._ensureView();
    if (!view) return;
    // Into a coverage surface, only the alpha of a paint survives, and the
    // tint arrives at blit time — so any opaque colour renders the same mask.
    view.draw(ctx, box.x, box.y, box.width, box.height, {
      color: view.paintKind === 'mono' ? '#ffffff' : this._currentColor(),
    });
  }
}

/**
 * A formula's ink, which is the ink of the text around it unless the style
 * names one. It used to be a fixed `#222222` — a shade darker than the prose
 * beside it, so a formula read as a figure. That cannot survive a palette
 * that follows the desktop: `#222222` on a dark background is invisible, and
 * stepping past `text` to keep the contrast lands on black on a light one.
 */
const texColor = (node) => node.resolvedTextStyle().color;

/**
 * <tex source displayMode size>: a KaTeX formula via ntk layoutTex.
 * Layout is synchronous and headless; the box has an intrinsic size (no
 * wrapping). Invalid TeX renders nothing and logs once.
 *
 * The ink colour is `style={{ color }}`, not a prop — `color` is a style
 * name, so a `color` prop threw in development and only worked in
 * production (issue #118). `paintContent` and `paintCachePlan` already
 * read it off the style; the prop reached nothing but layoutTex.
 */
export class TexNode extends Node {
  constructor(props, app) {
    super('tex', props, app);
    this.box = null;
    this._boxKey = null;
  }

  /** A formula does not wrap: one size, whatever is on offer. */
  measureContent() {
    const box = this._ensureBox();
    if (!box) return { width: 0, height: 0 };
    return { width: Math.ceil(box.width), height: Math.ceil(box.height) };
  }

  /** Formula text changed via string children. */
  _textContentChanged() {
    this._boxKey = null;
    this.invalidateMeasure('text');
  }

  _ensureBox() {
    const { size, displayMode, katex } = this.props;
    const color = texColor(this);
    const source = stringChildrenOf(this) ?? this.props.source;
    if (!source) return null;
    const key = `${source}|${size}|${color}|${displayMode}`;
    if (this._boxKey === key) return this.box;
    this._boxKey = key;
    this.box = null;
    try {
      this.box = layoutTex(String(source), {
        size,
        color,
        displayMode: displayMode ?? false,
        katex,
      });
    } catch (err) {
      console.error('react-x11: <tex> failed to layout:', err.message);
    }
    return this.box;
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    super.applyProps(newProps, oldProps);
    // A colour change is not in here: it cannot move the box, and the
    // repaint it does need is already claimed for it as a paint style.
    if (
      newProps.source !== before.source ||
      newProps.size !== before.size ||
      newProps.displayMode !== before.displayMode
    ) {
      this.invalidateMeasure('props');
    }
  }

  paintContent(ctx) {
    const box = this._ensureBox();
    // TexBox.draw issues raw XRender requests through ctx.window.app —
    // it needs a real ntk 2d context (headless mock contexts skip)
    if (!box || !ctx.window?.app?.display) return;
    const content = this.contentBox();
    ctx.fillStyle = texColor(this);
    box.draw(ctx, content.x, content.y);
  }

  /**
   * A formula is the other thing in the tree that is expensive to draw and
   * never changes on its own, and `_boxKey` already says what it is made of.
   *
   * Note what content-keying adds over that memo: `_boxKey` caches the
   * *layout* per node, so a document showing the same formula twice lays it
   * out twice and rasterizes it twice on every frame. One cache entry serves
   * both.
   *
   * The colour is in the key rather than tinted, because a TexBox draws
   * through glyph and trapezoid composites whose colour is the context's
   * fill at draw time; rendering it as coverage would need the box to promise
   * it never sets a colour of its own, which it does not. `_boxKey` carries
   * it — the colour is a style value, and that is where `_ensureBox` reads
   * it from.
   */
  paintCachePlan() {
    const box = this._ensureBox();
    if (!box || !this._boxKey) return null;
    const content = this.contentBox();
    const width = Math.ceil(content.width);
    const height = Math.ceil(content.height);
    if (width <= 0 || height <= 0) return null;
    return {
      key: `tex|${width}x${height}@1|${this._boxKey}`,
      x: Math.round(content.x),
      y: Math.round(content.y),
      width,
      height,
      format: 'argb32',
      tint: null,
    };
  }

  paintCached(ctx, box) {
    const laid = this._ensureBox();
    if (!laid || !ctx.window?.app?.display) return;
    ctx.fillStyle = texColor(this);
    laid.draw(ctx, box.x, box.y);
  }
}
