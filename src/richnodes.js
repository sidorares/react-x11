// Rich-content elements: thin retained-node wrappers over ntk's document
// widgets in standalone mode (`layout(width)` + `draw(ctx, x, y)` +
// `contentHeight`). One yoga measure function per node feeds the widget's
// own layout into flexbox; async content (HtmlView images and SVGs) arrives
// through the widget's `onInvalidate` hook (ntk >= 3.4.0).
import { MarkdownView, HtmlView, SvgView, layoutTex } from 'ntk';

import { Node } from './nodes.js';
import {
  Yoga,
  isLayoutProp,
  isPaintProp,
  DEFAULT_TEXT_STYLE,
} from './styles.js';

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
    this.yoga.setMeasureFunc((width, widthMode) => {
      const view = this._ensureView();
      if (!view) return { width: 0, height: 0 };
      const unconstrained =
        widthMode === Yoga.MEASURE_MODE_UNDEFINED ||
        !Number.isFinite(width) ||
        width <= 0;
      const w = Math.max(1, Math.ceil(unconstrained ? PREFERRED_WIDTH : width));
      const height = this._layoutAt(w);
      return { width: w, height: Math.ceil(height) };
    });
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
    this.yoga?.markDirty();
    this.root?.invalidate(true, null, 'content');
  }

  _source() {
    return stringChildrenOf(this) ?? this.props.source ?? '';
  }

  /** String children changed (chunk added/removed/edited). */
  _textContentChanged() {
    if (this.view) this._setSource(this.view);
    this._contentInvalidated();
  }

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

  _paintContent(ctx) {
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
    // take synthetic-event coordinates directly (_defaultMouseDown)
    view.draw(ctx, content.x, content.y);
    ctx.restore();
  }

  _defaultMouseDown(ev) {
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
 * (viewBox) size, kept to its aspect ratio when only the width is
 * constrained; scales to the content box.
 */
export class SvgNode extends Node {
  constructor(props, app) {
    super('svg', props, app);
    this.view = null;
    this._stale = true;
    this._configureMeasure();
  }

  /** Any change to the svg subtree (props, children, text) lands here. */
  _textContentChanged() {
    this._stale = true;
    // markDirty is only legal on nodes with a measure function (it is
    // unset when width and height are both fixed)
    if (this._hasMeasure) this.yoga?.markDirty();
    this.root?.invalidate(true, null, 'props');
  }

  _ensureView() {
    if (!this._stale) return this.view;
    this._stale = false;
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

  _configureMeasure() {
    if (this.props.width != null && this.props.height != null) {
      if (this._hasMeasure) this.yoga.unsetMeasureFunc();
      this._hasMeasure = false;
      return;
    }
    this._hasMeasure = true;
    this.yoga.setMeasureFunc((width, widthMode) => {
      const view = this._ensureView();
      const natW = view?.naturalWidth ?? 0;
      const natH = view?.naturalHeight ?? 0;
      let w = natW;
      if (
        widthMode !== Yoga.MEASURE_MODE_UNDEFINED &&
        Number.isFinite(width) &&
        width < w
      ) {
        w = width;
      }
      return { width: w, height: natW > 0 ? (w * natH) / natW : natH };
    });
  }

  applyProps(newProps, oldProps) {
    super.applyProps(newProps, oldProps);
    this._configureMeasure();
    // attributes live in props (children form) or in `source`; either way
    // the SvgView is cheap to rebuild on the next measure/paint
    this._textContentChanged();
  }

  _paintContent(ctx) {
    const view = this._ensureView();
    if (!view) return;
    const content = this.contentBox();
    if (content.width <= 0 || content.height <= 0) return;
    view.draw(ctx, content.x, content.y, content.width, content.height, {
      color: this._currentColor(),
    });
  }

  /** What `fill="currentColor"` resolves to here. */
  _currentColor() {
    return this.style.color ?? DEFAULT_TEXT_STYLE.color;
  }

  /**
   * Cache plan (see `Node._paintContent` for the protocol).
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
   */
  paintCachePlan() {
    const view = this._ensureView();
    if (!view || !this._docKey) return null;
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
 * <tex source displayMode size color>: a KaTeX formula via ntk layoutTex.
 * Layout is synchronous and headless; the box has an intrinsic size (no
 * wrapping). Invalid TeX renders nothing and logs once.
 */
export class TexNode extends Node {
  constructor(props, app) {
    super('tex', props, app);
    this.box = null;
    this._boxKey = null;
    this.yoga.setMeasureFunc(() => {
      const box = this._ensureBox();
      if (!box) return { width: 0, height: 0 };
      return { width: Math.ceil(box.width), height: Math.ceil(box.height) };
    });
  }

  /** Formula text changed via string children. */
  _textContentChanged() {
    this._boxKey = null;
    this.yoga?.markDirty();
    this.root?.invalidate(true, null, 'text');
  }

  _ensureBox() {
    const { size, color, displayMode, katex } = this.props;
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
    if (
      newProps.source !== before.source ||
      newProps.size !== before.size ||
      newProps.color !== before.color ||
      newProps.displayMode !== before.displayMode
    ) {
      this.yoga.markDirty();
      this.root?.invalidate(true, null, 'props');
    }
  }

  _paintContent(ctx) {
    const box = this._ensureBox();
    // TexBox.draw issues raw XRender requests through ctx.window.app —
    // it needs a real ntk 2d context (headless mock contexts skip)
    if (!box || !ctx.window?.app?.display) return;
    const content = this.contentBox();
    ctx.fillStyle = this.style.color ?? '#222222';
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
   * it never sets a colour of its own, which it does not.
   */
  paintCachePlan() {
    const box = this._ensureBox();
    if (!box || !this._boxKey) return null;
    const content = this.contentBox();
    const width = Math.ceil(content.width);
    const height = Math.ceil(content.height);
    if (width <= 0 || height <= 0) return null;
    return {
      key: `tex|${width}x${height}@1|${this.style.color ?? ''}|${this._boxKey}`,
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
    ctx.fillStyle = this.style.color ?? '#222222';
    laid.draw(ctx, box.x, box.y);
  }
}
