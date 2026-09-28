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
//   enough for what it holds, one per child, and the surface shows between
//   them. Inside a pane the ground is the surface's `clearColor` — the
//   colour its frames start from — so a pixel a child leaves unpainted there
//   (a rounded corner, a translucent background, text with no box behind
//   it) shows that colour, never the GL frame.
//
//   One pane per child, kept by the child, and holding that child and what
//   is under it where the two meet — never what is over it (`_paintPane`).
//   Two children that overlap keep a pane each, stacked in their order, the
//   upper one holding the lower one's pixels where they meet. So a card
//   dragged across another moves its own pane and leaves the other one's
//   alone: nothing the other holds changed. Panes used to be one per region
//   the children reached, overlapping ones merged, handed out by position in
//   a list — and a card dragged into a neighbour's reach re-cut the regions,
//   so every pane after it in the list went to someone else's place with
//   that someone's pixels in it, for a frame, on every step.
//
//   A pane's window takes a new place and the pixels that go there together
//   (`X11PaneWindow`), and keeps its contents in the server while it is
//   mapped, as the surface's window does (src/glnodes.js): a pane or a
//   frame another pane moves off is put back by the server at once, not
//   after an Expose and a repaint.
//
//   A window per child rather than one window shaped by the SHAPE
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
// a child instead of claiming it (`GlAreaNode._absolutizeChild`). On X11 its
// pane goes with it, and the window's move carries its pixels; on a
// composited backend the frame moves them inside the one pane —
// `scrollRegion`, the verb the scroll blit uses on a window. Either way the
// frame repaints only what the move uncovered and what it now overlaps
// differently (`settleMoves`). A pan over a graph's mounted node bodies is
// that frame, sixty times a second.
//
// A leaf module, like src/embedding.js: `appcontext.js` asks `canOverlay`
// for `useSupports('glOverlay')`, and it imports nothing of ours but the
// damage model's arithmetic, which imports nothing at all.
import { cssColorStraight } from 'ntk/color';

import { FULL_DAMAGE, addDamageRect } from './nodes/damage.js';
import {
  innerPixels,
  intersectRects,
  outside,
  rectArea,
  rectContains,
  shiftRect,
  unionRect,
} from './nodes/rects.js';

// ConfigureWindow's stack mode: directly above the sibling it names
const STACK_ABOVE = 0;

// How many rects one pane's own list keeps before merging the closest pair
// (`Pane.owe`): each is a pass over that pane alone, which is small.
const OWED_CAP = 4;

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
 * A backend saying nothing can be drawn over a GL surface on this app, and
 * why: one whose child windows are not X windows, and that has no
 * composited pane either — on Windows a window with a parent is a GL
 * surface of its own (src/win32/glarea.js), and a bridge without layers has
 * nothing else to offer. Before the first render, like `beginGlOverlay`, so
 * `useSupports('glOverlay')` never changes its answer.
 */
