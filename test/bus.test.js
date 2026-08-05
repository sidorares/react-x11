// The bus floor (issue #163): lazy, shared, ref-counted, name-ready, and
// unable to crash an app that has no bus.
//
// Every behaviour the contract names is a test here rather than a comment in
// src/bus.js, because the whole point of the layer is what it does in
// environments the developer writing against it is not sitting in — an ssh
// session, a container, CI, a Node 20 install with no transport at all.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import React from 'react';

import {
  BusUnavailableError,
  closeBus,
  sessionBus,
  systemBus,
  _resetBusState,
} from '../src/bus.js';
import { useSessionBus } from '../src/bushooks.js';
import { act, cleanup, renderX11 } from '../src/testing/index.js';
import {
  startBroker,
  stopBroker,
  transportAvailable,
  until,
  withBus,
} from './helpers/with-bus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');

// On Node 20 npm skips `dbus-native` (its own engines field is >=22.12), which
// is the degradation this layer is designed around rather than a problem to
// route around. The tests that need a real broker skip there; the ones that
// assert the *absence* of a transport run everywhere.
const haveTransport = await transportAvailable();
const needsBroker = haveTransport
  ? {}
  : { skip: 'dbus-native is not installed (expected on Node < 22.12)' };

function run(args, env = {}, timeout = 20000) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      args,
      { cwd: repo, env: { ...process.env, ...env }, timeout },
      (error, stdout, stderr) =>
        resolve({ code: error?.code ?? 0, error, stdout, stderr }),
    );
    child.on('error', () => {});
  });
}

/** Run a snippet of ESM in a child process, from the repo root. */
function runScript(source, env = {}, nodeArgs = [], timeout) {
  return run(
    [...nodeArgs, '--input-type=module', '--eval', source],
    env,
    timeout,
  );
}

/**
 * Poll a rendering condition, flushing React's queue between attempts.
 *
 * An update scheduled from a promise callback is *queued* while an `act()`
 * scope is open, so polling from inside one would never see it — each attempt
 * has to be its own act. This is the difference between a hook test that
 * passes and one that times out staring at the first render.
 */
async function untilRendered(predicate, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${message}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

/**
 * A socket path nothing is listening on yet — the tests that need to start and
 * stop a broker at a *fixed* address, which is what a daemon restart looks
 * like from the client's side.
 */
async function reservedSocket() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rx11-bus-'));
  return path.join(dir, 'socket');
}

/** Point the session bus at `address` for the duration of `fn`. */
async function withAddress(address, fn) {
  const saved = process.env.DBUS_SESSION_BUS_ADDRESS;
  process.env.DBUS_SESSION_BUS_ADDRESS = address;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
    else process.env.DBUS_SESSION_BUS_ADDRESS = saved;
    await closeBus('session').catch(() => {});
    _resetBusState();
  }
}

// ---------------------------------------------------------------------------

describe('import safety', () => {
  // The single most important rule in this layer: nothing throws at import
  // time and nothing dials a socket. `--eval` runs from the repo root, with no
  // DBUS_SESSION_BUS_ADDRESS and no XDG_RUNTIME_DIR — the ssh/CI/container
  // configuration, which is react-x11's flagship persona rather than an edge
  // case.
  test('importing react-x11 with no bus loads no transport and exits 0', async () => {
    // dbus-native is CJS, and the ESM loader evaluates a CJS package through
    // the CJS loader — so `require.cache` is where a module that really was
    // loaded shows up, whichever syntax reached it. Nothing else in the
    // process touches it, so a single entry is proof.
    const source = `
      import './src/index.js';
      const { createRequire } = await import('node:module');
      const require = createRequire(process.cwd() + '/');
      const cached = Object.keys(require.cache).filter((p) => p.includes('dbus-native'));
      if (cached.length) {
        console.error('dbus-native was loaded at import time: ' + cached[0]);
        process.exit(3);
      }
      console.log('ok');
    `;
    const { code, stdout, stderr } = await runScript(source, {
      DBUS_SESSION_BUS_ADDRESS: undefined,
      XDG_RUNTIME_DIR: undefined,
    });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /ok/);
  });

  test('calling sessionBus() with no bus answers null rather than throwing', async () => {
    const source = `
      import { sessionBus, systemBus } from './src/bus.js';
      const s = await sessionBus();
      const y = await systemBus();
      console.log(JSON.stringify({ session: s, system: y }));
    `;
    const { code, stdout, stderr } = await runScript(source, {
      DBUS_SESSION_BUS_ADDRESS: undefined,
      XDG_RUNTIME_DIR: undefined,
      DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/nonexistent/react-x11-test-system',
    });
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { session: null, system: null });
  });
});

