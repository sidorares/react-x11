// Custom URI schemes (issue #173): being the app a `myapp://…` link opens.
//
// Three halves, and they fail in different ways, so they are tested apart:
//
// - the **derivations** — an object path with a dash in it, a scheme that is
//   not ours to claim — which fail silently on a real desktop as "the launcher
//   started us and then nothing happened";
// - the **dispatch**, against a real broker: owning the name, answering `Open`
//   before any UI exists, and a second copy of the app handing over what it
//   was launched with;
// - the **raise**, which is the part a user judges the feature by, and which
//   reports success at every layer while doing nothing if the timestamp is
//   wrong.
//
// Two branches this harness deliberately cannot reach, stated rather than
// faked: the broker has no service activation and no security policy, so
// *bus-started* activation and the `.desktop`/MIME registration end to end are
// manual QA on a real session. The script for that is in docs/uri-schemes.md.

import assert from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import React from 'react';

import { _resetBusState, busRefs } from '../src/bus.js';
import { activateWindow, createRoot, useAppOpen } from '../src/index.js';
import {
  _resetApplicationState,
  acceptUris,
  objectPathForAppId,
  onAppActivate,
  onAppOpen,
  redactUri,
  registerApplication,
} from '../src/application.js';
import { createMockApp } from './helpers/mock-app.js';
import { fakeApplication, fakeLauncher } from './helpers/fake-launcher.js';
import { transportAvailable, until, withBus } from './helpers/with-bus.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const haveTransport = await transportAvailable();
const needsBroker = haveTransport
  ? {}
  : { skip: 'dbus-native is not installed (expected on Node < 22.12)' };

const APP_ID = 'com.example.myapp';
const LINK = `${APP_ID}://auth?code=SECRET`;

afterEach(() => _resetApplicationState());

// --------------------------------------------------------------------------
// The derivations
// --------------------------------------------------------------------------

describe('the app id is three things at once', () => {
  test('the object path is derived, including the dash rule', () => {
    assert.equal(
      objectPathForAppId('org.example.FooViewer'),
      '/org/example/FooViewer',
    );
    // The one everybody misses: a dash is legal in a bus name and illegal in
    // an object path, so an app that got this wrong would be called at a path
    // it does not serve — and see nothing at all.
    assert.equal(
      objectPathForAppId('com.example.my-app'),
      '/com/example/my_app',
    );
    assert.equal(
      objectPathForAppId('com.example.a-b.c-d'),
      '/com/example/a_b/c_d',
    );
  });

  test('a malformed app id throws rather than answering null', async () => {
    // Not the never-rejects rule: `null` means "no bus here", and using it for
    // a typo would hide the typo on every machine without a session bus.
    for (const appId of ['myapp', '', '.com.example', 'com.example.', 42]) {
      await assert.rejects(
        () => registerApplication({ appId }),
        /valid bus name|app id/,
        `${JSON.stringify(appId)} is not an app id`,
      );
    }
  });

  test('http, https and file are refused; a private scheme is not', async () => {
    for (const scheme of ['http', 'https', 'file', 'HTTPS']) {
      await assert.rejects(
        () => registerApplication({ appId: APP_ID, schemes: [scheme] }),
        /cannot be registered here/,
      );
    }
    for (const scheme of ['1nvalid', 'has space', 'has:colon', '']) {
      await assert.rejects(
        () => registerApplication({ appId: APP_ID, schemes: [scheme] }),
        /not a scheme name/,
      );
    }
  });
});

describe('what an app answers for', () => {
  test('a declared scheme filters, and file: is always allowed', () => {
    const uris = [
      LINK,
      'com.evil.other://take-over',
      'file:///home/u/notes.md',
      'not a uri',
    ];
    assert.deepEqual(acceptUris(uris, [APP_ID]), [
      LINK,
      'file:///home/u/notes.md',
    ]);
    // No declaration is not the same as an empty one: an app that never said
    // what it answers for gets everything that is a URI at all.
    assert.deepEqual(acceptUris(uris, null), uris.slice(0, 3));
  });

  test('a URI is never repeated whole — query, fragment and userinfo go', () => {
    assert.equal(redactUri(LINK), `${APP_ID}://auth…`);
    assert.equal(redactUri('myapp://cb#token=SECRET'), 'myapp://cb…');
    assert.equal(
      redactUri('myapp://user:hunter2@host/path'),
      'myapp://…@host/path',
    );
    assert.equal(redactUri('myapp://project/42'), 'myapp://project/42');
  });
});

// --------------------------------------------------------------------------
// Dispatch and delivery
// --------------------------------------------------------------------------

