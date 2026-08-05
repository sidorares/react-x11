// A react-three-fiber-shaped scene over indirect GLX: <Canvas3D> with
// <mesh>, geometries and materials. Each geometry is compiled into a
// server-side display list once — a frame is matrices plus one CallList per
// mesh, whatever the triangle count.
//
// Run with: npm run examples:three  (needs an X server with indirect GLX)
import React, { useEffect, useRef, useState } from 'react';

import { Image } from 'ntk';

import { Button, Canvas3D, Switch } from '../src/components/index.js';
import { createRoot } from '../src/index.js';

/** A procedural checker, uploaded to the server once and bound per frame. */
function checkerTexture(size = 64, squares = 8) {
  const data = Buffer.alloc(size * size * 4);
  const step = size / squares;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dark = (Math.floor(x / step) + Math.floor(y / step)) % 2 === 0;
      const i = (y * size + x) * 4;
      data[i] = dark ? 0x20 : 0xf2;
      data[i + 1] = dark ? 0x30 : 0xf6;
      data[i + 2] = dark ? 0x45 : 0xf8;
      data[i + 3] = 255;
    }
  }
  return new Image({ width: size, height: size, data });
}

const CHECKER = checkerTexture();

/** Advance a value every frame while `running`, via the window frame clock. */
function useSpin(running, windowRef) {
  const [angle, setAngle] = useState(0.6);
  const frame = useRef(0);
  useEffect(() => {
    const wnd = windowRef.current;
    if (!running || !wnd?.requestAnimationFrame) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      setAngle((a) => a + 0.02);
      frame.current = wnd.requestAnimationFrame(tick);
    };
    frame.current = wnd.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      wnd.cancelAnimationFrame?.(frame.current);
    };
  }, [running, windowRef]);
  return angle;
}

/**
 * Shown in place of the surface when the X server cannot give us a GL
 * context — which is the default on Xwayland and on Xorg without `+iglx`,
 * so most people run this example and land here first. The error carries a
 * `code` to branch on and a `hint` explaining how to get a server that works.
 */
function NoGL({ error }) {
  const disabled = error.code === 'GLX_INDIRECT_DISABLED';
  return (
    <box
      style={{
        flexGrow: 1,
        padding: 20,
        gap: 10,
        justifyContent: 'center',
        backgroundColor: '#12161f',
      }}
    >
      <text style={{ fontSize: 15, color: '#e8ecf1' }}>
        {disabled ? 'This X server has no indirect GLX' : 'No GL surface'}
      </text>
      <text style={{ fontSize: 12, color: '#9aa7b4' }}>{error.message}</text>
      {error.hint ? (
        <text style={{ fontSize: 11, color: '#6f7d8c' }}>{error.hint}</text>
      ) : null}
    </box>
  );
}

function App() {
  const windowRef = useRef(null);
  const [running, setRunning] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [textured, setTextured] = useState(true);
  const [hovered, setHovered] = useState(null);
  const [picked, setPicked] = useState(null);
  const angle = useSpin(running, windowRef);

  // pointer props shared by every mesh: hover highlight and click to pick,
  // both resolved by raycasting against the geometry on the client
  const pointer = (name) => ({
    cursor: 'pointer',
    onPointerOver: () => setHovered(name),
    onPointerOut: () => setHovered((h) => (h === name ? null : h)),
    onClick: () => setPicked((p) => (p === name ? null : name)),
  });
  const lift = (name) => (hovered === name ? 1.12 : 1);
  const tint = (name, color) => (picked === name ? '#f1c40f' : color);

  return (
    <window ref={windowRef} width={560} height={460} title="react-x11 — 3D">
      <box
        style={{
          flexGrow: 1,
          padding: 12,
          gap: 12,
          backgroundColor: '$surfaceHover',
        }}
      >
        <Canvas3D
          clearColor="#12161f"
          glx={{ DEPTH_SIZE: 24 }}
          camera={{ position: [0, 2.6, 8.5], target: [0, -0.2, 0], fov: 45 }}
          style={{ flexGrow: 1 }}
          fallback={(err) => <NoGL error={err} />}
        >
          <ambientLight intensity={0.35} />
          <pointLight position={[5, 6, 6]} intensity={1} />
          <directionalLight
            position={[-6, 2, 3]}
            intensity={0.4}
            color="#9ecbff"
          />

          <group rotation={[0, angle, 0]}>
            <mesh
              position={[-1.6, 0, 0]}
              rotation={[0.5, 0.4, 0]}
              scale={lift('box')}
              {...pointer('box')}
            >
              <boxGeometry args={[1.4, 1.4, 1.4]} />
              <meshPhongMaterial
                color={tint('box', '#2980b9')}
                map={textured ? CHECKER : undefined}
                shininess={60}
                wireframe={wireframe}
              />
            </mesh>
            <mesh
              position={[1.6, 0, 0]}
              scale={lift('ball')}
              {...pointer('ball')}
            >
              <sphereGeometry args={[0.9, 24, 16]} />
              <meshPhongMaterial
                color={tint('ball', '#e67e22')}
                shininess={12}
                wireframe={wireframe}
              />
            </mesh>
            <mesh
              position={[0, -1.4, 0]}
              rotation={[Math.PI / 2, 0, 0]}
              scale={lift('ring')}
              {...pointer('ring')}
            >
              <torusGeometry args={[1.1, 0.28, 12, 36]} />
              <meshLambertMaterial
                color={tint('ring', '#27ae60')}
                wireframe={wireframe}
              />
            </mesh>
          </group>
        </Canvas3D>

        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Switch checked={running} onChange={(ev) => setRunning(ev.value)} />
          <text style={{ fontSize: 13 }}>Spin</text>
          <Switch
            checked={wireframe}
            onChange={(ev) => setWireframe(ev.value)}
          />
          <text style={{ fontSize: 13 }}>Wireframe</text>
          <Switch checked={textured} onChange={(ev) => setTextured(ev.value)} />
          <text style={{ fontSize: 13 }}>Texture</text>
          <box style={{ flexGrow: 1 }} />
          <text style={{ fontSize: 13, color: '$dim' }}>
            {picked ? `picked: ${picked}` : 'click a shape'}
          </text>
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
  const root = await createRoot();
  root.render(<App />);
}
