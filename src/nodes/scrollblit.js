// The scroll blit (issues #138, #398, #533). A pure-scroll frame does not
// repaint the viewport: the band that stays visible is already in the
// window's backing pixmap, one CopyArea from its new position, so the frame
// repaints only the strip the scroll exposed and the scrollbars. Here are the
// gates that decide when that is safe and worth it, the ledger a scroll
// container keeps while its blit is armed, and WindowNode's half, which
// applies the blits at flush. Every failure falls back to repainting the
// viewport, so the fast path can cost correctness nothing.

import { EMPTY_STYLE, resolveBorderWidths } from '../styles.js';
import { DAMAGE_SLOP, addDamageRect } from './damage.js';
import {
  rectContains,
  isIntegerRect,
  insetRect,
  innerPixels,
  intersectRects,
  unionRect,
  rectArea,
  cornerSquaresOverlap,
  rectsOverlap,
} from './rects.js';
import { scrollbarTrackRect } from './scrollbars.js';
import { debugPaint } from './window/debugpaint.js';

// --- scroll blitting (issue #138) ---------------------------------------
//
// A pure-scroll frame does not have to repaint the viewport: the band that
// stays visible is already in ntk's backing pixmap, one CopyArea away from
// its new position (ntk >= 4.3, Window.scrollRegion). The frame then only
// repaints the strip the scroll exposed, plus the scrollbar tracks. The
// gates below decide when that is safe *and* worth it; every failure falls
// back to today's full-viewport repaint, so the fast path can cost
// correctness nothing — the worst mistake it can make is not firing.

// Below this viewport area a repaint is one cheap pass and the blit's
// bookkeeping (a safety walk over the tree, extra damage rects, an extra
// request) costs more than it saves.
const SCROLL_BLIT_MIN_AREA = 48 * 1024;

// Escape hatch, read once like the other switches: for measuring the blit
// against the plain path on the same build, and as first aid if a scroll
// ever misrenders in the field. `=== '1'` like REACT_X11_NO_PAINT_CACHE —
// a truthy check would read NO_SCROLL_BLIT=0 as "disable the blit", and a
// stale export like that is exactly the kind of thing a cross-machine
// performance comparison trips over.
const NO_SCROLL_BLIT = process.env.REACT_X11_NO_SCROLL_BLIT === '1';

// If less than this fraction of the viewport survives the shift, the
// exposed strip is most of a repaint anyway.
const SCROLL_BLIT_MIN_KEEP = 0.5;

// …and how much of it the frame may end up repainting anyway. The strip and
// the scrollbar repair sit under this by a wide margin; what can push past
// it is a ledger repair (issue #398) that the damage cap had to merge with
// the scrollbar column, whose box then reaches back across the viewport.
// Past this the blit is buying a shift and paying for the viewport anyway.
const SCROLL_BLIT_MAX_REPAINT = 0.75;

// A scroll that must not blit this frame: content inside the viewport
// already changed (see the arming check in scrollTo, and the claim-time
// cancel in WindowNode.invalidate — react-x11#295). Truthy on purpose, so
// scrollTo's `??=` cannot re-arm over it, and reset by _applyScrollBlits'
// up-front clear like any real origin, so it lives exactly one frame.
export const BLIT_POISONED = Object.freeze({ poisoned: true });

// A frame armed by `Node.scrollContents` rather than by a scroll offset
// (issue #303): there is no origin to record, because the element handed
// over the shift itself. Truthy for the same reason as the poison — so the
// `??=` in both arming paths reads "already armed" — with the rect and the
// net delta in `_pendingBlitContents` beside it.
const BLIT_CONTENTS = Object.freeze({ contents: true });

// How much of what changed inside a blitting viewport the ledger will carry
// before the frame gives up and repaints the viewport instead (issue #398).
// A virtualized list's scroll frame changes a handful of regions — the two
// spacers and the entering rows — and past that the blit plus a scatter of
// repaints stops being cheaper than the one pass it replaced. The area is
// what the regions add to the strip the frame repaints anyway, a pixel two
// of them share counted once.
const BLIT_MAX_CLAIMS = 8;
const BLIT_MAX_CLAIM_AREA = 0.25;

/**
 * The band a scrollbar's thumb travels in, as the line along the track's
 * inner edge and the viewport edge beyond it: `bottom` for a horizontal
 * bar, `right` for a vertical one, `left` for the vertical bar of an RTL
 * viewport. A whole pixel, just outside the track's slop, so the parts a
 * rect is cut into still meet on a pixel boundary once they are snapped.
 */
function scrollbarBand(bar, vp) {
  const track = scrollbarTrackRect(bar);
  if (bar.axis === 'x') {
    return track.y + track.height / 2 > vp.y + vp.height / 2
      ? { edge: 'bottom', at: Math.floor(track.y) }
      : { edge: 'top', at: Math.ceil(track.y + track.height) };
  }
  return track.x + track.width / 2 > vp.x + vp.width / 2
    ? { edge: 'right', at: Math.floor(track.x) }
    : { edge: 'left', at: Math.ceil(track.x + track.width) };
}

/**
 * Rects sharing a whole edge joined into the one rect they make, until no
 * two do. Exact — a join is the union of the two, so the list stays
 * disjoint — and it only saves a pass: a rect cut at a band's line whose
 * parts met nothing on either side comes back whole.
 */
