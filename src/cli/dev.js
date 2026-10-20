// `react-x11 dev <file>` — hot reload with nothing to set up.
//
// What `node --import react-x11/refresh/register main.jsx` leaves to the app,
// this does itself, and each piece is here because the --import route gets it
// wrong without one:
//
//  - **It is the entry.** The file named on a command line is the one module
//    hot-module-replacement never watches — it starts watching a module when
//    another module imports it — so under --import an app in one file never
//    reloads, and nothing says so. Here this module imports the file, which
//    makes it an ordinary hot module: one file, and saving it reloads it.
//  - **It mounts the file's default export**, so the file has no createRoot
//    and no named-import rule to learn before its first save. A file that
//    mounts a root of its own while it is imported runs as it is, the way the
//    --import route runs it.
//  - **It supplies a `<window>` when the tree has none.** Whether a tree has
//    one cannot be read off the export — a component returns another
//    component, or a window only once a state settles — but the renderer
//    knows the moment it matters: a drawn element at the root throws
//    NOT_IN_WINDOW before anything commits. So the component is mounted as it
//    is, and on that error mounted again inside a window of ours, with nothing
//    lost: the failed render committed nothing. Decided again on every reload,
//    both ways, so the first answer does not outlive the code that gave it.
//  - **It asks before it installs the toolchain.** Babel and friends are
//    optional peer dependencies, 7.6 MB that an app's users should not
//    download for a tool only its developers run, so `dev` finds them
//    missing, names them with the versions the loader is written against, and
//    installs them with the project's own package manager when the developer
//    says yes. Without a terminal to ask on it prints the command instead.
//  - **It turns click-to-component on.** Alt+Click (Option+Click on macOS)
//    opens the JSX line an element came from (docs/click-to-component.md):
//    a development tool, and this is the command a developer runs, so it is
//    on unless REACT_X11_CLICK_TO_COMPONENT=0 says otherwise. Set here, in
//    the environment, because that is where the renderer reads it when the
//    first root is made — and where a toolchain restart inherits it from.
//  - **It connects to React DevTools** whenever `npx react-devtools` is
//    running, before or after the app started, the way a browser with the
//    extension does: on by default where react-devtools-core is installed,
//    unless REACT_X11_DEVTOOLS=0. Where it is not, and a DevTools UI is
//    listening at start, it says what to install. Prepared before React
//    Refresh loads, because Refresh installs a stub hook where it finds none,
//    and the backend installs none where it finds one.
//  - **It runs the project's react-x11.** A second copy of the renderer is a
//    second React root nobody refreshes, so a global or npx-cached
//    `react-x11` hands over to the copy the file itself imports.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { connect } from 'node:net';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { THEME_SCOPE } from '../nodes/kinds.js';

const OWN_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OWN_PACKAGE = JSON.parse(
  readFileSync(join(OWN_ROOT, 'package.json'), 'utf8'),
);

/**
 * What the dev window is when the tree brings none. No size: a `<window>`
 * without one is sized from its content, which is the honest frame for a
 * component shown alone, and the floor only keeps a lone button's window big
 * enough to find and grab.
 */
const DEV_WINDOW = { minWidth: 320, minHeight: 200 };

/** A mistake the developer can fix from the message: printed bare. */
export class DevError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DevError';
  }
}

/**
 * Run `file` with hot reload. Resolves once the app is mounted; the process
 * then lives as long as the app's connection does.
 *
 * `options.args` is what the app sees after its file in `process.argv`, as
 * under `node file.jsx …args`. `createRoot` and `log` are the seams the
 * tests replace: the root is made against their mock app, and what this
 * prints is what they read.
 */
