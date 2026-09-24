// The move blit (issue #681). A subtree that only moved — the same size,
// somewhere else, nothing inside it changed — is already painted, one shift
// away. Where something in it covers its box with opaque pixels, what was
// under it cannot show through, so its pixels are copied from where they
// were to where they went (`Window.scrollRegion`, the verb the scroll blit
// moves a viewport's band with), and the frame paints only what the copy
// cannot supply: what the move uncovered, the parts of the subtree the cover
// does not reach, and whatever is drawn over it. A card of widgets dragged
// across a pane is that frame, once a step.
//
// The layout pass finds the move (`_beginRigidMove`, nodes/layout.js) and
// hands it here instead of claiming it, and the frame settles it once every
// other claim is in (`_settleRigidMoves`, from flush). Every gate falls back
// to the two claims the move would have made — where its pixels were and
// where they went — so the fast path can cost correctness nothing: the worst
// mistake it can make is not firing.

import { cssColorStraight } from 'ntk/color';
import { EMPTY_STYLE, resolveBorderWidths } from '../styles.js';
import { isPaintedColor } from './boxpaint.js';
import { DAMAGE_SLOP, FULL_DAMAGE, addDamageRect } from './damage.js';
import { NodePaint } from './paint.js';
import {
  innerPixels,
  insetRect,
  intersectRects,
  isIntegerRect,
  outerPixels,
  outside,
  rectArea,
  rectContains,
  rectsOverlap,
  shiftRect,
  unionRect,
} from './rects.js';
import { scrollbarTrackRect } from './scrollbars.js';
import { debugPaint } from './window/debugpaint.js';

// Below this many pixels the copy is not worth its bookkeeping: the frame
// still repaints a strip along each side of it, a pass apiece, where a small
// box repainted whole is a pass or two.
const MOVE_BLIT_MIN_AREA = 32 * 32;

// Past this share of the copy, the frame would repaint most of the pixels it
// copied — around whatever else changed over the subtree — and the copy only
// adds to the bill. The `<glarea>` pane's copy stops at the same share
// (src/gloverlay.js).
const MOVE_BLIT_MAX_REPAINT = 0.75;

// The verb moves the band of the rect it is handed, and the window presents
// all of that rect: handed the box around both ends of a move, a jump across
// the window presents everything between them. Past this multiple of the
// copy, the two ends are repainted where they are instead.
const MOVE_BLIT_MAX_SPAN = 2;

// How many claims a frame logs with their nodes (`_logClaim`). A drag step
// makes a few — the element that draws the card a body sits on, a hover —
// and a frame past this is a commit the copy would not pay for anyway. Such
// a frame is judged from its damage list alone, every rect of it as if drawn
// over the subtree (`_claimsBySource`).
const CLAIM_LOG_MAX = 32;

// The scroll blit's escape hatch (nodes/scrollblit.js), read the same way:
// every path that moves retained pixels instead of repainting them is one
// variable away from the plain repaint (docs/debugging.md).
const NO_BLIT = process.env.REACT_X11_NO_SCROLL_BLIT === '1';

// Where a claim's node paints against the subtree being copied
// (`_claimSide`).
const BELOW = 0;
const INSIDE = 1;
const ABOVE = 2;

/** A colour nothing shows through. */
function isOpaqueColor(color) {
  if (!isPaintedColor(color)) return false;
  const rgba = cssColorStraight(color);
  return rgba !== null && rgba[3] >= 1;
}

/** The squares at the corners of a box that a radius gives up, on the
 * whole pixels they touch: where a rounded fill or clip is not opaque. */
function cornerSquares(box, radius) {
  const r = Math.min(radius, box.width / 2, box.height / 2);
  if (!(r > 0)) return [];
  const right = box.x + box.width - r;
  const bottom = box.y + box.height - r;
  return [
    { x: box.x, y: box.y, width: r, height: r },
    { x: right, y: box.y, width: r, height: r },
    { x: box.x, y: bottom, width: r, height: r },
    { x: right, y: bottom, width: r, height: r },
  ].map(outerPixels);
}

