// Layout hosts (#534): a box whose `layout` names an algorithm registered
// in layouts.js arranges its children itself. Each child is a yoga root of
// its own, and the host is a measured leaf in its parent — so what the
// algorithm decides is on screen in the frame that asked.
// docs/architecture/custom-layout.md is the design record.

import {
  createLayoutNode,
  isMeasuringExactly,
  measuringExactly,
} from '../styles.js';
import { Yoga } from '../yoga.js';
import {
  checkLayoutResult,
  layoutOf,
  resolveOptions,
  unknownLayoutMessage,
} from '../layouts.js';
import { reportLayoutError, reportStyleProblem } from '../errors.js';
import { MEASURE_MODES, measureOffer } from './layout.js';
import { shallowEqual, NO_CHILDREN } from './util.js';
import {
  captureLeafHeights,
  declaresOwnMinimum,
  inFlow,
  setMeasuringShrink,
  restoreShrink,
  freezeWidths,
  restoreWidths,
  contentSpan,
  writeFloorsWithin,
  forgetHeightFloors,
} from './window/floors.js';

/**
 * A child, as a layout algorithm sees it (docs/extending.md, "A layout
 * algorithm of your own"): something to measure at a size and read options
 * off, never a node to reach into. Everything it answers is in device pixels
 * and in the child's **margin box** — a margin is part of the room a child
 * takes — so an algorithm that stacks children is right about margins
 * without knowing they exist.
 *
 * One per child, kept on the node: an algorithm is asked several times per
 * pass, and a fresh object per question per child is garbage nobody needs.
 */
class LayoutChild {
  #node;

  constructor(node) {
    this.#node = node;
    /** Where this child is in the list the algorithm was handed. */
    this.index = 0;
  }

  /** The child's `layoutItem`, against the options the layout declared —
   *  defaults filled in, lengths in device pixels. */
  get options() {
    return this.#node._layoutItemOptions();
  }

  /** The child's own resolved style, read-only and in device pixels — what
   *  a grid places it by (`gridColumn`, `gridArea`) and aligns it with
   *  (`alignSelf`, `justifySelf`). */
  get style() {
    return this.#node.style;
  }

  /**
   * The margin-box size this child takes under `constraints` — `{ width,
   * height, widthMode, heightMode }`, the vocabulary `measureContent`
   * speaks. An axis given a number and no mode is `'exactly'` that; an axis
   * left out is `'unconstrained'`; `'at-most'` is CSS's fit-content — what
   * the child would like, clamped into the offer, and never below what it
   * cannot be narrower than.
   */
  measure(constraints) {
    return this.#node._measureInHost(constraints ?? NO_CONSTRAINTS);
  }

  /** `{ minContentWidth, maxContentWidth }`: the narrowest this child can
   *  be drawn at, and the width it would take with no bound at all — both
   *  margin boxes. The minimum is the content floor the renderer measures
   *  for every box (docs/elements.md), so a paragraph's is its longest
   *  word. */
  intrinsicSizes() {
    return this.#node._intrinsicInHost();
  }
}

const NO_CONSTRAINTS = Object.freeze({});

const NO_OPTIONS = Object.freeze({});

const MEASURE_MODE_NAMES = new Set(['exactly', 'at-most', 'unconstrained']);

/** Yoga's spelling of a resolved direction, for a tree laid out as a root —
 *  a layout host's child inherits its direction through this argument, the
 *  way a window's tree inherits the window's. */
const yogaDirection = (node) =>
  node.direction === 'rtl' ? Yoga.DIRECTION_RTL : Yoga.DIRECTION_LTR;

/**
 * Lay out one of a layout host's children as the root it is. Dirt on the
 * root means something inside it changed — content, a style, a floor
 * written — since the sizes remembered for it were taken, and they go
 * (`Node._hostSizesNow`). Every layout of such a root comes through here or
 * through that, which is what makes the dirt a reliable sign: nothing else
 * clears it.
 */
function layoutHostChild(child, width, height, dir) {
  const yoga = child.yoga;
  if (yoga.isDirty()) child._hostSizes = null;
  child._hostLaidAt = null;
  yoga.calculateLayout(width, height, dir);
}

