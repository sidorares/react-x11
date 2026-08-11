// <foreign>: hosting another client's window.
//
// Two connections to node-x11's in-process X server — one renders the React
// tree, the other plays the application being embedded — because every claim
// worth making here is about a window we do not own. Whether it was
// reparented, whether it is still alive after an unmount, where the server
// thinks it is: a mock can only report the calls we chose to make, and the
// bug this element is most able to cause is destroying somebody else's
// window, which shows up as the window being *gone*, not as a call.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import React from 'react';
import xserver from 'x11/lib/xserver/index.js';
import { XEMBED, createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';
import { act } from '../src/testing/index.js';

const h = React.createElement;

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

/**
 * Drain until `predicate` holds. Embedding is a chain of awaited replies, so
 * a fixed number of settles is a guess — and layout lands on ntk's frame
 * clock, which is a *timer* behind a server fence rather than a reply, so
 * round trips alone can spin without ever letting a frame run.
 */
async function until(app, predicate, what) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await settle(app);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const queryTree = (app, wid) =>
  new Promise((resolve, reject) =>
    app.X.QueryTree(wid, (err, tree) => (err ? reject(err) : resolve(tree))),
  );

const geometry = (app, wid) =>
  new Promise((resolve, reject) =>
    app.X.GetGeometry(wid, (err, g) => (err ? reject(err) : resolve(g))),
  );

/** Does the server still have this window? The whole point of the release
 *  path — a client we handed back has to still exist. */
const alive = (app, wid) =>
  new Promise((resolve) => app.X.GetGeometry(wid, (err) => resolve(!err)));

/** Unmount before closing: an app that drops its connection mid-frame
 *  leaves work in flight, which surfaces as noise from the next test. */
async function teardown(x11Root, app, other) {
  await x11Root.unmount().catch(() => {});
  await settle(app);
  await app.close();
  await other.close();
}

/** A window belonging to the *other* connection, ready to be embedded. */
function foreignWindow(other, { xembed = false } = {}) {
  const wnd = other.createWindow({ x: 0, y: 0, width: 100, height: 60 });
  if (xembed) {
    // `_XEMBED_INFO` is what tells the socket the client speaks the
    // protocol; without it the socket reparents and maps, which is what
    // xterm -into and mpv --wid get.
    wnd.setProperty('_XEMBED_INFO', [XEMBED.VERSION, XEMBED.MAPPED], {
      type: '_XEMBED_INFO',
      format: 32,
    });
  }
  return wnd;
}

/** The <foreign> node under a rendered window instance. */
function foreignNode(instance) {
  const walk = (node) => {
    if (node.kind === 'foreign') return node;
    for (const child of node.children ?? []) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  const node = walk(instance._reactX11Node);
  assert.ok(node, 'the tree has a <foreign> node');
  return node;
}

test('<foreign> reparents the client into its own window, and never from render', async () => {
  const { app, other, xErrors } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const client = foreignWindow(other);
    await settle(other);

    const embedded = [];
    const instance = await render(
      h(
        'window',
        { width: 320, height: 240 },
        h('box', { style: { padding: 20, flexGrow: 1 } }, [
          h('foreign', {
            key: 'f',
            windowId: client.id,
            style: { flexGrow: 1 },
            onEmbedded: (info) => embedded.push(info),
          }),
        ]),
      ),
      x11Root,
    );

    const node = foreignNode(instance);
    await until(app, () => embedded.length > 0, 'the client to be embedded');

    // the client is a child of the socket's container window, which is a
    // child of the <window> — one reparent, into the node's own window
    const tree = await queryTree(app, node.socket.window.id);
    assert.deepEqual(tree.children, [client.id]);

    // yoga sized it: 320x240 window, 20px padding all round
    const geo = await geometry(app, client.id);
    assert.deepEqual(
      { width: geo.width, height: geo.height },
      { width: 280, height: 200 },
    );
    assert.deepEqual(node.rect, { x: 20, y: 20, width: 280, height: 200 });

    // no `_XEMBED_INFO` on the client: the plain-reparent path, which is
    // what almost everything embeddable actually wants
    assert.deepEqual(embedded[0].id, client.id);
    assert.equal(embedded[0].xembed, false);
    assert.equal(xErrors.length, 0, xErrors.map((e) => e.message).join(', '));

    await x11Root.unmount();
    await settle(app);
  } finally {
    await teardown(x11Root, app, other);
  }
});

test('a discarded render issues no X calls against the client', async () => {
  const { app, other } = await headlessPair();
  // mounting this tree throws on purpose; onUncaughtError is the channel for
  // it, and keeps the default (which sets process.exitCode) out of the way
  const x11Root = await createRoot({ app, onUncaughtError: () => {} });
  try {
    const client = foreignWindow(other);
    await settle(other);
    const before = (await queryTree(other, client.id)).parent;

    // A component that throws after its <foreign> child has been created:
    // React discards the whole render, so nothing it built may have touched
    // the server. This is the case the commit-phase rule exists for — a
    // ReparentWindow from a discarded render has moved the window for real.
    const Boom = () => {
      throw new Error('discarded');
    };
    // the request itself, not just its effect: a ReparentWindow that happened
    // to be a no-op here would still be one issued from a discarded render
    const reparents = [];
    const realReparent = app.X.ReparentWindow.bind(app.X);
    app.X.ReparentWindow = (...args) => {
      reparents.push(args);
      return realReparent(...args);
    };
    const failed = render(
      h('window', { width: 320, height: 240 }, [
        h('foreign', { key: 'f', windowId: client.id, style: { flexGrow: 1 } }),
        h(Boom, { key: 'b' }),
      ]),
      x11Root,
    ).then(
      () => null,
      (err) => err,
    );
    await failed;
    await settle(app);
    await settle(other);

    assert.deepEqual(reparents, [], 'no ReparentWindow was issued at all');
    assert.equal(
      (await queryTree(other, client.id)).parent,
      before,
      'the client is still where it was',
    );
    assert.ok(await alive(other, client.id), 'and still exists');
  } finally {
    await teardown(x11Root, app, other);
  }
});

test('unmount hands the client back to the root instead of destroying it', async () => {
  const { app, other, xErrors } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const client = foreignWindow(other);
    await settle(other);
    const root = other.display.screen[0].root;

    const embedded = [];
    await render(
      h(
        'window',
        { width: 320, height: 240 },
        h('foreign', {
          windowId: client.id,
          style: { flexGrow: 1 },
          onEmbedded: (info) => embedded.push(info),
        }),
      ),
      x11Root,
    );
    await until(app, () => embedded.length > 0, 'the client to be embedded');

    await x11Root.unmount();
    await settle(app);
    await settle(other);

    assert.ok(
      await alive(other, client.id),
      'the client survives the unmount — it is not ours to destroy',
    );
    assert.equal(
      (await queryTree(other, client.id)).parent,
      root,
      'and is a top-level window again',
    );
    assert.equal(xErrors.length, 0, xErrors.map((e) => e.message).join(', '));
  } finally {
    await teardown(x11Root, app, other);
  }
});

