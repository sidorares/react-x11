// `<svg>`: a retained-node wrapper over ntk's SvgView. The document is
// either JSX children — declarative SVG elements, one `SvgChildNode` each,
// serialized into the htmlparser2-style DOM SvgView consumes — or a `source`
// markup string, and it is sized like `<image>` from its viewBox.
//
// This file used to hold `<markdown>`, `<html>` and `<tex>` beside it, over
// ntk's document widgets. Those widgets rendered a document as one opaque
// drawing, which foreclosed both selection and per-block streaming; their
// successors are components in `@react-x11/components` (`<Markdown>`,
// `<Formula>`), composed from public host elements. `<svg>` stays here
// because it is not a document — it is a drawing, and one node is the right
// grain for it.
import SvgView from 'ntk/svg';

import { Node } from './nodes/node.js';
import { intrinsicSize } from './nodes/layout.js';
import { isLayoutProp, isPaintProp } from './styles.js';

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
    // React's, not the drawing's. Since React 19 a ref arrives as an
    // ordinary prop, and an object one — `useRef()` — was written into the
    // document as `ref="[object Object]"`. `key` would be the same if React
    // ever passed it on.
    if (key === 'ref' || key === 'key') continue;
    if (skip && skip(key)) continue;
    attribs[toSvgAttrib(key)] = String(value);
  }
  return attribs;
}

/** Whether two `svgAttribs` results say the same thing. Order aside: the
 * document reads an attribute by its name. */
function sameAttribs(a, b) {
  const names = Object.keys(a);
  if (names.length !== Object.keys(b).length) return false;
  for (const name of names) {
    if (a[name] !== b[name]) return false;
  }
  return true;
}

// Props of the `<svg>` element that are react-x11's rather than the
// drawing's: `source`, the other form of the content, and what lays the
// element out, styles it and takes its input. `style` is one of them, an
// object that reached the document as "[object Object]".
const notAnAttribute = (key) =>
  key === 'source' ||
  key === 'style' ||
  isLayoutProp(key) ||
  isPaintProp(key) ||
  key === 'cursor' ||
  key === 'focusable' ||
  key === 'pointerEvents';

/**
 * An element inside <svg>: no yoga node, no painting of its own — it only
 * carries a tag name and props, and is serialized into the htmlparser2-style
 * DOM that SvgView consumes. A change that reaches that DOM — an attribute
 * that serializes differently, a child added or removed — bubbles to the
 * owning SvgNode via the _textContentChanged channel (also used by text
 * chunks, so string children of an SVG <text> invalidate the same way).
 */
export class SvgChildNode extends Node {
  constructor(tag, props, app) {
    super(tag, props, app, { yoga: false });
    this.isSvgChild = true;
    /** What this element writes into the document: serialized once per
     * change rather than once per rebuild, and what a commit is compared
     * against. */
    this._attribs = svgAttribs(props);
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
    // React commits every child of an `<svg>` it re-renders, each with a new
    // props object and almost always with every attribute as it was — and a
    // rebuild re-parses the whole drawing and re-measures the `<svg>`. So
    // only a commit that serializes differently is a change.
    const attribs = svgAttribs(newProps);
    if (sameAttribs(attribs, this._attribs)) return;
    this._attribs = attribs;
    this._textContentChanged();
  }

  /**
   * Nothing this node draws, whatever changed: the `<svg>` paints the whole
   * document, and a change to it claims that element's box on the way
   * (`SvgNode._textContentChanged`). This node has no box — its rect is an
   * empty one at the window's origin — so core's answer, a claim of that
   * rect whenever a prop is a new value, repainted a corner nothing here
   * drew, on every commit that handed over an attribute rebuilt equal: a
   * `points` or `strokeDasharray` array, say.
   */
  paintChanged() {
    return false;
  }

  toDom() {
    return {
      type: 'tag',
      name: this.kind,
      attribs: this._attribs,
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
    /** This element's own attributes in children form, kept like a child's
     * for the same comparison. */
    this._attribs = svgAttribs(props, notAnAttribute);
    /** Bumped every time the document is rebuilt, and sampled at paint time,
     * so `paintCachePlan` can tell an animated document from a settled one.
     * See the note there. */
    this._docRevision = 0;
    this._paintedRevision = -1;
  }

  /** The viewBox is the natural size; `<image>`'s rules do the rest —
   * including the unit: natural sizes are logical pixels, multiplied to
   * device here so an unsized drawing keeps its size relative to
   * everything else. Unlike a bitmap it costs nothing: the document
   * rasterizes at whatever box layout settles on (src/scale.js). */
  measureContent(constraints) {
    const view = this._ensureView();
    const s = this.scale;
    return intrinsicSize(
      {
        width: (view?.naturalWidth ?? 0) * s,
        height: (view?.naturalHeight ?? 0) * s,
      },
      constraints,
    );
  }

  /** Any change to the document — `source`, an attribute, a child, a text
   * chunk — lands here, and only such a change: a commit that serializes
   * the same never calls it, so it rebuilds nothing and claims nothing. */
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
        const dom = {
          type: 'tag',
          name: 'svg',
          attribs: this._attribs,
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
    const source = this.props.source;
    super.applyProps(newProps, oldProps);
    // The document is `source`, or this element's attributes over its
    // children's, whose changes arrive on their own. A commit that leaves
    // both as they were — most of them: a parent re-rendering, a new style
    // object, a new ref — has nothing to re-parse or re-measure. The style
    // is core's to diff, like any element's.
    const attribs = svgAttribs(newProps, notAnAttribute);
    if (newProps.source === source && sameAttribs(attribs, this._attribs)) {
      return;
    }
    this._attribs = attribs;
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

  paintCached(ctx, box, ink = '#ffffff') {
    const view = this._ensureView();
    if (!view) return;
    // Into a coverage surface, only the alpha of a paint survives, and the
    // tint arrives at blit time — so any opaque colour renders the same
    // mask, and the cache says white then, or the tint where it bakes colour.
    view.draw(ctx, box.x, box.y, box.width, box.height, {
      color: view.paintKind === 'mono' ? ink : this._currentColor(),
    });
  }
}