function joinAlongEdges(rects) {
  const out = [...rects];
  for (let joined = true; joined;) {
    joined = false;
    for (let i = 0; i < out.length && !joined; i++) {
      for (let j = i + 1; j < out.length && !joined; j++) {
        const a = out[i];
        const b = out[j];
        let union = null;
        if (
          a.x === b.x &&
          a.width === b.width &&
          (a.y + a.height === b.y || b.y + b.height === a.y)
        ) {
          const y = Math.min(a.y, b.y);
          union = { x: a.x, y, width: a.width, height: a.height + b.height };
        } else if (
          a.y === b.y &&
          a.height === b.height &&
          (a.x + a.width === b.x || b.x + b.width === a.x)
        ) {
          const x = Math.min(a.x, b.x);
          union = { x, y: a.y, width: a.width + b.width, height: a.height };
        }
        if (!union) continue;
        out.splice(j, 1);
        out[i] = union;
        joined = true;
      }
    }
  }
  return out;
}

/** `rect` cut along a band's line: the part on the band's side of it and
 * the rest, either of them null where the line misses the rect. */
function splitAtBand(rect, band) {
  const vertical = band.edge === 'left' || band.edge === 'right';
  const start = vertical ? rect.x : rect.y;
  const end = start + (vertical ? rect.width : rect.height);
  const at = Math.min(Math.max(band.at, start), end);
  const piece = (from, to) => {
    if (to <= from) return null;
    return vertical
      ? { x: from, y: rect.y, width: to - from, height: rect.height }
      : { x: rect.x, y: from, width: rect.width, height: to - from };
  };
  const before = piece(start, at);
  const after = piece(at, end);
  return band.edge === 'right' || band.edge === 'bottom'
    ? { inside: after, outside: before }
    : { inside: before, outside: after };
}

/**
 * The area a list of rects covers, a pixel under several of them counted
 * once. Exact, column by column: between each pair of neighbouring x
 * edges, the rects spanning that column merge their y extents. Asked about
 * a handful of rects at a time.
 */
function unionArea(rects) {
  const xs = rects.flatMap((r) => [r.x, r.x + r.width]).sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < xs.length; i++) {
    const left = xs[i - 1];
    const right = xs[i];
    if (right <= left) continue;
    const spans = rects
      .filter((r) => r.x <= left && r.x + r.width >= right)
      .sort((a, b) => a.y - b.y);
    let covered = 0;
    let reach = -Infinity;
    for (const r of spans) {
      const from = Math.max(r.y, reach);
      const to = r.y + r.height;
      if (to > from) covered += to - from;
      reach = Math.max(reach, to);
    }
    total += covered * (right - left);
  }
  return total;
}

/** Do two overlapping rects cover exactly the box around them — one inside
 * the other, or the two spanning the same extent along one axis? */
function unionIsBox(a, b) {
  return (
    rectContains(a, b) ||
    rectContains(b, a) ||
    (a.x === b.x && a.width === b.width) ||
    (a.y === b.y && a.height === b.height)
  );
}

/** Node's half of the scroll blit, installed onto `Node.prototype` by node.js. */
export class NodeScrollBlit {
  /**
   * Is this node a scroll container that has a blit armed and still clean
   * this frame (issue #398)?
   *
   * While it is, the window keeps a *ledger* of the regions that actually
   * changed inside the viewport instead of cancelling the blit at the first
   * sign of one. The coarse claims this node would otherwise make — its own
   * box, which is all `paintBounds()` can say for a node that clips — would
   * cover the whole band the blit is about to move and throw that ledger
   * away, so the paths that make them take a finer route while this is true.
   *
   * `scrollContents` is out: an element blit already tests foreign claims
   * against the rect it handed over (issue #309), and its region is not a
   * viewport whose children *are* the scrolled content.
   */
  _blitLedgerOpen() {
    const from = this._pendingBlitFrom;
    return (
      from != null &&
      from !== BLIT_POISONED &&
      !this._pendingBlitContents &&
      this._blitLedger != null
    );
  }

  /**
   * Write one changed region into this viewport's ledger, in the coordinates
   * it was named in. Returns false when the frame is better off repainting
   * the viewport — too many regions to be worth the bookkeeping, or one big
   * enough that there is nothing left for the blit to keep — which the
   * caller turns into the poison the gate used to apply unconditionally.
   *
   * Which side of the frame's layout pass the rect came from decides
   * whether it moves with the blit: a claim made during the commit names
   * where the content sits *now*, and the blit is about to shift it, so
   * `_applyScrollBlits` shifts the rect too. A claim raised once layout has
   * run — the diff's, the reflow queue's — already names where it landed.
   * Read off the window rather than passed in, so a claim from application
   * code reached during the layout pass is filed on the right side of it.
   *
   * A region the ledger already holds is not another one. A claim that
   * overlaps an entry and covers exactly the box around the two of them is
   * folded into it: the same pixels, one entry. A held sticky node claims
   * one rect twice — where it was, and where it is a delta along — and
   * every sticky node held inside it claims inside those, so kept apart, a
   * pane holding a few of them ran out of entries on regions it had already
   * counted. Only between claims on the same side of the layout pass: the
   * blit moves one kind and not the other.
   */
  _recordBlitClaim(rect) {
    const ledger = this._blitLedger;
    if (!ledger) return false;
    const inside = intersectRects(rect, this.abs);
    // beside the band the blit moves: those pixels are painted the ordinary
    // way, out of the frame's own damage
    if (!inside) return true;
    const pre = !this.root?._laidOut;
    let claim = { ...inside, pre };
    for (let i = ledger.length - 1; i >= 0; i--) {
      const entry = ledger[i];
      if (entry.pre !== pre || !rectsOverlap(entry, claim)) continue;
      if (!unionIsBox(entry, claim)) continue;
      claim = { ...unionRect(entry, claim), pre };
      ledger.splice(i, 1);
      // grown, it can fold an entry already passed over
      i = ledger.length;
    }
    // …and a claim that covers the viewport leaves the blit nothing to keep
    if (rectContains(claim, this.abs)) return false;
    if (ledger.length >= BLIT_MAX_CLAIMS) return false;
    ledger.push(claim);
    return true;
  }

