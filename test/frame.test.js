// <Frame>: a pane of the application in its own process (docs/frame.md).
//
// Three altitudes, because the feature is three claims:
//
//  - The **protocol** is pure and is tested pure: callback ids survive the
//    updates they should and not the ones they should not, and what a stub's
//    arguments lose crossing the wire is exactly the functions.
//  - The **pane lifecycle** runs end to end in this process, over the
//    transport seam `<Frame transport>` exists for: a real module import, a
//    real second root on a second connection to the in-process X server, a
//    real embed — with `structuredClone` on every message so nothing
//    crosses here that would not survive the fork's serialization.
//  - The **fork** is real once: a child process, the default transport, a
//    TCP bridge onto the same in-process server — because the seam covers
//    everything except the boundary itself.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';

import React from 'react';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';
import { Frame } from '../src/frame/index.js';
import {
  CallbackTable,
  reviveCallbacks,
  sanitizeArgs,
} from '../src/frame/protocol.js';
import { ThemeProvider } from '../src/components/theme.js';
import { Session } from './fixtures/frame-contexts.js';
import { loopbackFrameFactory } from './helpers/frame-loopback.js';

const h = React.createElement;

const PANE = new URL('./fixtures/frame-pane.js', import.meta.url);

// ---------------------------------------------------------------- protocol

test('callback ids: stable for stable functions, one update of grace', () => {
  const warnings = [];
  const table = new CallbackTable({ warn: (msg) => warnings.push(msg) });
  const stable = () => {};
  let hits = [];
  const first = table.snapshot({ keep: stable, drop: () => hits.push('old') });
  const keepId = first.keep.$$reactX11FrameCallback;
  const dropId = first.drop.$$reactX11FrameCallback;
  assert.equal(typeof keepId, 'number');

  const second = table.snapshot({ keep: stable, next: () => {} });
  // a function the app kept keeps its id…
  assert.equal(second.keep.$$reactX11FrameCallback, keepId);
  // …and one from the previous snapshot still lands: the grace window
  assert.equal(table.invoke(dropId), true);
  assert.deepEqual(hits, ['old']);

  table.snapshot({ keep: stable });
  // two snapshots later it is gone, with a warning rather than a wrong call
  assert.equal(table.invoke(dropId), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /outlived two props updates/);
});

test('revive + sanitize: stubs call home, functions do not cross back', () => {
  const table = new CallbackTable();
  const got = [];
  const wire = structuredClone(
    table.snapshot({
      deep: { list: [{ onPick: (row, ev) => got.push({ row, ev }) }] },
    }),
  );
  const sent = [];
  const revived = reviveCallbacks(wire, (id, args) => {
    sent.push({ id, args });
    table.invoke(id, args);
  });
  revived.deep.list[0].onPick(42, { preventDefault: () => {}, kept: 'yes' });
  assert.equal(got.length, 1);
  assert.equal(got[0].row, 42);
  assert.equal(got[0].ev.kept, 'yes');
  // the function was dropped, not the object around it
  assert.equal('preventDefault' in got[0].ev, false);
  // and what went over the wire was already clean
  assert.equal(typeof sent[0].args[1], 'object');
});

test('sanitizeArgs keeps cycles and non-function leaves', () => {
  const ring = { name: 'a', fn: () => {} };
  ring.self = ring;
  const [clean] = sanitizeArgs([ring]);
  assert.equal(clean.name, 'a');
  assert.equal(clean.self, clean);
  assert.equal('fn' in clean, false);
  // …and survives the clone the transport will apply
  structuredClone(clean);
});

// ------------------------------------------------------ in-process pane

async function headlessPair() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const connect = async (onXError) => {
    const [serverEnd, clientEnd] = xserver.createStreamPair();
    server.addClientStream(serverEnd);
    return createClient({
      stream: clientEnd,
      fontSource: new StaticFontSource(),
      onXError,
    });
  };
  const xErrors = [];
  return {
    server,
    xErrors,
    app: await connect((err) => xErrors.push(err)),
    other: await connect(() => {}),
  };
}

const render = (element, x11Root) =>
  new Promise((resolve) => x11Root.render(element, resolve));

const settle = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => setImmediate(resolve)));

