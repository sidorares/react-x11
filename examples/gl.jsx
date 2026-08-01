// <glarea>: an OpenGL surface in the flex layout, with 2D widgets around it.
// The cube is compiled into a server-side display list once and replayed
// with one CallList per frame — immediate-mode vertices would be ~50
// commands on the wire every frame instead.
//
// Run with: npm run examples:gl  (needs an X server with indirect GLX)
import React, { useState } from 'react';

import { Button, Switch } from '../src/components/index.js';
import { createRoot } from '../src/index.js';

const CUBE_LIST = 1;

// (x, y, z) corners of a unit cube, per face, with a face colour each
const FACES = [
  {
    color: [0.16, 0.5, 0.73],
    v: [
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ],
  },
  {
    color: [0.12, 0.4, 0.6],
    v: [
      [-1, -1, -1],
      [-1, 1, -1],
      [1, 1, -1],
      [1, -1, -1],
    ],
  },
  {
    color: [0.9, 0.49, 0.13],
    v: [
      [-1, 1, -1],
      [-1, 1, 1],
      [1, 1, 1],
      [1, 1, -1],
    ],
  },
  {
    color: [0.75, 0.4, 0.1],
    v: [
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
      [-1, -1, 1],
    ],
  },
  {
    color: [0.15, 0.68, 0.38],
    v: [
      [1, -1, -1],
      [1, 1, -1],
      [1, 1, 1],
      [1, -1, 1],
    ],
  },
  {
    color: [0.11, 0.55, 0.3],
    v: [
      [-1, -1, -1],
      [-1, -1, 1],
      [-1, 1, 1],
      [-1, 1, -1],
    ],
  },
];

function compileCube(gl) {
  gl.NewList(CUBE_LIST, gl.COMPILE);
  gl.Begin(gl.QUADS);
  for (const face of FACES) {
    gl.Color3f(...face.color);
    for (const [x, y, z] of face.v) gl.Vertex3f(x, y, z);
  }
  gl.End();
  gl.EndList();
}

function Scene({ spinning }) {
  const [angle, setAngle] = useState(25);

  return (
    <glarea
      clearColor="#12161f"
      glx={{ DEPTH_SIZE: 24 }}
      frameLoop={spinning ? 'always' : 'demand'}
      onCreated={(gl) => {
        gl.Enable(gl.DEPTH_TEST);
        compileCube(gl);
      }}
      onDraw={(gl, { width, height }) => {
        const aspect = height / Math.max(1, width);
        gl.MatrixMode(gl.PROJECTION);
        gl.LoadIdentity();
        gl.Frustum(-1, 1, -aspect, aspect, 2.5, 20);
        gl.MatrixMode(gl.MODELVIEW);
        gl.LoadIdentity();
        gl.Translatef(0, 0, -9);
        gl.Rotatef(angle * 0.7, 1, 0, 0);
        gl.Rotatef(angle, 0, 1, 0);
        gl.CallList(CUBE_LIST);
        if (spinning) setAngle((a) => a + 1.5);
      }}
      style={{ flexGrow: 1 }}
    />
  );
}

function App() {
  const [spinning, setSpinning] = useState(true);

  return (
    <window width={520} height={400} title="react-x11 — <glarea>">
      <box
        style={{
          flexGrow: 1,
          padding: 12,
          gap: 12,
          backgroundColor: '#f4f6f8',
        }}
      >
        <Scene spinning={spinning} />
        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Switch checked={spinning} onChange={(ev) => setSpinning(ev.value)} />
          <text style={{ fontSize: 13 }}>Spin</text>
          <box style={{ flexGrow: 1 }} />
          <Button onPress={() => setSpinning((s) => !s)}>
            {spinning ? 'Pause' : 'Play'}
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