/**
 * The whole pixels a node that clips lets its children draw in: its box,
 * less its radius all round when it is rounded — the corner squares are
 * the pixels a rounded clip gives up — as `WindowNode._coverFor` has it.
 * Null when nothing is left.
 */
function clipBoxOf(node) {
  const radius = node.style?.borderRadius ?? 0;
  return innerPixels(radius > 0 ? insetRect(node.abs, radius) : node.abs);
}

/**
 * Whether what `node` draws over its children is all core's to know the
 * reach of: its border, its outline and its scrollbars. An element that
 * overrides `paint` draws after `super.paint` — over its children, where
 * only it knows.
 */
function drawsKnownOverChildren(node) {
  if (node.paint === NodePaint.prototype.paint) return true;
  let proto = Object.getPrototypeOf(node);
  while (proto && !Object.hasOwn(proto, 'paint')) {
    proto = Object.getPrototypeOf(proto);
  }
  // the Scrollable mixin's: `super.paint`, then the scrollbars
  return proto !== null && Object.hasOwn(proto, '_paintScrollbars');
}

function sameRects(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].x !== b[i].x ||
      a[i].y !== b[i].y ||
      a[i].width !== b[i].width ||
      a[i].height !== b[i].height
    ) {
      return false;
    }
  }
  return true;
}

/** Node's half of the move blit, installed onto `Node.prototype` by node.js. */
export class NodeMoveBlit {
  /**
   * Where this subtree covers its box with opaque pixels on every paint, as
   * `{ rect, holes }` — window coordinates, whole pixels — or null when it
   * promises nothing. `rect` is the box, and `holes` the squares in it that
   * a radius gives up, where what is under the box shows through its
   * antialiased corners. Everywhere else in `rect` whatever was painted
   * before the subtree is hidden, which is what makes a copy of its pixels
   * exact there (`WindowNode._blitRigidMove`).
   *
   * Three things cover: a background colour nothing shows through; an
   * element's own promise (`opaqueRect()`); and, for a node that makes
   * neither, its one drawn child's cover, cut to the box when it clips — the
   * wrappers a card is positioned and scaled by. A node with several
   * children answers null rather than the biggest of them: this is asked on
   * every step of a drag, and a walk of the subtree is the cost the copy
   * exists to save.
   *
   * Nothing in a group composited at an alpha below one is opaque, so an
   * `opacity` on the way down answers null; so does a node on a layer of its
   * own, whose pixels are not the bitmap's (src/cocoa/promotion.js).
   */
  _opaqueCover() {
    let clip = null;
    const holes = [];
    for (let node = this; ;) {
      if (node.hidden || node._promoted) return null;
      const style = node.style ?? EMPTY_STYLE;
      if (style.display === 'none') return null;
      if (style.opacity !== undefined && !(style.opacity >= 1)) return null;
      const radius = style.borderRadius ?? 0;
      let own = null;
      if (isOpaqueColor(style.backgroundColor)) {
        own = node.abs;
        holes.push(...cornerSquares(node.abs, radius));
      } else {
        own = node.opaqueRect();
      }
      if (own) {
        const cut = clip ? intersectRects(own, clip) : own;
        const rect = cut && innerPixels(cut);
        if (!rect) return null;
        return {
          rect,
          holes: holes
            .map((hole) => intersectRects(hole, rect))
            .filter(Boolean),
        };
      }
      if (node.clipsChildren()) {
        // a rounded clip gives up its corners the way a rounded fill does
        const box = innerPixels(node.abs);
        clip = box && (clip ? intersectRects(clip, box) : box);
        if (!clip) return null;
        holes.push(...cornerSquares(node.abs, radius));
      }
      const order = node.paintOrder();
      if (order.length !== 1) return null;
      node = order[0];
    }
  }

