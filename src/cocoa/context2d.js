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

  translate(x, y) {
    this._native.ctxTranslate(this._s(), x, y);
  }

  scale(x, y) {
    this._native.ctxScale(this._s(), x, y);
  }

  rotate(angle) {
    this._native.ctxRotate(this._s(), angle);
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

  fill(rule) {
    const style = this._state.fillStyle;
    if (style instanceof LinearGradient) {
      const [x0, y0, x1, y1] = style._coords;
      this._native.ctxFillLinearGradient(
        this._s(),
        x0,
        y0,
        x1,
        y1,
        style._stops,
      );
    } else {
      this._applyFill();
      this._native.ctxFill(this._s(), rule === 'evenodd');
    }
    this._dirty();
  }

  stroke() {
    this._applyStroke();
    this._native.ctxStroke(this._s());
    this._dirty();
  }

  clip() {
    this._native.ctxClip(this._s());
  }

  fillRect(x, y, w, h) {
    if (!(w > 0) || !(h > 0)) return;
    const style = this._state.fillStyle;
    if (style instanceof LinearGradient) {
      const [x0, y0, x1, y1] = style._coords;
      this._native.ctxFillLinearGradient(
        this._s(),
        x0,
        y0,
        x1,
        y1,
        style._stops,
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

  getImageData(x, y, w, h) {
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
  }

  // --- text (minimal: enough for <canvas onDraw> users) --------------------

  _drawLayout(layout, x, y) {
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
    const layout = this._fontLayout(text, this._state.fillStyle);
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
