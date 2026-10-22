// Descriptors end to end, in-process, on Node: the mock compositor over a
// socketpair through x11-dri's UnixSocket sends the client a real keymap fd
// (a memfd holding an XKB keymap), and the seat reads it, parses it and
// decodes a key against it. This is the whole transport story in one test —
// and it skips, rather than fails, where the native socket is not there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { WaylandConnection } from '../../src/wayland/connection.js';
import { WaylandSeat } from '../../src/wayland/seat.js';
import { REAL_MODS } from '../../src/wayland/xkb.js';
import {
  MockCompositor,
  until,
  waylandClientAvailable,
} from './mock-compositor.js';

const require = createRequire(import.meta.url);

const KEYMAP = `xkb_keymap {
xkb_keycodes "(unnamed)" { minimum = 8; maximum = 255; <AD01> = 24; <LFSH> = 50; };
xkb_types "(unnamed)" {
	type "ALPHABETIC" { modifiers= Shift+Lock; map[Shift]= 2; map[Lock]= 2; };
};
xkb_compatibility "(unnamed)" { };
xkb_symbols "(unnamed)" {
	key <AD01> { [ q, Q ] };
	key <LFSH> { [ Shift_L ] };
	modifier_map Shift { <LFSH> };
};
};
`;

function nativeSocketAvailable() {
  if (typeof Bun !== 'undefined') return false;
  try {
    const dri = require('x11-dri');
    return (
      typeof dri.UnixSocket === 'function' &&
      typeof dri.memfdCreate === 'function'
    );
  } catch {
    return false;
  }
}

test(
  'a keymap arrives as a descriptor over the native socket and decodes keys',
  {
    skip: !waylandClientAvailable
      ? '@windowkit/wayland is not installed'
      : !nativeSocketAvailable() &&
        'x11-dri UnixSocket not available on this runtime',
  },
  async () => {
    const dri = require('x11-dri');
    const bytes = Buffer.from(KEYMAP + '\0', 'utf8');
    const memfd = dri.memfdCreate(bytes.length, 'keymap');
    fs.writeSync(memfd, bytes, 0, bytes.length, 0);

    const mock = new MockCompositor({
      keymapFd: memfd,
      keymapSize: bytes.length,
    });
    const client = mock.pair();
    assert.ok(client, 'a socketpair transport');
    const conn = await WaylandConnection.open({
      socket: client,
      protocols: ['xdg-shell', 'cursor-shape-v1'],
    });
    try {
      assert.equal(conn.transport, 'injected');
      const seat = await WaylandSeat.bind(conn);
      await until(() => seat.xkb, {
        what: 'the keymap to arrive over the socket',
      });
      assert.equal(seat.keymap.size, bytes.length);
      assert.equal(seat.xkb.keys.size, 2);
      assert.deepEqual(seat.xkb.keycode2keysyms[24], [0x71, 0x51]);

      // and a key event resolves through it, modifiers included
      const keys = [];
      seat.on('keydown', (ev) => keys.push(ev));
      // keyboard focus names a surface, so make one
      const compositor = await conn.require('wl_compositor');
      const surface = compositor.$.create_surface();
      await conn.roundtrip();
      mock.keyboardEnter(surface.id);
      mock.modifiers(1, 0, 0, 0); // Shift
      mock.key(16, true);
      await until(() => keys.length >= 1, { what: 'a key' });
      mock.key(16, false);
      assert.equal(keys[0].keycode, 24);
      assert.equal(
        keys[0].keysym,
        0x51,
        'Shift+q decoded against the received keymap',
      );
      assert.equal(keys[0].baseKeysym, 0x71);
      assert.equal(keys[0].codepoint, 0x51);
    } finally {
      conn.destroy();
      mock.close();
      fs.closeSync(memfd);
    }
  },
);

test(
  'the seat answers the locks, the group and the layouts from the keymap',
  {
    skip: !waylandClientAvailable
      ? '@windowkit/wayland is not installed'
      : !nativeSocketAvailable() &&
        'x11-dri UnixSocket not available on this runtime',
  },
  async () => {
    const dri = require('x11-dri');
    // libxkbcommon's own serialisation of us,de — the shape every compositor
    // sends, including the `pc_us_de_2_inet(evdev)` name the codes come from
    const bytes = Buffer.concat([
      fs.readFileSync(
        new URL('../fixtures/xkb-libxkbcommon-us-de.xkb', import.meta.url),
      ),
      Buffer.from([0]),
    ]);
    const memfd = dri.memfdCreate(bytes.length, 'keymap');
    fs.writeSync(memfd, bytes, 0, bytes.length, 0);

    const mock = new MockCompositor({
      keymapFd: memfd,
      keymapSize: bytes.length,
    });
    const conn = await WaylandConnection.open({
      socket: mock.pair(),
      protocols: ['xdg-shell', 'cursor-shape-v1'],
    });
    try {
      const seat = await WaylandSeat.bind(conn);
      const changes = [];
      seat.on('modifiers', () => changes.push(seat.keyboardState()));
      await until(() => seat.xkb, { what: 'the keymap' });
      assert.deepEqual(seat.keyboardState(), {
        capsLock: false,
        numLock: false,
        group: 0,
        layouts: ['us', 'de'],
      });

      const compositor = await conn.require('wl_compositor');
      const surface = compositor.$.create_surface();
      await conn.roundtrip();
      mock.keyboardEnter(surface.id);
      // Caps and Num locked, the second group latched in: what a German
      // typist with both lights on sends. Only the *locked* half counts — a
      // held Shift is not Caps Lock.
      const numLock = seat.xkb.maskOf('NumLock');
      assert.equal(numLock, REAL_MODS.Mod2, 'NumLock is Mod2 in this keymap');
      mock.modifiers(REAL_MODS.Shift, 0, REAL_MODS.Lock | numLock, 1);
      await until(() => changes.length, { what: 'the modifiers' });
      assert.deepEqual(changes.at(-1), {
        capsLock: true,
        numLock: true,
        group: 1,
        layouts: ['us', 'de'],
      });

      mock.modifiers(REAL_MODS.Lock, 0, 0, 0);
      await until(() => changes.length > 1, { what: 'the release' });
      assert.equal(changes.at(-1).capsLock, false, 'depressed is not locked');
    } finally {
      conn.destroy();
      mock.close();
      fs.closeSync(memfd);
    }
  },
);