  /**
   * The box this subtree's pixels are all inside, on whole pixels, with
   * nothing to spare — or null when that cannot be promised, and the damage
   * model's reach, a pixel of slop all round, is what has to be claimed.
   *
   * A claim is grown by a pixel because a fractional edge and a glyph's
   * antialiasing put ink just outside a box. A box on whole pixels with no
   * shadow and no outline inks nothing outside itself, and neither do its
   * children when it clips them or none comes within a pixel of its edge.
   * For a copy that pixel is not free: around a card it is four strips a
   * pixel wide, a paint pass apiece, where the copy's own frame is the
   * strip the move uncovered.
   */
  _inkBox() {
    const box = this.abs;
    if (!isIntegerRect(box)) return null;
    if (this._outlineExtent() > 0 || this._shadowExtent() > 0) return null;
    if (!this.clipsChildren() && !inksWithin(this, box)) return null;
    return box;
  }
}

/**
 * Whether everything `node`'s children draw stays inside `box`, whole
 * pixels. A child's reach (`_subtreeBounds`, its shadow and outline in it)
 * has to be inside the box; one that comes within a pixel of its edge has
 * to be a box on whole pixels, whose fills and borders end where it does —
 * text puts antialiased ink a pixel past its glyphs — and so, unless it
 * clips them, do its own children: the wrapper a card's content is laid out
 * in fills the card to its edge and draws nothing there.
 */
function inksWithin(node, box) {
  const inner = insetRect(box, DAMAGE_SLOP);
  for (const child of node.children) {
    if (child.isWindow || !child.yoga || child.hidden) continue;
    if (child.style?.display === 'none') continue;
    const reach = child._subtreeBounds();
    if (!rectContains(box, reach)) return false;
    if (rectContains(inner, reach)) continue;
    if (child.kind !== 'box' || !isIntegerRect(child.abs)) return false;
    if (!child.clipsChildren() && !inksWithin(child, box)) return false;
  }
  return true;
}

/** WindowNode's half of the move blit, installed onto `WindowNode.prototype` by window/window.js. */
export class WindowMoveBlit {
  /**
   * One rect this frame's list took (`invalidate`, `_claimLayoutMove`,
   * `_placeNodes`), and the node whose claim it was: what tells a copy of a
   * subtree a claim under it, which the copy covers, from one over it,
   * which it has to repaint (`_claimSide`). A frame past `CLAIM_LOG_MAX`
   * claims stops keeping them, and `_takeDamage` starts the next frame's.
   */
  _logClaim(rect, source) {
    const log = this._claimLog;
    if (log === null) return;
    if (log.length >= CLAIM_LOG_MAX) {
      this._claimLog = null;
      return;
    }
    log.push({
      // a caller's rect can be a live one — a `contentBox()`, a pan's region
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      source,
    });
  }

  /**
   * Whether the move of `node` by `shift` could be copied rather than
   * repainted, as far as the layout pass can tell before it walks the
   * subtree (`_beginRigidMove`). A frame still bounded, with no scroll blit
   * armed — two copies in one frame would each carry pixels the other made
   * stale, which is why a scroll blit declines a frame the layout moved —
   * and nothing drawn over the whole window that a copy would drag along. A
   * whole-pixel shift, and a backing the window can move pixels in. And a
   * subtree whose pixels are the window's to move: not inside a `<glarea>`,
   * whose panes hold them (src/gloverlay.js), nor holding one with panes;
   * not on a layer of its own or inside one; not inside a group faded
   * through a surface of its own. Everything that needs the frame's other
   * claims waits for the pass to end (`_settleRigidMoves`).
   */
  _mayBlitMove(node, shift) {
    if (NO_BLIT || this._damage === FULL_DAMAGE) return false;
    if (this._pendingScrolls?.size) return false;
    if (!Number.isInteger(shift.x) || !Number.isInteger(shift.y)) return false;
    if (typeof this.window?.scrollRegion !== 'function') return false;
    if (
      debugPaint ||
      process.env.REACT_X11_DEBUG_LAYOUT ||
      this._highlight ||
      this._traceUpdates
    ) {
      return false;
    }
    if (node._promoted) return false;
    for (let n = node.parent; n && n !== this; n = n.parent) {
      if (n.isGlArea || n._promoted) return false;
      const opacity = n.style?.opacity;
      if (opacity !== undefined && !(opacity >= 1)) return false;
    }
    for (const area of this._overlaid) {
      for (let n = area; n && n !== this; n = n.parent) {
        if (n === node) return false;
      }
    }
    return true;
  }

