// Tier D's 2d context: canvas-shaped drawing that ends up as GLES draw calls.
//
// This is the piece the RFC calls the largest workstream, and the shape it
// takes here is worth stating because it is not the obvious one.
//
// **Analytic shapes first, stencil second.** A rounded rectangle — which is
// most of what a UI draws — is a signed distance field evaluated in the
// fragment shader: antialiased without multisampling, and batched, so every
// box in a window can share one draw call. Arbitrary paths (SVG, custom
// canvas drawing) go the conventional way, stencil-then-cover: the flattened
// path's winding is counted into the stencil attachment of the render target
// (target.js), then a quad over its bounds is drawn wherever the count is
// non-zero. That path is aliased for now; the stencil bits it needs came with
// x11-dri 0.8.0 and the target's own renderbuffer.
//
// **One shader, batched by mode.** Vertices carry position, texture
// coordinates, a premultiplied colour and four shape parameters; per-batch
// uniforms pick how the fragment shader reads them. A batch flushes when the
// mode, the texture, the texture's byte layout or the scissor changes, which
// for a widget UI means a handful of draw calls for a whole window.
//
// **Transforms on the CPU.** The matrix is applied as vertices are emitted
// rather than sent as a uniform, so a translate does not break a batch. A UI
// emits thousands of vertices per frame, not millions.
//
// **Clipping is the scissor.** Rectangular clips — a scroll pane, a list row,
// a text field — are exact. A non-rectangular clip falls back to its bounding
// box, which over-paints rather than under-paints; `clipApproximations`
// counts them.
//
// **Three pixel layouts, one texture path.** ntk's `Image` is premultiplied
// BGRA (it was made for XRender), canvas `ImageData` is straight RGBA (the
// spec), and a render target is premultiplied RGBA (ours). Converting on the
// CPU would cost a pass per upload; the fragment shader swizzles instead,
// selected per batch.
//
// **Text is ntk's up to the last inch.** `drawGlyphs` is the contract
// `TextLayout.draw` calls, and everything before it — matching, shaping,
// bidi, line breaking — is the same code the X11 backend runs. Only the
// composite changes: an A8 atlas texture instead of a server glyph set.

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Path2D, Image as NtkImage } from 'ntk';
import { GlyphAtlas } from './glyphatlas.js';
import { GLTarget } from './target.js';

// ntk's exports map hides lib/path.js, and `flattenPath` is what turns a
// Path2D into device-space polygons — reach it by file.
const require = createRequire(import.meta.url);
const ntkLib = path.dirname(require.resolve('ntk'));
const { flattenPath } = await import(
  pathToFileURL(path.join(ntkLib, 'path.js'))
);

const MODE_SOLID = 0;
const MODE_TEXTURE = 1;
const MODE_GLYPH = 2;
const MODE_RRECT = 3;
const MODE_GRADIENT = 4;

/** `uSwizzle`: how the bound texture's bytes are to be read. */
const SWIZZLE_RGBA = 0; // premultiplied RGBA (render targets)
const SWIZZLE_BGRA = 1; // premultiplied BGRA (ntk Image)
const SWIZZLE_STRAIGHT = 2; // straight RGBA (ImageData)

/** floats per vertex: pos(2) uv(2) color(4) params(4) */
const STRIDE = 12;
const MAX_VERTS = 6 * 4096;
const TRI = [0, 1, 2, 0, 2, 3];

const VERT = `
attribute vec2 aPos;
attribute vec2 aUV;
attribute vec4 aColor;
attribute vec4 aParams;
uniform vec2 uViewport;
varying vec2 vUV;
varying vec4 vColor;
varying vec4 vParams;
void main() {
  vUV = aUV;
  vColor = aColor;
  vParams = aParams;
  // Device pixels (y down, origin top-left) to clip space (y up).
  gl_Position = vec4(aPos.x / uViewport.x * 2.0 - 1.0,
                     1.0 - aPos.y / uViewport.y * 2.0, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
varying vec2 vUV;
varying vec4 vColor;
varying vec4 vParams;
uniform int uMode;
uniform int uSwizzle;
uniform sampler2D uTex;
// highp to match the vertex stage's default: GLSL ES links a uniform used in
// both stages only when their precisions agree, and device coordinates past
// 2048 need the range anyway.
uniform highp vec2 uViewport;
uniform int uGradKind;
uniform vec4 uGradA;
uniform vec4 uGradB;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

vec4 sampleTex(vec2 uv) {
  vec4 c = texture2D(uTex, uv);
  if (uSwizzle == 1) c = c.bgra;
  else if (uSwizzle == 2) c = vec4(c.rgb * c.a, c.a);
  return c;
}

void main() {
  if (uMode == 0) {
    gl_FragColor = vColor;
  } else if (uMode == 1) {
    gl_FragColor = vColor * sampleTex(vUV);
  } else if (uMode == 2) {
    gl_FragColor = vColor * texture2D(uTex, vUV).a;
  } else if (uMode == 3) {
    // vUV is the offset from the rect centre, in pixels; vParams.w selects
    // fill (0), stroke of that width (> 0) or a shadow feathered by that
    // much (< 0).
    float d = sdRoundBox(vUV, vParams.xy, vParams.z);
    float w = vParams.w;
    float a;
    if (w > 0.0) a = 1.0 - smoothstep(w * 0.5 - 0.5, w * 0.5 + 0.5, abs(d));
    else if (w < 0.0) a = 1.0 - smoothstep(w, -w, d);
    else a = 1.0 - smoothstep(-0.5, 0.5, d);
    gl_FragColor = vColor * a;
  } else {
    // Gradients are evaluated per fragment from its device position, so any
    // shape — a cover quad over a path included — can be filled with one.
    vec2 p = vec2(gl_FragCoord.x, uViewport.y - gl_FragCoord.y);
    float t;
    if (uGradKind == 0) {
      vec2 d = uGradB.xy - uGradA.xy;
      float l = dot(d, d);
      t = l > 0.0 ? dot(p - uGradA.xy, d) / l : 0.0;
    } else {
      float r0 = uGradA.z;
      float r1 = uGradB.x;
      float dist = length(p - uGradA.xy);
      t = r1 > r0 ? (dist - r0) / (r1 - r0) : 0.0;
    }
    gl_FragColor = vColor * texture2D(uTex, vec2(clamp(t, 0.0, 1.0), 0.5));
  }
}`;

// ---- small helpers ----------------------------------------------------------

/** A 2x3 affine matrix in canvas order [a b c d e f]. */
const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

