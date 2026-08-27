// The product shot, as an actual object: a `<glarea>` with the laptop in it,
// turning and opening as the configuration panel beside it scrolls.
//
// ## Why this file is shaped the way it is
//
// **The two GL backends are different APIs, not two spellings of one**
// (docs/gl.md). Direct is OpenGL ES 2 with GLSL; indirect encodes GL 1.x
// commands into the X connection and has no shaders at all. This scene is
// written for direct — `glPolicy: 'auto'` in index.jsx, which takes direct
// where it exists — and where that is not what the connection got, the page
// falls back to the flat `<box>` laptop it always had. That is a real
// ladder rather than a courtesy: most modern desktops refuse indirect GLX,
// and the machines that do are exactly the ones where direct works.
//
// **The surface stacks above the 2D tree.** A `<glarea>` owns a real X
// window, so nothing painted by the parent can overlap it — which is why the
// stage is its own band of the hero with the spec chips *below* it rather
// than a caption floating over the render.
//
// **Scroll scrubs it, and nothing runs when it doesn't.** `frameLoop` is
// `'demand'`, and `applyProps` asks for a frame on any prop change — so a
// fresh `onDraw` closure per scroll position is exactly one redraw per
// scroll event, with no clock left running when the reader stops. An
// `'always'` loop would have been a GPU burning quietly behind a store page.
//
// **The pose is a pure function**, which is the only part a headless test can
// see: GL renders where `GetImage` cannot read it (docs/glx.md), so there is
// no pixel to assert on and `npm run screenshots` skips this element.
//
// **The screen shows the page.** What the laptop is displaying is the
// configuration panel beside it, read back off the window with
// `getImageData` and uploaded as a texture whenever a choice changes — the
// app running on itself. That works in one direction only, and the asymmetry
// is the whole reason it is safe: the panel is ordinary 2D content in the
// window's backing pixmap and can simply be read, while the GL surface's
// pixels never live in an X drawable at all, so the screen can never contain
// the screen. The rect captured is the pane's, and the render is not in it.
//
// **Anti-aliasing is ours to do.** `chooseGLConfig` reads `DEPTH_SIZE` and
// `ALPHA_SIZE` out of the GLX spec on the direct backend and nothing else, so
// `SAMPLES` is honoured on indirect and ignored on the backend this runs on
// (sidorares/ntk#341). What direct does have is framebuffer objects, so the
// scene is drawn into one at twice the panel's size and resolved down — full
// scene AA, decided by the app rather than by the visual.
//
// ## What does not work
//
// No picking: `<glarea>` still does not hit-test for the *pointer*
// (docs/elements.md), so the laptop cannot be dragged to orbit it. The wheel
// does arrive — the surface selects it and hands it to the window's manager
// — and this page spends it on the configuration beside the render, which is
// what a reader turning the wheel over the laptop is looking at. Reduced motion is not honoured here
// either: `animation` loops are core's to stop, and this is an app drawing
// its own frames, so a scrubbed scene keeps scrubbing.
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { compose, lookAt, multiply, perspective } from '../../src/mat4.js';

// ---------------------------------------------------------------------------
// The pose — pure, and the half of this file that can be tested
// ---------------------------------------------------------------------------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Fast at first, settling at the end — a lid falling open, not a servo. */
const easeOut = (t) => 1 - (1 - t) ** 3;

/** Closed is a hair off flat, so the seam still reads as a seam. */
const LID_SHUT = 0.04;
const LID_OPEN = 1.95; // ~112°, where a laptop actually sits

/**
 * Where the laptop is at a given scroll position, `0` at the top of the
 * configuration and `1` at the bottom.
 *
 * The lid opens over the first half and the body keeps turning the whole way,
 * so the top of the page is a closed machine seen from its corner and the
 * bottom is an open one facing the reader — and every position in between
 * belongs to a scroll offset rather than to a clock.
 */
