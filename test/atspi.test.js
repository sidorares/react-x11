// The AT-SPI bridge, end to end, with no desktop: an in-process message bus
// (dbus-native's broker), a stub registry owning org.a11y.atspi.Registry,
// and a test client playing the screen reader — connecting, walking the
// tree with real Accessible/Component/Text calls, driving the app through
// Action and EditableText, and collecting the signals Orca would.
//
// AT_SPI_BUS_ADDRESS pointed at the broker is the same seam a sandboxed
// desktop uses, so the bridge under test runs the exact code a real session
// runs from the GetAddress reply onward; only the discovery rung is skipped.
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
const settle = async () => {
  await tick();
  await tick();
};

const ROOT_PATH = '/org/a11y/atspi/accessible/root';
const CACHE_PATH = '/org/a11y/atspi/cache';
const ACCESSIBLE = 'org.a11y.atspi.Accessible';
const COMPONENT = 'org.a11y.atspi.Component';
const ACTION = 'org.a11y.atspi.Action';
const TEXT = 'org.a11y.atspi.Text';
const EDITABLE = 'org.a11y.atspi.EditableText';
const VALUE = 'org.a11y.atspi.Value';
const PROPERTIES = 'org.freedesktop.DBus.Properties';

const ROLE = { APPLICATION: 75, FRAME: 23, BUTTON: 43, ENTRY: 79, LABEL: 29 };
const STATE = { CHECKED: 4, ENABLED: 8, FOCUSABLE: 11, FOCUSED: 12 };
const hasState = ([lo, hi], bit) =>
  bit < 32 ? Boolean(lo & (1 << bit)) : Boolean(hi & (1 << (bit - 32)));

