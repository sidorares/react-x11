// The other way of asking for a frame: `org_kde_kwin_server_decoration`,
// which some compositors have instead of xdg-decoration. A frame the
// compositor draws beats one this backend imitates, so the older protocol is
// asked with where the standard one is missing, and only a compositor with
// neither leaves the frame to `decorations.js`.
//
// The difference that has to be tested rather than assumed: this protocol's
// `mode` event is not part of a configure sequence. Before the first
// configure the answer still rides it, and a change of heart afterwards
// arrives alone and has to be flushed.
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, test } from 'node:test';

import { WaylandConnection } from '../../src/wayland/connection.js';
import { WaylandWindow } from '../../src/wayland/window.js';
import {
  KDE_DECORATION_MODE,
  createServerDecoration,
} from '../../src/wayland/ssd.js';
import {
  MockCompositor,
  until,
  waylandClientAvailable,
} from './mock-compositor.js';

const SKIP = waylandClientAvailable
  ? false
  : '@windowkit/wayland is not installed';

const open = [];
after(() => {
  for (const { conn, mock } of open) {
    conn?.destroy();
    mock?.close();
  }
});

/** A compositor missing the interfaces named, and a client connected to it. */
async function connect(without = []) {
  const mock = new MockCompositor({ width: 640, height: 480, without });
  const port = await mock.listen();
  const sock = net.createConnection(port);
  await new Promise((r) => sock.once('connect', r));
  const conn = await WaylandConnection.open({
    socket: sock,
    protocols: [
      'xdg-shell',
      'xdg-decoration-unstable-v1',
      'kde-server-decoration',
    ],
  });
  const env = {
    mock,
    conn,
    compositor: await conn.require('wl_compositor'),
    wmBase: await conn.require('xdg_wm_base'),
    manager: await conn.bind('zxdg_decoration_manager_v1'),
    kdeManager: await conn.bind('org_kde_kwin_server_decoration_manager'),
  };
  open.push(env);
  return env;
}

const make = (env, title, decorations) =>
  WaylandWindow.createSync({
    conn: env.conn,
    compositor: env.compositor,
    wmBase: env.wmBase,
    title,
    width: 300,
    height: 200,
    decorations,
  });

test(
  'a KDE-only compositor is still asked for server-side, before the first commit',
  { skip: SKIP },
  async () => {
    const env = await connect(['zxdg_decoration_manager_v1']);
    assert.equal(env.manager, null, 'the standard protocol is not offered');
    assert.ok(env.kdeManager, 'the older one is');

    const heard = [];
    const win = make(env, 'K', {
      manager: env.manager,
      kdeManager: env.kdeManager,
      prefer: 'server',
    });
    win.on('decorationmode', (m) => heard.push(`decorationmode:${m}`));
    win.on('configure', () => heard.push('configure'));
    assert.equal(win.decorationMode, 'client', 'nothing agreed yet');
    await win.whenConfigured;

    const names = env.mock.requests.map((r) => `${r.iface}.${r.name}`);
    const asked = names.indexOf(
      'org_kde_kwin_server_decoration_manager.create',
    );
    const preferred = names.indexOf(
      'org_kde_kwin_server_decoration.request_mode',
    );
    const committed = names.indexOf('wl_surface.commit');
    assert.ok(asked >= 0 && asked < committed, 'the object before the commit');
    assert.ok(
      preferred > asked && preferred < committed,
      'the mode stated before the commit',
    );
    assert.deepEqual(
      env.mock.sent('org_kde_kwin_server_decoration', 'request_mode')[0].args,
      [KDE_DECORATION_MODE.SERVER],
    );

    assert.equal(win.decorationMode, 'server', 'the compositor granted it');
    assert.deepEqual(
      heard,
      ['decorationmode:server', 'configure'],
      'the first answer still rides the first configure',
    );

    // A change of heart, with no configure behind it: the flush has to carry
    // it, or the window would keep painting at the wrong insets forever.
    env.mock.setKdeDecorationMode(win.surface.id, KDE_DECORATION_MODE.CLIENT);
    await until(() => win.decorationMode === 'client', {
      what: 'a mode that arrived alone to be flushed',
    });
    assert.deepEqual(
      heard.slice(2),
      ['decorationmode:client'],
      'flushed on its own, with no configure invented for it',
    );

    // and back again, so the flush is not a one-shot
    env.mock.setKdeDecorationMode(win.surface.id, KDE_DECORATION_MODE.SERVER);
    await until(() => win.decorationMode === 'server', {
      what: 'server-side again',
    });

    // a repeat is not a change
    const before = heard.length;
    env.mock.setKdeDecorationMode(win.surface.id, KDE_DECORATION_MODE.SERVER);
    await env.conn.roundtrip();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(heard.length, before, 'no decorationmode for a repeat');

    win.destroy();
    await env.conn.roundtrip();
    const order = env.mock.requests.map((r) => `${r.iface}.${r.name}`);
    assert.ok(
      order.lastIndexOf('org_kde_kwin_server_decoration.release') <
        order.lastIndexOf('xdg_toplevel.destroy'),
      'the decoration goes before the toplevel it decorates',
    );
  },
);