  /** A move `_mayBlitMove` let through, queued for `_settleRigidMoves`. */
  _deferRigidMove(node, was, shift) {
    (this._rigidMoves ??= []).push({ node, was, shift });
  }

  /**
   * The moves this frame's layout pass queued, once every other claim of
   * the frame is in. The one whose copy is biggest is copied where that is
   * safe and pays (`_blitRigidMove`); every other one, and that one when
   * not, is claimed as the pass would have claimed it. True when the
   * window's list took one of those claims — a frame that is not a pure
   * scroll (`_applyScrollBlits`).
   */
  _settleRigidMoves(moves, width, height) {
    let best = null;
    let most = 0;
    // a scroll armed while the pass ran is the one copy the frame gets
    if (Array.isArray(this._damage) && !this._pendingScrolls?.size) {
      for (const move of moves) {
        const region = this._moveBlitRegion(move, width, height);
        const size = region ? rectArea(region.dest) : 0;
        if (size > most) {
          best = { move, region };
          most = size;
        }
      }
    }
    let took = false;
    // the others first: the copy has to account for what they claim
    for (const move of moves) {
      if (move !== best?.move && this._claimMove(move)) took = true;
    }
    if (best && !this._blitRigidMove(best.move, best.region)) {
      if (this._claimMove(best.move)) took = true;
    }
    return took;
  }

  /**
   * A move claimed the plain way, as `Node._claimRigidMove` claims one no
   * copy is waiting on: where the subtree's pixels were and where they went,
   * each cut to what its clipping ancestors let reach the surface.
   */
  _claimMove({ node, was, shift }) {
    const cap = this._damageRectCap();
    let took = false;
    for (const end of [was, shiftRect(was, shift.x, shift.y)]) {
      const clipped = node._clippedByAncestors(end);
      if (clipped && this._claimLayoutMove(clipped, node, cap)) took = true;
    }
    return took;
  }

  /**
   * Where a move's copy would go, or null when there is none to make.
   * `dest` is the part of the subtree's opaque cover (`_opaqueCover`) that
   * its clipping ancestors let through where it is and, moved back, where
   * it was; `src` is `dest` moved back. A clip cuts a whole pixel whole only
   * on a whole pixel and away from a rounded corner, so each clip is taken
   * that way (`clipBoxOf`), and the window's edge is one more.
   *
   * A box with nothing drawn inside it is left to its repaint: that is one
   * fill, where the copy is a CopyArea and a strip on each side.
   */
  _moveBlitRegion({ node, shift }, width, height) {
    if (node.destroyed || node.root !== this || node.hidden) return null;
    if (node.kind === 'box' && node.paintOrder().length === 0) return null;
    const cover = node._opaqueCover();
    if (!cover) return null;
    let clip = { x: 0, y: 0, width, height };
    for (let n = node.parent; n && n !== this && clip; n = n.parent) {
      if (!n.clipsChildren()) continue;
      const box = clipBoxOf(n);
      clip = box && intersectRects(clip, box);
    }
    if (!clip) return null;
    const here = intersectRects(cover.rect, clip);
    const dest =
      here && intersectRects(here, shiftRect(clip, shift.x, shift.y));
    if (!dest || rectArea(dest) < MOVE_BLIT_MIN_AREA) return null;
    const src = shiftRect(dest, -shift.x, -shift.y);
    if (rectArea(unionRect(src, dest)) > rectArea(dest) * MOVE_BLIT_MAX_SPAN) {
      return null;
    }
    const holes = [];
    for (const hole of cover.holes) {
      const inside = intersectRects(hole, dest);
      if (inside) holes.push(inside);
    }
    return { dest, src, holes };
  }