describe('against a broker', { concurrency: 1, ...needsBroker }, () => {
  test('the first copy of the app owns the name and is introspectable', async () => {
    await withBus(async (address) => {
      const app = await registerApplication({ appId: APP_ID });
      assert.equal(app.role, 'primary');
      assert.equal(app.objectPath, '/com/example/myapp');

      const desktop = await fakeLauncher(address);
      const names = await desktop.bus.listNames();
      assert.ok(names.includes(APP_ID), 'the well-known name is ours');
      const xml = await desktop.introspect(APP_ID);
      assert.match(xml, /interface name="org.freedesktop.Application"/);
      assert.match(xml, /method name="Open"/);
      assert.match(xml, /method name="ActivateAction"/);

      await desktop.stop();
      await app.release();
      await until(() => busRefs('session') === 0, 'the app to release the bus');
    });
  });

  test('Open reaches a handler that attached after the call', async () => {
    await withBus(async (address) => {
      const app = await registerApplication({
        appId: APP_ID,
        schemes: [APP_ID],
      });
      const desktop = await fakeLauncher(address);

      // Nothing is listening yet — the shape of a bus-started launch, where
      // the call is what boots the process and React is a second away.
      await desktop.open(APP_ID, [LINK], {
        'desktop-startup-id': 'launcher/app.desktop/1-0_TIME12345',
      });

      const seen = [];
      onAppOpen((uris, ctx) => seen.push({ uris, ctx }));
      await until(() => seen.length === 1, 'the buffered link to replay');

      assert.deepEqual(seen[0].uris, [LINK]);
      // The whole point of the id: this is the timestamp the window manager
      // weighs before letting a window come forward.
      assert.equal(seen[0].ctx.timestamp, 12345);
      assert.equal(seen[0].ctx.startupId, 'launcher/app.desktop/1-0_TIME12345');

      // Drained by the first handler and gone: a second subscriber must not
      // replay one login twice.
      const later = [];
      onAppOpen((uris) => later.push(uris));
      await tick();
      assert.deepEqual(later, []);

      await desktop.stop();
      await app.release();
    });
  });

  test('Open takes none, one or many URIs, and answers promptly', async () => {
    await withBus(async (address) => {
      const app = await registerApplication({ appId: APP_ID });
      const seen = [];
      onAppOpen((uris) => seen.push(uris));
      const desktop = await fakeLauncher(address);

      const many = [`${APP_ID}://a`, `${APP_ID}://b`, `${APP_ID}://c`];
      await desktop.open(APP_ID, []);
      await desktop.open(APP_ID, [LINK]);
      await desktop.open(APP_ID, many);
      await until(() => seen.length === 3, 'three Open calls to arrive');
      assert.deepEqual(seen, [[], [LINK], many]);

      await desktop.stop();
      await app.release();
    });
  });

  test('a missing or malformed _TIME is null, never a throw', async () => {
    await withBus(async (address) => {
      const app = await registerApplication({ appId: APP_ID });
      const seen = [];
      onAppOpen((uris, ctx) => seen.push(ctx.timestamp));
      const desktop = await fakeLauncher(address);

      await desktop.open(APP_ID, [LINK], { 'desktop-startup-id': 'no-time' });
      await desktop.open(APP_ID, [LINK], {
        'desktop-startup-id': 'x_TIMEnotanumber',
      });
      await desktop.open(APP_ID, [LINK]);
      await until(() => seen.length === 3, 'three launches to arrive');
      assert.deepEqual(seen, [null, null, null]);

      await desktop.stop();
      await app.release();
    });
  });

  test('Activate is its own event, not an Open with nothing in it', async () => {
    await withBus(async (address) => {
      const app = await registerApplication({ appId: APP_ID });
      const opens = [];
      const activations = [];
      onAppOpen((uris) => opens.push(uris));
      onAppActivate((ctx) => activations.push(ctx));
      const desktop = await fakeLauncher(address);

      await desktop.activate(APP_ID, {
        'desktop-startup-id': 'panel_TIME77',
        'activation-token': 'tok',
      });
      await until(() => activations.length === 1, 'the activation to arrive');
      assert.deepEqual(opens, []);
      assert.equal(activations[0].timestamp, 77);
      assert.equal(activations[0].activationToken, 'tok');

      await desktop.stop();
      await app.release();
    });
  });

  test('ActivateAction replies correctly, handler or not', async () => {
    await withBus(async (address) => {
      const desktop = await fakeLauncher(address);
      // A stub that errors is worse than one that does nothing: the shell
      // concludes the app is broken rather than that the action is unhandled.
      const bare = await registerApplication({ appId: APP_ID });
      await desktop.activateAction(APP_ID, 'new-window');
      await bare.release();
      _resetApplicationState();

      const seen = [];
      const app = await registerApplication({
        appId: APP_ID,
        onAction: (name, params) => seen.push([name, params]),
      });
      await desktop.activateAction(APP_ID, 'new-window');
      await until(() => seen.length === 1, 'the action to reach the handler');
      assert.equal(seen[0][0], 'new-window');

      await desktop.stop();
      await app.release();
    });
  });

  test('a second copy hands over its argv and becomes nothing', async () => {
    await withBus(async (address) => {
      // The `xdg-open` path: the desktop spawned `my-app com.example.myapp://…`
      // while a copy was already running. Owning the name from a separate
      // connection is the only faithful way to be that first copy.
      const first = await fakeApplication(address, APP_ID);
      assert.equal(first.nameReply, 1, 'the fake really owns the name');

      const second = await registerApplication({
        appId: APP_ID,
        schemes: [APP_ID],
        argv: ['--frobnicate', LINK, 'com.evil.other://nope'],
      });

      assert.equal(second.role, 'secondary');
      await until(() => first.opened.length === 1, 'the URI to be forwarded');
      // Only the URI, and only the scheme this app registered: forwarding an
      // arbitrary command line to another process would be a different and
      // much worse feature.
      assert.deepEqual(first.opened[0].uris, [LINK]);

      // And it holds nothing: the caller's next line is process.exit(0).
      await until(
        () => busRefs('session') === 0,
        'the second copy to release the bus',
      );

      await first.stop();
    });
  });

  test('a second launch with no link asks the first one to come forward', async () => {
    await withBus(async (address) => {
      const first = await fakeApplication(address, APP_ID);
      const second = await registerApplication({
        appId: APP_ID,
        schemes: [APP_ID],
        argv: [],
      });
      assert.equal(second.role, 'secondary');
      await until(() => first.activated.length === 1, 'an Activate to arrive');
      assert.deepEqual(first.opened, [], 'not an empty Open');
      await first.stop();
    });
  });

  test('the launch carried in argv reaches the first copy too', async () => {
    await withBus(async () => {
      // A cold start through `xdg-open` with nothing else running: this
      // process is the app *and* the URI is in its argv. Without this the deep
      // link that started the app is the one link it never sees.
      const seen = [];
      onAppOpen((uris) => seen.push(uris));
      const app = await registerApplication({
        appId: APP_ID,
        schemes: [APP_ID],
        argv: [LINK],
      });
      assert.equal(app.role, 'primary');
      await until(() => seen.length === 1, 'the argv link to be delivered');
      assert.deepEqual(seen[0], [LINK]);
      await app.release();
    });
  });

  test('two identities in one process is a mistake, and says so', async () => {
    await withBus(async () => {
      const app = await registerApplication({ appId: APP_ID });
      await assert.rejects(
        () => registerApplication({ appId: 'com.example.other' }),
        /already registered as "com.example.myapp"/,
      );
      await app.release();
    });
  });

  test('debug output never carries the secret in a link', async () => {
    await withBus(async (address) => {
      const saved = process.env.REACT_X11_DEBUG_URI;
      process.env.REACT_X11_DEBUG_URI = '1';
      const written = [];
      const realError = console.error;
      console.error = (...args) => written.push(args.join(' '));
      try {
        const app = await registerApplication({
          appId: APP_ID,
          schemes: [APP_ID],
        });
        const desktop = await fakeLauncher(address);
        await desktop.open(APP_ID, [LINK, 'com.evil.other://take-over']);
        await tick();
        await desktop.stop();
        await app.release();
      } finally {
        console.error = realError;
        if (saved === undefined) delete process.env.REACT_X11_DEBUG_URI;
        else process.env.REACT_X11_DEBUG_URI = saved;
      }
      const all = written.join('\n');
      assert.ok(all.length > 0, 'the switch produced something to check');
      assert.ok(!all.includes('SECRET'), `leaked a code:\n${all}`);
      assert.ok(all.includes(`${APP_ID}://auth`), 'still identifies the link');
    });
  });
});