function mul(m, n) {
  // m × n, where n is applied first (canvas semantics for ctx.transform)
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function applyX(m, x, y) {
  return m[0] * x + m[2] * y + m[4];
}
function applyY(m, x, y) {
  return m[1] * x + m[3] * y + m[5];
}
function isAxisAligned(m) {
  return m[1] === 0 && m[2] === 0;
}
/** the uniform scale a matrix applies, for stroke widths */
function scaleOf(m) {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

const colorCache = new Map();

/**
 * Parse a CSS-ish colour into premultiplied 0..1 RGBA. Memoised: the
 * renderer above resolves palettes long before a paint call, so a frame sees
 * a few dozen distinct strings thousands of times.
 */
export function parseColor(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return BLACK;
  const hit = colorCache.get(value);
  if (hit) return hit;
  const c = parseColorUncached(value);
  if (colorCache.size > 4096) colorCache.clear();
  colorCache.set(value, c);
  return c;
}

const BLACK = Object.freeze([0, 0, 0, 1]);
const CLEAR = Object.freeze([0, 0, 0, 0]);

function parseColorUncached(value) {
  const s = value.trim();
  if (s[0] === '#') {
    const h = s.slice(1);
    const n = h.length;
    const q = (i, len) =>
      parseInt(len === 1 ? h[i] + h[i] : h.slice(i * 2, i * 2 + 2), 16) / 255;
    if (n === 3 || n === 4)
      return premul(q(0, 1), q(1, 1), q(2, 1), n === 4 ? q(3, 1) : 1);
    if (n === 6 || n === 8)
      return premul(q(0, 2), q(1, 2), q(2, 2), n === 8 ? q(3, 2) : 1);
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean);
    const chan = (v) =>
      (v.endsWith('%') ? parseFloat(v) * 2.55 : parseFloat(v)) / 255;
    const alpha =
      p.length > 3
        ? p[3].endsWith('%')
          ? parseFloat(p[3]) / 100
          : parseFloat(p[3])
        : 1;
    return premul(
      chan(p[0] || '0'),
      chan(p[1] || '0'),
      chan(p[2] || '0'),
      Number.isFinite(alpha) ? alpha : 1,
    );
  }
  if (s === 'transparent' || s === 'none') return CLEAR;
  const named = NAMED[s.toLowerCase()];
  if (named) return named;
  return BLACK;
}

function premul(r, g, b, a) {
  return Object.freeze([r * a, g * a, b * a, a]);
}

const NAMED = {
  black: BLACK,
  white: premul(1, 1, 1, 1),
  red: premul(1, 0, 0, 1),
  green: premul(0, 128 / 255, 0, 1),
  blue: premul(0, 0, 1, 1),
  gray: premul(128 / 255, 128 / 255, 128 / 255, 1),
  grey: premul(128 / 255, 128 / 255, 128 / 255, 1),
  yellow: premul(1, 1, 0, 1),
  orange: premul(1, 165 / 255, 0, 1),
  purple: premul(128 / 255, 0, 128 / 255, 1),
  cyan: premul(0, 1, 1, 1),
  magenta: premul(1, 0, 1, 1),
  silver: premul(192 / 255, 192 / 255, 192 / 255, 1),
  currentcolor: BLACK,
};

/**
 * A gradient: stops, and a 256-texel ramp texture baked from them on first
 * use. Interpolated premultiplied, which is what keeps a fade to transparent
 * from passing through grey.
 */
class Gradient {
  constructor(kind, a) {
    this.kind = kind; // 'linear' | 'radial'
    this.a = a; // linear: [x0,y0,x1,y1]; radial: [cx0,cy0,r0,cx1,cy1,r1]
    this.stops = [];
    this._ramp = null;
    this._baked = 0;
  }

  addColorStop(offset, color) {
    const o = Math.min(1, Math.max(0, Number(offset) || 0));
    this.stops.push({ offset: o, color: parseColor(color) });
    this.stops.sort((p, q) => p.offset - q.offset);
    return this;
  }

  /** the ramp as premultiplied RGBA8, 256 texels */
  ramp() {
    if (this._ramp && this._baked === this.stops.length) return this._ramp;
    const out = new Uint8Array(256 * 4);
    const stops = this.stops.length
      ? this.stops
      : [{ offset: 0, color: CLEAR }];
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let lo = stops[0];
      let hi = stops[stops.length - 1];
      for (let s = 0; s < stops.length - 1; s++) {
        if (t >= stops[s].offset && t <= stops[s + 1].offset) {
          lo = stops[s];
          hi = stops[s + 1];
          break;
        }
      }
      const span = hi.offset - lo.offset;
      const f = span > 0 ? Math.min(1, Math.max(0, (t - lo.offset) / span)) : 0;
      for (let c = 0; c < 4; c++) {
        out[i * 4 + c] = Math.round(
          (lo.color[c] + (hi.color[c] - lo.color[c]) * f) * 255,
        );
      }
    }
    this._ramp = out;
    this._baked = this.stops.length;
    this._dirty = true;
    return out;
  }
}

/**
 * The CSS font shorthand, as much of it as a UI writes:
 * `[style] [weight] size[px|pt] family[, family…]`.
 */
