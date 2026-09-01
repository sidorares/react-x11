// A canvas-shaped 2d context over a node-calayers CoreGraphics surface.
//
// This is the raster half of the Cocoa backend: on the surface presenter it
// is the whole drawing path, and on the layer presenter it stays as the
// fallback every painted-code node (<canvas>, <svg>, registered elements)
// rasters through — docs/macos.md §"Custom drawing on a layer tree".
//
// The native surface holds the real graphics state (paths, CTM, clip); this
// class keeps the JS-visible state (fillStyle strings, gradient objects,
// dash arrays) and re-syncs it when the backing surface is replaced after a
// resize — `_gen` is that generation.
import { cssColorStraight } from 'ntk';

const BLACK = [0, 0, 0, 1];

function parseColor(value) {
  if (value == null) return BLACK;
  return cssColorStraight(String(value)) ?? BLACK;
}

class LinearGradient {
  constructor(x0, y0, x1, y1) {
    this._coords = [x0, y0, x1, y1];
    this._stops = [];
  }

  addColorStop(offset, color) {
    const [r, g, b, a] = parseColor(color);
    this._stops.push(offset, r, g, b, a);
  }

  /**
   * CoreGraphics requires stop locations inside [0, 1]; the decorations
   * parser deliberately pads a gradient's line past both ends (its end
   * colours pinned there — see src/decorations.js). Out-of-range locations
   * fed to CGGradient render as a solid block, so the line is re-derived:
   * the coordinates extend to cover the outermost stops and every location
   * remaps into [0, 1].
   */
  _normalized() {
    const stops = [];
    for (let i = 0; i + 4 < this._stops.length; i += 5) {
      stops.push(this._stops.slice(i, i + 5));
    }
    stops.sort((p, q) => p[0] - q[0]);
    if (stops.length === 0) return { coords: this._coords, flat: [] };
    if (stops.length === 1) stops.push([...stops[0]]);
    const min = Math.min(0, stops[0][0]);
    const max = Math.max(1, stops[stops.length - 1][0]);
    let [x0, y0, x1, y1] = this._coords;
    if (min !== 0 || max !== 1) {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const nx0 = x0 + dx * min;
      const ny0 = y0 + dy * min;
      x1 = x0 + dx * max;
      y1 = y0 + dy * max;
      x0 = nx0;
      y0 = ny0;
      const span = max - min;
      for (const stop of stops) stop[0] = (stop[0] - min) / span;
    }
    for (const stop of stops) stop[0] = Math.min(1, Math.max(0, stop[0]));
    return { coords: [x0, y0, x1, y1], flat: stops.flat() };
  }
}

export class CocoaContext2D {
  /**
   * @param native the node-calayers module
   * @param surfaceOf () => current surface handle — the owner replaces the
   *   surface on resize, and this context follows it.
   * @param genOf () => surface generation number
   */
  constructor(native, surfaceOf, genOf) {
    this._native = native;
    this._surfaceOf = surfaceOf;
    this._genOf = genOf;
    this._gen = -1;
    this._stack = [];
    this._state = {
      fillStyle: '#000',
      strokeStyle: '#000',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      globalAlpha: 1,
      dash: [],
      dashOffset: 0,
      font: '10px sans-serif',
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      shadowColor: 'rgba(0,0,0,0)',
      ctm: [1, 0, 0, 1, 0, 0],
    };
    this._onDirty = null;
  }

  _s() {
    const surface = this._surfaceOf();
    const gen = this._genOf();
    if (gen !== this._gen) {
      // fresh surface: push the sticky state back into it
      this._gen = gen;
      const n = this._native;
      const st = this._state;
      n.ctxSetLineWidth(surface, st.lineWidth);
      n.ctxSetLineCap(surface, st.lineCap);
      n.ctxSetLineJoin(surface, st.lineJoin);
      n.ctxSetGlobalAlpha(surface, st.globalAlpha);
      n.ctxSetLineDash(surface, st.dash, st.dashOffset);
      this._stack.length = 0;
    }
    return surface;
  }

  _dirty() {
    this._onDirty?.();
  }

  // --- state ---------------------------------------------------------------

  get fillStyle() {
    return this._state.fillStyle;
  }

  set fillStyle(value) {
    this._state.fillStyle = value;
  }

  get strokeStyle() {
    return this._state.strokeStyle;
  }

  set strokeStyle(value) {
    this._state.strokeStyle = value;
  }

  get lineWidth() {
    return this._state.lineWidth;
  }

  set lineWidth(value) {
    if (typeof value === 'number' && value > 0) {
      this._state.lineWidth = value;
      this._native.ctxSetLineWidth(this._s(), value);
    }
  }

  get lineCap() {
    return this._state.lineCap;
  }

  set lineCap(value) {
    this._state.lineCap = value;
    this._native.ctxSetLineCap(this._s(), String(value));
  }

