// react-x11/refresh — the loader half of state-preserving hot reload.
// `registerRefresh(options)` is the seam for a tool that needs options;
// `react-x11/refresh/register` calls it with the defaults so an app adopts
// the whole thing as `node --import react-x11/refresh/register app.jsx`.
//
// Two module hook layers, both sync (module.registerHooks, Node >= 22.15):
//
//   1. a JSX + Fast Refresh loader — babel with the classic JSX transform
//      plus react-refresh/babel, which instruments every component so edits
//      update it *in place*, keeping its hook state. retainLines keeps the
//      source's line structure, which the layer above depends on. The
//      injected prelude provides the $RefreshReg$/$RefreshSig$ bindings the
//      instrumentation emits (components register under their canonical
//      module URL, the ?hmr=N cache-buster stripped, so a reloaded module
//      lands in the same component family), and the injected footer hands
//      the module's exports to the runtime, which decides whether the
//      module is a refresh boundary (see ./index.js);
//   2. hot-module-replacement's ESM hooks, registered second so they run
//      outermost and see plain JS: an acorn transform rewrites static
//      imports into live `let` bindings and wires up import.meta.hot.
//
// node_modules and react-x11's own src/ are kept out of the hot graph:
// React, the renderer and react-refresh/runtime stay singletons, so the
// X11 connection and the mounted window survive reloads — the hot boundary
// is the application's own modules.
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { fileURLToPath } from 'node:url';
import { markHotReloadSession } from '../registry.js';

const RUNTIME_URL = new URL('./index.js', import.meta.url).href;
const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));

const TOOLCHAIN = [
  '@babel/core',
  '@babel/plugin-transform-react-jsx',
  'react-refresh',
  'hot-module-replacement',
];

async function loadToolchain() {
  const missing = [];
  const load = async (specifier, name) => {
    try {
      return await import(specifier);
    } catch {
      missing.push(name);
      return null;
    }
  };
  const babel = await load('@babel/core', '@babel/core');
  const jsxTransform = await load(
    '@babel/plugin-transform-react-jsx',
    '@babel/plugin-transform-react-jsx',
  );
  const refreshTransform = await load('react-refresh/babel', 'react-refresh');
  if (missing.length > 0) {
    throw new Error(
      `react-x11/refresh: the hot-reload toolchain is not installed ` +
        `(missing: ${missing.join(', ')}). It is a set of optional peer ` +
        `dependencies — an app that never hot-reloads does not carry them. ` +
        `Install them where the dev loop runs:\n\n` +
        `  npm install --save-dev ${TOOLCHAIN.join(' ')}\n`,
    );
  }
  return {
    babel,
    jsxTransform: jsxTransform.default,
    refreshTransform: refreshTransform.default,
  };
}

function validateOptions(babel, options) {
  const {
    extensions = ['.jsx'],
    jsxRuntime = 'classic',
    prelude = [],
    ignore,
  } = options;

  if (jsxRuntime !== 'classic') {
    throw new Error(
      `react-x11/refresh: jsxRuntime must be 'classic', got ` +
        `${JSON.stringify(jsxRuntime)}. The automatic runtime appends its ` +
        `react/jsx-runtime import to the last existing import's line, and ` +
        `hot-module-replacement's line-oriented import rewrite then breaks ` +
        `the statement — and the injected import would itself become a ` +
        `named-import binding that is undefined at module scope. The ` +
        `classic runtime compiles to React.createElement, which reaches ` +
        `React through the default import and has neither problem.`,
    );
  }

  if (
    !Array.isArray(extensions) ||
    extensions.length === 0 ||
    extensions.some((ext) => typeof ext !== 'string' || !ext.startsWith('.'))
  ) {
    throw new Error(
      `react-x11/refresh: extensions must be a non-empty array of ` +
        `'.ext' strings, got ${JSON.stringify(extensions)}.`,
    );
  }

  if (ignore !== undefined && typeof ignore !== 'function') {
    throw new Error(
      `react-x11/refresh: ignore must be a function (path) => boolean, ` +
        `got ${typeof ignore}.`,
    );
  }

  if (!Array.isArray(prelude)) {
    throw new Error(
      `react-x11/refresh: prelude must be an array of statements, got ` +
        `${typeof prelude}.`,
    );
  }
  prelude.forEach((statement, i) => {
    const reject = (what) => {
      throw new Error(
        `react-x11/refresh: prelude[${i}] ${what}. Injected prelude lines ` +
          `are joined one statement per line: hot-module-replacement's ` +
          `import rewrite replaces a whole import statement's span, so a ` +
          `second statement sharing its line is silently swallowed or ` +
          `becomes a syntax error. Split it into one array entry per ` +
          `statement.\n  prelude[${i}]: ${JSON.stringify(statement)}`,
      );
    };
    if (typeof statement !== 'string' || statement.trim() === '') {
      throw new Error(
        `react-x11/refresh: prelude[${i}] must be a non-empty statement ` +
          `string, got ${JSON.stringify(statement)}.`,
      );
    }
    if (statement.includes('\n')) reject('contains a newline');
    let ast;
    try {
      ast = babel.parseSync(statement, {
        babelrc: false,
        configFile: false,
        sourceType: 'module',
      });
    } catch (err) {
      throw new Error(
        `react-x11/refresh: prelude[${i}] does not parse as a statement: ` +
          `${err.message}\n  prelude[${i}]: ${JSON.stringify(statement)}`,
      );
    }
    if (ast.program.body.length !== 1) {
      reject(`holds ${ast.program.body.length} statements`);
    }
  });

  return { extensions, prelude, ignore };
}

