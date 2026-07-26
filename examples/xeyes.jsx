// xeyes, the react-x11 way: flex layout (zero manual layout math), the
// <canvas> escape hatch for custom drawing, and hooks for state + polling.
// Run with: npm run examples:xeyes  (needs an X server / DISPLAY)
import React, { useEffect, useState } from 'react';
import { createRoot } from '../src/index.js';

function Eye({ color, lookingAt }) {
  return (
    <canvas
      flexGrow={1}
      onDraw={(ctx, { width, height, node }) => {
        // lookingAt is in root (screen) coordinates; convert to eye-local
        const win = node.root.window;
        const px = lookingAt.x - win.x - node.abs.x - width / 2;
        const py = lookingAt.y - win.y - node.abs.y - height / 2;

        ctx.fillStyle = color;
        ctx.fillRect(0, 0, width, height);
        const gradient = ctx.createRadialGradient(
          px + width / 2,
          py + height / 2,
          0,
          width / 2,
          height / 2,
          width / 2,
        );
        gradient.addColorStop(0, color);
        gradient.addColorStop(0.5, color);
        gradient.addColorStop(0.505, 'white');
        gradient.addColorStop(0.995, 'white');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
      }}
    />
  );
}

function App({ app }) {
  const [lookingAt, setLookingAt] = useState({ x: 0, y: 0 });

  // While the pointer is outside the window we get no motion events; poll.
  useEffect(() => {
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
      <box flexDirection="row" flexGrow={1}>
        <Eye color="green" lookingAt={lookingAt} />
        <Eye color="blue" lookingAt={lookingAt} />
      </box>
    </window>
  );
}

const root = await createRoot();
root.render(<App app={root.app} />);
