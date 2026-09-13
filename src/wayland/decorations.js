// Client-side decorations: the titlebar, borders and resize edges a window
// has to draw for itself.
//
// On X11 the window manager frames every toplevel. On Wayland the
// compositor *may* — `xdg-decoration` lets a client ask for server-side
// decorations — but GNOME's mutter does not advertise that protocol at all,
// and it is the desktop this backend was developed against. So a window
// without decorations of its own on GNOME is a bare rectangle: no title, no
// close button, no edge to drag. This is the minimum that makes one usable,
// drawn with the same 2d context the content is, and it is deliberately
// plain: a toolkit's chrome should not have opinions its applications did
// not ask for.
//
// The geometry is: the titlebar above the content, a hairline border round
// everything, and an invisible resize band along each edge and corner that
// reaches a few pixels *outside* the border (the way every desktop's window
// frames do — a 1px border is not something anyone can hit). The
// compositor's surface is therefore larger than the content by the frame,
// and `xdg_surface.set_window_geometry` tells it which part is the window;
// the rest is treated as shadow/margin and not counted for placement or
// tiling.
//
// Interaction is entirely requests: a titlebar press starts
// `xdg_toplevel.move`, an edge press starts `xdg_toplevel.resize` with the
// matching edge, a double-click toggles maximised, a right-click asks for
// the compositor's window menu. The client never moves anything itself.

import { RESIZE_EDGE, TOPLEVEL_STATE } from './window.js';

export const TITLEBAR_HEIGHT = 36;
export const BORDER = 1;
/** how far outside the visible border a resize grab still lands */
export const RESIZE_MARGIN = 8;
const BUTTON = 14;
const BUTTON_GAP = 12;

export const THEME = {
  active: { bar: '#2b2f3a', text: '#e8eaf0', border: '#3a4050' },
  inactive: { bar: '#22252e', text: '#8b93a7', border: '#2c3140' },
  close: '#e5484d',
  maximize: '#f5a623',
  minimize: '#45a85a',
  glyph: '#1a1a1a',
};