describe('the transport is absent', () => {
  // The Node 20 configuration, run on every Node: `dbus-native` fails to
  // resolve, and "no transport installed" collapses into "no bus here" rather
  // than adding a mode.
  const loader = path.join(here, 'helpers', 'no-dbus.mjs');

  test('sessionBus() is null and the cause says the transport is missing', async () => {
    const source = `
      import { sessionBus, BusUnavailableError } from './src/bus.js';
      console.log(JSON.stringify({ ref: await sessionBus() }));
      try {
        await sessionBus({ required: true });
        process.exit(4);
      } catch (err) {
        console.log(JSON.stringify({
          name: err.constructor.name,
          kind: err.kind,
          cause: err.cause?.message ?? '',
        }));
      }
    `;
    const { code, stdout, stderr } = await runScript(source, {}, [
      '--import',
      loader,
    ]);
    assert.equal(code, 0, stderr);
    const [absent, required] = stdout.trim().split('\n').map(JSON.parse);
    assert.equal(absent.ref, null);
    assert.equal(required.name, 'BusUnavailableError');
    assert.equal(required.kind, 'session');
    assert.match(required.cause, /transport is not installed/);
    assert.match(required.cause, /npm i dbus-native/);
  });

  test('useSessionBus() reports unavailable with that cause', async () => {
    const source = `
      import React from 'react';
      import { useSessionBus } from './src/bushooks.js';
      import { act, cleanup, renderX11 } from './src/testing/index.js';

      let seen = null;
      function Probe() {
        const handle = useSessionBus();
        seen = handle;
        return React.createElement('text', null, handle.status);
      }
      await renderX11(React.createElement(Probe), { backend: 'mock' });
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      console.log(JSON.stringify({
        status: seen.status,
        bus: seen.bus,
        cause: seen.cause?.cause?.message ?? '',
        retry: typeof seen.retry,
      }));
      await cleanup();
    `;
    const { code, stdout, stderr } = await runScript(source, {}, [
      '--import',
      loader,
    ]);
    assert.equal(code, 0, stderr);
    const seen = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(seen.status, 'unavailable');
    assert.equal(seen.bus, null);
    assert.equal(seen.retry, 'function');
    assert.match(seen.cause, /transport is not installed/);
  });
});

describe('never-throwing', { ...needsBroker }, () => {
  test('a nonexistent socket answers null, and names ENOENT when required', async () => {
    await withAddress(
      'unix:path=/nonexistent/react-x11-no-such-bus',
      async () => {
        assert.equal(await sessionBus(), null);
        await assert.rejects(
          () => sessionBus({ required: true }),
          (err) => {
            assert.ok(err instanceof BusUnavailableError);
            assert.equal(err.kind, 'session');
            // The cause distinguishes this from "no address at all".
            assert.equal(err.cause.code, 'ENOENT');
            return true;
          },
        );
      },
    );
  });

  test('no address at all answers null, with a different cause', async () => {
    const saved = {
      addr: process.env.DBUS_SESSION_BUS_ADDRESS,
      runtime: process.env.XDG_RUNTIME_DIR,
      platform: process.platform,
    };
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    delete process.env.XDG_RUNTIME_DIR;
    // The no-address path is a Linux/BSD one: darwin has launchd to fall back
    // to, so there is always an address to try there.
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      assert.equal(await sessionBus(), null);
      await assert.rejects(
        () => sessionBus({ required: true }),
        (err) => {
          assert.ok(err instanceof BusUnavailableError);
          assert.match(err.cause.message, /no session bus address/);
          assert.equal(err.cause.code, undefined);
          return true;
        },
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: saved.platform });
      if (saved.addr !== undefined)
        process.env.DBUS_SESSION_BUS_ADDRESS = saved.addr;
      if (saved.runtime !== undefined)
        process.env.XDG_RUNTIME_DIR = saved.runtime;
      _resetBusState();
    }
  });
});