/** A remembered size, with a bound on how many: an algorithm asks a child a
 *  handful of questions a pass, not a new one each run. */
function remember(sizes, key, size) {
  if (sizes.size >= 32) sizes.clear();
  sizes.set(key, size);
}

const marginBoxWidth = (yoga) =>
  yoga.getComputedWidth() +
  yoga.getComputedMargin(Yoga.EDGE_LEFT) +
  yoga.getComputedMargin(Yoga.EDGE_RIGHT);

const marginBoxHeight = (yoga) =>
  yoga.getComputedHeight() +
  yoga.getComputedMargin(Yoga.EDGE_TOP) +
  yoga.getComputedMargin(Yoga.EDGE_BOTTOM);

/** Up to a whole pixel, with a thousandth of slack for a sum that should
 *  have been whole: a measure that answers a fraction is one yoga divides
 *  a rounding residue by (issue #411). */
const wholePixels = (v) => Math.ceil(v - 1e-3);

/**
 * The elements that cannot arrange children with a layout, because they
 * have none to arrange: they measure their own content, or are content.
 * A registered element that implements `measureContent` is the same case,
 * asked of the instance.
 */
const NO_LAYOUT_KINDS = new Set([
  'text',
  'textchunk',
  'image',
  'svg',
  'canvas',
  'textinput',
  'textarea',
  'glarea',
  'foreign',
]);

/** Node's half of layout hosts, installed onto `Node.prototype` by node.js. */
export class NodeLayoutHost {
  // --- a layout host (docs/styling.md, "Custom layouts") -----------------
  //
  // A node whose style names a `layout` hands its children to that
  // algorithm. In yoga's terms it becomes a measured leaf — its size is
  // what the algorithm answers for the room on offer — and each child
  // becomes a yoga tree of its own, laid out where and how big the
  // algorithm says. Both happen inside the pass that lays the window out,
  // so the arrangement is on screen in the frame that asked for it.

  /**
   * Hand this node's children to the layout its style names, or take them
   * back. Run from the style funnel whenever `layout` could have moved; a
   * value that is the same layout with the same options costs a compare.
   */
  _syncLayoutHost() {
    const found = layoutOf(this.style);
    let def = null;
    let options = null;
    if (found !== null) {
      const refused = found.conflict ? null : this._layoutRefusal();
      if (found.conflict) {
        reportStyleProblem(
          this,
          found.conflict,
          'It is laid out as flexbox until the two agree',
        );
      } else if (refused !== null) {
        reportStyleProblem(
          this,
          `react-x11: <${this.kind}> cannot ${
            found.name === 'grid'
              ? 'lay its children out as a grid'
              : 'take a layout'
          } — ${refused}`,
          'It lays out as it would without one',
        );
      } else if (!found.def) {
        reportStyleProblem(
          this,
          unknownLayoutMessage(found.name),
          'It is laid out as flexbox instead',
        );
      } else {
        const abandoned = this._layoutAbandoned;
        if (
          abandoned === null ||
          abandoned.def !== found.def ||
          !shallowEqual(abandoned.raw, found.raw)
        ) {
          this._layoutAbandoned = null;
          const resolved = resolveOptions(
            found.def.options,
            found.raw,
            this.scale,
            `<${this.kind} style={{ layout: "${found.name}" }}>`,
          );
          if (resolved.problem) {
            // the one layout whose options live in the style instead
            const grid = found.def.builtin && found.name === 'grid';
            reportStyleProblem(
              this,
              grid
                ? "react-x11: layout: { name: 'grid' } takes no options — a " +
                    "grid's tracks are the box's own style: gridTemplateColumns, " +
                    'gridTemplateRows, gridTemplateAreas, gridAutoFlow'
                : resolved.problem,
              grid ? 'They are ignored' : 'It takes its default',
            );
          }
          def = found.def;
          options = resolved.options;
        }
        // …else it is the layout that threw, and stays flexbox until the
        // style names another (`WindowNode._abandonFailedHosts`)
      }
    }
    const host = this._host;
    if (def === null) {
      if (host !== null) this._leaveHost();
      return;
    }
    if (host === null) {
      this._enterHost(found.name, def, options);
      return;
    }
    if (
      host.def !== def ||
      host.scale !== this.scale ||
      !shallowEqual(host.options, options)
    ) {
      host.def = def;
      host.name = found.name;
      host.options = options;
      host.scale = this.scale;
      host.failed = null;
      this._hostChanged();
    }
  }

