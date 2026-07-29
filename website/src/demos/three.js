export default {
  id: 'three',
  title: '3D, react-three-fiber shaped',
  description:
    'Inside a Canvas3D the children are scene elements with r3f names: ' +
    '<mesh>, <group>, geometries, materials and lights. On a desktop this ' +
    'draws over indirect GLX — the GL protocol travels the X connection. ' +
    "Here node-x11's GLX emulator replays it onto WebGL2, so it needs a " +
    'browser with WebGL2.',
  code: `import React, { useEffect, useState } from 'react';
import { createRoot, Canvas3D } from 'react-x11';

function Scene() {
  const [t, setT] = useState(0);

  // a plain interval drives the rotation; a scene only redraws when
  // something actually changed, unless you ask for frameLoop="always"
  useEffect(() => {
    const id = setInterval(() => setT((v) => v + 0.03), 33);
    return () => clearInterval(id);
  }, []);

  return (
    <Canvas3D
      style={{ flexGrow: 1 }}
      clearColor="#11161f"
      camera={{ position: [0, 2.2, 6.5], fov: 45 }}
    >
      <ambientLight intensity={0.35} />
      <pointLight position={[5, 6, 6]} />

      <group rotation={[0, t, 0]}>
        <mesh position={[-1.9, 0, 0]} rotation={[0.5, 0.4, 0]}>
          <boxGeometry args={[1.5, 1.5, 1.5]} />
          <meshPhongMaterial color="#2980b9" shininess={60} />
        </mesh>

        <mesh position={[1.9, 0, 0]}>
          <sphereGeometry args={[0.95, 24, 16]} />
          <meshPhongMaterial color="#e67e22" shininess={30} />
        </mesh>

        <mesh position={[0, -1.5, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[7, 7]} />
          <meshLambertMaterial color="#243040" />
        </mesh>
      </group>
    </Canvas3D>
  );
}

function App() {
  return (
    <window x={20} y={20} width={600} height={420} title="three"
            style={{ backgroundColor: '#11161f' }}>
      <Scene />
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
`,
};
