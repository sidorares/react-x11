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
//  - **It runs the project's react-x11.** A second copy of the renderer is a
//    second React root nobody refreshes, so a global or npx-cached
//    `react-x11` hands over to the copy the file itself imports.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import * as nodeModule from 'node:module';
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

  // Before anything below loads: a module's source maps are read when it
  // loads, and only once this is on.
  process.setSourceMapsEnabled(true);
  const { registerRefresh } = await import('../refresh/loader.js');
  await registerRefresh();
  // The runtime patches React DevTools' global hook and then hands the
  // renderer to it, which has to happen before the first root commits.
  const { default: Refresh } = await import('../refresh/index.js');
  const { default: RefreshRuntime } = await import('react-refresh/runtime');
  const { default: React } = await import('react');
  const ReactX11 = await import('../index.js');
  const { NOT_IN_WINDOW } = await import('../errors.js');
  const { liveApps } = await import('../trace-registry.js');

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
  let root = null;
  const tree = () => {
    const app = React.createElement(App);
    return wrapped
      ? React.createElement('window', { ...DEV_WINDOW, title }, app)
      : app;
  };
  const render = () => root.render(tree());
  const mounted = () => (root.app._rootChildren ?? []).length > 0;

  root = await (createRoot ?? ReactX11.createRoot)({
    onUncaughtError(error, info) {
      if (error?.code === NOT_IN_WINDOW && !wrapped) {
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
      console.error(
        'react-x11 dev: uncaught error' + (info?.componentStack ?? ''),
        error,
      );
      setImmediate(() => {
        if (!mounted()) {
          log(`fix it and save: ${name} is mounted again on the next reload.`);
        }
      });
    },
  });

  // After a reload has re-rendered the edited components: take the dev
  // window away from a tree that now brings its own. The other direction
  // needs nothing here — a tree that lost its window throws NOT_IN_WINDOW,
  // and the handler above wraps it — and neither does a tree an error took
  // down: react-refresh keeps the roots that failed, and renders them again
  // on the next reload itself.
  const settle = () => {
    if (!wrapped || !mounted()) return;
    const { windows, drawn } = rootContent(root.app._rootChildren[0]);
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