describe('against a broker', { ...needsBroker }, () => {
  test('lazy: the first acquisition is what dials', async () => {
    await withBus(async (address, broker) => {
      assert.equal(broker.liveClients, 0, 'importing dialled nothing');
      const ref = await sessionBus();
      assert.ok(ref, 'connected to the broker');
      assert.equal(broker.liveClients, 1);
      await ref.release();
    });
  });

  test('name-ready: uniqueName is a string with no extra awaiting', async () => {
    await withBus(async () => {
      const ref = await sessionBus();
      assert.match(ref.uniqueName, /^:/);
      assert.equal(ref.uniqueName, ref.bus.name);
      await ref.release();
    });
  });

  test('shared: two acquisitions are one socket and one identity', async () => {
    await withBus(async (address, broker) => {
      const [a, b] = await Promise.all([sessionBus(), sessionBus()]);
      assert.equal(broker.liveClients, 1, 'one client on the broker');
      assert.equal(a.bus, b.bus);
      assert.equal(a.uniqueName, b.uniqueName);
      await a.release();
      await b.release();
    });
  });

  test('concurrent acquisitions share one connect attempt', async () => {
    await withBus(async (address, broker) => {
      const refs = await Promise.all(
        Array.from({ length: 8 }, () => sessionBus()),
      );
      assert.equal(broker.liveClients, 1);
      assert.equal(new Set(refs.map((r) => r.uniqueName)).size, 1);
      await Promise.all(refs.map((r) => r.release()));
    });
  });

  test('session and system are separate connections', async () => {
    await withBus(async (address, broker) => {
      process.env.DBUS_SYSTEM_BUS_ADDRESS = address;
      const s = await sessionBus();
      const y = await systemBus();
      assert.equal(broker.liveClients, 2);
      assert.notEqual(s.uniqueName, y.uniqueName);
      await s.release();
      await y.release();
    });
  });

  test('no churn on release: the connection survives zero refs', async () => {
    await withBus(async (address, broker) => {
      const first = await sessionBus();
      const name = first.uniqueName;
      await first.release();
      // The lifecycle decision, made falsifiable: closing at zero refs would
      // show up here as a dropped client and a new unique name below.
      assert.equal(broker.liveClients, 1, 'still connected at zero refs');
      const second = await sessionBus();
      assert.equal(second.uniqueName, name, 'same identity');
      assert.equal(broker.liveClients, 1, 'no new client');
      await second.release();
    });
  });

  test('release() is idempotent per ref', async () => {
    await withBus(async (address, broker) => {
      const a = await sessionBus();
      const b = await sessionBus();
      await a.release();
      await a.release();
      await a.release();
      // If the extra releases had decremented, the count would be at zero and
      // b's would take it negative — which nothing would notice until an
      // unref'd socket let the process exit under a live consumer.
      assert.equal(broker.liveClients, 1);
      await b.release();
      assert.equal(broker.liveClients, 1);
    });
  });

  test('asyncDispose releases', async () => {
    await withBus(async () => {
      let captured;
      {
        const ref = await sessionBus();
        captured = ref;
        await ref[Symbol.asyncDispose]();
      }
      // A second dispose is the same idempotent release.
      await captured[Symbol.asyncDispose]();
    });
  });

  test('retry is not cached: a bus that appears later is found', async () => {
    // A failed attempt answers its waiters and is forgotten. A session bus can
    // genuinely appear later — $XDG_RUNTIME_DIR/bus exists the moment
    // something starts one — so a transient failure must never become a
    // process-lifetime false negative.
    const socket = await reservedSocket();
    let broker = null;
    try {
      await withAddress(`unix:path=${socket}`, async () => {
        assert.equal(await sessionBus(), null, 'nothing listening yet');
        broker = await startBroker({ socket });
        const ref = await sessionBus();
        assert.ok(ref, 'the second attempt connects');
        await ref.release();
      });
    } finally {
      if (broker) await stopBroker(broker);
    }
  });

  test('generation on death: old refs stay harmless, a new one connects', async () => {
    const socket = await reservedSocket();
    let broker = await startBroker({ socket });
    try {
      await withAddress(`unix:path=${socket}`, async () => {
        const old = await sessionBus();
        const oldName = old.uniqueName;

        await stopBroker(broker);
        await until(
          () => old.bus.connection.stream.destroyed,
          'the connection to notice the broker went away',
        );

        // A call on the dead ref fails rather than hanging for a reply that
        // cannot arrive.
        await assert.rejects(() => old.bus.listNames());
        // ...and releasing it is still safe.
        await old.release();

        broker = await startBroker({ socket });
        const fresh = await sessionBus();
        assert.ok(fresh, 'a fresh acquisition dials a new socket');
        // Identity is asserted on the connection rather than on the name: a
        // broker that restarts also restarts its own `:1.N` counter, so the
        // *name* would collide here for a reason that has nothing to do with
        // this layer. The name change is pinned in the next test, against a
        // broker that stays up.
        assert.notEqual(fresh.bus, old.bus, 'a new connection object');
        assert.match(oldName, /^:/);
        await fresh.release();
      });
    } finally {
      await stopBroker(broker);
    }
  });

  test('a connection that dies under a live bus comes back as a new name', async () => {
    // The reason reconnect stays off and a death retires the generation: the
    // replacement is a different client as far as the bus is concerned, so
    // anything holding the old unique name is talking to nobody.
    await withBus(async (address, broker) => {
      const old = await sessionBus();
      const oldName = old.uniqueName;
      old.bus.connection.stream.destroy();
      await until(() => broker.liveClients === 0, 'the client to go away');

      const fresh = await sessionBus();
      assert.notEqual(fresh.uniqueName, oldName, 'a new socket is a new name');
      assert.equal(broker.liveClients, 1);
      // The old ref never becomes dangerous: its calls fail and it releases.
      await assert.rejects(() => old.bus.listNames());
      await old.release();
      await fresh.release();
    });
  });

  test('closeBus() drops the connection and a later acquisition redials', async () => {
    await withBus(async (address, broker) => {
      const first = await sessionBus();
      const name = first.uniqueName;
      await closeBus('session');
      await until(
        () => broker.liveClients === 0,
        'the broker to see the client go',
      );
      // The retired ref releases without disturbing the new generation.
      await first.release();
      const second = await sessionBus();
      assert.notEqual(second.uniqueName, name);
      assert.equal(broker.liveClients, 1);
      await second.release();
    });
  });

  test('closeBus() rejects a kind that is not a bus', async () => {
    await assert.rejects(
      () => closeBus('sesion'),
      /expected "session" or "system"/,
    );
  });
});

