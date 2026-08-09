// A shader lab: ordinary 2D controls driving a scene that only the **direct**
// backend can draw.
//
//   npm run examples:shader-lab
//
// Every knob here moves a uniform, and a uniform write is the cheapest thing
// a frame can contain — so the sliders feel like sliders rather than like
// recompiles. Nothing in the middle panel is expressible over indirect GLX:
// the surface is displaced per vertex and shaded per fragment by GLSL the app
// wrote, which the GLX protocol encodes no way to send.
//
// It also uses the drawables that are not triangles — `<points>` for the
// halo, `<instancedMesh>` for the row of cubes — and `useFrame`, the
// per-surface clock. Those three do work on both backends; the shader does
// not, so the whole panel is gated on `useSupports('shaders')`.
import React, { useState } from 'react';

import {
  Button,
  Canvas3D,
  Select,
  Slider,
  Switch,
} from '../src/components/index.js';
import { createRoot, useApp, useFrame, useSupports } from '../src/index.js';

const PALETTES = {
  ember: { a: [0.85, 0.2, 0.35], b: [0.98, 0.75, 0.25], halo: '#ffd166' },
  lagoon: { a: [0.1, 0.35, 0.7], b: [0.3, 0.9, 0.8], halo: '#7ae7ff' },
  orchid: { a: [0.45, 0.15, 0.7], b: [0.95, 0.45, 0.85], halo: '#f2a6ff' },
  moss: { a: [0.12, 0.4, 0.2], b: [0.75, 0.9, 0.3], halo: '#c8f56a' },
};

// three.js's names are declared for you, so this is the shader you would
// write against react-three-fiber
const VERTEX = `
varying vec2 vUv;
varying vec3 vNormal;
varying float vWave;
uniform float uTime;
uniform float uAmplitude;
uniform float uFrequency;
void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  // ripple along the surface, travelling with time
  float wave = sin(position.y * uFrequency + uTime * 2.0)
             * cos(position.x * uFrequency * 0.7 - uTime);
  vWave = wave;
  vec3 displaced = position + normal * uAmplitude * wave;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}`;

const FRAGMENT = `
varying vec2 vUv;
varying vec3 vNormal;
varying float vWave;
uniform float uTime;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uBands;
uniform float uRim;
uniform float uChecker;
void main() {
  float band = 0.5 + 0.5 * sin(vUv.y * uBands - uTime * 3.0);
  vec3 color = mix(uColorA, uColorB, band);
  // a procedural checker, computed per fragment — no texture involved
  vec2 grid = abs(fract(vUv * 12.0) - 0.5);
  float checker = step(0.25, grid.x) * step(0.25, grid.y);
  color = mix(color, color * 0.35, checker * uChecker);
  // brighten where the surface turns away from the eye
  float rim = pow(1.0 - abs(vNormal.z), 3.0);
  color += rim * uRim;
  // and let the displacement itself tint the crests
  color += vec3(0.15, 0.1, 0.0) * vWave;
  gl_FragColor = vec4(color, 1.0);
}`;

/** A halo of points on a circle — one of the non-triangle drawables. */
const HALO = (() => {
  const out = [];
  for (let i = 0; i < 180; i++) {
    const a = (i / 180) * Math.PI * 2;
    const r = 2.15 + 0.12 * Math.sin(a * 7);
    out.push(Math.cos(a) * r, Math.sin(a) * r, 0);
  }
  return out;
})();

const CUBES = Array.from({ length: 7 }, (_, i) => ({
  position: [(i - 3) * 0.66, -2.15, 0],
  scale: [0.26, 0.26, 0.26],
  rotation: [0.4, i * 0.5, 0],
}));

/** Drives `uTime` off the surface's own frame clock. */
function Clock({ running, onTick }) {
  useFrame((state, delta) => {
    if (running) onTick(delta);
  });
  return null;
}

function Lab({
  palette,
  amplitude,
  frequency,
  bands,
  rim,
  checker,
  halo,
  cubes,
  running,
}) {
  const [time, setTime] = useState(0);
  const colors = PALETTES[palette];
  return (
    <Canvas3D
      style={{ flexGrow: 1 }}
      clearColor="#0a0e18"
      camera={{ position: [0, 0.55, 7.6] }}
    >
      <Clock running={running} onTick={(delta) => setTime((t) => t + delta)} />
      <mesh rotation={[0.5, time * 0.35, 0]}>
        <torusGeometry args={[1.35, 0.5, 40, 96]} />
        <shaderMaterial
          vertexShader={VERTEX}
          fragmentShader={FRAGMENT}
          uniforms={{
            uTime: { value: time },
            uAmplitude: { value: amplitude },
            uFrequency: { value: frequency },
            uBands: { value: bands },
            uRim: { value: rim },
            uChecker: { value: checker ? 1 : 0 },
            uColorA: { value: colors.a },
            uColorB: { value: colors.b },
          }}
        />
      </mesh>

      {halo && (
        <points rotation={[0, 0, time * 0.2]}>
          <bufferGeometry position={HALO} />
          <pointsMaterial color={colors.halo} size={3} />
        </points>
      )}

      {cubes && (
        <instancedMesh instances={CUBES} rotation={[0, time * 0.35, 0]}>
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial color={colors.halo} />
        </instancedMesh>
      )}
    </Canvas3D>
  );
}

