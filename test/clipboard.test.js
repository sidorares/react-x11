// The userland clipboard, against a real ICCCM peer.
//
// Two ntk clients on node-x11's in-process X server, the pattern from
// test/dnd.test.js: one owns selections through ntk's clipboard, the other
// reads them through `useClipboard()`'s facade. What is asserted is the
// layer react-x11 adds — the type vocabulary and the timestamps — not the
// selection machinery underneath, which is ntk's and tested there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot, useApp, useClipboard } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function headlessPair() {
  const server = xserver.createServer({ width: 320, height: 240 });
  const connect = async () => {
    const [serverEnd, clientEnd] = xserver.createStreamPair();
    server.addClientStream(serverEnd);
    return createClient({
      stream: clientEnd,
      fontSource: new StaticFontSource(),
    });
  };
  return { app: await connect(), peer: await connect() };
}

/** The facade, without a React tree in the way. `useClipboard` is a
 * `useMemo` over exactly this. */
async function clipboardOf(app) {
  const { createClipboard } = await import('../src/clipboard.js');
  return createClipboard(app);
}

// --- the vocabulary ---------------------------------------------------------

test("read('text') finds a flavour readText() cannot", async () => {
  const { app, peer } = await headlessPair();
  try {
    // A GTK-ish owner that offers only the modern MIME name. ntk's own
    // read() asks UTF8_STRING and then STRING, so it has nothing to ask
    // for — which is exactly the gap the group walk exists to close.
    await peer.clipboard.write({ 'text/plain;charset=utf-8': 'κόσμε' });
    const clipboard = await clipboardOf(app);

    await assert.rejects(
      () => clipboard.readText(),
      /refused|cannot convert|no owner/,
      'the plain text path has no target to ask for',
    );
    assert.equal(await clipboard.read('text'), 'κόσμε');
  } finally {
    await app.close();
    await peer.close();
  }
});

test("read('text') prefers the best flavour when several are offered", async () => {
  const { app, peer } = await headlessPair();
  try {
    await peer.clipboard.write({
      'text/plain;charset=utf-8': 'best',
      'text/plain': 'worse',
      STRING: 'worst',
    });
    const clipboard = await clipboardOf(app);
    assert.equal(await clipboard.read('text'), 'best');
  } finally {
    await app.close();
    await peer.close();
  }
});

test('readFiles() parses what a file manager copies, and is [] otherwise', async () => {
  const { app, peer } = await headlessPair();
  try {
    const clipboard = await clipboardOf(app);
    await peer.clipboard.write({
      'text/uri-list':
        'file:///home/u/My%20Doc.pdf\r\n# a comment\r\nfile://otherhost/x\r\n',
    });
    assert.deepEqual(await clipboard.readFiles(), [
      { uri: 'file:///home/u/My%20Doc.pdf', path: '/home/u/My Doc.pdf' },
      { uri: 'file://otherhost/x' }, // remote: no local path
    ]);

    await peer.clipboard.write('just text');
    assert.deepEqual(
      await clipboard.readFiles(),
      [],
      'no file flavour is an empty list, not a throw',
    );
  } finally {
    await app.close();
    await peer.close();
  }
});

test('read() answers null for a type the owner does not have', async () => {
  const { app, peer } = await headlessPair();
  try {
    await peer.clipboard.write('text only');
    const clipboard = await clipboardOf(app);
    assert.equal(await clipboard.read('image/png'), null);
  } finally {
    await app.close();
    await peer.close();
  }
});

test('write() offers several flavours of one thing; clear() gives it back', async () => {
  const { app, peer } = await headlessPair();
  try {
    const clipboard = await clipboardOf(app);
    await clipboard.write({
      'text/html': '<b>hi</b>',
      'text/plain': 'hi',
    });
    const offered = await peer.clipboard.targets();
    for (const t of ['text/html', 'text/plain']) {
      assert.ok(offered.includes(t), `${t} offered, got ${offered.join(', ')}`);
    }
    assert.equal(
      (await peer.clipboard.read({ target: 'text/html' })).toString('utf8'),
      '<b>hi</b>',
    );

    await clipboard.clear();
    assert.deepEqual(await peer.clipboard.targets(), []);
  } finally {
    await app.close();
    await peer.close();
  }
});