export function laptopPose(progress) {
  const p = clamp01(progress);
  const open = easeOut(clamp01(p / 0.55));
  return {
    lid: LID_SHUT + open * (LID_OPEN - LID_SHUT),
    turn: -0.44 + p * 0.86,
    tilt: 0.16 - open * 0.05,
    lift: open * 0.06,
    // The camera frames what is there rather than what will be: a shut
    // laptop is a low slab and an open one is half lid, so both the point it
    // looks at and how much room it leaves above have to travel with the
    // hinge — otherwise the closed state sits in the bottom of an empty panel.
    focus: 0.05 + open * 0.52,
    reachV: 0.6 + open * 0.86,
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * One axis-aligned box with its edges cut off — a chamfer, not a fillet.
 *
 * The cut is what makes an edge read as rounded: it catches the key light at
 * a different angle from either face it joins, so the object gets the thin
 * highlight along its edges that a machined aluminium case has and a sharp
 * box cannot. A true fillet would need a ring of segments per edge and a
 * seam-free sphere at each corner; at this size the difference is a pixel of
 * gradient, and one flat cut costs 11 triangles per box instead of hundreds.
 *
 * Sized here rather than scaled by the model matrix on purpose: a non-uniform
 * scale needs the inverse transpose to carry normals, and every transform
 * below stays rigid this way, so `mat3(uModel)` is the whole normal matrix.
 *
 * Nothing is culled, so winding does not matter — the normals are given
 * explicitly and the depth buffer decides what is seen.
 */
function chamferBox(out, center, size, chamfer = 0.02) {
  const h = [size[0] / 2, size[1] / 2, size[2] / 2];
  // a chamfer can never eat more than the part is thick
  const r = Math.min(chamfer, Math.min(h[0], h[1], h[2]) * 0.85);
  const a = [h[0] - r, h[1] - r, h[2] - r];
  const start = out.length / 6;

  const push = (p, n) =>
    out.push(
      p[0] + center[0],
      p[1] + center[1],
      p[2] + center[2],
      n[0],
      n[1],
      n[2],
    );
  const quad = (p1, p2, p3, p4, n) => {
    push(p1, n);
    push(p2, n);
    push(p3, n);
    push(p1, n);
    push(p3, n);
    push(p4, n);
  };
  /** a point named by its three axis components, in axis-index order */
  const at = (i, vi, j, vj, k, vk) => {
    const p = [0, 0, 0];
    p[i] = vi;
    p[j] = vj;
    p[k] = vk;
    return p;
  };
  const unit = (v) => {
    const L = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / L, v[1] / L, v[2] / L];
  };

  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const k = (i + 2) % 3;
    // the six faces, inset by the chamfer on both of their other axes
    for (const s of [1, -1]) {
      const n = [0, 0, 0];
      n[i] = s;
      quad(
        at(i, s * h[i], j, -a[j], k, -a[k]),
        at(i, s * h[i], j, a[j], k, -a[k]),
        at(i, s * h[i], j, a[j], k, a[k]),
        at(i, s * h[i], j, -a[j], k, a[k]),
        n,
      );
    }
    // the twelve cuts, each joining two faces along the remaining axis
    for (const si of [1, -1]) {
      for (const sj of [1, -1]) {
        const n = [0, 0, 0];
        n[i] = si;
        n[j] = sj;
        quad(
          at(i, si * h[i], j, sj * a[j], k, -a[k]),
          at(i, si * a[i], j, sj * h[j], k, -a[k]),
          at(i, si * a[i], j, sj * h[j], k, a[k]),
          at(i, si * h[i], j, sj * a[j], k, a[k]),
          unit(n),
        );
      }
    }
  }
  // and the eight corners the cuts leave behind
  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      for (const sz of [1, -1]) {
        const n = unit([sx, sy, sz]);
        push([sx * h[0], sy * a[1], sz * a[2]], n);
        push([sx * a[0], sy * h[1], sz * a[2]], n);
        push([sx * a[0], sy * a[1], sz * h[2]], n);
      }
    }
  }
  return { first: start, count: out.length / 6 - start };
}

const FOV_Y = 32;
const REACH_H = 1.68;

const BASE_W = 3.1;
const BASE_D = 2.1;
const BASE_H = 0.13;
const LID_H = 0.07;

/**
 * The screen's aspect ratio, which the page reads before capturing itself.
 *
 * The panel is cropped to fill the screen ("cover"), so anything captured
 * outside this shape is read off the window, pushed across the wire and then
 * discarded by the fragment shader. Handing the capture this number lets it
 * read the band that will actually be seen.
 */
export const SCREEN_ASPECT = (BASE_W - 0.2) / (BASE_D - 0.06 - 0.18);

