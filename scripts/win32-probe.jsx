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

import { systemAppearance } from '../src/appearance.js';
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

{
  const app = root.app ?? root._app;
  const resolved = await systemAppearance();
  console.log('appearance :', {
    source: resolved.source,
    colorScheme: resolved.colorScheme,
    accent: resolved.accent,
    contrast: resolved.contrast,
    reducedMotion: resolved.reducedMotion,
  });
  console.log('bezels     :', app.nativeBezels ? 'native' : 'drawn');
  console.log(
    'screens    :',
    app._screens.map((s) => `${s.width}x${s.height}@${s.scale}`).join(', '),
  );
  console.log('eyedropper :', app.screenColorAt(0, 0));

  // The capability seams each ladder looks for. Absent is a real answer — it
  // is how a feature reports that this backend has no rung for it — so what
  // matters is that the ones that *are* built are found by name.
  const seams = [
    'createStatusItem',
    'filePanels',
    'setDockBadge',
    'setTaskbarProgress',
    'requestAttention',
    'nativeBezels',
    'systemAppearance',
    'screenColorAt',
    'chooseGLConfig',
  ];
  console.log(
    'seams      :',
    seams.map((s) => `${s}=${app[s] == null ? 'no' : 'yes'}`).join(' '),
  );

  // What a length written by an app becomes by the time it reaches the text
  // engine. `fontSize` is in SCALED_LENGTH_PROPS, so a 16 authored in a style
  // should arrive here as 16 * scale device pixels — and the glyphs should be
  // that tall on the surface, because the surface is device pixels too.
  const scale = app.scale;
  for (const authored of [12, 16, 24]) {
    const device = authored * scale;
    // `size`, not `fontSize`: a span speaks ntk's vocabulary, and asking with
    // the CSS name here would measure the default and report it as the answer.
    const at = (size) => app.fonts.layout([{ text: 'Hxy', size }], { size });
    console.log(
      `text       : authored ${authored} -> device ${device} ` +
        `=> layout ${Math.round(at(device).height)}px tall ` +
        `(unscaled would be ${Math.round(at(authored).height)}px)`,
    );
  }
}

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
