// A model viewer — one scene on both GL backends, and what geometry costs on
// each.
//
//   npm run examples:viewer3d                          # X11: indirect GLX
//   NTK_GL_POLICY=direct npm run examples:viewer3d     # X11: GLES on the GPU
//   env -u DISPLAY REACT_X11_BACKEND=wayland bun examples/viewer3d.jsx
//
// A `<glarea>` hands `onDraw` one of two GL APIs, and they are different APIs
// rather than two spellings of one (docs/gl.md). So this file draws the same
// model twice over, and branches once, on `gl.backend`:
//
// - **indirect** — GLX: GL 1.x commands encoded into the same connection as
//   everything else, no GPU on this side, no native bindings. That reach is
//   the whole point of the transport — it works over ssh — and it decides
//   the shape of that half of the file. GLX needs a drawable on a GL-capable
//   visual, which is why on X11 `<glarea>` is the one drawn element that
//   owns a real X window.
// - **direct** — OpenGL ES 2 on the GPU, through the `x11-dri` addon, with
//   finished frames handed over as buffers rather than commands. X11 draws
//   through it under `glPolicy: 'direct'` (or `'auto'`, where it exists). The
//   Wayland backend has nothing else — there is no X connection to encode GL
//   into — and there the surface is a rect of the window's own GPU target
//   rather than a window (src/wayland/glarea.js).
//
// ## The one rule, on both backends
//
// **Geometry crosses once; a frame sends matrices.** On indirect every
// immediate-mode vertex is a command on the wire, so a mesh re-sent per
// frame costs kilobytes per frame and a compiled display list costs one
// `CallList`. The 768-triangle sphere is ~4,600 commands to compile once, and
// 1 command a frame thereafter. That is the difference between a viewer that
// orbits smoothly over a network and one that does not.
//
// On direct the rule is the same and the price is not. `bufferData` copies a
// mesh into GPU memory once, and a frame is two uniform matrices and one
// `drawArrays`; re-uploading per frame would cost a copy to the GPU rather
// than a round of requests across a socket — cheaper, and still waste. So
// the two halves are built alike: a mesh is baked on the frame that first
// needs it and kept under what was baked into it, and the panel counts
// compiled lists on one backend and uploaded buffers on the other. Both go
// up per *model*, never per frame. `test/viewer3d.test.js` asserts the direct
// half against a recording GL — one upload, however many frames. The
// indirect half it cannot see (its GLX emulator replays lists), so that one
// is measured on a real server instead; the test's header says how.
//
// This is also why orbiting keeps its angles in a ref rather than in state.
// The pointer moves faster than React needs to re-render, and nothing about
// the *scene* changes when the camera does — the frame clock reads the
// current angles and sends two matrices.
//
// ## What to try
//
//   drag              orbit. A frame carries two matrices, on either backend.
//   wheel             dolly in and out.
//   Model             a new mesh compiles a new list — or uploads a new
//                     buffer — once. Watch the counter: it goes up per
//                     *model*, not per frame.
//   Shading           flat, smooth, or wireframe — a different list or buffer
//                     each, because the normals and the polygon mode are
//                     baked into it (and GLES has no polygon mode, below).
//   Spin              `frameLoop="always"` against `"demand"`. On demand the
//                     app only redraws when something changed, which is the
//                     right default for a viewer nobody is touching.
//
// ## The shader is the fixed-function pipeline, written out
//
// The direct half draws what the indirect half draws, so its shader is the
// part of OpenGL 1.x that `setupScene` leans on without spelling out: one
// directional light fixed to the camera, ambient plus Lambert diffuse —
// ambient being the light's own *and* the 0.2 that fixed function adds for
// the light model unasked — times the material's colour, clamped. It lights
// per vertex, as `glLight` does, and lets the rasterizer interpolate the
// colour. Per fragment is what shaders are for, and this backend could; it
// is one line moved between the two shaders, left where it is so switching
// backends does not change the picture.
//
// Three things fixed function keeps as state are done another way here:
//
// - **flat** has no `ShadeModel` to ask for. Every vertex of a triangle
//   carries the face's normal instead — the meshes already give each
//   triangle three vertices of its own, so nothing has to be split.
// - **wireframe** has no `PolygonMode`: GLES rasterizes no polygon as lines.
//   The buffer is `LINES` instead, three segments a triangle and lit with the
//   vertex normals, which is what the indirect wireframe draws.
// - **the depth test** is switched on in every frame rather than once,
//   because the context is shared: between every `<glarea>` on X11, and on
//   Wayland with the window's own 2D renderer, which puts its state back
//   after each surface draws. The light is the exception. It is uniforms of
//   the program, and a program keeps its uniforms, so it is set once, like
//   the indirect half's.
//
// ## What does not work
//
// **On X11, nobody can screenshot it.** On XQuartz, GL renders into a Metal
// surface the compositor owns rather than into the X drawable, so `GetImage`
// reads back the window's background and `npm run screenshots` skips the 3D
// examples (docs/glx.md). The 2D chrome around the surface is capturable;
// the surface is not. That is why the tests assert the *command stream* —
// which is where the property that matters lives anyway. Wayland is the
// exception: the surface is drawn into the window's own target, and
// `REACT_X11_WAYLAND_SNAPSHOT` reads the whole window back off the GPU.
//
// **Indirect GLX is off by default on most modern servers.** Xorg 1.17+ and
// Xwayland ship with it disabled (`+iglx` / `AllowIndirectGLX`), and those
// are exactly the machines where direct works — `NTK_GL_POLICY=direct` runs
// this file there, on the GPU. XQuartz allows it, which is why the default
// runs on macOS. `createRoot()` below asks for no policy, so X11 gets ntk's
// default, indirect: the wire is what this viewer is for, and `'auto'` would
// take it away on every machine with a GPU. With no GL surface at all,
// `onError` fires and the window says what to do rather than showing an
// empty rectangle.
//
// Two hand-written halves is the price of raw GL. A scene graph —
// `@react-x11/components/three` — spans both backends without the branch.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  Select,
  Switch,
  createRoot,
  createStyles,
  useApp,
} from '../src/index.js';
import { compose, multiply, perspective } from '../src/mat4.js';

