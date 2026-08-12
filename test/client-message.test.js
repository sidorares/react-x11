// `<window onClientMessage>` and the two selection timestamps, against a real
// server: react-x11 on one connection to node-x11's in-process X server, a
// plain X client on a second sending the messages. The point of doing it over
// the wire rather than by emitting on the ntk window is that a ClientMessage's
// whole promise is that it comes from *another process* — the tray client, the
// window manager, the other copy of this application.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot, lastInputTime, serverTime } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;

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

const settle = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => setImmediate(resolve)));

async function until(app, predicate, what) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await settle(app);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const render = (element, root) =>
  new Promise((resolve) => root.render(element, resolve));

const intern = (X, name) =>
  new Promise((resolve, reject) =>
    X.InternAtom(false, name, (err, atom) =>
      err ? reject(err) : resolve(atom),
    ),
  );

/** A ClientMessage from the other client, aimed at the window itself —
 * event mask 0, which is what a message to another application's window
 * takes (SubstructureNotify is for the ones aimed at the root). */
function send(peer, wid, atom, data, format = 32) {
  peer.X.SendClientMessage(wid, wid, atom, format, data, 0);
}

// --- the seam ---------------------------------------------------------------

test('onClientMessage names the atom and carries the payload', async () => {
  const { app, peer } = await headlessPair();
  const root = await createRoot({ app });
  try {
    const seen = [];
    const instance = await render(
      h('window', {
        width: 100,
        height: 80,
        onClientMessage: (ev) => seen.push(ev),
      }),
      root,
    );
    // interned on the *peer* only: an application receiving a protocol it
    // does not send still gets the name, because an atom belongs to the
    // server rather than to a connection
    const opcode = await intern(peer.X, '_NET_SYSTEM_TRAY_OPCODE');
    send(peer, instance.id, opcode, [0, 0, 12345, 0, 0]);
    await until(app, () => seen.length === 1, 'the message to arrive');

    const ev = seen[0];
    assert.equal(ev.messageType, '_NET_SYSTEM_TRAY_OPCODE');
    assert.equal(ev.atom, opcode);
    assert.equal(ev.type, 33, 'X ClientMessage');
    assert.equal(ev.format, 32);
    assert.deepEqual(ev.data, [0, 0, 12345, 0, 0]);
    assert.equal(ev.window, instance, 'the window it was delivered to');
    assert.equal(ev.target, instance);
    assert.equal(ev.defaultPrevented, false);
    await root.unmount();
  } finally {
    await app.close();
    await peer.close();
  }
});

test('a format-8 payload arrives as its 20 bytes', async () => {
  // The tray's balloon messages are format 8, and a reader that assumed 5
  // longs would silently truncate them to nothing.
  const { app, peer } = await headlessPair();
  const root = await createRoot({ app });
  try {
    const seen = [];
    const instance = await render(
      h('window', {
        width: 100,
        height: 80,
        onClientMessage: (ev) => seen.push(ev),
      }),
      root,
    );
    const atom = await intern(peer.X, '_NET_SYSTEM_TRAY_MESSAGE_DATA');
    const bytes = Array.from({ length: 20 }, (_, i) => 65 + i);
    send(peer, instance.id, atom, bytes, 8);
    await until(app, () => seen.length === 1, 'the message to arrive');

    assert.equal(seen[0].format, 8);
    assert.deepEqual(seen[0].data, bytes);
    await root.unmount();
  } finally {
    await app.close();
    await peer.close();
  }
});

test('an atom the server itself does not know comes through as null', async () => {
  // The only case left after the round trip: a sender naming an atom that
  // was never created. `atom` is still exact, so a handler can log it.
  const { app, peer } = await headlessPair();
  const root = await createRoot({ app });
  try {
    const seen = [];
    const instance = await render(
      h('window', {
        width: 100,
        height: 80,
        onClientMessage: (ev) => seen.push(ev),
      }),
      root,
    );
    const bogus = 0x00ffffff;
    send(peer, instance.id, bogus, [1, 2, 3, 4, 5]);
    await until(app, () => seen.length === 1, 'the message to arrive');

    assert.equal(seen[0].messageType, null, 'no name to give');
    assert.equal(seen[0].atom, bogus, 'the id is still exact');
    await root.unmount();
  } finally {
    await app.close();
    await peer.close();
  }
});

test('messages are delivered in the order they were sent', async () => {
  // What the chunked protocols depend on: _NET_SYSTEM_TRAY_BEGIN_MESSAGE and
  // the _NET_SYSTEM_TRAY_MESSAGE_DATA pieces that follow it reassemble by
  // arrival order and nothing else. Naming an atom this connection has never
  // seen takes a round trip, and this is the case that says every message
  // behind it waits rather than overtaking it.
  const { app, peer } = await headlessPair();
  const root = await createRoot({ app });
  try {
    const seen = [];
    const instance = await render(
      h('window', {
        width: 100,
        height: 80,
        onClientMessage: (ev) => seen.push(ev.data[0]),
      }),
      root,
    );
    // WM_NAME is predefined, so the app connection has it already; the other
    // two are interned on the peer alone, which is exactly the "a protocol
    // this application only receives" case — each costs one GetAtomName.
    const known = app.X.atoms.WM_NAME;
    const cold = await intern(peer.X, '_ORDERING_COLD');
    const colder = await intern(peer.X, '_ORDERING_COLDER');
    assert.equal(app.X.atom_names[cold], undefined, 'genuinely unknown here');

    // interleaved, so a dispatch that let a synchronous message past a
    // pending lookup would scramble them rather than merely lag
    const order = [known, cold, known, colder, cold, known, colder, known];
    order.forEach((atom, i) => send(peer, instance.id, atom, [i, 0, 0, 0, 0]));

    await until(app, () => seen.length === order.length, 'every message');
    assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7]);
    await root.unmount();
  } finally {
    await app.close();
    await peer.close();
  }
});

