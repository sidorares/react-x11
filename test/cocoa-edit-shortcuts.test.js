// The text controls' shortcuts on the cocoa backend, and the edit menu that
// prints them.
//
// A Mac edits with ⌘: ⌘Z, ⇧⌘Z, ⌘X, ⌘C, ⌘V, ⌘A. The bridge reports ⌘ as
// `metaKey` (cocoa/keymap.js, the DOM's own macOS convention), and the
// controls answered only `ctrlKey` — so ⌘C in a field copied nothing, ⌘S
// typed an `s` (AppKit hands over the key's bare character with ⌘ held), and
// the right-click menu printed `Ctrl+C` beside a Copy no Mac user presses
// that way. The app now says its primary modifier is ⌘
// (`app.primaryModifier`, src/keysyms.js), and everything that reads a
// chord reads that.
//
// And the menu closes when the user goes to another application. No press
// reaches us for that — the grab redirects presses between windows of ours,
// and the popup panel never takes the keyboard — so the window's blur is
// what says so.
//
// Headless, over test/helpers/cocoa-bridge.js's recording fake. Input goes
// through the bridge's own event shape (`app._route`), the route a real
// NSEvent takes.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import { editMenuOpen } from '../src/index.js';
import { cleanupCocoa, mountCocoa, tick } from './helpers/cocoa-bridge.js';

const h = React.createElement;

afterEach(cleanupCocoa);

/** `NSPasteboard.general`, as far as the clipboard shim reaches it. */
function pasteboardOn(native, text = null) {
  const pb = { text };
  native.pasteboardWriteText = (value) => {
    pb.text = value;
  };
  native.pasteboardReadText = () => pb.text;
  native.pasteboardClear = () => {
    pb.text = null;
  };
  return pb;
}

/**
 * A bridge key press. `chars` is what the key types with no modifiers
 * (`charactersByApplyingModifiers:0`) and `shifted` what
 * `charactersIgnoringModifiers` gives — the key's own character, Shift
 * applied and ⌘ not, which is exactly why a ⌘ chord can look like typing.
 */
function press(app, wnd, { keyCode, chars, shifted = chars, ...modifiers }) {
  const ev = {
    windowNumber: wnd.windowNumber,
    keyCode,
    charsBase: chars,
    charsShifted: shifted,
    time: performance.now(),
    ...modifiers,
  };
  app._route({ type: 'keydown', ...ev });
  app._route({ type: 'keyup', ...ev });
}

// kVK_ANSI_*
const KEY = {
  a: { keyCode: 0, chars: 'a' },
  s: { keyCode: 1, chars: 's' },
  z: { keyCode: 6, chars: 'z' },
  x: { keyCode: 7, chars: 'x' },
  c: { keyCode: 8, chars: 'c' },
  v: { keyCode: 9, chars: 'v' },
  y: { keyCode: 16, chars: 'y' },
};
const RETURN = { keyCode: 36 };

/** Put the selection, anchor to caret, the way shift+arrows would. */
function select(field, anchor, caret = anchor) {
  field._moveCaret(anchor, false);
  field._moveCaret(caret, true);
}
const cmd = (key, extra = {}) => ({ ...key, command: true, ...extra });

/** A bridge right-click at the centre of `node`. */
function rightClick(app, node) {
  const wnd = node.root.window;
  const s = wnd.scale;
  const x = (node.abs.x + node.abs.width / 2) / s;
  const y = (node.abs.y + node.abs.height / 2) / s;
  const ev = {
    windowNumber: wnd.windowNumber,
    x,
    y,
    gx: wnd.x / s + x,
    gy: wnd.y / s + y,
    button: 3,
    time: performance.now(),
  };
  app._route({ type: 'mousedown', ...ev });
  app._route({ type: 'mouseup', ...ev });
}

async function mountField(props = {}) {
  const input = React.createRef();
  const changes = [];
  const mounted = await mountCocoa(
    h('textinput', {
      ref: input,
      defaultValue: 'hello world',
      onChange: (ev) => changes.push(ev.value),
      ...props,
    }),
    { width: 300, height: 80 },
  );
  input.current.focus();
  return { ...mounted, input, changes };
}

