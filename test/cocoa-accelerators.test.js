// Accelerators on the cocoa backend: a chord's `Control` is ⌘ there, in the
// binding as in the label — and a menu the macOS menu bar has taken over is
// not answered twice.
//
// The menu bar has always installed `[['Control', 'S']]` as ⌘S
// (cocoa/globalmenu.js), and the text controls answer ⌘ since the app said
// ⌘ is its primary modifier (`app.primaryModifier`). What still read the
// chord literally was the accelerator path: `useAccelerator` and a drawn
// `MenuBar`/`ContextMenu` fired on ⌃S, and a drawn row printed `Ctrl+S`.
//
// The trap in fixing that: the bridge hands JS every keydown *before*
// `[NSApp sendEvent:]` (backend.mm `DispatchEvent2`), so ⌘S reaches the
// window's bindings and then the menu bar's key equivalent. A delegated bar
// that started matching ⌘ would run Save twice.
//
// Headless, over test/helpers/cocoa-bridge.js's recording fake. Input goes
// through the bridge's own event shape (`app._route`), the route a real
// NSEvent takes.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import { ContextMenu, MenuBar, useAccelerator } from '../src/index.js';
import { answersShortcut } from '../src/cocoa/globalmenu.js';
import { cleanupCocoa, mountCocoa, tick } from './helpers/cocoa-bridge.js';

const h = React.createElement;

afterEach(cleanupCocoa);

/** A bridge key press: `chars` is what the key types with no modifiers. */
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

// kVK_ANSI_* and kVK_F5
const KEY = {
  a: { keyCode: 0, chars: 'a' },
  s: { keyCode: 1, chars: 's' },
  k: { keyCode: 40, chars: 'k' },
  f5: { keyCode: 96 },
};
const cmd = (key, extra = {}) => ({ ...key, command: true, ...extra });
const ctrl = (key) => ({ ...key, control: true });

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

function findAll(node, pred, out = []) {
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, pred, out);
  return out;
}

/** Every menu row drawn in any window of the app. */
function menuRows(app) {
  const rows = [];
  for (const wnd of app._windows.values()) {
    const node = wnd._reactX11Node;
    if (!node) continue;
    findAll(
      node,
      (n) => String(n.props?.role ?? '').startsWith('menuitem'),
      rows,
    );
  }
  return rows;
}

/** The strings a row's `<text>`s draw: its label, then its shortcut. */
const rowTexts = (row) =>
  findAll(row, (n) => n.type === 'text' || n.constructor?.name === 'TextNode')
    .map((n) => n.props.children)
    .filter((text) => typeof text === 'string');

test('useAccelerator answers ⌘ for `Control`, and not ⌃', async () => {
  const fired = [];
  function Palette() {
    useAccelerator([['Control', 'K']], () => fired.push('palette'));
    return h('box', { style: { flexGrow: 1 } });
  }
  const { app, wnd } = await mountCocoa(h(Palette));

  press(app, wnd, ctrl(KEY.k));
  assert.deepStrictEqual(fired, [], '⌃K is not the chord a Mac user presses');
  press(app, wnd, cmd(KEY.k));
  assert.deepStrictEqual(fired, ['palette'], '⌘K');
});

test('a drawn ContextMenu prints ⌘S, announces Meta+S, and answers ⌘S', async () => {
  const fired = [];
  const target = React.createRef();
  const { app, wnd } = await mountCocoa(
    h(
      ContextMenu,
      {
        items: [
          {
            label: 'Save',
            shortcut: [['Control', 'S']],
            onSelect: () => fired.push('save'),
          },
          {
            label: 'Save As…',
            shortcut: [['Control', 'Shift', 'S']],
            onSelect: () => fired.push('save as'),
          },
        ],
        style: { flexGrow: 1 },
      },
      h('box', { ref: target, style: { flexGrow: 1 } }),
    ),
    { width: 300, height: 200 },
  );

  // the label and the binding are one decision, so they are asserted together
  press(app, wnd, ctrl(KEY.s));
  assert.deepStrictEqual(fired, [], '⌃S');
  press(app, wnd, cmd(KEY.s));
  assert.deepStrictEqual(fired, ['save'], '⌘S, once');
  press(app, wnd, cmd(KEY.s, { shift: true, shifted: 'S' }));
  assert.deepStrictEqual(fired, ['save', 'save as'], '⇧⌘S');

  rightClick(app, target.current);
  await tick();
  const rows = menuRows(app);
  const save = rows.find((row) => row.props['aria-label'] === 'Save');
  const saveAs = rows.find((row) => row.props['aria-label'] === 'Save As…');
  assert.ok(save && saveAs, 'the premise: the menu is open');
  assert.deepStrictEqual(rowTexts(save), ['Save', '⌘S']);
  assert.deepStrictEqual(rowTexts(saveAs), ['Save As…', '⇧⌘S']);
  assert.strictEqual(save.props['aria-keyshortcuts'], 'Meta+S');
  assert.strictEqual(saveAs.props['aria-keyshortcuts'], 'Meta+Shift+S');
});

