// The DevTools integration against the *real* react-devtools-core backend,
// driven over the bridge the standalone app would drive it over: a
// WebSocket server here stands in for the DevTools frontend, sends it the
// same messages, and reads what comes back.
//
// The unit tests in smoke.test.js drive our own agent listeners with a fake
// agent, which proves the drawing but not that the backend ever calls them.
// That half is what this file is for — every feature below is one the
// backend only offers a host that answers a particular way, and a version
// bump that changes the offer should fail here rather than in someone's
// window.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import React from 'react';
import { createMockApp } from './helpers/mock-app.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The DevTools frontend, near enough: a socket that records what the app
 * says and can say things back. The bridge batches, so everything here
 * waits for an event rather than assuming it has arrived. */
async function fakeDevTools() {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.on('listening', resolve));
  const received = [];
  let socket = null;
  const connected = new Promise((resolve) => {
    server.on('connection', (ws) => {
      socket = ws;
      ws.on('message', (data) => received.push(JSON.parse(data.toString())));
      resolve(ws);
    });
  });
  return {
    port: server.address().port,
    connected,
    received,
    send: (event, payload) => socket.send(JSON.stringify({ event, payload })),
    async waitFor(event, timeout = 5000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const hit = received.find((m) => m.event === event);
        if (hit) return hit;
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for "${event}"; saw ` +
              [...new Set(received.map((m) => m.event))].join(', '),
          );
        }
        await sleep(20);
      }
    },
    async close() {
      socket?.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('the DevTools backend drives the overlays, the picker and the style editor', async (t) => {
  const devtools = await fakeDevTools();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'react-x11-dt-'));
  const stateFile = path.join(stateDir, 'devtools.json');
  process.env.REACT_X11_DEVTOOLS = '1';
  process.env.REACT_X11_DEVTOOLS_PORT = String(devtools.port);
  process.env.REACT_X11_DEVTOOLS_STATE = stateFile;
  t.after(async () => {
    delete process.env.REACT_X11_DEVTOOLS;
    delete process.env.REACT_X11_DEVTOOLS_PORT;
    delete process.env.REACT_X11_DEVTOOLS_STATE;
    // A backend whose socket closes reconnects forever (handleClose ->
    // scheduleRetry), which is what an app wants and what would keep this
    // process alive after the last assertion. Every timer from here on is
    // unref'd, so the retries continue without being a reason to stay up.
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...rest) => {
      const timer = realSetTimeout(fn, ms, ...rest);
      timer.unref?.();
      return timer;
    };
    await devtools.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  // imported after the environment is set: the hook installs from here
  const { createRoot } = await import('../src/index.js');

  let bump;
  function Counter() {
    const [n, setN] = React.useState(0);
    bump = () => setN((value) => value + 1);
    return React.createElement('box', {
      style: { width: 60, height: 20, backgroundColor: n ? 'red' : 'blue' },
    });
  }

  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 100 },
      React.createElement(Counter),
    ),
  );
  await devtools.connected;
  await devtools.waitFor('operations');
  const wnd = app.windows[0];
  const box = wnd._reactX11Node.children[0];
  const outlines = (from) =>
    wnd.ctx.ops
      .slice(from)
      .filter(
        ([op, color]) => op === 'stroke' && String(color).startsWith('#'),
      );

  // 1. the style editor is offered at all, with our style vocabulary
  const advert = await devtools.waitFor('isNativeStyleEditorSupported');
  assert.strictEqual(advert.payload.isSupported, true);
  assert.ok(
    advert.payload.validAttributes?.includes('padding'),
    'the editor is told which attributes an element takes',
  );

  // 2. "highlight updates when components render": the backend asks for
  // tracing, a commit produces outlines, and its own clock expires them
  devtools.send('setTraceUpdatesEnabled', true);
  await sleep(200);
  const beforeCommit = wnd.ctx.ops.length;
  bump();
  await sleep(400);
  assert.ok(
    outlines(beforeCommit).length > 0,
    'the re-rendered node is outlined in the colour the backend chose',
  );
  await sleep(1600); // DISPLAY_DURATION, plus the redraw that clears it
  const afterExpiry = wnd.ctx.ops.length;
  await sleep(300);
  assert.deepStrictEqual(
    outlines(afterExpiry),
    [],
    'and stops being painted once the backend stops sending it',
  );

  // 3. the element picker: with no DOM to listen on, the backend hands the
  // pointer over and waits to be told what was picked
  devtools.send('startInspectingHost', false);
  await sleep(200);
  wnd.emit('mousemove', { x: 30, y: 10 });
  await sleep(50);
  wnd.emit('mousedown', { x: 30, y: 10, keycode: 1 });
  wnd.emit('mouseup', { x: 30, y: 10, keycode: 1 });
  const selected = await devtools.waitFor('selectElement');
  assert.strictEqual(
    typeof selected.payload,
    'number',
    'an element id comes back for whatever was under the pointer',
  );
  const stopped = await devtools.waitFor('stopInspectingHost');
  assert.strictEqual(stopped.payload, true, 'and picking mode ends');

  // 4. the style editor, on a host element — the default filters hide
  // those, and a component id has no style to edit
  devtools.send('updateComponentFilters', []);
  await sleep(300);
  const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const [rendererID] = [...hook.rendererInterfaces.keys()];
  const renderer = hook.rendererInterfaces.get(rendererID);
  const id = renderer.getElementIDForHostInstance(box);
  devtools.send('NativeStyleEditor_measure', { id, rendererID });
  const measured = await devtools.waitFor('NativeStyleEditor_styleAndLayout');
  assert.deepStrictEqual(
    measured.payload.style,
    { width: 60, height: 20, backgroundColor: 'red' },
    'the flattened style is what the editor shows',
  );
  assert.strictEqual(measured.payload.layout?.width, 60);
  assert.strictEqual(measured.payload.layout?.height, 20);

  // editing a value goes through the reconciler's own override path, so
  // the app really re-renders and really re-lays-out
  devtools.send('NativeStyleEditor_setValue', {
    id,
    rendererID,
    name: 'width',
    value: 120,
  });
  await sleep(400);
  assert.strictEqual(box.abs.width, 120, 'the edited style took effect');

  // 5. a setting changed in the DevTools UI is on disk for the next run
  devtools.send('updateHookSettings', {
    appendComponentStack: true,
    breakOnConsoleErrors: false,
    showInlineWarningsAndErrors: true,
    hideConsoleLogsInStrictMode: false,
  });
  await sleep(300);
  const stored = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.deepStrictEqual(
    JSON.parse(stored['react-x11:hookSettings']).showInlineWarningsAndErrors,
    true,
    'hook settings are written where the next run reads them',
  );

  await x11Root.unmount();
});

// "Reload and start profiling" restarts the app with profiling already on —
// the only way to profile a mount. A browser reloads the page; this re-execs
// the process, which has to keep the node flags, the argv and the session
// state a reload would have kept.
test('reload-and-profile re-execs the app with its flags intact', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'react-x11-reload-'));
  const module = fileURLToPath(
    new URL('../src/DevToolsIntegration.js', import.meta.url),
  );
  const script = path.join(dir, 'restart.mjs');
  await fs.writeFile(
    script,
    `import { reloadAndProfile } from ${JSON.stringify(module)};
     if (process.env.REACT_X11_DEVTOOLS_PROFILING) {
       console.log(JSON.stringify({
         argv: process.argv.slice(1),
         execArgv: process.execArgv,
         profiling: process.env.REACT_X11_DEVTOOLS_PROFILING,
         session: process.env.REACT_X11_DEVTOOLS_SESSION,
         devtools: process.env.REACT_X11_DEVTOOLS,
       }));
       process.exit(0);
     }
     global.sessionStorage = { toJSON: () => ({ selection: '3' }) };
     reloadAndProfile(true, false);\n`,
  );
  try {
    const child = spawn(
      process.execPath,
      ['--title=react-x11-reload-test', script, '--an-argument'],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.strictEqual(code, 0);
    const restarted = JSON.parse(out.trim().split('\n').at(-1));
    assert.deepStrictEqual(restarted.argv, [script, '--an-argument']);
    assert.deepStrictEqual(restarted.execArgv, [
      '--title=react-x11-reload-test',
    ]);
    assert.deepStrictEqual(JSON.parse(restarted.profiling), {
      recordChangeDescriptions: true,
      recordTimeline: false,
    });
    assert.deepStrictEqual(
      JSON.parse(restarted.session),
      { selection: '3' },
      'the selection survives the restart, as it would a page reload',
    );
    assert.strictEqual(
      restarted.devtools,
      '1',
      'the app that comes back has DevTools enabled whatever launched it',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
