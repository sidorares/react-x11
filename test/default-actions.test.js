// Default actions as a documented seam (#251): an element that *behaves* —
// an editor, a terminal, a table with cell editing — implements the same
// `default*` methods `<textinput>`'s editing runs on, and gets the same
// ordering: the application's handlers first, the element's behaviour after,
// `preventDefault` in between.
//
// Everything here registers its element through `react-x11/host` and imports
// `Node` from `react-x11/node`, because the point of the issue is that a
// package outside react-x11 can do this. A test reaching into src/nodes.js
// would prove nothing about the published surface.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { createRoot } from '../src/index.js';
import { registerElement, unregisterElement } from '../src/host.js';
import { Node, CARET_BLINK_MS } from '../src/node.js';
import { XK_TAB, XK_ESCAPE, XK_LEFT } from '../src/keysyms.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Simulate an ntk keydown: bind the keysym to a synthetic keycode and emit
 * the raw event shape the EventManager consumes. */
function pressKey(app, wnd, keysym, { codepoint, buttons = 0 } = {}) {
  const keycode = ((keysym ?? codepoint) % 248) + 8;
  app.X.keycode2keysyms[keycode] = [keysym ?? codepoint];
  wnd.emit('keydown', { keycode, keysym, codepoint, buttons });
}

/**
 * The element under test: a miniature editor. It records what it was asked
 * to do rather than doing it, so a test can assert on the order of the two
 * layers rather than on pixels.
 */
class EditorNode extends Node {
  constructor(props, app) {
    super('miniedit', props, app);
    this.focusableByDefault = true;
    this.defaultCursor = 'text';
    this.log = [];
    this.tabEscapes = false;
    this.blinks = 0;
  }

  defaultKeyDown(ev) {
    this.log.push(`key:${ev.keysym}`);
    if (ev.keysym === XK_ESCAPE) {
      // the documented way out: the next Tab leaves
      this.tabEscapes = true;
      return;
    }
    if (ev.keysym === XK_TAB) {
      if (this.tabEscapes) {
        this.tabEscapes = false; // one Tab, then it indents again
        return; // …and this one belongs to focus traversal
      }
      this.log.push('indent');
      ev.preventDefault(); // …but this one is mine
      return;
    }
    this.tabEscapes = false;
  }

  defaultMouseDown(ev) {
    this.log.push('down');
    ev.capturePointer();
  }

  defaultMouseDrag(ev) {
    this.log.push(`drag:${ev.x}`);
  }

  defaultMouseUp() {
    this.log.push('up');
  }

  defaultContextMenu() {
    this.log.push('menu');
  }

  defaultFocus() {
    this.log.push('focus');
    this.blinkTimer = setInterval(() => {
      this.blinks++;
      this.root?.invalidate(false, this, 'caret');
    }, CARET_BLINK_MS);
    this.blinkTimer.unref?.();
  }

  defaultBlur() {
    this.log.push('blur');
    clearInterval(this.blinkTimer);
    this.blinkTimer = null;
  }

