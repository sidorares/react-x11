// `react-x11 dev <file>` (src/cli/). The sessions run the command for real in
// a child process — test/fixtures/dev/driver.mjs, which is the bin with the
// mock app where the display would be — write the app's files into a scratch
// directory, edit them while it runs, and read what came out: the command's
// own `DEV` lines, and a RENDER line from the app's effect carrying its
// useState id, its code version and the tree it is mounted in. The rest are
// the pieces the sessions cannot reach: argument handling through the real
// bin, the package-manager guess and the install prompt.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeDevTools } from './helpers/fake-devtools.js';
import {
  DevError,
  ensureToolchain,
  installCommand,
  packageManagerFor,
  reactX11For,
} from '../src/cli/dev.js';

// A port nobody listens on, so the sessions run with DevTools on — the
// command's default — without reaching a DevTools the developer has open.
const NO_DEVTOOLS = await new Promise((resolve) => {
  const probe = createServer().listen(0, () => {
    const { port } = probe.address();
    probe.close(() => resolve(String(port)));
  });
});

const supported = typeof nodeModule.registerHooks === 'function';
const skip = supported ? false : 'module.registerHooks needs Node >= 22.15';

const repo = fileURLToPath(new URL('..', import.meta.url));
const bin = join(repo, 'src/cli/index.js');
const driver = join(repo, 'test/fixtures/dev/driver.mjs');
const { version } = nodeModule.createRequire(import.meta.url)(
  '../package.json',
);

/** An app module whose effect reports who it is and where it is mounted. */
function component({
  version: v = 'v1',
  body = '<box style={{ width: 60, height: 24 }} />',
  head = '',
  declaration = 'export default function App()',
} = {}) {
  return `import React from 'react';
${head}
const VERSION = '${v}';

${declaration} {
  const [id] = React.useState(() => Math.random().toString(36).slice(2, 10));
  React.useEffect(() => {
    console.log(\`RENDER \${id} \${VERSION} \${globalThis.devTree()}\`);
  });
  return ${body};
}
`;
}

const OWN_WINDOW =
  '<window title="mine"><box style={{ width: 60, height: 24 }} /></window>';
const THROWS = "(() => { throw new Error('boom'); })()";

let sessions = 0;

/**
 * Run the command on `entry` among `files`, in a directory of their own
 * inside test/fixtures — so `react` and react-x11 resolve from this checkout
 * — with that directory as the working one, so the command names the files
 * the way a developer would see them.
 */