  get lineJoin() {
    return this._state.lineJoin;
  }

  set lineJoin(value) {
    this._state.lineJoin = value;
    this._native.ctxSetLineJoin(this._s(), String(value));
  }

  get globalAlpha() {
    return this._state.globalAlpha;
  }

  set globalAlpha(value) {
    if (typeof value === 'number' && value >= 0 && value <= 1) {
      this._state.globalAlpha = value;
      this._native.ctxSetGlobalAlpha(this._s(), value);
    }
  }

  get font() {
    return this._state.font;
  }

  set font(value) {
    this._state.font = String(value);
  }

  get shadowBlur() {
    return this._state.shadowBlur;
  }

  set shadowBlur(value) {
    if (typeof value === 'number' && value >= 0) {
      this._state.shadowBlur = value;
      this._syncShadow();
    }
  }

  get shadowOffsetX() {
    return this._state.shadowOffsetX;
  }

  set shadowOffsetX(value) {
    if (typeof value === 'number') {
      this._state.shadowOffsetX = value;
      this._syncShadow();
    }
  }

  get shadowOffsetY() {
    return this._state.shadowOffsetY;
  }

  set shadowOffsetY(value) {
    if (typeof value === 'number') {
      this._state.shadowOffsetY = value;
      this._syncShadow();
    }
  }

  get shadowColor() {
    return this._state.shadowColor;
  }

  set shadowColor(value) {
    this._state.shadowColor = value;
    this._syncShadow();
  }

  _syncShadow() {
    const st = this._state;
    const [r, g, b, a] = parseColor(st.shadowColor);
    const on = st.shadowBlur > 0 && a > 0;
    this._native.ctxSetShadow(
      this._s(),
      on ? st.shadowBlur : 0,
      st.shadowOffsetX,
      st.shadowOffsetY,
      r,
      g,
      b,
      a,
    );
  }

  setLineDash(segments) {
    this._state.dash = Array.isArray(segments) ? segments : [];
    this._native.ctxSetLineDash(this._s(), this._state.dash, 0);
  }

  getLineDash() {
    return [...this._state.dash];
  }

  save() {
    this._stack.push({ ...this._state, dash: [...this._state.dash] });
    this._native.ctxSave(this._s());
  }

  restore() {
    const prev = this._stack.pop();
    if (prev) this._state = prev;
    this._native.ctxRestore(this._s());
  }

  _concat(a2, b2, c2, d2, e2, f2) {
    const [a, b, c, d, e, f] = this._state.ctm;
    this._state.ctm = [
      a * a2 + c * b2,
      b * a2 + d * b2,
      a * c2 + c * d2,
      b * c2 + d * d2,
      a * e2 + c * f2 + e,
      b * e2 + d * f2 + f,
    ];
  }

  translate(x, y) {
    this._concat(1, 0, 0, 1, x, y);
    this._native.ctxTranslate(this._s(), x, y);
  }

  scale(x, y) {
    this._concat(x, 0, 0, y, 0, 0);
    this._native.ctxScale(this._s(), x, y);
  }

  rotate(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    this._concat(cos, sin, -sin, cos, 0, 0);
    this._native.ctxRotate(this._s(), angle);
  }

  transform(a, b, c, d, e, f) {
    this._concat(a, b, c, d, e, f);
    this._native.ctxTransform(this._s(), a, b, c, d, e, f);
  }

  setTransform(a, b, c, d, e, f) {
    if (typeof a === 'object' && a) ({ a, b, c, d, e, f } = a);
    // concat the delta that takes the current matrix to the requested one
    const [ca, cb, cc, cd, ce, cf] = this._state.ctm;
    const det = ca * cd - cb * cc;
    if (!det) return;
    const ia = cd / det;
    const ib = -cb / det;
    const ic = -cc / det;
    const id = ca / det;
    const ie = -(ia * ce + ic * cf);
    const iff = -(ib * ce + id * cf);
    this.transform(
      ia * a + ic * b,
      ib * a + id * b,
      ia * c + ic * d,
      ib * c + id * d,
      ia * e + ic * f + ie,
      ib * e + id * f + iff,
    );
  }

  resetTransform() {
    this.setTransform(1, 0, 0, 1, 0, 0);
  }

  getTransform() {
    const [a, b, c, d, e, f] = this._state.ctm;
    return { a, b, c, d, e, f };
  }

  // --- paths ---------------------------------------------------------------

  beginPath() {
    this._native.ctxBeginPath(this._s());
  }

  moveTo(x, y) {
    this._native.ctxMoveTo(this._s(), x, y);
  }

  lineTo(x, y) {
    this._native.ctxLineTo(this._s(), x, y);
  }

  rect(x, y, w, h) {
    this._native.ctxRect(this._s(), x, y, w, h);
  }

