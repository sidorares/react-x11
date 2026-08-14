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
import { XK_TAB, XK_ESCAPE, XK_LEFT, MOD } from '../src/keysyms.js';
import { createMockApp, spinWheel } from './helpers/mock-app.js';

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

/**
 * The other element under test: a scene, the shape issue #302 was found
 * building. It draws a graph into one node, so its wheel is a zoom about the
 * pointer rather than a scroll and the hover it paints is the node under the
 * pointer rather than a `:hover` block on a child that does not exist.
 */
class PaneNode extends Node {
  constructor(props, app) {
    super('minipane', props, app);
    this.log = [];
    this.zoom = 1;
    this.hovered = null;
  }

  defaultWheel(ev) {
    this.log.push(
      `wheel:${ev.deltaY}@${ev.x},${ev.y}${ev.ctrlKey ? '+ctrl' : ''}`,
    );
    // `zooms={false}` is the same element declining the gesture, which is
    // what puts it back in the scroll chain
    if (this.props.zooms === false) return;
    this.zoom *= Math.exp(-ev.deltaY / 400);
    ev.preventDefault(); // consumed, whether or not anything "scrolled"
  }

  defaultMouseMove(ev) {
    this.hovered = { x: ev.localX, y: ev.localY };
    this.log.push(`move:${ev.x},${ev.y}`);
  }

  defaultMouseLeave() {
    this.hovered = null;
    this.log.push('leave');
  }

  defaultMouseDown(ev) {
    this.log.push('down');
    if (this.props.captures !== false) ev.capturePointer();
  }

