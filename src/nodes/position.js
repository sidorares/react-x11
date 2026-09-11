// Positions (#534): a node laid out in flow and then moved by the scheme its
// `position` names — `sticky`, or one registered in layouts.js — against
// the scroll pane and the container it is measured from.

import { Yoga } from '../yoga.js';
import {
  positionOf,
  resolveOptions,
  unknownPositionMessage,
} from '../layouts.js';
import { reportLayoutError, reportStyleProblem } from '../errors.js';
import { now } from './animation.js';
import { FULL_DAMAGE, addDamageRect } from './damage.js';
import { offsetInParent } from './layout.js';
import { intersectRects } from './rects.js';
import { BLIT_POISONED } from './scrollblit.js';

/** Node's half of positions, installed onto `Node.prototype` by node.js. */
export class NodePosition {
  /**
   * The scroll pane a placement is measured against: the nearest ancestor
   * that scrolls — a `<box>` or a `<window>` with `overflow: 'scroll'`.
   * Only that. `'hidden'` clips without scrolling here, which is CSS's
   * `clip` rather than its `hidden`, so a card that rounds its corners does
   * not quietly capture the sticky header inside it — the CSS trap of a
   * sticky element that "does nothing". Null when nothing above scrolls.
   */
  _scrollPane() {
    for (let n = this.parent; n; n = n.parent) {
      if (n.isScroller?.()) return n;
      if (n.isWindow) return null;
    }
    return null;
  }

  /**
   * Where layout put this node before anything shifted it: the origin its
   * parent hands its children — scrolled, when the parent is a scroll pane
   * — plus yoga's offset. The same sum `absolutize` makes, asked again so
   * that nothing has to remember which shifts a rect already carries: the
   * scroll fast path moves a placed node along with its pane's content
   * (`_shiftAbs`), offset and all.
   */
  _laidOutAt() {
    const parent = this.parent;
    const origin = (parent.isScroller?.() && parent._childOrigin) || parent.abs;
    const offset = offsetInParent(this);
    return { x: origin.x + offset.x, y: origin.y + offset.y };
  }

  /**
   * The position this node's style places it with — `sticky` is the
   * built-in one — resolved: the definition, and its options with lengths in
   * device pixels. Null for none, and for one that cannot be had, which is
   * reported once and leaves the node where layout put it. Cached per style:
   * the pass asks every frame, and the style only moves through `_retarget`.
   */
  _placement() {
    const style = this.style;
    const cache = this._placementCache;
    if (cache !== null && cache.style === style) return cache.request;
    const found = positionOf(style);
    let request = null;
    if (found !== null) {
      if (!found.def) {
        reportStyleProblem(
          this,
          unknownPositionMessage(found.name),
          'It is laid out in flow, as relative is',
        );
      } else {
        const { options, problem } = resolveOptions(
          found.def.options,
          found.raw,
          this.scale,
          `<${this.kind} style={{ position: "${found.name}" }}>`,
        );
        if (problem) reportStyleProblem(this, problem, 'It takes its default');
        request = { name: found.name, def: found.def, options };
      }
    }
    // a placement that threw is not asked again until the style names
    // another one
    if (
      this._placementFailed !== null &&
      this._placementFailed !== request?.def
    ) {
      this._placementFailed = null;
    }
    this._placementCache = { style, request };
    return request;
  }