// ---------------------------------------------------------------------------
// The models
//
// A seam, because the interesting one is a file on disk and the testable one
// is two triangles. Each answers triangles as three vertices of their own,
// each with a position, a vertex normal and the face's normal — which is
// what a display list wants, what a vertex buffer wants, and what either
// pipeline lights.
// ---------------------------------------------------------------------------

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const minus = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v) => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const faceNormal = (a, b, c) => norm(cross(minus(b, a), minus(c, a)));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * A quad as two triangles, carrying per-vertex normals for smooth shading.
 *
 * The winding decides which way the face normal points, and the sphere and
 * the torus wind their quads the other way round from the cube's. So where
 * the surface brings normals of its own, the face's is turned to agree with
 * them: pointing inwards, it made flat shading light the inside of the
 * surface, on both backends.
 */
const quad = (a, b, c, d, normals) => {
  const wound = faceNormal(a, b, c);
  const n =
    normals && dot(wound, normals[0]) < 0 ? wound.map((v) => -v) : wound;
  const vn = normals ?? [n, n, n, n];
  return [
    { p: a, n: vn[0], f: n },
    { p: b, n: vn[1], f: n },
    { p: c, n: vn[2], f: n },
    { p: a, n: vn[0], f: n },
    { p: c, n: vn[2], f: n },
    { p: d, n: vn[3], f: n },
  ];
};

function cube() {
  const s = 1;
  const v = [
    [-s, -s, s],
    [s, -s, s],
    [s, s, s],
    [-s, s, s],
    [-s, -s, -s],
    [s, -s, -s],
    [s, s, -s],
    [-s, s, -s],
  ];
  return [
    ...quad(v[0], v[1], v[2], v[3]),
    ...quad(v[5], v[4], v[7], v[6]),
    ...quad(v[4], v[0], v[3], v[7]),
    ...quad(v[1], v[5], v[6], v[2]),
    ...quad(v[3], v[2], v[6], v[7]),
    ...quad(v[4], v[5], v[1], v[0]),
  ];
}

