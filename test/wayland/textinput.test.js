// Input methods over text-input v3, against the in-process compositor: the
// text input is made for the seat, enter/leave follow the keyboard, a
// focused <textinput> is described to the compositor — enable, content
// type, caret rectangle, surrounding text, one commit — and the
// compositor's preedit, commit and delete land in the field through the
// composition events a dead key takes. No display, no GPU: the tree is
// mounted on the mock app, and the window it makes stands in for the
// backend window, given the frame insets and scale a real one has.
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';

import { WaylandConnection } from '../../src/wayland/connection.js';
import { WaylandWindow } from '../../src/wayland/window.js';
import { WaylandSeat } from '../../src/wayland/seat.js';
import {
  WaylandTextInput,
  CONTENT_HINT,
  CONTENT_PURPOSE,
  CHANGE_CAUSE,
  MAX_SURROUNDING_BYTES,
  surroundingText,
  charsWithin,
  preeditCursor,
} from '../../src/wayland/textinput.js';
import {
  MockCompositor,
  until,
  waylandClientAvailable,
} from './mock-compositor.js';
import { createRoot } from '../../src/index.js';
import { React, createMockApp } from '../helpers/mock-app.js';

const SKIP = waylandClientAvailable
  ? false
  : 'wayland-client (the fork) is not installed';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  await tick();
  await tick();
};

/** The frame a decorated toplevel has, and a HiDPI output. */
const INSETS = { top: 37, left: 0, right: 0, bottom: 0 };
const SCALE = 2;

let mock;
let conn;
let seat;
let surface;
let mockApp;
let root;
let wnd;
let input; // <textinput name="a">
let secret; // <textinput name="b" sensitive inputMode="email">
let area; // <textarea>
let textInput;
const changes = [];
const compositions = [];

/** A plain key through the pipeline, as the seat would deliver one. */
function typeKey(codepoint) {
  const keycode = (codepoint % 248) + 8;
  mockApp.X.keycode2keysyms[keycode] = [codepoint];
  wnd.emit('keydown', {
    keycode,
    keysym: codepoint,
    baseKeysym: codepoint,
    codepoint,
    buttons: 0,
  });
}

/** The text-input requests since `mark`, by name. */
const namesSince = (mark) => mock.textInputRequests(mark).map((r) => r.name);
const argsOf = (mark, name) =>
  mock.textInputRequests(mark).find((r) => r.name === name)?.args;
const requestCount = () => mock.textInputRequests().length;

/** The caret rectangle the field would report, in surface-local logical px. */
function expectedRect(node) {
  const box = node.contentBox();
  return [
    Math.round(box.x / SCALE + INSETS.left),
    Math.round(box.y / SCALE + INSETS.top),
    1,
    Math.round(box.height / SCALE),
  ];
}

before(async () => {
  if (SKIP) return;
  mock = new MockCompositor({ width: 640, height: 480 });
  const p = await mock.listen();
  const sock = net.createConnection(p);
  await new Promise((r) => sock.once('connect', r));
  conn = await WaylandConnection.open({
    socket: sock,
    protocols: [
      'xdg-shell',
      'cursor-shape-v1',
      'viewporter',
      'fractional-scale-v1',
      'text-input-unstable-v3',
    ],
  });
  const compositor = await conn.require('wl_compositor');
  const wmBase = await conn.require('xdg_wm_base');
  seat = await WaylandSeat.bind(conn);
  surface = WaylandWindow.createSync({
    conn,
    compositor,
    wmBase,
    title: 'IME',
    width: 300,
    height: 200,
  });
  await surface.whenConfigured;

  // The tree: three fields in one window, on the mock app.
  mockApp = createMockApp();
  root = await createRoot({ app: mockApp });
  const record = (phase) => (ev) =>
    compositions.push([
      phase,
      ev.data,
      ev.target.props.name,
      ev.cursorBegin,
      ev.cursorEnd,
    ]);
  root.render(
    h(
      'window',
      { width: 300, height: 200 },
      h('textinput', {
        name: 'a',
        defaultValue: '',
        onChange: (ev) =>
          changes.push({ value: ev.value, native: ev.nativeEvent }),
        onCompositionStart: record('start'),
        onCompositionUpdate: record('update'),
        onCompositionEnd: record('end'),
      }),
      h('textinput', {
        name: 'b',
        defaultValue: 'hunter2',
        sensitive: true,
        inputMode: 'email',
        onCompositionStart: record('start'),
        onCompositionUpdate: record('update'),
        onCompositionEnd: record('end'),
      }),
      h('textarea', { name: 'c', defaultValue: 'lines' }),
    ),
  );
  await settle();
  wnd = mockApp.windows[0];
  // what a WaylandBackendWindow has and the mock window does not
  wnd.insets = INSETS;
  wnd.scale = SCALE;
  const find = (node, pred) =>
    pred(node)
      ? node
      : node.children.reduce((a, c) => a || find(c, pred), null);
  const tree = wnd._reactX11Node;
  input = find(tree, (n) => n.props?.name === 'a');
  secret = find(tree, (n) => n.props?.name === 'b');
  area = find(tree, (n) => n.props?.name === 'c');

  // The text input over an app-shaped object: the connection, the seat and
  // the surface → window map are all it reads.
  textInput = await WaylandTextInput.create({
    conn,
    seat,
    windows: new Map([[surface.surface.id, wnd]]),
  });
});

