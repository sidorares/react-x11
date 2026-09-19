// `<glarea>` on Windows: a WGL core context, composited as a visual.
//
// docs/windows-gl.md is the report behind this, and the route is the X11
// model rather than ANGLE — a GL surface covers its rect and the tree draws
// under it, positioned from the parent's yoga rect. src/glnodes.js already
// expects exactly that, including the rule that the surface selects no
// pointer input so a press over it reaches the tree by propagation.
//
// Where it parts from X11 is how the surface reaches the screen. It is not a
// child window: a window presenting through DirectComposition is shown from
// its visual tree, and a child HWND's pixels go to a redirection bitmap that
// is then no part of what is composited. That was built and measured before
// it was believed — see the commit and the report. So the bridge gives each
// surface a composition swap chain under the window's own visual, and GL
// draws into a Direct3D texture the frame copies into it. Which means a
// `<glarea>` here *does* composite with the window's alpha, where on X11 it
// does not.

/**
 * The window object a `<glarea>` gets. It is *not* a Win32Window: it has no
 * 2d context and no frame clock of the window's — GL draws into its own
 * composition surface and presents it, which is the whole difference.
 */
export class Win32GlWindow {
  constructor(app, attributes = {}) {
    this.app = app;
    this._native = app._native;
    this.attributes = attributes;
    this.x = Math.round(attributes.x ?? 0);
    this.y = Math.round(attributes.y ?? 0);
    this.width = Math.max(1, Math.round(attributes.width ?? 1));
    this.height = Math.max(1, Math.round(attributes.height ?? 1));
    this.mapped = false;
    this.destroyed = false;
    this._handlers = {};
    this._gl = null;
    /** The surface exists on the UI thread; until it does there is nothing to
     * draw into, and a frame asked for meanwhile is refused rather than
     * dropped — `glnodes.js` re-requests it from `onFrameAvailable`. */
    this._ready = false;

    // The parent window's id, not its handle: the surface is composited as a
    // visual inside that window's tree rather than parented as a child HWND.
    const parentId = attributes.parent ? attributes.parent.id : 0;
    this.id = this._native.glCreateSurface(
      parentId,
      this.x,
      this.y,
      this.width,
      this.height,
    );
    app._glWindows.set(this.id, this);
    this.parent = attributes.parent ?? null;
  }

  /**
   * The bridge reports the surface. `ok` is false where this machine has no
   * vendor driver: opengl32.dll is then the 1.1 software rasterizer, with no
   * shaders and no framebuffer objects — which is not a degraded direct
   * backend but the indirect one's feature set without its portability, and
   * is docs/windows-gl.md's rung 2 rather than this one.
   */
  _onReady(ok, why = 0) {
    if (!ok) {
      // The bridge says which step refused, because "no GL surface" covers
      // four quite different machines and only one of them is the one this
      // error used to describe.
      const REASONS = {
        1: 'the surface window could not be created',
        2: 'no pixel format on this device supports OpenGL — a remote ' +
          'session or a display driver without an OpenGL ICD',
        3: 'a pixel format was set but no OpenGL context could be made on it',
        4: 'this machine has no vendor OpenGL driver, so only the 1.1 ' +
          'software rasterizer is available, which has no shaders',
      };
      this.emit(
        'error',
        new Error(
          `react-x11: no OpenGL surface — ${REASONS[why] ?? 'the bridge refused it'}. ` +
            'docs/windows-gl.md rung 2 (ANGLE) covers this case and is not built yet.',
        ),
      );
      return;
    }
    this._ready = true;
    // The frame this surface refused while it was being made.
    this._gl?.onFrameAvailable?.();
    this.emit('expose', {});
  }