  /** Why this node cannot arrange children with a layout, or null when it
   *  can — the sentence the report finishes with. */
  _layoutRefusal() {
    if (!this.yoga) return 'it takes no part in layout';
    if (this.isWindow) {
      return `put the layout on a <box> inside the <${this.kind}>`;
    }
    if (
      NO_LAYOUT_KINDS.has(this.kind) ||
      typeof this.measureContent === 'function' ||
      (this._measureFn && this._host === null)
    ) {
      return 'it measures its own content, so it has no children to arrange';
    }
    if (this.isScroller?.()) {
      return (
        'a scroll pane lays out its viewport; put the layout on a <box> ' +
        'inside the pane, which is what it scrolls'
      );
    }
    return null;
  }

  _enterHost(name, def, options) {
    const yoga = this.yoga;
    this._host = {
      name,
      def,
      options,
      scale: this.scale,
      // Set whenever the algorithm was asked a hypothetical — which lays the
      // children out at sizes nothing is drawn at — so the placement after
      // the pass knows it has to put them back.
      measured: true,
      // the content box, and direction, the last placement was made for
      size: null,
      // the children the last call was handed, in order, beside the
      // handles it was handed them as
      flow: NO_CHILDREN,
      handles: NO_CHILDREN,
      // a yoga node standing in for the padding box, holding the absolutely
      // positioned children — which yoga then places by its own rules
      absolute: null,
      // the error the algorithm threw, until the pass that saw it is over
      failed: null,
    };
    // The children leave the flex tree first: a node that measures may have
    // no yoga children, and yoga aborts rather than refuse.
    for (const child of this.children) {
      if (!child.yoga || child.isWindow) continue;
      yoga.removeChild(child.yoga);
      this._adoptHostChild(child);
    }
    this._setMeasureFunc((w, wm, h, hm) => this._measureHost(w, wm, h, hm));
    this.root?._layoutHosts.add(this);
    this._hostChanged();
  }

  _leaveHost() {
    const host = this._host;
    this._host = null;
    this.yoga.unsetMeasureFunc();
    this._measureFn = null;
    let index = 0;
    for (const child of this.children) {
      if (!child.yoga || child.isWindow) continue;
      if (child._hostAbsolute) {
        host.absolute.removeChild(child.yoga);
        child._hostAbsolute = false;
      }
      child._hostSlot = null;
      this.yoga.insertChild(child.yoga, index++);
    }
    host.absolute?.free();
    this.root?._layoutHosts.delete(this);
    this.root?._failedHosts.delete(this);
    this._hostChanged();
  }

  /** A child joins the layout: its yoga tree is a root of its own now. Its
   *  dirt stops there, so the window looks for it before every pass
   *  (`WindowNode._sweepLayoutHosts`) and makes it this node's. */
  _adoptHostChild(child) {
    const cy = child.yoga;
    // A floor written while it was a flex item means nothing to a layout,
    // which sizes the child itself — and would outlast it as a minimum.
    if (child._floorMinW != null) {
      cy.setMinWidth(child.style.minWidth);
      child._floorMinW = undefined;
    }
    if (child._floorMinH != null) {
      cy.setMinHeight(child.style.minHeight);
      child._floorMinH = undefined;
    }
    child._hostSlot = null;
    child._hostSizes = null;
    child._hostSqueezed = false;
    child._hostLaidAt = null;
    if (child.style.position === 'absolute') {
      const holder = this._hostHolder();
      holder.insertChild(cy, holder.getChildCount());
      child._hostAbsolute = true;
    }
  }

  /** The yoga node the absolutely positioned children are laid out in. */
  _hostHolder() {
    return (this._host.absolute ??= createLayoutNode());
  }