test(
  '`none` is not server-side: the backend keeps the frame it draws',
  { skip: SKIP },
  async () => {
    const env = await connect(['zxdg_decoration_manager_v1']);
    env.mock.opts.kdeDecorationMode = KDE_DECORATION_MODE.NONE;
    const win = make(env, 'N', {
      manager: env.manager,
      kdeManager: env.kdeManager,
      prefer: 'server',
    });
    await win.whenConfigured;
    assert.equal(
      win.decorationMode,
      'client',
      'no frame from the compositor means this side owns it',
    );
    win.destroy();
  },
);

test(
  'prefer client over the KDE protocol asks for client, not none',
  { skip: SKIP },
  async () => {
    const env = await connect(['zxdg_decoration_manager_v1']);
    const win = make(env, 'C', {
      manager: env.manager,
      kdeManager: env.kdeManager,
      prefer: 'client',
    });
    await win.whenConfigured;
    assert.deepEqual(
      env.mock.sent('org_kde_kwin_server_decoration', 'request_mode').pop()
        .args,
      [KDE_DECORATION_MODE.CLIENT],
      'a frameless window declines server-side and then draws nothing',
    );
    assert.equal(win.decorationMode, 'client');
    win.destroy();
  },
);

test(
  'with both protocols the standard one is used and the older one is left alone',
  { skip: SKIP },
  async () => {
    const env = await connect();
    assert.ok(env.manager && env.kdeManager, 'the mock offers both');
    const win = make(env, 'B', {
      manager: env.manager,
      kdeManager: env.kdeManager,
      prefer: 'server',
    });
    await win.whenConfigured;
    assert.equal(win.decorationMode, 'server');
    assert.equal(
      env.mock.sent('org_kde_kwin_server_decoration_manager').length,
      0,
      'the older protocol is never spoken where the standard one is there',
    );
    assert.ok(
      env.mock.sent('zxdg_decoration_manager_v1', 'get_toplevel_decoration')
        .length > 0,
    );
    win.destroy();
  },
);

test(
  'with neither protocol nothing is asked and the frame stays ours',
  { skip: SKIP },
  async () => {
    const env = await connect([
      'zxdg_decoration_manager_v1',
      'org_kde_kwin_server_decoration_manager',
    ]);
    assert.equal(env.manager, null);
    assert.equal(env.kdeManager, null);
    const win = make(env, 'G', {
      manager: env.manager,
      kdeManager: env.kdeManager,
      prefer: 'server',
    });
    await win.whenConfigured;
    assert.equal(win.decoration, null, 'nobody to ask');
    assert.equal(win.decorationMode, 'client');
    win.destroy();
  },
);

test('createServerDecoration prefers the standard protocol', () => {
  const calls = [];
  const proxy = (name) => ({
    $: {
      get_toplevel_decoration: () => {
        calls.push('xdg');
        return proxy(name);
      },
      create: () => {
        calls.push('kde');
        return proxy(name);
      },
      set_mode: () => calls.push('xdg.set_mode'),
      request_mode: () => calls.push('kde.request_mode'),
    },
    on: () => {},
    id: 1,
  });
  const toplevel = { id: 1 };
  const surface = { id: 2 };

  createServerDecoration({
    manager: proxy('xdg'),
    kdeManager: proxy('kde'),
    toplevel,
    surface,
  });
  assert.deepEqual(calls, ['xdg', 'xdg.set_mode'], 'the standard one wins');

  calls.length = 0;
  createServerDecoration({ kdeManager: proxy('kde'), toplevel, surface });
  assert.deepEqual(calls, ['kde', 'kde.request_mode'], 'the older one is used');

  assert.equal(
    createServerDecoration({ toplevel, surface }),
    null,
    'and with neither there is nobody to ask',
  );
});
