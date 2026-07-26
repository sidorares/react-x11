// Context menu via <popup> — an override-redirect X11 window (ntk >= 3.1.0)
// positioned at the pointer. Right-click anywhere to open it; pick an entry
// or left-click elsewhere to close. Shows conditional rendering of a real
// second window, component composition, and screen-coordinate anchoring.
// Run with: npm run examples:menu  (needs an X server / DISPLAY)
import React, { useState } from 'react';
import { createRoot } from '../src/index.js';

const CHOICES = ['Cut', 'Copy', 'Paste', 'Rename…', 'Delete'];
const ITEM_HEIGHT = 28;

function MenuItem({ label, onSelect }) {
  const [hover, setHover] = useState(false);
  return (
    <box
      height={ITEM_HEIGHT}
      cursor="pointer"
      justifyContent="center"
      paddingLeft={12}
      backgroundColor={hover ? '#2980b9' : 'white'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onSelect(label)}
    >
      <text color={hover ? 'white' : '#2d3436'}>{label}</text>
    </box>
  );
}

function ContextMenu({ at, onSelect }) {
  return (
    <popup
      x={at.x}
      y={at.y}
      width={160}
      height={CHOICES.length * ITEM_HEIGHT + 10}
      backgroundColor="white"
    >
      <box
        flexGrow={1}
        padding={4}
        borderWidth={1}
        borderColor="#b2bec3"
        backgroundColor="white"
      >
        {CHOICES.map((label) => (
          <MenuItem key={label} label={label} onSelect={onSelect} />
        ))}
      </box>
    </popup>
  );
}

function App() {
  const [menuAt, setMenuAt] = useState(null);
  const [last, setLast] = useState('(none)');

  return (
    <window
      width={420}
      height={240}
      title="popup menu"
      backgroundColor="#f5f6fa"
      onMouseDown={(ev) => {
        if (ev.button === 3) {
          // anchor at the pointer, in screen coordinates
          setMenuAt({ x: ev.nativeEvent.rootx, y: ev.nativeEvent.rooty });
        } else {
          setMenuAt(null);
        }
      }}
    >
      <box flexGrow={1} justifyContent="center" alignItems="center" gap={8}>
        <text fontSize={18} color="#2d3436">
          Right-click for a menu
        </text>
        <text color="#7f8c8d">
          last choice: <text color="#2980b9">{last}</text>
        </text>
      </box>
      {menuAt && (
        <ContextMenu
          at={menuAt}
          onSelect={(label) => {
            setLast(label);
            setMenuAt(null);
          }}
        />
      )}
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