export async function runDev(file, options = {}) {
  const {
    args = [],
    createRoot = null,
    log = (line) => console.error(`react-x11 dev: ${line}`),
  } = options;

  const path = resolve(file);
  const rel = (p) => relative(process.cwd(), p) || p;
  if (!existsSync(path)) {
    throw new DevError(`${file}: no such file.`);
  }
  const ext = extname(path);
  if (!['.jsx', '.js', '.mjs'].includes(ext)) {
    throw new DevError(
      `${rel(path)}: the hot loader compiles .jsx files, and runs .js and ` +
        `.mjs as Node does — ${ext || 'a file with no extension'} is ` +
        'neither. TypeScript is not supported yet; rename the file to .jsx.',
    );
  }
  if (process.env.NODE_ENV === 'production') {
    throw new DevError(
      "NODE_ENV is 'production', and react-refresh ships a no-op build " +
        'for production, so nothing would reload. Unset NODE_ENV (or set ' +
        "it to 'development') to run react-x11 dev.",
    );
  }
  if (typeof nodeModule.registerHooks !== 'function') {
    throw new DevError(
      'hot reload needs Node.js 22.15 or newer, for module.registerHooks — ' +
        `this is Node ${process.versions.node}. The app itself runs on ` +
        'Node 20.19: `node` (or `npx tsx`) with your own entry file.',
    );
  }

  const theirs = reactX11For(path);
  if (theirs === null) {
    throw new DevError(
      `${rel(path)} cannot import react-x11: it is not installed in the ` +
        'project the file is in. Install it there:\n\n' +
        '  npm install react-x11 react\n',
    );
  }
  if (realpathSync(theirs) !== realpathSync(OWN_ROOT)) {
    await handOver(theirs);
    return null;
  }

  const projectDir = projectDirOf(dirname(path));
  if ((await ensureToolchain({ projectDir, log })) === 'installed') {
    restart();
    return null;
  }

  process.env.REACT_X11_CLICK_TO_COMPONENT ??= '1';
  if (process.env.REACT_X11_DEVTOOLS === undefined) {
    if (resolves('react-devtools-core')) {
      process.env.REACT_X11_DEVTOOLS = '1';
    } else {
      suggestDevTools({ projectDir, log });
    }
  }
  if (envFlag(process.env.REACT_X11_DEVTOOLS)) {
    await (await import('../DevToolsIntegration.js')).prepare();
  }

  // Before anything below loads: a module's source maps are read when it
  // loads, and only once this is on.
  process.setSourceMapsEnabled(true);
  const { onTransform, registerRefresh } = await import('../refresh/loader.js');
  await registerRefresh();
  // The runtime patches React DevTools' global hook and then hands the
  // renderer to it, which has to happen before the first root commits.
  const { default: Refresh } = await import('../refresh/index.js');
  const { default: RefreshRuntime } = await import('react-refresh/runtime');
  const { default: React } = await import('react');
  const ReactX11 = await import('../index.js');
  const { NOT_IN_WINDOW } = await import('../errors.js');
  const { liveApps } = await import('../trace-registry.js');
  const { ErrorWindow, describeError } = await import('./errorwindow.js');

  // What `node file.jsx …args` would hand the app.
  process.argv = [process.argv[0], path, ...args];

  const appsBefore = liveApps().length;
  const mod = await import(pathToFileURL(path).href);
  const name = rel(path);
  const compiled = ext === '.jsx';

  // A module reloads in place only when everything it exports is a
  // component (src/refresh/index.js, `moduleReady`); otherwise the edit goes
  // up to its importer, which is this module, and stops there.
  const notComponents = Object.keys(mod).filter(
    (key) => !RefreshRuntime.isLikelyComponentType(mod[key]),
  );
  const boundary = Object.keys(mod).length > 0 && notComponents.length === 0;

  if (liveApps().length > appsBefore) {
    log(
      `${name} mounted a root of its own, so it runs as it is: saving the ` +
        `.jsx modules it imports reloads them, and ${name} itself needs a ` +
        'restart.',
    );
    if (compiled && boundary) {
      log(
        `${name} also exports only components, so saving it re-runs it — ` +
          'and its createRoot call, which opens another window. Leave the ' +
          'mounting to react-x11 dev (delete the createRoot call), or guard ' +
          'it: if (!import.meta.hot) { … }.',
      );
    }
    return null;
  }

  const App = mod.default;
  const componentLike =
    typeof App === 'function' ||
    (typeof App === 'object' && App !== null && '$$typeof' in App);
  if (!componentLike) {
    throw new DevError(
      `${name} has no component as its default export, and mounted no root ` +
        'of its own, so there is nothing to show. Export the component:\n\n' +
        '  export default function App() { … }\n',
    );
  }
  if (!compiled) {
    log(
      `${name} is not compiled by the hot loader (it compiles .jsx files), ` +
        'so saving it needs a restart; the .jsx modules it imports reload.',
    );
  } else if (!boundary) {
    const reasons = [];
    if (notComponents.includes('default')) {
      reasons.push(
        'its default export is not a component to React Refresh, which ' +
          'goes by a capitalized name — export default function App() { … }',
      );
    }
    const others = notComponents.filter((key) => key !== 'default');
    if (others.length > 0) {
      reasons.push(
        `${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} not — ` +
          'move what is not a component to a module of its own',
      );
    }
    log(
      `saving ${name} will not reload it in place: a module does that only ` +
        `when everything it exports is a component, and ${reasons.join('; ')}. ` +
        'Until then, saving it needs a restart.',
    );
  }

  const title = `${basename(path)} — react-x11 dev`;
  let wrapped = false;
  let mixedNoted = false;
  // What the error window shows: a render error took the app's tree down,
  // and the app stays down until the next reload tries it again; a compile
  // error is a save that did not compile, beside an app still running the
  // module's last version. Both at once shows the compile error, which is
  // the newer news.
  let renderFailure = null;
  let compileFailure = null;
  // Set when a reload starts while a render error is showing: that reload is
  // the one to try the app again on. Not the reload that threw — react-refresh
  // calls the reload listeners in the same batch as the render that failed,
  // and retrying there would only throw it a second time.
  let retry = false;
  let root = null;
  // Two children, always in these places: an error window opening or
  // closing beside the app is then a sibling coming and going, and the app's
  // state is untouched by it.
  const tree = () => {
    const app = React.createElement(App);
    const failure = compileFailure ?? renderFailure;
    return React.createElement(
      React.Fragment,
      null,
      renderFailure
        ? null
        : wrapped
          ? React.createElement('window', { ...DEV_WINDOW, title }, app)
          : app,
      failure
        ? React.createElement(ErrorWindow, {
            failure,
            title: `${basename(failure.filename ?? path)} — error`,
            // Beside a running app it is a second window, whose closing is
            // ours to answer: it goes until the next error. Standing in for
            // the app it is the only one, and closing it ends the app.
            onCloseRequest: renderFailure
              ? undefined
              : () => {
                  compileFailure = null;
                  render();
                },
          })
        : null,
    );
  };
  const render = () => root.render(tree());

  root = await (createRoot ?? ReactX11.createRoot)({
    onUncaughtError(error, info) {
      if (error?.code === NOT_IN_WINDOW && !wrapped && !renderFailure) {
        wrapped = true;
        log(
          `${name} renders no <window>, so it is shown in one of react-x11 ` +
            "dev's; the first <window> it renders replaces it.",
        );
        setImmediate(render);
        return;
      }
      if (info?.handler) {
        // from an event handler: React was not on the stack and nothing
        // unmounted (src/errors.js, reportHandlerError)
        console.error(
          `react-x11 dev: ${info.handler} on ${info.element} threw; ` +
            'dispatch continues.',
          error,
        );
        return;
      }
      console.error(error);
      const chain = describeError({
        kind: 'render',
        error,
        componentStack: info?.componentStack,
      }).components;
      // Already showing one: this came out of the error window itself, or
      // the tree failed again before a reload — the terminal has it, and a
      // window answering its own failure by mounting itself again would
      // never stop.
      if (renderFailure) return;
      log(
        (chain.length > 0 ? `thrown rendering ${chain.join(' › ')}. ` : '') +
          `Fix it and save: ${name} is mounted again on the next reload.`,
      );
      renderFailure = {
        kind: 'render',
        error,
        componentStack: info?.componentStack,
      };
      setImmediate(render);
    },
  });

  // A save that does not compile: the reload library prints it and keeps the
  // module's last version, so this is the only place it can be shown. Before
  // the mount, the import of the file itself throws, and the bin prints it.
  //
  // Every reload compiles at least the module it stops at, so this is also
  // where a reload is first seen.
  onTransform(({ filename, error }) => {
    if (error) {
      compileFailure = { kind: 'compile', error, filename };
      setImmediate(render);
      return;
    }
    if (renderFailure) retry = true;
    if (compileFailure?.filename === filename) {
      compileFailure = null;
      setImmediate(render);
    }
  });

  // After a reload: try an app an error took down again, and take the dev
  // window away from a tree that now brings its own. The other direction
  // needs nothing here — a tree that lost its window throws NOT_IN_WINDOW,
  // and the handler above wraps it.
  const settle = () => {
    if (renderFailure) {
      if (!retry) return;
      retry = false;
      renderFailure = null;
      render();
      return;
    }
    if (!wrapped) return;
    const devWindow = (root.app._rootChildren ?? [])[0];
    if (!devWindow) return;
    const { windows, drawn } = rootContent(devWindow);
    if (windows > 0 && drawn === 0) {
      wrapped = false;
      mixedNoted = false;
      log(
        `${name} renders its own <window> now, so it is mounted without ` +
          "react-x11 dev's; that resets its state.",
      );
      render();
    } else if (windows > 0 && !mixedNoted) {
      mixedNoted = true;
      log(
        `${name} renders a <window> beside content that is in none, so ` +
          "both stay in react-x11 dev's window. Put that content in a " +
          '<window> of its own.',
      );
    }
  };
  Refresh.onReload(({ urls, refreshed }) => {
    if (refreshed) {
      log(`reloaded ${urls.map((url) => rel(fileURLToPath(url))).join(', ')}`);
    }
    setImmediate(settle);
  });

  render();
  log(`${name} is running; saving it reloads in place. Ctrl+C stops it.`);
  return root;
}