test('a layout change moves the client and tells it where it is', async () => {
  const { app, other } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const client = foreignWindow(other);
    // the synthetic ConfigureNotify (ICCCM 4.1.5) is the only way a client
    // inside somebody else's window learns its position on screen
    const configures = [];
    client.on('resize', (ev) => configures.push(ev));
    await client.selectInput(1 << 17); // StructureNotify
    await settle(other);

    const embedded = [];
    const tree = (padding) =>
      h(
        'window',
        { width: 320, height: 240 },
        h(
          'box',
          { style: { padding, flexGrow: 1 } },
          h('foreign', {
            windowId: client.id,
            style: { flexGrow: 1 },
            onEmbedded: (info) => embedded.push(info),
          }),
        ),
      );

    const instance = await render(tree(20), x11Root);
    const node = foreignNode(instance);
    await until(app, () => embedded.length > 0, 'the client to be embedded');
    await until(
      other,
      () => configures.length > 0,
      'the first ConfigureNotify',
    );

    await render(tree(40), x11Root);
    await until(app, () => node.rect.x === 40, 'the layout change');
    await settle(app);

    const geo = await geometry(app, client.id);
    assert.deepEqual(
      { width: geo.width, height: geo.height },
      { width: 240, height: 160 },
    );

    // Root-relative, which is the whole point: the client is a child of the
    // container and its *real* ConfigureNotify puts it at 0,0 inside it, so
    // an event carrying the position on screen can only be the synthetic
    // one. The origin is asked for rather than assumed — nothing here says
    // where a window manager would have put the toplevel.
    const origin = node.root.window._screenOrigin ?? { x: 0, y: 0 };
    const expected = {
      x: origin.x + 40,
      y: origin.y + 40,
      width: 240,
      height: 160,
    };
    await until(
      other,
      () =>
        configures.some(
          (c) =>
            c.x === expected.x &&
            c.y === expected.y &&
            c.width === expected.width &&
            c.height === expected.height,
        ),
      `a ConfigureNotify carrying ${JSON.stringify(expected)}; saw ${JSON.stringify(configures.map((c) => [c.x, c.y, c.width, c.height]))}`,
    );
  } finally {
    await teardown(x11Root, app, other);
  }
});