after(async () => {
  textInput?.destroy();
  await root?.unmount();
  surface?.destroy();
  conn?.destroy();
  mock?.close();
});

test(
  'the text input is made for the seat, and enter/leave follow the keyboard',
  { skip: SKIP },
  async () => {
    assert.ok(textInput, 'the mock advertises the manager');
    await until(() => mock.textInput, { what: 'get_text_input' });
    const made = mock.sent('zwp_text_input_manager_v3', 'get_text_input')[0];
    assert.equal(made.args[1], seat.seat.id, 'made for our seat');
    mock.textInputEnter(surface.surface.id);
    await until(() => textInput.entered === surface.surface.id, {
      what: 'enter',
    });
    await conn.roundtrip();
    assert.equal(
      requestCount(),
      0,
      'nothing focused, so nothing is enabled — the IME stays off the window',
    );
    mock.textInputLeave(surface.surface.id);
    await until(() => textInput.entered === null, { what: 'leave' });
    await conn.roundtrip();
    assert.equal(requestCount(), 0, 'and nothing to disable either');
  },
);

test(
  'a focused field is described on enter: enable, content type, caret rectangle and surrounding text in one commit',
  { skip: SKIP },
  async () => {
    input.focus();
    assert.equal(wnd._reactX11Node.events.focused, input);
    const mark = requestCount();
    mock.textInputEnter(surface.surface.id);
    await until(() => namesSince(mark).includes('commit'), {
      what: 'the field to be enabled',
    });
    assert.deepEqual(namesSince(mark), [
      'enable',
      'set_content_type',
      'set_cursor_rectangle',
      'set_surrounding_text',
      'commit',
    ]);
    assert.deepEqual(argsOf(mark, 'set_content_type'), [
      CONTENT_HINT.NONE,
      CONTENT_PURPOSE.NORMAL,
    ]);
    // no fonts on the mock, so the field offers its content box: through
    // the frame insets and the scale into surface-local logical pixels
    assert.deepEqual(argsOf(mark, 'set_cursor_rectangle'), expectedRect(input));
    assert.ok(
      argsOf(mark, 'set_cursor_rectangle')[1] >= INSETS.top,
      'below the titlebar',
    );
    assert.deepEqual(argsOf(mark, 'set_surrounding_text'), ['', 0, 0]);
    assert.equal(textInput.commits, 1);
    assert.equal(textInput.active.node, input);
  },
);

test(
  'a preedit shows at the caret and is not the value; a commit is; the application hears start, update and end',
  { skip: SKIP },
  async () => {
    compositions.length = 0;
    changes.length = 0;
    // か is 3 bytes: a cursor over the whole of it
    mock.preeditString('か', 0, 3);
    mock.textInputDone();
    await until(() => input._preedit === 'か', { what: 'the preedit' });
    assert.equal(input.value, '', 'a composition is not the value');
    assert.deepEqual(
      input._preeditCursor,
      { begin: 0, end: 1 },
      'bytes became code points',
    );
    assert.equal(changes.length, 0, 'and fires no onChange');
    assert.deepEqual(compositions, [
      ['start', '', 'a', undefined, undefined],
      ['update', 'か', 'a', 0, 1],
    ]);

    mock.commitString('漢字');
    mock.preeditString('', 0, 0);
    mock.textInputDone();
    await until(() => input.value === '漢字', { what: 'the commit' });
    assert.equal(input._preedit, '', 'the composition ended');
    assert.equal(input._caret, 2, 'the caret is after what was committed');
    assert.deepEqual(
      changes.map((c) => c.value),
      ['漢字'],
      'one onChange for the commit',
    );
    assert.equal(
      changes[0].native?.type,
      'text-input',
      'no key behind it: the native event says what it was',
    );
    assert.deepEqual(compositions.slice(2), [
      ['end', '漢字', 'a', undefined, undefined],
    ]);
    assert.equal(textInput.doneSerial, 1);
  },
);