function sphere(bands = 16, segments = 24) {
  const at = (i, j) => {
    const phi = (i / bands) * Math.PI;
    const theta = (j / segments) * Math.PI * 2;
    return [
      Math.sin(phi) * Math.cos(theta),
      Math.cos(phi),
      Math.sin(phi) * Math.sin(theta),
    ];
  };
  const out = [];
  for (let i = 0; i < bands; i += 1) {
    for (let j = 0; j < segments; j += 1) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      // a sphere's vertex normal *is* its position, which is what makes the
      // smooth/flat switch visible on it
      out.push(...quad(a, b, c, d, [a, b, c, d]));
    }
  }
  return out;
}

function torus(major = 24, minor = 16, R = 1, r = 0.38) {
  const at = (i, j) => {
    const u = (i / major) * Math.PI * 2;
    const v = (j / minor) * Math.PI * 2;
    const cx = Math.cos(u) * R;
    const cz = Math.sin(u) * R;
    const p = [
      Math.cos(u) * (R + r * Math.cos(v)),
      r * Math.sin(v),
      Math.sin(u) * (R + r * Math.cos(v)),
    ];
    return { p, n: norm(minus(p, [cx, 0, cz])) };
  };
  const out = [];
  for (let i = 0; i < major; i += 1) {
    for (let j = 0; j < minor; j += 1) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      out.push(...quad(a.p, b.p, c.p, d.p, [a.n, b.n, c.n, d.n]));
    }
  }
  return out;
}

export function proceduralModels() {
  return [
    { id: 'cube', label: 'Cube', build: cube },
    { id: 'sphere', label: 'Sphere', build: sphere },
    { id: 'torus', label: 'Torus', build: torus },
  ];
}

const SHADING = [
  { value: 'smooth', label: 'Smooth' },
  { value: 'flat', label: 'Flat' },
  { value: 'wire', label: 'Wireframe' },
];

// ---------------------------------------------------------------------------
// The scene — one lens, one light and one colour, whichever GL draws it
// ---------------------------------------------------------------------------

/** The lens's near and far planes; its width is the surface's. */
const NEAR = 2.2;
const FAR = 60;

/**
 * The light. `w = 0` makes it directional, and it is set while the modelview
 * is still the identity, so its direction is in eye space: it stays over the
 * viewer's right shoulder however the model turns.
 */
const LIGHT_POSITION = [2, 3, 4, 0];
const LIGHT_DIFFUSE = [1, 0.97, 0.9, 1];
const LIGHT_AMBIENT = [0.22, 0.24, 0.3, 1];

/** Ambient and diffuse both, through `COLOR_MATERIAL` on indirect. */
const MODEL_COLOR = [0.55, 0.72, 0.95];

/**
 * `LIGHT_MODEL_AMBIENT`: fixed function lights every surface with this much
 * of its own colour before any light is counted. `setupScene` never sets it,
 * so it is GL's default — and the shader has to be told.
 */
const LIGHT_MODEL_AMBIENT = 0.2;

// ---------------------------------------------------------------------------
// The drawing, indirect: display lists
// ---------------------------------------------------------------------------

/** The first display-list name this app claims. */
const LIST_BASE = 1;

/**
 * Compile one mesh into a display list.
 *
 * This is the expensive call and the only one that carries geometry: every
 * `Vertex3f` here is a command on the wire, and none of them is sent again.
 * The list id is the app's handle to all of it.
 */
function compile(gl, list, triangles, shading) {
  gl.NewList(list, gl.COMPILE);
  gl.PolygonMode(gl.FRONT_AND_BACK, shading === 'wire' ? gl.LINE : gl.FILL);
  gl.ShadeModel(shading === 'flat' ? gl.FLAT : gl.SMOOTH);
  gl.Begin(gl.TRIANGLES);
  for (const v of triangles) {
    const n = shading === 'flat' ? v.f : v.n;
    gl.Normal3f(n[0], n[1], n[2]);
    gl.Vertex3f(v.p[0], v.p[1], v.p[2]);
  }
  gl.End();
  gl.EndList();
}