function devSession(files, entry = 'app.jsx', args = [], env = {}) {
  const dir = join(
    repo,
    'test/fixtures',
    `dev-run-${process.pid}-${sessions++}`,
  );
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(dir, name), source);
  }
  const child = spawn(process.execPath, [driver, join(dir, entry), ...args], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      REACT_X11_CLICK_TO_COMPONENT: undefined,
      REACT_X11_DEVTOOLS: undefined,
      REACT_X11_DEVTOOLS_PORT: NO_DEVTOOLS,
      REACT_X11_DEVTOOLS_STATE: join(
        tmpdir(),
        `react-x11-dev-dt-${process.pid}.json`,
      ),
      ...env,
    },
  });
  let stdout = '';
  let stderr = '';
  let cursor = 0;
  const waiters = new Set();
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const check of [...waiters]) check();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    for (const check of [...waiters]) check();
  });
  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    /** The next match of `pattern` past the last one this returned. */
    next(pattern, what = String(pattern)) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const match = stdout.slice(cursor).match(pattern);
          if (!match) return;
          waiters.delete(check);
          clearTimeout(timer);
          cursor += match.index + match[0].length;
          resolve(match);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new Error(
              `timed out waiting for ${what}\n--- stdout ---\n${stdout}\n` +
                `--- stderr ---\n${stderr}`,
            ),
          );
        }, 30_000);
        waiters.add(check);
        check();
      });
    },
    /**
     * Rewrite one of the files. The first edit waits for the watcher to
     * settle on the fresh tree, or the change can race its registration.
     */
    async write(name, source) {
      if (!this.settled) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        this.settled = true;
      }
      writeFileSync(join(dir, name), source);
    },
    stop() {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const RENDER = (v) => new RegExp(`RENDER (\\w+) ${v} (.*)\\n`);
const DEV_WINDOW = 'window(app.jsx — react-x11 dev)[box]';

test(
  'one file, no <window>: shown in a window of its own, and saving it reloads in place',
  { skip },
  async () => {
    const s = devSession({ 'app.jsx': component() });
    try {
      const first = await s.next(RENDER('v1'), 'the first render');
      assert.strictEqual(first[2], DEV_WINDOW);
      assert.match(s.stdout, /DEV app\.jsx renders no <window>/);
      // on by default under dev
      assert.match(s.stdout, /click-to-component enabled/);
      // the render that found no window committed nothing: one mount
      assert.strictEqual(s.stdout.match(/RENDER /g).length, 1);

      await s.write('app.jsx', component({ version: 'v2' }));
      const second = await s.next(RENDER('v2'), 'the hot re-render');
      assert.strictEqual(second[1], first[1], 'useState survives the reload');
      assert.strictEqual(second[2], DEV_WINDOW);
      await s.next(/DEV reloaded app\.jsx\n/, 'the reload line');
      assert.strictEqual(s.stderr, '');
    } finally {
      s.stop();
    }
  },
);

test(
  'a tree with its own <window> is mounted as it is, and sees its own argv',
  { skip },
  async () => {
    const s = devSession(
      {
        'app.jsx': component({
          body: OWN_WINDOW,
          head: 'console.log(`ARGV ${JSON.stringify(process.argv.slice(1))}`);',
        }),
      },
      'app.jsx',
      ['--size', 'large'],
    );
    try {
      const first = await s.next(RENDER('v1'), 'the first render');
      assert.strictEqual(first[2], 'window(mine)[box]');
      await s.next(/READY/);
      assert.doesNotMatch(s.stdout, /renders no <window>/);
      // what `node app.jsx --size large` would have handed it
      const [, argv] = s.stdout.match(/ARGV (.*)\n/);
      assert.deepStrictEqual(JSON.parse(argv).slice(1), ['--size', 'large']);
      assert.match(JSON.parse(argv)[0], /app\.jsx$/);
    } finally {
      s.stop();
    }
  },
);

test(
  'the window is decided again on every reload, both ways',
  { skip },
  async () => {
    const s = devSession({ 'app.jsx': component() });
    try {
      assert.strictEqual((await s.next(RENDER('v1')))[2], DEV_WINDOW);

      // gains a <window>: the dev window goes, rather than holding it nested
      await s.write('app.jsx', component({ version: 'v2', body: OWN_WINDOW }));
      await s.next(/DEV app\.jsx renders its own <window> now/);
      const own = await s.next(/RENDER (\w+) v2 (window\(mine\)\[box\])\n/);
      assert.ok(own, 'mounted in its own window alone');

      // loses it again: back into one
      await s.write('app.jsx', component({ version: 'v3' }));
      await s.next(/DEV app\.jsx renders no <window>/);
      assert.strictEqual((await s.next(RENDER('v3')))[2], DEV_WINDOW);
    } finally {
      s.stop();
    }
  },
);

const WINDOWS = (...titles) =>
  new RegExp(
    `WINDOWS ${JSON.stringify(titles).replace(/[[\]().|]/g, '\\$&')}\\n`,
  );
const ERROR_WINDOW = 'app.jsx — error';
const APP_WINDOW = 'app.jsx — react-x11 dev';

test(
  'a render that throws is shown in a window, and the save that fixes it brings the app back',
  { skip },
  async () => {
    const s = devSession({ 'app.jsx': component() });
    try {
      await s.next(RENDER('v1'));
      await s.write('app.jsx', component({ version: 'v2', body: THROWS }));
      await s.next(/DEV thrown rendering App\. Fix it and save/);
      // the app's tree is down, and the error window stands in for it
      await s.next(WINDOWS(ERROR_WINDOW), 'the error window alone');
      assert.match(s.stderr, /Error: boom/);

      await s.write('app.jsx', component({ version: 'v3' }));
      assert.strictEqual((await s.next(RENDER('v3')))[2], DEV_WINDOW);
      await s.next(WINDOWS(APP_WINDOW), 'the app back, the error window gone');
      // tried once per save: the reload that threw does not retry it
      assert.strictEqual(s.stdout.match(/DEV thrown rendering/g).length, 1);
      assert.strictEqual(s.stderr.match(/Error: boom/g).length, 1);
    } finally {
      s.stop();
    }
  },
);

test(
  'a first render that throws opens the error window, and a save mounts the app',
  { skip },
  async () => {
    const s = devSession({ 'app.jsx': component({ body: THROWS }) });
    try {
      await s.next(WINDOWS(ERROR_WINDOW), 'the error window');
      await s.write('app.jsx', component({ version: 'v2' }));
      assert.strictEqual((await s.next(RENDER('v2')))[2], DEV_WINDOW);
      await s.next(WINDOWS(APP_WINDOW));
    } finally {
      s.stop();
    }
  },
);

test(
  'a save that does not compile is shown beside the running app, which keeps its state',
  { skip },
  async () => {
    const s = devSession({ 'app.jsx': component() });
    try {
      const first = await s.next(RENDER('v1'));
      await s.write(
        'app.jsx',
        component({ version: 'v2' }).replace('return', 'return <'),
      );
      await s.next(
        WINDOWS(APP_WINDOW, ERROR_WINDOW),
        'the error window beside the app',
      );

      await s.write('app.jsx', component({ version: 'v3' }));
      // gone once the file compiles, before the reload renders it
      await s.next(WINDOWS(APP_WINDOW), 'the error window gone');
      const fixed = await s.next(RENDER('v3'));
      assert.strictEqual(fixed[1], first[1], 'the app was never unmounted');
    } finally {
      s.stop();
    }
  },
);

test(
  'a file that mounts its own root runs as it is, and what it imports reloads',
  { skip },
  async () => {
    const main = `import React from 'react';
import ReactX11 from '../../../src/index.js';
import * as Mock from '../../../src/testing/mock-app.js';
import App from './app.jsx';

globalThis.devApp = Mock.createMockApp();
const root = await ReactX11.createRoot({ app: globalThis.devApp });
root.render(<App />);
`;
    const s = devSession(
      { 'main.jsx': main, 'app.jsx': component({ body: OWN_WINDOW }) },
      'main.jsx',
    );
    try {
      const first = await s.next(RENDER('v1'));
      assert.strictEqual(first[2], 'window(mine)[box]', 'one window, its own');
      await s.next(/DEV main\.jsx mounted a root of its own/);
      await s.next(/READY/);
      assert.doesNotMatch(s.stdout, /opens another window/);

      await s.write('app.jsx', component({ version: 'v2', body: OWN_WINDOW }));
      const second = await s.next(RENDER('v2'));
      assert.strictEqual(second[1], first[1]);
      assert.strictEqual(second[2], 'window(mine)[box]');
    } finally {
      s.stop();
    }
  },
);

test(
  'a file that mounts itself and exports its component is told every save opens a window',
  { skip },
  async () => {
    const app = component({
      body: OWN_WINDOW,
      head: `import ReactX11 from '../../../src/index.js';
import * as Mock from '../../../src/testing/mock-app.js';`,
    }).concat(`
globalThis.devApp = Mock.createMockApp();
const root = await ReactX11.createRoot({ app: globalThis.devApp });
root.render(<App />);
`);
    const s = devSession({ 'app.jsx': app });
    try {
      await s.next(/DEV app\.jsx mounted a root of its own/);
      await s.next(
        /DEV app\.jsx also exports only components[^\n]*another window/,
      );
    } finally {
      s.stop();
    }
  },
);

test(
  'a module that cannot reload in place says why, before the first save is wasted',
  { skip },
  async () => {
    const s = devSession({
      'app.jsx': component({
        declaration: 'export default function ()',
        head: 'export const answer = 42;',
      }),
    });
    try {
      const [line] = await s.next(
        /DEV saving app\.jsx will not reload it[^\n]*/,
      );
      assert.match(line, /default export is not a component/);
      assert.match(line, /answer is not/);
      // and it still runs
      await s.next(RENDER('v1'));
    } finally {
      s.stop();
    }
  },
);

/** `promise`, or `fallback` once `ms` have passed. */
const within = (promise, ms, fallback) =>
  Promise.race([
    promise,
    new Promise((resolve) => setTimeout(resolve, ms, fallback)),
  ]);

test(
  'React DevTools started after the app attaches to it, and saving still reloads',
  { skip },
  async () => {
    const devtools = await fakeDevTools();
    await devtools.close();
    // the port the app will retry, and nothing listening there yet
    const s = devSession({ 'app.jsx': component() }, 'app.jsx', [], {
      REACT_X11_DEVTOOLS_PORT: String(devtools.port),
    });
    let late = null;
    try {
      const first = await s.next(RENDER('v1'), 'the first render');
      await new Promise((resolve) => setTimeout(resolve, 300));
      late = await fakeDevTools({ port: devtools.port });
      assert.strictEqual(
        await within(
          late.connected.then(() => 'connected'),
          10_000,
          'none',
        ),
        'connected',
      );
      await late.waitFor('operations');
      // Refresh patches the hook DevTools installed, not one of its own
      await s.write('app.jsx', component({ version: 'v2' }));
      const second = await s.next(RENDER('v2'), 'the hot re-render');
      assert.strictEqual(second[1], first[1], 'useState survives the reload');
    } finally {
      s.stop();
      await late?.close();
    }
  },
);

test(
  'REACT_X11_CLICK_TO_COMPONENT=0 and REACT_X11_DEVTOOLS=0 turn the two off, an editor named or not',
  { skip },
  async () => {
    const devtools = await fakeDevTools();
    const s = devSession({ 'app.jsx': component() }, 'app.jsx', [], {
      REACT_X11_CLICK_TO_COMPONENT: '0',
      REACT_X11_EDITOR: 'code',
      REACT_X11_DEVTOOLS: '0',
      REACT_X11_DEVTOOLS_PORT: String(devtools.port),
    });
    try {
      // installing it logs before the root is made, so ahead of this
      await s.next(RENDER('v1'), 'the first render');
      assert.doesNotMatch(s.stdout, /click-to-component/);
      assert.strictEqual(
        await within(
          devtools.connected.then(() => 'connected'),
          2500,
          'none',
        ),
        'none',
      );
    } finally {
      s.stop();
      await devtools.close();
    }
  },
);

/** Run the real bin, to completion. */
function cli(args, { cwd = repo, env = {} } = {}) {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [bin, ...args],
    {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    },
  );
  return { status, stdout, stderr };
}