test(
  "the field's changes go back as surrounding text — the IME's own with no cause, the user's as `other`",
  { skip: SKIP },
  async () => {
    // the frame after the commit: the backend window calls sync
    let mark = requestCount();
    textInput.sync(wnd);
    await conn.roundtrip();
    assert.deepEqual(namesSince(mark), ['set_surrounding_text', 'commit']);
    assert.deepEqual(
      argsOf(mark, 'set_surrounding_text'),
      ['漢字', 6, 6],
      'byte offsets',
    );

    // nothing changed: nothing sent
    mark = requestCount();
    textInput.sync(wnd);
    await conn.roundtrip();
    assert.deepEqual(namesSince(mark), []);

    // a key the IME declined types through the pipeline as usual
    typeKey(0x61);
    assert.equal(input.value, '漢字a');
    mark = requestCount();
    textInput.sync(wnd);
    await conn.roundtrip();
    assert.deepEqual(namesSince(mark), [
      'set_text_change_cause',
      'set_surrounding_text',
      'commit',
    ]);
    assert.deepEqual(argsOf(mark, 'set_text_change_cause'), [
      CHANGE_CAUSE.OTHER,
    ]);
    assert.deepEqual(argsOf(mark, 'set_surrounding_text'), ['漢字a', 7, 7]);

    // the caret moving is a change of cursor with the same text
    input._moveCaret(1, false);
    mark = requestCount();
    textInput.sync(wnd);
    await conn.roundtrip();
    assert.deepEqual(argsOf(mark, 'set_surrounding_text'), ['漢字a', 3, 3]);
    input._moveCaret(3, false);
    textInput.sync(wnd);
    await conn.roundtrip();
  },
);

test(
  'delete_surrounding_text counts bytes around the selection, and a stale done is applied all the same',
  { skip: SKIP },
  async () => {
    changes.length = 0;
    // 4 bytes before the caret: 'a' (1) and '字' (3)
    mock.deleteSurroundingText(4, 0);
    mock.commitString('!');
    mock.textInputDone(0 /* not the number of commits we sent */);
    await until(() => input.value === '漢!', { what: 'delete then commit' });
    assert.deepEqual(
      changes.map((c) => c.value),
      ['漢', '漢!'],
      'the deletion and the commit are two edits',
    );
    const mark = requestCount();
    textInput.sync(wnd);
    await conn.roundtrip();
    assert.deepEqual(
      namesSince(mark),
      ['set_surrounding_text', 'commit'],
      "the IME's own change: reported without a cause",
    );
    assert.deepEqual(argsOf(mark, 'set_surrounding_text'), ['漢!', 4, 4]);
  },
);

test(
  'focus moving to another field disables and re-enables; a sensitive field offers no surrounding text; a textarea is multiline',
  { skip: SKIP },
  async () => {
    secret.focus();
    let mark = requestCount();
    textInput.sync(wnd);
    await conn.roundtrip();
    assert.deepEqual(namesSince(mark), [
      'disable',
      'commit',
      'enable',
      'set_content_type',
      'set_cursor_rectangle',
      'commit',
    ]);
    assert.deepEqual(argsOf(mark, 'set_content_type'), [
      CONTENT_HINT.SENSITIVE_DATA,
      CONTENT_PURPOSE.EMAIL,
    ]);
    assert.deepEqual(
      argsOf(mark, 'set_cursor_rectangle'),
      expectedRect(secret),
    );
    assert.equal(textInput.active.node, secret);

    // …and the secret's edits move the caret rectangle but never the text
    typeKey(0x78);
    mark = requestCount();
    textInput.sync(wnd);
    await conn.roundtrip();
    assert.ok(!namesSince(mark).includes('set_surrounding_text'));
    assert.deepEqual(
      argsOf(mark, 'set_text_change_cause'),
      [CHANGE_CAUSE.OTHER],
      'the cause still tells the IME its preedit is stale',
    );

    area.focus();
    mark = requestCount();
    textInput.sync(wnd);
    await conn.roundtrip();
    assert.deepEqual(argsOf(mark, 'set_content_type'), [
      CONTENT_HINT.MULTILINE,
      CONTENT_PURPOSE.NORMAL,
    ]);
    assert.deepEqual(argsOf(mark, 'set_surrounding_text'), ['lines', 5, 5]);
  },
);