/**
 * What the tree put inside the dev window, by the rule the root itself
 * keeps: windows (popups among them), and anything drawn. A
 * `<ThemeProvider>` is neither — inside a window it is a box that holds what
 * it wraps — so its children are counted in its place.
 */
function rootContent(node) {
  let windows = 0;
  let drawn = 0;
  for (const child of node?.children ?? []) {
    if (child.isWindow) windows++;
    else if (child._reactFiber?.type === THEME_SCOPE) {
      const inner = rootContent(child);
      windows += inner.windows;
      drawn += inner.drawn;
    } else drawn++;
  }
  return { windows, drawn };
}

/** Whether `specifier` resolves from react-x11, which is where it is
 * imported from. */
function resolves(specifier) {
  try {
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/** The renderer's rule for a switch: set, and not `0`. */
function envFlag(value) {
  return Boolean(value) && value !== '0';
}

/**
 * Where react-devtools-core is missing: if a DevTools UI is listening (one
 * TCP connect, in the background, never holding the process), say what to
 * install for the app to show up in it. Silent otherwise — no DevTools
 * running is the usual case, not one to print about.
 */
function suggestDevTools({ projectDir, log }) {
  const host = process.env.REACT_X11_DEVTOOLS_HOST || 'localhost';
  const port = Number(process.env.REACT_X11_DEVTOOLS_PORT) || 8097;
  const socket = connect({ host, port });
  socket.unref();
  socket.setTimeout(1000, () => socket.destroy());
  socket.on('error', () => {});
  socket.on('connect', () => {
    socket.destroy();
    const line = shellLine(
      installCommand(packageManagerFor(projectDir), ['react-devtools-core']),
    );
    log(
      `React DevTools is listening on ${host}:${port}, and this project ` +
        'cannot connect to it without react-devtools-core. Install it, and ' +
        `the next run shows up there:\n\n  ${line}\n`,
    );
  });
}

/** The react-x11 package `path` imports, or null when it imports none. */
export function reactX11For(path) {
  let entry;
  try {
    entry = nodeModule.createRequire(path).resolve('react-x11');
  } catch {
    return null;
  }
  for (let dir = dirname(entry); dirname(dir) !== dir; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    if (JSON.parse(readFileSync(manifest, 'utf8')).name === 'react-x11') {
      return dir;
    }
  }
  return null;
}

/**
 * Hand the command over to the project's own copy of react-x11, which reads
 * the same `process.argv`.
 */
async function handOver(theirRoot) {
  const pkg = JSON.parse(readFileSync(join(theirRoot, 'package.json'), 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['react-x11'];
  if (!bin) {
    throw new DevError(
      `this project's react-x11 is ${pkg.version} (${theirRoot}), which has ` +
        `no react-x11 dev — it arrived in ${OWN_PACKAGE.version}. Update ` +
        'it:\n\n  npm install react-x11@latest\n',
    );
  }
  await import(pathToFileURL(join(theirRoot, bin)).href);
}

/** The nearest directory at or above `dir` with a package.json. */
function projectDirOf(dir) {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, 'package.json'))) return at;
    if (dirname(at) === at) return dir;
  }
}

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

