// The standard edit menu as a documented seam (#256): an element that edits
// or selects text of its own opens the *same* Undo/Cut/Copy/Paste menu
// `<textinput>` opens, by naming its verbs — rather than rebuilding the
// enablement rules, the clipboard subtleties and the menu keyboard handling
// core already debugged.
//
// Everything here goes through the published surface: the element is
// registered through `react-x11/host`, subclasses `Node` from
// `react-x11/node`, and calls `openEditMenu` off the package root. A test
// reaching into src/nodes.js would prove nothing about what a sibling
// package can do.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import {
  closeEditMenu,
  createRoot,
  editMenuOpen,
  openEditMenu,
} from '../src/index.js';
import { registerElement, unregisterElement } from '../src/host.js';
import { Node } from '../src/node.js';
import { editMenuItems } from '../src/editmenu.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A miniature editable element. It records the verbs it was asked to run
 * rather than editing anything, so a test can assert what the menu did
 * without a text buffer in the way.
 */
class EditorNode extends Node {
  constructor(props, app) {
    super('miniedit', props, app);
    this.focusableByDefault = true;
    this.defaultCursor = 'text';
    this.ran = [];
    this.selected = true;
    this.undone = false;
  }

  /** What this element offers the standard menu. `readOnly` withholds the
   * editing half of it, so one test can watch those rows disappear. */
  editActions() {
    const run = (verb) => () => this.ran.push(verb);
    return {
      hasSelection: this.selected,
      // a read-only surface offers what it can do and nothing else: no
      // undo, no cut, nowhere to paste to
      ...(this.props.readOnly
        ? null
        : {
            canUndo: this.undone === false,
            undo: run('undo'),
            cut: run('cut'),
            paste: run('paste'),
          }),
      copy: run('copy'),
      selectAll: run('selectAll'),
    };
  }

  defaultContextMenu(ev) {
    openEditMenu(this, { x: ev.x, y: ev.y }, this.editActions());
  }
}

const registered = new Set();
function register(type, definition) {
  registerElement(type, definition);
  registered.add(type);
}

afterEach(() => {
  for (const type of registered) unregisterElement(type);
  registered.clear();
});

