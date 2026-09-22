// The children of a `<glarea>`: 2D content, drawn above the GL surface.
//
// A surface is stacked over everything 2D in its window — a child X window
// above the parent's drawing on X11, a layer at zPosition 1e7 over both
// presenters on the Cocoa backend — so the window's own paint walk can never
// put a pixel on it, and does not try: a `<glarea>` is in no paint order, and
// so is nothing under it. Its children are otherwise ordinary. They are laid
// out in its box like a `<box>`'s; they live in the owning window's tree, so
// their claims land in its damage list and their input comes through its
// event manager, the hit test asking them before the surface itself
// (`GlAreaNode.hitSurface`). What is theirs alone is where they are painted:
// into *panes* above the surface, from inside the owning window's frame and
// with that frame's damage (nodes/window/flush.js, `_syncOverlays` and
// `_paintOverlays`).
//
// A pane is the backend's answer to one question — can a window composite a
// translucent child over a GL surface?
//
// - **The Cocoa backend: yes.** Core Animation composites every layer, so
//   one pane holds everything — a transparent bitmap layer over the whole
//   surface, above the GL layer — and a translucent background, an
//   antialiased edge or a shadow blends with the GL frame under it.
//   `app.createOverlayPane` is how a backend says it composites.
// - **X11: no.** A child window is opaque without a compositor, and a
//   compositor would not change that: it redirects top-level windows, not
//   the children inside one. So a pane is a plain child window just big
//   enough for what it holds, one per region the children reach, and the
//   surface shows between them. Inside a pane the ground is the surface's
//   `clearColor` — the colour its frames start from — so a pixel a child
//   leaves unpainted there (a rounded corner, a translucent background, text
//   with no box behind it) shows that colour, never the GL frame.
//
//   A window per region rather than one window shaped by the SHAPE
//   extension, for two reasons: SHAPE is near-universal but not universal —
//   node-x11's in-process server, where this is tested, has none — and a
//   window as big as the surface would keep a backing pixmap the size of a
//   map to show a legend in its corner.
// - **XQuartz: no, and not opaquely either.** Every GL surface there, the
//   direct ones Apple-DRI exports and indirect GLX's alike, is a surface of
//   the macOS window server, composited above everything the X server draws
//   in the window (hw/xquartz/xpr/dri.c makes it `XP_MAPPED_ABOVE`). X's
//   stacking never reaches it: a pane stacked over the surface's window is
//   drawn under the frame, cutting that window down with SHAPE leaves the
//   frame covering all of it, and only a pane over the whole surface shows —
//   by hiding the frame (issue #653). So no pane is made there, and
//   `canOverlay` says so from the first render on (`beginGlOverlay`).
//
// A pane selects no input, so the pointer over one reaches the owning window
// by the same propagation that brings it the pointer over the surface
// (src/glnodes.js, `_create`), and lands on the child it is over.
//
// A pane keeps what it holds between frames, so a child that only moved is
// already painted, one shift away (issue #644). The layout pass reports such
// a child instead of claiming it (`GlAreaNode._absolutizeChild`), and the
// frame moves its pixels inside the pane — `scrollRegion`, the verb the
// scroll blit uses on a window — and repaints only what the move uncovered
// and what it now overlaps differently (`settleMoves`). A pan over a
// graph's mounted node bodies is that frame, sixty times a second.
//
// A leaf module, like src/embedding.js: `appcontext.js` asks `canOverlay`
// for `useSupports('glOverlay')`, and it imports nothing of ours but the
// damage model's arithmetic, which imports nothing at all.
import { cssColorStraight } from 'ntk';

import { FULL_DAMAGE, addDamageRect } from './nodes/damage.js';
import {
  innerPixels,
  intersectRects,
  rectArea,
  rectContains,
  unionRect,
} from './nodes/rects.js';

// ConfigureWindow's stack mode: directly above the sibling it names
const STACK_ABOVE = 0;

// Past this share of the pixels a move carries, the frame would repaint
// most of them anyway — around what it claims itself, or around the other
// children the copy reached — and the copy only adds to the bill.
const MOVE_BLIT_MAX_REPAINT = 0.75;

