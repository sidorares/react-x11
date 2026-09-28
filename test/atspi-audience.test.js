// The AT-SPI bridge with nobody listening (src/atspi.js, "nobody
// listening"): an accessibility bus runs in most Linux sessions whether or
// not an assistive technology does, and the registry is what knows. With no
// event registered there and no call from anybody but the registry, the
// bridge falls silent — nothing pushed, nothing exported — and it speaks
// again for good at the first listener or the first call.
//
// The same in-process broker as test/atspi.test.js, with a stub registry
// that also answers GetRegisteredEvents and can announce a listener.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import {
  transportAvailable,
  startBroker,
  stopBroker,
  until,
} from './helpers/with-bus.js';

const haveTransport = await transportAvailable();
const needsBroker = haveTransport
  ? {}
  : { skip: 'dbus-native is not installed (expected on Node < 22.12)' };

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ROOT_PATH = '/org/a11y/atspi/accessible/root';
const ACCESSIBLE = 'org.a11y.atspi.Accessible';
const REGISTRY = 'org.a11y.atspi.Registry';
const REGISTRY_PATH = '/org/a11y/atspi/registry';

describe(
  'a bridge nobody listens to',
  { concurrency: 1, ...needsBroker },
  () => {
    let dbus;
    let broker;
    let registry; // the stub at-spi2-registryd
    let at; // a client that overhears every signal
    let signals;
    /** What GetRegisteredEvents answers, per test. */
    let listeners = [];
    let asked = 0;

    async function client() {
      const bus = dbus.createClient({ busAddress: broker.addressString });
      await new Promise((resolve, reject) => {
        bus.connection.once('connect', resolve);
        bus.connection.once('error', reject);
      });
      await bus.listNames();
      return bus;
    }

    before(async () => {
      dbus = (await import('dbus-native')).default;
      broker = await startBroker();
      registry = await client();
      await registry.requestName(REGISTRY, 0);
      registry.exportInterface(
        {
          Embed() {
            return [REGISTRY, ROOT_PATH];
          },
          Unembed() {
            return null;
          },
        },
        ROOT_PATH,
        {
          name: 'org.a11y.atspi.Socket',
          methods: { Embed: ['(so)', '(so)'], Unembed: ['(so)', ''] },
        },
      );
      registry.exportInterface(
        {
          GetRegisteredEvents() {
            asked++;
            return listeners;
          },
        },
        REGISTRY_PATH,
        {
          name: REGISTRY,
          methods: { GetRegisteredEvents: ['', 'a(ss)'] },
          signals: {
            EventListenerRegistered: ['ssas', 'bus', 'event', 'props'],
          },
        },
      );
      at = await client();
      signals = [];
      await at.addMatch("type='signal'");
      at.connection.on('message', (msg) => {
        if (msg.type === 4 /* signal */) signals.push(msg);
      });
      process.env.AT_SPI_BUS_ADDRESS = broker.addressString;
    });

    after(async () => {
      delete process.env.AT_SPI_BUS_ADDRESS;
      const { _stopForTests } = await import('../src/atspi.js');
      await _stopForTests();
      for (const bus of [registry, at]) {
        try {
          await bus.close();
        } catch {
          // the broker may already be gone
        }
      }
      await stopBroker(broker);
    });

    function Rows({ n, label }) {
      return h(
        'window',
        { title: 'Audience', width: 320, height: 400 },
        h('box', { role: 'button', focusable: true }, h('text', null, label)),
        h(
          'box',
          { role: 'list' },
          ...Array.from({ length: n }, (_, i) =>
            h('box', { key: i, role: 'listitem' }, h('text', null, `row ${i}`)),
          ),
        ),
      );
    }

    /** A fresh bridge over a fresh app, once the registry has been asked. */
    async function bridgeOver(events) {
      const atspi = await import('../src/atspi.js');
      await atspi._stopForTests();
      listeners = events;
      asked = 0;
      const { createRoot } = await import('../src/index.js');
      const { createMockApp } = await import('./helpers/mock-app.js');
      const app = createMockApp();
      // the test starts its own bridge: createRoot's would race it
      const root = await createRoot({ app, desktop: { a11y: false } });
      root.render(h(Rows, { n: 3, label: 'Save' }));
      await tick();
      await tick();
      const bridge = await atspi.start();
      assert.ok(bridge, 'the bridge came up against the broker');
      await until(() => asked > 0, 'the registry to be asked who listens');
      await pause(20);
      return { root, bridge };
    }

    const heardFrom = (bridge) =>
      signals.filter((msg) => msg.sender === bridge.bus.name);

    test('with no listener and no caller it says nothing', async () => {
      const { root, bridge } = await bridgeOver([]);
      assert.equal(bridge.audience, false, 'silent');
      assert.equal(bridge.exported.size, 0, 'and nothing left exported');
      const before = heardFrom(bridge).length;

      root.render(h(Rows, { n: 40, label: 'Saved' }));
      await tick();
      await pause(50);
      root.render(h(Rows, { n: 2, label: 'Save' }));
      await tick();
      await pause(50);
      assert.equal(heardFrom(bridge).length, before, 'no signal for anything');
      assert.equal(bridge.exported.size, 0, 'and nothing exported for it');
      const { announce } = await import('../src/a11y.js');
      assert.equal(announce('saved'), false, 'an announcement goes unheard');

      // An AT that registered for nothing still has to ask to read anything,
      // and asking is enough: the tree it reads is the live one, and changes
      // are pushed from then on.
      const children = await at.invoke({
        destination: bridge.bus.name,
        path: ROOT_PATH,
        interface: ACCESSIBLE,
        member: 'GetChildren',
      });
      assert.equal(children.length, 1, 'the window, read as it is');
      assert.equal(bridge.audience, true, 'the call woke it');
      root.render(h(Rows, { n: 6, label: 'Save' }));
      await until(
        () =>
          heardFrom(bridge).some(
            (msg) =>
              msg.member === 'ChildrenChanged' ||
              msg.member === 'AddAccessible',
          ),
        'the rows that arrived to be pushed',
      );
      root.unmount();
    });

    test('a listener registering wakes it', async () => {
      const { root, bridge } = await bridgeOver([]);
      assert.equal(bridge.audience, false, 'silent');
      registry.sendSignal(
        REGISTRY_PATH,
        REGISTRY,
        'EventListenerRegistered',
        'ssas',
        [':1.999', 'object:state-changed', []],
      );
      await until(() => bridge.audience, 'the listener to be heard');
      const before = heardFrom(bridge).length;
      root.render(h(Rows, { n: 5, label: 'Save' }));
      await until(
        () => heardFrom(bridge).length > before,
        'the change to be pushed',
      );
      root.unmount();
    });

    test('a listener registered before the app speaks from the start', async () => {
      const { root, bridge } = await bridgeOver([[':1.999', 'focus:']]);
      assert.equal(bridge.audience, true);
      const before = heardFrom(bridge).length;
      root.render(h(Rows, { n: 5, label: 'Save' }));
      await until(
        () => heardFrom(bridge).length > before,
        'the change to be pushed',
      );
      root.unmount();
    });
  },
);