  /**
   * Copy a moved subtree's pixels where they went, and narrow what the
   * frame owes the move to what the copy cannot supply. True when it did;
   * false leaves the frame's damage as it was, for `_claimMove`.
   *
   * The copy is of what the subtree showed where it covers, moved as far as
   * it moved (`dest`). Nothing under it shows through there, so the copy is
   * right wherever its own drawing is all that is there — and the frame
   * repaints the rest:
   *
   * - what the move uncovered, and the parts of the subtree the copy did
   *   not land on — its rounded corners, a shadow, a child reaching out of
   *   it: where its pixels were and where they went, less `dest`;
   * - what is drawn over it: inside `dest` where it is, and where the copy
   *   carried what it covered (`_drawnOverMove`);
   * - the frame's other claims, by whose they are (`_claimSide`). One from
   *   under the subtree is repainted outside `dest` alone, since nothing of
   *   it shows inside: the element that draws the card a mounted body sits
   *   on claims the box the card moved through, and most of that box is the
   *   body's. One from inside the subtree is repainted where it stands and
   *   moved with the copy, which covers it whichever side of the layout
   *   pass it was named on. One from over it, or from anywhere the log
   *   cannot say, is repainted where it stands and where the copy carried
   *   what it covered.
   *
   * Past `MOVE_BLIT_MAX_REPAINT` of `dest` those repaint most of what the
   * copy saves, and the plain claims have the frame.
   */
  _blitRigidMove({ node, was, shift }, { src, dest, holes }) {
    const dx = shift.x;
    const dy = shift.y;
    const target = this._blitTarget(node);
    if (target?.top !== this) return false;
    const over = this._drawnOverMove(node, src, dest, dx, dy);
    if (!over) return false;
    // each ancestor of the subtree, with its child on the way down to it
    const chain = new Map();
    for (let n = node.parent, child = node; n; child = n, n = n.parent) {
      chain.set(n, child);
      if (n === this) break;
    }
    // Assembled uncapped: a cap merge would pick two pieces either side of
    // the copy and put it back. Pieces cut around the same `dest` nest —
    // bands above and below it full width, pieces beside it its rows only —
    // so what overlaps coalesces without reaching into it.
    let rects = [];
    const add = (rect) => {
      if (rect) rects = addDamageRect(rects, rect, Infinity);
    };
    for (const { rect, source } of this._claimsBySource()) {
      const side = this._claimSide(source, node, chain);
      if (side === BELOW) {
        for (const piece of outside(rect, dest)) add(piece);
      } else if (side === INSIDE) {
        add(rect);
        add(shiftRect(rect, dx, dy));
      } else {
        add(rect);
        add(intersectRects(shiftRect(rect, dx, dy), dest));
      }
    }
    // where the subtree's pixels were and where they went: its box when it
    // inks nothing outside it, which leaves the strips the move uncovered
    const ink = node._inkBox();
    const ends = ink
      ? [shiftRect(ink, -dx, -dy), ink]
      : [was, shiftRect(was, dx, dy)];
    for (const end of ends) {
      const clipped = node._clippedByAncestors(end);
      if (!clipped) continue;
      for (const piece of outside(clipped, dest)) add(piece);
    }
    for (const rect of over) add(rect);
    // …and where the copy is not opaque: a rounded corner shows what was
    // under it where it was, and has to show what is under it here
    for (const hole of holes) add(hole);
    // Each rect is a paint pass, and the frame's cap on them is the window's
    // price for one (`_damageRectCap`). Past it the cap merges pieces either
    // side of the copy into the box around them, and that box reaches into
    // the copied content and repaints the widgets along its edge — on X11,
    // four passes, a rounded card's four corners and the strip it uncovered
    // cost more requests and more bytes than the card they spare. The plain
    // claims have that frame.
    if (rects.length > this._damageRectCap()) return false;
    // the list is disjoint, so the sum is the area it covers
    let repainted = 0;
    for (const rect of rects) {
      const inside = intersectRects(rect, dest);
      if (inside) repainted += rectArea(inside);
    }
    if (repainted > rectArea(dest) * MOVE_BLIT_MAX_REPAINT) return false;
    // the verb moves the band that survives inside the rect it is handed,
    // so handed where the pixels are and where they go, that band is `dest`
    if (!target.blit(unionRect(src, dest), dx, dy)) return false;
    this._damage = rects;
    // what the list holds now is no longer the claims it was built from
    this._claimLog = null;
    return true;
  }

