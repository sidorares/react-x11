// Hello world: flex layout + text, no manual pixel math.
// Run with: npm run examples:simple  (needs an X server / DISPLAY)
import React from 'react';
import { createRoot } from '../src/index.js';

function App() {
  return (
    <window
      width={320}
      height={200}
      title="react-x11"
      style={{ backgroundColor: '#f4f4f4' }}
    >
      <box
        style={{
          flexGrow: 1,
          justifyContent: 'center',
          alignItems: 'center',
          gap: 12,
          padding: 16,
        }}
      >
        <text style={{ fontSize: 24, color: '#222' }}>
          Hello, <text style={{ color: '#c0392b' }}>X11</text>!
        </text>
        <box
          style={{ backgroundColor: '#3498db', borderRadius: 6, padding: 10 }}
        >
          <text style={{ color: 'white' }}>flexbox via yoga-layout</text>
        </box>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