export function parseFont(font) {
  const m = String(font ?? '')
    .trim()
    .match(
      /^(?:(italic|oblique|normal)\s+)?(?:(normal|bold|bolder|lighter|[1-9]00)\s+)?(\d+(?:\.\d+)?)(px|pt)?(?:\s*\/\s*[^\s]+)?\s+(.+)$/i,
    );
  if (!m) return { italic: false, weight: 400, size: 16, family: 'sans-serif' };
  const size = parseFloat(m[3]) * (m[4]?.toLowerCase() === 'pt' ? 4 / 3 : 1);
  const w = (m[2] ?? 'normal').toLowerCase();
  const weight =
    w === 'bold' || w === 'bolder'
      ? 700
      : w === 'lighter'
        ? 300
        : w === 'normal'
          ? 400
          : parseInt(w, 10);
  const family = m[5]
    .split(',')[0]
    .trim()
    .replace(/^["']|["']$/g, '');
  return { italic: /italic|oblique/i.test(m[1] ?? ''), weight, size, family };
}

// ---- the context --------------------------------------------------------------

export class WaylandContext2D {
  /**
   * @param {object} gl the GLES entry points
   * @param {object} [opts]
   * @param {object} [opts.fontManager] an ntk FontManager, for `fillText`
   * @param {import('./target.js').GLTarget} [opts.target] where to draw
   */
  constructor(gl, { fontManager = null, target = null } = {}) {
    this.gl = gl;
    this.fontManager = fontManager;
    // `TextLayout.draw` opens with `ctx.window.app.display.Render` and reads
    // one constant from it. Satisfy the shape rather than fork the layout.
    this.window = { app: { display: { Render: { PictOp: { Over: 3 } } } } };
    this.atlas = new GlyphAtlas(gl);
    // Quads already buffered against the atlas must be drawn before the
    // atlas re-lays itself out under them.
    this.atlas.onBeforeGrow = () => this._flush();
    this._target = target;

    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.miterLimit = 10;
    this.globalAlpha = 1;
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
    this.timestamp = 0;
    this._font = '16px sans-serif';
    this._fontSpec = parseFont(this._font);
    this._fontFace = null;
    this._fontFaceFor = null;

    /** how many non-rectangular clips were approximated by their bbox */
    this.clipApproximations = 0;
    this.shapeStats = { quads: 0, batches: 0, glyphs: 0, paths: 0 };

    this._m = IDENTITY;
    this._stack = [];
    this._clip = null;
    this._path = new Path2D();
    this._rects = [];
    this._rectOnly = true;

    this._width = 0;
    this._height = 0;

    this._verts = new Float32Array(MAX_VERTS * STRIDE);
    this._n = 0;
    this._mode = MODE_SOLID;
    this._texture = null;
    this._swizzle = SWIZZLE_RGBA;
    this._drew = false;

    this._program = null;
    this._buffer = null;
    this._loc = {};
    /** image object -> { tex, w, h } */
    this._textures = new WeakMap();
    this._gradTex = new WeakMap();
  }

  // ---- lifecycle --------------------------------------------------------

  /** Compile the program and allocate the vertex buffer. Context must be current. */
  init() {
    const gl = this.gl;
    if (this._program) return;
    const vs = compile(gl, gl.VERTEX_SHADER, VERT, 'vertex');
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG, 'fragment');
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`2d program failed to link: ${gl.getProgramInfoLog(p)}`);
    }
    this._program = p;
    const u = (n) => gl.getUniformLocation(p, n);
    this._loc = {
      aPos: gl.getAttribLocation(p, 'aPos'),
      aUV: gl.getAttribLocation(p, 'aUV'),
      aColor: gl.getAttribLocation(p, 'aColor'),
      aParams: gl.getAttribLocation(p, 'aParams'),
      uViewport: u('uViewport'),
      uMode: u('uMode'),
      uSwizzle: u('uSwizzle'),
      uTex: u('uTex'),
      uGradKind: u('uGradKind'),
      uGradA: u('uGradA'),
      uGradB: u('uGradB'),
    };
    this._buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
    // The addon's bufferData takes a TypedArray, not the byte-length
    // overload WebGL also accepts. Allocated once; frames use bufferSubData.
    gl.bufferData(gl.ARRAY_BUFFER, this._verts, gl.DYNAMIC_DRAW);
  }

  /** Where this context draws. A window's backing, or a surface's target. */
  attach(target) {
    if (this._target !== target) this._flush();
    this._target = target;
  }

  get target() {
    return this._target;
  }

  /**
   * Start a frame. Resets state as a fresh canvas would, binds the target,
   * and sizes the projection to it.
   */
  begin(width, height, timestamp = 0) {
    this.init();
    const gl = this.gl;
    const t = this._target;
    if (t) {
      t.bind();
      width = t.width;
      height = t.height;
    }
    this._width = width;
    this._height = height;
    this._m = IDENTITY;
    this._stack.length = 0;
    this._clip = null;
    this._path = new Path2D();
    this._rects = [];
    this._rectOnly = true;
    this._n = 0;
    this._drew = false;
    this.timestamp = timestamp;
    this.shapeStats = { quads: 0, batches: 0, glyphs: 0, paths: 0 };
    this.clipApproximations = 0;

    gl.useProgram(this._program);
    gl.uniform2f(this._loc.uViewport, width, height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.colorMask(true, true, true, true);
    // Premultiplied alpha throughout — colours are premultiplied on the way
    // in, and the glyph and texture paths both produce premultiplied output.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Flush anything still buffered. Call before presenting. */
  end() {
    this._flush();
    this.gl.disable(this.gl.SCISSOR_TEST);
  }

  /** Whether anything was drawn since `begin()`. */
  get drew() {
    return this._drew || this._n > 0;
  }

  // ---- state ------------------------------------------------------------

  save() {
    this._stack.push({
      m: this._m,
      clip: this._clip,
      fill: this.fillStyle,
      stroke: this.strokeStyle,
      lw: this.lineWidth,
      cap: this.lineCap,
      join: this.lineJoin,
      miter: this.miterLimit,
      alpha: this.globalAlpha,
      font: this._font,
      align: this.textAlign,
      baseline: this.textBaseline,
    });
  }

  restore() {
    const s = this._stack.pop();
    if (!s) return;
    if (s.clip !== this._clip) this._flush();
    this._m = s.m;
    this._clip = s.clip;
    this.fillStyle = s.fill;
    this.strokeStyle = s.stroke;
    this.lineWidth = s.lw;
    this.lineCap = s.cap;
    this.lineJoin = s.join;
    this.miterLimit = s.miter;
    this.globalAlpha = s.alpha;
    if (s.font !== this._font) this.font = s.font;
    this.textAlign = s.align;
    this.textBaseline = s.baseline;
  }

  translate(x, y) {
    this._m = mul(this._m, [1, 0, 0, 1, x, y]);
  }

  scale(x, y = x) {
    this._m = mul(this._m, [x, 0, 0, y, 0, 0]);
  }

  rotate(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    this._m = mul(this._m, [c, s, -s, c, 0, 0]);
  }

  transform(a, b, c, d, e, f) {
    this._m = mul(this._m, [a, b, c, d, e, f]);
  }

  setTransform(a, b, c, d, e, f) {
    if (typeof a === 'object' && a) this._m = [a.a, a.b, a.c, a.d, a.e, a.f];
    else this._m = [a, b, c, d, e, f];
  }

  resetTransform() {
    this._m = IDENTITY;
  }

  getTransform() {
    const [a, b, c, d, e, f] = this._m;
    return { a, b, c, d, e, f };
  }

  setLineDash() {
    // Dashes are a stroke-geometry feature not implemented here; accepted
    // and ignored so a caller that dashes a focus ring still gets the ring.
  }

  getLineDash() {
    return [];
  }

  get font() {
    return this._font;
  }

  set font(value) {
    if (value === this._font) return;
    this._font = String(value);
    this._fontSpec = parseFont(this._font);
    this._fontFace = null;
  }

  createLinearGradient(x0, y0, x1, y1) {
    return new Gradient('linear', [x0, y0, x1, y1]);
  }

  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    return new Gradient('radial', [x0, y0, r0, x1, y1, r1]);
  }

  createPattern() {
    // Patterns need a repeating texture mode; not yet.
    return null;
  }

  // ---- paths ------------------------------------------------------------

  beginPath() {
    this._path = new Path2D();
    this._rects = [];
    this._rectOnly = true;
  }

  rect(x, y, w, h) {
    this._rects.push({ x, y, w, h, r: 0 });
    this._path.rect(x, y, w, h);
  }

  roundRect(x, y, w, h, radii) {
    const r = Array.isArray(radii) ? Number(radii[0]) || 0 : Number(radii) || 0;
    this._rects.push({ x, y, w, h, r });
    this._path.roundRect(x, y, w, h, radii);
  }

  moveTo(x, y) {
    this._rectOnly = false;
    this._path.moveTo(x, y);
  }

  lineTo(x, y) {
    this._rectOnly = false;
    this._path.lineTo(x, y);
  }

  closePath() {
    this._path.closePath();
  }

  bezierCurveTo(x1, y1, x2, y2, x, y) {
    this._rectOnly = false;
    this._path.bezierCurveTo(x1, y1, x2, y2, x, y);
  }

  quadraticCurveTo(x1, y1, x, y) {
    this._rectOnly = false;
    this._path.quadraticCurveTo(x1, y1, x, y);
  }

  arc(x, y, r, a0, a1, ccw) {
    this._rectOnly = false;
    this._path.arc(x, y, r, a0, a1, ccw);
  }

  arcTo(x1, y1, x2, y2, r) {
    this._rectOnly = false;
    this._path.arcTo(x1, y1, x2, y2, r);
  }

  ellipse(x, y, rx, ry, rot, a0, a1, ccw) {
    this._rectOnly = false;
    this._path.ellipse(x, y, rx, ry, rot, a0, a1, ccw);
  }

  /**
   * `fill()`, `fill(rule)`, `fill(path)`, `fill(path, rule)`.
   *
   * Rectangles and rounded rectangles built with `rect`/`roundRect` take the
   * analytic path; anything else is flattened and stencilled.
   */
  fill(a, b) {
    const external = a instanceof Path2D ? a : null;
    const rule = (external ? b : a) === 'evenodd' ? 'evenodd' : 'nonzero';
    if (!external && this._rectOnly) {
      for (const r of this._rects)
        this._rect(r.x, r.y, r.w, r.h, r.r, this.fillStyle, 0);
      return;
    }
    const cmds = external ? external._cmds : this._path._cmds;
    const polys = flattenPath(cmds, this._m);
    this._fillPolys(polys, rule, this.fillStyle);
  }

  stroke(external) {
    const p = external instanceof Path2D ? external : null;
    if (!p && this._rectOnly) {
      for (const r of this._rects)
        this._rect(
          r.x,
          r.y,
          r.w,
          r.h,
          r.r,
          this.strokeStyle,
          Math.max(0.5, this.lineWidth),
        );
      return;
    }
    const cmds = p ? p._cmds : this._path._cmds;
    const polylines = flattenPath(cmds, this._m);
    const width = Math.max(0.5, this.lineWidth * scaleOf(this._m));
    const polys = strokePolys(
      polylines,
      width,
      this.lineJoin,
      this.lineCap,
      this.miterLimit,
    );
    this._fillPolys(polys, 'nonzero', this.strokeStyle);
  }

  /**
   * Intersect the clip with the current path's bounds.
   *
   * Exact for an axis-aligned rectangle; everything else is its bounding box,
   * counted in `clipApproximations`.
   */
  clip(a) {
    const external = a instanceof Path2D ? a : null;
    let bounds = null;
    let exact = true;
    if (!external && this._rectOnly && isAxisAligned(this._m)) {
      for (const r of this._rects) {
        const d = this._deviceRect(r.x, r.y, r.w, r.h);
        bounds = bounds ? unionRect(bounds, d) : d;
        if (r.r > 0) exact = false;
      }
    } else {
      exact = false;
      const polys = flattenPath(
        external ? external._cmds : this._path._cmds,
        this._m,
      );
      bounds = polysBounds(polys);
    }
    if (!bounds) {
      // an empty path clips everything
      bounds = { x: 0, y: 0, w: 0, h: 0 };
    }
    if (!exact) this.clipApproximations++;
    this._flush();
    this._clip = this._clip ? intersectRect(this._clip, bounds) : bounds;
  }

  isPointInPath(x, y) {
    const polys = flattenPath(this._path._cmds, this._m);
    const dx = applyX(this._m, x, y);
    const dy = applyY(this._m, x, y);
    return polysContain(polys, dx, dy);
  }

  // ---- fills ------------------------------------------------------------

  fillRect(x, y, w, h) {
    this._rect(x, y, w, h, 0, this.fillStyle, 0);
  }

  strokeRect(x, y, w, h) {
    this._rect(x, y, w, h, 0, this.strokeStyle, Math.max(0.5, this.lineWidth));
  }

  /** The batched form react-x11 uses for backgrounds and selection bands. */
  fillRects(rects) {
    for (const r of rects) {
      const x = r.x ?? r[0];
      const y = r.y ?? r[1];
      const w = r.width ?? r.w ?? r[2];
      const h = r.height ?? r.h ?? r[3];
      this._rect(x, y, w, h, 0, this.fillStyle, 0);
    }
  }

  /**
   * A blurred rounded-rectangle shadow, drawn analytically: the distance
   * field's edge is feathered by the blur radius instead of stepping at
   * zero. `boxpaint.js` calls this when it exists, in place of rendering
   * coverage to a surface and gaussian-blurring it on the CPU — the same
   * look for the shapes a box shadow can have, at the cost of one quad.
   */
  fillShadow(rect, radius, blur, color) {
    const feather = Math.max(0.5, blur);
    this._rect(
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      radius,
      color,
      -feather,
    );
  }

  /** Clear to transparent — writes zeroes rather than blending. */
  clearRect(x, y, w, h) {
    if (!(w > 0 && h > 0)) return;
    this._flush();
    const gl = this.gl;
    gl.blendFunc(gl.ONE, gl.ZERO);
    this._emitRect(x, y, w, h, CLEAR);
    this._flush();
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  _rect(x, y, w, h, radius, style, strokeWidth) {
    if (!(w > 0 && h > 0)) return;
    if (style instanceof Gradient) {
      if (radius <= 0 && strokeWidth === 0)
        return this._gradientQuad(x, y, w, h, style);
      // rounded/stroked gradient: stencil the shape, cover with the gradient
      const p = new Path2D();
      p.roundRect(x, y, w, h, radius);
      const polys = flattenPath(p._cmds, this._m);
      return this._fillPolys(polys, 'nonzero', style);
    }
    const color = this._color(style);
    if (color[3] === 0) return;
    if (radius <= 0 && strokeWidth === 0 && isAxisAligned(this._m)) {
      return this._emitRect(x, y, w, h, color);
    }
    // Rounded, stroked, shadowed or rotated: hand the shader the rect in its
    // own space, padded so the antialiased edge (or feather) has room.
    const pad =
      strokeWidth > 0
        ? strokeWidth * 0.5 + 1
        : strokeWidth < 0
          ? -strokeWidth + 1
          : 1;
    const hw = w / 2;
    const hh = h / 2;
    const cx = x + hw;
    const cy = y + hh;
    const r = Math.min(Math.max(0, radius), hw, hh);
    this._setMode(MODE_RRECT, null, SWIZZLE_RGBA);
    const m = this._m;
    const s = scaleOf(m);
    const px = pad / s;
    const c = [
      [-hw - px, -hh - px],
      [hw + px, -hh - px],
      [hw + px, hh + px],
      [-hw - px, hh + px],
    ];
    const pos = new Array(8);
    const uv = new Array(8);
    for (let i = 0; i < 4; i++) {
      const [dx, dy] = c[i];
      pos[i * 2] = applyX(m, cx + dx, cy + dy);
      pos[i * 2 + 1] = applyY(m, cx + dx, cy + dy);
      uv[i * 2] = dx * s;
      uv[i * 2 + 1] = dy * s;
    }
    this._quad(pos, uv, color, [hw * s, hh * s, r * s, strokeWidth]);
  }

  _emitRect(x, y, w, h, color) {
    this._setMode(MODE_SOLID, null, SWIZZLE_RGBA);
    const m = this._m;
    this._quad(
      [
        applyX(m, x, y),
        applyY(m, x, y),
        applyX(m, x + w, y),
        applyY(m, x + w, y),
        applyX(m, x + w, y + h),
        applyY(m, x + w, y + h),
        applyX(m, x, y + h),
        applyY(m, x, y + h),
      ],
      UV_UNIT,
      color,
      ZERO4,
    );
  }

  /** Bind a gradient's ramp and endpoints as the current batch's uniforms. */
  _useGradient(grad) {
    const gl = this.gl;
    this._flush();
    let tex = this._gradTex.get(grad);
    const ramp = grad.ramp();
    if (!tex) {
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._gradTex.set(grad, tex);
      grad._dirty = true;
    }
    if (grad._dirty) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        256,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        ramp,
      );
      grad._dirty = false;
    }
    this._mode = MODE_GRADIENT;
    this._texture = tex;
    this._swizzle = SWIZZLE_RGBA;
    const m = this._m;
    const a = grad.a;
    gl.useProgram(this._program);
    if (grad.kind === 'linear') {
      gl.uniform1i(this._loc.uGradKind, 0);
      gl.uniform4f(
        this._loc.uGradA,
        applyX(m, a[0], a[1]),
        applyY(m, a[0], a[1]),
        0,
        0,
      );
      gl.uniform4f(
        this._loc.uGradB,
        applyX(m, a[2], a[3]),
        applyY(m, a[2], a[3]),
        0,
        0,
      );
    } else {
      const s = scaleOf(m);
      gl.uniform1i(this._loc.uGradKind, 1);
      gl.uniform4f(
        this._loc.uGradA,
        applyX(m, a[3], a[4]),
        applyY(m, a[3], a[4]),
        a[2] * s,
        0,
      );
      gl.uniform4f(this._loc.uGradB, a[5] * s, 0, 0, 0);
    }
  }

  _gradientQuad(x, y, w, h, grad) {
    this._useGradient(grad);
    const m = this._m;
    const alpha = this.globalAlpha;
    this._quad(
      [
        applyX(m, x, y),
        applyY(m, x, y),
        applyX(m, x + w, y),
        applyY(m, x + w, y),
        applyX(m, x + w, y + h),
        applyY(m, x + w, y + h),
        applyX(m, x, y + h),
        applyY(m, x, y + h),
      ],
      UV_UNIT,
      [alpha, alpha, alpha, alpha],
      ZERO4,
    );
    this._flush();
  }

  // ---- stencil-then-cover -----------------------------------------------

  /**
   * Fill device-space polygons with a paint.
   *
   * Pass 1 counts winding into the stencil buffer with colour writes off:
   * one triangle fan per subpath, incrementing for one facing and
   * decrementing for the other (two draws with culling, since the binding
   * has no `stencilOpSeparate`), or inverting for even-odd. Pass 2 covers
   * the bounds with the paint wherever the count is non-zero, zeroing the
   * stencil as it goes so the next path starts clean. The scissor applies to
   * both, which is what keeps a clipped path from leaving counts outside the
   * clip.
   */
  _fillPolys(polys, rule, style) {
    const bounds = polysBounds(polys);
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) return;
    if (!(style instanceof Gradient)) {
      const c = this._color(style);
      if (c[3] === 0) return;
    }
    const gl = this.gl;
    this._flush();
    this.shapeStats.paths++;

    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    this._mode = MODE_SOLID;
    this._texture = null;
    this._swizzle = SWIZZLE_RGBA;

    const fans = () => {
      for (const poly of polys) {
        const p = poly.pts;
        if (p.length < 6) continue;
        for (let i = 2; i + 1 < p.length; i += 2) {
          this._tri(p[0], p[1], p[i - 2], p[i - 1], p[i], p[i + 1]);
        }
      }
      this._flush();
    };
    if (rule === 'evenodd') {
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
      fans();
    } else {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR_WRAP);
      fans();
      gl.cullFace(gl.FRONT);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.DECR_WRAP);
      fans();
      gl.disable(gl.CULL_FACE);
    }

    // cover
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
    gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
    const { x, y, w, h } = bounds;
    const saved = this._m;
    this._m = IDENTITY;
    if (style instanceof Gradient) {
      this._m = saved; // gradient endpoints are in user space
      this._useGradient(style);
      this._m = IDENTITY;
      const a = this.globalAlpha;
      this._quad(
        [x, y, x + w, y, x + w, y + h, x, y + h],
        UV_UNIT,
        [a, a, a, a],
        ZERO4,
      );
    } else {
      this._emitRect(x, y, w, h, this._color(style));
    }
    this._flush();
    this._m = saved;
    gl.disable(gl.STENCIL_TEST);
  }

  // ---- images -----------------------------------------------------------

  /**
   * Draw an image, a canvas `ImageData`, or an offscreen surface.
   *
   * `(img, dx, dy)`, `(img, dx, dy, dw, dh)` and
   * `(img, sx, sy, sw, sh, dx, dy, dw, dh)`, as canvas.
   */
  drawImage(img, ...args) {
    const src = this._textureFor(img);
    if (!src) return;
    let sx = 0;
    let sy = 0;
    let sw = src.w;
    let sh = src.h;
    let dx;
    let dy;
    let dw;
    let dh;
    if (args.length >= 8) [sx, sy, sw, sh, dx, dy, dw, dh] = args;
    else if (args.length >= 4) [dx, dy, dw, dh] = args;
    else {
      [dx, dy] = args;
      dw = sw;
      dh = sh;
    }
    if (!(dw > 0 && dh > 0 && sw > 0 && sh > 0)) return;
    this._setMode(MODE_TEXTURE, src.tex, src.swizzle);
    let u0 = sx / src.w;
    let v0 = sy / src.h;
    let u1 = (sx + sw) / src.w;
    let v1 = (sy + sh) / src.h;
    if (src.flipY) {
      // a render target's row 0 is the bottom of what was drawn into it
      v0 = 1 - v0;
      v1 = 1 - v1;
    }
    const m = this._m;
    const a = this.globalAlpha;
    this._quad(
      [
        applyX(m, dx, dy),
        applyY(m, dx, dy),
        applyX(m, dx + dw, dy),
        applyY(m, dx + dw, dy),
        applyX(m, dx + dw, dy + dh),
        applyY(m, dx + dw, dy + dh),
        applyX(m, dx, dy + dh),
        applyY(m, dx, dy + dh),
      ],
      [u0, v0, u1, v0, u1, v1, u0, v1],
      [a, a, a, a],
      ZERO4,
    );
  }

  /**
   * Write pixels, ignoring the transform and the clip (the canvas rule).
   * `dirtyX/Y/Width/Height` select part of the data, as the spec has it.
   */
  putImageData(data, x, y, dirtyX = 0, dirtyY = 0, dirtyWidth, dirtyHeight) {
    if (!data?.width || !data?.height) return;
    const dw = dirtyWidth ?? data.width;
    const dh = dirtyHeight ?? data.height;
    this._flush();
    const savedM = this._m;
    const savedClip = this._clip;
    const savedAlpha = this.globalAlpha;
    this._m = IDENTITY;
    this._clip = null;
    this.globalAlpha = 1;
    // Replace rather than blend, as the spec requires.
    const gl = this.gl;
    gl.blendFunc(gl.ONE, gl.ZERO);
    this.drawImage(
      data,
      dirtyX,
      dirtyY,
      dw,
      dh,
      x + dirtyX,
      y + dirtyY,
      dw,
      dh,
    );
    this._flush();
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this._m = savedM;
    this._clip = savedClip;
    this.globalAlpha = savedAlpha;
  }

  /** Read pixels back as straight RGBA, top row first. */
  getImageData(x, y, w, h) {
    this._flush();
    const gl = this.gl;
    const W = Math.max(0, w | 0);
    const H = Math.max(0, h | 0);
    const raw = new Uint8Array(W * H * 4);
    if (W && H) {
      gl.readPixels(
        x | 0,
        this._height - (y | 0) - H,
        W,
        H,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        raw,
      );
    }
    const data = new Uint8ClampedArray(W * H * 4);
    const row = W * 4;
    for (let r = 0; r < H; r++)
      data.set(raw.subarray((H - 1 - r) * row, (H - r) * row), r * row);
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a === 0 || a === 255) continue;
      data[i] = Math.min(255, (data[i] * 255) / a);
      data[i + 1] = Math.min(255, (data[i + 1] * 255) / a);
      data[i + 2] = Math.min(255, (data[i + 2] * 255) / a);
    }
    return { width: W, height: H, data };
  }

  createImageData(w, h) {
    return {
      width: w | 0,
      height: h | 0,
      data: new Uint8ClampedArray((w | 0) * (h | 0) * 4),
    };
  }

  /**
   * A texture for an image-like thing, with its byte layout.
   *
   * ntk `Image`s are immutable and uploaded once. `ImageData` is written by
   * the caller between draws, so its bytes go up every time — into the same
   * texture when the size has not changed. A render target *is* a texture.
   */
  _textureFor(img) {
    if (!img) return null;
    const gl = this.gl;
    const target =
      img instanceof GLTarget
        ? img
        : img.target instanceof GLTarget
          ? img.target
          : null;
    if (target)
      return {
        tex: target.texture,
        w: target.width,
        h: target.height,
        swizzle: SWIZZLE_RGBA,
        flipY: true,
      };

    const w = img.width | 0;
    const h = img.height | 0;
    const data = img.data ?? img.pixels;
    if (!w || !h || !data) return null;
    const isNtkImage = img instanceof NtkImage;
    const swizzle = isNtkImage
      ? SWIZZLE_BGRA
      : data instanceof Uint8ClampedArray
        ? SWIZZLE_STRAIGHT
        : img.premultiplied === false
          ? SWIZZLE_STRAIGHT
          : SWIZZLE_RGBA;

    let entry = this._textures.get(img);
    const bytes =
      data instanceof Uint8Array
        ? data
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (!entry || entry.w !== w || entry.h !== h) {
      if (entry) gl.deleteTexture(entry.tex);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        w,
        h,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        bytes,
      );
      entry = { tex, w, h, swizzle, flipY: false, immutable: isNtkImage };
      this._textures.set(img, entry);
    } else if (!entry.immutable) {
      this._flush();
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        w,
        h,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        bytes,
      );
    }
    return entry;
  }

  // ---- text -------------------------------------------------------------

  /**
   * ntk's glyph-drawing contract, which is how `TextLayout.draw` reaches a
   * context — and therefore how every `<text>`, `<textinput>` and
   * `<textarea>` in react-x11 gets on screen.
   *
   * The signature is XRender's: a `PictOp`, a source `Picture`, and glyph
   * runs already placed at absolute baselines. The op is always `Over` for
   * text and the source is always a solid colour, so what this does is take
   * the colour back out of the stand-in `_stylePicture` handed over and draw
   * the runs through the atlas.
   *
   * @param {number} op ignored — text is always drawn `Over`
   * @param {{color?:string}} src what `_stylePicture` returned
   * @param {Array<{run:object, x:number, y:number}>} positioned
   */
  drawGlyphs(op, src, positioned) {
    if (!Array.isArray(positioned)) return;
    const color = src?.color ?? this.fillStyle;
    const runs = [];
    for (const p of positioned) {
      const run = p.run;
      if (!run?.glyphs?.length) continue;
      // ntk's shaped glyphs carry advances, not positions: the server walked
      // the run and accumulated them. There is no server, so walk it here.
      let pen = p.x;
      const glyphs = [];
      for (const g of run.glyphs) {
        glyphs.push({ id: g.id, x: pen + (g.dx ?? 0), y: p.y + (g.dy ?? 0) });
        pen += g.ax ?? 0;
      }
      runs.push({ font: run.font, size: run.size, glyphs, color });
    }
    this.drawTextRuns(runs);
  }

  /** A solid-colour stand-in for the XRender `Picture` a source would be. */
  _stylePicture(color) {
    return { color };
  }

  get _backgroundPicture() {
    return { color: this.fillStyle };
  }

  /** The X11 context tracks dirty regions for its damage; this one does not. */
  _markDirty() {}

  /**
   * Draw positioned glyph runs through the atlas.
   *
   * Glyph origins are rounded to whole device pixels — the same rule ntk's
   * layout applies — because a glyph bitmap sampled at a fractional offset
   * under linear filtering is a blurred glyph.
   *
   * @param {Array<{font, size, glyphs:Array<{id,x,y}>, color}>} runs
   */
  drawTextRuns(runs) {
    const m = this._m;
    for (const run of runs) {
      const font = run.font;
      if (!font) continue;
      const size = run.size ?? font.size ?? 16;
      const color = this._color(run.color ?? this.fillStyle);
      if (color[3] === 0) continue;
      const key = font.postscriptName ?? font.familyName ?? 'f';
      const tex = this.atlas.bind();
      this._setMode(MODE_GLYPH, tex, SWIZZLE_RGBA);
      for (const g of run.glyphs) {
        const entry = this.atlas.get(`${key}|${size}|${g.id}`, () =>
          font.rasterize(g.id, size),
        );
        if (entry.empty) continue;
        // `left`/`top` are the bitmap's offset from the glyph origin in the
        // rasteriser's **y-down** pixel space: a cap-height glyph has a
        // negative `top` (H at 32px: -24).
        const ox = Math.round(applyX(m, g.x, g.y)) + entry.left;
        const oy = Math.round(applyY(m, g.x, g.y)) + entry.top;
        // the atlas may have grown mid-run; rebind so the batch names the
        // new texture (the old quads were flushed by onBeforeGrow)
        if (this.atlas.texture !== this._texture)
          this._setMode(MODE_GLYPH, this.atlas.bind(), SWIZZLE_RGBA);
        this._quad(
          [
            ox,
            oy,
            ox + entry.w,
            oy,
            ox + entry.w,
            oy + entry.h,
            ox,
            oy + entry.h,
          ],
          [
            entry.u0,
            entry.v0,
            entry.u1,
            entry.v0,
            entry.u1,
            entry.v1,
            entry.u0,
            entry.v1,
          ],
          color,
          ZERO4,
        );
        this.shapeStats.glyphs++;
      }
      // anything rasterised in this run goes up before the batch is drawn
      if (this.atlas._dirty || this.atlas._fresh) this.atlas.bind();
    }
  }

  /** The Font for the current `font` string, or null while it is loading. */
  _resolveFont() {
    if (!this.fontManager) return null;
    if (this._fontFace && this._fontFaceFor === this._font)
      return this._fontFace;
    const spec = this._fontSpec;
    let face = null;
    try {
      face = this.fontManager.match({
        family: spec.family,
        weight: spec.weight,
        italic: spec.italic,
        size: spec.size,
      });
    } catch {
      return null;
    }
    if (face && typeof face.then === 'function') {
      // a face still opening: use it next time
      face.then(
        (f) => {
          if (this._font === spec && f) {
            this._fontFace = f;
            this._fontFaceFor = this._font;
          }
        },
        () => {},
      );
      return null;
    }
    this._fontFace = face;
    this._fontFaceFor = this._font;
    return face;
  }

  /** Shaped text for `fillText`/`measureText`, through ntk's shaping memo. */
  _shape(text) {
    const face = this._resolveFont();
    if (!face) return null;
    const spec = this._fontSpec;
    const style = {
      font: face,
      family: spec.family,
      size: spec.size,
      weight: spec.weight,
      italic: spec.italic,
    };
    const shaped = this.fontManager._shapeCachedWhole(String(text), style);
    return { shaped, style };
  }

  fillText(text, x, y) {
    text = String(text ?? '');
    if (!text) return;
    const r = this._shape(text);
    if (!r) return;
    const { shaped, style } = r;
    const metrics = style.font.metrics(style.size);
    let ax = 0;
    let align = this.textAlign;
    if (align === 'start') align = shaped.baseLevel & 1 ? 'right' : 'left';
    if (align === 'end') align = shaped.baseLevel & 1 ? 'left' : 'right';
    if (align === 'center') ax = -shaped.width / 2;
    else if (align === 'right') ax = -shaped.width;
    let ay = 0;
    switch (this.textBaseline) {
      case 'top':
        ay = metrics.ascent;
        break;
      case 'hanging':
        ay = metrics.ascent * 0.8;
        break;
      case 'middle':
        ay = (metrics.ascent - metrics.descent) / 2;
        break;
      case 'bottom':
      case 'ideographic':
        ay = -metrics.descent;
        break;
      default:
        ay = 0;
    }
    const positioned = [];
    let cursor = x + ax;
    for (const run of shaped.runs) {
      positioned.push({ run, x: cursor, y: y + ay });
      cursor += run.width;
    }
    this.drawGlyphs(3, { color: this.fillStyle }, positioned);
  }

  strokeText(text, x, y) {
    // No outline stroking of glyphs; the fill is the honest approximation.
    const saved = this.fillStyle;
    this.fillStyle = this.strokeStyle;
    this.fillText(text, x, y);
    this.fillStyle = saved;
  }

  measureText(text) {
    const r = this._shape(String(text ?? ''));
    if (!r)
      return {
        width: 0,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: 0,
        actualBoundingBoxAscent: 0,
        actualBoundingBoxDescent: 0,
      };
    const { shaped, style } = r;
    const m = style.font.metrics(style.size);
    return {
      width: shaped.width,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: shaped.width,
      actualBoundingBoxAscent: m.ascent,
      actualBoundingBoxDescent: m.descent,
      fontBoundingBoxAscent: m.ascent,
      fontBoundingBoxDescent: m.descent,
    };
  }

  // ---- batching ---------------------------------------------------------

  _color(style) {
    const c = parseColor(style);
    if (this.globalAlpha >= 1) return c;
    const a = this.globalAlpha;
    return [c[0] * a, c[1] * a, c[2] * a, c[3] * a];
  }

  _setMode(mode, texture, swizzle) {
    if (
      mode !== this._mode ||
      texture !== this._texture ||
      swizzle !== this._swizzle
    ) {
      this._flush();
      this._mode = mode;
      this._texture = texture;
      this._swizzle = swizzle;
    }
  }

  /** Two triangles from four corners, in order TL, TR, BR, BL. */
  _quad(pos, uv, color, params) {
    if (this._n + 6 > MAX_VERTS) this._flush();
    const v = this._verts;
    let o = this._n * STRIDE;
    for (let k = 0; k < 6; k++) {
      const i = TRI[k];
      v[o++] = pos[i * 2];
      v[o++] = pos[i * 2 + 1];
      v[o++] = uv[i * 2];
      v[o++] = uv[i * 2 + 1];
      v[o++] = color[0];
      v[o++] = color[1];
      v[o++] = color[2];
      v[o++] = color[3];
      v[o++] = params[0];
      v[o++] = params[1];
      v[o++] = params[2];
      v[o++] = params[3];
    }
    this._n += 6;
    this.shapeStats.quads++;
  }

  /** One triangle, for the stencil pass. Colour and params are irrelevant. */
  _tri(x0, y0, x1, y1, x2, y2) {
    if (this._n + 3 > MAX_VERTS) this._flush();
    const v = this._verts;
    let o = this._n * STRIDE;
    const pts = [x0, y0, x1, y1, x2, y2];
    for (let k = 0; k < 3; k++) {
      v[o++] = pts[k * 2];
      v[o++] = pts[k * 2 + 1];
      o += 10;
    }
    this._n += 3;
  }

  _flush() {
    if (this._n === 0) return;
    const gl = this.gl;
    const { aPos, aUV, aColor, aParams } = this._loc;

    gl.useProgram(this._program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this._verts.subarray(0, this._n * STRIDE),
    );

    const bytes = STRIDE * 4;
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, bytes, 0);
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, bytes, 8);
    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, bytes, 16);
    gl.enableVertexAttribArray(aParams);
    gl.vertexAttribPointer(aParams, 4, gl.FLOAT, false, bytes, 32);

    gl.uniform1i(this._loc.uMode, this._mode);
    gl.uniform1i(this._loc.uSwizzle, this._swizzle);
    if (this._texture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texture);
      gl.uniform1i(this._loc.uTex, 0);
    }

    if (this._clip) {
      gl.enable(gl.SCISSOR_TEST);
      // Scissor is y-up from the bottom-left; our clips are y-down. Snap
      // outward to whole pixels, as XRender's integer clip would.
      const x0 = Math.floor(this._clip.x);
      const y0 = Math.floor(this._clip.y);
      const x1 = Math.ceil(this._clip.x + this._clip.w);
      const y1 = Math.ceil(this._clip.y + this._clip.h);
      gl.scissor(
        x0,
        Math.max(0, this._height - y1),
        Math.max(0, x1 - x0),
        Math.max(0, y1 - y0),
      );
    } else {
      gl.disable(gl.SCISSOR_TEST);
    }

    gl.drawArrays(gl.TRIANGLES, 0, this._n);
    this._n = 0;
    this._drew = true;
    this.shapeStats.batches++;
  }

  _deviceRect(x, y, w, h) {
    const m = this._m;
    const x0 = applyX(m, x, y);
    const y0 = applyY(m, x, y);
    const x1 = applyX(m, x + w, y + h);
    const y1 = applyY(m, x + w, y + h);
    return {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      w: Math.abs(x1 - x0),
      h: Math.abs(y1 - y0),
    };
  }

  destroy() {
    this.atlas.destroy();
    if (this._buffer) this.gl.deleteBuffer(this._buffer);
    if (this._program) this.gl.deleteProgram(this._program);
    this._buffer = null;
    this._program = null;
  }
}