// --------------------------------------------------------------------------
// No bus
// --------------------------------------------------------------------------

/** Run `fn` where `sessionBus()` can only answer `null`. */
async function withoutBus(fn) {
  const saved = {
    addr: process.env.DBUS_SESSION_BUS_ADDRESS,
    runtime: process.env.XDG_RUNTIME_DIR,
    platform: process.platform,
  };
  delete process.env.DBUS_SESSION_BUS_ADDRESS;
  delete process.env.XDG_RUNTIME_DIR;
  // darwin has launchd to fall back to, so there is always an address there.
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: saved.platform });
    if (saved.addr !== undefined)
      process.env.DBUS_SESSION_BUS_ADDRESS = saved.addr;
    if (saved.runtime !== undefined)
      process.env.XDG_RUNTIME_DIR = saved.runtime;
    _resetBusState();
  }
}

describe('with no session bus', () => {
  test('registering answers null and an app still renders', async () => {
    await withoutBus(async () => {
      // ssh, a bare startx, a container, CI, Node 20 without the transport.
      assert.equal(await registerApplication({ appId: APP_ID }), null);

      const app = createMockApp();
      const root = await createRoot({ app });
      root.render(h('window', { width: 100, height: 50 }, h('box', null)));
      await tick();
      assert.equal(app.windows.length, 1, 'the tree mounted anyway');
      await root.unmount();
    });
  });

  test('a cold-start link in argv is delivered without a bus at all', async () => {
    await withoutBus(async () => {
      const seen = [];
      onAppOpen((uris) => seen.push(uris));
      assert.equal(
        await registerApplication({
          appId: APP_ID,
          schemes: [APP_ID],
          argv: [LINK],
        }),
        null,
      );
      await until(() => seen.length === 1, 'the argv link to be delivered');
      assert.deepEqual(seen[0], [LINK]);
    });
  });
});