  /**
   * How far the blit this viewport has pending moves the pixels it keeps:
   * the delta `_applyScrollBlits` hands `scrollRegion`, from the offsets
   * captured when the blit was armed to the ones in force now. `from` is
   * that origin, for a caller that has already taken it off the node.
   *
   * It is the content's own move, and along x that is not always against
   * the offset. `scrollX` is a distance from the start edge, which is the
   * right-hand one under `direction: 'rtl'`, so there `_absolutizeChildren`
   * carries the children right as it grows — and the band the blit keeps,
   * the strip it exposes, the thumb it drags along and the claims in the
   * ledger all go the way the children went.
   */
  _blitShift(from = this._pendingBlitFrom) {
    const dx = this.scrollX - from.x;
    // 0 - x rather than -x: negating +0 yields -0, which survives into
    // request buffers and test comparisons
    return {
      x: this.direction === 'rtl' ? 0 + dx : 0 - dx,
      y: 0 - (this.scrollY - from.y),
    };
  }

  /**
   * "The pixels in `rect` moved by (dx, dy); the rest of it is new" — the
   * public form of the dance `<box overflow="scroll">` has been doing since
   * issue #138, for an element with a viewport of its own (issue #303).
   *
   * A pan is a scroll in every way but the bookkeeping: it translates every
   * pixel of the pane, so an element that can only say "everything changed"
   * repaints the lot, sixty times a second, for a frame whose content is
   * already on screen one shift away. This claims `rect` — the conservative
   * answer, and the one that stands if anything below declines — and arms
   * the frame to blit instead: at frame time core asks ntk to move the
   * surviving band inside the backing store (`Window.scrollRegion`) and
   * **narrows this claim to the band the shift exposed**, which is what
   * `paintDamage()` then hands the paint. So the element draws the strip and
   * nothing else, without ever asking whether the blit happened.
   *
   * `dx`/`dy` are **how far the pixels moved**, the sense `Surface.copyWithin`
   * and `Window.scrollRegion` use rather than a scroll offset's — panning a
   * graph right by 10 is `dx: 10`, and the exposed band is down the left
   * edge. Whole pixels, both of them, and `rect` in window coordinates
   * (`abs`, `contentBox()`, an event's `x`/`y`) and inside this node.
   *
   * The element promises one thing in return: that inside `rect` the frame
   * really is that translation and nothing else. Every other way it could be
   * false is core's to check — a claim from anywhere else reaching into the
   * rect, a sibling drawing over it, a child of this node laid out on top of
   * it, an ancestor's border ring or rounded corner, a layout pass that
   * moved something — and each of them falls back to repainting the rect,
   * which is the behaviour without this call at all.
   *
   * All of those are about `rect`, not about this node (issue #309). An
   * element with furniture pinned to a corner of its pane — a minimap, zoom
   * controls, a HUD strip that has to repaint on a pan frame and whose
   * pixels must not ride the blit — carves it out of the region it shifts
   * and claims it as ordinary damage. Those claims land beside the rect and
   * the frame stays a blit.
   *
   * Returns whether the frame is still a blit candidate. The real answer
   * arrives as `paintDamage()`, because most of the gates cannot be decided
   * until the frame closes; a `false` here is only the ones that can.
   */
  scrollContents(rect, dx, dy) {
    const root = this.root;
    if (
      !root ||
      this.destroyed ||
      !rect ||
      !(rect.width > 0) ||
      !(rect.height > 0)
    ) {
      return false;
    }
    // Nothing moved, so there is nothing to claim either — an element
    // rounding a gesture to whole pixels lands here on most events.
    if (!dx && !dy) return true;
    const pending = this._pendingBlitContents;
    // The rect has to be the same one all frame: two different regions of
    // one node shifting by different deltas is not one CopyArea, and the
    // second claim would coalesce into the first past the point either can
    // be told apart. Same for a Scrollable element that also scrolls its
    // offsets this frame — two shifts of the same pixels, and a frame can
    // only have one.
    if (
      this._pendingBlitFrom != null &&
      (!pending ||
        pending.rect.x !== rect.x ||
        pending.rect.y !== rect.y ||
        pending.rect.width !== rect.width ||
        pending.rect.height !== rect.height)
    ) {
      this._pendingBlitFrom = BLIT_POISONED;
    } else if (this._pendingBlitFrom == null && Array.isArray(root._damage)) {
      // Arming is the one moment the evidence still exists — the claim
      // below coalesces earlier ones into itself, after which a change
      // inside the rect is indistinguishable from this call's own claim.
      // The same reasoning, and the same poison rather than a disarm, as
      // scrollTo (react-x11#295).
      //
      // The zone is `rect` itself, where scrollTo's is the viewport plus
      // slop (issue #309): the claim recorded below *is* this rect, so a
      // claim it could swallow has to overlap it, and every claim carries
      // its own slop already — `paintBounds` inflates a node's region by
      // `DAMAGE_SLOP` on every side, so ink that bleeds into `rect` is
      // claimed overlapping it. Furniture *beside* the rect — a minimap in
      // a corner the element carved out and repaints itself — is not a
      // change to the pixels about to move.
      for (const claimed of root._damage) {
        if (rectsOverlap(claimed, rect)) {
          this._pendingBlitFrom = BLIT_POISONED;
          break;
        }
      }
    }
    const state = (this._pendingBlitContents ??= {
      // our own copy: the caller's rect is very often the live
      // `contentBox()` of a node that is about to be laid out again
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      dx: 0,
      dy: 0,
    });
    // several pans in one frame blit once, by the net shift — the same
    // coalescing scrollTo gets from recording an origin
    state.dx += dx;
    state.dy += dy;
    this._pendingBlitFrom ??= BLIT_CONTENTS;
    (root._pendingScrolls ??= new Set()).add(this);
    // ...and the claim about to be recorded is the shift itself, not a
    // reason to un-blit it. `state.rect` by identity, so a second call this
    // frame is recognised as the same claim rather than as foreign damage.
    root._scrollClaim = state.rect;
    root.invalidate(false, state.rect, 'scroll');
    root._scrollClaim = null;
    return this._pendingBlitFrom !== BLIT_POISONED;
  }

