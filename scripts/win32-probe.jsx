// A hand probe for the win32 backend: renders a tree, posts synthetic input
// into the real window procedure, and reports what reached React.
//
// It is here rather than in test/ because it needs a live desktop — the
// bridge, an HWND and DWM — which is the same reason scripts/ holds the a11y,
// scale and xi2 probes. The headless half of this backend belongs in
// test/win32/ against a fake bridge, as the Cocoa and Wayland suites do.
//
//   node --import tsx scripts/win32-probe.jsx
import React from 'react';

import { createRoot } from '../src/index.js';

let clicks = 0;
let hovers = 0;
let resolved;
const done = new Promise((r) => {
  resolved = r;
});

function App() {
  const [on, setOn] = React.useState(false);
  return (
    <window width={300} height={200} title="win32-probe">
      <box style={{ flexGrow: 1, padding: 20, backgroundColor: '#202030' }}>
        <box
          style={{
            width: 160,
            height: 60,
            backgroundColor: on ? '#2ecc71' : '#c0392b',
            borderRadius: 8,
            justifyContent: 'center',
            alignItems: 'center',
          }}
          onClick={() => {
            clicks++;
            setOn((v) => !v);
          }}
          onMouseEnter={() => {
            hovers++;
          }}
        >
          <text style={{ color: '#ffffff', fontSize: 16 }}>
            {on ? 'clicked' : 'click me'}
          </text>
        </box>
      </box>
    </window>
  );
}

const root = await createRoot({ backend: 'win32' });
root.render(<App />);

// Let the window come up and paint, then aim at the middle of the box: the
// padding is 20 and the box is 160x60, so (100, 50) is inside it.
setTimeout(() => {
  const app = root.app ?? root._app;
  const native = app._native;
  const wnd = app._windows.values().next().value;
  const post = (kind, x, y) => native.postMouseEvent(wnd.id, kind, x, y);

  post('move', 100, 50);
  setTimeout(() => {
    post('down', 100, 50);
    setTimeout(() => {
      post('up', 100, 50);
      setTimeout(() => {
        console.log(`hovers=${hovers} clicks=${clicks}`);
        console.log(
          clicks > 0
            ? 'ok: synthetic input reached a React handler'
            : 'FAILED: the click never reached the tree',
        );
        resolved();
      }, 400);
    }, 120);
  }, 200);
}, 1500);

await done;
process.exit(clicks > 0 ? 0 : 1);