  /** A layout host is going: its children's trees are roots of their own,
   *  which the `freeRecursive` that takes this node's box does not reach.
   *  Run after the children's own `destroySubtree`, so a child that was a
   *  host itself has let go of its children already. */
  _freeHostTrees() {
    const host = this._host;
    for (const child of this.children) {
      const cy = child.yoga;
      if (!cy || child.isWindow) continue;
      if (child._hostAbsolute) {
        host.absolute.removeChild(cy);
        child._hostAbsolute = false;
      }
      cy.freeRecursive();
      child.yoga = null;
    }
    host.absolute?.free();
    host.absolute = null;
    this.root?._layoutHosts?.delete(this);
    this.root?._failedHosts?.delete(this);
  }

  /** A child moved in or out of `position: 'absolute'`: in flow the
   *  algorithm places it, out of it yoga does, against the padding box. */
  _rehomeHostChild(child) {
    const cy = child.yoga;
    if (!cy || this._host === null) return;
    const absolute = child.style.position === 'absolute';
    if (absolute && !child._hostAbsolute) {
      const holder = this._hostHolder();
      holder.insertChild(cy, holder.getChildCount());
      child._hostAbsolute = true;
    } else if (!absolute && child._hostAbsolute) {
      this._host.absolute.removeChild(cy);
      child._hostAbsolute = false;
    }
    child._hostSlot = null;
    this._hostChanged();
  }

  /** Something the algorithm reads moved: ask it again next pass. */
  _hostChanged() {
    this._markHostDirty();
    this._invalidateLayout('layout');
    const root = this.root;
    if (root) {
      // a layout arriving, leaving or re-asked is a change to the tree the
      // content floors were measured from, as any style change is
      root._floorsDirty = true;
      root._floorsContentDirty = true;
    }
  }

  _markHostDirty() {
    if (this._host !== null && this.yoga && !this.destroyed) {
      this.yoga.markDirty();
    }
  }

  /**
   * Yoga's measure function for a layout host: the algorithm's answer for
   * the room on offer, in the content box. Asked several times per pass —
   * the content floors ask for the smallest the box can be, a flex line for
   * its basis — and each asking lays the children out at that size, so
   * `measured` records that the placement after the pass owes them their
   * real one.
   */
  _measureHost(width, widthMode, height, heightMode) {
    const host = this._host;
    if (host === null) return { width: 0, height: 0 };
    if (heightMode === Yoga.MEASURE_MODE_UNDEFINED) {
      this._floorMeasureMode = MEASURE_MODES[widthMode];
    }
    host.measured = true;
    const result = this._runLayout(
      {
        width: measureOffer(width, widthMode),
        height: measureOffer(height, heightMode),
        widthMode: MEASURE_MODES[widthMode],
        heightMode: MEASURE_MODES[heightMode],
      },
      false,
    );
    return result === null
      ? { width: 0, height: 0 }
      : {
          width: wholePixels(result.width),
          height: wholePixels(result.height),
        };
  }

  /**
   * One call to the algorithm, over the children in flow. A throw, or an
   * answer that is not a size, is reported and turns the layout off for
   * this node: this pass gets an empty box, and the window lays it out as
   * flexbox before the frame is done (`WindowNode._abandonFailedHosts`).
   */
  _runLayout(constraints, final) {
    const host = this._host;
    if (host.failed !== null) return null;
    const flow = [];
    const handles = [];
    for (const child of this.children) {
      if (!child.yoga || child.isWindow || child.hidden) continue;
      const style = child.style;
      if (style.display === 'none' || style.position === 'absolute') continue;
      const handle = (child._handle ??= new LayoutChild(child));
      handle.index = flow.length;
      flow.push(child);
      handles.push(handle);
    }
    host.flow = flow;
    host.handles = handles;
    try {
      return checkLayoutResult(
        host.def.layout(handles, constraints, host.options, {
          style: this.style,
          scale: this.scale,
          // a mistake the algorithm can lay out around — a grid area nobody
          // named — said once, the way a bad style value is
          report: (message, consequence) =>
            reportStyleProblem(this, message, consequence),
        }),
        handles.length,
        final,
        host.name,
      );
    } catch (error) {
      host.failed = error;
      this.root?._failedHosts.add(this);
      reportLayoutError(
        this,
        `layout "${host.name}"`,
        error,
        'It is laid out as flexbox until its style names another layout',
      );
      return null;
    }
  }