test('PRIMARY is a separate selection, reachable through the same calls', async () => {
  const { app, peer } = await headlessPair();
  try {
    const clipboard = await clipboardOf(app);
    await clipboard.writeText('for ctrl-v');
    await clipboard.writeText('for middle click', { selection: 'PRIMARY' });
    assert.equal(await peer.clipboard.read(), 'for ctrl-v');
    assert.equal(
      await peer.clipboard.read({ selection: 'PRIMARY' }),
      'for middle click',
    );
  } finally {
    await app.close();
    await peer.close();
  }
});

// --- the React surface ------------------------------------------------------

test('useClipboard() reaches the app the tree renders onto', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  let clipboard = null;
  function Copier() {
    clipboard = useClipboard();
    return h('box', { style: { width: 10, height: 10 } });
  }
  x11Root.render(h('window', { width: 100, height: 100 }, h(Copier)));
  await tick();

  assert.ok(clipboard, 'the hook resolved');
  await clipboard.writeText('from a component');
  assert.deepEqual(app.clipboard.writes.at(-1).data, 'from a component');
  assert.equal(await clipboard.read('text'), 'from a component');
  await x11Root.unmount();
});

test('useApp() hands back the connection, and says so when there is none', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  let seen = null;
  function Probe() {
    seen = useApp();
    return null;
  }
  x11Root.render(h('window', { width: 100, height: 100 }, h(Probe)));
  await tick();
  assert.equal(seen, app, 'the same app createRoot was given');
  await x11Root.unmount();
});

test('useApp() explains itself when the tree has no provider above it', async () => {
  // Reached by rendering react-x11 components under another renderer, which
  // is why it is an error with a sentence in it rather than a null. Driven
  // through the provider directly: `createRoot` always installs one, so
  // there is no way to get here through the public entry point.
  const { AppProvider } = await import('../src/appcontext.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const errors = [];
  function Probe() {
    try {
      useApp();
    } catch (err) {
      errors.push(err.message);
    }
    return null;
  }
  x11Root.render(
    h(
      'window',
      { width: 100, height: 100 },
      h(AppProvider, { value: null }, h(Probe)),
    ),
  );
  await tick();
  assert.match(errors[0] ?? '', /inside a tree rendered by createRoot/);
  await x11Root.unmount();
});

test('a copy carries the timestamp of the keystroke behind it', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  let clipboard = null;
  function Copier() {
    clipboard = useClipboard();
    return h('box', { style: { width: 50, height: 50 } });
  }
  x11Root.render(h('window', { width: 100, height: 100 }, h(Copier)));
  await tick();
  await tick();

  const wnd = app.windows[0];
  wnd.emit('keydown', { keycode: 40, codepoint: 0x63, buttons: 4, time: 4242 });
  await clipboard.writeText('copied');
  assert.equal(
    app.clipboard.writes.at(-1).time,
    4242,
    'ICCCM 2.1: the event that caused the copy, not "now"',
  );

  // an explicit time still wins — a caller with a better one is believed
  await clipboard.writeText('again', { time: 7 });
  assert.equal(app.clipboard.writes.at(-1).time, 7);
  await x11Root.unmount();
});

test('watch() reports the clipboard going empty', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  let clipboard = null;
  function Probe() {
    clipboard = useClipboard();
    return null;
  }
  x11Root.render(h('window', { width: 100, height: 100 }, h(Probe)));
  await tick();

  const seen = [];
  const unwatch = await clipboard.watch((ev) => seen.push(ev.owner));
  await clipboard.writeText('something');
  await clipboard.clear();
  assert.deepEqual(seen, [1, 0], 'owned, then unowned');

  unwatch();
  await clipboard.writeText('after');
  assert.deepEqual(seen, [1, 0], 'unwatch stops the callbacks');
  await x11Root.unmount();
});
