// Drive an example on the cocoa backend headlessly-ish: mount it, let the
// pump run, snapshot every window, exit. For development of the backend —
// not part of the test suite (that gets a cocoa-mock harness backend).
//
//   node --import tsx scripts/cocoa-drive.mjs examples/simple.jsx out.png [ms]
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import React from 'react';

process.env.REACT_X11_NO_AUTORUN = '1';

const [, , exampleFile, outFile = '/tmp/cocoa-drive.png', holdMs = '900'] =
  process.argv;

const { createRoot } = await import('../src/index.js');
const mod = await import(pathToFileURL(path.resolve(exampleFile)).href);
const App = mod.default ?? mod.App;

const root = await createRoot();
root.render(React.createElement(App));

setTimeout(() => {
  let i = 0;
  for (const wnd of root.app._windows.values()) {
    const file = i === 0 ? outFile : outFile.replace(/\.png$/, `-${i}.png`);
    console.log('window', wnd.windowNumber, wnd.width, 'x', wnd.height, '->');
    console.log('  ', file, wnd.snapshot(file));
    i++;
  }
  root.unmount().then(() => process.exit(0));
}, Number(holdMs));
