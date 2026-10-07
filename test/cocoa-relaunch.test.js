// Threaded mode by default on macOS (src/cocoa/relaunch.js): the rules for
// when an import of react-x11 moves the app onto a worker, and the worker's
// side of the hand-off — the main thread waits on shared memory until the
// worker asks for AppKit or says it is done, after every exit handler the
// app has, with its crash printed by itself, from the worker's first line
// on. Headless: the rules are a pure function, what tells an import made as
// the app starts from one made later is read in child processes of every
// shape, the hand-off is shared memory and an EventEmitter, and the
// worker's start is a child process whose worker never asks for AppKit.
import assert from 'node:assert';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect } from 'node:util';

import { relaunchVeto, WORKER_START } from '../src/cocoa/relaunch.js';
import { RELAUNCH, requestAppKit } from '../src/cocoa/threaded.js';
import { runNode } from './helpers/run-script.js';

const app = {
  isMainThread: true,
  platform: 'darwin',
  env: {},
  execArgv: [],
  node: 22,
  entry: '/Users/me/app.mjs',
  compiled: false,
  late: false,
};

test('an app on macOS, imported as it starts, moves onto a worker', () => {
  assert.strictEqual(relaunchVeto(app), null);
  assert.strictEqual(
    relaunchVeto({ ...app, env: { REACT_X11_BACKEND: 'cocoa' } }),
    null,
  );
  // under a loader too from Node 24 on, where tsx follows it onto the
  // worker; with flags that are no loader on any Node; and in Bun, whose
  // loaders are its own
  for (const change of [
    { node: 24, execArgv: ['--import', 'tsx'] },
    { node: 26, env: { NODE_OPTIONS: '--import=tsx' } },
    { node: 20, execArgv: ['--expose-gc', '--require', './setup.cjs'] },
    { node: 22, env: { NODE_OPTIONS: '--max-old-space-size=4096' } },
    { node: null, execArgv: ['--import', 'tsx'] },
  ]) {
    assert.strictEqual(
      relaunchVeto({ ...app, ...change }),
      null,
      inspect(change),
    );
  }
});

test('everything that keeps it where it is says why', () => {
  const cases = [
    [{ isMainThread: false }, 'not the main thread'],
    [{ platform: 'linux' }, 'not macOS'],
    [{ platform: 'win32' }, 'not macOS'],
    [{ env: { REACT_X11_THREADED: '0' } }, 'REACT_X11_THREADED=0'],
    [{ env: { REACT_X11_BACKEND: 'x11' } }, 'REACT_X11_BACKEND=x11'],
    [{ env: { REACT_X11_FRAME: '1' } }, 'a <Frame> pane'],
    [{ entry: null }, 'no entry script'],
    [{ compiled: true }, 'a single executable'],
    [{ env: { NODE_TEST_CONTEXT: 'child-v8' } }, 'a test runner'],
    [{ env: { NODE_ENV: 'test' } }, 'a test runner'],
    [{ env: { VITEST: 'true' } }, 'a test runner'],
    [{ late: true }, 'imported after the app started running'],
    [{ execArgv: ['--import', 'tsx'] }, 'an ES module loader before Node 24'],
    [
      { node: 20, execArgv: ['--import=tsx'] },
      'an ES module loader before Node 24',
    ],
    [
      { execArgv: ['--loader', 'ts-node/esm'] },
      'an ES module loader before Node 24',
    ],
    [
      { execArgv: ['--experimental-loader=./hooks.mjs'] },
      'an ES module loader before Node 24',
    ],
    [
      { env: { NODE_OPTIONS: '--max-old-space-size=4096 --import tsx' } },
      'an ES module loader before Node 24',
    ],
  ];
  for (const [change, reason] of cases) {
    assert.strictEqual(relaunchVeto({ ...app, ...change }), reason);
  }
});

