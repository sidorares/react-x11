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

const ROLE = {
  APPLICATION: 75,
  FRAME: 23,
  BUTTON: 43,
  ENTRY: 79,
  LABEL: 29,
  LIST_ITEM: 32,
};
const STATE = {
  CHECKED: 4,
  EDITABLE: 7,
  ENABLED: 8,
  FOCUSABLE: 11,
  FOCUSED: 12,
  SELECTED: 23,
};
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
    // GetRoleName is the AT-SPI name, not the ARIA one the app wrote:
    // libatspi derives role names locally from the number, so a bridge
    // answering its own vocabulary here is inconsistent with its own
    // GetRole and nothing notices until an AT asks over the wire (which is
    // how this was found — scripts/a11y-probe.mjs does ask).
    assert.equal(
      await call(appBus, paths.button, ACCESSIBLE, 'GetRoleName'),
      'button',
    );
    assert.equal(
      await call(appBus, framePath, ACCESSIBLE, 'GetRoleName'),
      'frame',
    );
    // …and the ARIA role travels as an attribute, where the browsers put it.
    // `a{ss}` reads back as pairs or as a plain object depending on the
    // connection's value shapes, so normalise rather than pin one.
    const attrs = await call(appBus, paths.button, ACCESSIBLE, 'GetAttributes');
    const entries = Array.isArray(attrs) ? attrs : Object.entries(attrs);
    assert.deepEqual(
      entries.find(([k]) => k === 'xml-roles'),
      ['xml-roles', 'button'],
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

  test('a composition is system text; the character it commits is not', async () => {
    const wnd = app.windows[0];
    const input = wnd._reactX11Node.children[1];
    // compose in the middle of the value, so a wrong index space shows up
    // as a wrong offset rather than as the end of the string either way
    await call(appBus, paths.input, TEXT, 'SetCaretOffset', 'i', [2]);
    const before = await call(
      appBus,
      paths.input,
      TEXT,
      'GetText',
      'ii',
      [0, -1],
    );
    const chars = Array.from(before);
    signals.length = 0;

    // A dead key. The accent is on the screen and in nobody's value.
    input.defaultComposition({ type: 'compositionUpdate', data: '´' });
    await until(
      () => eventsNamed('TextChanged').length >= 1,
      'the preedit insert',
    );
    assert.deepEqual(
      eventsNamed('TextChanged').map((s) => [
        s.body[0],
        s.body[1],
        dbus.variantValue(s.body[3]),
      ]),
      [['insert:system', 2, '´']],
      'a preedit is text the user did not type — Gecko\'s ":system" suffix',
    );
    assert.equal(input.value, chars.join(''), 'the value did not move');

    // The Text interface answers with what is drawn: an AT tracking the
    // caret or magnifying character 3 has to land on the glyphs, and the
    // layout every extent is read from is the layout of *this* string.
    const composed = [...chars.slice(0, 2), '´', ...chars.slice(2)].join('');
    assert.equal(
      await call(appBus, paths.input, TEXT, 'GetText', 'ii', [0, -1]),
      composed,
    );
    assert.equal(
      await getProp(appBus, paths.input, TEXT, 'CharacterCount'),
      chars.length + 1,
    );
    // the caret is at the far end of the composition, where the next
    // keystroke of the sequence will appear
    assert.equal(await getProp(appBus, paths.input, TEXT, 'CaretOffset'), 3);

    // …and which part of it is uncommitted is a text run, not a guess
    assert.deepEqual(
      await call(appBus, paths.input, TEXT, 'GetAttributes', 'i', [2]),
      // `underline` is the registered AT-SPI attribute for what is drawn;
      // `composition` is this renderer's own, because AT-SPI registers
      // nothing for a preedit
      [{ underline: 'single', composition: 'true' }, 2, 3],
    );
    assert.deepEqual(
      await call(appBus, paths.input, TEXT, 'GetAttributes', 'i', [0]),
      [{}, 0, 2],
      'the committed text before it is one plain run, bounded by the preedit',
    );
    assert.equal(
      await call(appBus, paths.input, TEXT, 'GetAttributeValue', 'is', [
        2,
        'underline',
      ]),
      'single',
    );

    // The commit. The accent leaving is still system text — nothing was
    // deleted — but `é` is what the user typed, so it is a plain insert and
    // a reader that suppresses system text still speaks it.
    signals.length = 0;
    input.defaultComposition({ type: 'compositionEnd', data: 'é' });
    await until(
      () =>
        eventsNamed('TextChanged').some((s) => s.body[0].startsWith('insert')),
      'the commit',
    );
    assert.deepEqual(
      eventsNamed('TextChanged').map((s) => [
        s.body[0],
        s.body[1],
        dbus.variantValue(s.body[3]),
      ]),
      [
        ['delete:system', 2, '´'],
        ['insert', 2, 'é'],
      ],
    );
    assert.equal(
      await call(appBus, paths.input, TEXT, 'GetText', 'ii', [0, -1]),
      [...chars.slice(0, 2), 'é', ...chars.slice(2)].join(''),
    );
    assert.deepEqual(
      await call(appBus, paths.input, TEXT, 'GetAttributes', 'i', [2]),
      [{}, 0, chars.length + 1],
      'nothing is composing any more',
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

  test('a registered element that reports text is read and edited like an input', async () => {
    // #257: the seam a package outside react-x11 implements — a text state
    // it reports and a replacement it accepts — has to reach the wire as
    // the Text/EditableText pair, or a third-party editor is silent to Orca
    // with no way to fix it from outside.
    const { registerElement, unregisterElement } =
      await import('../src/host.js');
    const { Node } = await import('../src/node.js');

    class MiniEditorNode extends Node {
      constructor(props, app) {
        super('minieditor', props, app);
        this.text = String(props.defaultValue ?? '');
        this.caret = this.text.length;
      }
      a11yTextState() {
        return {
          value: this.text,
          caret: this.caret,
          selectionStart: this.caret,
          selectionEnd: this.caret,
          editable: true,
          multiline: true,
        };
      }
      a11yReplaceText(start, end, text) {
        const chars = Array.from(this.text);
        chars.splice(start, end - start, ...Array.from(text));
        this.text = chars.join('');
        this.caret = start + Array.from(text).length;
        this.notifyA11yTextChanged();
        return true;
      }
      a11ySetSelection(start, end) {
        this.caret = end;
        void start;
        this.notifyA11yTextChanged();
        return true;
      }
    }

    /** The read-only tier: text and a selection, nothing to type into. */
    class MiniDocNode extends Node {
      constructor(props, app) {
        super('minidoc', props, app);
      }
      a11yTextState() {
        return { value: String(this.props.text ?? '') };
      }
    }

    /** Editable text the user types but an AT may not: the element
     * implements no write half. */
    class MiniOwnNode extends Node {
      constructor(props, app) {
        super('miniown', props, app);
      }
      a11yTextState() {
        return { value: 'mine', editable: true, multiline: false };
      }
    }

    registerElement('minieditor', {
      create: (props, app) => new MiniEditorNode(props, app),
      semanticNames: ['defaultValue'],
      childrenAllowed: false,
    });
    registerElement('minidoc', {
      create: (props, app) => new MiniDocNode(props, app),
      semanticNames: ['text'],
      childrenAllowed: false,
    });
    registerElement('miniown', {
      create: (props, app) => new MiniOwnNode(props, app),
      childrenAllowed: false,
    });
    x11Root.render(
      h(
        'window',
        { title: 'Bridge Test', width: 320, height: 200 },
        h('minieditor', { defaultValue: 'let x = 1' }),
        h('minidoc', { text: 'read me' }),
        h('miniown', null),
      ),
    );
    await settle();
    const frameChildren = await call(
      appBus,
      framePath,
      ACCESSIBLE,
      'GetChildren',
    );
    const editorPath = frameChildren[0][1];
    const docPath = frameChildren[1][1];
    const ownPath = frameChildren[2][1];

    // the role it never declared, from the text it reports
    assert.equal(
      await call(appBus, editorPath, ACCESSIBLE, 'GetRole'),
      ROLE.ENTRY,
    );
    const ifaces = await call(appBus, editorPath, ACCESSIBLE, 'GetInterfaces');
    assert.ok(ifaces.includes(TEXT), 'the Text interface');
    assert.ok(ifaces.includes(EDITABLE), 'and EditableText, since it writes');
    // the viewer reads, and only reads: an EditableText whose every method
    // answered false would be a lie an AT cannot see through
    const docIfaces = await call(appBus, docPath, ACCESSIBLE, 'GetInterfaces');
    assert.ok(docIfaces.includes(TEXT));
    assert.ok(!docIfaces.includes(EDITABLE), 'nothing may type into a viewer');
    assert.equal(
      await call(appBus, docPath, TEXT, 'GetText', 'ii', [0, -1]),
      'read me',
    );
    // …and an element whose text only *it* edits is announced as editable
    // without being offered as one an AT may write to
    const ownIfaces = await call(appBus, ownPath, ACCESSIBLE, 'GetInterfaces');
    assert.ok(ownIfaces.includes(TEXT));
    assert.ok(!ownIfaces.includes(EDITABLE), 'no write half, no EditableText');
    assert.ok(
      hasState(
        await call(appBus, ownPath, ACCESSIBLE, 'GetState'),
        STATE.EDITABLE,
      ),
      'the EDITABLE state is still true of it',
    );

    assert.equal(await getProp(appBus, editorPath, TEXT, 'CharacterCount'), 9);
    assert.deepEqual(
      await call(appBus, editorPath, TEXT, 'GetStringAtOffset', 'iu', [4, 1]),
      ['x', 4, 5],
    );

    // the AT types: one replacement through the element's own seam, and the
    // diff comes back off the state it reports afterwards
    signals.length = 0;
    assert.equal(
      await call(appBus, editorPath, EDITABLE, 'InsertText', 'isi', [
        9,
        ' + 2',
        4,
      ]),
      true,
    );
    await until(
      () =>
        eventsNamed('TextChanged').some(
          (s) => s.path === editorPath && s.body[0] === 'insert',
        ),
      'the edit as a text-changed insert',
    );
    assert.equal(
      await call(appBus, editorPath, TEXT, 'GetText', 'ii', [0, -1]),
      'let x = 1 + 2',
    );

    // …and the caret it moves is a caret the element moved
    signals.length = 0;
    assert.equal(
      await call(appBus, editorPath, TEXT, 'SetCaretOffset', 'i', [3]),
      true,
    );
    await until(
      () => eventsNamed('TextCaretMoved').some((s) => s.path === editorPath),
      'the caret move',
    );
    assert.equal(await getProp(appBus, editorPath, TEXT, 'CaretOffset'), 3);

    unregisterElement('minieditor');
    unregisterElement('minidoc');
    unregisterElement('miniown');
  });

  test('a drawn scene is children an AT can walk, name and act on', async () => {
    // #304: an element that paints N interactive things is one accessible
    // to the bridge and therefore one object to Orca — "group", nothing
    // inside. What it says it drew has to arrive as real children, with
    // rectangles, states, and actions that reach the element.
    const { registerElement, unregisterElement } =
      await import('../src/host.js');
    const { Node } = await import('../src/node.js');

    const clicks = [];
    const routed = [];
    let graphNode = null;

    class MiniGraphNode extends Node {
      constructor(props, app, kind = 'minigraph') {
        super(kind, props, app);
        this.focusableByDefault = true;
        this.selected = null;
      }
      a11yScene() {
        return (this.props.nodes ?? []).map((node, i) => ({
          id: node.id,
          role: this.props.itemRole ?? 'button',
          name: node.label,
          rect: {
            x: this.abs.x + 8,
            y: this.abs.y + 8 + i * 30,
            width: 120,
            height: 24,
          },
          states: { selected: this.selected === node.id },
        }));
      }
      select(id) {
        this.selected = id;
        this.notifyA11ySceneChanged();
      }
    }

    /** The other half of the seam: an element that answers for itself. */
    class MiniChartNode extends MiniGraphNode {
      constructor(props, app) {
        super(props, app, 'minichart');
      }
      a11ySceneAction(id, action) {
        routed.push([id, action]);
        return true;
      }
    }

    registerElement('minigraph', {
      create: (props, app) => (graphNode = new MiniGraphNode(props, app)),
      semanticNames: ['nodes', 'itemRole'],
      childrenAllowed: false,
    });
    registerElement('minichart', {
      create: (props, app) => new MiniChartNode(props, app),
      semanticNames: ['nodes', 'itemRole'],
      childrenAllowed: false,
    });

    const nodes = [
      { id: 'fetch', label: 'Fetch' },
      { id: 'parse', label: 'Parse' },
    ];
    const graph = (props) =>
      h(
        'window',
        { title: 'Bridge Test', width: 320, height: 200 },
        h('minigraph', {
          nodes,
          onClick: (ev) => clicks.push([ev.x, ev.y]),
          style: { width: 200, height: 100 },
          ...props,
        }),
        h('minichart', {
          nodes,
          // a role ARIA promises no activation for: the element answering
          // actions is what makes these activatable anyway
          itemRole: 'listitem',
          style: { width: 200, height: 100 },
        }),
      );
    x11Root.render(graph());
    await settle();

    const [graphRef, chartRef] = await call(
      appBus,
      framePath,
      ACCESSIBLE,
      'GetChildren',
    );
    const graphPath = graphRef[1];
    const items = await call(appBus, graphPath, ACCESSIBLE, 'GetChildren');
    assert.equal(items.length, 2, 'one accessible per drawn node');
    const [fetchPath, parsePath] = items.map((ref) => ref[1]);

    assert.equal(
      await call(appBus, fetchPath, ACCESSIBLE, 'GetRole'),
      ROLE.BUTTON,
    );
    assert.equal(
      await getProp(appBus, parsePath, ACCESSIBLE, 'Name'),
      'Parse',
      'named, where the element was one nameless group',
    );
    assert.equal(
      await call(appBus, parsePath, ACCESSIBLE, 'GetIndexInParent'),
      1,
    );
    assert.deepEqual(
      await getProp(appBus, parsePath, ACCESSIBLE, 'Parent'),
      [appBus, graphPath],
      'the element is the parent an AT walks back up to',
    );

    // a rectangle is what focus is drawn around and what a magnifier tracks
    const extents = await call(
      appBus,
      parsePath,
      COMPONENT,
      'GetExtents',
      'u',
      [1],
    );
    assert.deepEqual(extents.slice(2), [120, 24]);
    // …and the point inside it answers with the item, not with the element
    const atPoint = await call(
      appBus,
      graphPath,
      COMPONENT,
      'GetAccessibleAtPoint',
      'iiu',
      [extents[0] + 4, extents[1] + 4, 1],
    );
    assert.deepEqual(atPoint, [appBus, parsePath]);

    // activating one is the click a mouse user would make on it, at the
    // rect the element drew — the element hit-tests its own scene already
    assert.equal(
      await call(appBus, parsePath, ACTION, 'DoAction', 'i', [0]),
      true,
    );
    await until(() => clicks.length === 1, 'the click at the item');
    const [x, y] = clicks[0];
    assert.ok(
      x >= extents[0] && x < extents[0] + 120,
      'inside the item horizontally',
    );
    assert.ok(y >= extents[1] && y < extents[1] + 24, 'and vertically');

    // a scene the element changes on its own reaches the bus as that child
    // changing, not as the pane being rebuilt
    signals.length = 0;
    graphNode.select('parse');
    await until(
      () =>
        eventsNamed('StateChanged').some(
          (s) => s.path === parsePath && s.body[0] === 'selected',
        ),
      'the selection as a state change on the item',
    );
    assert.ok(
      hasState(
        await call(appBus, parsePath, ACCESSIBLE, 'GetState'),
        STATE.SELECTED,
      ),
    );

    // an item that leaves is a child removed, and its path goes with it
    signals.length = 0;
    x11Root.render(graph({ nodes: [nodes[0]] }));
    await settle();
    await until(
      () =>
        eventsNamed('ChildrenChanged').some(
          (s) => s.path === graphPath && s.body[0] === 'remove',
        ),
      'the child removal',
    );
    await until(async () => {
      try {
        await call(appBus, parsePath, ACCESSIBLE, 'GetRole');
        return false;
      } catch {
        return true; // the path went with it
      }
    }, 'the departed item to be unexported');
    assert.equal(
      (await call(appBus, graphPath, ACCESSIBLE, 'GetChildren')).length,
      1,
    );

    // …and an element with an answer of its own is the one that acts
    const chartItems = await call(
      appBus,
      chartRef[1],
      ACCESSIBLE,
      'GetChildren',
    );
    assert.equal(
      await call(appBus, chartItems[1][1], ACTION, 'DoAction', 'i', [0]),
      true,
    );
    assert.equal(
      await call(appBus, chartItems[0][1], COMPONENT, 'GrabFocus'),
      true,
    );
    assert.deepEqual(routed, [
      ['parse', 'activate'],
      ['fetch', 'focus'],
    ]);
    assert.equal(clicks.length, 1, 'and core did not click as well');

    unregisterElement('minigraph');
    unregisterElement('minichart');
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