test('changing windowId releases the old client before embedding the new one', async () => {
  const { app, other, xErrors } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const first = foreignWindow(other);
    const second = foreignWindow(other);
    await settle(other);
    const root = other.display.screen[0].root;

    const embedded = [];
    const tree = (windowId) =>
      h(
        'window',
        { width: 320, height: 240 },
        h('foreign', {
          windowId,
          style: { flexGrow: 1 },
          onEmbedded: (info) => embedded.push(info),
        }),
      );

    const instance = await render(tree(first.id), x11Root);
    const node = foreignNode(instance);
    await until(app, () => embedded.length > 0, 'the first client');

    await render(tree(second.id), x11Root);
    await until(app, () => embedded.length > 1, 'the second client');
    await settle(other);

    assert.deepEqual(
      embedded.map((e) => e.id),
      [first.id, second.id],
    );
    assert.equal(
      (await queryTree(other, first.id)).parent,
      root,
      'the client that left is a top-level window again',
    );
    assert.deepEqual(
      (await queryTree(app, node.socket.window.id)).children,
      [second.id],
      'and the socket holds exactly the new one',
    );
    assert.ok(await alive(other, first.id));
    assert.equal(xErrors.length, 0, xErrors.map((e) => e.message).join(', '));

    await x11Root.unmount();
    await settle(app);
  } finally {
    await teardown(x11Root, app, other);
  }
});

test('a client destroyed out from under us reports gone, once', async () => {
  const { app, other, xErrors } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const client = foreignWindow(other);
    await settle(other);

    const embedded = [];
    const gone = [];
    const instance = await render(
      h(
        'window',
        { width: 320, height: 240 },
        h('foreign', {
          windowId: client.id,
          style: { flexGrow: 1 },
          onEmbedded: (info) => embedded.push(info),
          onClientGone: () => gone.push(1),
        }),
      ),
      x11Root,
    );
    const node = foreignNode(instance);
    await until(app, () => embedded.length > 0, 'the client to be embedded');

    client.destroy();
    await until(app, () => gone.length > 0, 'the client to go');
    await settle(app);
    assert.equal(gone.length, 1);
    assert.equal(node.client, null);

    // and nothing further is issued against the dead id
    await x11Root.unmount();
    await settle(app);
    assert.equal(xErrors.length, 0, xErrors.map((e) => e.message).join(', '));
  } finally {
    await teardown(x11Root, app, other);
  }
});

test('an XEmbed client is told it was embedded, and follows XEMBED_MAPPED', async () => {
  const { app, other } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const client = foreignWindow(other, { xembed: true });
    const messages = [];
    client.on('message', (ev) => messages.push(ev));
    await client.selectInput(1 << 17); // StructureNotify
    await settle(other);
    const xembedAtom = await client.atom('_XEMBED');

    const embedded = [];
    await render(
      h(
        'window',
        { width: 320, height: 240 },
        h('foreign', {
          windowId: client.id,
          style: { flexGrow: 1 },
          onEmbedded: (info) => embedded.push(info),
        }),
      ),
      x11Root,
    );
    await until(app, () => embedded.length > 0, 'the client to be embedded');
    await until(other, () => messages.length > 0, 'XEMBED_EMBEDDED_NOTIFY');

    assert.equal(embedded[0].xembed, true, 'the client speaks the protocol');
    const notify = messages.find((m) => m.message_type === xembedAtom);
    assert.ok(notify, '_XEMBED message received');
    assert.equal(notify.data[1], XEMBED.EMBEDDED_NOTIFY);
  } finally {
    await teardown(x11Root, app, other);
  }
});

