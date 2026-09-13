// The clipboard over wl_data_device: clearing it sends `set_selection` with a
// null source, an `allow-null` object the wayland-client fork refuses as 0.
// examples/clipboard.jsx's "clear it" button crashed the app on it.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';

import { WaylandConnection } from '../../src/wayland/connection.js';
import { createWaylandClipboard } from '../../src/wayland/clipboard.js';
import { MockCompositor, waylandClientAvailable } from './mock-compositor.js';

const SKIP = waylandClientAvailable
  ? false
  : 'wayland-client (the fork) is not installed';

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
