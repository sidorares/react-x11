// Entry for the refresh e2e test: an ordinary app entry, run under
// `node --import <src/refresh/register.js>`. Renders against the
// in-process X server (no $DISPLAY). Default/namespace imports only:
// named imports in a hot module initialize in a microtask, and the
// loader's own transform-time guard enforces exactly that.
import React from 'react';
import * as Testing from '../../../src/testing/index.js';
import Refresh from '../../../src/refresh/index.js';
import App from './app.jsx';

Refresh.onReload(({ urls, refreshed }) => {
  console.log(`RELOAD refreshed=${refreshed} count=${urls.length}`);
});

await Testing.renderX11(<App />);
console.log('READY');

// The in-process server rides stream pairs, not OS sockets, so nothing
// here holds the event loop open on its own; the file watcher is
// deliberately non-persistent. Hold the process open for the test.
setInterval(() => {}, 60_000);
