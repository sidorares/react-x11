// Rich-content elements: thin retained-node wrappers over ntk's document
// widgets in standalone mode (`layout(width)` + `draw(ctx, x, y)` +
// `contentHeight`). One yoga measure function per node feeds the widget's
// own layout into flexbox; async content (mermaid models, images) arrives
// through the widget's `onInvalidate` hook (ntk >= 3.4.0).
import { MarkdownView, HtmlView, SvgView, layoutTex } from 'ntk';

import { Node } from './nodes.js';
import { Yoga, isLayoutProp, isPaintProp } from './styles.js';

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
      // ntk >= 3.4.0 notifies here when async content (a mermaid model, an
      // image) invalidates the widget layout; harmless no-op before that
      this.view.onInvalidate = () => this._contentInvalidated();
      this._setSource(this.view);
    }
    return this.view;
  }

  _contentInvalidated() {
    if (this.destroyed) return;
    this._laidOutWidth = -1;
    this.yoga?.markDirty();
    this.root?.invalidate(true);
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
 * tables, syntax-highlighted fences, math fences, async mermaid fences.
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
    this.root?.invalidate(true);
  }

  _ensureView() {
    if (!this._stale) return this.view;
    this._stale = false;
    this.view = null;
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
        this.view = new SvgView(null).setSvgDom({
          type: 'tag',
          name: 'svg',
          attribs: svgAttribs(this.props, skip),
          children: children.map((c) =>
            c.kind === 'textchunk' ? { type: 'text', data: c.text } : c.toDom(),
          ),
        });
      } else if (this.props.source) {
        this.view = new SvgView(null).setSvg(String(this.props.source));
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
    view.draw(ctx, content.x, content.y, content.width, content.height);
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
    this.root?.invalidate(true);
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
      this.root?.invalidate(true);
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
}