/** Drain until `predicate` (possibly async) holds. */
async function until(app, predicate, what, { tries = 400, delay = 2 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await predicate()) return;
    await settle(app);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const queryTree = (app, wid) =>
  new Promise((resolve, reject) =>
    app.X.QueryTree(wid, (err, tree) => (err ? reject(err) : resolve(tree))),
  );

const alive = (app, wid) =>
  new Promise((resolve) => app.X.GetGeometry(wid, (err) => resolve(!err)));

async function teardown(x11Root, app, other) {
  await x11Root.unmount().catch(() => {});
  await settle(app);
  await app.close();
  await other.close();
}

test('a pane runs behind the seam: props, callbacks, theme, context, close', async () => {
  const { app, other } = await headlessPair();
  const x11Root = await createRoot({ app });
  const factory = loopbackFrameFactory({ childApp: other });
  const reports = [];
  const closed = [];
  const exits = [];
  const started = [];
  const onReport = (data, extras) => reports.push({ data, extras });
  const onClosed = (word, extras) => closed.push({ word, extras });

  const tree = ({ label, accent, mounted = true }) =>
    h(
      'window',
      { width: 320, height: 240 },
      h(
        ThemeProvider,
        { value: { accent } },
        h(
          Session.Provider,
          { value: { user: 'ada' } },
          mounted
            ? h(Frame, {
                src: PANE,
                transport: factory,
                props: { label, onReport, onClosed },
                style: { flexGrow: 1 },
                onStarted: (info) => started.push(info),
                onExit: (info) => exits.push(info),
              })
            : h('box', {}),
        ),
      ),
    );

  try {
    const instance = await render(
      tree({ label: 'one', accent: '#123456' }),
      x11Root,
    );

    await until(app, () => reports.length >= 1, 'the first report');
    // props, the bridged theme and the bridged context all arrived in the
    // pane's first paint-worth of state — no default-theme frame first
    assert.deepEqual(reports[0].data, {
      label: 'one',
      accent: '#123456',
      user: 'ada',
    });
    // callback args crossed sanitized: the function is gone, the data kept
    assert.equal(reports[0].extras.kept, 'yes');
    assert.equal('preventDefault' in reports[0].extras, false);
    // `ready` races the pane's own first effects (children's effects run
    // first), so the started event is waited for, not assumed
    await until(app, () => started.length === 1, 'onStarted');
    assert.equal(typeof started[0].windowId, 'number');

    // the pane's window really is inside ours: toplevel → container → pane
    let paneWid = null;
    await until(
      app,
      async () => {
        const top = await queryTree(app, instance.id);
        if (top.children.length !== 1) return false;
        const container = await queryTree(app, top.children[0]);
        if (container.children.length !== 1) return false;
        paneWid = container.children[0];
        return true;
      },
      'the pane window inside the container',
    );
    assert.equal(paneWid, started[0].windowId);

    // a props change is one update; so is a theme change, through the env
    await render(tree({ label: 'two', accent: '#123456' }), x11Root);
    await until(
      app,
      () => reports.some((r) => r.data.label === 'two'),
      'the props update',
    );
    await render(tree({ label: 'two', accent: '#654321' }), x11Root);
    await until(
      app,
      () => reports.some((r) => r.data.accent === '#654321'),
      'the theme update',
    );

    // unmount: close handlers flush through callbacks, then a clean exit
    await render(
      tree({ label: 'two', accent: '#654321', mounted: false }),
      x11Root,
    );
    const done = await factory.sessions[0].done;
    assert.equal(done.code, 0);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].word, 'closing');
    assert.equal('flush' in closed[0].extras, false);
    await until(app, () => exits.length === 1, 'the exit event');
    assert.equal(exits[0].expected, true);
    assert.equal(factory.sessions[0].kills.length, 0);
    // the pane window belonged to the pane's root, which unmounted
    await until(
      app,
      async () => !(await alive(app, paneWid)),
      'the pane window to be destroyed by its own root',
    );
  } finally {
    await teardown(x11Root, app, other);
  }
});