/**
 * The package manager a project is installed with: its lockfile, nearest
 * first, then the one that launched this command (`npx`, `pnpm dlx`, `bunx`
 * set `npm_config_user_agent`), then npm.
 */
export function packageManagerFor(
  dir,
  userAgent = process.env.npm_config_user_agent,
) {
  for (let at = dir; ; at = dirname(at)) {
    for (const [file, manager] of LOCKFILES) {
      if (existsSync(join(at, file))) return manager;
    }
    if (dirname(at) === at) break;
  }
  return /^(npm|pnpm|yarn|bun)\//.exec(userAgent ?? '')?.[1] ?? 'npm';
}

/** The command that adds `packages` as dev dependencies, as argv. */
export function installCommand(manager, packages) {
  switch (manager) {
    case 'pnpm':
      return ['pnpm', 'add', '--save-dev', ...packages];
    case 'yarn':
      return ['yarn', 'add', '--dev', ...packages];
    case 'bun':
      return ['bun', 'add', '--dev', ...packages];
    default:
      return ['npm', 'install', '--save-dev', ...packages];
  }
}

/** `argv` as one line a POSIX shell (or cmd.exe) reads back the same. */
function shellLine(argv) {
  const quote = (arg) =>
    /^[\w@./:=-]+$/.test(arg)
      ? arg
      : process.platform === 'win32'
        ? `"${arg}"`
        : `'${arg}'`;
  return argv.map(quote).join(' ');
}

