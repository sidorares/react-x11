export default {
  id: 'canvas',
  title: 'The canvas escape hatch',
  description:
    "<canvas> hands you ntk's canvas-like 2d context — paths, gradients, " +
    'transforms, clipping — laid out by flexbox like any other element and ' +
    'backed by the X RENDER extension, so the compositing happens in the X ' +
    'server. This is xeyes, tracking the pointer.',
  code: `import React, { useState } from 'react';
import { createRoot } from 'react-x11';

function Eyes() {
  const [pointer, setPointer] = useState({ x: 200, y: 120 });

  const draw = (ctx, { width, height }) => {
    ctx.clearRect(0, 0, width, height);

    const rx = width / 4.4;
    const ry = height / 2.6;

    for (const cx of [width / 2 - rx * 1.15, width / 2 + rx * 1.15]) {
      const cy = height / 2;

      // the white
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#1f2933';
      ctx.stroke();

      // the pupil, clamped inside the white
      const dx = pointer.x - cx;
      const dy = pointer.y - cy;
      const dist = Math.hypot(dx, dy) || 1;
      const reach = Math.min(dist, Math.min(rx, ry) * 0.52);
      ctx.beginPath();
      ctx.ellipse(
        cx + (dx / dist) * reach,
        cy + (dy / dist) * reach,
        rx * 0.32, ry * 0.32, 0, 0, Math.PI * 2
      );
      ctx.fillStyle = '#1f2933';
      ctx.fill();
    }
  };

  return (
    <canvas
      onDraw={draw}
      onMouseMove={(ev) => setPointer({ x: ev.x, y: ev.y })}
      style={{ flexGrow: 1 }}
    />
  );
}

function App() {
  return (
    <window x={60} y={50} width={420} height={280} title="xeyes"
            style={{ backgroundColor: '#dfe7ee', padding: 10 }}>
      <Eyes />
      <text style={{ fontSize: 12, color: '#52606d', alignSelf: 'center' }}>
        move the pointer over the window
      </text>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
`,
};