  /**
   * `paintBounds()` with the one clip a damage claim must respect: a scroll
   * container above this node that is waiting to blit (issue #398).
   *
   * A viewport clips its children, so the part of a claim outside its box is
   * pixels that cannot appear — and leaving it in costs the blit the frame.
   * A virtualized list is the shape that makes this concrete: its spacers
   * are boxes thousands of pixels tall whose visible extent is a sliver or
   * nothing at all, and their unclipped claims, coalesced into the scroll's
   * own, leave `_blitKeptDamage` a damage rect many times the viewport to
   * refuse. Null when the clip left nothing.
   *
   * Only while a blit is pending — outside that this is `paintBounds()` and
   * one property read. Clipping every claim to every clipping ancestor
   * would be correct too, and is a bigger change than the frame this is
   * about.
   */
  _claimBounds() {
    const bounds = this.paintBounds();
    const sv = this._blitViewport();
    return sv ? intersectRects(bounds, sv.paintBounds()) : bounds;
  }

  /** The scroll container above this node that is waiting to blit, if there
   *  is one — the viewport whose ledger this node's claims belong in, and
   *  whose box clips them (issue #398). One property read when no blit is
   *  pending, which is every frame that is not a scroll. */
  _blitViewport() {
    if (!this.root?._pendingScrolls?.size) return null;
    for (let n = this.parent; n; n = n.parent) {
      if (n._blitLedgerOpen()) return n;
    }
    return null;
  }
}