// The scroll blit's escape hatch (src/nodes/scrollblit.js), read the same
// way: every path that moves retained pixels instead of repainting them is
// one variable away from the plain repaint (docs/debugging.md).
const NO_BLIT = process.env.REACT_X11_NO_SCROLL_BLIT === '1';

// Connections on which nothing can be drawn over a GL surface, each with the
// reason (`beginGlOverlay`), and the probe that finds out, once per app.
const refusals = new WeakMap();
const probes = new WeakMap();

const XQUARTZ =
  'this display is XQuartz, where the macOS window server composites every ' +
  'GL surface above everything the X server draws in its window. Draw the ' +
  'overlay beside the surface or in GL instead, or run on the Cocoa backend ' +
  '(the default on macOS), which composites it';

/**
 * Whether the children of a `<glarea>` can be drawn over its surface on this
 * connection: a backend that composites a pane itself, or one that can make
 * the plain child window a pane is on X11 — on any server but XQuartz, where
 * nothing can be drawn over a GL surface (`beginGlOverlay`). One function
 * for the element and for `useSupports('glOverlay')`, which have to agree —
 * the rule `canEmbed` follows for `<foreign>`.
 */
export function canOverlay(app) {
  if (typeof app?.createOverlayPane === 'function') return true;
  return typeof app?.createWindow === 'function' && !refusals.has(app);
}

/** Why nothing is drawn over a GL surface on this connection, for the
 * warning a `<glarea>` with children gives there — or null. */
export function overlayRefusal(app) {
  return (app && refusals.get(app)) ?? null;
}

/**
 * Is this an X server where nothing can be drawn over a GL surface? Asked
 * in `createRoot`, with the other startup probes and before the first
 * render, so that `canOverlay` answers the same from the first frame on —
 * a component choosing how to draw by it would otherwise build one way and
 * tear that down a frame later.
 *
 * The server is XQuartz, and the question is its Apple-DRI extension, which
 * no other server has: every GL surface XQuartz makes comes from the
 * machinery that extension exports, direct and indirect alike. Asked of the
 * server rather than of `app.glCapabilities()`, because the default policy
 * never probes direct rendering and XQuartz's indirect GLX hides the panes
 * all the same. One QueryExtension; where ntk's direct-rendering probe has
 * asked already, node-x11 answers it from the reply it kept.
 */
export function beginGlOverlay(app) {
  if (!app) return Promise.resolve();
  let pending = probes.get(app);
  if (pending) return pending;
  const X = app.X;
  pending =
    typeof app.createOverlayPane === 'function' ||
    typeof X?.QueryExtension !== 'function'
      ? Promise.resolve()
      : new Promise((resolve) => {
          try {
            X.QueryExtension('Apple-DRI', (err, reply) => {
              if (!err && reply?.present) refusals.set(app, XQUARTZ);
              resolve();
            });
          } catch {
            // a connection that cannot ask is one this cannot find out about
            resolve();
          }
        });
  probes.set(app, pending);
  return pending;
}

/** A rect grown out to whole device pixels. */
function whole(r) {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return {
    x,
    y,
    width: Math.ceil(r.x + r.width) - x,
    height: Math.ceil(r.y + r.height) - y,
  };
}

const overlaps = (a, b) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