  /**
   * The WebGL-shaped table, plus the two calls `glnodes.js` makes around a
   * frame. `SwapBuffers` keeps its PascalCase because that is the one name
   * the element spells the same way on both backends.
   */
  getContext(kind) {
    if (kind !== 'opengl') return null;
    if (this._gl) return this._gl;
    const gl = this._native.glTable();
    // What `glnodes.js` branches on to choose the camelCase spelling over the
    // indirect backend's PascalCase one — `gl.backend === 'direct'`. This is a
    // real direct context (shaders, framebuffer objects, vertex buffers), and
    // saying otherwise sends every call to a name this table does not have.
    gl.backend = 'direct';
    gl.makeCurrent = () => this._native.glMakeCurrent(this.id);
    gl.SwapBuffers = () => this._native.glSwapBuffers(this.id);
    // A WGL swap does not hold a frame back the way a DRI3 Present or a CGL
    // flush does, so the only reason to refuse one is that the surface does
    // not exist yet. `onFrameAvailable` is the channel glnodes.js installs to
    // be told when it does — declared here so it finds the property.
    gl.canRender = () => this._ready;
    gl.onFrameAvailable = null;
    Object.assign(gl, CONSTANTS);
    this._gl = GL_DEBUG ? instrument(gl) : gl;
    return this._gl;
  }


  /**
   * The frame clock, which is the parent window's — the same delegation the
   * Cocoa surface makes (src/cocoa/glarea.js). A `<glarea>` has no clock of
   * its own here: it is a visual inside its parent's composition tree, so
   * the parent's tick is the one its frames belong to. Without this
   * `glnodes.js` falls back to `setImmediate`, which is not a frame clock at
   * all — it is "as fast as the event loop will go", which paces a still
   * scene against nothing.
   */
  requestAnimationFrame(cb) {
    return this.parent?.requestAnimationFrame?.(cb) ?? setImmediate(cb);
  }
  resize(width, height) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this._native.glResizeSurface(
      this.id,
      this.x,
      this.y,
      this.width,
      this.height,
    );
  }

  move(x, y) {
    this.x = Math.round(x);
    this.y = Math.round(y);
    this._native.glResizeSurface(
      this.id,
      this.x,
      this.y,
      this.width,
      this.height,
    );
  }

  map() {
    this.mapped = true;
  }

  unmap() {
    this.mapped = false;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.app._glWindows.delete(this.id);
    this._native.glDestroySurface(this.id);
  }

  on(name, fn) {
    (this._handlers[name] ??= []).push(fn);
  }

  emit(name, ev) {
    for (const fn of this._handlers[name] ?? []) fn(ev);
  }

  // A GL surface has no 2d context and no backing store; these exist so the
  // node layer's feature tests answer no rather than throwing.
  getContext2D() {
    return null;
  }
  setCursor() {}
  raise() {}
}

/**
 * `REACT_X11_GL_DEBUG=1` — every call checked against glGetError, and every
 * name the caller reaches for that this table does not have.
 *
 * A missing verb is the failure this exists for: the table is written by hand
 * against the WebGL names, and a renderer that asks for one that is not here
 * gets `undefined is not a function` somewhere deep inside its own frame,
 * where an example's error handling may swallow it. Asking the object what it
 * was asked for turns that into a list.
 */
const GL_DEBUG = process.env.REACT_X11_GL_DEBUG === '1';

