// Drag and drop over `wl_data_device` (src/wayland/dnd.js): the drop side
// answering an incoming drag from another application, and the source side
// offering a payload and being asked for it — both driven against the
// in-process mock compositor over a descriptor-capable socketpair, because
// the payload travels as real pipe fds either way.
//
// The DropSession and DragSession themselves are the tree's and are tested
// end to end elsewhere (test/dnd.test.js, test/cocoa-dnd.test.js); what is
// asserted here is the Wayland transport's translation, so the sessions are
// recording spies and the compositor is the peer. Mounting a real React tree
// is not an option on the mock — a window needs a GPU dma-buf the mock does
// not offer — so the transport is exercised directly, which is exactly the
// seam this file owns.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { WaylandConnection } from '../../src/wayland/connection.js';
import {
  WaylandDnd,
  offeredTypes,
  sourceOffers,
  wireBytes,
} from '../../src/wayland/dnd.js';
import {
  MockCompositor,
  until,
  waylandClientAvailable,
} from './mock-compositor.js';

const require = createRequire(import.meta.url);

/** DnD needs the fd-capable transport both ways: the payload is a pipe. */
function nativeSocketAvailable() {
  if (typeof Bun !== 'undefined') return false;
  try {
    const dri = require('x11-dri');
    return (
      typeof dri.UnixSocket === 'function' && typeof dri.pipe === 'function'
    );
  } catch {
    return false;
  }
}

const SKIP = !waylandClientAvailable
  ? 'wayland-client (the fork) is not installed'
  : !nativeSocketAvailable() && 'x11-dri UnixSocket/pipe not available';

// ---- pure type mapping (no compositor needed) -------------------------------

test('offeredTypes surfaces text/plain beside the charset spelling', () => {
  assert.deepEqual(
    offeredTypes(['text/plain;charset=utf-8', 'text/uri-list']),
    ['text/plain;charset=utf-8', 'text/plain', 'text/uri-list'],
  );
  assert.deepEqual(offeredTypes(['application/x-foo']), ['application/x-foo']);
  assert.deepEqual(offeredTypes(undefined), []);
});

test('sourceOffers adds both text spellings, mapping each back to the session type', () => {
  const map = sourceOffers({ types: ['text/plain', 'application/x-demo'] });
  assert.equal(map['text/plain'], 'text/plain');
  assert.equal(map['text/plain;charset=utf-8'], 'text/plain');
  assert.equal(map['application/x-demo'], 'application/x-demo');
});

test('wireBytes: strings and bytes as they are, anything else as JSON', () => {
  assert.equal(wireBytes('hi').toString('utf8'), 'hi');
  assert.deepEqual(wireBytes(Buffer.from([1, 2, 3])), Buffer.from([1, 2, 3]));
  assert.equal(wireBytes({ a: 1 }).toString('utf8'), '{"a":1}');
  assert.equal(wireBytes(null).length, 0);
});

// ---- protocol-level fixtures ------------------------------------------------

/** A recording DropSession, answering `localOver` with a canned verdict. */
function spySession() {
  return {
    calls: [],
    over: { accepted: true, action: 'copy' },
    dropOutcome: { handled: true, action: 'copy' },
    localOver(x, y, offer, time) {
      this.calls.push(['over', x, y, offer, time]);
      return this.over;
    },
    localLeave() {
      this.calls.push(['leave']);
    },
    localDrop(offer, extras, time) {
      this.calls.push(['drop', offer, extras, time]);
      return this.dropOutcome;
    },
    of(name) {
      return this.calls.filter((c) => c[0] === name);
    },
  };
}

/** A recording DragSession the source path drives, as `DragSession._start`
 * would have set it up: `_nativeSession`, the live payload, the callbacks. */
function spyDrag({ types, data, actions = ['copy'] }) {
  return {
    _nativeSession: true,
    accepted: false,
    currentAction: actions[0],
    types,
    actions,
    _data: data,
    press: { x: 20, y: 20, rootx: 20, rooty: 20 },
    moved: [],
    ended: [],
    _resolve(type) {
      return data[type];
    },
    _offer() {
      return { types, action: actions[0], source: 'internal' };
    },
    _dropExtras() {
      const items = {};
      for (const t of types) items[t] = data[t];
      return {
        items,
        files: [],
        text: undefined,
        getData: (t) => Promise.resolve(data[t]),
      };
    },
    nativeMoved(ev) {
      this.moved.push(ev);
    },
    nativeEnded(ev) {
      this.ended.push(ev);
    },
  };
}

/** A connected client with a WaylandDnd over the mock's data device, and a
 * real surface to route drops to / drag from. */