/** WindowNode's half of the scroll blit, installed onto `WindowNode.prototype` by window/window.js. */
export class WindowScrollBlit {
  /**
   * The scroll-blit fast path (issue #138): when the frame is a *pure*
   * scroll of one viewport, ask ntk to CopyArea the band that stays visible
   * into its new place inside the backing store, and narrow this frame's
   * damage from the whole viewport to the strip the scroll exposed (plus
   * the scrollbar tracks, whose pixels the blit dragged along).
   *
   * Everything here is a gate, cheapest first, and every gate falls back to
   * the claim scrollTo already recorded — the full-viewport repaint that
   * has always been the behavior. The fast path can therefore cost
   * correctness nothing: the worst mistake it can make is not firing.
   */
  _applyScrollBlits(width, height, layoutMoved = false) {
    const pending = this._pendingScrolls;
    if (!pending?.size) return;
    const nodes = [...pending];
    pending.clear();
    const from = nodes[0]._pendingBlitFrom;
    const contents = nodes[0]._pendingBlitContents;
    const ledger = nodes[0]._blitLedger;
    for (const n of nodes) {
      n._pendingBlitFrom = null;
      n._pendingBlitContents = null;
      n._blitLedger = null;
    }
    // two viewports scrolling in one frame is rare enough that sorting out
    // whether their regions interact is not worth it
    if (nodes.length !== 1) return;
    const node = nodes[0];
    // a poisoned frame (react-x11#295) falls back to the full-viewport
    // claim the scroll recorded, like every other declined gate here
    if (from === BLIT_POISONED) return;
    if (NO_SCROLL_BLIT || !from || node.destroyed || node.root !== this) return;
    const wnd = this.window;
    if (typeof wnd?.scrollRegion !== 'function') return; // ntk without #139
    // the debug overlays and the DevTools highlight draw over the whole
    // window; a blit would drag shifted copies of them along
    if (
      debugPaint ||
      process.env.REACT_X11_DEBUG_LAYOUT ||
      this._highlight ||
      this._traceUpdates
    ) {
      return;
    }
    if (!Array.isArray(this._damage)) return; // unbounded frame already
    // the layout diff claimed real movement this pass — the frame is not a
    // pure scroll, and a blit under rearranged content would shift stale
    // pixels into place the repaint no longer covers
    if (layoutMoved) return;
    // From here the two arming paths part company: an element handed us the
    // region and the shift itself (issue #303), where a scroll container is
    // its whole viewport shifted by the change in its offsets.
    if (contents) {
      this._applyContentsBlit(node, contents, width, height);
      return;
    }
    // Back where the frame started: a burst of scrolls that went one way
    // and back again inside one refresh — the Cocoa wheel folds a burst
    // into one paced frame, and a trackpad's reversal is exactly that.
    // Nothing on screen moved, so there is no band to shift and the
    // scroll's claim on the whole viewport is owed nothing; what did change
    // inside it is in the ledger, and the ledger is what gets repainted.
    // (Every pixel-shift gate below is moot for a shift of nothing.)
    if (from.x === node.scrollX && from.y === node.scrollY) {
      const box = node.abs;
      const kept = this._blitKeptDamage(box);
      if (!kept) return;
      let rects = kept;
      for (const claim of ledger ?? []) {
        const inside = intersectRects(claim, box);
        if (inside) rects = addDamageRect(rects, inside);
      }
      this._damage = rects;
      return;
    }
    // children clip to the border box, so a border ring or rounded corner
    // would be shifted like content — any painted side counts
    const blitBorder = resolveBorderWidths(node.style, node.direction);
    if (
      blitBorder.top > 0 ||
      blitBorder.right > 0 ||
      blitBorder.bottom > 0 ||
      blitBorder.left > 0 ||
      node.style.borderRadius > 0
    ) {
      return;
    }
    const vp = node.abs;
    // fractional geometry or offsets change every pixel; only a whole-pixel
    // shift is a copy
    if (!isIntegerRect(vp)) return;
    if (!Number.isInteger(from.x) || !Number.isInteger(from.y)) return;
    // How far the kept pixels move, which is how far the content moved —
    // the sense `scrollRegion` takes and `_applyContentsBlit` is handed.
    // Not the change in the offsets: along x in RTL the two agree only in
    // size (`_blitShift`).
    const { x: dx, y: dy } = node._blitShift(from);
    if (!Number.isInteger(dx) || !Number.isInteger(dy)) return;
    if (dx === 0 && dy === 0) return;
    // one axis at a time: a diagonal scroll needs an L of strips whose
    // pieces overlap the bar rects, and overlapping damage rects merge into
    // their box (translucent paint must not run twice) — the merges balloon
    // toward the whole viewport and the blit stops paying. Wheels scroll
    // one axis per event, so this costs almost nothing real.
    if (dx !== 0 && dy !== 0) return;
    if (Math.abs(dx) >= vp.width || Math.abs(dy) >= vp.height) return;
    // the worth-it heuristics: below these, the plain repaint is one cheap
    // pass and the blit's bookkeeping outweighs it
    const area = vp.width * vp.height;
    if (area < SCROLL_BLIT_MIN_AREA) return;
    const kept = (vp.width - Math.abs(dx)) * (vp.height - Math.abs(dy));
    if (kept < area * SCROLL_BLIT_MIN_KEEP) return;
    // the band shifts in from inside the window; a viewport poking out of
    // it has nothing there to shift
    if (
      vp.x < 0 ||
      vp.y < 0 ||
      vp.x + vp.width > width ||
      vp.y + vp.height > height
    ) {
      return;
    }
    const keep = this._blitKeptDamage(vp);
    if (!keep) return;
    // What changed inside the viewport while the blit was armed, in the
    // coordinates the frame is about to paint in (issue #398). A claim made
    // during the commit named where the content sat before the shift, and
    // the blit is about to move those pixels by the frame's delta, so it
    // moves with them; a claim from the layout diff already landed there.
    //
    // Repainting the result is what makes the blit honest about them: the
    // blit translates the previous frame's rendering, which is correct
    // everywhere the content did not change, and these are the places it
    // did. That is finer than the strip-only rule issue #398 asks for and
    // no more complicated, so a mid-viewport change — a row upgrading from
    // skeleton to content while the list scrolls — rides the fast path too
    // instead of falling back to the whole viewport.
    //
    // The strip the shift exposed, on the side the pixels moved away from,
    // full breadth — it also covers the corner gutter beside the bars, whose
    // old pixels the blit did not overwrite — is repainted on every frame
    // the blit serves, whatever the ledger holds.
    const axis = dy !== 0 ? 'y' : 'x';
    const delta = dy !== 0 ? dy : dx;
    const strip =
      axis === 'y'
        ? {
            x: vp.x,
            y: delta > 0 ? vp.y : vp.y + vp.height + delta,
            width: vp.width,
            height: Math.abs(delta),
          }
        : {
            x: delta > 0 ? vp.x : vp.x + vp.width + delta,
            y: vp.y,
            width: Math.abs(delta),
            height: vp.height,
          };
    const repairs = [];
    for (const claim of ledger ?? []) {
      const moved = claim.pre
        ? {
            x: claim.x + dx,
            y: claim.y + dy,
            width: claim.width,
            height: claim.height,
          }
        : claim;
      const inside = intersectRects(moved, vp);
      if (inside) repairs.push(inside);
    }
    // Past this the blit plus a scatter of repaints is no longer cheaper
    // than the one full-viewport pass it replaced. Priced as what the
    // repairs add to the strip: a pixel under two of them, or under one and
    // the strip, is painted once. Summed, a held sticky header paid for its
    // rect twice — it claims where it was and where it is, a delta apart —
    // then again for each sticky node held inside it, and scrolled back up
    // it paid a third time for the strip the blit dragged its copy across.
    const repairArea = repairs.length
      ? unionArea([strip, ...repairs]) - rectArea(strip)
      : 0;
    if (repairArea > area * BLIT_MAX_CLAIM_AREA) return;
    if (!this._scrollBlitSafe(node, vp)) return;
    // The band the scrolled bar's thumb travels in is repaired on its own.
    // The thumb's rects are thin and run along the viewport's edge, and a
    // rect reaching into the band from inside — a column held down the
    // pane's whole height, the strip at the end the thumb has come to —
    // merged with them into the box around both, which reaches back across
    // the viewport. Cut at the band's line instead, each part coalesces on
    // its own side of it, and the band stays a band.
    //
    // Assembled uncapped, so the parts of a cut stay apart until every rect
    // is in: a cap merge would pick the two halves of one rect first — they
    // waste nothing — and put the overlap back. The halves that met nothing
    // on either side are rejoined after, which is the rect uncut and one
    // pass fewer, and only then is the frame capped.
    const scrolledBar = node._scrollbar(axis);
    const band = scrolledBar ? scrollbarBand(scrolledBar, vp) : null;
    let rects = keep;
    const add = (rect) => {
      const { inside, outside } = band
        ? splitAtBand(rect, band)
        : { inside: null, outside: rect };
      if (outside) rects = addDamageRect(rects, outside, Infinity);
      if (inside) rects = addDamageRect(rects, inside, Infinity);
    };
    add(strip);
    // Scrollbar repair. The scrolled axis's thumb moved *and* the blit
    // dragged a copy of the old thumb along: repaint the dragged copy's
    // rect and the new thumb's rect — small rects, where the full track
    // would run the viewport's whole length and merge with the strip into
    // most of the viewport. The cross-axis bar did not move, but the blit
    // shifted its pixels like everything else: its track repaints whole,
    // and so does the copy of the track the shift dragged off it — a pane
    // scrolling both ways otherwise trails a smear of old thumb behind its
    // bar, a row per pixel scrolled. Both lie along the strip on the far
    // edge, so their merge stays a band.
    if (scrolledBar) {
      const savedX = node.scrollX;
      const savedY = node.scrollY;
      node.scrollX = from.x;
      node.scrollY = from.y;
      const oldBar = node._scrollbar(axis);
      node.scrollX = savedX;
      node.scrollY = savedY;
      if (oldBar) {
        rects = addDamageRect(
          rects,
          {
            x: oldBar.x - 1 + dx,
            y: oldBar.y - 1 + dy,
            width: oldBar.width + 2,
            height: oldBar.height + 2,
          },
          Infinity,
        );
      }
      rects = addDamageRect(
        rects,
        {
          x: scrolledBar.x - 1,
          y: scrolledBar.y - 1,
          width: scrolledBar.width + 2,
          height: scrolledBar.height + 2,
        },
        Infinity,
      );
    }
    const crossBar = node._scrollbar(axis === 'y' ? 'x' : 'y');
    if (crossBar) {
      const track = scrollbarTrackRect(crossBar);
      add(track);
      const dragged = intersectRects(
        { ...track, x: track.x + dx, y: track.y + dy },
        vp,
      );
      if (dragged) add(dragged);
    }
    for (const repair of repairs) add(repair);
    rects = joinAlongEdges(rects).reduce(
      (capped, rect) => addDamageRect(capped, rect),
      [],
    );
    // The last gate, and the only one that has to wait until the rects are
    // assembled: damage rects must not overlap, and the frame carries at
    // most MAX_DAMAGE_RECTS of them, so repairs that meet — a column and a
    // row at a corner — or that the cap has to pair up are merged into the
    // box around them, and that box can reach back across the viewport.
    // When it does, the blit is buying a shift and paying for the viewport
    // anyway, so let the plain repaint scrollTo already claimed have the
    // frame.
    let painted = 0;
    for (const rect of rects) {
      const inside = intersectRects(rect, vp);
      if (inside) painted += inside.width * inside.height;
    }
    if (painted > area * SCROLL_BLIT_MAX_REPAINT) return;
    if (!wnd.scrollRegion({ ...vp }, dx, dy)) return;
    this._damage = rects;
  }