// --------------------------------------------------------------------------
// The raise
// --------------------------------------------------------------------------

describe('activateWindow', () => {
  const mount = async (element) => {
    const app = createMockApp();
    const root = await createRoot({ app });
    root.render(element ?? h('window', { width: 200, height: 100 }));
    await tick();
    return { app, root };
  };

  /** The `_NET_ACTIVE_WINDOW` messages this connection sent. */
  const raises = (app) =>
    app.clientMessages.filter(
      (m) => m.type === app._atoms.get('_NET_ACTIVE_WINDOW'),
    );

  test('goes to the root, about our window, with the timestamp given', async () => {
    const { app, root } = await mount();
    const wnd = app.windows[0];

    assert.equal(activateWindow(wnd, { timestamp: 12345 }), true);
    await tick();

    const [message] = raises(app);
    assert.ok(message, 'a _NET_ACTIVE_WINDOW went out');
    // EWMH sends this to the **root**, about the client window — getting the
    // two the wrong way round is silent and total.
    assert.equal(message.destination, app.X.display.screen[0].root);
    assert.equal(message.wid, wnd.id);
    assert.equal(message.format, 32);
    assert.equal(message.data[0], 1, 'source indication: an application');
    assert.equal(message.data[1], 12345);
    await root.unmount();
  });

  test('null means CurrentTime, which is the honest zero', async () => {
    const { app, root } = await mount();
    activateWindow(app.windows[0], { timestamp: null });
    await tick();
    assert.equal(raises(app)[0].data[1], 0);
    await root.unmount();
  });

  test('with no window named, the app’s only toplevel is the answer', async () => {
    const { app, root } = await mount();
    assert.equal(activateWindow(), true);
    await tick();
    assert.equal(raises(app)[0].wid, app.windows[0].id);
    await root.unmount();
  });

  test('nothing to raise is false rather than a throw', async () => {
    const app = createMockApp();
    const root = await createRoot({ app });
    // Mounted, but nothing rendered: there is no window, and an app that calls
    // this from a launch handler before its first frame must not crash.
    assert.equal(activateWindow(), false);
    assert.equal(activateWindow(null, { timestamp: 1 }), false);
    await root.unmount();
  });

  test('a component raises its own window from a buffered link', async () => {
    // The shape the docs show, end to end: a launch that arrived before the
    // tree existed replays into `useAppOpen`, and the handler raises the
    // window that render produced — with the launch's own timestamp, which is
    // the only number a window manager will accept as a reason.
    const received = [];

    function App() {
      const win = React.useRef(null);
      useAppOpen((uris, ctx) => {
        received.push(uris);
        activateWindow(win, { timestamp: ctx.timestamp });
      });
      return h('window', { ref: win, width: 200, height: 100 });
    }

    await withoutBus(async () => {
      process.env.DESKTOP_STARTUP_ID = 'launcher/app.desktop/1-0_TIME4242';
      try {
        await registerApplication({
          appId: APP_ID,
          schemes: [APP_ID],
          argv: [LINK],
        });
      } finally {
        delete process.env.DESKTOP_STARTUP_ID;
      }

      const { app, root } = await mount(h(App));
      await until(() => received.length === 1, 'the link to reach the tree');
      assert.deepEqual(received[0], [LINK]);

      await until(() => raises(app).length === 1, 'the window to be raised');
      assert.equal(raises(app)[0].wid, app.windows[0].id);
      assert.equal(raises(app)[0].data[1], 4242, 'the launch timestamp');
      await root.unmount();
    });
  });
});