describe('the event-loop hold', { ...needsBroker }, () => {
  // Both halves of the ref/unref rule, as process exit — which is the only
  // place the difference is observable.
  test('a process that releases exits; one that holds does not', async () => {
    const broker = await startBroker();
    try {
      const address = broker.address();
      const released = await runScript(
        `
        import { sessionBus } from './src/bus.js';
        const ref = await sessionBus();
        if (!ref) { console.error('no bus'); process.exit(5); }
        await ref.release();
        console.log('released');
        `,
        { DBUS_SESSION_BUS_ADDRESS: address },
      );
      assert.equal(released.code, 0, released.stderr);
      assert.match(released.stdout, /released/);

      // The same script without the release has nothing else keeping the loop
      // alive — no timer, no listener — so if it is still running when the
      // kill lands, it is the ref'd socket holding it. A serving app is this
      // shape, which is why the hold is conditional on the count rather than
      // an unconditional unref.
      const held = await runScript(
        `
        import { sessionBus } from './src/bus.js';
        const ref = await sessionBus();
        if (!ref) { console.error('no bus'); process.exit(5); }
        console.log('held');
        `,
        { DBUS_SESSION_BUS_ADDRESS: address },
        [],
        3000,
      );
      assert.match(held.stdout, /held/);
      assert.ok(
        held.error && (held.error.killed || held.error.signal),
        'a held ref keeps the process alive until it is killed, got ' +
          JSON.stringify({ code: held.code, stderr: held.stderr }),
      );
    } finally {
      await stopBroker(broker);
    }
  });
});

