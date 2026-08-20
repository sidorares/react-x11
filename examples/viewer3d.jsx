// A model viewer — 3D over the X connection, and what that costs.
//
//   npm run examples:viewer3d
//
// `<glarea>` is the only drawn element that owns a real X window, because
// GLX needs a drawable on a GL-capable visual. Everything it draws is
// **indirect GLX**: GL commands encoded into the same connection as
// everything else, no GPU on this side, no native bindings. That reach is
// the whole point of the transport — it works over ssh — and it decides the
// shape of every line below.
//
// ## The one rule of this backend
//
// **Geometry goes in a display list; a frame sends matrices.** Every
// immediate-mode vertex is a command on the wire, so a mesh re-sent per
// frame costs kilobytes per frame and a compiled list costs one `CallList`.
// A 960-triangle sphere is ~2,900 commands to compile once, and 1 command a
// frame thereafter. That is the difference between a viewer that orbits
// smoothly over a network and one that does not, and it is what
// `test/viewer3d.test.js` asserts: the vertices appear once, however many
// frames are drawn.
//
// This is also why orbiting keeps its angles in a ref rather than in state.
// The pointer moves faster than React needs to re-render, and nothing about
// the *scene* changes when the camera does — the frame clock reads the
// current angles and sends two matrices.
//
// ## What to try
//
//   drag              orbit. The wire carries two matrices per frame.
//   wheel             dolly in and out.
//   Model             a new mesh compiles a new list, once. Watch the
//                     "compiled" counter: it goes up per *model*, not per
//                     frame.
//   Shading           flat, smooth, or wireframe — a different list each,
//                     because normals and polygon mode are baked into the
//                     compile.
//   Spin              `frameLoop="always"` against `"demand"`. On demand the
//                     app only redraws when something changed, which is the
//                     right default for a viewer nobody is touching.
//
// ## What does not work
//
// **The direct backend is not this file.** `createRoot({ glPolicy: 'auto' })`
// gets OpenGL ES 2 on the GPU where it is available, and its raw API is a
// different spelling — camelCase ES 2 against PascalCase OpenGL 1.x, with
// nothing translating between them (`docs/gl.md`). Shaders, framebuffers and
// vertex buffers live only there. This viewer reports which backend it got
// and refuses to pretend: on `direct` it says so and draws nothing, because
// code written against one backend does not run on the other, and an
// example that quietly drew a different scene on each would teach the wrong
// thing. The declarative route (`<Canvas3D>` and the scene elements) is what
// spans both, and it is moving to `@react-x11/components`.
//
// **Nobody can screenshot it.** On XQuartz, GL renders into a Metal surface
// the compositor owns rather than into the X drawable, so `GetImage` reads
// back the window's background and `npm run screenshots` skips the 3D
// examples (`docs/glx.md`). The 2D chrome around the surface is capturable;
// the surface is not. That is why the tests assert the *command stream* —
// which is where the property that matters lives anyway.
//
// **Indirect GLX is off by default on most modern servers.** Xorg 1.17+ and
// Xwayland ship with it disabled (`+iglx` / `AllowIndirectGLX`), and those
// are exactly the machines where direct works. XQuartz allows it, which is
// why this runs on macOS. With no GL surface at all, `onError` fires and the
// window says what to do rather than showing an empty rectangle.
import React, { useCallback, useMemo, useRef, useState } from 'react';

