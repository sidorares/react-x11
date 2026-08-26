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
// ## What does not work
//
// No picking: `<glarea>` does not take part in the parent's hit testing yet
// (docs/elements.md), so the laptop cannot be dragged to orbit it — the
// scroll position is the only input. Reduced motion is not honoured here
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
 * One axis-aligned box, at its final size and place in the group's space.
 *
 * Sized here rather than scaled by the model matrix on purpose: a non-uniform
 * scale needs the inverse transpose to carry normals, and every transform
 * below stays rigid this way, so `mat3(uModel)` is the whole normal matrix.
 */
function box(out, [cx, cy, cz], [w, h, d]) {
  const x = w / 2;
  const y = h / 2;
  const z = d / 2;
  const faces = [
    [
      [0, 0, 1],
      [-x, -y, z],
      [x, -y, z],
      [x, y, z],
      [-x, y, z],
    ],
    [
      [0, 0, -1],
      [x, -y, -z],
      [-x, -y, -z],
      [-x, y, -z],
      [x, y, -z],
    ],
    [
      [0, 1, 0],
      [-x, y, z],
      [x, y, z],
      [x, y, -z],
      [-x, y, -z],
    ],
    [
      [0, -1, 0],
      [-x, -y, -z],
      [x, -y, -z],
      [x, -y, z],
      [-x, -y, z],
    ],
    [
      [1, 0, 0],
      [x, -y, z],
      [x, -y, -z],
      [x, y, -z],
      [x, y, z],
    ],
    [
      [-1, 0, 0],
      [-x, -y, -z],
      [-x, -y, z],
      [-x, y, z],
      [-x, y, -z],
    ],
  ];
  const start = out.length / 6;
  for (const [n, a, b, c, d2] of faces) {
    for (const v of [a, b, c, a, c, d2]) {
      out.push(v[0] + cx, v[1] + cy, v[2] + cz, n[0], n[1], n[2]);
    }
  }
  return { first: start, count: out.length / 6 - start };
}

/** Vertical field of view, and how much of the object has to fit inside it:
 *  half the width across; the vertical reach travels with the lid and comes
 *  from the pose. */
const FOV_Y = 32;
const REACH_H = 1.68;

const BASE_W = 3.1;
const BASE_D = 2.1;
const BASE_H = 0.13;
const LID_H = 0.07;

/** The parts, in two groups: what stays put and what swings on the hinge. */
function buildGeometry() {
  const data = [];
  // the body, in the base's own space — the hinge is at z = -BASE_D / 2
  const base = box(data, [0, 0, 0], [BASE_W, BASE_H, BASE_D]);
  const keys = box(
    data,
    [0, BASE_H / 2, -0.24],
    [BASE_W - 0.42, 0.012, BASE_D - 1.0],
  );
  const pad = box(data, [0, BASE_H / 2, 0.62], [1.16, 0.01, BASE_D - 1.45]);
  // the lid, in the hinge's space: it extends *away* from the pivot, so the
  // whole part sits at +y and rotates around the origin
  const lidH = BASE_D - 0.06;
  const lid = box(data, [0, lidH / 2, -LID_H / 2], [BASE_W, lidH, LID_H]);
  const screen = box(
    data,
    [0, lidH / 2, 0.001],
    [BASE_W - 0.2, lidH - 0.18, LID_H],
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
varying float vY;
void main() {
  vNormal = normalize(mat3(uModel) * aNormal);
  vY = aPos.y;
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
varying vec3 vNormal;
varying float vY;
void main() {
  vec3 n = normalize(vNormal);
  float key = max(dot(n, normalize(vec3(-0.35, 0.85, 0.55))), 0.0);
  float fill = max(dot(n, normalize(vec3(0.7, 0.25, 0.4))), 0.0);
  float bounce = max(-n.y, 0.0);
  vec3 base = mix(uColor, uColor2, uGrad * clamp((vY - uGradMin) / uGradSpan, 0.0, 1.0));
  vec3 lit = base * (0.52 + 0.46 * key + 0.16 * fill + 0.08 * bounce);
  gl_FragColor = vec4(mix(lit, base, uGlow), 1.0);
}`;

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

// ---------------------------------------------------------------------------
// The element
// ---------------------------------------------------------------------------

/**
 * `bind` is a ref the page hands over so its scroll handler can push a
 * position straight into this component's state. The alternative — lifting
 * the position to the page — re-renders the whole configuration on every
 * scroll event to move a laptop, which is the one thing a scroll must not do.
 */
export function LaptopGL({ finish, bind, clearColor, onUnavailable, style }) {
  const [progress, setProgress] = useState(0);
  const scene = useRef(null);

  useEffect(() => {
    if (!bind) return undefined;
    bind.current.set = setProgress;
    return () => {
      bind.current.set = null;
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
        scene.current = {
          program,
          buffer,
          geo,
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
      // Fit the object to the panel rather than trusting a fixed distance:
      // the stage is one shape at 1220px and another when the layout stacks,
      // and a camera that ignores that crops the laptop on the narrow one.
      const aspect = Math.max(width, 1) / Math.max(height, 1);
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
        gl.drawArrays(gl.TRIANGLES, first, count);
      };

      const p = s.geo.parts;
      part(body, p.base, body3);
      part(body, p.keys, well3);
      part(body, p.pad, edge3);
      part(hinge, p.lid, body3);
      // the screen is lit by itself rather than by the room, which is what
      // makes it read as a screen and not as a painted panel
      part(hinge, p.screen, top3, {
        grad: true,
        color2: bottom3,
        gradMin: 0.09,
        gradSpan: s.geo.lidH - 0.18,
        glow: 0.82,
      });
    },
    [progress, finish],
  );

  return (
    <glarea
      style={style}
      clearColor={clearColor}
      frameLoop="demand"
      glx={{ DEPTH_SIZE: 24 }}
      onCreated={onCreated}
      onDraw={onDraw}
      onError={(err) =>
        onUnavailable?.(err?.message ?? err?.code ?? 'no GL surface')
      }
      data-testname="stage-gl"
    />
  );
}
