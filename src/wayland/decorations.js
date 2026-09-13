// Client-side decorations: the frame a window draws for itself where the
// compositor will not — GNOME's mutter has no xdg-decoration at all, so
// without one a window there is a bare rectangle.
//
// It is drawn to look like the frames beside it, which on GNOME are
// libadwaita's: from what the desktop says (framestyle.js — the button
// layout, the title's font, what titlebar clicks mean; appearance.js — light
// or dark) and from a libadwaita 1.7 window measured on a GNOME 48 desktop:
//
//   - a headerbar 47px tall for an 11pt title and as tall as a bigger title
//     needs (48px for 23pt), a hairline under it, a 1px highlight along its
//     top in the dark scheme, 12px corners;
//   - the title bold in the interface font, centred across the window;
//   - window buttons as 24px circles 37px apart, the outermost centred 24px
//     from the edge, holding the icon theme's own 16px symbolic glyphs;
//   - a button is the bar mixed towards the text colour: 10% at rest, 15%
//     under the pointer, 30% pressed — which gives exactly the greys
//     measured, in both schemes and both focus states;
//   - an unfocused window's text at half strength over a flatter bar;
//   - a soft shadow, larger for the focused window, cast downward.
//
// The shadow is drawn in a margin round the window that is part of the
// surface and not of the window: `set_window_geometry` excludes it, the
// input region stops a resize band into it, and a maximised or tiled window
// has none (window.js owns that boundary; `marginsFor` here says how big).
// `insets()` includes it, so everything that converts between surface and
// content coordinates — input, drag and drop, the text-input caret — needs
// no idea there is a shadow at all.
//
// Interaction is requests: a titlebar press starts `xdg_toplevel.move`, a
// press in the band starts `resize` with the edges it is nearest, and the
// buttons do what they say. input.js routes; this answers where things are.

import fs from 'node:fs';
import { Path2D } from 'ntk';
import { RESIZE_EDGE, TOPLEVEL_STATE } from './window.js';
import { DEFAULTS, parseButtonLayout, titleFont } from './framestyle.js';

/** how far outside the window a resize grab still lands (the input band) */
export const RESIZE_MARGIN = 8;
/** how far along an edge from a corner a grab resizes both ways */
const CORNER = 18;
const RADIUS = 12;
const SEPARATOR = 1;
const BUTTON = 24;
const BUTTON_STEP = 37;
const BUTTON_INSET = 24;

/** the room a shadow needs; a maximised, tiled or fullscreen window has none */
export const SHADOW_MARGINS = Object.freeze({
  left: 30,
  top: 26,
  right: 30,
  bottom: 38,
});
const NO_MARGINS = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 });

/** [focused, unfocused] per scheme; the rest is derived. */
const PALETTE = {
  dark: {
    bar: ['#2e2e32', '#222226'],
    fg: ['#ffffff', '#909092'],
    highlight: 'rgba(255, 255, 255, 0.07)',
    separator: 0.36,
  },
  light: {
    bar: ['#ffffff', '#fafafb'],
    fg: ['#333338', '#959597'],
    highlight: null,
    separator: 0.12,
  },
};

/**
 * Shadow layers — offset down, feather, opacity — focused, then not. The
 * rounded-rectangle shader feathers as `1 - smoothstep(-f, f, d)`: half
 * strength at the window's edge, nothing `f` beyond it. Four such layers
 * fit libadwaita's measured falloff (the alpha of black at 1, 5, 10, 20px
 * from a focused window's edge: 0.18, 0.12, 0.071, 0.032 against 0.19,
 * 0.12, 0.071, 0.023 here); an unfocused window's is tighter and fainter.
 * The margins above leave the widest room enough to fade out before the
 * surface ends, so no layer is cut off.
 */
const SHADOWS = [
  [
    { dy: 1, blur: 6, alpha: 0.1 },
    { dy: 2, blur: 18, alpha: 0.14 },
    { dy: 3, blur: 34, alpha: 0.13 },
    { dy: 4, blur: 48, alpha: 0.06 },
  ],
  [
    { dy: 1, blur: 5, alpha: 0.12 },
    { dy: 1, blur: 14, alpha: 0.14 },
    { dy: 2, blur: 26, alpha: 0.06 },
  ],
];

const hexRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
/** `a` moved towards `b` by `t`, as a CSS colour. */
function mix(a, b, t) {
  const x = hexRgb(a);
  const y = hexRgb(b);
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// The window buttons' glyphs, from the installed icon theme when it has
// them — they are the pixels every GTK window beside this one shows — and
// Adwaita's, embedded, when it does not.
const GLYPH_DIRS = [
  '/usr/share/icons/Adwaita/symbolic/ui',
  '/usr/share/icons/Adwaita/scalable/ui',
];
const FALLBACK_GLYPHS = {
  'window-close':
    'M4.7 4 L8 7.3 L11.3 4 L12 4.7 L8.7 8 L12 11.3 L11.3 12 L8 8.7 L4.7 12 L4 11.3 L7.3 8 L4 4.7 Z',
  'window-maximize':
    'm 3.988281 3.992188 v 8.011718 h 8.011719 v -8.011718 z m 2 2 h 4.011719 v 4.011718 h -4.011719 z',
  'window-restore':
    'm 4.988281 4.992188 v 6.011718 h 6.011719 v -6.011718 z m 2 2 h 2.011719 v 2.011718 h -2.011719 z',
  'window-minimize': 'm 4 10.007812 h 8 v 1.988282 h -8 z',
};
const glyphs = new Map();
function glyph(name) {
  if (glyphs.has(name)) return glyphs.get(name);
  let path = null;
  for (const dir of GLYPH_DIRS) {
    try {
      const svg = fs.readFileSync(`${dir}/${name}-symbolic.svg`, 'utf8');
      const ds = [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);
      if (ds.length) {
        path = new Path2D(ds.join(' '));
        break;
      }
    } catch {
      // not in this directory
    }
  }
  path ??= new Path2D(FALLBACK_GLYPHS[name]);
  glyphs.set(name, path);
  return path;
}

export class Decorations {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.enabled=true] false: no frame at all (the
   *   compositor draws one, or the window asked for none)
   */
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
    this.title = '';
    this.active = false;
    this.maximized = false;
    this.tiled = false;
    this.fullscreen = false;
    this.hover = null; // 'close' | 'maximize' | 'minimize' | null
    this.pressed = null;
    /** `(text, size, weight, family) => { width, ascent, descent, runs } | null` */
    this.measure = null;
    /** the shell window's current margins (window.js) */
    this.marginsOf = null;
    /** asks for another frame when the title's font was still loading */
    this.onNeedsRepaint = null;
    this.setStyle(DEFAULTS, null);
  }

  /** The margin a shadow needs in these states. */
  static marginsFor(states, enabled = true) {
    if (!enabled) return NO_MARGINS;
    for (const s of states ?? []) {
      if (
        s === TOPLEVEL_STATE.MAXIMIZED ||
        s === TOPLEVEL_STATE.FULLSCREEN ||
        (s >= TOPLEVEL_STATE.TILED_LEFT && s <= TOPLEVEL_STATE.TILED_BOTTOM)
      ) {
        return NO_MARGINS;
      }
    }
    return SHADOW_MARGINS;
  }

  /**
   * What the desktop says (framestyle.js) and its light or dark
   * (appearance.js's snapshot). The titlebar's height follows the title's
   * font, so a caller compares `insets()` before and after.
   */
  setStyle(style, appearance) {
    this.style = style ?? DEFAULTS;
    this.dark = appearance?.colorScheme === 'dark';
    this.highContrast = appearance?.contrast === 'high';
    this.font = titleFont(this.style);
    this.layout = parseButtonLayout(this.style.buttonLayout);
    // A line of the title's font, plus the headerbar's padding; never less
    // than libadwaita's 47px. From the font size, not from shaped metrics,
    // so the height is known before the font has been opened.
    this.barHeight = Math.max(47, Math.ceil(this.font.size * 1.17 + 12));
  }

  setState(states) {
    this.maximized = states.has(TOPLEVEL_STATE.MAXIMIZED);
    this.tiled = [...states].some(
      (s) => s >= TOPLEVEL_STATE.TILED_LEFT && s <= TOPLEVEL_STATE.TILED_BOTTOM,
    );
    this.fullscreen = states.has(TOPLEVEL_STATE.FULLSCREEN);
    this.active = states.has(TOPLEVEL_STATE.ACTIVATED);
  }

  margins() {
    if (!this.enabled) return NO_MARGINS;
    return this.marginsOf?.() ?? NO_MARGINS;
  }

  /** The frame's insets round the content, shadow margin included, in
   * logical pixels of the surface. */
  insets() {
    if (!this.enabled || this.fullscreen) return { ...NO_MARGINS };
    const m = this.margins();
    return {
      top: m.top + this.barHeight + SEPARATOR,
      left: m.left,
      right: m.right,
      bottom: m.bottom,
    };
  }

  /** How much bigger than the content the surface is. */
  extra() {
    const i = this.insets();
    return { width: i.left + i.right, height: i.top + i.bottom };
  }

  /** Rounded while the window floats; square once maximised or tiled. */
  get radius() {
    return this.maximized || this.tiled || this.fullscreen ? 0 : RADIUS;
  }

  /** The buttons, where they are: window-geometry coordinates. */
  _buttons(geomWidth) {
    const cy = Math.floor((this.barHeight - 1) / 2);
    const out = [];
    this.layout.left.forEach((id, k) => {
      out.push({ id, cx: BUTTON_INSET + k * BUTTON_STEP, cy });
    });
    const right = this.layout.right;
    right.forEach((id, k) => {
      out.push({
        id,
        cx: geomWidth - BUTTON_INSET - (right.length - 1 - k) * BUTTON_STEP,
        cy,
      });
    });
    return out;
  }

  /** How far from an edge the buttons on that side reach. */
  _reach(side) {
    const n = this.layout[side].length;
    return n ? BUTTON_INSET + (n - 1) * BUTTON_STEP + BUTTON / 2 + 6 : 12;
  }

  /**
   * What is under a surface-local point: a resize edge, a titlebar button,
   * the titlebar itself, or the content.
   *
   * @returns {{kind:'content'}|{kind:'titlebar'}|{kind:'button',id:string}|{kind:'resize',edges:number}}
   */
  hitTest(x, y, surfaceWidth, surfaceHeight) {
    if (!this.enabled || this.fullscreen) return { kind: 'content' };
    const m = this.margins();
    const gx = x - m.left;
    const gy = y - m.top;
    const gw = surfaceWidth - m.left - m.right;
    const gh = surfaceHeight - m.top - m.bottom;
    const inside = gx >= 0 && gx < gw && gy >= 0 && gy < gh;
    if (!inside) {
      if (this.maximized || this.tiled) return { kind: 'content' };
      // the band outside the window: the edges the point is beyond, and a
      // corner when it is near one
      let left = gx < 0;
      let right = gx >= gw;
      let top = gy < 0;
      let bottom = gy >= gh;
      if (left || right) {
        top ||= gy < CORNER;
        bottom ||= gy >= gh - CORNER;
      }
      if (top || bottom) {
        left ||= gx < CORNER;
        right ||= gx >= gw - CORNER;
      }
      let edges = 0;
      if (left) edges |= RESIZE_EDGE.LEFT;
      else if (right) edges |= RESIZE_EDGE.RIGHT;
      if (top) edges |= RESIZE_EDGE.TOP;
      else if (bottom) edges |= RESIZE_EDGE.BOTTOM;
      return { kind: 'resize', edges };
    }
    if (gy < this.barHeight) {
      for (const b of this._buttons(gw)) {
        if (
          Math.abs(gx - b.cx) <= BUTTON / 2 + 4 &&
          Math.abs(gy - b.cy) <= BUTTON / 2 + 4
        )
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

  /** The colours for the current scheme and focus. */
  _colors() {
    const p = this.dark ? PALETTE.dark : PALETTE.light;
    const k = this.active ? 0 : 1;
    const bar = p.bar[k];
    const fg = p.fg[k];
    const sep = this.highContrast ? Math.min(1, p.separator * 2) : p.separator;
    return {
      bar,
      fg,
      highlight: this.active ? p.highlight : null,
      // opaque: the row under the bar belongs to the frame, and a
      // translucent line there would be drawn over nothing
      separator: mix(bar, '#000006', sep),
      button: (id) =>
        mix(
          bar,
          fg,
          this.pressed === id ? 0.3 : this.hover === id ? 0.15 : 0.1,
        ),
    };
  }

  /**
   * Draw the frame into the surface. `width`/`height` are the surface's in
   * logical pixels; the context's transform already carries the output
   * scale. Idempotent, because it runs every frame over the last one: the
   * shadow's region is cleared before the shadow goes down, and nothing is
   * drawn inside the window but the bar, which is opaque.
   */
  paint(ctx, width, height, measure = this.measure) {
    if (!this.enabled || this.fullscreen) return;
    const m = this.margins();
    const gx = m.left;
    const gy = m.top;
    const gw = width - m.left - m.right;
    const gh = height - m.top - m.bottom;
    const r = this.radius;
    const c = this._colors();

    if (m.left || m.top || m.right || m.bottom) {
      // outside the window only: the region between the surface and the
      // rounded window, even-odd
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.roundRect(gx, gy, gw, gh, r);
      ctx.clip('evenodd');
      ctx.clearRect(0, 0, width, height);
      for (const s of SHADOWS[this.active ? 0 : 1]) {
        ctx.fillShadow(
          { x: gx, y: gy + s.dy, width: gw, height: gh },
          r,
          s.blur,
          `rgba(0, 0, 0, ${s.alpha})`,
        );
      }
      ctx.restore();
    }

    // the headerbar: rounded at the top, square where it meets the content
    const bh = this.barHeight;
    ctx.fillStyle = c.bar;
    if (r > 0) {
      ctx.beginPath();
      ctx.roundRect(gx, gy, gw, bh, r);
      ctx.fill();
      ctx.fillRect(gx, gy + r, gw, bh - r);
    } else {
      ctx.fillRect(gx, gy, gw, bh);
    }
    if (c.highlight) {
      ctx.fillStyle = c.highlight;
      ctx.fillRect(gx + r, gy, gw - 2 * r, 1);
    }
    ctx.fillStyle = c.separator;
    ctx.fillRect(gx, gy + bh, gw, SEPARATOR);

    for (const b of this._buttons(gw)) {
      // centred on the pixel, not on the grid line between two: a 24px
      // circle at a whole-pixel centre sits half a pixel up and left of
      // libadwaita's
      const cx = gx + b.cx + 0.5;
      const cy = gy + b.cy + 0.5;
      ctx.fillStyle = c.button(b.id);
      ctx.beginPath();
      ctx.roundRect(
        cx - BUTTON / 2,
        cy - BUTTON / 2,
        BUTTON,
        BUTTON,
        BUTTON / 2,
      );
      ctx.fill();
      const name =
        b.id === 'maximize'
          ? this.maximized
            ? 'window-restore'
            : 'window-maximize'
          : `window-${b.id}`;
      ctx.save();
      ctx.translate(cx - 8, cy - 8);
      ctx.fillStyle = c.fg;
      ctx.fill(glyph(name));
      ctx.restore();
    }

    this._paintTitle(ctx, gx, gy, gw, c.fg, measure);
  }

  _paintTitle(ctx, gx, gy, gw, color, measure) {
    if (!this.title || !measure) return;
    const f = this.font;
    const fit = (text) => measure(text, f.size, f.weight, f.family);
    let label = fit(this.title);
    if (!label) {
      // the font is still opening; ask again rather than show no title
      this.onNeedsRepaint?.();
      return;
    }
    const side = Math.max(this._reach('left'), this._reach('right'));
    const avail = Math.max(0, gw - 2 * side);
    if (label.width > avail) {
      // ellipsised at the end, as a GTK title is: the longest prefix that fits
      let lo = 0;
      let hi = this.title.length;
      let best = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const l = fit(this.title.slice(0, mid).trimEnd() + '…');
        if (l && l.width <= avail) {
          best = l;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (!best) return;
      label = best;
    }
    const x = gx + (gw - label.width) / 2;
    const baseline =
      gy + (this.barHeight - (label.ascent + label.descent)) / 2 + label.ascent;
    ctx.save();
    ctx.beginPath();
    ctx.rect(gx + side, gy, avail, this.barHeight);
    ctx.clip();
    ctx.translate(x, baseline);
    ctx.drawTextRuns(label.runs.map((run) => ({ ...run, color })));
    ctx.restore();
  }
}