function instrument(gl) {
  // REACT_X11_GL_FORCE_CLEAR=1 paints the GL surface a colour nothing else in
  // the window uses. It answers the one question a screenshot of a map cannot:
  // whether what is on screen is the GL child or the 2D layer behind it, which
  // in this app are both the style's background colour.
  if (process.env.REACT_X11_GL_FORCE_CLEAR === '1') {
    const realClearColor = gl.clearColor;
    gl.clearColor = () => realClearColor(1, 0, 1, 1);
  }

  const counts = new Map();
  const missing = new Set();
  let swaps = 0;
  // Frame timing, split at the only place it can be split from here: the work
  // between making the context current and presenting is the GL frame; the
  // rest of the interval is everything else — the tile and label work, the
  // React render, the 2D layer, and whatever the pacer decides to wait.
  let frameStart = 0;
  let drawTotal = 0;
  let gapTotal = 0;
  let lastSwap = 0;
  let presentTotal = 0;
  let errors = 0;
  const raw = gl.getError;
  const rawRead = gl.readPixels;
  const raw_getShaderInfoLog = gl.getShaderInfoLog;
  const raw_getProgramInfoLog = gl.getProgramInfoLog;
  // REACT_X11_GL_PEEK=<n> reads the stencil and the colour at the middle of
  // the surface after each draw. A fill pass that lays down no winding and a
  // cover pass that paints nothing look identical from outside; the stencil
  // buffer is the only place that tells them apart.
  const peek = Number(process.env.REACT_X11_GL_PEEK ?? 0);
  let peeked = 0;

  const describe = (v) =>
    ArrayBuffer.isView(v)
      ? `${v.constructor.name}(${v.length})`
      : typeof v === 'string'
        ? JSON.stringify(v.length > 30 ? `${v.slice(0, 30)}…` : v)
        : String(v);

  // REACT_X11_GL_TRACE=<n> also prints the first n calls in order, with their
  // arguments: the only way to see a frame that draws everything correctly
  // into a place nothing is looking at.
  const trace = Number(process.env.REACT_X11_GL_TRACE ?? 0);
  // Startup frames draw nothing — the tiles are still arriving — so the
  // interesting frame is never the first one.
  const traceAfter = Number(process.env.REACT_X11_GL_TRACE_AFTER ?? 0);
  let traced = 0;

  for (const name of Object.keys(gl)) {
    const fn = gl[name];
    if (typeof fn !== 'function' || name === 'getError') continue;
    gl[name] = (...args) => {
      if (name === 'makeCurrent') frameStart = performance.now();
      const out = fn(...args);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (traced < trace && swaps >= traceAfter) {
        traced += 1;
        process.stderr.write(
          `[gl] ${String(traced).padStart(3)} ${name}(${args.map(describe).join(', ')})` +
            `${out === undefined ? '' : ` = ${describe(out)}`}
`,
        );
      }
      // readPixels answers in an out-parameter, so the trace has to look at it
      // after the call or the most interesting result in the API is invisible.
      if (
        trace > 0 &&
        (name === 'bufferData' || name === 'bufferSubData') &&
        traced <= trace
      ) {
        const buf = args.find((a) => ArrayBuffer.isView(a));
        process.stderr.write(
          `[gl]     upload: ${buf ? `${buf.constructor.name} ${buf.byteLength}B` : 'no view argument'}
`,
        );
      }
      if (name === 'readPixels' && trace > 0 && ArrayBuffer.isView(args[6])) {
        process.stderr.write(`[gl]     read back: [${[...args[6].slice(0, 16)].join(', ')}]
`);
      }
      if (peek > 0 && peeked < peek && name.startsWith('draw')) {
        peeked += 1;
        // A whole scanline rather than one pixel: geometry that misses the
        // point sampled and geometry that was never rasterised look alike.
        const st = new Uint8Array(1600);
        rawRead(100, 600, 1600, 1, 0x1901 /* STENCIL_INDEX */, 0x1401, st);
        const rgba = new Uint8Array(1600 * 4);
        rawRead(100, 600, 1600, 1, 0x1908, 0x1401, rgba);
        let set = 0;
        let peak = 0;
        for (const v of st) {
          if (v !== 0) set += 1;
          if (v > peak) peak = v;
        }
        const colours = new Set();
        for (let i = 0; i < rgba.length; i += 4) {
          colours.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`);
        }
        process.stderr.write(
          `[gl]     after ${name}: stencil set on ${set}/1600 (max ${peak}), ` +
            `${colours.size} colours ${[...colours].slice(0, 3).join(' | ')}\n`,
        );
      }
      // A shader that will not compile, or a program that will not link, is
      // not a GL *error* — glGetError stays clean and the caller is expected
      // to ask. An app that asks and then throws its own message leaves
      // nothing behind, so the log is printed here where it still exists.
      if (
        (name === 'getShaderParameter' || name === 'getProgramParameter') &&
        out === false
      ) {
        const log =
          name === 'getShaderParameter'
            ? raw_getShaderInfoLog(args[0])
            : raw_getProgramInfoLog(args[0]);
        process.stderr.write(`[gl] ${name} false — ${log || '(no log)'}\n`);
      }
      const err = raw();
      if (err !== 0 && errors < 40) {
        errors += 1;
        process.stderr.write(
          `[gl] ${name}(${args.map(describe).join(', ')}) -> 0x${err.toString(16)}\n`,
        );
      }
      return out;
    };
  }

  const swap = gl.SwapBuffers;
  gl.SwapBuffers = (...args) => {
    swaps += 1;
    const now = performance.now();
    if (frameStart) drawTotal += now - frameStart;
    if (lastSwap) gapTotal += now - lastSwap;
    lastSwap = now;
    if (swaps % 30 === 0) {
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Number(process.env.REACT_X11_GL_TOP ?? 12))
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      process.stderr.write(
        `[gl] after ${swaps} swaps: GL frame ${(drawTotal / 30).toFixed(1)} ms, ` +
          `present ${(presentTotal / 30).toFixed(1)} ms, interval ${(gapTotal / 30).toFixed(1)} ms — ${top}
`,
      );
      drawTotal = 0;
      gapTotal = 0;
      presentTotal = 0;
      if (missing.size > 0) {
        process.stderr.write(`[gl] NOT IN TABLE: ${[...missing].join(', ')}\n`);
      }
    }
    const before = performance.now();
    const result = swap(...args);
    presentTotal += performance.now() - before;
    return result;
  };

  return new Proxy(gl, {
    get(target, prop) {
      if (
        typeof prop === 'string' &&
        !(prop in target) &&
        // a constant would be SHOUTED; anything else read off this object is
        // being read to be called
        prop !== 'then' &&
        !missing.has(prop)
      ) {
        missing.add(prop);
        process.stderr.write(`[gl] NOT IN TABLE: ${prop}\n`);
      }
      return target[prop];
    },
  });
}

/**
 * The GL enumerants, as numbers. They are constants of the API rather than of
 * a context, so they live here rather than being asked of the driver — which
 * is also what every WebGL implementation does.
 */

/**
 * The texture units, as a range rather than one entry.
 *
 * `TEXTURE0` alone was here, and a scene that binds a second texture —
 * anything with a base map and an overlay, which is most of them — asked for
 * `gl.TEXTURE1`, got `undefined`, and passed it to `activeTexture` as an
 * invalid enum. The bind then landed on unit 0 and the sampler read black.
 *
 * GL guarantees the units are consecutive from TEXTURE0, so this is the
 * definition rather than a table of 32 lines.
 */
const TEXTURE_UNITS = Object.fromEntries(
  Array.from({ length: 32 }, (_, i) => [`TEXTURE${i}`, 0x84c0 + i]),
);
const CONSTANTS = Object.freeze({
  DEPTH_BUFFER_BIT: 0x0100,
  STENCIL_BUFFER_BIT: 0x0400,
  COLOR_BUFFER_BIT: 0x4000,
  POINTS: 0,
  LINES: 1,
  LINE_LOOP: 2,
  LINE_STRIP: 3,
  TRIANGLES: 4,
  TRIANGLE_STRIP: 5,
  TRIANGLE_FAN: 6,
  ZERO: 0,
  ONE: 1,
  SRC_COLOR: 0x0300,
  ONE_MINUS_SRC_COLOR: 0x0301,
  SRC_ALPHA: 0x0302,
  ONE_MINUS_SRC_ALPHA: 0x0303,
  DST_ALPHA: 0x0304,
  ONE_MINUS_DST_ALPHA: 0x0305,
  DST_COLOR: 0x0306,
  ONE_MINUS_DST_COLOR: 0x0307,
  FRONT: 0x0404,
  BACK: 0x0405,
  FRONT_AND_BACK: 0x0408,
  CULL_FACE: 0x0b44,
  DEPTH_TEST: 0x0b71,
  STENCIL_TEST: 0x0b90,
  BLEND: 0x0be2,
  SCISSOR_TEST: 0x0c11,
  TEXTURE_2D: 0x0de1,
  NEVER: 0x0200,
  LESS: 0x0201,
  EQUAL: 0x0202,
  LEQUAL: 0x0203,
  GREATER: 0x0204,
  NOTEQUAL: 0x0205,
  GEQUAL: 0x0206,
  ALWAYS: 0x0207,
  KEEP: 0x1e00,
  REPLACE: 0x1e01,
  INCR: 0x1e02,
  DECR: 0x1e03,
  INVERT: 0x150a,
  INCR_WRAP: 0x8507,
  DECR_WRAP: 0x8508,
  BYTE: 0x1400,
  UNSIGNED_BYTE: 0x1401,
  SHORT: 0x1402,
  UNSIGNED_SHORT: 0x1403,
  INT: 0x1404,
  UNSIGNED_INT: 0x1405,
  UNPACK_ALIGNMENT: 0x0cf5,
  FLOAT: 0x1406,
  RGB: 0x1907,
  RGBA: 0x1908,
  LUMINANCE: 0x1909,
  LUMINANCE_ALPHA: 0x190a,
  NEAREST: 0x2600,
  LINEAR: 0x2601,
  NEAREST_MIPMAP_NEAREST: 0x2700,
  LINEAR_MIPMAP_NEAREST: 0x2701,
  NEAREST_MIPMAP_LINEAR: 0x2702,
  LINEAR_MIPMAP_LINEAR: 0x2703,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  REPEAT: 0x2901,
  CLAMP_TO_EDGE: 0x812f,
  MIRRORED_REPEAT: 0x8370,
  ...TEXTURE_UNITS,
  ARRAY_BUFFER: 0x8892,
  ELEMENT_ARRAY_BUFFER: 0x8893,
  STREAM_DRAW: 0x88e0,
  STATIC_DRAW: 0x88e4,
  DYNAMIC_DRAW: 0x88e8,
  FRAGMENT_SHADER: 0x8b30,
  VERTEX_SHADER: 0x8b31,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  VALIDATE_STATUS: 0x8b83,
  INFO_LOG_LENGTH: 0x8b84,
  DELETE_STATUS: 0x8b80,
  FRAMEBUFFER: 0x8d40,
  RENDERBUFFER: 0x8d41,
  RGBA4: 0x8056,
  DEPTH_COMPONENT16: 0x81a5,
  DEPTH24_STENCIL8: 0x88f0,
  STENCIL_INDEX8: 0x8d48,
  COLOR_ATTACHMENT0: 0x8ce0,
  DEPTH_ATTACHMENT: 0x8d00,
  STENCIL_ATTACHMENT: 0x8d20,
  DEPTH_STENCIL_ATTACHMENT: 0x821a,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  FRAMEBUFFER_BINDING: 0x8ca6,
  RENDERBUFFER_BINDING: 0x8ca7,
  VERTEX_ARRAY_BINDING: 0x85b5,
  ARRAY_BUFFER_BINDING: 0x8894,
  CURRENT_PROGRAM: 0x8b8d,
  MAX_TEXTURE_SIZE: 0x0d33,
  VIEWPORT: 0x0ba2,
  NO_ERROR: 0,
});

/**
 * `app.chooseGLConfig` — the seam `glxConfig()` asks, and whose presence is
 * what makes `hasDirectGL()` true for this app.
 *
 * There is no visual to choose on Windows: a pixel format is picked against
 * the child window's own DC when the surface is made, because a format can be
 * set on a DC only once and the DC does not exist until the window does. So
 * this answers the shape the caller expects and defers the real choice.
 */
export function installGl(app) {
  const probe = app._native.glProbe?.();
  // A core context is the line. Below it there is no vendor driver, and the
  // software rasterizer's GL 1.1 is not a degraded direct backend.
  if (!probe || !probe.core) return false;

  app.glPolicy = { mode: 'direct' };
  app._glCapsResolved = { direct: true, indirect: false, probe };
  app.chooseGLConfig = () =>
    Promise.resolve({ backend: 'direct', visual: 0, depth: 32 });
  app.glCapabilities = () => ({ direct: true, indirect: false });
  return true;
}