/** The parts, in two groups: what stays put and what swings on the hinge. */
function buildGeometry() {
  const data = [];
  // the body, in the base's own space — the hinge is at z = -BASE_D / 2
  const base = chamferBox(data, [0, 0, 0], [BASE_W, BASE_H, BASE_D], 0.03);
  const keys = chamferBox(
    data,
    [0, BASE_H / 2, -0.24],
    [BASE_W - 0.42, 0.012, BASE_D - 1.0],
    0.006,
  );
  const pad = chamferBox(
    data,
    [0, BASE_H / 2, 0.62],
    [1.16, 0.01, BASE_D - 1.45],
    0.006,
  );
  // the lid, in the hinge's space: it extends *away* from the pivot, so the
  // whole part sits at +y and rotates around the origin
  const lidH = BASE_D - 0.06;
  const lid = chamferBox(
    data,
    [0, lidH / 2, -LID_H / 2],
    [BASE_W, lidH, LID_H],
    0.024,
  );
  const screen = chamferBox(
    data,
    [0, lidH / 2, 0.001],
    [BASE_W - 0.2, lidH - 0.18, LID_H],
    0.008,
  );
  return {
    data: new Float32Array(data),
    parts: { base, keys, pad, lid, screen },
    lidH,
  };
}

// ---------------------------------------------------------------------------
// Shaders — GLSL ES 1.00, the direct backend's language
// ---------------------------------------------------------------------------

const VERTEX_SRC = `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uMvp;
uniform mat4 uModel;
varying vec3 vNormal;
varying vec3 vLocal;
void main() {
  vNormal = normalize(mat3(uModel) * aNormal);
  vLocal = aPos;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

// Two lights and a floor bounce rather than one lamp: a single directional
// light leaves the side facing away from it flat black, which reads as a hole
// in a page this bright.
const FRAGMENT_SRC = `
precision mediump float;
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uGrad;
uniform float uGradMin;
uniform float uGradSpan;
uniform float uGlow;
// the screen: what the configuration panel looked like when it was last
// read back, fitted into the panel without stretching it
uniform sampler2D uTex;
uniform float uScreen;
uniform vec4 uScreenBox;
uniform vec2 uFit;
varying vec3 vNormal;
varying vec3 vLocal;
void main() {
  if (uScreen > 0.5) {
    vec2 uv = (vLocal.xy - uScreenBox.xy) / uScreenBox.zw;
    // Cover, not contain: an app on a laptop fills its screen. The panel is
    // portrait and the screen is landscape, so this crops the panel rather
    // than shrinking it into a letterbox nobody could read — the alternative
    // put the whole page on screen at a size where the type was mush.
    uv = (uv - 0.5) / uFit + 0.5;
    // an X image reads top row first; a texture's v counts up from the bottom
    uv.y = 1.0 - uv.y;
    gl_FragColor = vec4(texture2D(uTex, uv).rgb, 1.0);
    return;
  }
  vec3 n = normalize(vNormal);
  float key = max(dot(n, normalize(vec3(-0.35, 0.85, 0.55))), 0.0);
  float fill = max(dot(n, normalize(vec3(0.7, 0.25, 0.4))), 0.0);
  float bounce = max(-n.y, 0.0);
  vec3 base = mix(uColor, uColor2, uGrad * clamp((vLocal.y - uGradMin) / uGradSpan, 0.0, 1.0));
  vec3 lit = base * (0.52 + 0.46 * key + 0.16 * fill + 0.08 * bounce);
  gl_FragColor = vec4(mix(lit, base, uGlow), 1.0);
}`;

/**
 * Full-scene anti-aliasing, by supersampling.
 *
 * The direct backend's config carries no sample buffers — `chooseGLConfig`
 * reads `DEPTH_SIZE` and `ALPHA_SIZE` out of the GLX spec and nothing else,
 * so `SAMPLES` is honoured on indirect and silently ignored on the backend
 * this scene actually runs on (sidorares/ntk#341). What direct *does* have is
 * framebuffer objects, so the scene renders into one at twice the panel's
 * size and is resolved down through a linear-filtered quad: 4 samples a
 * pixel, decided here rather than by the visual.
 *
 * Two, and not because of the memory: the resolve is one bilinear tap, which
 * averages a 2x2 neighbourhood, so 2 is the largest factor it can actually
 * resolve. Measured on the silhouette — mean edge ramp 1.06px with no
 * supersampling, 1.40px at 2x, and back to 1.06px at 3x and 1.24px at 4x,
 * where the filter starts missing texels. Going wider needs a multi-tap
 * filter or a mip chain in the resolve, which is a lot of machinery for an
 * edge already a pixel and a half soft.
 */
const SUPERSAMPLE = 2;

const BLIT_VERTEX_SRC = `
attribute vec2 aQuad;
varying vec2 vUv;
void main() {
  vUv = aQuad * 0.5 + 0.5;
  gl_Position = vec4(aQuad, 0.0, 1.0);
}`;

const BLIT_FRAGMENT_SRC = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(uTex, vUv); }`;

