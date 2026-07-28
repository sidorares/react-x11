// xeyes, the react-x11 way: flex layout (zero manual layout math), the
// <canvas> escape hatch for custom drawing, and hooks for state + polling.
// Run with: npm run examples:xeyes  (needs an X server / DISPLAY)
import React, { useEffect, useState } from 'react';
import { createRoot } from '../src/index.js';

function Eye({ lookingAt }) {
  return (
    <canvas
      onDraw={(ctx, { width, height, node }) => {
        const cx = width / 2;
        const cy = height / 2;
        const rx = cx - 4;
        const ry = cy - 4;

        // lookingAt is in root (screen) coordinates; convert to eye-local
        const win = node.root.window;
        const dx = lookingAt.x - (win.x ?? 0) - node.abs.x - cx;
        const dy = lookingAt.y - (win.y ?? 0) - node.abs.y - cy;

        // sclera
        ctx.fillStyle = 'white';
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // pupil: aim at the pointer, clamped inside the sclera
        const pr = Math.min(rx, ry) * 0.35;
        const reachX = Math.max(1, rx - pr - 4);
        const reachY = Math.max(1, ry - pr - 4);
        const nx = dx / reachX;
        const ny = dy / reachY;
        const overshoot = Math.hypot(nx, ny);
        const s = overshoot > 1 ? 1 / overshoot : 1;
        ctx.fillStyle = 'black';
        ctx.beginPath();
        ctx.ellipse(
          cx + nx * s * reachX,
          cy + ny * s * reachY,
          pr,
          pr,
          0,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }}
      style={{ flexGrow: 1 }}
    />
  );
}

function App({ app }) {
  const [lookingAt, setLookingAt] = useState({ x: 0, y: 0 });

  // While the pointer is outside the window we get no motion events; poll.
  useEffect(() => {
    if (!app) return undefined;
    const id = setInterval(() => {
      app.rootWindow().queryPointer((err, pointer) => {
        if (!err) setLookingAt({ x: pointer.childX, y: pointer.childY });
      });
    }, 100);
    return () => clearInterval(id);
  }, [app]);

  return (
    <window
      width={240}
      height={120}
      title="xeyes"
      onMouseMove={(ev) =>
        setLookingAt({ x: ev.nativeEvent.rootx, y: ev.nativeEvent.rooty })
      }
    >
      <box style={{ flexDirection: 'row', flexGrow: 1 }}>
        <Eye lookingAt={lookingAt} />
        <Eye lookingAt={lookingAt} />
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App app={root.app} />);
}