test('the handler a re-render installed is the one called', async () => {
  const { app, peer } = await headlessPair();
  const root = await createRoot({ app });
  try {
    const first = [];
    const second = [];
    const instance = await render(
      h('window', {
        width: 100,
        height: 80,
        onClientMessage: (ev) => first.push(ev),
      }),
      root,
    );
    await render(
      h('window', {
        width: 100,
        height: 80,
        onClientMessage: (ev) => second.push(ev),
      }),
      root,
    );
    const atom = await intern(peer.X, '_HANDLER_SWAP');
    send(peer, instance.id, atom, [1, 0, 0, 0, 0]);
    await until(app, () => second.length === 1, 'the message to arrive');

    assert.equal(first.length, 0, 'the replaced handler is not called');
    await root.unmount();
  } finally {
    await app.close();
    await peer.close();
  }
});

test('a message is scoped to the window it was addressed to', async () => {
  // The whole point of the element seam over `X.on("event")`: a nested
  // <window> hears its own messages and only those.
  const { app, peer } = await headlessPair();
  const root = await createRoot({ app });
  try {
    const parent = [];
    const child = [];
    const childRef = React.createRef();
    const instance = await render(
      h(
        'window',
        {
          width: 200,
          height: 160,
          onClientMessage: (ev) => parent.push(ev.atom),
        },
        h('window', {
          ref: childRef,
          width: 40,
          height: 40,
          x: 10,
          y: 10,
          onClientMessage: (ev) => child.push(ev.atom),
        }),
      ),
      root,
    );
    const atom = await intern(peer.X, '_SCOPED_TO_A_WINDOW');
    send(peer, childRef.current.id, atom, [7, 0, 0, 0, 0]);
    await until(app, () => child.length === 1, 'the child to hear it');

    assert.deepEqual(child, [atom]);
    assert.deepEqual(parent, [], 'the parent hears nothing');

    send(peer, instance.id, atom, [8, 0, 0, 0, 0]);
    await until(app, () => parent.length === 1, 'the parent to hear its own');
    assert.equal(child.length, 1, 'and the child still hears nothing more');
    await root.unmount();
  } finally {
    await app.close();
    await peer.close();
  }
});

// --- preventDefault, over XDND ----------------------------------------------

/**
 * The XDND half of a drag source: enough to make react-x11 answer an
 * XdndPosition with an XdndStatus. A window with no drop targets still
 * answers — one refusal covering the whole window — which is what makes this
 * a clean probe for whether core handled the message at all.
 */
async function xdndProbe(peer) {
  const names = ['XdndEnter', 'XdndPosition', 'XdndStatus', 'XdndActionCopy'];
  const atoms = {};
  for (const name of names) atoms[name] = await intern(peer.X, name);
  const wnd = peer.createWindow({ width: 10, height: 10 });
  const replies = [];
  peer.X.on('event', (ev) => {
    if (ev.type === 33 && ev.message_type === atoms.XdndStatus)
      replies.push(ev);
  });
  return {
    atoms,
    replies,
    /** XDND puts the *source* in `data[0]` and the target in the event's own
     * window field — which is also what ntk routes a `'message'` by, so
     * getting it backwards delivers to nobody. */
    drag(target) {
      send(peer, target, atoms.XdndEnter, [wnd.id, 5 << 24, 0, 0, 0]);
      send(peer, target, atoms.XdndPosition, [
        wnd.id,
        0,
        (5 << 16) | 5,
        1,
        atoms.XdndActionCopy,
      ]);
    },
  };
}

test('XDND is answered when the handler leaves it alone', async () => {
  const { app, peer } = await headlessPair();
  const root = await createRoot({ app });
  try {
    const seen = [];
    const instance = await render(
      h('window', {
        width: 100,
        height: 80,
        onClientMessage: (ev) => seen.push(ev.messageType),
      }),
      root,
    );
    const probe = await xdndProbe(peer);
    probe.drag(instance.id);
    await until(peer, () => probe.replies.length === 1, 'an XdndStatus back');

    assert.deepEqual(
      seen,
      ['XdndEnter', 'XdndPosition'],
      'the handler saw both, named',
    );
    await root.unmount();
  } finally {
    await app.close();
    await peer.close();
  }
});

