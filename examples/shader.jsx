// GLSL in the scene graph: <shaderMaterial> on the direct backend, where the
// pipeline is OpenGL ES 2 on the GPU rather than fixed-function commands on
// the wire. The uniforms animate every frame, which costs one uniform write —
// programs are cached by source, so nothing recompiles.
//
// Run with: npm run examples:shader
//
// Needs direct rendering: a local connection to a Linux X server with DRI3
// (Xorg with glamor, or Xwayland — most desktops) and ntk's optional x11-dri
// addon. Without it the fallback below says so. See docs/gl.md.
import React, { useEffect, useRef, useState } from 'react';

import { Button, Canvas3D } from '../src/components/index.js';
import { createRoot } from '../src/index.js';

// three.js's names are declared for you: position/normal/uv and the matrices,
// so this is the same shader you would write against react-three-fiber.
const VERTEX = `
varying vec2 vUv;
varying vec3 vNormal;
uniform float uTime;
void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  // push the surface along its own normal, in a wave that travels
  vec3 displaced = position + normal * 0.08 * sin(uTime * 2.0 + position.y * 6.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}`;

const FRAGMENT = `
precision mediump float;
varying vec2 vUv;
varying vec3 vNormal;
uniform float uTime;
uniform vec3 uColorA;
uniform vec3 uColorB;
void main() {
  // a band that sweeps around the surface, tinted by how much the surface
  // faces the eye — the sort of thing no fixed-function pipeline can express
  float band = 0.5 + 0.5 * sin(vUv.y * 18.0 - uTime * 3.0);
  float rim = pow(1.0 - abs(vNormal.z), 2.0);
  vec3 color = mix(uColorA, uColorB, band) + rim * 0.5;
  gl_FragColor = vec4(color, 1.0);
}`;

/** A value that advances on the window's frame clock while `running`. */
function useClock(running, windowRef) {
  const [time, setTime] = useState(0);
  const frame = useRef(0);
  useEffect(() => {
    const wnd = windowRef.current;
    if (!running || !wnd?.requestAnimationFrame) return;
    let cancelled = false;
    const started = Date.now();
    const tick = () => {
      if (cancelled) return;
      setTime((Date.now() - started) / 1000);
      frame.current = wnd.requestAnimationFrame(tick);
    };
    frame.current = wnd.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
    };
  }, [running, windowRef]);
  return time;
}

function NoDirect(err) {
  return (
    <box style={{ padding: 24, gap: 10, flexDirection: 'column' }}>
      <text style={{ fontSize: 15, fontWeight: 'bold' }}>
        No direct rendering on this display
      </text>
      <text style={{ color: '$dim' }}>{err?.message ?? String(err)}</text>
      <text style={{ color: '$dim' }}>
        Shaders need the GPU backend. It wants a local connection to a server
        with DRI3 and the x11-dri addon — see docs/gl.md.
      </text>
    </box>
  );
}

function App() {
  const windowRef = useRef(null);
  const [running, setRunning] = useState(true);
  const [warm, setWarm] = useState(true);
  const time = useClock(running, windowRef);

  return (
    <window
      ref={windowRef}
      width={640}
      height={480}
      title="react-x11 — shaders"
    >
      <box style={{ flexDirection: 'column', flexGrow: 1 }}>
        <Canvas3D
          style={{ flexGrow: 1 }}
          clearColor="#0b1021"
          camera={{ position: [0, 0, 3.4] }}
          fallback={NoDirect}
        >
          <mesh rotation={[0.4, time * 0.4, 0]}>
            <torusGeometry args={[1, 0.38, 24, 64]} />
            <shaderMaterial
              vertexShader={VERTEX}
              fragmentShader={FRAGMENT}
              uniforms={{
                uTime: { value: time },
                uColorA: { value: warm ? [0.85, 0.2, 0.35] : [0.1, 0.3, 0.7] },
                uColorB: { value: warm ? [0.95, 0.7, 0.2] : [0.2, 0.8, 0.75] },
              }}
            />
          </mesh>
        </Canvas3D>
        <box
          style={{
            flexDirection: 'row',
            gap: 10,
            padding: 10,
            alignItems: 'center',
          }}
        >
          <text style={{ fontSize: 13 }}>t = {time.toFixed(1)}s</text>
          <box style={{ flexGrow: 1 }} />
          <Button onPress={() => setWarm((w) => !w)}>
            {warm ? 'Cool' : 'Warm'}
          </Button>
          <Button onPress={() => setRunning((r) => !r)}>
            {running ? 'Pause' : 'Play'}
          </Button>
        </box>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  // 'auto' is direct where it is available and indirect otherwise; this scene
  // needs the former, and the fallback explains itself where there is none
  const root = await createRoot({ glPolicy: 'auto' });
  root.render(<App />);
}