function around(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

const sameRect = (a, b) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const shifted = (r, dx, dy) => ({
  x: r.x + dx,
  y: r.y + dy,
  width: r.width,
  height: r.height,
});

/** `a` with `b` taken out of it: up to four rects — the full-width bands
 * above and below `b`, and the pieces either side of it between them. */
function subtractRect(a, b) {
  const cut = intersectRects(a, b);
  if (!cut) return [a];
  const out = [];
  const right = a.x + a.width;
  const bottom = a.y + a.height;
  const cutRight = cut.x + cut.width;
  const cutBottom = cut.y + cut.height;
  if (cut.y > a.y) {
    out.push({ x: a.x, y: a.y, width: a.width, height: cut.y - a.y });
  }
  if (cutBottom < bottom) {
    out.push({
      x: a.x,
      y: cutBottom,
      width: a.width,
      height: bottom - cutBottom,
    });
  }
  if (cut.x > a.x) {
    out.push({ x: a.x, y: cut.y, width: cut.x - a.x, height: cut.height });
  }
  if (cutRight < right) {
    out.push({
      x: cutRight,
      y: cut.y,
      width: right - cutRight,
      height: cut.height,
    });
  }
  return out;
}

/** On screen: nothing from here to the window hidden or `display: 'none'`. */
function shown(node) {
  for (let n = node; n; n = n.parent) {
    if (n.destroyed || n.hidden || n.style?.display === 'none') return false;
    if (n.isWindow) break;
  }
  return true;
}

/**
 * Where the children put ink, as rects no two of which overlap: each drawn
 * child's reach in whole pixels, cut to the surface, and any two that
 * overlap merged into the box around both. A pane is a rectangle, and two
 * panes over one pixel would each have to hold what the other draws there.
 *
 * The reach is `_subtreeBounds()`, the rect the damage model culls against —
 * so a child's shadow, its outline and a descendant that sticks out of it
 * are all inside its pane.
 */
export function overlayRegions(area, surface) {
  const rects = [];
  for (const child of area.paintOrder()) {
    const reach = intersectRects(whole(child._subtreeBounds()), surface);
    if (reach) rects.push(reach);
  }
  for (let merged = true; merged;) {
    merged = false;
    search: for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        if (overlaps(rects[i], rects[j])) {
          rects[i] = around(rects[i], rects[j]);
          rects.splice(j, 1);
          merged = true;
          break search;
        }
      }
    }
  }
  return rects;
}

/**
 * The colour an opaque pane is filled with before its children paint: the
 * surface's `clearColor`, what the GL frame under the pane starts from, at
 * full alpha. The pane is opaque, and a translucent fill would pile up on
 * the pane's own last frame rather than show anything under it.
 */
function groundOf(props) {
  const value = props.clearColor ?? 'black';
  const [r, g, b] = Array.isArray(value)
    ? value
    : (cssColorStraight(value) ?? [0, 0, 0, 1]);
  const byte = (c) => Math.round(Math.max(0, Math.min(1, c)) * 255);
  return `rgb(${byte(r)}, ${byte(g)}, ${byte(b)})`;
}

/**
 * One pane: the window — or on the Cocoa backend the layer, which speaks the
 * same few verbs — and what the overlay knows about it: where it is, whether
 * all of it is owed a paint, and its 2d context, made once, since ntk builds
 * a fresh one with subscriptions of its own on every `getContext`.
 */
class Pane {
  constructor(wnd, rect, transparent) {
    this.wnd = wnd;
    this.rect = rect;
    this.transparent = transparent;
    this.full = true;
    this.ctx = null;
    // placed this frame: what the pane holds is where the children were in
    // the pane's own corner, not in the window, so nothing in it is a known
    // shift away from where it goes
    this.placed = false;
    // moved pixels this frame, which has to reach the screen even when no
    // pass follows it (`GlOverlay.paint`)
    this.blitted = false;
  }

  context() {
    if (!this.ctx && typeof this.wnd.getContext === 'function') {
      this.ctx = this.wnd.getContext('2d');
    }
    return this.ctx;
  }

  /** Somewhere else. A new size is a new backing — a pixmap on X11, a
   * bitmap on Cocoa — and has to be painted whole; a move keeps what the
   * pane holds, which moved with the children it shows. */
  place(rect) {
    if (rect.width !== this.rect.width || rect.height !== this.rect.height) {
      this.full = true;
    }
    // pixels a scroll blit moved this frame (nodes/scrollblit.js, which runs
    // before `sync`) were moved in the pane's own corner, and the pane has
    // since gone somewhere else
    if (this.blitted) this.full = true;
    this.rect = rect;
    this.placed = true;
    if (typeof this.wnd.setState === 'function') this.wnd.setState(rect);
    else {
      this.wnd.move?.(rect.x, rect.y);
      this.wnd.resize?.(rect.width, rect.height);
    }
  }

  /** Can the pixels of `rect`, in window coordinates, move inside this
   * pane? Not when it is owed a paint whole or was placed this frame, and
   * not where the backend has no verb for it. */
  canBlit(rect) {
    return (
      !this.full &&
      !this.placed &&
      typeof this.wnd.scrollRegion === 'function' &&
      rectContains(this.rect, rect)
    );
  }