test('preventDefault() stops react-x11 answering XDND itself', async () => {
  const { app, peer } = await headlessPair();
  const root = await createRoot({ app });
  try {
    const seen = [];
    const instance = await render(
      h('window', {
        width: 100,
        height: 80,
        onClientMessage: (ev) => {
          seen.push(ev.messageType);
          ev.preventDefault();
          assert.equal(ev.defaultPrevented, true);
        },
      }),
      root,
    );
    const probe = await xdndProbe(peer);
    probe.drag(instance.id);
    await until(app, () => seen.length === 2, 'both messages to be seen');
    // give an XdndStatus every chance to turn up before concluding it never
    // will: the drop session answers off a promise chain, not inline
    for (let i = 0; i < 20; i++) {
      await settle(app);
      await settle(peer);
    }

    assert.deepEqual(probe.replies, [], 'core kept out of the conversation');
    await root.unmount();
  } finally {
    await app.close();
    await peer.close();
  }
});

test('preventDefault() still reaches XDND when the type needed naming', async () => {
  // The case `pending()` exists for. react-x11 interns the XDND atoms itself,
  // so the drag messages normally resolve synchronously and the flag is set
  // before the drop session ever sees them; forgetting one puts a round trip
  // in between. Whether `preventDefault()` works must not depend on that.
  const { app, peer } = await headlessPair();
  const root = await createRoot({ app });
  try {
    const seen = [];
    const instance = await render(
      h('window', {
        width: 100,
        height: 80,
        onClientMessage: (ev) => {
          seen.push(ev.messageType);
          ev.preventDefault();
        },
      }),
      root,
    );
    const probe = await xdndProbe(peer);
    await settle(app); // let react-x11's own interning land, then undo it
    delete app.X.atom_names[probe.atoms.XdndEnter];
    delete app.X.atom_names[probe.atoms.XdndPosition];

    probe.drag(instance.id);
    await until(app, () => seen.length === 2, 'both messages to be seen');
    for (let i = 0; i < 20; i++) {
      await settle(app);
      await settle(peer);
    }

    assert.deepEqual(
      seen,
      ['XdndEnter', 'XdndPosition'],
      'named the slow way, still in order',
    );
    assert.deepEqual(probe.replies, [], 'and core still kept out of it');
    await root.unmount();
  } finally {
    await app.close();
    await peer.close();
  }
});

// --- the timestamps ---------------------------------------------------------

test('lastInputTime is the server time the input event carried', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  try {
    const instance = await render(h('window', { width: 60, height: 40 }), root);
    assert.equal(
      lastInputTime(app),
      undefined,
      'no input has arrived, and 0 would be CurrentTime',
    );

    instance.emit('mousedown', { x: 5, y: 5, keycode: 1, time: 918273 });
    assert.equal(lastInputTime(app), 918273);
    instance.emit('keyup', { x: 5, y: 5, keycode: 38, time: 918290 });
    assert.equal(lastInputTime(app), 918290, 'the latest one wins');

    // motion is deliberately not tracked: nothing acquires a selection from
    // one, and it would be a write per pointer step
    instance.emit('mousemove', { x: 6, y: 6, time: 999999 });
    assert.equal(lastInputTime(app), 918290);
    await root.unmount();
  } finally {
    await app.close();
  }
});

test('lastInputTime is per connection', async () => {
  const a = createMockApp();
  const b = createMockApp();
  const rootA = await createRoot({ app: a });
  const rootB = await createRoot({ app: b });
  try {
    const wndA = await render(h('window', { width: 60, height: 40 }), rootA);
    await render(h('window', { width: 60, height: 40 }), rootB);
    wndA.emit('mousedown', { x: 1, y: 1, keycode: 1, time: 4242 });

    assert.equal(lastInputTime(a), 4242);
    assert.equal(lastInputTime(b), undefined, 'another server, another clock');
    await rootA.unmount();
    await rootB.unmount();
  } finally {
    await a.close();
    await b.close();
  }
});

test('serverTime answers with a real timestamp, and reuses one window', async () => {
  const { app, peer } = await headlessPair();
  try {
    const before = await countWindows(peer, app);
    const first = await serverTime(app);
    assert.ok(first > 0, `a real timestamp, got ${first}`);

    const second = await serverTime(app);
    assert.ok(second >= first, 'the server clock does not go backwards');

    // the 1x1 timestamp window is created once and shared, so a second call
    // is a round trip and nothing else
    assert.equal(
      (await countWindows(peer, app)) - before,
      1,
      'one timestamp window for both calls',
    );
  } finally {
    await app.close();
    await peer.close();
  }
});

/** How many children the root has, counted from the other connection. */
async function countWindows(peer, app) {
  await settle(app);
  const root = peer.X.display.screen[0].root;
  const tree = await new Promise((resolve, reject) =>
    peer.X.QueryTree(root, (err, res) => (err ? reject(err) : resolve(res))),
  );
  return tree.children.length;
}

test('serverTime resolves CurrentTime where there is nothing to ask', async () => {
  // A headless mock models no window creation at all, which is the same
  // answer a torn-down connection gives: 0 rather than a hang.
  const app = createMockApp();
  assert.equal(await serverTime(app), 0);
  assert.equal(await serverTime(null), 0);
});