  /**
   * Place the children where the algorithm says, in the box the pass gave
   * this node — the final call, with both modes `'exactly'`. Each child's
   * yoga tree is laid out at the size its rect names (an axis the rect
   * leaves out is the child's own), and what `absolutize` reads is the
   * slot: the margin box's corner, from this node's border box, mirrored
   * for a right-to-left box so that an algorithm is written once, from the
   * left, and reads correctly both ways.
   *
   * Skipped when nothing has asked the algorithm anything since the last
   * placement and the box is the size it was: the children are still laid
   * out exactly as that placement left them.
   */
  _placeHostChildren(floors) {
    const host = this._host;
    if (host === null || this.destroyed || this.hidden) return false;
    if (this.style.display === 'none') return false;
    const yoga = this.yoga;
    const width = yoga.getComputedWidth();
    const height = yoga.getComputedHeight();
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
    const bl = yoga.getComputedBorder(Yoga.EDGE_LEFT);
    const bt = yoga.getComputedBorder(Yoga.EDGE_TOP);
    const br = yoga.getComputedBorder(Yoga.EDGE_RIGHT);
    const bb = yoga.getComputedBorder(Yoga.EDGE_BOTTOM);
    const left = bl + yoga.getComputedPadding(Yoga.EDGE_LEFT);
    const top = bt + yoga.getComputedPadding(Yoga.EDGE_TOP);
    const cw = Math.max(
      0,
      width - left - br - yoga.getComputedPadding(Yoga.EDGE_RIGHT),
    );
    const ch = Math.max(
      0,
      height - top - bb - yoga.getComputedPadding(Yoga.EDGE_BOTTOM),
    );
    const rtl = this.direction === 'rtl';
    const last = host.size;
    if (
      !host.measured &&
      last !== null &&
      last.width === cw &&
      last.height === ch &&
      last.rtl === rtl
    ) {
      return false;
    }
    const result = this._runLayout(
      { width: cw, height: ch, widthMode: 'exactly', heightMode: 'exactly' },
      true,
    );
    host.measured = false;
    host.size = { width: cw, height: ch, rtl };
    if (result === null) return false;
    const dir = rtl ? Yoga.DIRECTION_RTL : Yoga.DIRECTION_LTR;
    const flow = host.flow;
    const rects = result.children;
    let measuredHeights = false;
    for (let i = 0; i < flow.length; i++) {
      const child = flow[i];
      const r = rects[i];
      // A child that can come out shorter than its content has rows that can
      // be squeezed, which need their floors at the width it gets: one that
      // names a height of its own, or one its rect gives less height than
      // its content takes at that width — asked before it is laid out at
      // the rect, since asking lays it out at its natural height. A
      // stretched row of items sized to fit it, and a masonry's cards,
      // never are.
      const squeezed =
        floors &&
        (typeof child.style.height === 'number' ||
          typeof child.style.maxHeight === 'number' ||
          (r.height != null &&
            (child._hostSqueezed ||
              r.height <
                child._measureInHost(
                  r.width == null ? NO_CONSTRAINTS : { width: r.width },
                ).height -
                  0.5)));
      // A tree already laid out at this rect, with nothing inside it changed,
      // is left as it is. Yoga would do the same from its own cache but for
      // the floors pass, which measures off the pixel grid and so voids every
      // cached layout in the window — and each child here is a window-sized
      // layout's worth of calls to find out nothing moved.
      const at = child._hostLaidAt;
      if (
        at === null ||
        at.width !== r.width ||
        at.height !== r.height ||
        at.dir !== dir ||
        child.yoga.isDirty()
      ) {
        layoutHostChild(
          child,
          r.width ?? undefined,
          r.height ?? undefined,
          dir,
        );
      }
      if (
        squeezed &&
        (child._floorH === undefined ||
          child._floorAtW === undefined ||
          Math.abs(child._floorAtW - child.yoga.getComputedWidth()) >= 1)
      ) {
        this._measureHostChildHeights(child, r, dir);
        child._hostSqueezed = true;
        measuredHeights = true;
      }
      child._hostLaidAt = { width: r.width, height: r.height, dir };
      const x = rtl ? cw - r.x - (r.width ?? marginBoxWidth(child.yoga)) : r.x;
      // whole pixels: the child's own tree was rounded from its corner, so
      // a fractional corner would put every edge in it between two pixels
      const slot = { x: left + Math.round(x), y: top + Math.round(r.y) };
      const was = child._hostSlot;
      if (was === null || was.x !== slot.x || was.y !== slot.y) {
        child._hostSlot = slot;
      }
    }
    // The absolutely positioned children, by yoga's own rules against the
    // padding box — which is what the holder stands in for.
    const holder = host.absolute;
    if (holder !== null && holder.getChildCount() > 0) {
      const pw = Math.max(0, width - bl - br);
      const ph = Math.max(0, height - bt - bb);
      holder.setWidth(pw);
      holder.setHeight(ph);
      holder.calculateLayout(pw, ph, dir);
      for (const child of this.children) {
        if (child._hostAbsolute) child._hostSlot = { x: bl, y: bt };
      }
    }
    return measuredHeights;
  }

