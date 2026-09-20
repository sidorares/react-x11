// xeyes, the react-x11 way: flex layout (zero manual layout math), the
// <canvas> escape hatch for custom drawing, and hooks for state + polling.
// Run with: npm run examples:xeyes
//
// Runs on every backend. Following the pointer *outside* the window needs
// X11's root-window query and is asked for by capability, not assumed — see
// `canQueryRoot` below, which is the shape any example that wants one
// backend's extra should have.
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

  // While the pointer is outside the window there are no motion events, so
  // the eyes would freeze at the edge. Polling the *root* window is how the
  // original xeyes follows a pointer that has left: it asks the server where
  // the pointer is, whoever it is over.
  //
  // That is an X11 question and nothing else has it — there is no
  // cross-application pointer position on Wayland by design, and none is
  // bound on the Windows backend. So it is asked for by capability rather
  // than assumed: where `rootWindow()` exists the eyes follow the pointer
  // across the whole screen, and everywhere else they follow it inside this
  // window, through `onMouseMove` below, which every backend sends.
  const canQueryRoot = typeof app?.rootWindow === 'function';
  useEffect(() => {
    if (!canQueryRoot) return undefined;
    const id = setInterval(() => {
      app.rootWindow().queryPointer((err, pointer) => {
        if (!err) setLookingAt({ x: pointer.childX, y: pointer.childY });
      });
    }, 100);
    return () => clearInterval(id);
  }, [app, canQueryRoot]);

  useEffect(() => {
    if (canQueryRoot) return;
    console.log(
      'xeyes: this backend has no root-window pointer query (X11 only), so the\n' +
        '       eyes follow the pointer while it is over this window and rest when\n' +
        '       it leaves. Run it under X11 to see them track across the screen.',
    );
  }, [canQueryRoot]);

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
