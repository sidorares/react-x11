// Rich-content elements: thin retained-node wrappers over ntk's document
// widgets in standalone mode (`layout(width)` + `draw(ctx, x, y)` +
// `contentHeight`). One yoga measure function per node feeds the widget's
// own layout into flexbox; async content (mermaid models, images) arrives
// through the widget's `onInvalidate` hook (ntk > 3.3.0 — sidorares/ntk#75;
// static content works without it).
import { MarkdownView, HtmlView, SvgView, layoutTex } from 'ntk';

import { Node } from './nodes.js';
import { Yoga } from './styles.js';

// Fallback width for measuring under an unconstrained yoga width
// (position: absolute without width, unbounded row). Flowed documents have
// no natural width, so pick something readable.
const PREFERRED_WIDTH = 480;

/**
 * Base for <markdown> and <html>: width-driven document flow. Subclasses
 * implement _createView() (a widget with layout/draw/contentHeight) and
 * _setSource(view). The view is created lazily because the headless mock
 * app in smoke tests has no font manager — everything measures 0×0 there,
 * like <text>.
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
      // ntk > 3.3.0 notifies here when async content (a mermaid model, an
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
    view.setMarkdown(this.props.source ?? '');
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
    view.setHtml(this.props.source ?? '', { baseUrl: this.props.baseUrl });
  }
}

/**
 * <svg source>: ntk SvgView. Sized like <image>: natural (viewBox) size,
 * kept to its aspect ratio when only the width is constrained; scales to
 * the content box. Parsing is synchronous — no fonts needed until text.
 */
export class SvgNode extends Node {
  constructor(props, app) {
    super('svg', props, app);
    this.view = null;
    this._error = null;
    this._parse();
    this._configureMeasure();
  }

  _parse() {
    this.view = null;
    this._error = null;
    const source = this.props.source;
    if (!source) return;
    try {
      this.view = new SvgView(null).setSvg(String(source));
    } catch (err) {
      this._error = err;
      console.error('react-x11: <svg> failed to parse:', err.message);
    }
  }

  _configureMeasure() {
    if (this.props.width != null && this.props.height != null) {
      this.yoga.unsetMeasureFunc();
      return;
    }
    this.yoga.setMeasureFunc((width, widthMode) => {
      const natW = this.view?.naturalWidth ?? 0;
      const natH = this.view?.naturalHeight ?? 0;
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
    const before = oldProps ?? this.props;
    super.applyProps(newProps, oldProps);
    this._configureMeasure();
    if (newProps.source !== before.source) {
      this._parse();
      this.yoga.markDirty();
      this.root?.invalidate(true);
    }
  }

  _paintContent(ctx) {
    if (!this.view) return;
    const content = this.contentBox();
    if (content.width <= 0 || content.height <= 0) return;
    this.view.draw(ctx, content.x, content.y, content.width, content.height);
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

  _ensureBox() {
    const { source, size, color, displayMode, katex } = this.props;
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
    ctx.fillStyle = this.props.color ?? '#222222';
    box.draw(ctx, content.x, content.y);
  }
}