test('the app says ⌘ is its primary modifier', async () => {
  const { app } = await mountField();
  assert.strictEqual(app.primaryModifier, 'Super');
});

test('⌘A, ⌘C, ⌘X, ⌘V, ⌘Z and ⇧⌘Z do in a field what they do on a Mac', async () => {
  const { native, app, wnd, input } = await mountField();
  const pb = pasteboardOn(native, 'copied elsewhere');

  press(app, wnd, cmd(KEY.a));
  assert.strictEqual(input.current._selectedText(), 'hello world', '⌘A');

  press(app, wnd, cmd(KEY.c));
  await tick();
  assert.strictEqual(pb.text, 'hello world', '⌘C');
  assert.strictEqual(input.current.value, 'hello world');

  press(app, wnd, cmd(KEY.x));
  await tick();
  assert.strictEqual(input.current.value, '', '⌘X');
  assert.strictEqual(pb.text, 'hello world');

  pb.text = 'pasted';
  press(app, wnd, cmd(KEY.v));
  await tick();
  await tick();
  assert.strictEqual(input.current.value, 'pasted', '⌘V');

  press(app, wnd, cmd(KEY.z));
  assert.strictEqual(input.current.value, '', '⌘Z');
  // Shift is applied to `charactersIgnoringModifiers`, ⌘ is not
  press(app, wnd, cmd(KEY.z, { shift: true, shifted: 'Z' }));
  assert.strictEqual(input.current.value, 'pasted', '⇧⌘Z');
});

test('a ⌘ chord the field has no answer for types nothing', async () => {
  // ⌘S belongs to whatever bound it; before, the field took the bare `s`
  // AppKit hands over with it and typed it
  const { app, wnd, input, changes } = await mountField();
  press(app, wnd, cmd(KEY.s));
  // …and ⌘Y is not a redo here, Windows' Ctrl+Y notwithstanding
  press(app, wnd, cmd(KEY.y));
  assert.strictEqual(input.current.value, 'hello world');
  assert.deepStrictEqual(changes, []);
});

test('⌃ is not the primary modifier: ⌃C copies nothing, and ⌃A types nothing', async () => {
  const { native, app, wnd, input, changes } = await mountField();
  const pb = pasteboardOn(native, 'copied elsewhere');
  select(input.current, 0, 11);

  press(app, wnd, { ...KEY.c, control: true });
  await tick();
  assert.strictEqual(pb.text, 'copied elsewhere');

  select(input.current, 0);
  press(app, wnd, { ...KEY.a, control: true });
  assert.strictEqual(input.current.value, 'hello world');
  assert.deepStrictEqual(changes, []);
});

test('⌘↩ submits a textarea', async () => {
  const submitted = [];
  const area = React.createRef();
  const { app, wnd } = await mountCocoa(
    h('textarea', {
      ref: area,
      defaultValue: 'note',
      onSubmit: (ev) => submitted.push(ev.value),
    }),
    { width: 300, height: 120 },
  );
  area.current.focus();
  select(area.current, 4);

  press(app, wnd, { ...RETURN, control: true });
  assert.deepStrictEqual(submitted, [], '⌃↩ is a newline here');
  assert.strictEqual(area.current.value, 'note\n');

  press(app, wnd, { ...RETURN, command: true });
  assert.deepStrictEqual(submitted, ['note\n']);
});

test('the edit menu prints ⌘, and switching to another application closes it', async () => {
  const { app, wnd, input } = await mountField();
  select(input.current, 0, 5);

  rightClick(app, input.current);
  assert.strictEqual(editMenuOpen(input.current), true, 'the premise');
  const rows = input.current._editMenu._editMenuRows;
  assert.deepStrictEqual(
    rows.filter((row) => !row.separator).map((row) => row.shortcut),
    ['⌘Z', '⇧⌘Z', '⌘X', '⌘C', '⌘V', '⌘A'],
  );

  // AppKit's windowDidResignKey, which is all the bridge says when the user
  // ⌘-Tabs away or clicks another application's window
  app._route({ type: 'window-blur', windowNumber: wnd.windowNumber });
  assert.strictEqual(editMenuOpen(input.current), false);
  assert.ok(app._grabWindow == null, 'and its grab went with it');
});