async function connect() {
  const mock = new MockCompositor();
  const client = mock.pair();
  if (!client) return null;
  const conn = await WaylandConnection.open({
    socket: client,
    protocols: ['wayland', 'xdg-shell'],
  });
  const compositor = await conn.require('wl_compositor');
  const manager = await conn.require('wl_data_device_manager');
  const seatProxy = await conn.require('wl_seat');
  const device = manager.$.get_data_device(seatProxy.id);
  const surface = compositor.$.create_surface();
  await conn.roundtrip();
  const app = { _activeDrag: null, compositor, scale: 1 };
  const seat = { lastPressSerial: 7, lastSerial: 7 };
  const dnd = new WaylandDnd({ app, device, manager, seat });
  return { mock, conn, app, dnd, surfaceId: surface.id };
}

const win = (
  id,
  insets = { top: 0, left: 0, right: 0, bottom: 0 },
  scale = 1,
) => ({
  wl: { surface: { id } },
  insets,
  scale,
});

// ---- the drop side ----------------------------------------------------------

test(
  'an external drag: enter accepts from dropAccept, the payload is read at drop, finish is sent',
  { skip: SKIP },
  async () => {
    const env = await connect();
    const { mock, conn, dnd, surfaceId } = env;
    try {
      const session = spySession();
      dnd.attach(win(surfaceId), session, {});
      mock.dndPayload = {
        'text/uri-list': 'file:///tmp/a.txt\r\n',
        'text/plain;charset=utf-8': 'hello',
      };

      mock.dndEnter(surfaceId, ['text/uri-list', 'text/plain;charset=utf-8'], {
        x: 20,
        y: 30,
      });
      await until(() => session.of('over').length >= 1, { what: 'localOver' });
      await conn.roundtrip();
      const over = session.of('over')[0];
      assert.equal(over[1], 20, 'content device x');
      assert.equal(over[2], 30, 'content device y');
      assert.equal(over[3].source, 'external');
      assert.deepEqual(
        over[3].types,
        ['text/uri-list', 'text/plain;charset=utf-8', 'text/plain'],
        'text/plain surfaced beside the charset spelling',
      );
      assert.ok(
        mock.sent('wl_data_offer', 'accept').length >= 1,
        'the offer was accepted',
      );
      assert.ok(
        mock.sent('wl_data_offer', 'set_actions').length >= 1,
        'actions were negotiated',
      );

      mock.dndDrop();
      await until(() => session.of('drop').length >= 1, { what: 'localDrop' });
      const extras = session.of('drop')[0][2];
      assert.equal(extras.text, 'hello');
      assert.deepEqual(
        extras.files.map((f) => f.path),
        ['/tmp/a.txt'],
      );
      assert.equal(await extras.getData('text/plain'), 'hello', 'alias read');
      assert.equal(
        await extras.getData('files'),
        'file:///tmp/a.txt\r\n',
        'a group resolves to the offered member',
      );

      await conn.roundtrip();
      assert.ok(
        mock.sent('wl_data_offer', 'finish').length >= 1,
        'finish after the data was received',
      );
      assert.ok(
        mock.sent('wl_data_offer', 'destroy').length >= 1,
        'the offer was destroyed',
      );
    } finally {
      conn.destroy();
      mock.close();
    }
  },
);

test(
  'coordinates convert by scale, and a position over the frame is a leave',
  { skip: SKIP },
  async () => {
    const env = await connect();
    const { mock, conn, dnd, surfaceId } = env;
    try {
      const session = spySession();
      // a titlebar 24 logical px tall, a 1px border, at scale 2
      dnd.attach(
        win(surfaceId, { top: 24, left: 1, right: 1, bottom: 1 }, 2),
        session,
        {},
      );

      // over the content: (10 - 1) * 2 = 18, (30 - 24) * 2 = 12
      mock.dndEnter(surfaceId, ['text/plain'], { x: 10, y: 30 });
      await until(() => session.of('over').length >= 1, { what: 'localOver' });
      const over = session.of('over')[0];
      assert.deepEqual(
        [over[1], over[2]],
        [18, 12],
        'insets off, then × scale',
      );

      // up into the titlebar (y < 24): outside the content → leave + refuse
      mock.dndMotion(10, 10);
      await until(() => session.of('leave').length >= 1, {
        what: 'a leave from the frame',
      });
      await conn.roundtrip();
      const setActions = mock.sent('wl_data_offer', 'set_actions');
      assert.deepEqual(
        setActions.at(-1).args,
        [0, 0],
        'no action offered over the frame',
      );
    } finally {
      conn.destroy();
      mock.close();
    }
  },
);