  defaultMouseDrag(ev) {
    this.log.push(`drag:${ev.x}`);
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

// --- the wheel and hover motion (#302) --------------------------------------
//
// The two inputs that never reached the seam. `isScroller`/`scrollBy` route
// the wheel for content that scrolls and hand out deltas only; a pane whose
// wheel is a zoom about the pointer needs the point, the modifiers, and to
// answer the gesture whether or not anything "can scroll". And core already
// computes the hover path per motion for `:hover` and `onMouseEnter`/`Leave`
// — an element painting its own hover state just could not hear it.

/** Mount `<minipane>` over a tall sibling in a window that may scroll, so
 * the chain behind the element is a real one for it to keep or hand on. */
async function mountPane({ props = {}, windowProps = {} } = {}) {
  register('minipane', {
    create: (p, app) => new PaneNode(p, app),
    childrenAllowed: false,
    override: true,
  });
  const app = createMockApp();
  const root = await createRoot({ app });
  const ref = React.createRef();
  root.render(
    h(
      'window',
      { width: 300, height: 200, ...windowProps },
      h('minipane', {
        ref,
        style: { width: 200, height: 100, flexShrink: 0 },
        ...props,
      }),
      h('box', { style: { height: 400, flexShrink: 0 } }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  return { app, root, wnd, windowNode: wnd._reactX11Node, pane: ref.current };
}

test('the wheel reaches the element with the point and the modifiers', async () => {
  const { wnd, pane } = await mountPane();
  spinWheel(wnd, 50, 40, { deltaY: 1, buttons: MOD.Control });
  await tick();
  assert.deepStrictEqual(pane.log, ['wheel:48@50,40+ctrl']);
  assert.ok(pane.zoom < 1, 'and the zoom it drove is about that point');
});

test('consuming the wheel keeps it from the scroll chain', async () => {
  const { wnd, windowNode, pane } = await mountPane({
    windowProps: { style: { overflow: 'scroll' } },
  });
  spinWheel(wnd, 50, 40);
  await tick();
  assert.strictEqual(pane.log.length, 1, 'the element answered it');
  assert.strictEqual(windowNode.scrollY, 0, 'so the window behind it did not');
});

test('…and leaving it alone puts the element back in the chain', async () => {
  const { wnd, windowNode, pane } = await mountPane({
    props: { zooms: false },
    windowProps: { style: { overflow: 'scroll' } },
  });
  spinWheel(wnd, 50, 40);
  await tick();
  assert.deepStrictEqual(pane.log, ['wheel:48@50,40'], 'it was offered first');
  assert.strictEqual(pane.zoom, 1, 'and declined the gesture');
  assert.strictEqual(windowNode.scrollY, 48, 'so the walk ran as before');
});

test('an app handler still gets the wheel first, and can veto it', async () => {
  const seen = [];
  const { wnd, pane } = await mountPane({
    props: {
      onWheel: (ev) => {
        seen.push(ev.deltaY);
        ev.preventDefault();
      },
    },
  });
  spinWheel(wnd, 50, 40);
  await tick();
  assert.deepStrictEqual(seen, [48], 'the handler ran');
  assert.deepStrictEqual(pane.log, [], 'and the element behaviour did not');

  // …while a handler that only watches leaves the element its wheel
  const watched = await mountPane({
    props: { onWheel: () => seen.push('saw') },
  });
  spinWheel(watched.wnd, 50, 40);
  await tick();
  assert.deepStrictEqual(seen, [48, 'saw']);
  assert.deepStrictEqual(watched.pane.log, ['wheel:48@50,40']);
});

test('the fraction a touchpad measured reaches the element whole', async () => {
  // the chain spends whole pixels and carries the rest, because a fractional
  // scroll offset is one the blit cannot shift — a zoom factor is continuous
  // and gets the delta as it was measured
  const { wnd, windowNode, pane } = await mountPane({
    props: { zooms: false },
    windowProps: { style: { overflow: 'scroll' } },
  });
  spinWheel(wnd, 50, 40, { deltaY: 1 / 128, smooth: true });
  await tick();
  assert.deepStrictEqual(pane.log, ['wheel:0.375@50,40']);
  assert.strictEqual(windowNode.scrollY, 0, 'a third of a pixel moves nothing');
});

test('hover motion reaches the element, and the leave that ends it', async () => {
  const { wnd, pane } = await mountPane();

  wnd.emit('mousemove', { x: 20, y: 30 });
  await tick();
  assert.deepStrictEqual(
    pane.log,
    ['move:20,30'],
    'the first one is the enter',
  );
  assert.deepStrictEqual(pane.hovered, { x: 20, y: 30 }, 'local, as elsewhere');

  wnd.emit('mousemove', { x: 40, y: 30 });
  await tick();
  assert.deepStrictEqual(pane.log, ['move:20,30', 'move:40,30']);

  // out of the element's box, still inside the window
  wnd.emit('mousemove', { x: 250, y: 30 });
  await tick();
  assert.deepStrictEqual(pane.log, ['move:20,30', 'move:40,30', 'leave']);
  assert.strictEqual(pane.hovered, null, 'the highlight went with it');
});

test('the pointer leaving the window is a leave as well', async () => {
  const { wnd, pane } = await mountPane();
  wnd.emit('mousemove', { x: 20, y: 30 });
  wnd.emit('mouseout', { x: -1, y: 30 });
  await tick();
  assert.deepStrictEqual(pane.log, ['move:20,30', 'leave']);
});

test('app handlers get motion and the leave first, and can veto either', async () => {
  const seen = [];
  const { wnd, pane } = await mountPane({
    props: {
      onMouseMove: (ev) => {
        seen.push('move');
        ev.preventDefault();
      },
      onMouseLeave: (ev) => {
        seen.push('leave');
        ev.preventDefault();
      },
    },
  });
  wnd.emit('mousemove', { x: 20, y: 30 });
  wnd.emit('mousemove', { x: 250, y: 30 });
  await tick();
  assert.deepStrictEqual(seen, ['move', 'leave'], 'both handlers ran');
  assert.deepStrictEqual(pane.log, [], 'and neither default action after them');

  // …and handlers that only watch leave the element both of them
  const watched = await mountPane({
    props: {
      onMouseMove: () => seen.push('saw move'),
      onMouseLeave: () => seen.push('saw leave'),
    },
  });
  watched.wnd.emit('mousemove', { x: 20, y: 30 });
  watched.wnd.emit('mousemove', { x: 250, y: 30 });
  await tick();
  assert.deepStrictEqual(seen, ['move', 'leave', 'saw move', 'saw leave']);
  assert.deepStrictEqual(watched.pane.log, ['move:20,30', 'leave']);
});

test('a capture keeps the motion on the drag hook', async () => {
  const { wnd, pane } = await mountPane();
  wnd.emit('mousedown', { x: 20, y: 30, keycode: 1 });
  wnd.emit('mousemove', { x: 250, y: 30 });
  await tick();
  // hover is frozen for the length of the gesture, so the motion of one is
  // the drag's and not also the hover's
  assert.deepStrictEqual(pane.log, ['down', 'drag:250']);
  assert.strictEqual(pane.hovered, null);

  // …and a press that did not capture leaves hover live, in that order: what
  // the pointer is over still lights up while the press follows it
  const loose = await mountPane({ props: { captures: false } });
  loose.wnd.emit('mousedown', { x: 20, y: 30, keycode: 1 });
  loose.wnd.emit('mousemove', { x: 40, y: 30 });
  await tick();
  assert.deepStrictEqual(loose.pane.log, ['down', 'move:40,30', 'drag:40']);
});

test('a node that unmounts while hovered is forgotten, not left', async () => {
  const { root, wnd, pane } = await mountPane();
  wnd.emit('mousemove', { x: 20, y: 30 });
  await tick();
  assert.deepStrictEqual(pane.log, ['move:20,30'], 'hovered, and painting it');

  pane.log.length = 0;
  root.render(h('window', { width: 300, height: 200 }));
  await tick();
  assert.deepStrictEqual(pane.log, [], 'the same rule focus follows');
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
