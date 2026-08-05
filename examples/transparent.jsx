// Rounded popups, via a 32-bit ARGB visual: `<popup transparent>` gives the
// window an alpha channel, `borderRadius` rounds the background painted into
// it, and the compositor blends what is left — antialiased corners with the
// desktop showing through, and no Shape extension anywhere.
//
// Needs a running compositor (Mutter, KWin, picom, …). Without one X shows
// the raw pixels and the corners come out black instead of transparent; on a
// display with no 32-bit visual the popup is created opaque and square.
//
// Run with: npm run examples:transparent  (needs an X server / DISPLAY)
import React, { useRef, useState } from 'react';
import { createRoot, useAnchor } from '../src/index.js';

const CARD = 240;

function App() {
  const [open, setOpen] = useState(null);
  const buttonRef = useRef(null);
  const measure = useAnchor(buttonRef);

  const toggle = () =>
    setOpen((at) => (at ? null : measure({ width: CARD, height: 132 })));

  return (
    <window
      width={420}
      height={260}
      title="transparent popups"
      style={{ backgroundColor: '#101014' }}
    >
      <box
        style={{
          flexGrow: 1,
          justifyContent: 'center',
          alignItems: 'center',
          gap: 14,
          padding: 24,
        }}
      >
        <text style={{ fontSize: 20, color: '#f0f0f4' }}>
          Rounded, translucent, composited
        </text>
        <text style={{ fontSize: 13, color: '#8a8a99' }}>
          the popup below has a real alpha channel
        </text>
        <box
          ref={buttonRef}
          onClick={toggle}
          style={{
            backgroundColor: open ? '#3b82f6' : '#26262e',
            borderRadius: 8,
            paddingTop: 9,
            paddingBottom: 9,
            paddingLeft: 18,
            paddingRight: 18,
          }}
        >
          <text style={{ color: '#f0f0f4' }}>
            {open ? 'Close' : 'Open popup'}
          </text>
        </box>
      </box>

      {open && (
        <popup
          transparent
          grab
          x={open.x}
          y={open.y}
          width={CARD}
          height={132}
          onDismiss={() => setOpen(null)}
          // Opaque and square is the base; translucent and rounded is the
          // enhancement, and `@supports transparency` is what gates it. On a
          // server with no 32-bit visual, or with nothing compositing, the
          // block does not apply and the popup is an ordinary opaque one —
          // where painting the corners away would have shown black.
          style={{
            backgroundColor: '#181820',
            '@supports transparency': {
              backgroundColor: 'rgba(24, 24, 30, 0.86)',
              borderRadius: 14,
            },
          }}
        >
          <box
            style={{
              flexGrow: 1,
              padding: 16,
              gap: 10,
              justifyContent: 'center',
            }}
          >
            <text style={{ fontSize: 15, color: '#f0f0f4' }}>
              No Shape extension
            </text>
            <text style={{ fontSize: 12, color: '#9a9aa8' }}>
              The corners are antialiased because they are alpha, not a 1-bit
              mask.
            </text>
            <box style={{ flexDirection: 'row', gap: 8 }}>
              {['#ef4444', '#22c55e', '#3b82f6', '#facc15'].map((color) => (
                <box
                  key={color}
                  style={{
                    width: 30,
                    height: 20,
                    backgroundColor: color,
                    borderRadius: 5,
                  }}
                />
              ))}
            </box>
          </box>
        </popup>
      )}
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