import {
  Select,
  Switch,
  createRoot,
  createStyles,
  useApp,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// The models
//
// A seam, because the interesting one is a file on disk and the testable one
// is two triangles. Each answers flat-shaded triangles: three positions and
// one normal, which is what a display list wants and what a fixed-function
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

/** A quad as two triangles, carrying per-vertex normals for smooth shading. */
const quad = (a, b, c, d, normals) => {
  const n = faceNormal(a, b, c);
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
// The drawing
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
  gl.Lightfv(gl.LIGHT0, gl.POSITION, [2, 3, 4, 0]);
  gl.Lightfv(gl.LIGHT0, gl.DIFFUSE, [1, 0.97, 0.9, 1]);
  gl.Lightfv(gl.LIGHT0, gl.AMBIENT, [0.22, 0.24, 0.3, 1]);
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
  warn: { fontSize: 12, color: '$warning' },
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

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

export function ViewerPanel({
  models = proceduralModels(),
  initialModel,
  initialSpin = true,
}) {
  const app = useApp();
  const [modelId, setModelId] = useState(initialModel ?? models[0].id);
  const [shading, setShading] = useState('smooth');
  const [spin, setSpin] = useState(initialSpin);
  const [failed, setFailed] = useState(null);
  const [backend, setBackend] = useState(null);
  const [compiles, setCompiles] = useState(0);

  const model = models.find((m) => m.id === modelId) ?? models[0];
  const triangles = useMemo(() => model.build(), [model]);

  // The camera lives in refs: the pointer produces far more moves than the
  // scene has states, and none of them changes anything React renders.
  const camera = useRef({ yaw: 0.6, pitch: 0.35, distance: 5, spinning: 0 });
  const drag = useRef(null);
  // The compiled lists, keyed by what was baked into them.
  const lists = useRef(new Map());
  const compiledRef = useRef(0);

  const onCreated = useCallback((gl) => {
    setBackend(gl.backend ?? 'indirect');
    if (gl.backend === 'direct') return;
    lists.current = new Map();
    setupScene(gl);
  }, []);

  const onDraw = useCallback(
    (gl, { width, height }) => {
      if (gl.backend === 'direct') return;
      const key = `${model.id}:${shading}`;
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
      gl.Frustum(-1, 1, -aspect, aspect, 2.2, 60);
      gl.MatrixMode(gl.MODELVIEW);
      gl.LoadIdentity();
      gl.Translatef(0, 0, -cam.distance);
      gl.Rotatef((cam.pitch * 180) / Math.PI, 1, 0, 0);
      gl.Rotatef(((cam.yaw + cam.spinning) * 180) / Math.PI, 0, 1, 0);
      gl.Color3f(0.55, 0.72, 0.95);
      gl.CallList(list);
    },
    [model, shading, triangles, spin],
  );

  const onMouseDown = useCallback((ev) => {
    drag.current = { x: ev.x, y: ev.y };
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
  }, []);
  const onWheel = useCallback((ev) => {
    const cam = camera.current;
    cam.distance = Math.min(30, Math.max(2.6, cam.distance + ev.deltaY * 0.4));
  }, []);

  const glCaps = app?.glCapabilities?.();

  return (
    <box style={s.root}>
      <box style={s.stage}>
        {failed ? (
          <box style={s.fallback} data-testname="failed">
            <text style={s.bad}>{`No GL surface: ${failed}`}</text>
            <text style={s.dim}>
              Indirect GLX is off by default on Xorg 1.17+ and Xwayland. Start
              the server with `+iglx`, or run with `NTK_GL_POLICY=direct` on a
              machine with DRI3 — and see `docs/gl.md` for what changes when you
              do.
            </text>
          </box>
        ) : backend === 'direct' ? (
          <box style={s.fallback} data-testname="direct">
            <text style={s.warn}>This viewer draws through indirect GLX.</text>
            <text style={s.dim}>
              The direct backend hands `onDraw` an OpenGL ES 2 context —
              camelCase, shaders, vertex buffers — and nothing translates
              between the two spellings, so the fixed-function code this file is
              made of would not run. {'`<Canvas3D>`'} is what spans both.
            </text>
          </box>
        ) : (
          <glarea
            style={{ flexGrow: 1 }}
            data-testname="stage"
            clearColor="#0b1021"
            frameLoop={spin ? 'always' : 'demand'}
            glx={{ DEPTH_SIZE: 24 }}
            onCreated={onCreated}
            onDraw={onDraw}
            onError={(err) => setFailed(String(err?.message ?? err))}
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
          <text style={s.h}>On the wire</text>
          <text style={s.value}>{`${triangles.length / 3} triangles`}</text>
          <text style={s.dim}>
            {`${compiles} list${compiles === 1 ? '' : 's'} compiled · 1 CallList per frame`}
          </text>
        </box>

        <box style={s.fact}>
          <text style={s.h}>Backend</text>
          <text style={s.value}>{backend ?? 'starting…'}</text>
          <text style={s.dim}>
            {glCaps
              ? `direct ${glCaps.direct ? 'available' : 'unavailable'}`
              : 'no capability report'}
          </text>
          <text style={s.dim}>
            No shaders, no framebuffers, no vertex arrays — the GLX protocol
            encodes none of them.
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