  /**
   * Move the pixels of `rect` — window coordinates — by (dx, dy) inside the
   * pane, with the window verb's contract (ntk `Window.scrollRegion`, and
   * the Cocoa pane's own): the band that survives inside `rect` moves, the
   * rest of it is left as it was. False when the backend could not, which
   * leaves the pane exactly as it was.
   */
  blit(rect, dx, dy) {
    const local = {
      x: rect.x - this.rect.x,
      y: rect.y - this.rect.y,
      width: rect.width,
      height: rect.height,
    };
    if (!this.wnd.scrollRegion(local, dx, dy)) return false;
    this.blitted = true;
    return true;
  }

  show(on) {
    if (on) this.wnd.map?.();
    else this.wnd.unmap?.();
  }

  destroy() {
    this.wnd.destroy?.();
    this.ctx = null;
  }
}

/** A `<glarea>`'s panes, from the owning window's frame. */
export class GlOverlay {
  constructor(area) {
    this.area = area;
    this.app = area.app;
    // one pane over the whole surface, where the backend composites it
    this.composited = typeof this.app?.createOverlayPane === 'function';
    this.panes = [];
    // the children this frame's layout moved and nothing else, reported
    // rather than claimed (`GlAreaNode._absolutizeChild`) and settled after
    // the panes are (`settleMoves`)
    this.moves = [];
  }

  /**
   * After layout: panes for where the children are now. True when a pane was
   * made, resized or dropped — a paint the frame then owes.
   *
   * Nothing is made for a surface that is hidden, or has no area, or has no
   * child on screen: a pane with nothing on it would only hide the surface.
   * The panes of one that goes are dropped rather than kept unmapped, and
   * the frame that brings it back makes new ones and paints them whole.
   */
  sync() {
    const area = this.area;
    const abs = area.abs;
    for (const pane of this.panes) pane.placed = false;
    let rects = [];
    if (shown(area) && abs.width > 0 && abs.height > 0) {
      // the surface's own rect, rounded the way its window's is
      const surface = area._geometry();
      if (!this.composited) rects = overlayRegions(area, surface);
      else if (area.paintOrder().length) rects = [surface];
    }
    let changed = false;
    while (this.panes.length > rects.length) {
      this.panes.pop().destroy();
      changed = true;
    }
    let made = false;
    for (let i = 0; i < rects.length; i++) {
      const pane = this.panes[i];
      if (!pane) {
        this.panes.push(this._makePane(rects[i]));
        made = changed = true;
      } else if (!sameRect(pane.rect, rects[i])) {
        pane.place(rects[i]);
        changed = true;
      }
    }
    if (made) this.restack();
    return changed;
  }

  _makePane(rect) {
    const owner = this.area.root.window;
    const attributes = { parent: owner, ...rect };
    const pane = this.composited
      ? new Pane(this.app.createOverlayPane(attributes), rect, true)
      : // A plain child window on the owning window's visual, selecting
        // nothing but what ntk selects for itself — the structure events and
        // the exposures its backing store answers. The pointer is the tree's.
        new Pane(this.app.createWindow(attributes), rect, false);
    // ntk asks for a redraw when the backing no longer holds the picture — a
    // resize it could not carry over — and a pane has nothing to redraw from
    // but the children, on the next frame of the window they live in
    pane.wnd.on?.('draw', () => this._lost(pane));
    pane.show(true);
    return pane;
  }

  /** A pane whose pixels are gone: all of it is owed, on the owning window's
   * next frame, claimed as its rect so the rest of the window stays put. */
  _lost(pane) {
    pane.full = true;
    const root = this.area.root;
    if (root && !root.destroyed)
      root.invalidate(false, { ...pane.rect }, 'expose', this.area);
  }

  /**
   * Put the panes directly over the surface, bottom to top. Only X11 needs
   * it: a child window is made on top of its siblings, which is right for a
   * pane made after the surface and wrong for one made before it — the
   * surface's window is made once its visual is known, which can be after
   * the first frame has laid out and painted its children. So the surface
   * restacks its panes when its own window is made, too (`_create`). On the
   * Cocoa backend the layer's zPosition is the whole of it.
   */
  restack() {
    if (this.composited) return;
    const X = this.app?.X;
    if (typeof X?.ConfigureWindow !== 'function') return;
    let below = this.area.window?.id ?? null;
    for (const pane of this.panes) {
      const id = pane.wnd.id;
      if (id == null) continue;
      if (below == null) X.ConfigureWindow(id, { stackMode: STACK_ABOVE });
      else X.ConfigureWindow(id, { sibling: below, stackMode: STACK_ABOVE });
      below = id;
    }
  }