  /**
   * This frame's claims, each with the node that made it: the log, when it
   * holds exactly what the list does. Replayed through the same merge it has
   * to come out as the list itself — anything else means a writer of the
   * list that did not log, and a log that says nothing reliable. Otherwise
   * the list's own rects with no node, which `_claimSide` reads as drawn
   * over the subtree.
   */
  _claimsBySource() {
    const log = this._claimLog;
    const damage = this._damage;
    if (log !== null) {
      const cap = this._damageRectCap();
      let replay = [];
      for (const { rect } of log) replay = addDamageRect(replay, rect, cap);
      if (sameRects(replay, damage)) return log;
    }
    return damage.map((rect) => ({ rect, source: null }));
  }

  /**
   * Where a claim's node paints against the subtree being copied — inside
   * it, under it or over it — found at the nearest ancestor the two share,
   * by which of its children on the way down comes first in its paint
   * order. An ancestor's own claim is over: its border, its outline and its
   * scrollbars are drawn after its children. So is a claim with no node,
   * the window's, or one whose node has left the tree.
   */
  _claimSide(source, node, chain) {
    if (
      !source ||
      source === this ||
      source.destroyed ||
      source.root !== this
    ) {
      return ABOVE;
    }
    for (let n = source, branch = null; n; branch = n, n = n.parent) {
      if (n === node) return INSIDE;
      const mine = chain.get(n);
      if (mine === undefined) continue;
      if (branch === null) return ABOVE;
      const order = n.paintOrder();
      const at = order.indexOf(mine);
      const theirs = order.indexOf(branch);
      return at !== -1 && theirs !== -1 && theirs < at ? BELOW : ABOVE;
    }
    return ABOVE;
  }

  /**
   * What is drawn over a moved subtree, as the rects inside `dest` a copy
   * leaves wrong: where each thing is, and where the copy carried what it
   * covered of `src`. The later siblings in paint order — the subtree's,
   * and each ancestor's up to the window — and each ancestor's own drawing
   * over its children: the border, drawn inside its box and over them, as
   * far in as a rounded one bends; the outline, outside the box, which a
   * child reaches only past an ancestor that does not clip; the scrollbars.
   *
   * Null when an ancestor draws anything else over its children — an
   * element that overrides `paint` — whose reach nothing here knows.
   */
  _drawnOverMove(node, src, dest, dx, dy) {
    const out = [];
    const reach = unionRect(src, dest);
    const over = (rect) => {
      if (!rect || !rectsOverlap(rect, reach)) return;
      const box = outerPixels(rect);
      const here = intersectRects(box, dest);
      if (here) out.push(here);
      const carried = intersectRects(shiftRect(box, dx, dy), dest);
      if (carried) out.push(carried);
    };
    for (let n = node.parent, child = node; n; child = n, n = n.parent) {
      if (n !== this) {
        if (!drawsKnownOverChildren(n)) return null;
        const style = n.style ?? EMPTY_STYLE;
        const bw = resolveBorderWidths(style, n.direction);
        const ring = Math.max(bw.top, bw.right, bw.bottom, bw.left);
        if (ring > 0) {
          const inner = insetRect(
            n.abs,
            Math.max(ring, style.borderRadius ?? 0) + DAMAGE_SLOP,
          );
          const outer = insetRect(n.abs, -DAMAGE_SLOP);
          for (const piece of outside(outer, inner)) over(piece);
        }
        const outline = n._outlineExtent();
        if (outline > 0 && !n.clipsChildren()) {
          const around = insetRect(n.abs, -(outline + DAMAGE_SLOP));
          for (const piece of outside(around, n.abs)) over(piece);
        }
      }
      if (typeof n._scrollbars === 'function') {
        for (const bar of n._scrollbars()) {
          over(insetRect(scrollbarTrackRect(bar), -DAMAGE_SLOP));
        }
      }
      const order = n.paintOrder();
      const at = order.indexOf(child);
      for (let i = at === -1 ? 0 : at + 1; i < order.length; i++) {
        // on a layer of its own: nothing of it is in the bitmap
        if (!order[i]._promoted) over(order[i].paintBounds());
      }
      if (n === this) break;
    }
    return out;
  }
}