/** The lights and material, set once when the context appears. */
function setupScene(gl) {
  gl.Enable(gl.DEPTH_TEST);
  gl.Enable(gl.LIGHTING);
  gl.Enable(gl.LIGHT0);
  gl.Enable(gl.NORMALIZE);
  gl.Enable(gl.COLOR_MATERIAL);
  gl.ColorMaterial(gl.FRONT_AND_BACK, gl.AMBIENT_AND_DIFFUSE);
  gl.Lightfv(gl.LIGHT0, gl.POSITION, LIGHT_POSITION);
  gl.Lightfv(gl.LIGHT0, gl.DIFFUSE, LIGHT_DIFFUSE);
  gl.Lightfv(gl.LIGHT0, gl.AMBIENT, LIGHT_AMBIENT);
}

// ---------------------------------------------------------------------------
// The drawing, direct: one program and a vertex buffer per mesh
// ---------------------------------------------------------------------------

// GLSL ES 1.00, the language every direct flavor speaks. The vertex shader
// is `setupScene` plus what fixed function does with it: normals into eye
// space (and normalized, as `GL_NORMALIZE` asks), one directional light,
// and the lit colour clamped per vertex before it is interpolated.
const VERTEX_SRC = `
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform mat4 uMvp;
uniform mat3 uNormalMatrix;
uniform vec3 uLightDir;
uniform vec3 uAmbient;
uniform vec3 uDiffuse;
uniform vec3 uColor;
varying vec3 vColor;
void main() {
  vec3 n = normalize(uNormalMatrix * aNormal);
  float lambert = max(dot(n, uLightDir), 0.0);
  vColor = min(uColor * (uAmbient + lambert * uDiffuse), 1.0);
  gl_Position = uMvp * vec4(aPosition, 1.0);
}`;

const FRAGMENT_SRC = `
precision mediump float;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
}`;

/** Floats per vertex in a buffer: a position, then a normal. */
const STRIDE = 6;

/**
 * One mesh as a vertex buffer wants it — positions and normals interleaved,
 * in one array for one `bufferData` — with what was baked into it.
 *
 * The three shadings are three arrays, the way they are three lists on
 * indirect. Flat and smooth differ only in which normal each vertex carries.
 * Wireframe differs in the primitive: `LINES` over each triangle's three
 * edges, lit with the vertex normals, because GLES has no `PolygonMode` to
 * rasterize the triangles as outlines. An edge two triangles share is drawn
 * twice, as `PolygonMode(LINE)` draws it.
 */
function vertexData(triangles, shading) {
  const lines = shading === 'wire';
  const order = [];
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const [a, b, c] = [triangles[i], triangles[i + 1], triangles[i + 2]];
    if (lines) order.push(a, b, b, c, c, a);
    else order.push(a, b, c);
  }
  const data = new Float32Array(order.length * STRIDE);
  order.forEach((v, i) => {
    data.set(v.p, i * STRIDE);
    data.set(shading === 'flat' ? v.f : v.n, i * STRIDE + 3);
  });
  return { data, count: order.length, lines };
}

function shaderOf(gl, type, src, what) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`${what} shader: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

/**
 * The program, and the light and material in its uniforms — `setupScene`'s
 * counterpart, once when the context appears.
 */
function buildProgram(gl) {
  const program = gl.createProgram();
  gl.attachShader(
    program,
    shaderOf(gl, gl.VERTEX_SHADER, VERTEX_SRC, 'vertex'),
  );
  gl.attachShader(
    program,
    shaderOf(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC, 'fragment'),
  );
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(program)}`);
  }
  const uniform = (name) => gl.getUniformLocation(program, name);
  const set = (name, v) => gl.uniform3f(uniform(name), v[0], v[1], v[2]);
  gl.useProgram(program);
  set('uLightDir', norm(LIGHT_POSITION.slice(0, 3)));
  set(
    'uAmbient',
    LIGHT_AMBIENT.map((c) => c + LIGHT_MODEL_AMBIENT),
  );
  set('uDiffuse', LIGHT_DIFFUSE);
  set('uColor', MODEL_COLOR);
  return {
    program,
    aPosition: gl.getAttribLocation(program, 'aPosition'),
    aNormal: gl.getAttribLocation(program, 'aNormal'),
    uMvp: uniform('uMvp'),
    uNormalMatrix: uniform('uNormalMatrix'),
  };
}