  /**
   * The frame's damage with the shift's own claim taken out, or null if the
   * shift is not the only thing that happened inside `vp`.
   *
   * The claim recorded by `scrollTo` (with its slop) or by `scrollContents`
   * (exactly `vp`) is the one rect allowed to reach in. Anything else — a
   * virtualized table's row swap, a hover restyle mid-scroll, a coalesce
   * that swallowed the claim into a bigger box — means pixels in there
   * changed, and changed pixels must not be blitted around.
   *
   * `exact` is how an element blit asks for the strict form of that: the
   * claim has to still *be* `vp`, not merely cover it within the slop
   * (issue #309). The claim is dropped here in favour of the strips the
   * shift exposed, so anything merged into it is dropped with it — and the
   * damage cap merges neighbours on its own, without a claim-time gate to
   * poison first. Requiring the rect back unchanged is what lets the
   * claim-time gate narrow to `vp` itself and let furniture beside it live.
   */
  _blitKeptDamage(vp, exact = false) {
    const keep = [];
    let sawClaim = false;
    const slopped = insetRect(vp, -(DAMAGE_SLOP + 1));
    for (const rect of this._damage) {
      if (!rectsOverlap(rect, vp)) {
        keep.push(rect);
        continue;
      }
      if (
        exact
          ? rect.x === vp.x &&
            rect.y === vp.y &&
            rect.width === vp.width &&
            rect.height === vp.height
          : rectContains(rect, vp) && rectContains(slopped, rect)
      ) {
        sawClaim = true;
        continue;
      }
      return null;
    }
    return sawClaim ? keep : null;
  }