  /**
   * The height floors inside one of this host's children, at the width the
   * placement just gave it — a minimum height is always a height for a
   * width (`WindowNode._applyContentFloors`), and a child's width is the
   * algorithm's. Measured the way the window measures its own, off the
   * pixel grid: the tree at its width with no bound on its height, the
   * leaves' heights taken, the widths held and the collapse read back
   * (`contentSpan`). Then the floors inside it are written, and it is laid
   * out again at its rect.
   */
  _measureHostChildHeights(child, r, dir) {
    const root = this.root;
    if (!root) return;
    const cy = child.yoga;
    const stale = root._floorsStale;
    const width = r.width ?? marginBoxWidth(cy);
    // at a new width every height inside it is a question again
    if (child._floorH !== undefined) forgetHeightFloors(child, stale);
    measuringExactly(() => {
      // what it holds now comes off first: a floor read back as content
      // could only ever grow
      writeFloorsWithin(child, 'height', stale);
      layoutHostChild(child, width, undefined, dir);
      const intrinsic = new Map();
      captureLeafHeights(child, intrinsic);
      const frozen = [];
      freezeWidths(child, frozen);
      const shrunk = [];
      setMeasuringShrink(child, 'height', shrunk);
      layoutHostChild(child, width, 0, dir);
      const span = contentSpan(child, 'height', intrinsic, root);
      restoreWidths(frozen);
      restoreShrink(shrunk);
      child._floorH = declaresOwnMinimum(child, 'height')
        ? cy.getComputedHeight()
        : span;
      root._floorsMeasured += 1;
      stale.add(child);
      writeFloorsWithin(child, 'height', stale);
    });
    layoutHostChild(child, r.width ?? undefined, r.height ?? undefined, dir);
    child._floorAtW = cy.getComputedWidth();
  }

  /** `absolutize`'s walk, for a layout host: each child from the slot its
   *  placement gave it. One the algorithm was not handed — hidden — sits at
   *  the content box's corner, where nothing is drawn of it. */
  _absolutizeHostChildren() {
    const { x, y } = this.abs;
    const yoga = this.yoga;
    const cx =
      yoga.getComputedBorder(Yoga.EDGE_LEFT) +
      yoga.getComputedPadding(Yoga.EDGE_LEFT);
    const cy =
      yoga.getComputedBorder(Yoga.EDGE_TOP) +
      yoga.getComputedPadding(Yoga.EDGE_TOP);
    for (const child of this.children) {
      if (child.isWindow) continue;
      const slot = child._hostSlot;
      child.absolutize(
        x + (slot === null ? cx : slot.x),
        y + (slot === null ? cy : slot.y),
      );
    }
  }

  // --- …and a child of one, as its algorithm measures it ---------------