test('an import Node evaluates as it starts the app is not late, and one the app makes once its own code has run is', async () => {
  // Static imports, an ES module entry's or a CommonJS one's, and a
  // preload's, run before the entry's body, so the worker repeats nothing
  // the app did; an import() is made by code that has run, which the worker
  // would run again. This is what decides the move, so it runs on any OS.
  // The event loop's first turn is the public signal, and wrong both ways:
  // Node 20 and 22 turn it while they load an ES module entry, and 24 and
  // later evaluate an import() the entry makes before it turns.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx11-start-'));
  try {
    const relaunch = new URL('../src/cocoa/relaunch.js', import.meta.url);
    const files = {
      // Reads the stack with an app's own settings in place, a limit that
      // shows no frame and a formatter, and says whether they are as it
      // left them. An Error the app froze keeps whatever it has. With it,
      // the flags and the Node the loader rule reads.
      'probe.mjs':
        "import { writeSync } from 'node:fs';\n" +
        `import { describeProcess } from ${JSON.stringify(relaunch.href)};\n` +
        'if (!Object.isFrozen(Error)) {\n' +
        '  Error.stackTraceLimit = 0;\n' +
        '  Error.prepareStackTrace = (error) => `${error}`;\n' +
        '}\n' +
        'const app = [Error.stackTraceLimit, Error.prepareStackTrace];\n' +
        'const { late, execArgv, node } = describeProcess(import.meta.url);\n' +
        'const kept =\n' +
        '  Error.stackTraceLimit === app[0] && Error.prepareStackTrace === app[1];\n' +
        'writeSync(1, JSON.stringify({ late, kept, execArgv, node }));\n',
      'static.mjs': "import './probe.mjs';\n",
      'nested.mjs': "import './static.mjs';\n",
      'static.cjs': "require('./probe.mjs');\n",
      'empty.mjs': '',
      'timer.mjs': "setTimeout(() => import('./probe.mjs'), 10);\n",
      'awaits.mjs':
        "globalThis.started = true;\nawait import('./probe.mjs');\n",
      'dynamic.cjs': "import('./probe.mjs');\n",
      'freeze.mjs': 'Object.freeze(Error);\n',
      'frozen.mjs': "import './freeze.mjs';\nimport './probe.mjs';\n",
    };
    for (const [name, source] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), source);
    }
    const at = (name) => path.join(dir, name);
    const probe = pathToFileURL(at('probe.mjs')).href;
    const cases = [
      ['a static import', [at('static.mjs')], false],
      ['a static import of a static import', [at('nested.mjs')], false],
      ['a require() of a CommonJS entry', [at('static.cjs')], false],
      ['an --import preload', ['--import', probe, at('empty.mjs')], false],
      [
        'a --require preload',
        ['--require', at('probe.mjs'), at('empty.mjs')],
        false,
      ],
      ['an import() from a timer', [at('timer.mjs')], true],
      ['an import() the entry awaits', [at('awaits.mjs')], true],
      ['an import() of a CommonJS entry', [at('dynamic.cjs')], true],
      // no stack to read: where the app is, rather than a throw at the
      // import, or a worker that runs the entry twice
      ['a static import, with Error frozen', [at('frozen.mjs')], true],
    ];
    const node = Number(process.versions.node.split('.')[0]);
    const runs = await Promise.all(cases.map(([, args]) => runNode(args)));
    cases.forEach(([how, args, late], i) => {
      const run = runs[i];
      assert.strictEqual(run.code, 0, `${how}: ${run.stderr}`);
      assert.deepStrictEqual(
        JSON.parse(run.stdout),
        { late, kept: true, execArgv: args.slice(0, -1), node },
        how,
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('node flags a Worker refuses to be handed do not stop the move, and the worker keeps every one', async () => {
  // `--expose-gc` is a V8 flag and `--title` a process-wide one: handed
  // either as execArgv, a Worker throws ERR_WORKER_INVALID_EXEC_ARGV, and
  // the app died at its import of react-x11. An `--import`, the way a
  // loader like tsx comes in, must still reach the worker, and its
  // `process.execArgv` must stay the process's, since whatever starts node
  // again from the worker — the bench's per-scenario children — passes it
  // on. So must `process.argv`: the worker starts on lines of react-x11's
  // own, and the entry is still the script the app was started with.
  const flags = [
    '--expose-gc',
    '--title=react-x11-relaunch',
    '--import',
    'data:text/javascript,globalThis.preloaded=true',
  ];
  const run = await runNode([
    ...flags,
    'test/fixtures/relaunch-node-flags.js',
    'report',
  ]);
  assert.strictEqual(run.code, 3, run.stderr);
  assert.deepStrictEqual(JSON.parse(run.stdout), {
    isMainThread: false,
    gc: 'function',
    title: 'react-x11-relaunch',
    preloaded: true,
    execArgv: flags,
    argv: [
      fileURLToPath(
        new URL('./fixtures/relaunch-node-flags.js', import.meta.url),
      ),
      'report',
    ],
  });
});

test('a worker that stops before its import of react-x11 says why, and the process ends with its code', async () => {
  // What an entry imports ahead of react-x11 runs again on the worker,
  // where a call only a main thread may make — process.chdir() — throws.
  // The worker used to learn how to end the process and print its crash
  // only once it reached react-x11, so one that died first did neither:
  // the main thread waited for ever, and nothing was printed, the error
  // included. A hang here is the timeout's kill, which reads as code 0.
  const run = await runNode(['test/fixtures/relaunch-early-death.js', 'chdir']);
  assert.strictEqual(run.code, 1, `${run.error?.signal ?? ''}\n${run.stderr}`);
  assert.match(
    run.stderr,
    /react-x11: the app stopped on its worker thread before reaching its import of react-x11 there\./,
  );
  // the worker's own error, printed once, under the word on why
  const error = 'process.chdir() is not supported in workers';
  assert.strictEqual(run.stderr.split(error).length, 2, run.stderr);
  // and the exit handler the app added had finished when the process ended
  assert.strictEqual(run.stdout, 'the exit handler ran to its end\n');
});

// The move for real, which needs macOS and a bridge that can run AppKit's
// loop — anywhere else nothing moves and there is nothing to keep.
const bridge = await (async () => {
  if (process.platform !== 'darwin') return null;
  try {
    const { loadNative } = await import('../src/cocoa/native.js');
    return loadNative();
  } catch {
    return null;
  }
})();
const noMove =
  typeof bridge?.runMain !== 'function' &&
  'needs macOS and a bridge with runMain() (@windowkit/appkit >= 0.10)';

/** Fork test/fixtures/relaunch-frame-pane.js as `<Frame>` forks a pane —
 * or, with `pane` false, the same fork with no pane in it. */
function forkPane(execArgv, pane) {
  const env = { ...process.env };
  // the runner's own mark would keep either where it is by itself
  delete env.NODE_TEST_CONTEXT;
  delete env.REACT_X11_FRAME;
  if (pane) env.REACT_X11_FRAME = '1';
  return new Promise((resolve) => {
    const child = fork(
      fileURLToPath(
        new URL('./fixtures/relaunch-frame-pane.js', import.meta.url),
      ),
      ['report'],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        execArgv,
        env,
        serialization: 'advanced',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const last = stdout.trim().split('\n').at(-1);
      resolve({ code, signal, stderr, report: last ? JSON.parse(last) : null });
    });
  });
}

test(
  'a <Frame> pane stays on its main thread, where the IPC channel to its host is',
  { skip: noMove },
  async () => {
    // A pane's entry (src/frame/child.js) talks to its host over the
    // channel fork() sets up, and the channel is the main thread's — a
    // worker has no `process.send` — while the pane has no AppKit for the
    // main thread to keep: its pixels reach the host through shared
    // IOSurfaces. Moved, every pane exited at once. Both ways in: the move
    // on import, and the launcher, which a pane gets whenever its host was
    // started under it, since the host's node flags follow into the fork.
    for (const [how, execArgv] of [
      ['on import', []],
      ['under the launcher', ['--import', './src/cocoa/main.js']],
    ]) {
      const pane = await forkPane(execArgv, true);
      assert.strictEqual(pane.code, 0, `${how}: ${pane.stderr}`);
      assert.deepStrictEqual(
        pane.report,
        { isMainThread: true, send: 'function' },
        how,
      );
      // the same fork with no pane in it moves: what keeps the pane where
      // it is is REACT_X11_FRAME, not something about this harness
      const app = await forkPane(execArgv, false);
      assert.strictEqual(app.code, 0, `${how}: ${app.stderr}`);
      assert.strictEqual(app.report?.isMainThread, false, how);
    }
  },
);

test(
  'an app started under a loader keeps its main thread before Node 24, and moves from 24 on',
  { skip: noMove },
  async () => {
    // tsx keeps its hooks to the main thread on Node 20 and 22, where a
    // worker without them cannot load a .jsx entry, and no loader can be
    // asked before the move, so there any --import keeps the app where it
    // is. The fork with no pane in it is an app that moves otherwise.
    const run = await forkPane(['--import', 'data:text/javascript,0'], false);
    assert.strictEqual(run.code, 0, run.stderr);
    assert.strictEqual(
      run.report?.isMainThread,
      Number(process.versions.node.split('.')[0]) < 24,
    );
  },
);

test(
  'an app that changes directory ahead of its import of react-x11 is told why it stopped, rather than left waiting',
  { skip: noMove },
  async () => {
    // The report as it came in, moved by the import for real: the main
    // thread runs the module that calls process.chdir() without a
    // complaint, moves the app, and the worker refuses the same call. It
    // used to hang with nothing printed; REACT_X11_THREADED=0 ran it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx11-early-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'setup.mjs'),
        `process.chdir(${JSON.stringify(dir)});\n`,
      );
      fs.writeFileSync(
        path.join(dir, 'entry.mjs'),
        "import './setup.mjs';\n" +
          `import ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};\n` +
          "console.error('the entry’s body ran');\n" +
          'process.exit(0);\n',
      );
      const run = await runNode([path.join(dir, 'entry.mjs')], {
        // the runner's mark would keep it where it is by itself, and so
        // would either switch in the environment this suite runs in
        NODE_TEST_CONTEXT: '',
        REACT_X11_THREADED: '',
        REACT_X11_BACKEND: '',
      });
      assert.strictEqual(
        run.code,
        1,
        `${run.error?.signal ?? ''}\n${run.stderr}`,
      );
      assert.match(
        run.stderr,
        /react-x11: the app stopped on its worker thread before reaching its import of react-x11 there\./,
      );
      assert.match(
        run.stderr,
        /process\.chdir\(\) is not supported in workers/,
      );
      assert.doesNotMatch(run.stderr, /the entry’s body ran/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('the first cocoa root asks the waiting main thread for AppKit, and waits for its run', async () => {
  const state = new Int32Array(new SharedArrayBuffer(8));
  let running = false;
  const asked = requestAppKit({ threaded: () => running }, state);
  assert.strictEqual(Atomics.load(state, 0), RELAUNCH.APPKIT);
  let done = false;
  asked.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(done, false, 'not before runMain runs');
  running = true;
  await asked;
  // a second root finds AppKit up and asks nothing
  await requestAppKit({ threaded: () => true }, state);
  assert.strictEqual(Atomics.load(state, 0), RELAUNCH.APPKIT);
});

/**
 * `WORKER_START` run against a stand-in for the worker's `process`, as the
 * worker runs it before the app's entry. `writeSync` is what it prints
 * through; `booted` says the app's import of react-x11 has run.
 */
function startWorker({ booted = false, writeSync } = {}) {
  const proc = new EventEmitter();
  proc.exitCode = undefined;
  const state = new Int32Array(new SharedArrayBuffer(8));
  const printed = [];
  const builtins = {
    'node:worker_threads': { workerData: { reactX11State: state.buffer } },
    'node:fs': {
      writeSync:
        writeSync ??
        ((fd, bytes, off) => {
          printed.push([fd, Buffer.from(bytes.subarray(off)).toString()]);
          return bytes.length - off;
        }),
    },
    'node:util': { inspect },
  };
  proc.getBuiltinModule = (name) => builtins[name];
  const global = {};
  if (booted) global[Symbol.for('react-x11.cocoa.workerBooted')] = true;
  new Function(`return ${WORKER_START}`)()(proc, global);
  return { proc, state, printed };
}

test('the worker says it is done after every exit handler the app has, however late it added one', () => {
  const { proc, state } = startWorker();
  // each handler sees the main thread still waiting: the end comes after
  // the last of them
  const seen = [];
  const handler = (name) => () => seen.push([name, Atomics.load(state, 0)]);
  proc.on('exit', handler('the app'));
  proc.once('exit', handler('the app, once'));
  proc.prependListener('exit', handler('the app, first'));
  proc.emit('exit', 4);
  assert.deepStrictEqual(seen, [
    ['the app, first', RELAUNCH.WAITING],
    ['the app', RELAUNCH.WAITING],
    ['the app, once', RELAUNCH.WAITING],
  ]);
  assert.deepStrictEqual([...state], [RELAUNCH.ENDED, 4]);

  // an exit that names no code ends with the one the app set
  const quiet = startWorker();
  quiet.proc.exitCode = 7;
  quiet.proc.emit('exit');
  assert.deepStrictEqual([...quiet.state], [RELAUNCH.ENDED, 7]);
});

test('the worker prints its own uncaught error, unless the app handles it, and says why when its import of react-x11 had not run', () => {
  const early = startWorker();
  early.proc.emit('uncaughtExceptionMonitor', new Error('nobody caught this'));
  assert.strictEqual(early.printed.length, 1);
  const [fd, text] = early.printed[0];
  assert.strictEqual(fd, 2);
  assert.match(
    text,
    /^react-x11: the app stopped on its worker thread before reaching its import of react-x11 there\. .*\nError: nobody caught this\n {4}at /,
  );
  // the section it sends the developer to is there
  assert.match(text, /See docs\/macos\.md, "What changes for an app"\./);
  const docs = fs.readFileSync(
    new URL('../docs/macos.md', import.meta.url),
    'utf8',
  );
  assert.match(docs, /^### What changes for an app$/m);

  const later = startWorker({ booted: true });
  later.proc.emit('uncaughtExceptionMonitor', new Error('after the import'));
  assert.deepStrictEqual(later.printed.length, 1);
  assert.match(later.printed[0][1], /^Error: after the import\n {4}at /);

  later.printed.length = 0;
  later.proc.on('uncaughtException', () => {});
  later.proc.emit('uncaughtExceptionMonitor', new Error('the app did'));
  assert.deepStrictEqual(later.printed, []);
});

test('the worker’s crash reaches stderr whole, through a pipe that is full', () => {
  const written = [];
  let full = true;
  const { proc } = startWorker({
    booted: true,
    writeSync(fd, bytes, off) {
      if (full) {
        full = false;
        throw Object.assign(new Error('resource temporarily unavailable'), {
          code: 'EAGAIN',
        });
      }
      const n = Math.min(3, bytes.length - off);
      written.push(Buffer.from(bytes.subarray(off, off + n)));
      return n;
    },
  });
  const err = new Error('a crash');
  proc.emit('uncaughtExceptionMonitor', err);
  assert.strictEqual(Buffer.concat(written).toString(), `${inspect(err)}\n`);
});
