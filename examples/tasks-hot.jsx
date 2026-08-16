// Hot-reloading entry for the tasks example. Run with:
//
//   npm run examples:tasks:hot
//
// (which is `node --enable-source-maps --import react-x11/refresh/register
// examples/tasks-hot.jsx`) then edit examples/tasks.jsx and watch the
// window update in place. The X11 connection, the mounted window, and
// component state — the task list, even half-typed text in the input —
// all survive a reload:
//
//  - the renderer and react-refresh stay outside the hot graph, so the
//    root — and its X11 connection — is created exactly once;
//  - components are Fast Refresh-instrumented by the loader: a module
//    whose exports are all components is a refresh boundary, edits to it
//    re-render in place with hook state intact, and a component whose
//    hook signature changed remounts alone. No accept handlers to write —
//    the loader injects the wiring into every hot module.
//
// This entry is an ordinary react-x11 app; the one refresh-specific line
// is the optional onReload subscription. Identity that must survive a
// reload (contexts, stores) lives in its own untouched module
// (examples/tasks-context.js).
import React from 'react';
import ReactX11 from '../src/index.js';
import Refresh from '../src/refresh/index.js';
import App from './tasks.jsx';

const root = await ReactX11.createRoot();
root.render(<App />);

Refresh.onReload(({ urls, refreshed }) => {
  console.log(
    `[refresh] ${urls.length} module(s) reloaded${refreshed ? '' : ', nothing to re-render'}`,
  );
});
