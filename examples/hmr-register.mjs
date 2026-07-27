// Hot-reload bootstrap for the examples. Run an example through it with:
//
//   node --enable-source-maps --import ./examples/hmr-register.mjs examples/tasks-hot.jsx
//
// Two module hook layers, both sync (module.registerHooks, Node >= 22.15):
//
//   1. a JSX + Fast Refresh loader — babel with the classic JSX transform
//      (React.createElement, the same shape tsx gives the plain example
//      runs) plus react-refresh/babel, which instruments every component
//      so edits update it *in place*, keeping its hook state. retainLines
//      keeps the source's line structure, which the layer above depends
//      on. A one-line prelude provides the $RefreshReg$/$RefreshSig$
//      bindings the instrumentation emits, registering components under
//      their canonical module URL (the ?hmr=N cache-buster stripped, so a
//      reloaded module lands in the same component family);
//   2. hot-module-replacement's ESM hooks, registered second so they run
//      outermost and see plain JS: an acorn transform rewrites static
//      imports into live `let` bindings and wires up import.meta.hot.
//
// node_modules and src/ are kept out of the hot graph: React, the
// renderer and react-refresh/runtime stay singletons, so the X11
// connection and the mounted window survive reloads — the hot boundary is
// the example modules themselves. See examples/hmr-refresh.js for the
// runtime half of Fast Refresh.
//
// One constraint the binding rewrite imposes on hot modules: named
// imports are re-initialized in a microtask, so module top-level code
// must not call them synchronously — use the default import there
// (`React.createContext(...)`, not `createContext(...)`); inside
// components anything goes.
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from '@babel/core';
import jsxTransform from '@babel/plugin-transform-react-jsx';
import refreshTransform from 'react-refresh/babel';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

// One statement per line: hot-module-replacement's import rewrite emits
// replacements with no trailing semicolon, so a following statement on
// the same line is a syntax error — newlines keep ASI in play. (Stacks
// through hot modules are off by these four lines; dev-only.)
const REFRESH_PRELUDE =
  [
    `import __RefreshRuntime from 'react-refresh/runtime'`,
    `const __refreshUrl = import.meta.url.replace(/\\?hmr=\\d+$/, '')`,
    `const $RefreshReg$ = (type, id) => __RefreshRuntime.register(type, __refreshUrl + ' ' + id)`,
    `const $RefreshSig$ = __RefreshRuntime.createSignatureFunctionForTransform`,
  ].join(';\n') + ';';

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:')) {
      return nextLoad(url, context);
    }
    const fileUrl = new URL(url);
    fileUrl.search = ''; // hot-module-replacement cache-busts with ?hmr=N
    if (!fileUrl.pathname.endsWith('.jsx')) {
      return nextLoad(url, context);
    }
    const filename = fileURLToPath(fileUrl);
    const { code } = transformSync(readFileSync(filename, 'utf8'), {
      filename,
      babelrc: false,
      configFile: false,
      plugins: [
        // classic runtime: no injected react/jsx-runtime import — babel
        // appends it to the last import's line, where the layer above's
        // semicolon-less import rewrite would make it a syntax error
        [jsxTransform, { runtime: 'classic' }],
        [refreshTransform, { skipEnvCheck: true }],
      ],
      retainLines: true,
      sourceMaps: 'inline',
    });
    return {
      format: 'module',
      source: `${REFRESH_PRELUDE}\n${code}`,
      shortCircuit: true,
    };
  },
});

globalThis.__HMR_OPTIONS__ = {
  ignore: (path) => path.includes('/node_modules/') || path.startsWith(srcDir),
};
await import('hot-module-replacement/register');
