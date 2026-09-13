// A popup's grab has to reach the compositor before the popup's initial
// commit: mutter finishes a popup's setup on that commit, and a grab after
// it is `invalid_grab` — a fatal protocol error, "tried to grab after popup
// was mapped". Every `<popup grab>` hit it while the tree's grab (taken at
// map) followed a commit sent at creation. The mock enforces mutter's rule,
// so the second test is the crash and the first is its fix.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';

import { WaylandConnection } from '../../src/wayland/connection.js';
import { WaylandWindow } from '../../src/wayland/window.js';
import {
  MockCompositor,
  until,
  waylandClientAvailable,
} from './mock-compositor.js';

const SKIP = waylandClientAvailable
  ? false
  : 'wayland-client (the fork) is not installed';

async function open() {
  const mock = new MockCompositor({ width: 640, height: 480 });
  const path = await mock.listen();
  const sock = net.createConnection(path);
  await new Promise((r) => sock.once('connect', r));
  const conn = await WaylandConnection.open({ socket: sock });
  const compositor = await conn.require('wl_compositor');
  const wmBase = await conn.require('xdg_wm_base');
  const seat = await conn.require('wl_seat');
  const parent = WaylandWindow.createSync({
    conn,
    compositor,
    wmBase,
    title: 'P',
    width: 200,
    height: 150,
  });
  await parent.whenConfigured;
  const errors = [];
  conn.on('error', (e) => errors.push(e));
  return {
    mock,
    conn,
    seat,
    wmBase,
    errors,
    popup: (extra = {}) =>
      WaylandWindow.createPopupSync({
        conn,
        compositor,
        wmBase,
        parent,
        x: 10,
        y: 20,
        width: 80,
        height: 40,
        ...extra,
      }),
    /** requests the mock received since `start`, in order */
    since: (start) => mock.requests.slice(start),
    close() {
      try {
        parent.destroy();
      } catch {
        /* the connection may be dead */
      }
      if (conn.destroyed) conn.socket.destroy();
      else conn.destroy();
      mock.close();
    },
  };
}

const isCommitOf = (surface) => (r) =>
  r.iface === 'wl_surface' && r.name === 'commit' && r.id === surface.id;

test(
  'a popup made without its commit takes the grab first, and commits when asked',
  { skip: SKIP },
  async () => {
    const t = await open();
    try {
      const start = t.mock.requests.length;
      const p = t.popup({ commit: false });
      await t.conn.roundtrip();
      assert.equal(p.initialCommitPending, true);
      assert.equal(
        t.since(start).filter(isCommitOf(p.surface)).length,
        0,
        'nothing is committed before the map',
      );
      assert.equal(p.configured, false, 'and nothing is configured');

      assert.equal(p.takeGrab(t.seat, 7), true);
      p.commitInitial();
      await p.whenConfigured;
      const log = t.since(start);
      const grab = log.findIndex(
        (r) => r.iface === 'xdg_popup' && r.name === 'grab',
      );
      const commit = log.findIndex(isCommitOf(p.surface));
      assert.ok(grab >= 0, 'the grab went out');
      assert.ok(commit > grab, 'before the initial commit');
      assert.deepEqual(log[grab].args, [t.seat.id, 7]);

      assert.equal(p.takeGrab(t.seat, 8), false, 'no second grab after setup');
      await t.conn.roundtrip();
      assert.equal(t.mock.sent('xdg_popup', 'grab').length, 1);
      assert.deepEqual(t.errors, []);
      p.destroy();
    } finally {
      t.close();
    }
  },
);

test(
  'a grab after the initial commit is invalid_grab, and ends the connection',
  { skip: SKIP },
  async () => {
    const t = await open();
    try {
      const p = t.popup(); // committed at creation, the way it used to be
      await p.whenConfigured;
      assert.equal(p.takeGrab(t.seat, 7), false, 'takeGrab knows it is late');
      // …and a raw request shows what the refusal protects against
      p.popup.$.grab(t.seat.id, 7);
      await until(() => t.errors.length > 0, { what: 'the protocol error' });
      assert.equal(t.errors[0].name, 'WaylandProtocolError');
      assert.match(t.errors[0].message, /invalid_grab/);
      assert.equal(
        t.conn.destroyed,
        true,
        'nothing writes to a connection the compositor has ended',
      );
    } finally {
      t.close();
    }
  },
);

test(
  'a move before the map goes out right after the initial commit',
  { skip: SKIP },
  async () => {
    const t = await open();
    try {
      const start = t.mock.requests.length;
      const p = t.popup({ commit: false });
      assert.equal(
        p.reposition(t.wmBase, { x: 30, y: 40, width: 80, height: 40 }),
        true,
      );
      await t.conn.roundtrip();
      assert.equal(
        t.since(start).filter((r) => r.name === 'reposition').length,
        0,
        'held while there is no placement to change',
      );
      p.commitInitial();
      await p.whenConfigured;
      await t.conn.roundtrip();
      const log = t.since(start);
      const commit = log.findIndex(isCommitOf(p.surface));
      const reposition = log.findIndex(
        (r) => r.iface === 'xdg_popup' && r.name === 'reposition',
      );
      assert.ok(commit >= 0 && reposition > commit);
      assert.deepEqual(t.errors, []);
      p.destroy();
    } finally {
      t.close();
    }
  },
);