/** The id the bridge was handed for the item titled `title`. */
function menuIdOf(native, title) {
  const spec = native.of('setMainMenu').at(-1)?.[0] ?? [];
  const walk = (items) => {
    for (const item of items ?? []) {
      if (item.title === title) return item;
      const inner = walk(item.items);
      if (inner) return inner;
    }
    return null;
  };
  return walk(spec);
}

test('a MenuBar the macOS menu bar has taken runs each item once', async () => {
  const fired = [];
  const delegations = [];
  function Elsewhere() {
    // a second binding on the bar's own chord, further down the window
    useAccelerator([['Control', 'S']], () => fired.push('palette'));
    return null;
  }
  const { app, wnd, native } = await mountCocoa(
    h(
      'box',
      { style: { flexGrow: 1 } },
      h(MenuBar, {
        onGlobalMenuChange: (on) => delegations.push(on),
        menus: [
          {
            label: 'File',
            items: [
              {
                label: 'Save',
                shortcut: [['Control', 'S']],
                onSelect: () => fired.push('save'),
              },
              // F5 has no NSMenu spelling, so the menu bar shows no hint
              // for it and never answers it: the window still has to
              {
                label: 'Reload',
                shortcut: [['F5']],
                onSelect: () => fired.push('reload'),
              },
              // and neither does a bare key, which the adapter pads out to
              // ⌘A to have something to show — the chord says A
              {
                label: 'Add',
                shortcut: [['a']],
                onSelect: () => fired.push('add'),
              },
            ],
          },
        ],
      }),
      h(Elsewhere),
    ),
    { width: 300, height: 200 },
  );
  await tick();
  assert.deepStrictEqual(delegations.at(-1), true, 'the premise: delegated');
  const saveItem = menuIdOf(native, 'Save');
  assert.strictEqual(saveItem.key, 's', 'and installed as a key equivalent');

  // ⌘S: the window sees it first and leaves it to the menu bar — the item
  // and the other binding alike — and AppKit's key equivalent is what then
  // reaches the item, as `menu-activate`
  press(app, wnd, cmd(KEY.s));
  assert.deepStrictEqual(fired, [], 'nothing in the window ran ⌘S');
  app._route({ type: 'menu-activate', id: saveItem.id });
  assert.deepStrictEqual(fired, ['save']);

  // what the menu bar does not answer, the window does — once
  press(app, wnd, KEY.f5);
  assert.deepStrictEqual(fired, ['save', 'reload']);
  press(app, wnd, KEY.a);
  assert.deepStrictEqual(fired, ['save', 'reload', 'add']);
  // ⌃S is no chord at all here, for the bar or anything else
  press(app, wnd, ctrl(KEY.s));
  assert.deepStrictEqual(fired, ['save', 'reload', 'add']);
});

test('what the menu bar answers by itself: the ⌘ chords it can spell', () => {
  // the menu bar's own reading of `Control`, so `MenuBar` and the NSMenu it
  // feeds cannot disagree about which keys are whose
  assert.strictEqual(answersShortcut([['Control', 'S']]), true);
  assert.strictEqual(answersShortcut([['Super', 'Shift', 's']]), true);
  assert.strictEqual(answersShortcut([['Control', 'Alt', 'x']]), true);
  // not spellable: a non-character key, a second alternative
  assert.strictEqual(answersShortcut([['Control', 'F5']]), false);
  assert.strictEqual(answersShortcut([['Control', 'plus']]), false);
  assert.strictEqual(answersShortcut([['Control', 'S'], ['F2']]), false);
  // no ⌘ in the chord: the key equivalent's ⌘ would be the adapter's, not
  // the app's, and the chord stays the window's
  assert.strictEqual(answersShortcut([['a']]), false);
  assert.strictEqual(answersShortcut([['Alt', 'x']]), false);
  assert.strictEqual(answersShortcut(undefined), false);
});