// The two per-module analyses, one babel pass:
//
//  - the enforced constraint: a *named* import called at module top level.
//    hot-module-replacement rewrites named imports into `let` bindings it
//    initializes in a microtask, so at module scope the value is still
//    undefined — the call throws a bare "x is not a function" at runtime,
//    four frames from anything the developer wrote. Caught here instead,
//    at transform time, with the module and line;
//  - export collection for the boundary decision. Any export the footer
//    cannot name as a local value — a re-export, `export *`, an anonymous
//    default — makes the module opaque: never a boundary, so an edit to it
//    propagates to the nearest boundary above, which is correct just wider.
function makeGuardPlugin(onModuleInfo) {
  return ({ types: t }) => ({
    name: 'react-x11-refresh-guards',
    visitor: {
      Program: {
        exit(path) {
          for (const binding of Object.values(path.scope.bindings)) {
            if (binding.kind !== 'module') continue;
            if (!t.isImportSpecifier(binding.path.node)) continue;
            for (const ref of binding.referencePaths) {
              if (ref.getFunctionParent()) continue;
              // A class field initializer runs at instantiation, not at
              // module evaluation — a static block does run now, though.
              const classBody = ref.findParent(
                (p) => p.isClassBody() || p.isStaticBlock(),
              );
              if (classBody && classBody.isClassBody()) continue;
              const parent = ref.parentPath;
              const called =
                ((t.isCallExpression(parent.node) ||
                  t.isNewExpression(parent.node)) &&
                  parent.node.callee === ref.node) ||
                (t.isTaggedTemplateExpression(parent.node) &&
                  parent.node.tag === ref.node);
              if (!called) continue;
              const name = ref.node.name;
              throw ref.buildCodeFrameError(
                `react-x11/refresh: \`${name}\` is a named import called at ` +
                  `module top level inside a hot module. Named imports here ` +
                  `become live bindings that hot-module-replacement ` +
                  `initializes in a microtask, so \`${name}\` is still ` +
                  `undefined when this line runs. Call it through the ` +
                  `default import instead (React.createContext(...), not ` +
                  `createContext(...)), or move the call inside a component ` +
                  `or function — and keep identity that must survive a ` +
                  `reload (contexts, stores) in a module outside the hot ` +
                  `graph.`,
              );
            }
          }

          let opaque = false;
          const names = [];
          for (const node of path.node.body) {
            if (node.type === 'ExportAllDeclaration') {
              opaque = true;
            } else if (node.type === 'ExportDefaultDeclaration') {
              const d = node.declaration;
              if (
                (d.type === 'FunctionDeclaration' ||
                  d.type === 'ClassDeclaration') &&
                d.id
              ) {
                names.push(d.id.name);
              } else if (d.type === 'Identifier') {
                names.push(d.name);
              } else {
                opaque = true;
              }
            } else if (node.type === 'ExportNamedDeclaration') {
              if (node.source) {
                opaque = true;
                continue;
              }
              const d = node.declaration;
              if (d && d.type === 'VariableDeclaration') {
                for (const declarator of d.declarations) {
                  if (declarator.id.type === 'Identifier') {
                    names.push(declarator.id.name);
                  } else {
                    opaque = true;
                  }
                }
              } else if (d && d.id) {
                names.push(d.id.name);
              } else if (d) {
                opaque = true;
              }
              for (const spec of node.specifiers) {
                if (spec.type === 'ExportSpecifier') {
                  names.push(spec.local.name);
                } else {
                  opaque = true;
                }
              }
            }
          }
          onModuleInfo({ opaque, names });
        },
      },
    },
  });
}

/**
 * The transform alone, for a tool that hosts its own hooks (and for the
 * tests). `matches(pathname)` says whether a file is a hot module;
 * `transform(source, filename)` returns `{ code }` with the refresh
 * prelude, the instrumented body, and the boundary footer.
 */
export async function createTransformer(options = {}) {
  const toolchain = await loadToolchain();
  return buildTransformer(toolchain, validateOptions(toolchain.babel, options));
}

