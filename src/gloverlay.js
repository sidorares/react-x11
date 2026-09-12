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
//
// A pane selects no input, so the pointer over one reaches the owning window
// by the same propagation that brings it the pointer over the surface
// (src/glnodes.js, `_create`), and lands on the child it is over.
//
// A leaf module, like src/embedding.js: `appcontext.js` asks `canOverlay`
// for `useSupports('glOverlay')`, and it imports nothing of ours.
import { cssColorStraight } from 'ntk';

// ConfigureWindow's stack mode: directly above the sibling it names
const STACK_ABOVE = 0;

/**
 * Whether the children of a `<glarea>` can be drawn over its surface on this
 * connection: a backend that composites a pane itself, or one that can make
 * the plain child window a pane is on X11. One function for the element and
 * for `useSupports('glOverlay')`, which have to agree — the rule `canEmbed`
 * follows for `<foreign>`.
 */
export function canOverlay(app) {
  return (
    typeof app?.createOverlayPane === 'function' ||
    typeof app?.createWindow === 'function'
  );
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

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null;
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
    const reach = intersect(whole(child._subtreeBounds()), surface);
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
    this.rect = rect;
    if (typeof this.wnd.setState === 'function') this.wnd.setState(rect);
    else {
      this.wnd.move?.(rect.x, rect.y);
      this.wnd.resize?.(rect.width, rect.height);
    }
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
      root.invalidate(false, { ...pane.rect }, 'expose');
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
          const hit = intersect(rect, pane.rect);
          if (hit) passes.push(hit);
        }
        if (passes.length === 0) continue;
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