  /**
   * Move this node to where its placement puts it this frame — or, with no
   * request, back to where layout has it, which is what a node whose style
   * just stopped asking needs. The subtree rides along. Returns whether the
   * placement asked for another frame.
   *
   * Nothing remembers an offset. The scroll fast path (#405) moves a placed
   * node along with its pane's content, offset and all, so each pass
   * re-derives where layout put it (`_laidOutAt`) and moves it from wherever
   * it is now: a stored offset goes stale on exactly the frames that matter.
   */
  _place(request, t) {
    const at = this._laidOutAt();
    let dx = 0;
    let dy = 0;
    let again = false;
    if (request !== null && this._placementFailed !== request.def) {
      let result = null;
      try {
        result = request.def.place(
          this,
          this._placementContext(at, request.options, t),
        );
      } catch (error) {
        this._placementFailed = request.def;
        reportLayoutError(
          this,
          `position "${request.name}"`,
          error,
          'The node stays where layout put it until its style names another ' +
            'position',
        );
      }
      if (result) {
        // whole pixels, which is what keeps a pane's scroll blit a copy
        const x = Math.round(result.x ?? 0);
        const y = Math.round(result.y ?? 0);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          dx = x;
          dy = y;
          again = result.again === true;
        } else {
          reportStyleProblem(
            this,
            `react-x11: position "${request.name}" moved <${this.kind}> by ` +
              `{ x: ${result.x}, y: ${result.y} } — an offset is two finite ` +
              'numbers, in device pixels',
            'The node stays where layout put it',
          );
        }
      }
    }
    const mx = at.x + dx - this.abs.x;
    const my = at.y + dy - this.abs.y;
    if (mx !== 0 || my !== 0) {
      this._shiftAbs(mx, my);
      // every cached union above still counts this subtree where it was
      this._clearHitBounds();
    }
    return again;
  }

  /**
   * What a position's placement is handed (docs/extending.md, "A position
   * of your own"): where layout put the node, the scroll pane above it and the
   * box it has to stay inside — window coordinates, device pixels, the space
   * `abs` is in — so a placement that holds a node against an edge adds and
   * subtracts, and never converts.
   */
  _placementContext(at, options, t) {
    const own = this.yoga;
    const pane = this._scrollPane();
    let scrolled = null;
    if (pane) {
      const py = pane.yoga;
      const abs = pane.abs;
      scrolled = {
        // the band the content scrolls through: inside the border, over
        // the padding
        scrollport: {
          left: abs.x + py.getComputedBorder(Yoga.EDGE_LEFT),
          top: abs.y + py.getComputedBorder(Yoga.EDGE_TOP),
          right: abs.x + abs.width - py.getComputedBorder(Yoga.EDGE_RIGHT),
          bottom: abs.y + abs.height - py.getComputedBorder(Yoga.EDGE_BOTTOM),
        },
        scrollX: pane.scrollX,
        scrollY: pane.scrollY,
      };
    }
    return {
      laidOut: {
        x: at.x,
        y: at.y,
        width: this.abs.width,
        height: this.abs.height,
      },
      pane: scrolled,
      container: this._placementContainer(pane),
      margin: {
        left: own.getComputedMargin(Yoga.EDGE_LEFT),
        top: own.getComputedMargin(Yoga.EDGE_TOP),
        right: own.getComputedMargin(Yoga.EDGE_RIGHT),
        bottom: own.getComputedMargin(Yoga.EDGE_BOTTOM),
      },
      direction: this.direction,
      scale: this.scale,
      now: t,
      options,
    };
  }

  /**
   * The box a placed node is contained by: its parent's content box — or,
   * when the parent is the scroll pane itself, the content the pane scrolls:
   * at least the pane's own box, and as far as `measureScrollContent` found
   * the children reaching — so a header that is a direct child of the pane
   * sticks for the whole of its scroll. Window coordinates; the node's own
   * margins are the placement's to apply.
   */
  _placementContainer(pane) {
    const parent = this.parent;
    const py = parent.yoga;
    const inner = (edge) =>
      py.getComputedBorder(edge) + py.getComputedPadding(edge);
    if (parent === pane) {
      const origin = pane._childOrigin ?? pane.abs;
      const { width, height } = pane.abs;
      const padLeft = py.getComputedPadding(Yoga.EDGE_LEFT);
      const padRight = py.getComputedPadding(Yoga.EDGE_RIGHT);
      const bottom =
        Math.max(
          height - py.getComputedBorder(Yoga.EDGE_BOTTOM),
          pane.contentHeight,
        ) - py.getComputedPadding(Yoga.EDGE_BOTTOM);
      // `contentWidth` is measured from the edge the content starts at,
      // which is the right-hand one under RTL (measureScrollContent)
      const box =
        pane.direction === 'rtl'
          ? {
              left:
                origin.x +
                padLeft +
                Math.min(
                  py.getComputedBorder(Yoga.EDGE_LEFT),
                  width - pane.contentWidth,
                ),
              right: origin.x + width - inner(Yoga.EDGE_RIGHT),
            }
          : {
              left: origin.x + inner(Yoga.EDGE_LEFT),
              right:
                origin.x +
                Math.max(
                  width - py.getComputedBorder(Yoga.EDGE_RIGHT),
                  pane.contentWidth,
                ) -
                padRight,
            };
      box.top = origin.y + inner(Yoga.EDGE_TOP);
      box.bottom = origin.y + bottom;
      return box;
    }
    const abs = parent.abs;
    return {
      left: abs.x + inner(Yoga.EDGE_LEFT),
      top: abs.y + inner(Yoga.EDGE_TOP),
      right: abs.x + abs.width - inner(Yoga.EDGE_RIGHT),
      bottom: abs.y + abs.height - inner(Yoga.EDGE_BOTTOM),
    };
  }
}