  /**
   * A child the layout pass moved and nothing else — every descendant
   * landed where it was plus (dx, dy) or claimed where it did not — and
   * claimed nothing for (`GlAreaNode._absolutizeChild`). `reach` is its
   * `paintBounds()` from before the move: every pixel of it the panes hold.
   */
  noteMove(node, reach, dx, dy) {
    this.moves.push({ node, reach, dx, dy });
  }

  /**
   * The frame's moves, settled after `sync` has put the panes where the
   * children are and before the frame takes its damage
   * (`WindowNode._syncOverlays`). The one covering the most of the surface
   * moves its pixels on its pane where that is safe and saves the repaint
   * (`_blitMove`); every other one, and that one when not, is claimed where
   * it was and where it is — the pixels the layout diff would have claimed
   * for it and every descendant. True when there was anything to settle.
   *
   * The claims go to the panes' damage alone (`WindowNode._paneDamage`):
   * the window paints none of a surface's children, and its pass under the
   * surface is one nobody sees.
   */
  settleMoves(root) {
    const moves = this.moves;
    if (moves.length === 0) return false;
    this.moves = [];
    // the panes repaint whole this frame: nothing is owed
    if (!root || root.destroyed || root._paneDamage === FULL_DAMAGE) {
      return true;
    }
    const surface = this.area._geometry();
    let best = null;
    let most = 0;
    for (const move of moves) {
      const shown = intersectRects(whole(move.reach), surface);
      const size = shown ? rectArea(shown) : 0;
      if (size > most) {
        best = move;
        most = size;
      }
    }
    // the others first: the pixels they claim are ones the copy may carry,
    // and `_blitMove` repairs whatever the frame claims by then
    for (const move of moves) if (move !== best) this._claimMove(root, move);
    if (best && !this._blitMove(root, best)) this._claimMove(root, best);
    return true;
  }

  /** Where a move's child was and where it is, claimed the ordinary way —
   * cut to the surface's box, which clips the children (`clipsChildren`). */
  _claimMove(root, { node, reach }) {
    const box = this.area.abs;
    for (const rect of [reach, node.paintBounds()]) {
      const claim = intersectRects(rect, box);
      if (claim) root._addPaneDamage(claim);
    }
  }

  /**
   * Move a child's pixels on its pane, and narrow what the frame owes the
   * move to what the copy cannot supply. True when it did; false leaves
   * the pane and the frame's damage as they were, for `_claimMove`.
   *
   * The copy is of what the child showed, moved as far as the child moved
   * and kept where it is still on show (`dest`). That is right wherever
   * the child's own drawing is the only thing that changed — and the frame
   * repaints the rest:
   *
   * - what the child uncovered, and whatever of its new reach the copy did
   *   not land on: its reach before and after, less `dest`;
   * - the other children: the pixels of theirs the copy carried off with
   *   the child's, and theirs that the copy covered — over the child or
   *   under it, their own pixels are not a shift away;
   * - what the panes are owed already, where the copy would carry it: a
   *   claim is often a rect named before layout ran, and when it was
   *   inside the child its content went with the copy. Repainted shifted
   *   as well as where it stands, which is right whichever it was. A
   *   claim that cannot reach the panes is not in their list
   *   (`WindowNode._paneReach`) — a graph pane under the surface that
   *   claims itself whole on every step of the pan this copy is.
   *
   * Past `MOVE_BLIT_MAX_REPAINT` of `dest` those repaint most of what the
   * copy saves, and the plain claims have the frame.
   */
  _blitMove(root, { node, reach, dx, dy }) {
    if (NO_BLIT || !Number.isInteger(dx) || !Number.isInteger(dy)) {
      return false;
    }
    const area = this.area;
    // a rounded surface clips its children to an arc, and the arc stays put
    if ((area.style?.borderRadius ?? 0) > 0) return false;
    // the whole pixels of the surface's box: a fractional edge is an
    // antialiased clip, and that does not move either
    const box = innerPixels(area.abs);
    if (!box) return false;
    const was = intersectRects(whole(reach), box);
    const now = intersectRects(whole(node.paintBounds()), box);
    // nothing of it was on show, so there is nothing to carry
    if (!was) return false;
    const pane = this.panes.find(
      (p) => p.canBlit(was) && (!now || p.canBlit(now)),
    );
    if (!pane) return false;
    const view = intersectRects(pane.rect, box);
    const dest = intersectRects(shifted(was, dx, dy), view);
    if (!dest) return false;
    const cap = root._damageRectCap();
    const claimed = root._paneDamage ?? [];
    let rects = claimed;
    const add = (rect) => {
      if (rect) rects = addDamageRect(rects, rect, cap);
    };
    for (const claim of claimed)
      add(intersectRects(shifted(claim, dx, dy), dest));
    for (const piece of subtractRect(was, dest)) add(piece);
    if (now) for (const piece of subtractRect(now, dest)) add(piece);
    for (const other of area.paintOrder()) {
      if (other === node) continue;
      const theirs = whole(other.paintBounds());
      add(intersectRects(theirs, dest));
      add(intersectRects(shifted(theirs, dx, dy), dest));
    }
    // the list is disjoint, so the sum is the area it covers
    let repainted = 0;
    for (const rect of rects) {
      const inside = intersectRects(rect, dest);
      if (inside) repainted += rectArea(inside);
    }
    if (repainted > rectArea(dest) * MOVE_BLIT_MAX_REPAINT) return false;
    // the verb moves the band that survives inside the rect it is handed,
    // so handed where the pixels are and where they go, that band is `dest`
    if (!pane.blit(unionRect(shifted(dest, -dx, -dy), dest), dx, dy)) {
      return false;
    }
    root._paneDamage = rects;
    return true;
  }

