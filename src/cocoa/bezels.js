// Native control bezels — AppKit's own pixels for the core controls, cached
// as surfaces the ordinary 2d paint path can blit (docs/macos.md §Native
// controls). The mechanism is offscreen NSCell/NSControl rendering, the
// WebKit/Gecko form-control technique: interaction, focus and keyboard stay
// the shared component implementation, and only the *bezel* — the pixels of
// the well, the track, the button face — is asked of the system.
//
// Everything here is measured in points at the native boundary and delivered
// in device pixels, the same split the rest of the backend keeps.
//
// ## The ink box
//
// AppKit cells draw inside margins of their own: a push button cell insets
// its bezel ~6pt each side, a checkbox floats its 16pt well in an 18pt
// frame. Component layout wants the *visible* control — a well that is 16px
// is 16px in the row it sits in — so the store scans each (kind, size)'s
// alpha bounding box once, and every bezel afterwards is rendered into a
// frame padded back out by those insets and blitted from the ink region.
// Scanned rather than hard-coded so a macOS release that redraws its
// controls moves the answer instead of breaking it.
export class BezelStore {
  constructor(native) {
    this._native = native;
    this._canonical = new Map(); // kind|size|scale → { insets, natural }
    this._cache = new Map(); // full param key → { surface, sx, sy, sw, sh }
    this._MAX = 160;
  }

  /**
   * The control's natural size in logical px — the size the bezel is
   * designed at, which layout adopts for the kinds that must not stretch
   * (checkbox, radio, switch). For the stretchable kinds only `height` is
   * meaningful: a push button is as wide as its label needs.
   */
  natural(kind, controlSize = 'regular') {
    const c = this._scan(kind, controlSize, 2);
    return {
      width: Math.round(c.natural.width),
      height: Math.round(c.natural.height),
    };
  }

  /**
   * The bezel for one laid-out box: `w`/`h` in device px, blit-ready.
   * Returns `{ surface, sx, sy, sw, sh }` — draw with the 9-arg
   * `ctx.drawImage` so the ink region lands exactly on the box.
   */
  get(params, w, h, scale) {
    const controlSize = params.controlSize ?? 'regular';
    const c = this._scan(params.kind, controlSize, scale);
    const key = JSON.stringify([
      params.kind,
      controlSize,
      params.state ?? 0,
      params.pressed ?? false,
      params.enabled ?? true,
      params.isDefault ?? false,
      params.value,
      params.appearance,
      w,
      h,
      scale,
    ]);
    let entry = this._cache.get(key);
    if (entry) {
      // Map order is the recency order: re-inserting keeps the hot bezels
      // at the young end when the cache is over budget.
      this._cache.delete(key);
      this._cache.set(key, entry);
      return entry;
    }
    const fw = w / scale + c.insets.left + c.insets.right;
    const fh = h / scale + c.insets.top + c.insets.bottom;
    const surface = this._native.createSurface(
      Math.max(1, Math.round(fw * scale)),
      Math.max(1, Math.round(fh * scale)),
      scale,
    );
    this._native.drawControlIntoSurface(surface, {
      ...params,
      controlSize,
    });
    entry = {
      surface,
      sx: Math.round(c.insets.left * scale),
      sy: Math.round(c.insets.top * scale),
      sw: w,
      sh: h,
    };
    this._cache.set(key, entry);
    if (this._cache.size > this._MAX) {
      // eldest first; the surface itself is freed by its External finalizer
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
    return entry;
  }

  /**
   * One render + alpha scan per (kind, size, scale): where does this cell
   * actually put ink inside the frame it is given? The frame is the natural
   * cellSize widened by 24pt so a stretchable bezel's side margins are
   * visible as margins rather than crowding the ends.
   */
  _scan(kind, controlSize, scale) {
    const key = `${kind}|${controlSize}|${scale}`;
    let c = this._canonical.get(key);
    if (c) return c;
    const m = this._native.measureControl({ kind, controlSize });
    const fw = m.width + 24;
    const fh = m.height;
    const pw = Math.max(1, Math.round(fw * scale));
    const ph = Math.max(1, Math.round(fh * scale));
    const surface = this._native.createSurface(pw, ph, scale);
    this._native.drawControlIntoSurface(surface, {
      kind,
      controlSize,
      // the fullest state, so the scan sees the whole footprint
      state: 1,
      value: 0.5,
      enabled: true,
      appearance: 'light',
    });
    const buf = this._native.ctxGetImageData(surface, 0, 0, pw, ph);
    let x0 = pw;
    let y0 = ph;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        if (buf[(y * pw + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) {
      // nothing painted (should not happen) — treat the frame as the ink
      x0 = 0;
      y0 = 0;
      x1 = pw - 1;
      y1 = ph - 1;
    }
    c = {
      insets: {
        left: x0 / scale,
        top: y0 / scale,
        right: fw - (x1 + 1) / scale,
        bottom: fh - (y1 + 1) / scale,
      },
      natural: {
        width: (x1 - x0 + 1) / scale,
        height: (y1 - y0 + 1) / scale,
      },
    };
    this._canonical.set(key, c);
    return c;
  }
}