/**
 * Make sure the hot-reload toolchain resolves from this copy of react-x11,
 * which is where the loader imports it from. `'ready'` when it does,
 * `'installed'` when it was just installed (the caller restarts: a package
 * manager may have moved react-x11 itself to satisfy the new peers), and a
 * DevError carrying the command when it is missing and was not installed.
 *
 * Every way out of this is a seam for the tests: `resolveSpecifier`,
 * `interactive`, `ask` and `run`.
 */
export async function ensureToolchain({
  projectDir,
  log,
  resolveSpecifier = (specifier) => import.meta.resolve(specifier),
  interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY),
  ask = askOnTerminal,
  run = (argv, cwd) =>
    spawnSync(argv[0], argv.slice(1), {
      cwd,
      stdio: 'inherit',
      // npm and friends are .cmd scripts there, which only a shell runs
      shell: process.platform === 'win32',
    }).status,
}) {
  const { TOOLCHAIN } = await import('../refresh/loader.js');
  const missing = TOOLCHAIN.filter(({ specifier }) => {
    try {
      resolveSpecifier(specifier);
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length === 0) return 'ready';

  // The versions the loader is written against, from react-x11's own
  // peerDependencies: an unpinned install takes whatever major is newest.
  const packages = missing.map(
    ({ name }) => `${name}@${OWN_PACKAGE.peerDependencies[name]}`,
  );
  const argv = installCommand(packageManagerFor(projectDir), packages);
  const line = shellLine(argv);
  const what =
    `hot reload needs ${missing.length === 1 ? 'a package' : 'packages'} ` +
    `this project does not have: ${missing.map((m) => m.name).join(', ')}. ` +
    'They are optional peer dependencies of react-x11, so an app that never ' +
    'hot-reloads does not ship them to its users.';
  if (!interactive) {
    throw new DevError(
      `${what} Install them as dev dependencies:\n\n  ${line}\n`,
    );
  }
  log(what);
  const answer = (await ask(`Run \`${line}\` in ${projectDir}? [Y/n] `))
    .trim()
    .toLowerCase();
  if (answer !== '' && answer !== 'y' && answer !== 'yes') {
    throw new DevError(
      `not installed. To install them yourself:\n\n  ${line}\n`,
    );
  }
  const status = run(argv, projectDir);
  if (status !== 0) {
    throw new DevError(
      `\`${line}\` failed${status == null ? '' : ` (exit ${status})`}; its ` +
        'output is above.',
    );
  }
  return 'installed';
}

async function askOnTerminal(question) {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

/**
 * Start this command again, once the toolchain is installed: the new process
 * resolves the packages, and react-x11 itself, from scratch.
 */
function restart() {
  const { status, signal } = spawnSync(
    process.execPath,
    [...process.execArgv, ...process.argv.slice(1)],
    { stdio: 'inherit' },
  );
  process.exitCode = status ?? (signal ? 1 : 0);
}