/** WindowNode's half of positions, installed onto `WindowNode.prototype` by window/window.js. */
export class WindowPosition {
  /**
   * Place every node whose `position` is placed after layout — `sticky` is
   * the built-in one (docs/styling.md, "Custom positions"). Layout lays one
   * out in flow; this is the other half, run once the pass has placed
   * everything — including the pass a scroll runs, so a header lands in the
   * frame that scrolled rather than the one after it — and on a frame with
   * nothing to lay out when an animated placement asked for one
   * (`_placementsDue`).
   *
   * Ancestors first: a placed node inside another rides the outer one's
   * shift, and measures its own from where that left it.
   *
   * A shift here is a move nothing else claims — the layout diff has already
   * run, and the scroll fast path moves a pane's content without one — so it
   * claims its own pixels: where the node was shown and where it is going.
   * "Where it was shown" is the last placement's reach, moved along by the
   * blit if one is pending over it. A node that rode the scroll like its
   * neighbours lands exactly there and claims nothing, which is what keeps
   * a pane of headers on the blit path; a held one claims two header-sized
   * rects, written into the blitting pane's ledger and clipped to it the
   * way `_reflowed`'s claims are. They overlap by all but the scroll's
   * delta, and the ledger folds them into one entry (`_recordBlitClaim`),
   * with every held child's claims inside it. True when anything was
   * claimed.
   */
  _placeNodes() {
    this._placementsDue = false;
    const nodes = [];
    for (const node of this._placedNodes) {
      if (
        node.destroyed ||
        node.root !== this ||
        node.isWindow ||
        !node.yoga ||
        !node.parent
      ) {
        this._placedNodes.delete(node);
        node._placedShown = null;
        continue;
      }
      nodes.push(node);
    }
    if (nodes.length > 1) {
      const depth = new Map();
      for (const node of nodes) {
        let d = 0;
        for (let n = node.parent; n; n = n.parent) d++;
        depth.set(node, d);
      }
      nodes.sort((a, b) => depth.get(a) - depth.get(b));
    }
    const cap = this._damageRectCap();
    const t = now();
    let claimed = false;
    for (const node of nodes) {
      const request = node._placement();
      if (node._place(request, t)) this._placementsDue = true;
      // one that stopped asking is back where layout has it: let it go
      if (request === null) this._placedNodes.delete(node);
      const before = node._placedShown;
      const after =
        request !== null && !node.hidden && node.style.display !== 'none'
          ? node.paintBounds()
          : null;
      node._placedShown = after;
      if (this._damage === FULL_DAMAGE) continue;
      const sv = node._blitViewport();
      let was = before;
      if (was && sv) {
        const shift = sv._blitShift();
        was = { ...was, x: was.x + shift.x, y: was.y + shift.y };
      }
      if (
        was &&
        after &&
        was.x === after.x &&
        was.y === after.y &&
        was.width === after.width &&
        was.height === after.height
      ) {
        continue;
      }
      for (const rect of [was, after]) {
        if (!rect) continue;
        const claim = sv ? intersectRects(rect, sv.paintBounds()) : rect;
        if (!claim) continue;
        if (sv && !sv._recordBlitClaim(claim)) {
          sv._pendingBlitFrom = BLIT_POISONED;
        }
        this._damage = addDamageRect(this._damage, claim, cap);
        claimed = true;
      }
    }
    // an animated placement's next frame, on the window's clock — asked from
    // inside a flush, which answers it once this frame is over
    if (this._placementsDue) this._scheduleFrame();
    return claimed;
  }
}