async function mount(props = {}) {
  register('miniedit', {
    create: (p, app) => new EditorNode(p, app),
    childrenAllowed: false,
    override: true,
  });
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    h(
      'window',
      { width: 300, height: 200 },
      h('miniedit', { style: { width: 200, height: 100 }, ...props }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const editor = wnd._reactX11Node.children[0];
  return { app, root, wnd, editor };
}

/** The open menu's rows, in order, as `[id, enabled]` — a separator as
 * `'---'`. They are painted into a canvas, so this is what there is to
 * assert on. */
const rows = (node) =>
  node._editMenu._editMenuRows.map((row) =>
    row.separator ? '---' : [row.id, row.enabled],
  );

/** Click a row the way the pointer does: at a y inside it. */
function chooseRow(node, id) {
  const popup = node._editMenu;
  const row = popup._editMenuRows.find((r) => r.id === id);
  popup.children[0].props.onMouseUp({ y: row.y + row.height / 2 });
}

const rightClick = (wnd, x = 20, y = 20) =>
  wnd.emit('mousedown', { x, y, keycode: 3 });

test('a registered element opens the standard menu with its own verbs', async () => {
  const { app, root, wnd, editor } = await mount();
  const before = app.windows.length;

  rightClick(wnd);
  assert.strictEqual(editMenuOpen(editor), true, 'the menu is open');
  assert.strictEqual(
    app.windows.length,
    before + 1,
    'and it is a real popup window, the same one <textinput> gets',
  );
  assert.deepStrictEqual(rows(editor), [
    ['undo', true],
    '---',
    ['cut', true],
    ['copy', true],
    ['paste', true],
    '---',
    ['selectAll', true],
  ]);

  chooseRow(editor, 'copy');
  assert.deepStrictEqual(editor.ran, ['copy'], 'the element ran its own verb');
  assert.strictEqual(editMenuOpen(editor), false, 'and the menu closed');

  await root.unmount();
});

test('enablement comes from the shared implementation, not the caller', async () => {
  const { root, wnd, editor } = await mount();
  editor.selected = false; // nothing selected…
  editor.undone = true; // …and nothing to undo

  rightClick(wnd);
  assert.deepStrictEqual(rows(editor), [
    ['undo', false],
    '---',
    ['cut', false], // Cut and Copy follow the selection
    ['copy', false],
    ['paste', true],
    '---',
    ['selectAll', true],
  ]);
  // a greyed row is not choosable: the click counts as a click on nothing
  chooseRow(editor, 'cut');
  assert.deepStrictEqual(editor.ran, [], 'the greyed row did nothing');

  await root.unmount();
});

test('a verb left out is a row that is absent, not a row that is greyed', async () => {
  // the read-only case (a rendered document with a selection) and the
  // `sensitive` case (a password field) are the same rule: no verb, no row
  const { root, wnd, editor } = await mount({ readOnly: true });

  rightClick(wnd);
  assert.deepStrictEqual(
    rows(editor),
    [['copy', true], '---', ['selectAll', true]],
    'two rows and the separator between their groups — no dead Undo/Cut/Paste',
  );

  await root.unmount();
});

test('no verbs at all opens nothing', async () => {
  const { app, root, editor } = await mount();
  const before = app.windows.length;

  openEditMenu(editor, { x: 0, y: 0 }, { hasSelection: false });
  assert.strictEqual(editMenuOpen(editor), false);
  assert.strictEqual(app.windows.length, before, 'no empty popup');

  await root.unmount();
});

test('the menu takes the keyboard, and hands it back where it found it', async () => {
  const { root, wnd, editor } = await mount();
  const events = wnd._reactX11Node.events;

  wnd.emit('mousedown', { x: 10, y: 10, keycode: 1 });
  wnd.emit('mouseup', { x: 10, y: 10, keycode: 1 });
  assert.strictEqual(editor.focused, true);

  rightClick(wnd);
  assert.notStrictEqual(events.focused, editor, 'the menu holds the keyboard');

  const canvas = editor._editMenu.children[0];
  canvas.props.onKeyDown({ keysym: 0xff54 }); // Down — first enabled row
  canvas.props.onKeyDown({ keysym: 0xff0d }); // Enter
  assert.deepStrictEqual(editor.ran, ['undo']);
  assert.strictEqual(editor.focused, true, 'focus came back to the element');

  // …and Escape leaves without running anything
  editor.ran.length = 0;
  rightClick(wnd);
  editor._editMenu.children[0].props.onKeyDown({ keysym: 0xff1b });
  assert.strictEqual(editMenuOpen(editor), false);
  assert.deepStrictEqual(editor.ran, []);
  assert.strictEqual(editor.focused, true);

  await root.unmount();
});

test('a surface that never had focus is not given any on the way out', async () => {
  // a rendered document is selectable but not a tab stop: handing it the
  // keyboard because its menu closed would be a focus ring out of nowhere
  const { root, wnd, editor } = await mount({ focusable: false });
  const events = wnd._reactX11Node.events;

  rightClick(wnd);
  assert.strictEqual(editMenuOpen(editor), true);
  closeEditMenu(editor);
  assert.strictEqual(events.focused, null, 'focus went nowhere');
  assert.strictEqual(editor.focused, false);

  await root.unmount();
});

test('the menu opens at the pointer, in window coordinates', async () => {
  const { root, wnd, editor } = await mount();
  // where the window manager put the window; a menu is placed on the screen
  wnd._screenOrigin = { x: 400, y: 300 };

  rightClick(wnd, 25, 40);
  const popup = editor._editMenu;
  assert.strictEqual(popup.attributes.x, 425, 'the window origin plus ev.x');
  assert.strictEqual(popup.attributes.y, 340);

  await root.unmount();
});

test('closeEditMenu is idempotent, and an unmount takes the menu with it', async () => {
  const { root, wnd, editor } = await mount();
  rightClick(wnd);
  closeEditMenu(editor);
  closeEditMenu(editor); // nothing left to close, and nothing thrown
  assert.strictEqual(editMenuOpen(editor), false);

  rightClick(wnd);
  assert.strictEqual(editMenuOpen(editor), true);
  await root.unmount(); // the popup is a child, so it goes with the element
  assert.strictEqual(editor.destroyed, true);
  closeEditMenu(editor); // and closing afterwards is still safe
});

// --- the rows themselves, with no tree at all -------------------------------

test('editMenuItems: the order, the groups and the separators', async () => {
  const noop = () => {};
  const all = editMenuItems({
    canUndo: true,
    undo: noop,
    canRedo: false,
    redo: noop,
    hasSelection: true,
    cut: noop,
    copy: noop,
    paste: noop,
    selectAll: noop,
  });
  assert.deepStrictEqual(
    all.map((i) => i.id ?? i.type),
    [
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'separator',
      'selectAll',
    ],
  );
  assert.deepStrictEqual(
    all.filter((i) => i.id).map((i) => [i.id, i.enabled]),
    [
      ['undo', true],
      ['redo', false],
      ['cut', true],
      ['copy', true],
      ['paste', true],
      ['selectAll', true],
    ],
  );

  // a whole group missing takes its separator with it — no gap where it was
  assert.deepStrictEqual(
    editMenuItems({ hasSelection: true, copy: noop }).map((i) => i.id),
    ['copy'],
  );
  assert.deepStrictEqual(
    editMenuItems({ canUndo: true, undo: noop, selectAll: noop }).map(
      (i) => i.id ?? i.type,
    ),
    ['undo', 'separator', 'selectAll'],
  );
  assert.deepStrictEqual(editMenuItems({}), []);

  // the two enablement answers only the target can give
  assert.strictEqual(
    editMenuItems({ selectAll: noop, canSelectAll: false })[0].enabled,
    false,
  );
  assert.strictEqual(
    editMenuItems({ paste: noop }, { canPaste: false })[0].enabled,
    false,
  );
});