  /** `LayoutChild.measure`, on the child's own yoga tree. */
  _measureInHost(c) {
    const host = this.parent;
    const yoga = this.yoga;
    const dir = yogaDirection(host);
    const widthMode =
      c.widthMode ??
      (c.width == null || c.width === Infinity ? 'unconstrained' : 'exactly');
    const heightMode =
      c.heightMode ??
      (c.height == null || c.height === Infinity ? 'unconstrained' : 'exactly');
    if (
      !MEASURE_MODE_NAMES.has(widthMode) ||
      !MEASURE_MODE_NAMES.has(heightMode)
    ) {
      throw new TypeError(
        `measure() was asked for modes ${JSON.stringify(widthMode)} / ` +
          `${JSON.stringify(heightMode)} — a mode is 'exactly', 'at-most' ` +
          "or 'unconstrained'",
      );
    }
    const sizes = this._hostSizesNow();
    const key = `${dir}|${widthMode}|${c.width}|${heightMode}|${c.height}`;
    let size = sizes.get(key);
    if (size === undefined) {
      this._hostLaidAt = null;
      let w = widthMode === 'unconstrained' ? undefined : c.width;
      let h = heightMode === 'unconstrained' ? undefined : c.height;
      if (widthMode === 'at-most') {
        // CSS's fit-content: what it would like, if that fits — and never
        // narrower than what it cannot be narrower than
        const { minContentWidth, maxContentWidth } = this._intrinsicInHost();
        w =
          maxContentWidth <= c.width
            ? undefined
            : Math.max(c.width, minContentWidth);
      }
      if (heightMode === 'at-most') {
        yoga.calculateLayout(w, undefined, dir);
        h = marginBoxHeight(yoga) <= c.height ? undefined : c.height;
      }
      yoga.calculateLayout(w, h, dir);
      size = { width: marginBoxWidth(yoga), height: marginBoxHeight(yoga) };
      remember(sizes, key, size);
    }
    return { width: size.width, height: size.height };
  }

  /** `LayoutChild.intrinsicSizes`. The maximum is a layout with no bound;
   *  the minimum is the content floor measured for this child, and until
   *  one has been, the maximum — nothing is squeezed on a guess. */
  _intrinsicInHost() {
    const dir = yogaDirection(this.parent);
    const sizes = this._hostSizesNow();
    let widest = sizes.get(dir);
    if (widest === undefined) {
      const yoga = this.yoga;
      this._hostLaidAt = null;
      yoga.calculateLayout(undefined, undefined, dir);
      widest = {
        max: marginBoxWidth(yoga),
        margins:
          yoga.getComputedMargin(Yoga.EDGE_LEFT) +
          yoga.getComputedMargin(Yoga.EDGE_RIGHT),
      };
      remember(sizes, dir, widest);
    }
    const { max, margins } = widest;
    const min =
      this._floorW === undefined ? max : Math.min(max, this._floorW + margins);
    return { minContentWidth: min, maxContentWidth: max };
  }

  /** The sizes remembered for this child of a layout host: kept while
   *  nothing inside it changes, which dirt on its root would say
   *  (`layoutHostChild`), and apart for each side of the pixel grid, since
   *  the same layout measured off it comes to a different size. */
  _hostSizesNow() {
    let memo = this._hostSizes;
    if (memo === null || this.yoga.isDirty()) {
      memo = this._hostSizes = { onGrid: new Map(), exact: new Map() };
    }
    return isMeasuringExactly() ? memo.exact : memo.onGrid;
  }

  /** This child's `layoutItem`, against the options its layout declared. */
  _layoutItemOptions() {
    const host = this.parent?._host;
    if (!host) return NO_OPTIONS;
    const raw = this.style.layoutItem ?? null;
    const cache = this._itemCache;
    if (
      cache !== null &&
      cache.raw === raw &&
      cache.def === host.def &&
      cache.scale === this.scale
    ) {
      return cache.options;
    }
    const { options, problem } = resolveOptions(
      host.def.childOptions,
      raw,
      this.scale,
      `<${this.kind} style={{ layoutItem }}> under layout "${host.name}"`,
    );
    if (problem) reportStyleProblem(this, problem, 'It takes its default');
    this._itemCache = { raw, def: host.def, scale: this.scale, options };
    return options;
  }
}

/** WindowNode's half of layout hosts, installed onto `WindowNode.prototype` by window/window.js. */
export class WindowLayoutHost {
  // --- layout hosts (docs/styling.md, "Custom layouts") -----------------

