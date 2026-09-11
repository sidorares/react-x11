// Debug overlays: REACT_X11_DEBUG_PAINT's damage flashes, and DevTools'
// highlight and trace-updates outlines.

// REACT_X11_DEBUG_PAINT: each frame strokes its damage rects in the next of
// these, so a region repainting every frame strobes visibly.
export const FLASH_COLORS = [
  '#e6194b',
  '#3cb44b',
  '#ffe119',
  '#4363d8',
  '#f58231',
  '#911eb4',
];

// REACT_X11_DEBUG_PAINT, read once: a process.env read is a real
// environment lookup, and this switch sits on invalidate() and the paint
// loop — the diagnostics must cost nothing when they are off. Indirected
// like the animation clock so tests can flip it without a subprocess.
export let debugPaint = process.env.REACT_X11_DEBUG_PAINT || '';
export function setDebugPaint(mode) {
  debugPaint = mode || '';
}

/** Debug overlays, installed onto `WindowNode.prototype` by window.js. */
export class WindowDebugPaint {
  /** DevTools hover highlight: tint a node's rect on the next paint. */
  setHighlight(node) {
    if (this._highlight === node) return;
    const prev = this._highlight;
    this._highlight = node;
    // The tint leaves one rect and lands on another, and both are already
    // known, so the claim is their union rather than the window. A side
    // with no laid-out rect tints (or tinted) the whole window — the same
    // fallback _paintRegion paints — so only that case stays unbounded.
    const rects = [];
    for (const n of [prev, node]) {
      if (!n) continue;
      if (!n.abs?.width) {
        this.invalidate(false, null, 'highlight');
        return;
      }
      rects.push(n.abs);
    }
    for (const rect of rects) this.invalidate(false, rect, 'highlight');
  }

  /**
   * DevTools' "highlight updates when components render": outline the rects
   * that just re-rendered, in the colour the backend assigned each one (it
   * ramps with the update count and fades them out on its own clock, so
   * this is a dumb overlay — `rects` is the whole state, `null` clears it).
   */
  setTraceUpdates(rects) {
    const previous = this._traceUpdates;
    const next = rects?.length ? rects : null;
    if (!previous && !next) return;
    this._traceUpdates = next;
    // The stroke sits inside the rect, but a rect whose node has since
    // moved or gone claims where it *was*; both lists are claimed for the
    // same reason setHighlight claims both of its rects.
    for (const r of [...(previous ?? []), ...(next ?? [])]) {
      this.invalidate(false, r, 'trace-updates');
    }
  }

  /** REACT_X11_DEBUG_LAYOUT=1: outline every drawn node, color by depth. */
  _paintDebugOverlay(ctx, node, depth) {
    const colors = ['#e74c3c', '#27ae60', '#2980b9', '#8e44ad', '#f39c12'];
    for (const child of node.paintOrder()) {
      ctx.strokeStyle = colors[depth % colors.length];
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(
        child.abs.x + 0.5,
        child.abs.y + 0.5,
        child.abs.width - 1,
        child.abs.height - 1,
      );
      ctx.stroke();
      this._paintDebugOverlay(ctx, child, depth + 1);
    }
  }
}