  roundRect(x, y, w, h, radii) {
    let r = radii ?? 0;
    if (typeof r === 'number') r = [r, r, r, r];
    else if (r.length === 1) r = [r[0], r[0], r[0], r[0]];
    else if (r.length === 2) r = [r[0], r[1], r[0], r[1]];
    else if (r.length === 3) r = [r[0], r[1], r[2], r[1]];
    const cap = Math.min(Math.abs(w) / 2, Math.abs(h) / 2);
    const clamp = (v) => Math.max(0, Math.min(Number(v) || 0, cap));
    this._native.ctxRoundRect(
      this._s(),
      x,
      y,
      w,
      h,
      clamp(r[0]),
      clamp(r[1]),
      clamp(r[2]),
      clamp(r[3]),
    );
  }

  arc(x, y, radius, start, end, anticlockwise = false) {
    this._native.ctxArc(this._s(), x, y, radius, start, end, anticlockwise);
  }

  ellipse(x, y, rx, ry) {
    this._native.ctxEllipse(this._s(), x, y, rx, ry);
  }

  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    this._native.ctxCurveTo(this._s(), c1x, c1y, c2x, c2y, x, y);
  }

  quadraticCurveTo(cx, cy, x, y) {
    this._native.ctxQuadTo(this._s(), cx, cy, x, y);
  }

  closePath() {
    this._native.ctxClosePath(this._s());
  }

  // --- painting ------------------------------------------------------------

  createLinearGradient(x0, y0, x1, y1) {
    return new LinearGradient(x0, y0, x1, y1);
  }

  createRadialGradient() {
    // radial paints flat until someone needs it; the stop list still works
    return new LinearGradient(0, 0, 0, 0);
  }

  _applyFill() {
    const [r, g, b, a] = parseColor(this._state.fillStyle);
    this._native.ctxSetFillColor(this._s(), r, g, b, a);
  }

  _applyStroke() {
    const [r, g, b, a] = parseColor(this._state.strokeStyle);
    this._native.ctxSetStrokeColor(this._s(), r, g, b, a);
  }

  /**
   * Replay an ntk/canvas Path2D (normalized M/L/C/Q/Z commands on `_cmds`)
   * into the native context path. The fill/stroke/clip overloads that take
   * a path argument route through this — ignoring the argument would run
   * the operation on whatever path a PREVIOUS painter left behind, which
   * is how a 44px SVG icon once filled a whole card with its accent.
   */
  _replayPath(path) {
    const cmds = path?._cmds;
    if (!Array.isArray(cmds)) return false;
    const n = this._native;
    const s = this._s();
    n.ctxBeginPath(s);
    for (const c of cmds) {
      if (c.type === 'M') n.ctxMoveTo(s, c.x, c.y);
      else if (c.type === 'L') n.ctxLineTo(s, c.x, c.y);
      else if (c.type === 'C')
        n.ctxCurveTo(s, c.x1, c.y1, c.x2, c.y2, c.x, c.y);
      else if (c.type === 'Q') n.ctxQuadTo(s, c.x1, c.y1, c.x, c.y);
      else if (c.type === 'Z') n.ctxClosePath(s);
    }
    return true;
  }

  fill(pathOrRule, maybeRule) {
    const hasPath = pathOrRule != null && typeof pathOrRule === 'object';
    const rule = hasPath ? maybeRule : pathOrRule;
    if (hasPath && !this._replayPath(pathOrRule)) return;
    const style = this._state.fillStyle;
    if (style instanceof LinearGradient) {
      const { coords, flat } = style._normalized();
      this._native.ctxFillLinearGradient(
        this._s(),
        coords[0],
        coords[1],
        coords[2],
        coords[3],
        flat,
      );
    } else {
      this._applyFill();
      this._native.ctxFill(this._s(), rule === 'evenodd');
    }
    this._dirty();
  }

  stroke(path) {
    if (path != null && typeof path === 'object' && !this._replayPath(path)) {
      return;
    }
    this._applyStroke();
    this._native.ctxStroke(this._s());
    this._dirty();
  }

  clip(pathOrRule) {
    if (
      pathOrRule != null &&
      typeof pathOrRule === 'object' &&
      !this._replayPath(pathOrRule)
    ) {
      return;
    }
    this._native.ctxClip(this._s());
  }

  fillRect(x, y, w, h) {
    if (!(w > 0) || !(h > 0)) return;
    const style = this._state.fillStyle;
    if (style instanceof LinearGradient) {
      const { coords, flat } = style._normalized();
      this._native.ctxFillLinearGradient(
        this._s(),
        coords[0],
        coords[1],
        coords[2],
        coords[3],
        flat,
        x,
        y,
        w,
        h,
      );
    } else {
      this._applyFill();
      this._native.ctxFillRect(this._s(), x, y, w, h);
    }
    this._dirty();
  }

  fillRects(rects) {
    const flat = Array.isArray(rects?.[0]) ? rects.flat() : (rects ?? []);
    if (!flat.length) return;
    this._applyFill();
    this._native.ctxFillRects(this._s(), flat);
    this._dirty();
  }

  strokeRect(x, y, w, h) {
    this._applyStroke();
    this._native.ctxStrokeRect(this._s(), x, y, w, h);
    this._dirty();
  }

  clearRect(x, y, w, h) {
    this._native.ctxClearRect(this._s(), x, y, w, h);
    this._dirty();
  }

  drawImage(image, ...args) {
    const src = image?._surfaceHandle ?? image?._surface?._surfaceHandle;
    if (!src) return; // ntk Images/Pictures are not on this backend yet
    const size = this._native.surfaceSize(src);
    let sx = 0;
    let sy = 0;
    let sw = size.width;
    let sh = size.height;
    let dx;
    let dy;
    let dw;
    let dh;
    if (args.length >= 8) {
      [sx, sy, sw, sh, dx, dy, dw, dh] = args;
    } else if (args.length >= 4) {
      [dx, dy, dw, dh] = args;
    } else {
      [dx, dy] = args;
      dw = sw;
      dh = sh;
    }
    this._native.ctxDrawSurface(this._s(), src, sx, sy, sw, sh, dx, dy, dw, dh);
    this._dirty();
  }

  putImageData(data, x, y) {
    if (!data?.data) return;
    const buf = Buffer.isBuffer(data.data)
      ? data.data
      : Buffer.from(data.data.buffer ?? data.data);
    this._native.ctxPutImageData(
      this._s(),
      buf,
      data.width,
      data.height,
      Math.round(x),
      Math.round(y),
    );
    this._dirty();
  }

  /**
   * ntk's contract, not the browser's: with a callback it delivers
   * `(err, imageData)`; without one it returns a Promise. On X11 the read
   * is a server round trip, so every consumer in the tree is written
   * async — the configurator's screen capture, the pixel harness,
   * scripts/capture.js — and a backend that answered synchronously would
   * strand their callbacks unfired. The pixels are read at call time (the
   * surface only changes in the pump, which cannot run before a
   * microtask), the delivery is a tick later like a resolved promise's.
   */
  getImageData(x, y, w, h, cb) {
    const read = () => {
      const buf = this._native.ctxGetImageData(
        this._s(),
        Math.round(x),
        Math.round(y),
        Math.round(w),
        Math.round(h),
      );
      return {
        data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length),
        width: Math.round(w),
        height: Math.round(h),
      };
    };
    let result;
    let failure;
    try {
      result = read();
    } catch (err) {
      failure = err;
    }
    const promise = failure ? Promise.reject(failure) : Promise.resolve(result);
    if (typeof cb === 'function') {
      promise.then(
        (data) => cb(null, data),
        (err) => cb(err),
      );
      return undefined;
    }
    return promise;
  }

  // --- text (minimal: enough for <canvas onDraw> users) --------------------

  _drawLayout(layout, x, y) {
    if (layout._contextInk) {
      const style = this._state.fillStyle;
      if (style instanceof LinearGradient) {
        const { coords, flat } = style._normalized();
        this._native.drawLayoutGradient(
          this._s(),
          layout._handle,
          x,
          y,
          coords[0],
          coords[1],
          coords[2],
          coords[3],
          flat,
        );
        this._dirty();
        return;
      }
      this._applyFill();
    }
    this._native.drawLayout(this._s(), layout._handle, x, y);
    this._dirty();
  }

  measureText(text) {
    const layout = this._fontLayout(text);
    return layout
      ? { width: layout.width }
      : { width: String(text).length * 7 };
  }

  fillText(text, x, y) {
    const layout = this._fontLayout(text);
    if (!layout) return;
    // canvas fillText's y is the baseline; layouts draw from their top
    const baseline = layout.lines[0]?.baseline ?? 0;
    this._drawLayout(layout, x, y - baseline);
  }

  _fontLayout(text, color) {
    const fonts = this._fonts;
    if (!fonts) return null;
    const m =
      /^(?:(italic|oblique)\s+)?(?:(\d{3}|bold)\s+)?(\d+(?:\.\d+)?)px\s+(.+)$/.exec(
        this._state.font,
      );
    const size = m ? Number(m[3]) : 12;
    const family = m ? m[4] : 'sans-serif';
    const weight = m?.[2] === 'bold' ? 700 : m?.[2] ? Number(m[2]) : 400;
    const style = m?.[1] ? 'italic' : 'normal';
    return fonts.layout(
      [{ text: String(text), family, size, weight, style, color }],
      { family, size, weight, style, color: color ?? '#000' },
      {},
    );
  }
}