export function refuseOverlay(app, reason) {
  if (app) refusals.set(app, reason);
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

const sameRect = (a, b) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** On screen: nothing from here to the window hidden or `display: 'none'`. */
function shown(node) {
  for (let n = node; n; n = n.parent) {
    if (n.destroyed || n.hidden || n.style?.display === 'none') return false;
    if (n.isWindow) break;
  }
  return true;
}

/**
 * Where each child puts ink, in paint order: its reach in whole pixels, cut
 * to the surface — the rect of the X11 pane that is that child's. Two that
 * overlap keep a rect each (see the header).
 *
 * The reach is `_subtreeBounds()`, the rect the damage model culls against —
 * so a child's shadow, its outline and a descendant that sticks out of it
 * are all inside its pane.
 */
export function childRegions(area, surface) {
  const regions = [];
  for (const child of area.paintOrder()) {
    const rect = intersectRects(whole(child._subtreeBounds()), surface);
    if (rect) regions.push({ node: child, rect });
  }
  return regions;
}

// ChangeWindowAttributes' backing-store value: the server keeps what the
// window shows while it is mapped
const BACKING_STORE_WHEN_MAPPED = 1;
// a resize keeps what the window shows at its top-left corner rather than
// discarding it
const NORTH_WEST_GRAVITY = 1;
// a background of None: an exposure shows what was there, not a fill colour
const NO_BACKGROUND = 0;
// The step an X11 pane's pixmap grows in. A pane whose child is zooming is
// a new size every frame, and a pixmap and its picture made per frame per
// pane is a round of requests for nothing; within the step the one it has
// does.
const PIXMAP_STEP = 64;

/**
 * An X11 pane's drawable: a plain child window of the owning window, and a
 * pixmap the pane is painted in — its double buffer — with the verbs a pane
 * asks of its window (`Pane`).
 *
 * Not an ntk window's own backing store, because of *when* that shows. ntk
 * presents a backing store on its own schedule — the next vblank, through
 * Present — while a window moves and resizes the moment its ConfigureWindow
 * reaches the server. So a pane that went somewhere else showed its old
 * pixels in the new place for a frame, and one that grew was shown cut to
 * the size ntk had not heard back about yet. Here the geometry waits for
 * the paint: `present` sends the ConfigureWindow and the CopyArea of what
 * was painted back to back, and the server applies the move and the pixels
 * that go with it together.
 *
 * The window keeps its contents in the server while it is mapped (X backing
 * store), so what a pane moving off another uncovers is put back at once;
 * its background is None, so an exposure it does get is filled from the
 * pixmap with nothing flashed first; and a resize keeps what it shows at
 * the corner until the copy lands.
 */
export class X11PaneWindow {
  /** Whether the app is one this can be made on: an ntk connection. */
  static usable(app) {
    return (
      typeof app?.X?.CopyArea === 'function' &&
      typeof app.createPixmap === 'function' &&
      typeof app.createWindow === 'function'
    );
  }

  constructor(app, owner, rect) {
    this.app = app;
    this.X = app.X;
    // where the window is on the server, and where the next present puts it
    this.rect = { ...rect };
    this._next = null;
    // mapped once there is something to show, and while the pane is shown
    this._mapped = false;
    this._shown = false;
    this._painted = false;
    // pane-local rects painted since the last present
    this._owed = [];
    this.window = app.createWindow({
      parent: owner,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      // ntk's double buffer, which this replaces — not X's backing store
      backingStore: false,
      backgroundPixmap: NO_BACKGROUND,
      bitGravity: NORTH_WEST_GRAVITY,
    });
    this.id = this.window.id;
    this.depth =
      this.window.depth || owner.depth || app.display.screen[0].root_depth;
    this.X.ChangeWindowAttributes(this.id, {
      backingStore: BACKING_STORE_WHEN_MAPPED,
    });
    this._gc = this.X.AllocID();
    this.X.CreateGC(this._gc, this.id, { graphicsExposures: 0 });
    this._pixmap = null;
    this._ctx = null;
    this._grow(rect.width, rect.height);
    // An exposure the server could not fill from its own copy — one with no
    // backing store, or one that let it go — is filled from the pixmap.
    // Adding the listener is what selects Exposure (ntk).
    this.window.on('expose', (ev) => {
      if (this._painted) this._copy([ev]);
    });
  }

  /** What a pane asks of its window's event selection: none of the pointer. */
  get eventMask() {
    return this.window.eventMask;
  }

  /** A pane asks for the context every pass: it is the pixmap's, and a pane
   *  that grew past its pixmap has a new one. */
  get ownsContext() {
    return true;
  }

  /** Whether a present is owed without a paint: a place to take, or pixels
   *  a blit moved. */
  get presentOwed() {
    return this._next !== null || this._owed.length !== 0 || !this._mapped;
  }

  getContext(name) {
    if (name !== '2d') return null;
    return (this._ctx ??= this._pixmap.getContext('2d'));
  }

  /** A pixmap at least `width`×`height`, grown in steps and never shrunk. */
  _grow(width, height) {
    const cur = this._pixmap;
    if (cur && cur.width >= width && cur.height >= height) return;
    const up = (v) =>
      Math.max(PIXMAP_STEP, Math.ceil(v / PIXMAP_STEP) * PIXMAP_STEP);
    const next = this.app.createPixmap({
      parent: this.window,
      width: up(Math.max(width, cur?.width ?? 0)),
      height: up(Math.max(height, cur?.height ?? 0)),
      depth: this.depth,
      // the window's pixels, read through the window's visual
      visual: this.window.visualId,
    });
    cur?.destroy();
    this._pixmap = next;
    this._ctx = null;
    // what the old pixmap held is gone: the pane is painted whole next
    this._painted = false;
  }

  /** Where the next present puts the window. A new size may be a new
   *  pixmap, which the pane paints whole anyway (`Pane.place`). */
  setState(rect) {
    this._next = { ...rect };
    this._grow(rect.width, rect.height);
  }

  /** Pixels painted at `rect`, pane-local, for the next present to show. */
  owe(rect) {
    this._owed.push(rect);
    this._painted = true;
  }

  /**
   * `Window.scrollRegion`'s contract, on the pixmap: the band of `rect`
   * (pane-local) that survives the shift moves, and all of `rect` is owed
   * to the window at the next present.
   */
  scrollRegion(rect, dx, dy) {
    if (!this._painted) return false;
    if (
      !Number.isInteger(dx) ||
      !Number.isInteger(dy) ||
      (dx === 0 && dy === 0)
    ) {
      return false;
    }
    const { width, height } = this._next ?? this.rect;
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
    const dstX0 = Math.max(x0, x0 + dx);
    const dstY0 = Math.max(y0, y0 + dy);
    const dstX1 = Math.min(x1, x1 + dx);
    const dstY1 = Math.min(y1, y1 + dy);
    if (dstX1 <= dstX0 || dstY1 <= dstY0) return false;
    const id = this._pixmap.id;
    this.X.CopyArea(
      id,
      id,
      this._gc,
      dstX0 - dx,
      dstY0 - dy,
      dstX0,
      dstY0,
      dstX1 - dstX0,
      dstY1 - dstY0,
    );
    this.owe({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    return true;
  }

  /**
   * Show what was painted, where it goes: the ConfigureWindow of a new place,
   * the map of a pane shown for the first time, and the copies of what was
   * painted since, back to back — one batch the server applies together.
   */
  present() {
    const X = this.X;
    const next = this._next;
    if (next) {
      this._next = null;
      const change = {};
      if (next.x !== this.rect.x) change.x = next.x;
      if (next.y !== this.rect.y) change.y = next.y;
      if (next.width !== this.rect.width) change.width = next.width;
      if (next.height !== this.rect.height) change.height = next.height;
      this.rect = next;
      if (Object.keys(change).length !== 0) X.ConfigureWindow(this.id, change);
    }
    if (!this._painted) return;
    if (this._shown && !this._mapped) {
      X.MapWindow(this.id);
      this._mapped = true;
    }
    const owed = this._owed;
    this._owed = [];
    this._copy(owed);
  }

  /** The pixmap's pixels at `rects` (pane-local), onto the window. */
  _copy(rects) {
    const { width, height } = this.rect;
    for (const r of rects) {
      const x0 = Math.max(0, Math.floor(r.x));
      const y0 = Math.max(0, Math.floor(r.y));
      const x1 = Math.min(width, Math.ceil(r.x + r.width));
      const y1 = Math.min(height, Math.ceil(r.y + r.height));
      if (x1 <= x0 || y1 <= y0) continue;
      this.X.CopyArea(
        this._pixmap.id,
        this.id,
        this._gc,
        x0,
        y0,
        x0,
        y0,
        x1 - x0,
        y1 - y0,
      );
    }
  }

  map() {
    this._shown = true;
    // a pane with nothing painted yet is mapped by the present that shows it
    if (this._painted && !this._mapped) {
      this.X.MapWindow(this.id);
      this._mapped = true;
      this._copy([
        { x: 0, y: 0, width: this.rect.width, height: this.rect.height },
      ]);
    }
  }

  unmap() {
    this._shown = false;
    if (!this._mapped) return;
    this.X.UnmapWindow(this.id);
    this._mapped = false;
  }

  destroy() {
    this.window.destroy?.();
    this._pixmap?.destroy();
    this._pixmap = null;
    this._ctx = null;
    try {
      this.X.FreeGC(this._gc);
    } catch {
      // the connection is closing, and takes the GC with it
    }
  }
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
  /**
   * @param node the child an X11 pane is kept by and holds, up to — null for
   *   a composited pane, which holds every child
   * @param overlay the panes it is one of, which `canBlit` asks about
   */
  constructor(wnd, rect, transparent, node = null, overlay = null) {
    this.wnd = wnd;
    this.rect = rect;
    this.transparent = transparent;
    this.node = node;
    this.overlay = overlay;
    this.full = true;
    this.ctx = null;
    // placed this frame: what the pane holds is where the children were in
    // the pane's own corner, not in the window, so nothing in it is a known
    // shift away from where it goes
    this.placed = false;
    // moved pixels this frame, which has to reach the screen even when no
    // pass follows it (`GlOverlay.paint`)
    this.blitted = false;
    // what this pane alone is owed this frame, beside the damage every pane
    // is cut from: the pixels a moved child's pane carried wrongly, or the
    // ones of it a pane over it holds (`_settleMove`)
    this.owed = [];
    // X11: placed this frame by exactly its child's move, which the window's
    // move carried (`_syncChildren`, `_settleCarried`)
    this.carried = false;
  }

  context() {
    // an X11 pane's is its pixmap's, which a pane that grew has a new one of
    if (this.wnd.ownsContext) return this.wnd.getContext('2d');
    if (!this.ctx && typeof this.wnd.getContext === 'function') {
      this.ctx = this.wnd.getContext('2d');
    }
    return this.ctx;
  }

  /** One rect more for this pane alone, window coordinates. */
  owe(rect) {
    const hit = rect && intersectRects(rect, this.rect);
    if (hit) this.owed = addDamageRect(this.owed, hit, OWED_CAP);
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
   *
   * A child's pane on X11 is not the only one holding those pixels: every
   * pane over it that reaches into `rect` holds a copy, which the move
   * leaves where it was. Those are owed `rect` (`owe`), so they repaint
   * what they hold of it.
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
    const panes = this.node ? this.overlay?.panes : null;
    if (panes) {
      for (let i = panes.indexOf(this) + 1; i < panes.length; i++) {
        panes[i].owe(rect);
      }
    }
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
    // bottom to top: the children's order on X11, one pane each
    this.panes = [];
    // X11: each child's pane, kept by the child for as long as it has one
    this.byNode = new Map();
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
    const visible = shown(area) && abs.width > 0 && abs.height > 0;
    // the surface's own rect, rounded the way its window's is
    const surface = visible ? area._geometry() : null;
    if (!this.composited) return this._syncChildren(surface);
    const rects = surface && area.paintOrder().length ? [surface] : [];
    let changed = false;
    while (this.panes.length > rects.length) {
      this.panes.pop().destroy();
      changed = true;
    }
    for (let i = 0; i < rects.length; i++) {
      const pane = this.panes[i];
      if (!pane) {
        this.panes.push(this._makePane(rects[i], null));
        changed = true;
      } else if (!sameRect(pane.rect, rects[i])) {
        pane.place(rects[i]);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * `sync` on X11: a pane per child, kept by the child. A child that is new
   * gets one, a child that went takes its with it, and one whose reach moved
   * has its pane placed there — and painted whole, unless the move was the
   * child's own and nothing else, which the window's move carries
   * (`_settleMove` repaints what it does not). A change of order restacks
   * them, and repaints whichever overlap another: what a pane holds is what
   * is under its child.
   */
  _syncChildren(surface) {
    const regions = surface ? childRegions(this.area, surface) : [];
    const moved = new Map();
    for (const move of this.moves) moved.set(move.node, move);
    const next = [];
    let changed = false;
    let made = false;
    const kept = new Set();
    for (const pane of this.panes) pane.carried = false;
    for (const { node, rect } of regions) {
      let pane = this.byNode.get(node);
      if (!pane) {
        pane = this._makePane(rect, node);
        this.byNode.set(node, pane);
        made = changed = true;
      } else if (!sameRect(pane.rect, rect)) {
        const move = moved.get(node);
        const carried =
          move !== undefined &&
          !pane.full &&
          rect.width === pane.rect.width &&
          rect.height === pane.rect.height &&
          rect.x === pane.rect.x + move.dx &&
          rect.y === pane.rect.y + move.dy;
        pane.place(rect);
        if (carried) pane.carried = true;
        else pane.full = true;
        changed = true;
      }
      kept.add(node);
      next.push(pane);
    }
    for (const [node, pane] of this.byNode) {
      if (kept.has(node)) continue;
      pane.destroy();
      this.byNode.delete(node);
      changed = true;
    }
    const reordered =
      next.length !== this.panes.length ||
      next.some((pane, i) => pane !== this.panes[i]);
    this.panes = next;
    if (reordered) {
      this.restack();
      if (!made) {
        // what each pane holds is its child and what is under it: a new
        // order is new contents wherever two of them meet
        for (const pane of next) {
          if (
            next.some(
              (other) => other !== pane && overlaps(other.rect, pane.rect),
            )
          ) {
            pane.full = true;
          }
        }
      }
      changed = true;
    }
    return changed;
  }

  _makePane(rect, node) {
    const owner = this.area.root.window;
    const attributes = { parent: owner, ...rect };
    let wnd;
    if (this.composited) wnd = this.app.createOverlayPane(attributes);
    else if (X11PaneWindow.usable(this.app)) {
      // a child window and its own double buffer, selecting nothing but the
      // exposures a pixmap answers — the pointer is the tree's
      wnd = new X11PaneWindow(this.app, owner, rect);
    } else {
      // an app with no X connection to speak for itself — the headless mock
      // — makes its panes as plain windows
      wnd = this.app.createWindow(attributes);
    }
    const pane = new Pane(wnd, rect, this.composited, node, this);
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
    if (!this.composited) {
      // Each child's move is its own pane's to settle: carried by the
      // window's move where its pane went with it, moved on the pane where
      // the pane stayed — cut to the surface, say, which a box bigger than
      // it is — or claimed.
      const reaches = new Map();
      for (const move of moves) reaches.set(move.node, move.reach);
      for (const move of moves) {
        const own = this.byNode.get(move.node);
        if (own?.carried) this._settleCarried(move, reaches);
        else if (!own || !this._blitMove(root, move, own)) {
          this._claimMove(root, move);
        }
      }
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

  /**
   * A child that only moved, on X11, whose pane went with it (`sync`): what
   * each pane is owed for it, and nothing in the frame's damage, which every
   * pane is cut from.
   *
   * - Its own pane: the window's move brought the child's pixels and the
   *   ground around them, which is one colour, and took along whatever of
   *   the children under it the pane held. Those are owed where they are
   *   now and where the move put their old pixels — and when nothing is
   *   under it, nothing is, which is a card dragged through open graph: one
   *   ConfigureWindow a step.
   * - The panes over it, which hold its pixels where they meet it: where it
   *   was, and where it is.
   * - The panes under it hold nothing of it, and are owed nothing.
   */
  _settleCarried({ node, reach, dx, dy }, reaches) {
    const panes = this.panes;
    const at = panes.indexOf(this.byNode.get(node));
    const own = panes[at];
    const order = this.area.paintOrder();
    const upTo = order.indexOf(node);
    for (let i = 0; i < upTo; i++) {
      const under = order[i];
      const bounds = [whole(under.paintBounds())];
      // one that moved this frame as well was somewhere else in the pane
      const before = reaches.get(under);
      if (before) bounds.push(whole(before));
      for (const b of bounds) {
        own.owe(b);
        own.owe(shiftRect(b, dx, dy));
      }
    }
    const was = whole(reach);
    const now = whole(node.paintBounds());
    for (let i = at + 1; i < panes.length; i++) {
      panes[i].owe(was);
      panes[i].owe(now);
    }
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
  _blitMove(root, { node, reach, dx, dy }, own = null) {
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
    // the child's own pane on X11, the one over the whole surface elsewhere
    const pane = own
      ? own.canBlit(was) && (!now || own.canBlit(now))
        ? own
        : null
      : this.panes.find((p) => p.canBlit(was) && (!now || p.canBlit(now)));
    if (!pane) return false;
    const view = intersectRects(pane.rect, box);
    const dest = intersectRects(shiftRect(was, dx, dy), view);
    if (!dest) return false;
    const cap = root._damageRectCap();
    const claimed = root._paneDamage ?? [];
    let rects = claimed;
    const add = (rect) => {
      if (rect) rects = addDamageRect(rects, rect, cap);
    };
    for (const claim of claimed)
      add(intersectRects(shiftRect(claim, dx, dy), dest));
    for (const piece of outside(was, dest)) add(piece);
    if (now) for (const piece of outside(now, dest)) add(piece);
    // the children whose pixels the pane holds: every other one on a pane
    // over the whole surface, and on X11 the ones under this child — the
    // panes over it are owed the copy by `Pane.blit`
    const order = area.paintOrder();
    const upTo = own ? order.indexOf(node) : order.length;
    for (let i = 0; i < upTo; i++) {
      const other = order[i];
      if (other === node) continue;
      const theirs = whole(other.paintBounds());
      add(intersectRects(theirs, dest));
      add(intersectRects(shiftRect(theirs, dx, dy), dest));
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
    if (!pane.blit(unionRect(shiftRect(dest, -dx, -dy), dest), dx, dy)) {
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
          if (hit) passes = addDamageRect(passes, hit, OWED_CAP);
        }
        for (const rect of pane.owed) {
          passes = addDamageRect(passes, rect, OWED_CAP);
        }
      }
      pane.owed = [];
      const blitted = pane.blitted;
      pane.blitted = false;
      pane.placed = false;
      if (passes.length === 0) {
        // pixels moved, or a place to take, and nothing else owed: they
        // still go out
        if (blitted || pane.wnd.presentOwed) pane.wnd.present?.();
        continue;
      }
      pane.full = false;
      this._paintPane(pane, passes);
    }
  }

  _paintPane(pane, passes) {
    const area = this.area;
    const root = area.root;
    if (!root) return;
    // an opaque pane is filled with what the surface starts its frames from;
    // a composited one is cleared, and shows the frame itself
    const ground = pane.transparent ? null : groundOf(area.props);
    // one pass, drawn by a context in window coordinates
    const paintPass = (ctx, pass) => {
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
        // an X11 pane holds its child and what is under it, and never
        // what is over it — the pane over it holds that (see the header)
        area._paintChildren(ctx, pane.node);
      } finally {
        root._paintDamage = null;
        ctx.restore();
      }
    };
    if (typeof pane.wnd.paintPasses === 'function') {
      // A pane drawn a rect at a time — a DirectComposition surface hands
      // out a context per `BeginDraw`, valid until `EndDraw` — opens each
      // pass itself (src/win32/overlay.js), the way such a window takes its
      // frame through `presentFrame`.
      pane.wnd.paintPasses(passes, paintPass);
    } else {
      const ctx = pane.context();
      if (!ctx) return;
      ctx.save();
      try {
        ctx.translate(-pane.rect.x, -pane.rect.y);
        for (const pass of passes) paintPass(ctx, pass);
      } finally {
        ctx.restore();
      }
    }
    // What was painted goes out with the place it goes to (`X11PaneWindow`);
    // a layer's contents are a copy the bitmap is pushed to; an ntk window's
    // backing store is blitted by ntk on its own, from the paint above
    if (typeof pane.wnd.owe === 'function') {
      for (const pass of passes) {
        pane.wnd.owe({
          x: pass.x - pane.rect.x,
          y: pass.y - pane.rect.y,
          width: pass.width,
          height: pass.height,
        });
      }
    }
    pane.wnd.present?.();
  }

  /** Unmapped now; `sync` drops them on the frame the hide lays out. */
  setHidden(hidden) {
    for (const pane of this.panes) pane.show(!hidden);
  }

  destroy() {
    for (const pane of this.panes) pane.destroy();
    this.panes = [];
    this.byNode.clear();
  }
}
