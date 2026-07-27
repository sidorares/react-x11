// A react-three-fiber-shaped scene over indirect GLX: <Canvas3D> with
// <mesh>, geometries and materials. Each geometry is compiled into a
// server-side display list once — a frame is matrices plus one CallList per
// mesh, whatever the triangle count.
//
// Run with: npm run examples:three  (needs an X server with indirect GLX)
import React, { useEffect, useRef, useState } from 'react';

import { Button, Canvas3D, Switch } from '../src/components/index.js';
import { createRoot } from '../src/index.js';

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

function App() {
  const windowRef = useRef(null);
  const [running, setRunning] = useState(true);
  const [wireframe, setWireframe] = useState(false);
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
      <box flexGrow={1} padding={12} gap={12} backgroundColor="#f4f6f8">
        <Canvas3D
          flexGrow={1}
          clearColor="#12161f"
          glx={{ DEPTH_SIZE: 24 }}
          camera={{ position: [0, 2.6, 8.5], target: [0, -0.2, 0], fov: 45 }}
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

        <box flexDirection="row" alignItems="center" gap={12}>
          <Switch checked={running} onChange={setRunning} />
          <text fontSize={13}>Spin</text>
          <Switch checked={wireframe} onChange={setWireframe} />
          <text fontSize={13}>Wireframe</text>
          <box flexGrow={1} />
          <text fontSize={13} color="#5b6570">
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
