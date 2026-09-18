// Does core `<glarea>` work on the win32 backend?
//
// docs/windows.md answers this with ANGLE — EGL and GLES translated to
// Direct3D 11, presenting into a composition swapchain on a child visual, the
// way the Cocoa `<glarea>` is an IOSurface sublayer. Two DLLs to ship, and
// optional the way x11-dri is. This probe says what actually happens today.
import React from 'react';

import { createRoot } from '../src/index.js';

function App() {
  return (
    <window width={320} height={240} title="win32-glarea-probe">
      <box style={{ flexGrow: 1, padding: 12, backgroundColor: '#202030' }}>
        <glarea
          style={{ flexGrow: 1 }}
          onReady={() => console.log('glarea: onReady')}
          onError={(err) =>
            console.log('glarea: onError —', err?.message ?? err)
          }
          onDraw={(gl) => {
            if (!gl) return;
            gl.clearColor(0.1, 0.6, 0.3, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
          }}
        />
      </box>
    </window>
  );
}

const root = await createRoot({ backend: 'win32' });
const app = root.app ?? root._app;

console.log('app.chooseGLConfig  :', typeof app.chooseGLConfig);
console.log('app.chooseGLXConfig :', typeof app.chooseGLXConfig);
console.log('app.glCapabilities  :', typeof app.glCapabilities);

try {
  root.render(<App />);
  console.log('render: returned without throwing');
} catch (err) {
  console.log('render: THREW —', err.message.split('\n')[0]);
}

setTimeout(() => {
  console.log(`windows open: ${app._windows.size}`);
  app.close();
  process.exit(0);
}, 2500);