test('focus: activation and focus-in go out in that order, and Tab carries its direction', async () => {
  const { app, other } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const client = foreignWindow(other, { xembed: true });
    const messages = [];
    client.on('message', (ev) => messages.push(ev));
    await settle(other);
    const xembedAtom = await client.atom('_XEMBED');
    const opcodes = () =>
      messages
        .filter((m) => m.message_type === xembedAtom)
        .map((m) => m.data[1]);

    const embedded = [];
    const instance = await render(
      h('window', { width: 320, height: 240 }, [
        h('box', { key: 't', focusable: true, style: { height: 10 } }),
        h('foreign', {
          key: 'f',
          windowId: client.id,
          style: { flexGrow: 1 },
          onEmbedded: (info) => embedded.push(info),
        }),
      ]),
      x11Root,
    );
    const node = foreignNode(instance);
    await until(app, () => embedded.length > 0, 'the client to be embedded');
    await until(
      other,
      () => opcodes().includes(XEMBED.EMBEDDED_NOTIFY),
      'the notify',
    );

    // the window has to hold the X focus for a node's focus to be real
    node.root.events.windowFocused = true;
    node.focus();
    await until(other, () => opcodes().includes(XEMBED.FOCUS_IN), 'FOCUS_IN');

    const sent = opcodes();
    assert.ok(
      sent.indexOf(XEMBED.WINDOW_ACTIVATE) < sent.indexOf(XEMBED.FOCUS_IN),
      `activate before focus-in, got ${sent.join(',')}`,
    );
    const focusIn = messages
      .filter((m) => m.message_type === xembedAtom)
      .find((m) => m.data[1] === XEMBED.FOCUS_IN);
    assert.equal(
      focusIn.data[2],
      XEMBED.FOCUS_CURRENT,
      'a focus() call does not disturb the client’s own focus',
    );

    // a back-Tab into the node asks it to focus its *last* widget
    node.root.events.focus(null);
    await settle(other);
    node.root.events._cycleFocus(true);
    await until(
      other,
      () =>
        messages
          .filter((m) => m.message_type === xembedAtom)
          .some(
            (m) =>
              m.data[1] === XEMBED.FOCUS_IN && m.data[2] === XEMBED.FOCUS_LAST,
          ),
      'FOCUS_IN with detail LAST',
    );
    assert.equal(node.focused, true);
  } finally {
    await teardown(x11Root, app, other);
  }
});

test('XEMBED_REQUEST_FOCUS goes through the focus manager; FOCUS_NEXT leaves through it', async () => {
  const { app, other } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const client = foreignWindow(other, { xembed: true });
    await settle(other);

    const embedded = [];
    const requested = [];
    const instance = await render(
      h('window', { width: 320, height: 240 }, [
        h('foreign', {
          key: 'f',
          windowId: client.id,
          style: { flexGrow: 1 },
          onEmbedded: (info) => embedded.push(info),
          onRequestFocus: () => requested.push(1),
        }),
        h('box', { key: 't', focusable: true, style: { height: 10 } }),
      ]),
      x11Root,
    );
    const node = foreignNode(instance);
    await until(app, () => embedded.length > 0, 'the client to be embedded');
    node.root.events.windowFocused = true;

    // The client talks back to the socket window, addressed to it in both
    // senses — delivered there and *about* it, which is what the spec says
    // and what the routing needs (events reach a window by the id in them).
    const socket = other.createWindow({ id: node.socket.window.id });
    await socket.sendClientMessage('_XEMBED', [
      0,
      XEMBED.REQUEST_FOCUS,
      0,
      0,
      0,
    ]);
    await until(app, () => requested.length > 0, 'the focus request');
    assert.equal(node.focused, true, 'the focus manager moved focus here');

    // …and the client running off the end of its own tab chain continues
    // into ours, rather than stopping at the socket
    await socket.sendClientMessage('_XEMBED', [0, XEMBED.FOCUS_NEXT, 0, 0, 0]);
    await until(app, () => !node.focused, 'focus to move on');
    assert.equal(
      node.root.events.focusManager.focused.kind,
      'box',
      'the next react-x11 focusable has it',
    );
  } finally {
    await teardown(x11Root, app, other);
  }
});