describe('the AT-SPI bridge', { concurrency: 1, ...needsBroker }, () => {
  let dbus;
  let broker;
  let registry; // the stub at-spi2-registryd
  let at; // the test client playing the screen reader
  let signals; // every signal `at` overhears, raw
  const embeds = [];

  /** A connected dbus-native client on the broker, name settled. */
  async function client() {
    const bus = dbus.createClient({ busAddress: broker.addressString });
    await new Promise((resolve, reject) => {
      bus.connection.once('connect', resolve);
      bus.connection.once('error', reject);
    });
    await bus.listNames();
    return bus;
  }

  const call = (dest, path, iface, member, signature = '', body = []) =>
    at.invoke({
      destination: dest,
      path,
      interface: iface,
      member,
      signature,
      body,
    });

  const getProp = async (dest, path, iface, name) => {
    const variant = await call(dest, path, PROPERTIES, 'Get', 'ss', [
      iface,
      name,
    ]);
    return dbus.variantValue(variant);
  };

  const eventsNamed = (member) => signals.filter((s) => s.member === member);

  before(async () => {
    dbus = (await import('dbus-native')).default;
    broker = await startBroker();
    // the stub registry: owns the well-known name, answers Socket.Embed
    // with a desktop ref, exactly what at-spi2-registryd would
    registry = await client();
    await registry.requestName('org.a11y.atspi.Registry', 0);
    registry.exportInterface(
      {
        Embed(plug) {
          embeds.push(plug);
          return ['org.a11y.atspi.Registry', ROOT_PATH];
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
    // the "screen reader": subscribes to everything and keeps the raw feed
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

  // shared across the tests below, in order — one app, one bridge, the way
  // one process has one
  let app;
  let x11Root;
  let appBus; // the app's unique name on the a11y bus
  let framePath;
  let pressed = 0;
  const paths = {};

  test('climbs the ladder, embeds, and exposes the application', async () => {
    const { createRoot } = await import('../src/index.js');
    const { createMockApp } = await import('./helpers/mock-app.js');
    const { startA11y } = await import('../src/a11y.js');

    app = createMockApp();
    x11Root = await createRoot({ app });
    x11Root.render(
      h(
        'window',
        { title: 'Bridge Test', width: 320, height: 200 },
        h(
          'box',
          { role: 'button', focusable: true, onClick: () => pressed++ },
          h('text', null, 'Save'),
        ),
        h('textinput', { defaultValue: 'hello' }),
      ),
    );
    await settle();

    const bridge = await startA11y();
    assert.ok(bridge, 'the bridge came up against the broker');
    await until(() => embeds.length === 1, 'the Embed handshake');
    // the plug ref names the app's unique name and its root path
    assert.equal(embeds[0][1], ROOT_PATH);
    appBus = embeds[0][0];

    assert.equal(
      await call(appBus, ROOT_PATH, ACCESSIBLE, 'GetRole'),
      ROLE.APPLICATION,
    );
    assert.equal(
      await getProp(
        appBus,
        ROOT_PATH,
        'org.a11y.atspi.Application',
        'ToolkitName',
      ),
      'react-x11',
    );
    // the desktop ref the registry answered with is the root's parent
    assert.deepEqual(await getProp(appBus, ROOT_PATH, ACCESSIBLE, 'Parent'), [
      'org.a11y.atspi.Registry',
      ROOT_PATH,
    ]);
  });

  test('the frame and its subtree read correctly over the wire', async () => {
    const children = await call(appBus, ROOT_PATH, ACCESSIBLE, 'GetChildren');
    assert.equal(children.length, 1, 'one toplevel window');
    assert.equal(children[0][0], appBus);
    framePath = children[0][1];

    assert.equal(
      await call(appBus, framePath, ACCESSIBLE, 'GetRole'),
      ROLE.FRAME,
    );
    assert.equal(
      await getProp(appBus, framePath, ACCESSIBLE, 'Name'),
      'Bridge Test',
    );

    const frameChildren = await call(
      appBus,
      framePath,
      ACCESSIBLE,
      'GetChildren',
    );
    assert.equal(frameChildren.length, 2, 'the button and the input');
    paths.button = frameChildren[0][1];
    paths.input = frameChildren[1][1];

    assert.equal(
      await call(appBus, paths.button, ACCESSIBLE, 'GetRole'),
      ROLE.BUTTON,
    );
    assert.equal(
      await getProp(appBus, paths.button, ACCESSIBLE, 'Name'),
      'Save',
      'name from contents',
    );
    assert.equal(
      await call(appBus, paths.button, ACCESSIBLE, 'GetIndexInParent'),
      0,
    );
    const states = await call(appBus, paths.button, ACCESSIBLE, 'GetState');
    assert.ok(hasState(states, STATE.ENABLED));
    assert.ok(hasState(states, STATE.FOCUSABLE));
    assert.ok(!hasState(states, STATE.FOCUSED));

    // the label under the button is a LABEL leaf
    const inside = await call(appBus, paths.button, ACCESSIBLE, 'GetChildren');
    assert.equal(inside.length, 1);
    assert.equal(
      await call(appBus, inside[0][1], ACCESSIBLE, 'GetRole'),
      ROLE.LABEL,
    );

    // Component answers rectangles once layout ran
    const extents = await call(
      appBus,
      paths.button,
      COMPONENT,
      'GetExtents',
      'u',
      [1],
    );
    assert.equal(extents.length, 4);
    assert.ok(extents[2] > 0, 'the button has laid-out width');
  });

  test('Cache.GetItems is the whole tree in one call', async () => {
    const items = await call(
      appBus,
      CACHE_PATH,
      'org.a11y.atspi.Cache',
      'GetItems',
    );
    const roles = items.map((item) => item[7]);
    assert.ok(roles.includes(ROLE.APPLICATION));
    assert.ok(roles.includes(ROLE.FRAME));
    assert.ok(roles.includes(ROLE.BUTTON));
    const buttonItem = items.find((item) => item[7] === ROLE.BUTTON);
    assert.equal(buttonItem[0][1], paths.button, 'refs are stable');
    assert.equal(buttonItem[2][1], framePath, 'parent ref points at the frame');
    assert.equal(buttonItem[6], 'Save');
  });

  test('DoAction("activate") is a real press gesture', async () => {
    const actions = await call(appBus, paths.button, ACTION, 'GetActions');
    assert.deepEqual(actions, [['activate', '', '']]);
    assert.equal(
      await call(appBus, paths.button, ACTION, 'DoAction', 'i', [0]),
      true,
    );
    await until(() => pressed === 1, 'the onClick handler');

    // Controls that act on the *press* — Select and MenuBar drop their
    // menus on mousedown — must hear an AT activation too.
    let pressedDown = 0;
    x11Root.render(
      h(
        'window',
        { title: 'Bridge Test', width: 320, height: 200 },
        h(
          'box',
          { role: 'button', focusable: true, onClick: () => pressed++ },
          h('text', null, 'Save'),
        ),
        h('textinput', { defaultValue: 'hello' }),
        h('box', {
          role: 'button',
          'aria-label': 'Open menu',
          onMouseDown: () => pressedDown++,
        }),
      ),
    );
    await settle();
    const kids = await call(appBus, framePath, ACCESSIBLE, 'GetChildren');
    await call(appBus, kids[2][1], ACTION, 'DoAction', 'i', [0]);
    await until(() => pressedDown === 1, 'the onMouseDown handler');

    // restore the tree the following tests were written against
    x11Root.render(
      h(
        'window',
        { title: 'Bridge Test', width: 320, height: 200 },
        h(
          'box',
          { role: 'button', focusable: true, onClick: () => pressed++ },
          h('text', null, 'Save'),
        ),
        h('textinput', { defaultValue: 'hello' }),
      ),
    );
    await settle();
  });

  test('focus lands as state-changed:focused plus the legacy Focus', async () => {
    signals.length = 0;
    assert.equal(await call(appBus, paths.input, COMPONENT, 'GrabFocus'), true);
    await until(
      () =>
        eventsNamed('StateChanged').some(
          (s) =>
            s.body[0] === 'focused' &&
            s.body[1] === 1 &&
            s.path === paths.input,
        ),
      'the focused state change',
    );
    assert.ok(
      eventsNamed('Focus').some((s) => s.path === paths.input),
      'the legacy Focus event went with it',
    );
    const states = await call(appBus, paths.input, ACCESSIBLE, 'GetState');
    assert.ok(hasState(states, STATE.FOCUSED));
  });

  test('the Text interface reads what the input holds', async () => {
    assert.equal(await getProp(appBus, paths.input, TEXT, 'CharacterCount'), 5);
    assert.equal(
      await call(appBus, paths.input, TEXT, 'GetText', 'ii', [0, -1]),
      'hello',
    );
    const [word, start, end] = await call(
      appBus,
      paths.input,
      TEXT,
      'GetStringAtOffset',
      'iu',
      [1, 1],
    );
    assert.deepEqual([word, start, end], ['hello', 0, 5]);
    assert.equal(
      await call(appBus, paths.input, TEXT, 'SetCaretOffset', 'i', [2]),
      true,
    );
    assert.equal(await getProp(appBus, paths.input, TEXT, 'CaretOffset'), 2);
  });

  test('an edit through EditableText emits the text-changed diff', async () => {
    signals.length = 0;
    assert.equal(
      await call(appBus, paths.input, EDITABLE, 'SetTextContents', 's', [
        'help me',
      ]),
      true,
    );
    // 'hello' -> 'help me': common prefix 'hel', delete 'lo', insert 'p me'
    await until(
      () => eventsNamed('TextChanged').length >= 2,
      'both halves of the diff',
    );
    const changes = eventsNamed('TextChanged').map((s) => ({
      kind: s.body[0],
      offset: s.body[1],
      length: s.body[2],
      text: dbus.variantValue(s.body[3]),
    }));
    assert.deepEqual(changes, [
      { kind: 'delete', offset: 3, length: 2, text: 'lo' },
      { kind: 'insert', offset: 3, length: 4, text: 'p me' },
    ]);
    assert.equal(
      await call(appBus, paths.input, TEXT, 'GetText', 'ii', [0, -1]),
      'help me',
    );
  });

  test('typing into the focused control reaches the AT as a diff', async () => {
    signals.length = 0;
    const wnd = app.windows[0];
    const input = wnd._reactX11Node.children[1];
    assert.equal(input.kind, 'textinput');
    input._insert('!');
    await until(
      () =>
        eventsNamed('TextChanged').some(
          (s) => s.body[0] === 'insert' && dbus.variantValue(s.body[3]) === '!',
        ),
      'the keystroke diff',
    );
    await until(
      () => eventsNamed('TextCaretMoved').length > 0,
      'the caret move that went with it',
    );
  });

  test('a state prop change becomes one precise state-changed event', async () => {
    // reach the checkbox in a fresh render: props flow through commitUpdate
    x11Root.render(
      h(
        'window',
        { title: 'Bridge Test', width: 320, height: 200 },
        h(
          'box',
          { role: 'button', focusable: true, onClick: () => pressed++ },
          h('text', null, 'Save'),
        ),
        h('textinput', { defaultValue: 'hello' }),
        h('box', { role: 'checkbox', 'aria-checked': false }),
      ),
    );
    await settle();
    await until(
      () => eventsNamed('ChildrenChanged').some((s) => s.body[0] === 'add'),
      'the checkbox joining the tree',
    );
    const frameChildren = await call(
      appBus,
      framePath,
      ACCESSIBLE,
      'GetChildren',
    );
    paths.checkbox = frameChildren[2][1];
    let states = await call(appBus, paths.checkbox, ACCESSIBLE, 'GetState');
    assert.ok(!hasState(states, STATE.CHECKED));

    signals.length = 0;
    x11Root.render(
      h(
        'window',
        { title: 'Bridge Test', width: 320, height: 200 },
        h(
          'box',
          { role: 'button', focusable: true, onClick: () => pressed++ },
          h('text', null, 'Save'),
        ),
        h('textinput', { defaultValue: 'hello' }),
        h('box', { role: 'checkbox', 'aria-checked': true }),
      ),
    );
    await settle();
    await until(
      () =>
        eventsNamed('StateChanged').some(
          (s) =>
            s.body[0] === 'checked' &&
            s.body[1] === 1 &&
            s.path === paths.checkbox,
        ),
      'the checked state change',
    );
    states = await call(appBus, paths.checkbox, ACCESSIBLE, 'GetState');
    assert.ok(hasState(states, STATE.CHECKED));
  });

  test('aria-valuenow is a live Value interface', async () => {
    x11Root.render(
      h(
        'window',
        { title: 'Bridge Test', width: 320, height: 200 },
        h('box', {
          role: 'slider',
          'aria-valuenow': 40,
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          onAccessibilityAction: (ev) => {
            paths.lastAction = ev;
          },
        }),
      ),
    );
    await settle();
    const frameChildren = await call(
      appBus,
      framePath,
      ACCESSIBLE,
      'GetChildren',
    );
    const sliderPath = frameChildren[0][1];
    assert.equal(await getProp(appBus, sliderPath, VALUE, 'CurrentValue'), 40);
    assert.equal(await getProp(appBus, sliderPath, VALUE, 'MaximumValue'), 100);
    // the AT writes the value; the widget's handler hears a setValue action
    await call(appBus, sliderPath, PROPERTIES, 'Set', 'ssv', [
      VALUE,
      'CurrentValue',
      ['d', 25],
    ]);
    await until(() => paths.lastAction?.action === 'setValue', 'the action');
    assert.equal(paths.lastAction.value, 25);
  });

  test('announce() reaches the bus as an Announcement', async () => {
    const { announce } = await import('../src/index.js');
    signals.length = 0;
    assert.equal(announce('saved', { assertive: true }), true);
    await until(() => eventsNamed('Announcement').length === 1, 'the event');
    const [detail, politeness, , text] = eventsNamed('Announcement')[0].body;
    assert.equal(detail, '');
    assert.equal(politeness, 2);
    assert.equal(dbus.variantValue(text), 'saved');
  });

  test('unmounting removes the tree and tells the cache', async () => {
    signals.length = 0;
    x11Root.render(null);
    await settle();
    await until(
      () => eventsNamed('RemoveAccessible').length > 0,
      'the cache removals',
    );
    await until(
      () =>
        eventsNamed('ChildrenChanged').some(
          (s) => s.body[0] === 'remove' && s.path === ROOT_PATH,
        ),
      'the application losing its child',
    );
    const children = await call(appBus, ROOT_PATH, ACCESSIBLE, 'GetChildren');
    assert.equal(children.length, 0);
  });
});
