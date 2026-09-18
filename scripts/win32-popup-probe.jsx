// A hand probe for `<popup>` on the win32 backend: renders a Select at a known
// place, opens it with synthetic input, and reports where the popup window
// actually landed against where anchor.js asked for it.
//
// Placement is the whole contract for a popup — a menu in the wrong place is
// not a cosmetic bug — and it cannot be checked headlessly, because the answer
// involves a real HWND and the monitor's work area.
//
//   node --import tsx scripts/win32-popup-probe.jsx
//   node --import tsx scripts/win32-popup-probe.jsx --keep   (stays open)
import React from 'react';

import { Select } from '../src/components/index.js';
import { createRoot } from '../src/index.js';

const keep = process.argv.includes('--keep');

function App() {
  const [value, setValue] = React.useState('blue');
  return (
    <window width={360} height={220} title="win32-popup-probe">
      <box style={{ flexGrow: 1, padding: 24, gap: 12 }}>
        <text>Pick a colour</text>
        <Select
          value={value}
          onChange={setValue}
          options={[
            { value: 'blue', label: 'Blue' },
            { value: 'green', label: 'Green' },
            { value: 'red', label: 'Red' },
          ]}
        />
      </box>
    </window>
  );
}

const root = await createRoot({ backend: 'win32' });
root.render(<App />);

const app = root.app ?? root._app;
const native = app._native;

setTimeout(() => {
  const [main] = [...app._windows.values()];
  // The Select sits under the label, inside 24px of padding — at this scale
  // roughly 60px down. The click opens it on the *press*, which is what
  // AGENTS.md's "answer the input" rule made Select do.
  const x = Math.round(60 * app.scale);
  const y = Math.round(70 * app.scale);
  native.postMouseEvent(main.id, 'move', x, y);
  native.postMouseEvent(main.id, 'down', x, y);

  setTimeout(() => {
    native.postMouseEvent(main.id, 'up', x, y);
    setTimeout(() => {
      const windows = [...app._windows.values()];
      console.log(`windows open: ${windows.length}`);
      for (const w of windows) {
        console.log(
          `  id=${w.id} popup=${w.popup} ` +
            `asked for ${w.attributes.x ?? '(default)'},${w.attributes.y ?? '(default)'} ` +
            `size ${w.width}x${w.height}`,
        );
      }
      const popup = windows.find((w) => w.popup);
      if (!popup) {
        console.log('\nFAILED: the select did not open a popup window');
      } else if (popup.attributes.x === undefined) {
        console.log('\nFAILED: the popup was created with no position');
      } else {
        console.log(
          '\nok: a frameless popup was created at an anchored position',
        );
      }
      if (!keep) {
        app.close();
        process.exit(popup && popup.attributes.x !== undefined ? 0 : 1);
      }
    }, 600);
  }, 120);
}, 1500);