  /**
   * Mark every layout host whose children changed as dirty, before a pass —
   * since nothing else would. A host's children are yoga trees of their own,
   * so their dirt stops at their own roots and never reaches the host's box.
   * (Yoga's dirtied callback is no substitute: it fires only on the way from
   * clean to dirty, and a child never laid out — hidden since it mounted — is
   * dirty already and would never say so.) Deepest first, so a host inside
   * another's child dirties that child's tree before the outer host looks.
   */
  _sweepLayoutHosts() {
    if (this._layoutHosts.size === 0) return;
    for (const host of this._hostsInOrder(true)) {
      for (const child of host.children) {
        if (!child.yoga || child.isWindow || child.hidden) continue;
        if (child.style.display === 'none') continue;
        if (child.yoga.isDirty()) {
          host._markHostDirty();
          break;
        }
      }
    }
  }

  /** This window's layout hosts, each before the hosts inside its children —
   *  or after them, `deepestFirst`. */
  _hostsInOrder(deepestFirst) {
    const hosts = [];
    for (const host of this._layoutHosts) {
      if (host.destroyed || host.root !== this || host._host == null) {
        this._layoutHosts.delete(host);
        continue;
      }
      hosts.push(host);
    }
    if (hosts.length > 1) {
      const depth = new Map();
      for (const host of hosts) {
        let d = 0;
        for (let n = host.parent; n; n = n.parent) if (n._host != null) d++;
        depth.set(host, d);
      }
      hosts.sort((a, b) =>
        deepestFirst
          ? depth.get(b) - depth.get(a)
          : depth.get(a) - depth.get(b),
      );
    }
    return hosts;
  }

  /**
   * The content floors inside every layout host's children, tree by tree. A
   * card a masonry lays out is a yoga tree of its own, and the window's own
   * measuring pass stops at the host, which answers for itself as a leaf —
   * so without this the rows inside the card would get no floor and squeeze
   * to nothing. Each stale child is measured the way the window measures its
   * tree: no room on offer, the shrink borrowed (`setMeasuringShrink`), the
   * span read back into the extents of everything stale inside it
   * (`contentSpan`), which `_writeFloors` then writes with the rest. The
   * child's own extent is its min-content width, which is what its host
   * reads of it (`LayoutChild.intrinsicSizes`).
   *
   * Deepest hosts first, so a host inside a card has its own children's
   * extents in hand when the card's pass asks it for its minimum.
   */
  _measureHostChildWidths() {
    for (const host of this._hostsInOrder(true)) {
      if (host.hidden || host.style.display === 'none') continue;
      const dir = yogaDirection(host);
      for (const child of host.children) {
        if (!inFlow(child) || child.hidden || child._floorW !== undefined) {
          continue;
        }
        const cy = child.yoga;
        const shrunk = [];
        setMeasuringShrink(child, 'width', shrunk);
        layoutHostChild(child, 0, undefined, dir);
        const span = contentSpan(child, 'width', null, this);
        child._floorW = declaresOwnMinimum(child, 'width')
          ? cy.getComputedWidth()
          : span;
        restoreShrink(shrunk);
        this._floorsMeasured += 1;
        // the floors inside it are written from what this found…
        this._floorsStale.add(child);
        // …and it was laid out with no room, which the placement undoes
        host._host.measured = true;
      }
    }
  }

  /** Every layout host's final call, parents first: placing a host lays its
   *  children's trees out, which is where the hosts inside them are
   *  measured — and they place after. True when a host measured height
   *  floors inside its children, which is a pass off the pixel grid. */
  _placeLayoutHosts(floors) {
    let measuredHeights = false;
    for (const host of this._hostsInOrder(false)) {
      if (host._placeHostChildren(floors)) measuredHeights = true;
    }
    return measuredHeights;
  }

  /**
   * The layouts that threw this pass, turned off: each host goes back to
   * being a flex box, and stays one until its style names a different
   * layout. True when there were any — the caller lays out again, so the
   * frame the throw happened in is already the flexbox one.
   */
  _abandonFailedHosts() {
    if (this._failedHosts.size === 0) return false;
    for (const host of [...this._failedHosts]) {
      if (host.destroyed || host._host === null) continue;
      host._layoutAbandoned = {
        def: host._host.def,
        raw: layoutOf(host.style)?.raw ?? null,
      };
      host._leaveHost();
    }
    this._failedHosts.clear();
    this._floorsDirty = true;
    this._floorsContentDirty = true;
    return true;
  }
}
