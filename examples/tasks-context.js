// The tasks example's dispatch context, in its own module so hot reloads
// of tasks.jsx keep the context identity: this file doesn't change, so it
// is never re-evaluated, and <DispatchContext.Provider> keeps the same
// element type across reloads — React updates the mounted tree (and the
// existing X11 window) in place instead of remounting it.
//
// React.createContext, not the named import: under hot reload (see
// hmr-register.mjs) named imports initialize in a microtask, after this
// module's top level has already run.
import React from 'react';

export const DispatchContext = React.createContext(null);