test(
  'focus leaving a composing field abandons the preedit and the application hears the end',
  { skip: SKIP },
  async () => {
    secret.focus();
    textInput.sync(wnd);
    compositions.length = 0;
    mock.preeditString('ü', 2, 2);
    mock.textInputDone();
    await until(() => secret._preedit === 'ü', { what: 'a preedit on b' });
    assert.deepEqual(compositions, [
      ['start', '', 'b', undefined, undefined],
      ['update', 'ü', 'b', 1, 1],
    ]);
    input.focus();
    const mark = requestCount();
    textInput.sync(wnd);
    await conn.roundtrip();
    assert.equal(secret._preedit, '');
    assert.equal(secret.value, 'hunter2x', 'nothing was committed');
    assert.deepEqual(compositions[2], ['end', '', 'b', undefined, undefined]);
    assert.deepEqual(namesSince(mark).slice(0, 3), [
      'disable',
      'commit',
      'enable',
    ]);
  },
);

test(
  'leave mid-composition drops the preedit and disables; a sync for a window that is not the entered one sends nothing',
  { skip: SKIP },
  async () => {
    compositions.length = 0;
    mock.preeditString('n', -1, -1);
    mock.textInputDone();
    await until(() => input._preedit === 'n', { what: 'a preedit on a' });
    assert.equal(
      input._preeditCursor,
      null,
      'a hidden cursor is drawn at the end',
    );
    const mark = requestCount();
    mock.textInputLeave(surface.surface.id);
    await until(() => textInput.entered === null, { what: 'leave' });
    await conn.roundtrip();
    assert.equal(input._preedit, '');
    assert.equal(input.value, '漢!');
    assert.deepEqual(compositions.pop(), [
      'end',
      '',
      'a',
      undefined,
      undefined,
    ]);
    assert.deepEqual(namesSince(mark), ['disable', 'commit']);
    assert.equal(textInput.active, null);

    // events for a field that is no longer active go nowhere
    mock.commitString('lost');
    mock.textInputDone();
    await conn.roundtrip();
    assert.equal(input.value, '漢!');

    const other = { _reactX11Node: null, insets: INSETS, scale: 1 };
    mock.textInputEnter(surface.surface.id);
    await until(() => textInput.entered === surface.surface.id, {
      what: 're-enter',
    });
    const before = requestCount();
    textInput.sync(other);
    await conn.roundtrip();
    assert.equal(requestCount() - before, 0);
  },
);

test('surrounding text: the whole value when it fits, a window around the selection when it does not', () => {
  assert.deepEqual(surroundingText('héllo', 2, 5), {
    text: 'héllo',
    cursor: 3,
    anchor: 6,
  });
  const long = 'x'.repeat(3000) + '漢'.repeat(2000);
  const s = surroundingText(long, 3500, 3490);
  assert.ok(Buffer.byteLength(s.text) <= MAX_SURROUNDING_BYTES);
  assert.ok(s.cursor > s.anchor, 'the selection is inside the window');
  assert.equal(s.cursor - s.anchor, 30, 'ten CJK characters');
  const chars = Array.from(s.text);
  assert.ok(chars.length > 1000, 'grown outward from the selection');
  // a selection wider than the cap is clipped to it rather than dropped
  const wide = surroundingText('漢'.repeat(2000), 0, 2000);
  assert.ok(Buffer.byteLength(wide.text) <= MAX_SURROUNDING_BYTES);
  assert.equal(wide.cursor, 0);
});

test('bytes to characters: whole characters only, either direction', () => {
  const chars = Array.from('a漢b');
  assert.equal(charsWithin(chars, 3, -4), 2, "'b' and '漢'");
  assert.equal(
    charsWithin(chars, 3, -2),
    1,
    'a count inside 漢 stops before it',
  );
  assert.equal(charsWithin(chars, 0, 4), 2);
  assert.equal(charsWithin(chars, 0, 100), 3);
  assert.deepEqual(preeditCursor('か゛', 3, 6), {
    cursorBegin: 1,
    cursorEnd: 2,
  });
  assert.deepEqual(preeditCursor('ab', 1, 0), { cursorBegin: 1, cursorEnd: 1 });
  assert.equal(preeditCursor('ab', -1, -1), undefined);
});