  /**
   * Paint what the frame owes: every pane whole after it was made, resized
   * or lost its pixels, and otherwise the frame's damage cut to each pane —
   * `null` damage meaning the whole window, as it does for the paint walk.
   *
   * Each pass is the window's own paint walk over the children, translated
   * so the pane's corner is the bitmap's, clipped to the pass, with
   * `paintDamage()` naming it — the same culling, the same paint cache, the
   * same everything as a pass over the window, and in its coordinates.
   */
  paint(damage) {
    for (const pane of this.panes) {
      let passes;
      if (pane.full || !damage) {
        passes = [pane.rect];
      } else {
        passes = [];
        for (const rect of damage) {
          const hit = intersectRects(rect, pane.rect);
          if (hit) passes.push(hit);
        }
      }
      const blitted = pane.blitted;
      pane.blitted = false;
      pane.placed = false;
      if (passes.length === 0) {
        // pixels moved and nothing else owed: they still go out
        if (blitted) pane.wnd.present?.();
        continue;
      }
      pane.full = false;
      this._paintPane(pane, passes);
    }
  }

  _paintPane(pane, passes) {
    const area = this.area;
    const root = area.root;
    const ctx = pane.context();
    if (!ctx || !root) return;
    // an opaque pane is filled with what the surface starts its frames from;
    // a composited one is cleared, and shows the frame itself
    const ground = pane.transparent ? null : groundOf(area.props);
    ctx.save();
    try {
      ctx.translate(-pane.rect.x, -pane.rect.y);
      for (const pass of passes) {
        ctx.save();
        try {
          ctx.beginPath();
          ctx.rect(pass.x, pass.y, pass.width, pass.height);
          ctx.clip();
          if (ground) {
            ctx.fillStyle = ground;
            ctx.fillRect(pass.x, pass.y, pass.width, pass.height);
          } else {
            ctx.clearRect(pass.x, pass.y, pass.width, pass.height);
          }
          root._paintDamage = pass;
          area._paintChildren(ctx);
        } finally {
          root._paintDamage = null;
          ctx.restore();
        }
      }
    } finally {
      ctx.restore();
    }
    // A layer's contents are a copy the bitmap is pushed to; an X window's
    // backing store is blitted by ntk on its own, from the paint above
    pane.wnd.present?.();
  }

  /** Unmapped now; `sync` drops them on the frame the hide lays out. */
  setHidden(hidden) {
    for (const pane of this.panes) pane.show(!hidden);
  }

  destroy() {
    for (const pane of this.panes) pane.destroy();
    this.panes = [];
  }
}