describe('the hooks', { ...needsBroker }, () => {
  test('mount reports connecting, then ready with a unique name', async () => {
    await withBus(async () => {
      const seen = [];
      function Probe() {
        const handle = useSessionBus();
        seen.push(handle);
        return React.createElement('text', null, handle.status);
      }
      const { unmount } = await renderX11(React.createElement(Probe), {
        backend: 'mock',
      });
      assert.equal(seen[0].status, 'connecting');
      assert.equal(seen[0].bus, null);
      await untilRendered(
        () => seen.at(-1).status === 'ready',
        'the hook to reach ready',
      );
      const ready = seen.at(-1);
      assert.equal(ready.status, 'ready');
      assert.ok(ready.bus);
      assert.match(ready.uniqueName, /^:/);
      await unmount();
      await cleanup();
    });
  });

  test('the hook does not churn the connection', async () => {
    await withBus(async (address, broker) => {
      function Probe() {
        const { status } = useSessionBus();
        return React.createElement('text', null, status);
      }
      let name = null;
      for (let i = 0; i < 4; i++) {
        const { unmount } = await renderX11(React.createElement(Probe), {
          backend: 'mock',
        });
        await untilRendered(
          () => broker.liveClients === 1,
          'a client on the broker',
        );
        const ref = await sessionBus();
        name ??= ref.uniqueName;
        // The React-level statement of "no churn on release": StrictMode's
        // double-mount and a dialog that opens and closes are the same shape.
        assert.equal(ref.uniqueName, name, 'same identity across mounts');
        assert.equal(broker.liveClients, 1, 'one client throughout');
        await ref.release();
        await unmount();
      }
      await cleanup();
      assert.equal(broker.liveClients, 1);
    });
  });

  test('a dead connection moves the hook to closed, and retry() recovers', async () => {
    const socket = await reservedSocket();
    let broker = await startBroker({ socket });
    try {
      await withAddress(`unix:path=${socket}`, async () => {
        const seen = [];
        function Probe() {
          const handle = useSessionBus();
          seen.push(handle);
          return React.createElement('text', null, handle.status);
        }
        const { unmount } = await renderX11(React.createElement(Probe), {
          backend: 'mock',
        });
        await untilRendered(() => seen.at(-1).status === 'ready', 'ready');

        await stopBroker(broker);
        await untilRendered(() => seen.at(-1).status === 'closed', 'closed');
        // Deliberately no auto-retry: a silent re-acquire would hand the
        // consumer a fresh bus under the same variable and hide the
        // unique-name change that disabling reconnect exists to expose.
        assert.equal(seen.at(-1).bus, null);

        broker = await startBroker({ socket });
        const mark = seen.length;
        await act(async () => {
          seen.at(-1).retry();
        });
        await untilRendered(
          () => seen.at(-1).status === 'ready',
          'ready again',
        );
        // A retry goes back through 'connecting' rather than leaving the dead
        // connection on screen until the new dial settles — asserted on the
        // render sequence, since how fast the dial lands is not the point.
        assert.equal(seen.slice(mark).map((h) => h.status)[0], 'connecting');
        assert.match(seen.at(-1).uniqueName, /^:/);
        await unmount();
        await cleanup();
      });
    } finally {
      await stopBroker(broker);
    }
  });

  test('no bus at all reports unavailable with a cause, and stays retryable', async () => {
    await withAddress(
      'unix:path=/nonexistent/react-x11-no-such-bus',
      async () => {
        const seen = [];
        function Probe() {
          const handle = useSessionBus();
          seen.push(handle);
          return React.createElement('text', null, handle.status);
        }
        const { unmount } = await renderX11(React.createElement(Probe), {
          backend: 'mock',
        });
        await untilRendered(
          () => seen.at(-1).status === 'unavailable',
          'unavailable',
        );
        const handle = seen.at(-1);
        assert.equal(handle.bus, null);
        assert.ok(handle.cause instanceof BusUnavailableError);
        assert.equal(typeof handle.retry, 'function');
        await unmount();
        await cleanup();
      },
    );
  });
});