test('keys reach the app first and are forwarded only if it does not consume them', async () => {
  const { app, other } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const client = foreignWindow(other);
    await settle(other);

    const embedded = [];
    const seen = [];
    const instance = await render(
      h(
        'window',
        {
          width: 320,
          height: 240,
          // an application chord, bound above the pane the way a real one is
          onKeyDown: (ev) => {
            seen.push(ev.keysym);
            if (ev.ctrlKey) ev.preventDefault();
          },
        },
        h('foreign', {
          windowId: client.id,
          style: { flexGrow: 1 },
          onEmbedded: (info) => embedded.push(info),
        }),
      ),
      x11Root,
    );
    const node = foreignNode(instance);
    await until(app, () => embedded.length > 0, 'the client to be embedded');
    node.root.events.windowFocused = true;
    node.focus();

    const sends = [];
    const realSendEvent = app.X.SendEvent.bind(app.X);
    app.X.SendEvent = (destination, propagate, mask, ev, cb) => {
      sends.push({ destination, ev });
      return realSendEvent(destination, propagate, mask, ev, cb);
    };

    const key = (buttons) => ({
      type: 2,
      name: 'KeyPress',
      seq: 1,
      keycode: 38,
      time: 100,
      root: other.display.screen[0].root,
      wid: node.root.window.id,
      child: 0,
      rootx: 5,
      rooty: 5,
      x: 5,
      y: 5,
      buttons,
      sameScreen: 1,
    });

    node.root.window.emit('keydown', key(0));
    await settle(app);
    assert.equal(seen.length, 1, 'the app saw the key');
    assert.equal(
      sends.filter((s) => s.destination === client.id).length,
      1,
      'and it was forwarded, re-addressed to the client',
    );
    assert.equal(sends.at(-1).ev.wid, client.id);

    // Ctrl held: the app consumed it, so nothing is forwarded. This is the
    // rule that makes a chord bound by the application beat the client.
    node.root.window.emit('keydown', key(4));
    await settle(app);
    assert.equal(seen.length, 2);
    assert.equal(
      sends.filter((s) => s.destination === client.id).length,
      1,
      'the consumed chord was not forwarded',
    );
  } finally {
    await teardown(x11Root, app, other);
  }
});

test('<foreign> adopts a window put inside it, and hands out the id to put it in', async () => {
  const { app, other } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const ready = [];
    const embedded = [];
    await render(
      h(
        'window',
        { width: 320, height: 240 },
        h('foreign', {
          style: { flexGrow: 1 },
          onReady: (info) => ready.push(info),
          onEmbedded: (info) => embedded.push(info),
        }),
      ),
      x11Root,
    );
    assert.equal(ready.length, 1, 'the container id is offered immediately');
    await settle(app);

    // what `xterm -into ID` does: create a window as a child of the id it
    // was given, rather than a top-level someone reparents
    const client = other.createWindow({
      parent: { id: ready[0].windowId, app: other, X: other.X },
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    await settle(other);
    await until(app, () => embedded.length > 0, 'the adopted client');
    assert.equal(embedded[0].id, client.id);
    assert.equal(embedded[0].xembed, false);
  } finally {
    await teardown(x11Root, app, other);
  }
});

test('<foreign> takes no children', async () => {
  const { app, other } = await headlessPair();
  const x11Root = await createRoot({ app, onUncaughtError: () => {} });
  try {
    // act() is what rethrows a mount error; a bare render() swallows it
    const err = await act(() =>
      x11Root.render(
        h(
          'window',
          { width: 320, height: 240 },
          h('foreign', { windowId: 1 }, h('box', {})),
        ),
      ),
    ).then(
      () => null,
      (e) => e,
    );
    assert.match(String(err), /<foreign> takes no children/);
  } finally {
    await teardown(x11Root, app, other);
  }
});