test(
  'a drop of our own live drag keeps the payload by reference, source internal',
  { skip: SKIP },
  async () => {
    const env = await connect();
    const { mock, conn, app, dnd, surfaceId } = env;
    try {
      const session = spySession();
      session.dropOutcome = { handled: true, action: 'move' };
      dnd.attach(win(surfaceId), session, {});
      const row = { id: 42, name: 'row' };
      const drag = spyDrag({
        types: ['application/x-demo'],
        data: { 'application/x-demo': row },
        actions: ['move'],
      });
      app._activeDrag = drag; // as DragSession._start set it

      mock.dndEnter(surfaceId, ['application/x-demo'], {
        x: 5,
        y: 5,
        sourceActions: 2,
      });
      await until(() => session.of('over').length >= 1, { what: 'localOver' });
      const over = session.of('over')[0];
      assert.equal(over[3].source, 'internal', 'the live drag, not the wire');
      assert.equal(drag.accepted, true, 'the drag learns it is accepted');

      mock.dndDrop();
      await until(() => session.of('drop').length >= 1, { what: 'localDrop' });
      const items = session.of('drop')[0][2].items;
      assert.equal(
        items['application/x-demo'],
        row,
        'the same object, by reference',
      );
      await conn.roundtrip();
      assert.ok(mock.sent('wl_data_offer', 'finish').length >= 1);
    } finally {
      conn.destroy();
      mock.close();
    }
  },
);

// ---- the drag source --------------------------------------------------------

test(
  'the source offers its types, starts the drag, answers a send, and ends on finish',
  { skip: SKIP },
  async () => {
    const env = await connect();
    const { mock, conn, app, dnd, surfaceId } = env;
    try {
      const row = { id: 3, name: 'r' };
      const session = spyDrag({
        types: ['application/x-demo', 'text/plain'],
        data: { 'application/x-demo': row, 'text/plain': 'p' },
        actions: ['move', 'copy'],
      });
      app._activeDrag = session;

      const began = dnd.beginDrag(win(surfaceId), session);
      assert.ok(began, 'the drag started');
      await conn.roundtrip();

      const offers = mock.sourceOffers();
      assert.ok(offers.includes('application/x-demo'));
      assert.ok(offers.includes('text/plain'));
      assert.ok(
        offers.includes('text/plain;charset=utf-8'),
        'the text alias is offered too',
      );
      assert.ok(mock.sent('wl_data_source', 'set_actions').length >= 1);

      const start = mock.sent('wl_data_device', 'start_drag');
      assert.equal(start.length, 1);
      assert.equal(start[0].args[1], surfaceId, 'the origin surface');
      assert.notEqual(start[0].args[2], 0, 'a real icon surface, never null');
      assert.equal(start[0].args[3], 7, 'the press serial');

      // the target accepts, then settles on move: onDrag fires each time
      mock.sourceTarget('application/x-demo');
      await until(() => session.moved.length >= 1, { what: 'onDrag' });
      assert.equal(session.accepted, true);
      mock.sourceAction(2); // move
      await until(() => session.currentAction === 'move', {
        what: 'the negotiated action',
      });

      // the payload, on demand: JSON for a live object, text as-is, the alias
      // resolving to the same value
      assert.equal(
        (await mock.sourceSend('application/x-demo')).toString('utf8'),
        JSON.stringify(row),
      );
      assert.equal((await mock.sourceSend('text/plain')).toString('utf8'), 'p');
      assert.equal(
        (await mock.sourceSend('text/plain;charset=utf-8')).toString('utf8'),
        'p',
      );

      // the drop happened and the target finished: the session ends, dropped
      mock.sourceDropPerformed();
      mock.sourceFinished();
      await until(() => session.ended.length >= 1, { what: 'nativeEnded' });
      assert.deepEqual(
        [session.ended[0].dropped, session.ended[0].operation],
        [true, 'move'],
      );
      await conn.roundtrip();
      assert.ok(
        mock.sent('wl_data_source', 'destroy').length >= 1,
        'the source is destroyed after finish',
      );
    } finally {
      conn.destroy();
      mock.close();
    }
  },
);

test('a cancelled drag ends undropped', { skip: SKIP }, async () => {
  const env = await connect();
  const { mock, conn, app, dnd, surfaceId } = env;
  try {
    const session = spyDrag({
      types: ['text/plain'],
      data: { 'text/plain': 'x' },
    });
    app._activeDrag = session;
    dnd.beginDrag(win(surfaceId), session);
    await conn.roundtrip();

    mock.sourceCancelled();
    await until(() => session.ended.length >= 1, { what: 'nativeEnded' });
    assert.deepEqual(
      [session.ended[0].dropped, session.ended[0].operation],
      [false, null],
    );
  } finally {
    conn.destroy();
    mock.close();
  }
});