  destroySubtree() {
    // a node that unmounts while focused is forgotten, not blurred
    clearInterval(this.blinkTimer);
    this.blinkTimer = null;
    super.destroySubtree();
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

/** Mount `<miniedit>` (plus whatever else the test asked for) and hand back
 * the pieces every test here pokes at. */
async function mount({ props = {}, extra = null } = {}) {
  register('miniedit', {
    create: (p, app) => new EditorNode(p, app),
    childrenAllowed: false,
    // a test that mounts twice re-registers the same class; the conflict the
    // flag is really for is two packages, not two roots
    override: true,
  });
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    h(
      'window',
      { width: 300, height: 200 },
      h('miniedit', { style: { width: 200, height: 100 }, ...props }),
      extra,
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const windowNode = wnd._reactX11Node;
  const find = (node, pred) =>
    pred(node)
      ? node
      : node.children.reduce((a, c) => a || find(c, pred), null);
  return {
    app,
    root,
    wnd,
    windowNode,
    editor: find(windowNode, (n) => n.kind === 'miniedit'),
    find,
  };
}

test('a registered element gets keys after the app handler, and can be vetoed', async () => {
  const seen = [];
  const { app, wnd, editor } = await mount({
    props: {
      onKeyDown: (ev) => {
        seen.push(ev.keysym);
        if (ev.keysym === XK_LEFT) ev.preventDefault();
      },
    },
  });

  // focus it the way a user would — a press
  wnd.emit('mousedown', { x: 10, y: 10, keycode: 1 });
  wnd.emit('mouseup', { x: 10, y: 10, keycode: 1 });
  await tick();
  assert.strictEqual(editor.focused, true, 'focusableByDefault took focus');

  pressKey(app, wnd, XK_ESCAPE);
  assert.deepStrictEqual(seen, [XK_ESCAPE], 'the app handler ran');
  assert.ok(
    editor.log.includes(`key:${XK_ESCAPE}`),
    'and the element behaviour after it',
  );

  editor.log.length = 0;
  pressKey(app, wnd, XK_LEFT);
  assert.deepStrictEqual(seen, [XK_ESCAPE, XK_LEFT]);
  assert.deepStrictEqual(
    editor.log,
    [],
    'preventDefault in the app handler skips the default action',
  );
});

test('Tab reaches the element, and consuming it keeps focus', async () => {
  const { app, wnd, editor, find, windowNode } = await mount({
    extra: h('box', { focusable: true, style: { width: 10, height: 10 } }),
  });
  const other = find(windowNode, (n) => n.kind === 'box' && n.props.focusable);

  editor.focus();
  await tick();
  assert.strictEqual(editor.focused, true);

  pressKey(app, wnd, XK_TAB);
  await tick();
  assert.ok(editor.log.includes('indent'), 'Tab arrived as an ordinary key');
  assert.strictEqual(
    editor.focused,
    true,
    'preventDefault kept it from the focus cycle',
  );
  assert.strictEqual(other.focused, false);
});

test('Escape arms one pass-through Tab, and only one', async () => {
  const { app, wnd, editor, find, windowNode } = await mount({
    extra: h('box', { focusable: true, style: { width: 10, height: 10 } }),
  });
  const other = find(windowNode, (n) => n.kind === 'box' && n.props.focusable);

  editor.focus();
  await tick();
  pressKey(app, wnd, XK_ESCAPE);
  pressKey(app, wnd, XK_TAB);
  await tick();
  assert.strictEqual(other.focused, true, 'the armed Tab left the element');
  assert.ok(!editor.log.includes('indent'), 'and did not indent');

  // …and the element has it back: Tab in from the other node, then Tab again
  editor.focus();
  await tick();
  editor.log.length = 0;
  pressKey(app, wnd, XK_TAB);
  await tick();
  assert.ok(editor.log.includes('indent'), 'the escape was for one Tab only');
  assert.strictEqual(editor.focused, true);
});

test('a key handler that prevents default keeps Tab too', async () => {
  // the app's veto is above the element's: it stops both the element
  // behaviour and the focus cycle, which is what it did before #251
  const { app, wnd, editor, find, windowNode } = await mount({
    props: { onKeyDown: (ev) => ev.preventDefault() },
    extra: h('box', { focusable: true, style: { width: 10, height: 10 } }),
  });
  const other = find(windowNode, (n) => n.kind === 'box' && n.props.focusable);

  editor.focus();
  await tick();
  pressKey(app, wnd, XK_TAB);
  await tick();
  assert.deepStrictEqual(editor.log, ['focus'], 'no default action ran');
  assert.strictEqual(other.focused, false, 'and no traversal either');
});

test('an element with no default action for Tab still hands it to traversal', async () => {
  register('inert', { create: (p, app) => new Node('inert', p, app) });
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    h(
      'window',
      { width: 300, height: 200 },
      h('inert', { focusable: true, style: { width: 50, height: 50 } }),
      h('box', { focusable: true, style: { width: 10, height: 10 } }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const windowNode = wnd._reactX11Node;
  const [inert, box] = [
    windowNode.children.find((n) => n.kind === 'inert'),
    windowNode.children.find((n) => n.kind === 'box'),
  ];
  inert.focus();
  await tick();
  pressKey(app, wnd, XK_TAB);
  await tick();
  assert.strictEqual(box.focused, true);
});

test('press, drag past the element and release all reach it', async () => {
  const seen = [];
  const { wnd, editor } = await mount({
    props: { onMouseDown: () => seen.push('handler') },
  });

  wnd.emit('mousedown', { x: 10, y: 10, keycode: 1 });
  // the drag leaves the element's box entirely — `onMouseMove` would go to
  // whatever is under the pointer, the default action follows the press
  wnd.emit('mousemove', { x: 260, y: 150 });
  wnd.emit('mouseup', { x: 260, y: 150, keycode: 1 });
  await tick();

  assert.deepStrictEqual(seen, ['handler']);
  assert.deepStrictEqual(
    editor.log.filter((entry) => entry !== 'focus'),
    ['down', 'drag:260', 'up'],
  );
});

test('preventDefault on the press skips the element behaviour', async () => {
  const { wnd, editor } = await mount({
    props: { onMouseDown: (ev) => ev.preventDefault() },
  });
  wnd.emit('mousedown', { x: 10, y: 10, keycode: 1 });
  wnd.emit('mousemove', { x: 20, y: 10 });
  await tick();
  assert.ok(!editor.log.includes('down'));
  // the drag hooks follow the press, and there was no press to follow
  assert.ok(!editor.log.some((entry) => entry.startsWith('drag')));
});

test('the context menu is its own default action', async () => {
  const { wnd, editor } = await mount({
    props: { onContextMenu: (ev) => ev.preventDefault() },
  });
  wnd.emit('mousedown', { x: 10, y: 10, keycode: 3 });
  await tick();
  assert.ok(editor.log.includes('down'), 'the press still placed the caret');
  assert.ok(
    !editor.log.includes('menu'),
    'while the menu the handler suppressed did not open',
  );

  editor.log.length = 0;
  const plain = await mount();
  plain.wnd.emit('mousedown', { x: 10, y: 10, keycode: 3 });
  await tick();
  assert.ok(plain.editor.log.includes('menu'), 'and opens with no handler');
});

test('focus and blur bracket the element behaviour, including the window losing focus', async () => {
  const { wnd, editor, find, windowNode } = await mount({
    extra: h('box', { focusable: true, style: { width: 10, height: 10 } }),
  });
  const other = find(windowNode, (n) => n.kind === 'box' && n.props.focusable);

  editor.focus();
  await tick();
  assert.deepStrictEqual(editor.log, ['focus']);
  assert.ok(editor.blinkTimer, 'the blink is running');

  // the window manager gives the keyboard to another window: the node keeps
  // focus, its caret does not keep blinking
  wnd.emit('blur', {});
  await tick();
  assert.deepStrictEqual(editor.log, ['focus', 'blur']);
  assert.strictEqual(editor.blinkTimer, null);
  assert.strictEqual(editor.focused, true, 'still the focused node');

  wnd.emit('focus', {});
  await tick();
  assert.deepStrictEqual(editor.log, ['focus', 'blur', 'focus']);

  other.focus();
  await tick();
  assert.deepStrictEqual(editor.log, ['focus', 'blur', 'focus', 'blur']);
  assert.strictEqual(editor.blinkTimer, null, 'nothing left ticking');
});

test('CARET_BLINK_MS is the cadence <textinput> blinks at', async () => {
  assert.ok(
    Number.isFinite(CARET_BLINK_MS) && CARET_BLINK_MS > 0,
    'a usable interval',
  );
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h('window', { width: 200, height: 100 }, h('textinput', null)));
  await tick();
  const wnd = app.windows[0];
  const input = wnd._reactX11Node.children.find((n) => n.kind === 'textinput');
  input.focus();
  await tick();
  // the built-in caret and an element's own caret have to agree, so the
  // number is one export rather than two copies
  const interval =
    input._blinkTimer?._idleTimeout ?? input._blinkTimer?._repeat;
  assert.strictEqual(interval, CARET_BLINK_MS);
  input.blur();
});