const UV_UNIT = Object.freeze([0, 0, 1, 0, 1, 1, 0, 1]);
const ZERO4 = Object.freeze([0, 0, 0, 0]);

// ---- geometry helpers ------------------------------------------------------------

function intersectRect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, r - x), h: Math.max(0, bt - y) };
}

function unionRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

function polysBounds(polys) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const poly of polys) {
    const p = poly.pts;
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < x0) x0 = p[i];
      if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1];
      if (p[i + 1] > y1) y1 = p[i + 1];
    }
  }
  if (!(x1 >= x0 && y1 >= y0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function polysContain(polys, x, y) {
  let wn = 0;
  for (const poly of polys) {
    const p = poly.pts;
    const n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = p[i * 2];
      const ay = p[i * 2 + 1];
      const bx = p[((i + 1) % n) * 2];
      const by = p[((i + 1) % n) * 2 + 1];
      if (ay <= y) {
        if (by > y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) wn++;
      } else if (by <= y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0)
        wn--;
    }
  }
  return wn !== 0;
}

/**
 * Polygons whose non-zero union is the stroke of the given polylines: a
 * quad per segment, a join polygon per interior vertex (a small circle for
 * round joins, a bevel triangle otherwise, plus the miter tip when it is
 * within the limit), and round caps when asked. Every polygon is emitted
 * with the same orientation so that overlapping pieces add rather than
 * cancel under the non-zero rule.
 */
function strokePolys(polylines, width, join, cap, miterLimit) {
  const hw = width / 2;
  const out = [];
  const push = (pts) => {
    // consistent orientation: positive signed area
    let area = 0;
    for (let i = 0; i < pts.length; i += 2) {
      const j = (i + 2) % pts.length;
      area += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
    }
    if (area < 0) {
      const rev = [];
      for (let i = pts.length - 2; i >= 0; i -= 2) rev.push(pts[i], pts[i + 1]);
      pts = rev;
    }
    out.push({ pts, closed: true });
  };
  const circle = (cx, cy) => {
    const n = hw < 2 ? 6 : hw < 6 ? 10 : 16;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push(cx + Math.cos(a) * hw, cy + Math.sin(a) * hw);
    }
    push(pts);
  };
  for (const line of polylines) {
    const p = line.pts;
    let n = p.length / 2;
    if (n < 2) {
      if (n === 1 && cap === 'round') circle(p[0], p[1]);
      continue;
    }
    const closed = line.closed;
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const ax = p[i * 2];
      const ay = p[i * 2 + 1];
      const j = (i + 1) % n;
      const bx = p[j * 2];
      const by = p[j * 2 + 1];
      let dx = bx - ax;
      let dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;
      dx /= len;
      dy /= len;
      const nx = -dy * hw;
      const ny = dx * hw;
      let ex = 0;
      let ey = 0;
      if (!closed && cap === 'square') {
        ex = dx * hw;
        ey = dy * hw;
      }
      const sx = i === 0 ? ex : 0;
      const sy = i === 0 ? ey : 0;
      const tx = i === segs - 1 ? ex : 0;
      const ty = i === segs - 1 ? ey : 0;
      push([
        ax - sx + nx,
        ay - sy + ny,
        bx + tx + nx,
        by + ty + ny,
        bx + tx - nx,
        by + ty - ny,
        ax - sx - nx,
        ay - sy - ny,
      ]);
    }
    // joins
    const first = closed ? 0 : 1;
    const last = closed ? n - 1 : n - 2;
    for (let i = first; i <= last; i++) {
      const cx = p[i * 2];
      const cy = p[i * 2 + 1];
      if (join === 'round' || hw <= 1) {
        circle(cx, cy);
        continue;
      }
      const prev = (i - 1 + n) % n;
      const next = (i + 1) % n;
      const ux = cx - p[prev * 2];
      const uy = cy - p[prev * 2 + 1];
      const vx = p[next * 2] - cx;
      const vy = p[next * 2 + 1] - cy;
      const ul = Math.hypot(ux, uy);
      const vl = Math.hypot(vx, vy);
      if (!ul || !vl) continue;
      const n1x = (-uy / ul) * hw;
      const n1y = (ux / ul) * hw;
      const n2x = (-vy / vl) * hw;
      const n2y = (vx / vl) * hw;
      const cross = ux * vy - uy * vx;
      const s = cross > 0 ? -1 : 1; // outer side
      const o1x = cx + n1x * s;
      const o1y = cy + n1y * s;
      const o2x = cx + n2x * s;
      const o2y = cy + n2y * s;
      // bevel
      push([cx, cy, o1x, o1y, o2x, o2y]);
      if (join === 'miter') {
        const cosHalf = Math.sqrt((1 + (ux * vx + uy * vy) / (ul * vl)) / 2);
        if (cosHalf > 1e-3 && 1 / cosHalf <= miterLimit) {
          const mx = (o1x + o2x) / 2 - cx;
          const my = (o1y + o2y) / 2 - cy;
          const ml = Math.hypot(mx, my);
          if (ml > 1e-6) {
            const tipLen = hw / cosHalf;
            const tx = cx + (mx / ml) * tipLen;
            const ty = cy + (my / ml) * tipLen;
            push([o1x, o1y, tx, ty, o2x, o2y]);
          }
        }
      }
    }
    if (!closed && cap === 'round') {
      circle(p[0], p[1]);
      circle(p[(n - 1) * 2], p[(n - 1) * 2 + 1]);
    }
  }
  return out;
}

function compile(gl, type, src, what) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(
      `${what} shader failed to compile: ${gl.getShaderInfoLog(sh)}`,
    );
  }
  return sh;
}