test('the bin: usage, version and the arguments it refuses', () => {
  const bare = cli([]);
  assert.strictEqual(bare.status, 2);
  assert.match(bare.stderr, /^Usage: react-x11 dev <file>/);

  const help = cli(['dev', '--help']);
  assert.strictEqual(help.status, 0);
  assert.match(help.stdout, /^Usage:/);

  assert.strictEqual(cli(['--version']).stdout, `${version}\n`);

  const unknown = cli(['start', 'app.jsx']);
  assert.strictEqual(unknown.status, 2);
  assert.match(unknown.stderr, /no command "start"/);

  const noFile = cli(['dev']);
  assert.strictEqual(noFile.status, 2);
  assert.match(noFile.stderr, /which file\?/);

  const option = cli(['dev', '--port', 'app.jsx']);
  assert.strictEqual(option.status, 2);
  assert.match(
    option.stderr,
    /no option --port — options after the file are the app's/,
  );

  const missing = cli(['dev', 'no-such-app.jsx']);
  assert.strictEqual(missing.status, 1);
  assert.strictEqual(
    missing.stderr,
    'react-x11 dev: no-such-app.jsx: no such file.\n',
  );
});

test(
  'the bin refuses what it cannot run, saying what to change',
  { skip },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'react-x11-dev-'));
    try {
      writeFileSync(join(dir, 'app.tsx'), 'export default () => null;\n');
      const ts = cli(['dev', 'app.tsx'], { cwd: dir });
      assert.strictEqual(ts.status, 1);
      assert.match(
        ts.stderr,
        /TypeScript is not supported yet; rename the file to \.jsx/,
      );

      // no react-x11 where the file is: an install line, not a resolve error
      writeFileSync(join(dir, 'app.jsx'), 'export default function App() {}\n');
      const outside = cli(['dev', 'app.jsx'], { cwd: dir });
      assert.strictEqual(outside.status, 1);
      assert.match(
        outside.stderr,
        /app\.jsx cannot import react-x11[\s\S]*npm install react-x11 react/,
      );

      const production = cli(['dev', join(repo, 'examples/tasks.jsx')], {
        env: { NODE_ENV: 'production' },
      });
      assert.strictEqual(production.status, 1);
      assert.match(production.stderr, /NODE_ENV is 'production'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// Only the half that holds in this process: `npm test` runs under tsx, which
// applies tsconfig.json's `paths` — `react-x11` mapped at the declarations —
// to every file, so here even a file outside any project finds this
// checkout. The bin runs under plain node, and the test above holds it to
// the other half: a file that imports no react-x11 is told to install it.
test('reactX11For finds the copy a file imports', () => {
  assert.strictEqual(
    reactX11For(join(repo, 'examples/tasks.jsx')),
    repo.replace(/\/$/, ''),
  );
});

test('packageManagerFor reads the nearest lockfile, then the launcher', () => {
  const dir = mkdtempSync(join(tmpdir(), 'react-x11-pm-'));
  try {
    const app = join(dir, 'packages', 'app');
    mkdirSync(app, { recursive: true });
    assert.strictEqual(packageManagerFor(app, ''), 'npm');
    assert.strictEqual(
      packageManagerFor(app, 'pnpm/9.12.0 npm/? node/v22.15.0'),
      'pnpm',
    );
    writeFileSync(join(dir, 'yarn.lock'), '');
    assert.strictEqual(
      packageManagerFor(app, 'pnpm/9.12.0'),
      'yarn',
      'a lockfile wins',
    );
    writeFileSync(join(app, 'bun.lock'), '');
    assert.strictEqual(packageManagerFor(app, ''), 'bun', 'the nearest one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepStrictEqual(installCommand('pnpm', ['a@^1']), [
    'pnpm',
    'add',
    '--save-dev',
    'a@^1',
  ]);
  assert.deepStrictEqual(installCommand('yarn', ['a@^1']), [
    'yarn',
    'add',
    '--dev',
    'a@^1',
  ]);
  assert.deepStrictEqual(installCommand('bun', ['a@^1']), [
    'bun',
    'add',
    '--dev',
    'a@^1',
  ]);
  assert.deepStrictEqual(installCommand('npm', ['a@^1']), [
    'npm',
    'install',
    '--save-dev',
    'a@^1',
  ]);
});

test('ensureToolchain: asks, installs the pinned versions, or prints the command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'react-x11-tc-'));
  writeFileSync(join(dir, 'package-lock.json'), '{}');
  const absent = new Set(['@babel/core', 'react-refresh/babel']);
  const resolveSpecifier = (specifier) => {
    if (absent.has(specifier)) throw new Error(`Cannot find ${specifier}`);
    return specifier;
  };
  const { peerDependencies } = nodeModule.createRequire(import.meta.url)(
    '../package.json',
  );
  const pinned = [
    `@babel/core@${peerDependencies['@babel/core']}`,
    `react-refresh@${peerDependencies['react-refresh']}`,
  ];
  const lines = [];
  const base = {
    projectDir: dir,
    log: (line) => lines.push(line),
    resolveSpecifier,
  };
  try {
    assert.strictEqual(
      await ensureToolchain({ ...base, resolveSpecifier: (s) => s }),
      'ready',
    );

    // no terminal to ask on: the command, with the versions, and no install
    await assert.rejects(
      ensureToolchain({
        ...base,
        interactive: false,
        run: () => assert.fail('ran'),
      }),
      (err) =>
        err instanceof DevError &&
        err.message.includes('@babel/core, react-refresh') &&
        err.message.includes(
          `npm install --save-dev '${pinned[0]}' '${pinned[1]}'`,
        ),
    );

    // asked, and the answer is no
    await assert.rejects(
      ensureToolchain({
        ...base,
        interactive: true,
        ask: async () => 'n',
        run: () => assert.fail('ran'),
      }),
      /not installed\. To install them yourself/,
    );

    // asked, and Enter means yes: the project's package manager, in the project
    const ran = [];
    assert.strictEqual(
      await ensureToolchain({
        ...base,
        interactive: true,
        ask: async (question) => (ran.push(question), ''),
        run: (argv, cwd) => (ran.push({ argv, cwd }), 0),
      }),
      'installed',
    );
    assert.match(ran[0], /\[Y\/n\] $/);
    assert.deepStrictEqual(ran[1], {
      argv: ['npm', 'install', '--save-dev', ...pinned],
      cwd: dir,
    });

    // and an install that fails says so
    await assert.rejects(
      ensureToolchain({
        ...base,
        interactive: true,
        ask: async () => 'y',
        run: () => 1,
      }),
      /failed \(exit 1\)/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