export class Decorations {
  /**
   * @param {object} opts
   * @param {boolean} [opts.enabled=true]
   * @param {number} [opts.scale=1]
   */
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
    this.title = '';
    this.active = false;
    this.maximized = false;
    this.fullscreen = false;
    this.hover = null; // 'close' | 'maximize' | 'minimize' | null
    this.pressed = null;
  }

  /** The frame's insets around the content, in logical pixels. */
  insets() {
    if (!this.enabled || this.fullscreen)
      return { top: 0, left: 0, right: 0, bottom: 0 };
    const b = this.maximized ? 0 : BORDER;
    return { top: TITLEBAR_HEIGHT + b, left: b, right: b, bottom: b };
  }

  /** How much bigger than the content the surface is. */
  extra() {
    const i = this.insets();
    return { width: i.left + i.right, height: i.top + i.bottom };
  }

  /** The window geometry to report: the frame without the resize margin. */
  geometry(surfaceWidth, surfaceHeight) {
    return { x: 0, y: 0, width: surfaceWidth, height: surfaceHeight };
  }

  setState(states) {
    this.maximized =
      states.has(TOPLEVEL_STATE.MAXIMIZED) ||
      [...states].some(
        (s) =>
          s >= TOPLEVEL_STATE.TILED_LEFT && s <= TOPLEVEL_STATE.TILED_BOTTOM,
      );
    this.fullscreen = states.has(TOPLEVEL_STATE.FULLSCREEN);
    this.active = states.has(TOPLEVEL_STATE.ACTIVATED);
  }

  _buttons(width) {
    const i = this.insets();
    const cy = i.top - TITLEBAR_HEIGHT / 2 - (this.maximized ? 0 : 0);
    const right = width - i.right - BUTTON_GAP - BUTTON / 2;
    return [
      { id: 'close', cx: right, cy, color: THEME.close },
      {
        id: 'maximize',
        cx: right - (BUTTON + BUTTON_GAP),
        cy,
        color: THEME.maximize,
      },
      {
        id: 'minimize',
        cx: right - 2 * (BUTTON + BUTTON_GAP),
        cy,
        color: THEME.minimize,
      },
    ];
  }

  /**
   * What is under a surface-local point: a resize edge, a titlebar button,
   * the titlebar itself, or the content.
   *
   * @returns {{kind:'content'}|{kind:'titlebar'}|{kind:'button',id:string}|{kind:'resize',edges:number}}
   */
  hitTest(x, y, width, height) {
    if (!this.enabled || this.fullscreen) return { kind: 'content' };
    const i = this.insets();
    if (!this.maximized) {
      const m = RESIZE_MARGIN;
      let edges = 0;
      if (x < m) edges |= RESIZE_EDGE.LEFT;
      else if (x >= width - m) edges |= RESIZE_EDGE.RIGHT;
      if (y < m) edges |= RESIZE_EDGE.TOP;
      else if (y >= height - m) edges |= RESIZE_EDGE.BOTTOM;
      if (edges) return { kind: 'resize', edges };
    }
    if (y < i.top) {
      for (const b of this._buttons(width)) {
        if (Math.abs(x - b.cx) <= BUTTON && Math.abs(y - b.cy) <= BUTTON)
          return { kind: 'button', id: b.id };
      }
      return { kind: 'titlebar' };
    }
    return { kind: 'content' };
  }

  /** The cursor for a hit. */
  static cursorFor(hit) {
    if (hit.kind !== 'resize') return 'default';
    const e = hit.edges;
    if (e === RESIZE_EDGE.TOP_LEFT || e === RESIZE_EDGE.BOTTOM_RIGHT)
      return 'nwse-resize';
    if (e === RESIZE_EDGE.TOP_RIGHT || e === RESIZE_EDGE.BOTTOM_LEFT)
      return 'nesw-resize';
    if (e === RESIZE_EDGE.LEFT || e === RESIZE_EDGE.RIGHT) return 'ew-resize';
    return 'ns-resize';
  }

  /**
   * Draw the frame. `width`/`height` are the surface size in logical
   * pixels; the context's transform already carries the output scale.
   */
  paint(ctx, width, height, textShaper) {
    if (!this.enabled || this.fullscreen) return;
    const i = this.insets();
    const t = this.active ? THEME.active : THEME.inactive;

    // border
    if (!this.maximized) {
      ctx.fillStyle = t.border;
      ctx.fillRect(0, 0, width, BORDER);
      ctx.fillRect(0, height - BORDER, width, BORDER);
      ctx.fillRect(0, 0, BORDER, height);
      ctx.fillRect(width - BORDER, 0, BORDER, height);
    }
    // titlebar
    ctx.fillStyle = t.bar;
    ctx.fillRect(
      i.left,
      i.top - TITLEBAR_HEIGHT,
      width - i.left - i.right,
      TITLEBAR_HEIGHT,
    );

    // buttons
    for (const b of this._buttons(width)) {
      ctx.beginPath();
      ctx.roundRect(
        b.cx - BUTTON / 2,
        b.cy - BUTTON / 2,
        BUTTON,
        BUTTON,
        BUTTON / 2,
      );
      ctx.fillStyle = this.active || this.hover === b.id ? b.color : t.border;
      ctx.fill();
      if (this.hover === b.id) {
        ctx.fillStyle = THEME.glyph;
        const s = 3;
        if (b.id === 'close') {
          ctx.fillRect(b.cx - s, b.cy - 0.5, s * 2, 1);
          ctx.fillRect(b.cx - 0.5, b.cy - s, 1, s * 2);
        } else if (b.id === 'maximize') {
          ctx.fillRect(b.cx - s, b.cy - s, s * 2, 1);
          ctx.fillRect(b.cx - s, b.cy + s - 1, s * 2, 1);
          ctx.fillRect(b.cx - s, b.cy - s, 1, s * 2);
          ctx.fillRect(b.cx + s - 1, b.cy - s, 1, s * 2);
        } else {
          ctx.fillRect(b.cx - s, b.cy - 0.5, s * 2, 1);
        }
      }
    }

    // title
    if (this.title && textShaper) {
      const label = textShaper(this.title, 13, 600);
      if (label) {
        const buttonsLeft =
          width - i.right - 3 * (BUTTON + BUTTON_GAP) - BUTTON_GAP;
        const avail = buttonsLeft - i.left - 12;
        const x = Math.max(
          i.left + 12,
          i.left + (width - i.left - i.right - label.width) / 2,
        );
        ctx.save();
        ctx.beginPath();
        ctx.rect(
          i.left + 12,
          i.top - TITLEBAR_HEIGHT,
          Math.max(0, avail),
          TITLEBAR_HEIGHT,
        );
        ctx.clip();
        ctx.translate(
          Math.min(x, buttonsLeft - label.width - 12),
          i.top - TITLEBAR_HEIGHT / 2 + label.ascent / 2 - 2,
        );
        ctx.drawTextRuns(label.runs.map((r) => ({ ...r, color: t.text })));
        ctx.restore();
      }
    }
  }
}