const rgb = (hex) => {
  const v = hex.replace('#', '');
  const n = parseInt(
    v.length === 3
      ? v
          .split('')
          .map((c) => c + c)
          .join('')
      : v,
    16,
  );
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

function compile(gl, type, src, what) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`${what}: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

/**
 * The offscreen the scene is drawn into, at `SUPERSAMPLE` times the panel.
 *
 * Rebuilt when the panel changes size and never per frame — an FBO plus its
 * texture is a GPU allocation, and a resize is the only thing that can
 * invalidate one. Returns null if the driver will not complete the
 * framebuffer, and the caller then draws straight to the window: aliased,
 * which is a great deal better than blank.
 */
function ensureTarget(gl, s, width, height) {
  const w = Math.max(1, Math.round(width * SUPERSAMPLE));
  const h = Math.max(1, Math.round(height * SUPERSAMPLE));
  if (s.target && s.target.w === w && s.target.h === h) return s.target;
  if (s.target) {
    gl.deleteFramebuffer(s.target.fbo);
    gl.deleteTexture(s.target.tex);
    gl.deleteRenderbuffer(s.target.depth);
    s.target = null;
  }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    w,
    h,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  );
  // LINEAR is the resolve: the downscale averages the extra samples
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const depth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    tex,
    0,
  );
  gl.framebufferRenderbuffer(
    gl.FRAMEBUFFER,
    gl.DEPTH_ATTACHMENT,
    gl.RENDERBUFFER,
    depth,
  );
  const ok =
    gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) {
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    gl.deleteRenderbuffer(depth);
    return null;
  }
  s.target = { fbo, tex, depth, w, h };
  return s.target;
}

// ---------------------------------------------------------------------------
// The element
// ---------------------------------------------------------------------------

/**
 * `bind` is a ref the page hands over so its scroll handler can push a
 * position straight into this component's state. The alternative — lifting
 * the position to the page — re-renders the whole configuration on every
 * scroll event to move a laptop, which is the one thing a scroll must not do.
 */
export function LaptopGL({
  finish,
  bind,
  clearColor,
  onUnavailable,
  onWheel,
  style,
}) {
  const [progress, setProgress] = useState(0);
  // The page's own configuration panel, read back off the window and shown on
  // the laptop's screen. State rather than a ref because a new capture has to
  // reach `onDraw`, and `onDraw`'s identity is what asks for the frame.
  const [page, setPage] = useState(null);
  const scene = useRef(null);
  // the same paper the page is on: the offscreen has to be cleared to it, or
  // the resolve blends the laptop's edges into black
  const clear = rgb(clearColor ?? '#ffffff');

  useEffect(() => {
    if (!bind) return undefined;
    bind.current.set = setProgress;
    bind.current.setPage = setPage;
    return () => {
      bind.current.set = null;
      bind.current.setPage = null;
    };
  }, [bind]);

  const onCreated = useCallback(
    (gl) => {
      // The scene is ES 2; on indirect there is no shader object to make.
      if (gl.backend !== 'direct') {
        onUnavailable?.(
          'this connection got the indirect GL backend, which has no shaders',
        );
        return;
      }
      try {
        const program = gl.createProgram();
        gl.attachShader(
          program,
          compile(gl, gl.VERTEX_SHADER, VERTEX_SRC, 'vertex shader'),
        );
        gl.attachShader(
          program,
          compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC, 'fragment shader'),
        );
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          throw new Error(`link: ${gl.getProgramInfoLog(program)}`);
        }
        const geo = buildGeometry();
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, geo.data, gl.STATIC_DRAW);
        gl.enable(gl.DEPTH_TEST);

        // the resolve pass: one triangle pair, sampling the supersampled
        // colour attachment with the hardware's linear filter
        const blit = gl.createProgram();
        gl.attachShader(
          blit,
          compile(gl, gl.VERTEX_SHADER, BLIT_VERTEX_SRC, 'blit vertex shader'),
        );
        gl.attachShader(
          blit,
          compile(
            gl,
            gl.FRAGMENT_SHADER,
            BLIT_FRAGMENT_SRC,
            'blit fragment shader',
          ),
        );
        gl.linkProgram(blit);
        if (!gl.getProgramParameter(blit, gl.LINK_STATUS)) {
          throw new Error(`link (blit): ${gl.getProgramInfoLog(blit)}`);
        }
        const quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          new Float32Array([-1, -1, 3, -1, -1, 3]),
          gl.STATIC_DRAW,
        );

        scene.current = {
          program,
          buffer,
          geo,
          blit,
          quad,
          aQuad: gl.getAttribLocation(blit, 'aQuad'),
          uTex: gl.getUniformLocation(blit, 'uTex'),
          target: null,
          aPos: gl.getAttribLocation(program, 'aPos'),
          aNormal: gl.getAttribLocation(program, 'aNormal'),
          uMvp: gl.getUniformLocation(program, 'uMvp'),
          uModel: gl.getUniformLocation(program, 'uModel'),
          uColor: gl.getUniformLocation(program, 'uColor'),
          uColor2: gl.getUniformLocation(program, 'uColor2'),
          uGrad: gl.getUniformLocation(program, 'uGrad'),
          uGradMin: gl.getUniformLocation(program, 'uGradMin'),
          uGradSpan: gl.getUniformLocation(program, 'uGradSpan'),
          uGlow: gl.getUniformLocation(program, 'uGlow'),
          uPageTex: gl.getUniformLocation(program, 'uTex'),
          uScreen: gl.getUniformLocation(program, 'uScreen'),
          uScreenBox: gl.getUniformLocation(program, 'uScreenBox'),
          uFit: gl.getUniformLocation(program, 'uFit'),
          // the page's own pixels, uploaded when a new capture arrives
          pageTex: gl.createTexture(),
          pageSeq: -1,
          pageAspect: 1,
        };
      } catch (err) {
        onUnavailable?.(String(err?.message ?? err));
      }
    },
    [onUnavailable],
  );

  const onDraw = useCallback(
    (gl, { width, height }) => {
      const s = scene.current;
      if (!s) return;
      const pose = laptopPose(progress);
      // Pass one goes into the supersampled offscreen where there is one;
      // the element already cleared the window, but the offscreen is ours.
      const target = ensureTarget(gl, s, width, height);
      const sw = target ? target.w : width;
      const sh = target ? target.h : height;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(0, 0, sw, sh);
      if (target) {
        gl.clearColor(clear[0], clear[1], clear[2], 1);
        gl.enable(gl.DEPTH_TEST);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      }
      // Fit the object to the panel rather than trusting a fixed distance:
      // the stage is one shape at 1220px and another when the layout stacks,
      // and a camera that ignores that crops the laptop on the narrow one.
      const aspect = Math.max(sw, 1) / Math.max(sh, 1);
      const halfV = Math.tan((FOV_Y * Math.PI) / 360);
      const dist =
        Math.max(pose.reachV / halfV, REACH_H / (halfV * aspect)) + BASE_D / 2;
      const view = lookAt(
        [0, pose.focus + dist * 0.26, dist],
        [0, pose.focus, 0],
        [0, 1, 0],
      );
      const proj = perspective(FOV_Y, aspect, 0.1, 200);
      const viewProj = multiply(proj, view);

      // the body: turned and tilted, lifted a little as it opens
      const body = compose(
        [0, pose.lift, 0],
        [pose.tilt, pose.turn, 0],
        [1, 1, 1],
      );
      // the hinge sits at the back edge, on top of the base
      const hinge = multiply(
        body,
        // The lid is modelled extending +Y from the pivot, so rotation 0
        // stands it upright: *shut* is a quarter turn forward onto the base,
        // and the pose's opening angle counts back from there.
        compose(
          [0, BASE_H / 2, -BASE_D / 2],
          [Math.PI / 2 - pose.lid, 0, 0],
          [1, 1, 1],
        ),
      );

      gl.useProgram(s.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.buffer);
      gl.enableVertexAttribArray(s.aPos);
      gl.vertexAttribPointer(s.aPos, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(s.aNormal);
      gl.vertexAttribPointer(s.aNormal, 3, gl.FLOAT, false, 24, 12);

      const body3 = rgb(finish.body);
      const edge3 = rgb(finish.edge);
      const well3 = rgb(finish.well);
      const top3 = rgb(finish.screen[0]);
      const bottom3 = rgb(finish.screen[1]);

      const part = (model, { first, count }, color, opts = {}) => {
        gl.uniformMatrix4fv(s.uMvp, false, multiply(viewProj, model));
        gl.uniformMatrix4fv(s.uModel, false, model);
        gl.uniform3f(s.uColor, color[0], color[1], color[2]);
        const c2 = opts.color2 ?? color;
        gl.uniform3f(s.uColor2, c2[0], c2[1], c2[2]);
        gl.uniform1f(s.uGrad, opts.grad ? 1 : 0);
        gl.uniform1f(s.uGradMin, opts.gradMin ?? 0);
        gl.uniform1f(s.uGradSpan, opts.gradSpan ?? 1);
        gl.uniform1f(s.uGlow, opts.glow ?? 0);
        gl.uniform1f(s.uScreen, opts.screen ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, first, count);
      };

      // A capture is uploaded once, on the frame after it arrives: the
      // texture is the same object across frames, so a scroll that changes
      // nothing about the page re-binds rather than re-uploads.
      if (page && page.seq !== s.pageSeq) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, s.pageTex);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          page.width,
          page.height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          page.data,
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        s.pageSeq = page.seq;
        s.pageAspect = page.width / page.height;
      }

      const p = s.geo.parts;
      part(body, p.base, body3);
      part(body, p.keys, well3);
      part(body, p.pad, edge3);
      part(hinge, p.lid, body3);
      // the screen is lit by itself rather than by the room, which is what
      // makes it read as a screen and not as a painted panel
      if (page) {
        const boxW = BASE_W - 0.2;
        const boxH = s.geo.lidH - 0.18;
        const screenAspect = boxW / boxH;
        // cover: fill the screen on the tighter axis and crop the other
        const fit =
          s.pageAspect > screenAspect
            ? [s.pageAspect / screenAspect, 1]
            : [1, screenAspect / s.pageAspect];
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, s.pageTex);
        gl.uniform1i(s.uPageTex, 1);
        gl.uniform4f(
          s.uScreenBox,
          -boxW / 2,
          s.geo.lidH / 2 - boxH / 2,
          boxW,
          boxH,
        );
        gl.uniform2f(s.uFit, fit[0], fit[1]);
        part(hinge, p.screen, top3, { screen: true });
      } else {
        part(hinge, p.screen, top3, {
          grad: true,
          color2: bottom3,
          gradMin: 0.09,
          gradSpan: s.geo.lidH - 0.18,
          glow: 0.82,
        });
      }

      // Pass two: resolve the offscreen down onto the window. Depth is off
      // for it — a fullscreen quad has nothing to be behind — and the texture
      // unit is left bound, which is the state the next frame starts from.
      if (target) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.disable(gl.DEPTH_TEST);
        gl.useProgram(s.blit);
        gl.bindBuffer(gl.ARRAY_BUFFER, s.quad);
        gl.enableVertexAttribArray(s.aQuad);
        gl.vertexAttribPointer(s.aQuad, 2, gl.FLOAT, false, 0, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, target.tex);
        gl.uniform1i(s.uTex, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.enable(gl.DEPTH_TEST);
      }
    },
    [progress, finish, clear, page],
  );

  return (
    <glarea
      style={style}
      clearColor={clearColor}
      frameLoop="demand"
      glx={{ DEPTH_SIZE: 24 }}
      onCreated={onCreated}
      onDraw={onDraw}
      onWheel={onWheel}
      onError={(err) =>
        onUnavailable?.(err?.message ?? err?.code ?? 'no GL surface')
      }
      data-testname="stage-gl"
    />
  );
}