function buildTransformer({ babel, jsxTransform, refreshTransform }, options) {
  const { extensions, prelude } = options;

  // One statement per line, `;`-joined — see the prelude constraint in
  // validateOptions. Everything reaches the runtime through its default
  // export because only default bindings initialize synchronously in a
  // hot module (the runtime says the same from its side).
  const preludeLines = [
    `import __ReactX11Refresh from ${JSON.stringify(RUNTIME_URL)}`,
    `const __refreshUrl = import.meta.url.replace(/\\?hmr=\\d+$/, '')`,
    `const $RefreshReg$ = (type, id) => __ReactX11Refresh.register(type, __refreshUrl + ' ' + id)`,
    `const $RefreshSig$ = __ReactX11Refresh.createSignatureFunctionForTransform`,
    ...prelude,
  ];
  // Stacks through hot modules are off by these lines; dev-only.
  const preludeSource = preludeLines.join(';\n') + ';';

  let lastModuleInfo = null;
  const guardPlugin = makeGuardPlugin((info) => {
    lastModuleInfo = info;
  });

  return {
    preludeLineCount: preludeLines.length,
    matches(pathname) {
      return extensions.some((ext) => pathname.endsWith(ext));
    },
    transform(source, filename) {
      lastModuleInfo = null;
      const { code } = babel.transformSync(source, {
        filename,
        babelrc: false,
        configFile: false,
        plugins: [
          // classic runtime only — see validateOptions for why
          [jsxTransform, { runtime: 'classic' }],
          [refreshTransform, { skipEnvCheck: true }],
          guardPlugin,
        ],
        retainLines: true,
        sourceMaps: 'inline',
      });
      const { opaque, names } = lastModuleInfo;
      const exportsArg =
        opaque || names.length === 0
          ? 'null'
          : `{ ${names.map((n) => `${JSON.stringify(n)}: ${n}`).join(', ')} }`;
      const footer = `\n;import.meta.hot && __ReactX11Refresh.moduleReady(import.meta.hot, import.meta.url, ${exportsArg});`;
      return { code: `${preludeSource}\n${code}${footer}` };
    },
  };
}

let registered = false;

/**
 * Register the hot-reload loader. `react-x11/refresh/register` calls this
 * with no options; a tool that needs the seams writes its own two-line
 * `--import` module and passes them here.
 */
export async function registerRefresh(options = {}) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `react-x11/refresh: NODE_ENV is 'production'. Hot reload is a ` +
        `development tool — react-refresh ships a no-op production build, ` +
        `so nothing would reload. Unset NODE_ENV (or set it to ` +
        `'development') for the dev loop, and drop the --import for ` +
        `production runs; there is no production hot path, by design.`,
    );
  }
  if (typeof nodeModule.registerHooks !== 'function') {
    throw new Error(
      `react-x11/refresh needs module.registerHooks, which landed in ` +
        `Node.js 22.15 — this is Node ${process.versions.node}. Upgrade ` +
        `Node to use hot reload; the renderer itself runs on Node >= 20.19.`,
    );
  }
  if (registered) {
    throw new Error(
      `react-x11/refresh: registerRefresh was already called in this ` +
        `process. Register it once — from the app's --import module or ` +
        `from the tool hosting it, not both.`,
    );
  }

  const toolchain = await loadToolchain();
  const validated = validateOptions(toolchain.babel, options);
  const transformer = buildTransformer(toolchain, validated);
  const { ignore } = validated;
  registered = true;

  const hotIgnore = (path) =>
    path.includes('/node_modules/') ||
    path.startsWith(SRC_DIR) ||
    (ignore ? ignore(path) === true : false);

  nodeModule.registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) {
        return nextLoad(url, context);
      }
      // A ?hmr=N request is a hot re-import about to re-run a module
      // scope. Told to the registry *before* the module evaluates — the
      // first reloaded module may itself call registerElement at top
      // level — and checked on every extension, because a chain reload
      // re-imports plain .js modules this hook does not transform.
      if (/[?&]hmr=\d+/.test(url)) markHotReloadSession();
      const fileUrl = new URL(url);
      fileUrl.search = ''; // hot-module-replacement cache-busts with ?hmr=N
      if (!transformer.matches(fileUrl.pathname)) {
        return nextLoad(url, context);
      }
      const filename = fileURLToPath(fileUrl);
      if (hotIgnore(filename)) {
        return nextLoad(url, context);
      }
      const { code } = transformer.transform(
        readFileSync(filename, 'utf8'),
        filename,
      );
      return { format: 'module', source: code, shortCircuit: true };
    },
  });

  // Registered second so its hooks run outermost and see plain JS.
  globalThis.__HMR_OPTIONS__ = { ignore: hotIgnore };
  await import('hot-module-replacement/register');
}