/**
 * Upload one mesh: `compile`'s counterpart, and the only call here that
 * carries geometry. The buffer is the app's handle to all of it.
 */
function upload(gl, triangles, shading) {
  const { data, count, lines } = vertexData(triangles, shading);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return { buffer, count, mode: lines ? gl.LINES : gl.TRIANGLES };
}

/**
 * The indirect half's two matrices, from src/mat4.js.
 *
 * `Frustum(-1, 1, -a, a, NEAR, FAR)` is a perspective whose top edge meets
 * the near plane at `a`, which makes its vertical field of view
 * `2·atan(a / NEAR)`, and `perspective` builds the same matrix from that.
 * The modelview is `Translatef` then two `Rotatef`s, which is `compose` with
 * the rotation in its XYZ order. It is rigid, so its upper 3×3 is its own
 * inverse transpose — the normal matrix without inverting anything.
 */
function cameraMatrices(cam, width, height) {
  const aspect = height / width || 1;
  const fov = (360 / Math.PI) * Math.atan(aspect / NEAR);
  const projection = perspective(fov, 1 / aspect, NEAR, FAR);
  const modelView = compose(
    [0, 0, -cam.distance],
    [cam.pitch, cam.yaw + cam.spinning, 0],
    [1, 1, 1],
  );
  const upper3x3 = [0, 1, 2, 4, 5, 6, 8, 9, 10].map((i) => modelView[i]);
  return {
    mvp: multiply(projection, modelView),
    normal: new Float32Array(upper3x3),
  };
}

/**
 * A frame: the camera as two uniforms, and one draw of a buffer that is
 * already on the GPU.
 *
 * The depth test is switched on here, every frame, because the context is
 * not this surface's alone (the header says whose). The attribute arrays go
 * back off at the end for the same reason: whoever draws next reads through
 * the arrays that are enabled, and these point into a buffer of ours.
 */
