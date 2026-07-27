// Hot-reloading entry for the tasks example. Run with:
//
//   npm run examples:tasks:hot
//
// then edit examples/tasks.jsx and watch the window update in place.
// The X11 connection, the mounted window, and component state — the task
// list, even half-typed text in the input — all survive a reload:
//
//  - the renderer (src/) is outside the hot graph (see hmr-register.mjs),
//    so the root — and its X11 connection — is created exactly once;
//  - components are Fast Refresh-instrumented (react-refresh): on accept,
//    performReactRefresh() re-renders the edited components in place,
//    preserving hook state wherever the edit keeps a component's hook
//    signature unchanged — a changed signature remounts only that
//    component. hmr-refresh.js must be the first import (see there).
import { performReactRefresh } from './hmr-refresh.js';
import React from 'react';
import ReactX11 from '../src/index.js';
import App from './tasks.jsx';

const root = await ReactX11.createRoot();
root.render(<App />);

if (import.meta.hot) {
  import.meta.hot.accept('./tasks.jsx', () => {
    console.log('[hmr] tasks.jsx updated — refreshing');
    performReactRefresh();
  });
}
