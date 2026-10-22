// The clipboard over wl_data_device: clearing it sends `set_selection` with a
// null source, an `allow-null` object @windowkit/wayland refused before
// 3.1.1. examples/clipboard.jsx's "clear it" button crashed the app on it.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
import { test } from 'node:test';

import { WaylandConnection } from '../../src/wayland/connection.js';
import { createWaylandClipboard } from '../../src/wayland/clipboard.js';
import { MockCompositor, waylandClientAvailable } from './mock-compositor.js';

const SKIP = waylandClientAvailable
  ? false
  : '@windowkit/wayland is not installed';

/** A read takes its payload through a pipe, which needs the fd-capable
 *  transport: x11-dri's socket, on Node. */
function nativeSocketAvailable() {
  if (typeof Bun !== 'undefined') return false;
  try {
    const dri = createRequire(import.meta.url)('x11-dri');
    return (
      typeof dri.UnixSocket === 'function' && typeof dri.pipe === 'function'
    );
  } catch {
    return false;
  }
}
const READ_SKIP =
  SKIP || (!nativeSocketAvailable() && 'x11-dri UnixSocket/pipe not available');

test(
  'write, then clear: the selection goes to a source, then to nothing',
  { skip: SKIP },
  async () => {
    const mock = new MockCompositor({ width: 320, height: 200 });
    const path = await mock.listen();
    const sock = net.createConnection(path);
    await new Promise((r) => sock.once('connect', r));
    const conn = await WaylandConnection.open({ socket: sock });
    try {
      const seat = await conn.require('wl_seat');
      const clipboard = await createWaylandClipboard({
        conn,
        seat,
        serial: () => 5,
      });
      await clipboard.write('hello');
      await clipboard.clear();
      await conn.roundtrip();
      const sets = mock.sent('wl_data_device', 'set_selection');
      assert.equal(sets.length, 2);
      assert.notEqual(sets[0].args[0], 0, 'a source first');
      assert.ok(!sets[1].args[0], 'then none');
      assert.equal(sets[1].args[1], 5, 'with the serial');
    } finally {
      conn.destroy();
      mock.close();
    }
  },
);

test(
  "read: another application's selection comes back as its text",
  { skip: READ_SKIP },
  async () => {
    // The `selection` event names the offer by id — an `object` argument is
    // a number off the wire, where `data_offer`'s `new_id` is a proxy — and
    // the clipboard kept the number: a read called `receive` on it and threw
    // "undefined is not an object (evaluating 'this.offer.$.receive')", so
    // nothing an X11 app or a native one copied could be pasted here.
    // the payload comes back through a pipe: an fd-capable socket
    const mock = new MockCompositor({ width: 320, height: 200 });
    const conn = await WaylandConnection.open({ socket: mock.pair() });
    try {
      const seat = await conn.require('wl_seat');
      const clipboard = await createWaylandClipboard({
        conn,
        seat,
        serial: () => 5,
      });
      await conn.roundtrip();
      mock.selectionOffer(['text/plain;charset=utf-8', 'UTF8_STRING'], {
        'text/plain;charset=utf-8': 'pasted from elsewhere',
        UTF8_STRING: 'pasted from elsewhere',
      });
      await conn.roundtrip();
      assert.ok(
        (await clipboard.targets()).includes('text/plain;charset=utf-8'),
        'its types',
      );
      assert.equal(await clipboard.read(), 'pasted from elsewhere');
    } finally {
      conn.destroy();
      mock.close();
    }
  },
);