test('a crash shows the fallback; restart() gets a fresh pane', async () => {
  const { app, other } = await headlessPair();
  const x11Root = await createRoot({ app });
  const factory = loopbackFrameFactory({ childApp: other });
  const reports = [];
  const exits = [];
  const fallbacks = [];
  const handle = React.createRef();

  const tree = ({ crash }) =>
    h(
      'window',
      { width: 320, height: 240 },
      h(Frame, {
        ref: handle,
        src: PANE,
        transport: factory,
        props: { label: 'boom', crash, onReport: (d) => reports.push(d) },
        style: { flexGrow: 1 },
        fallback: ({ error, restart }) => {
          fallbacks.push({ message: error?.message, phase: error?.phase });
          return h('box', { style: { flexGrow: 1 } });
        },
        onExit: (info) => exits.push(info),
      }),
    );

  try {
    await render(tree({ crash: true }), x11Root);
    await until(app, () => exits.length === 1, 'the crash exit');
    assert.equal(exits[0].expected, false);
    assert.equal(factory.sessions[0].exitCode, 1);
    await until(app, () => fallbacks.length >= 1, 'the fallback render');
    assert.match(fallbacks[0].message, /pane asked to crash/);
    assert.equal(fallbacks[0].phase, 'runtime');

    // stop crashing, then ask the handle for a fresh pane
    await render(tree({ crash: false }), x11Root);
    handle.current.restart();
    await until(app, () => reports.length >= 1, 'the pane after restart');
    assert.equal(reports[0].label, 'boom');
    assert.equal(factory.sessions.length, 2);
  } finally {
    await teardown(x11Root, app, other);
  }
});

test('a src that does not resolve fails as load, not as a hang', async () => {
  const { app, other } = await headlessPair();
  const x11Root = await createRoot({ app });
  const factory = loopbackFrameFactory({ childApp: other });
  const errors = [];
  try {
    await render(
      h(
        'window',
        { width: 200, height: 100 },
        h(Frame, {
          src: '/frame-pane-that-does-not-exist.js',
          transport: factory,
          style: { flexGrow: 1 },
          fallback: ({ error }) => {
            errors.push(error);
            return null;
          },
        }),
      ),
      x11Root,
    );
    await until(app, () => errors.length >= 1, 'the load failure');
    assert.equal(errors[0].phase, 'load');
    assert.equal(factory.sessions[0].exitCode, 1);
  } finally {
    await teardown(x11Root, app, other);
  }
});

// ------------------------------------------------------------- real fork

/** The in-process server, listening where a real display would: the child
 * process connects to `127.0.0.1:<n>` and lands on the same server the
 * parent reached over a stream pair. */
async function tcpDisplay(server) {
  const bridge = net.createServer((socket) => server.addClientStream(socket));
  for (let n = 91; n <= 99; n++) {
    const ok = await new Promise((resolve) => {
      bridge.once('error', () => resolve(false));
      bridge.listen(6000 + n, '127.0.0.1', () => resolve(true));
    });
    if (ok) return { bridge, display: `127.0.0.1:${n}` };
  }
  throw new Error('no free port for the frame fork test');
}

test('the default transport forks a real pane process', async () => {
  const { app, other, server } = await headlessPair();
  const x11Root = await createRoot({ app });
  const { bridge, display } = await tcpDisplay(server);
  const reports = [];
  const exits = [];
  const started = [];

  const tree = (mounted) =>
    h(
      'window',
      { width: 320, height: 240 },
      h(
        ThemeProvider,
        { value: { accent: '#abcdef' } },
        h(
          Session.Provider,
          { value: { user: 'grace' } },
          mounted
            ? h(Frame, {
                src: PANE,
                display,
                props: {
                  label: 'forked',
                  onReport: (data) => reports.push(data),
                },
                style: { flexGrow: 1 },
                onStarted: (info) => started.push(info),
                onExit: (info) => exits.push(info),
              })
            : h('box', {}),
        ),
      ),
    );

  try {
    const instance = await render(tree(true), x11Root);
    await until(app, () => reports.length >= 1, 'the forked pane report', {
      tries: 4000,
      delay: 5,
    });
    // theme and context crossed a real process boundary
    assert.deepEqual(reports[0], {
      label: 'forked',
      accent: '#abcdef',
      user: 'grace',
    });
    await until(app, () => started.length === 1, 'the forked onStarted', {
      tries: 4000,
      delay: 5,
    });
    assert.equal(typeof started[0].pid, 'number');
    await until(
      app,
      async () => {
        const top = await queryTree(app, instance.id);
        if (top.children.length !== 1) return false;
        const container = await queryTree(app, top.children[0]);
        return container.children.length === 1;
      },
      'the forked pane window inside the container',
      { tries: 4000, delay: 5 },
    );

    await render(tree(false), x11Root);
    await until(app, () => exits.length === 1, 'the forked pane exit', {
      tries: 4000,
      delay: 5,
    });
    assert.equal(exits[0].expected, true);
    assert.equal(exits[0].code, 0);
  } finally {
    bridge.close();
    await teardown(x11Root, app, other);
  }
});