function NoShaders() {
  const app = useApp();
  const reason = app._glCapsResolved?.reason;
  return (
    <box style={{ padding: 28, gap: 12, flexDirection: 'column', flexGrow: 1 }}>
      <text style={{ fontSize: 16, fontWeight: 'bold' }}>
        This one needs the GPU
      </text>
      <text style={{ color: '$dim' }}>
        {reason ? `${reason.code}: ${reason.message}` : 'No direct backend.'}
      </text>
      <text style={{ color: '$dim' }}>
        Everything in the panel is GLSL the app wrote, and indirect GLX encodes
        no way to send a shader. Direct rendering wants a local connection to a
        server with DRI3, the x11-dri addon, and Node rather than Bun. See
        docs/gl.md.
      </text>
    </box>
  );
}

/** A labelled slider with its value shown, since a bare track says nothing. */
function Knob({ label, value, min, max, step, format, onChange }) {
  return (
    <box style={{ flexDirection: 'column', gap: 2 }}>
      <box style={{ flexDirection: 'row', alignItems: 'center' }}>
        <text style={{ fontSize: 12 }}>{label}</text>
        <box style={{ flexGrow: 1 }} />
        <text style={{ fontSize: 12, color: '$dim' }}>
          {(format ?? ((v) => v.toFixed(2)))(value)}
        </text>
      </box>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(ev) => onChange(ev.value)}
      />
    </box>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Switch checked={checked} onChange={(ev) => onChange(ev.value)} />
      <text style={{ fontSize: 12 }}>{label}</text>
    </box>
  );
}

function App() {
  const shaders = useSupports('shaders');
  const [palette, setPalette] = useState('ember');
  const [amplitude, setAmplitude] = useState(0.12);
  const [frequency, setFrequency] = useState(4);
  const [bands, setBands] = useState(16);
  const [rim, setRim] = useState(0.45);
  const [checker, setChecker] = useState(true);
  const [halo, setHalo] = useState(true);
  const [cubes, setCubes] = useState(true);
  const [running, setRunning] = useState(true);

  return (
    <window width={860} height={560} title="react-x11 — shader lab">
      <box style={{ flexDirection: 'row', flexGrow: 1 }}>
        {shaders ? (
          <Lab
            palette={palette}
            amplitude={amplitude}
            frequency={frequency}
            bands={bands}
            rim={rim}
            checker={checker}
            halo={halo}
            cubes={cubes}
            running={running}
          />
        ) : (
          <NoShaders />
        )}

        <box
          style={{
            width: 250,
            padding: 16,
            gap: 14,
            flexDirection: 'column',
          }}
        >
          <text style={{ fontSize: 14, fontWeight: 'bold' }}>Shader</text>
          <Knob
            label="Displacement"
            value={amplitude}
            min={0}
            max={0.4}
            step={0.01}
            onChange={setAmplitude}
          />
          <Knob
            label="Ripple frequency"
            value={frequency}
            min={1}
            max={14}
            step={0.5}
            format={(v) => v.toFixed(1)}
            onChange={setFrequency}
          />
          <Knob
            label="Bands"
            value={bands}
            min={2}
            max={48}
            step={1}
            format={(v) => String(v)}
            onChange={setBands}
          />
          <Knob
            label="Rim light"
            value={rim}
            min={0}
            max={1.2}
            step={0.05}
            onChange={setRim}
          />

          <box style={{ flexDirection: 'column', gap: 6 }}>
            <text style={{ fontSize: 12 }}>Palette</text>
            <Select
              value={palette}
              options={Object.keys(PALETTES).map((k) => ({
                value: k,
                label: k,
              }))}
              onChange={(ev) => setPalette(ev.value)}
            />
          </box>

          <text style={{ fontSize: 14, fontWeight: 'bold' }}>Scene</text>
          <Toggle label="Checker" checked={checker} onChange={setChecker} />
          <Toggle label="Point halo" checked={halo} onChange={setHalo} />
          <Toggle label="Instanced cubes" checked={cubes} onChange={setCubes} />

          <box style={{ flexGrow: 1 }} />
          <Button onPress={() => setRunning((r) => !r)}>
            {running ? 'Pause' : 'Play'}
          </Button>
          <text style={{ fontSize: 11, color: '$dim' }}>
            {shaders
              ? 'Every knob is a uniform write — nothing here recompiles.'
              : 'Controls are live; the scene needs direct rendering.'}
          </text>
        </box>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot({ glPolicy: 'auto' });
  root.render(<App />);
}
