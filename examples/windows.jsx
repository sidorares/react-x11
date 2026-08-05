// Multiple top-level X11 windows from one React tree: open and close real
// windows with state/JSX (each <window> at the root is its own WM-managed
// window), share state across all of them, and handle the WM close button
// declaratively via onCloseRequest (WM_DELETE_WINDOW).
// Run with: npm run examples:windows  (needs an X server / DISPLAY)
import React, { useRef, useState } from 'react';
import { Button, createRoot } from '../src/index.js';

const PALETTE = ['#eaf2f8', '#e8f8f5', '#fef9e7', '#f9ebea', '#f4ecf7'];

function Satellite({ id, index, clicks, onClick, onClose }) {
  return (
    <window
      width={230}
      height={150}
      x={420 + index * 44}
      y={120 + index * 44}
      title={`satellite #${id}`}
      onCloseRequest={onClose}
      style={{ backgroundColor: PALETTE[id % PALETTE.length] }}
    >
      <box
        style={{ flexGrow: 1, padding: 14, gap: 10, alignItems: 'flex-start' }}
      >
        <text style={{ color: '$text' }}>{`I am window #${id}.`}</text>
        <text
          style={{ color: '$dim' }}
        >{`${clicks} clicks — in every window`}</text>
        <box style={{ flexDirection: 'row', gap: 8 }}>
          <Button primary onPress={onClick}>
            +1
          </Button>
          <Button onPress={onClose}>Close</Button>
        </box>
      </box>
    </window>
  );
}

function App() {
  const [wins, setWins] = useState([]);
  const [clicks, setClicks] = useState(0);
  const nextId = useRef(1);

  const open = () => setWins((w) => [...w, nextId.current++]);
  const close = (id) => setWins((w) => w.filter((x) => x !== id));

  return (
    <>
      <window
        width={320}
        height={200}
        title="windows"
        onCloseRequest={() => process.exit(0)}
        style={{ backgroundColor: '$surfaceHover' }}
      >
        <box
          style={{
            flexGrow: 1,
            padding: 16,
            gap: 12,
            alignItems: 'flex-start',
          }}
        >
          <text style={{ fontSize: 18, color: '$text' }}>
            One React tree, many windows
          </text>
          <text style={{ color: '$dim' }}>
            {`${wins.length} satellite${wins.length === 1 ? '' : 's'} open, ${clicks} clicks total`}
          </text>
          <Button primary onPress={open}>
            Open a window
          </Button>
        </box>
      </window>
      {wins.map((id, index) => (
        <Satellite
          key={id}
          id={id}
          index={index}
          clicks={clicks}
          onClick={() => setClicks((c) => c + 1)}
          onClose={() => close(id)}
        />
      ))}
    </>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