function drawMesh(gl, scene, mesh, { mvp, normal }) {
  gl.enable(gl.DEPTH_TEST);
  gl.useProgram(scene.program);
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
  gl.enableVertexAttribArray(scene.aPosition);
  gl.vertexAttribPointer(scene.aPosition, 3, gl.FLOAT, false, STRIDE * 4, 0);
  gl.enableVertexAttribArray(scene.aNormal);
  gl.vertexAttribPointer(scene.aNormal, 3, gl.FLOAT, false, STRIDE * 4, 12);
  gl.uniformMatrix4fv(scene.uMvp, false, mvp);
  gl.uniformMatrix3fv(scene.uNormalMatrix, false, normal);
  gl.drawArrays(mesh.mode, 0, mesh.count);
  gl.disableVertexAttribArray(scene.aPosition);
  gl.disableVertexAttribArray(scene.aNormal);
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = createStyles({
  root: { flexGrow: 1, flexDirection: 'row', backgroundColor: '$background' },
  side: {
    width: 250,
    flexDirection: 'column',
    gap: 12,
    padding: 14,
    borderStartWidth: 1,
    borderColor: '$border',
  },
  stage: { flexGrow: 1, flexDirection: 'column' },
  h: { fontSize: 12, color: '$textMuted' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { fontSize: 12, color: '$text' },
  value: { fontSize: 13, color: '$text' },
  dim: { fontSize: 11, color: '$textMuted' },
  bad: { fontSize: 12, color: '$danger' },
  fact: { flexDirection: 'column', gap: 1 },
  fallback: {
    flexGrow: 1,
    padding: 24,
    gap: 8,
    flexDirection: 'column',
    justifyContent: 'center',
    backgroundColor: '$surface',
  },
});

/** What to do about no GL surface, which is almost always this. */
const NO_SURFACE_HINT =
  'Indirect GLX is off by default on Xorg 1.17+ and Xwayland. Start the ' +
  'server with `+iglx`, or run with `NTK_GL_POLICY=direct` on a machine ' +
  'with DRI3 — this viewer draws on either backend.';

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

export function ViewerPanel({
  models = proceduralModels(),
  initialModel,
  initialShading = 'smooth',
  initialSpin = true,
}) {
  const app = useApp();
  const [modelId, setModelId] = useState(initialModel ?? models[0].id);
  const [shading, setShading] = useState(initialShading);
  const [spin, setSpin] = useState(initialSpin);
  const [failed, setFailed] = useState(null);
  const [backend, setBackend] = useState(null);
  const [compiles, setCompiles] = useState(0);
  const [uploads, setUploads] = useState(0);
  const direct = backend === 'direct';

  const model = models.find((m) => m.id === modelId) ?? models[0];
  const triangles = useMemo(() => model.build(), [model]);

  // The camera lives in refs: the pointer produces far more moves than the
  // scene has states, and none of them changes anything React renders.
  const camera = useRef({ yaw: 0.6, pitch: 0.35, distance: 5, spinning: 0 });
  const drag = useRef(null);
  // The compiled lists, keyed by what was baked into them.
  const lists = useRef(new Map());
  const compiledRef = useRef(0);
  // …and on direct the program, and the uploaded buffers, keyed the same way.
  const scene = useRef(null);
  const meshes = useRef(new Map());
  const uploadedRef = useRef(0);

  const onCreated = useCallback((gl) => {
    setBackend(gl.backend ?? 'indirect');
    if (gl.backend === 'direct') {
      meshes.current = new Map();
      try {
        scene.current = buildProgram(gl);
      } catch (err) {
        setFailed({
          message: `The viewer's shaders did not build: ${err.message}`,
        });
      }
      return;
    }
    lists.current = new Map();
    setupScene(gl);
  }, []);

  const onDraw = useCallback(
    (gl, { width, height }) => {
      const key = `${model.id}:${shading}`;
      if (gl.backend === 'direct') {
        if (!scene.current) return;
        let mesh = meshes.current.get(key);
        if (mesh === undefined) {
          mesh = upload(gl, triangles, shading);
          meshes.current.set(key, mesh);
          uploadedRef.current += 1;
          setUploads(uploadedRef.current);
        }
        const cam = camera.current;
        if (spin) cam.spinning += 0.01;
        drawMesh(gl, scene.current, mesh, cameraMatrices(cam, width, height));
        return;
      }
      let list = lists.current.get(key);
      if (list === undefined) {
        // Display-list names are the app's to choose, so they are counted
        // out here rather than asked for: `GenLists` is a round trip, and
        // this backend is one where round trips are the thing to avoid.
        list = LIST_BASE + lists.current.size;
        compile(gl, list, triangles, shading);
        lists.current.set(key, list);
        compiledRef.current += 1;
        setCompiles(compiledRef.current);
      }

      const cam = camera.current;
      if (spin) cam.spinning += 0.01;

      const aspect = height / width || 1;
      gl.MatrixMode(gl.PROJECTION);
      gl.LoadIdentity();
      gl.Frustum(-1, 1, -aspect, aspect, NEAR, FAR);
      gl.MatrixMode(gl.MODELVIEW);
      gl.LoadIdentity();
      gl.Translatef(0, 0, -cam.distance);
      gl.Rotatef((cam.pitch * 180) / Math.PI, 1, 0, 0);
      gl.Rotatef(((cam.yaw + cam.spinning) * 180) / Math.PI, 0, 1, 0);
      gl.Color3f(MODEL_COLOR[0], MODEL_COLOR[1], MODEL_COLOR[2]);
      gl.CallList(list);
    },
    [model, shading, triangles, spin],
  );

  // A drag is the one thing that has to redraw between renders: the moves
  // write the camera ref, and a `'demand'` surface draws only when a prop
  // changes — so the loop runs for as long as the drag does, and the press
  // and the release are the drag's only two renders.
  const [dragging, setDragging] = useState(false);
  const onMouseDown = useCallback((ev) => {
    // the orbit keeps going when the pointer leaves the stage, and the
    // release ends it wherever it lands
    ev.capturePointer();
    drag.current = { x: ev.x, y: ev.y };
    setDragging(true);
  }, []);
  const onMouseMove = useCallback((ev) => {
    const from = drag.current;
    if (!from) return;
    const cam = camera.current;
    cam.yaw += (ev.x - from.x) * 0.01;
    cam.pitch += (ev.y - from.y) * 0.01;
    drag.current = { x: ev.x, y: ev.y };
  }, []);
  const onMouseUp = useCallback(() => {
    drag.current = null;
    setDragging(false);
  }, []);
  const onWheel = useCallback((ev) => {
    const cam = camera.current;
    cam.distance = Math.min(30, Math.max(2.6, cam.distance + ev.deltaY * 0.4));
  }, []);

  // What the machine could do, beside what this connection does: under ntk's
  // default policy a DRI3 box answers `direct: true` and still draws
  // indirect (src/glbackend.js), and that pair is the hint worth showing.
  // The answer is a promise on every backend, so it is awaited, not read.
  const [caps, setCaps] = useState(null);
  useEffect(() => {
    let live = true;
    Promise.resolve(app?.glCapabilities?.()).then(
      (c) => live && c && setCaps(c),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [app]);

  let capsLine = 'no capability report';
  if (direct) {
    capsLine = `GLES on the GPU${caps?.flavor ? ` via ${caps.flavor}` : ''}`;
  } else if (caps) {
    capsLine = caps.direct
      ? 'direct available: NTK_GL_POLICY=direct'
      : 'direct unavailable here';
  }

  return (
    <box style={s.root}>
      <box style={s.stage}>
        {failed ? (
          <box style={s.fallback} data-testname="failed">
            <text style={s.bad}>{failed.message}</text>
            {failed.hint ? <text style={s.dim}>{failed.hint}</text> : null}
          </box>
        ) : (
          <glarea
            style={{ flexGrow: 1 }}
            data-testname="stage"
            clearColor="#0b1021"
            frameLoop={spin || dragging ? 'always' : 'demand'}
            glx={{ DEPTH_SIZE: 24 }}
            onCreated={onCreated}
            onDraw={onDraw}
            onError={(err) =>
              setFailed({
                message: `No GL surface: ${err?.message ?? err}`,
                hint: NO_SURFACE_HINT,
              })
            }
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onWheel={onWheel}
          />
        )}
      </box>

      <box style={s.side}>
        <box style={s.fact}>
          <text style={s.h}>Model</text>
          <Select
            value={modelId}
            aria-label="Model"
            options={models.map((m) => ({ value: m.id, label: m.label }))}
            onChange={(ev) => setModelId(ev.value)}
          />
        </box>
        <box style={s.fact}>
          <text style={s.h}>Shading</text>
          <Select
            value={shading}
            aria-label="Shading"
            options={SHADING}
            onChange={(ev) => setShading(ev.value)}
          />
        </box>
        <box style={s.row}>
          <text style={s.label}>Spin</text>
          <Switch
            checked={spin}
            aria-label="Spin"
            data-testname="spin"
            onChange={(ev) => setSpin(ev.value)}
          />
        </box>

        <box style={s.fact} data-testname="facts">
          <text style={s.h}>{direct ? 'On the GPU' : 'On the wire'}</text>
          <text style={s.value}>{`${triangles.length / 3} triangles`}</text>
          <text style={s.dim}>
            {direct
              ? `${uploads} buffer${uploads === 1 ? '' : 's'} uploaded · 1 draw per frame`
              : `${compiles} list${compiles === 1 ? '' : 's'} compiled · 1 CallList per frame`}
          </text>
        </box>

        <box style={s.fact} data-testname="backend">
          <text style={s.h}>Backend</text>
          <text style={s.value}>{backend ?? 'starting…'}</text>
          <text style={s.dim}>{capsLine}</text>
          <text style={s.dim}>
            {direct
              ? 'A shader and vertex buffers — two things the GLX protocol has no encoding for.'
              : 'No shaders, no framebuffers, no vertex arrays — the GLX protocol encodes none of them.'}
          </text>
        </box>
      </box>
    </box>
  );
}

function App(props) {
  return (
    <window
      width={880}
      height={560}
      title="Model viewer"
      wmClass="com.example.x11viewer3d"
      style={{ flexGrow: 1 }}
    >
      <ViewerPanel {...props} />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