  /**
   * The other half of the blit: a region an element shifted itself
   * (`Node.scrollContents`, issue #303).
   *
   * The gates are the scroll path's, minus everything that was about a
   * scroll container — there are no offsets to be whole, no scrollbars to
   * repair, and no extent that decided the delta — and plus the two things
   * only an element-owned region raises: the region has to be inside what
   * the element itself draws, and this node's *children* are laid out over
   * that drawing rather than being it.
   *
   * Diagonal shifts are allowed here, unlike the scroll path, and that is
   * the point rather than an oversight: a pan is diagonal almost every
   * frame, and the reason the scroll path takes one axis at a time is that
   * the L of exposed strips overlaps the scrollbar rects and the merges
   * balloon back towards the whole viewport. With no bars the L is two
   * disjoint rects and stays two.
   */
  _applyContentsBlit(node, { rect: vp, dx, dy }, width, height) {
    // only a whole-pixel shift of a whole-pixel region is a copy
    if (!isIntegerRect(vp)) return;
    if (!Number.isInteger(dx) || !Number.isInteger(dy)) return;
    // the net shift of the frame, which several pans can cancel out of
    if (dx === 0 && dy === 0) return;
    if (Math.abs(dx) >= vp.width || Math.abs(dy) >= vp.height) return;
    // the worth-it heuristics, the scroll path's: below these the plain
    // repaint is one cheap pass and the bookkeeping outweighs it
    const area = vp.width * vp.height;
    if (area < SCROLL_BLIT_MIN_AREA) return;
    const kept = (vp.width - Math.abs(dx)) * (vp.height - Math.abs(dy));
    if (kept < area * SCROLL_BLIT_MIN_KEEP) return;
    // the band shifts in from inside the window; a region poking out of it
    // has nothing there to shift
    if (
      vp.x < 0 ||
      vp.y < 0 ||
      vp.x + vp.width > width ||
      vp.y + vp.height > height
    ) {
      return;
    }
    // Inside the element, and clear of its own border ring and rounded
    // corners: those are `Node.paint`'s, not the element's drawing, and
    // they do not translate. A solid background does, so the fill under the
    // region is not a reason to decline.
    const bw = resolveBorderWidths(node.style ?? EMPTY_STYLE, node.direction);
    const inset = Math.max(
      bw.top,
      bw.right,
      bw.bottom,
      bw.left,
      node.style?.borderRadius ?? 0,
    );
    if (!rectContains(insetRect(node.abs, inset), vp)) return;
    // A scroll container's children *are* the scrolled content, which is
    // why _scrollBlitSafe skips that subtree. An element's are not: it
    // draws the region in paintContent and its children are laid out on
    // top, so one reaching in would have its pixels dragged along.
    for (const child of node.children) {
      if (child.isWindow || !child.yoga || child.hidden) continue;
      if (child.style?.display === 'none') continue;
      if (rectsOverlap(child._subtreeBounds(), vp)) return;
    }
    const keep = this._blitKeptDamage(vp, true);
    if (!keep) return;
    // An ancestor's rounded corners reach into the top and bottom rows of
    // the region (a graph pane inside a rounded card is the common shape):
    // those rows do not translate, so they leave the blit and get repainted
    // as bands — the same carve the element does for its own furniture —
    // and the band that shifts is what is left between them.
    const bands = this._cornerBands(node, vp);
    const shifted =
      bands.top || bands.bottom
        ? {
            x: vp.x,
            y: vp.y + bands.top,
            width: vp.width,
            height: vp.height - bands.top - bands.bottom,
          }
        : vp;
    if (shifted.height <= 0 || Math.abs(dy) >= shifted.height) return;
    if (
      (shifted.width - Math.abs(dx)) * (shifted.height - Math.abs(dy)) <
      area * SCROLL_BLIT_MIN_KEEP
    ) {
      return;
    }
    if (!this._scrollBlitSafe(node, shifted)) return;
    // the element's deltas are already how far the pixels moved, the sense
    // scrollRegion takes (0 + x rather than x: a caller's -0 would survive
    // into request buffers and test comparisons)
    if (!this.window.scrollRegion({ ...shifted }, 0 + dx, 0 + dy)) return;
    let rects = keep;
    if (bands.top) {
      rects = addDamageRect(rects, {
        x: vp.x,
        y: vp.y,
        width: vp.width,
        height: bands.top,
      });
    }
    if (bands.bottom) {
      rects = addDamageRect(rects, {
        x: vp.x,
        y: shifted.y + shifted.height,
        width: vp.width,
        height: bands.bottom,
      });
    }
    vp = shifted;
    // The strips the shift exposed, on the sides the pixels came from. The
    // horizontal one takes the full width and the vertical one takes what
    // is left, so a diagonal shift claims two rects that do not overlap —
    // overlapping claims merge into their box, and the box of an L is the
    // whole region again.
    if (dy !== 0) {
      rects = addDamageRect(rects, {
        x: vp.x,
        y: dy > 0 ? vp.y : vp.y + vp.height + dy,
        width: vp.width,
        height: Math.abs(dy),
      });
    }
    if (dx !== 0) {
      rects = addDamageRect(rects, {
        x: dx > 0 ? vp.x : vp.x + vp.width + dx,
        y: dy > 0 ? vp.y + dy : vp.y,
        width: Math.abs(dx),
        height: vp.height - Math.abs(dy),
      });
    }
    this._damage = rects;
  }

  /**
   * How many rows at the top and at the bottom of `vp` an ancestor's rounded
   * corners reach into — the rows an element blit has to leave behind and
   * repaint, so that what shifts stays clear of every corner square
   * (`_scrollBlitSafe`). Whole pixels, and zero when no corner reaches in.
   */
  _cornerBands(node, vp) {
    let top = 0;
    let bottom = 0;
    for (let n = node.parent; n && n !== this; n = n.parent) {
      const radius = n.style?.borderRadius ?? 0;
      if (!(radius > 0) || !n.abs) continue;
      if (!cornerSquaresOverlap(n.abs, radius, vp)) continue;
      top = Math.max(top, Math.ceil(n.abs.y + radius - vp.y));
      bottom = Math.max(
        bottom,
        Math.ceil(vp.y + vp.height - (n.abs.y + n.abs.height - radius)),
      );
    }
    return { top: Math.max(0, top), bottom: Math.max(0, bottom) };
  }

  /**
   * May the viewport's pixels be moved wholesale? Only if every pixel in it
   * belongs to the scrolled content (or to a plain solid fill behind it):
   * any node outside the scroller's subtree whose drawing reaches into
   * the viewport — an overlapping sibling, an ancestor's border ring or
   * rounded corner, an enclosing viewport's scrollbar — would have its
   * pixels dragged along by the blit, so any of them is a no.
   */
  _scrollBlitSafe(scroller, vp) {
    // the window itself scrolls: everything inside it *is* the scrolled
    // content, so there is nothing that could be dragged along
    if (scroller === this) return true;
    const ancestors = new Set();
    for (let n = scroller.parent; n && n !== this; n = n.parent) {
      ancestors.add(n);
    }
    const check = (parent) => {
      for (const child of parent.children) {
        if (child === scroller) continue; // the scrolled content itself
        if (child.isWindow || !child.yoga || child.hidden) continue;
        if (child.style?.display === 'none') continue;
        if (ancestors.has(child)) {
          // on the path down: its solid background under the viewport is
          // translation-invariant, its border ring and corners are not.
          // The widest side is conservative for a non-uniform border
          const bw = resolveBorderWidths(
            child.style ?? EMPTY_STYLE,
            child.direction,
          );
          const ring = Math.max(bw.top, bw.right, bw.bottom, bw.left);
          if (ring > 0 && !rectContains(insetRect(child.abs, ring), vp)) {
            return false;
          }
          // A rounded corner is not a ring: the arc lives in the four
          // radius-sized squares at the corners, and the straight run of
          // the edge between them is the border ring already excluded
          // above. A viewport that reaches the edge but stays clear of the
          // squares — an element that carved the corner rows into bands it
          // repaints (`_cornerBands`) — is translation-safe.
          const radius = child.style?.borderRadius ?? 0;
          if (radius > 0 && cornerSquaresOverlap(child.abs, radius, vp)) {
            return false;
          }
          if (typeof child._scrollbars === 'function') {
            for (const bar of child._scrollbars()) {
              if (rectsOverlap(scrollbarTrackRect(bar), vp)) return false;
            }
          }
          if (!check(child)) return false;
          continue;
        }
        // A node on a layer of its own (src/cocoa/promotion.js) has no
        // pixels in the bitmap the band is cut from, so nothing of it can
        // be dragged along — a pulsing toast over a list is what promotion
        // is for, and this is the half of it that keeps the pan a blit.
        if (child._promoted) continue;
        if (rectsOverlap(child._subtreeBounds(), vp)) return false;
      }
      return true;
    };
    return check(this);
  }

  /**
   * The node whose `opaqueRect()` holds the whole of `rect`, or null: the
   * pass needs no fill under that node. Whole pixels only — a fractional
   * edge is antialiased, and an antialiased pixel is not opaque. A clipping
   * ancestor shrinks the answer to what reaches the surface, a rounded one
   * by its radius all round, since the corner squares are exactly the
   * pixels a rounded clip gives up. A handful of nodes answer at all, so
   * this is a few rect tests per pass.
   */
  _coverFor(rect) {
    const nodes = this._opaqueNodes;
    if (nodes.size === 0) return null;
    for (const node of nodes) {
      if (node.destroyed || node.hidden || node._promoted) continue;
      if (node.style?.display === 'none' || !(node.abs?.width > 0)) continue;
      let cover = node.opaqueRect();
      if (!cover) continue;
      cover = innerPixels(cover);
      for (let n = node.parent; cover && n && n !== this; n = n.parent) {
        if (n.hidden || n.style?.display === 'none') {
          cover = null;
          break;
        }
        if (n.clipsChildren()) {
          const radius = n.style?.borderRadius ?? 0;
          cover = intersectRects(
            cover,
            radius > 0 ? insetRect(n.abs, radius) : n.abs,
          );
        }
      }
      if (cover && rectContains(cover, rect)) return node;
    }
    return null;
  }
}
