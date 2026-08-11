import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

import { createMockApp, spinWheel } from './helpers/mock-app.js';

// Simulate an ntk keydown: registers the keysym for a synthetic keycode and
// emits the raw event shape the EventManager consumes.
function pressKey(app, wnd, { keysym, codepoint, buttons = 0, time }) {
  const keycode = ((keysym ?? codepoint) % 248) + 8;
  app.X.keycode2keysyms[keycode] = [keysym ?? codepoint];
  wnd.emit('keydown', {
    keycode,
    codepoint,
    buttons,
    ...(time ? { time } : {}),
  });
}

const XK = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Left: 0xff51,
};

test('renders a top-level window with a child window', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const element = React.createElement(
    'window',
    { width: 300, height: 200, title: 'main' },
    React.createElement('window', { width: 50, height: 50, x: 10, y: 10 }),
  );

  x11Root.render(element);

  assert.strictEqual(app.windows.length, 2);
  // Windows are created top-down: the parent window first, then children
  // created directly against it (issue #4) — no reparenting involved.
  const [top, child] = [app.windows[0], app.windows[1]];

  assert.strictEqual(top.attributes.title, 'main');
  assert.strictEqual(top.mapped, true, 'top-level window should be mapped');

  assert.strictEqual(
    child.attributes.parent,
    top,
    'child should be created with its parent window from the start',
  );
  assert.strictEqual(
    child.attributes.overrideRedirect,
    undefined,
    'no override-redirect staging is needed with top-down creation',
  );
  assert.ok(
    !child.calls.some(([name]) => name === 'reparentTo'),
    'child should never be reparented',
  );
  assert.strictEqual(child.mapped, true, 'child should be mapped');

  await x11Root.unmount();
});

// Replay the recorded ConfigureWindow requests over the stack X gives a
// freshly created set of siblings (each new window on top), so the tests can
// assert the order the server ends up with rather than the exact requests.
function serverStack(app, createdIds) {
  const stack = [...createdIds];
  for (const [id, { sibling, stackMode }] of app.configureCalls) {
    stack.splice(stack.indexOf(id), 1);
    const at = stack.indexOf(sibling);
    stack.splice(stackMode === 1 ? at : at + 1, 0, id);
  }
  return stack;
}

test('child windows stack in JSX order, and a reorder restacks them', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const App = ({ order }) =>
    React.createElement(
      'window',
      { width: 300, height: 200, title: 'main' },
      order.map((title) =>
        React.createElement('window', {
          key: title,
          title,
          width: 50,
          height: 50,
        }),
      ),
    );

  x11Root.render(React.createElement(App, { order: ['a', 'b', 'c'] }));
  const [, a, b, c] = app.windows;
  assert.deepStrictEqual(
    [a.title, b.title, c.title],
    ['a', 'b', 'c'],
    'children are created in JSX order',
  );
  assert.deepStrictEqual(
    app.configureCalls,
    [],
    'mount order already stacks right — X puts each new window on top',
  );

  x11Root.render(React.createElement(App, { order: ['c', 'a', 'b'] }));
  const root = app.windows[0]._reactX11Node;
  assert.deepStrictEqual(
    root.children.map((child) => child.props.title),
    ['c', 'a', 'b'],
    'the node list follows the new JSX order, with no duplicates',
  );
  assert.strictEqual(
    app.windows.length,
    4,
    'a reorder moves the windows, it does not recreate them',
  );
  assert.deepStrictEqual(
    serverStack(app, [a.id, b.id, c.id]),
    [c.id, a.id, b.id],
    'the server stacks bottom-to-top in JSX order: c under a under b',
  );
  assert.strictEqual(
    app.configureCalls.length,
    2,
    'one pass per commit: n-1 requests, not one per moved child',
  );

  await x11Root.unmount();
});

test('zIndex raises a child window above its later siblings', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const render = (zIndex) =>
    x11Root.render(
      React.createElement(
        'window',
        { width: 300, height: 200 },
        React.createElement('window', {
          key: 'a',
          title: 'a',
          width: 50,
          height: 50,
          style: { zIndex: zIndex },
        }),
        React.createElement('window', {
          key: 'b',
          title: 'b',
          width: 50,
          height: 50,
        }),
      ),
    );

  render(0);
  const [, a, b] = app.windows;
  assert.deepStrictEqual(app.configureCalls, [], 'no zIndex, no requests');

  render(1);
  assert.deepStrictEqual(
    serverStack(app, [a.id, b.id]),
    [b.id, a.id],
    'the higher zIndex ends up on top even though it comes first in JSX',
  );

  await x11Root.unmount();
});

test('zIndex on a popup is inert — it is a child of the screen root', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const render = (zIndex) =>
    x11Root.render(
      React.createElement(
        'window',
        { width: 300, height: 200 },
        React.createElement(
          'box',
          { style: { flexGrow: 1 } },
          React.createElement('popup', {
            x: 0,
            y: 0,
            width: 40,
            height: 40,
            style: { zIndex: zIndex },
          }),
        ),
      ),
    );

  render(0);
  render(2); // must not try to restack the <box> the popup is written under
  assert.deepStrictEqual(app.configureCalls, []);

  await x11Root.unmount();
});

test('reordering keyed drawn children moves them instead of duplicating', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const App = ({ order }) =>
    React.createElement(
      'window',
      { width: 300, height: 200 },
      order.map((color) =>
        React.createElement('box', {
          key: color,
          style: { backgroundColor: color, width: 10, height: 10 },
        }),
      ),
    );

  x11Root.render(React.createElement(App, { order: ['red', 'green', 'blue'] }));
  const root = app.windows[0]._reactX11Node;
  const green = root.children[1];

  x11Root.render(React.createElement(App, { order: ['blue', 'red', 'green'] }));

  assert.deepStrictEqual(
    root.children.map((child) => child.style.backgroundColor),
    ['blue', 'red', 'green'],
    'children follow the new order exactly once each',
  );
  assert.strictEqual(root.children[2], green, 'the moved node is reused');
  assert.deepStrictEqual(
    root.paintOrder().map((child) => child.style.backgroundColor),
    ['blue', 'red', 'green'],
    'paint order follows too — the last sibling paints on top',
  );
  // the yoga tree has to track the move: insertChild on a node that still
  // has a parent aborts the wasm module
  assert.strictEqual(root.yoga.getChildCount(), 3);

  await x11Root.unmount();
});

test('applies prop updates to the window', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const render = (props) =>
    x11Root.render(React.createElement('window', props));

  render({ width: 300, height: 200, title: 'before', x: 0, y: 0 });
  const wnd = app.windows[0];

  render({ width: 400, height: 250, title: 'after', x: 20, y: 30 });

  assert.strictEqual(app.windows.length, 1, 'window instance should be reused');
  assert.strictEqual(wnd.title, 'after');
  assert.deepStrictEqual([wnd.width, wnd.height], [400, 250]);
  assert.deepStrictEqual([wnd.x, wnd.y], [20, 30]);

  await x11Root.unmount();
});

test('adds a child to an already-mounted window top-down', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const render = (withChild) =>
    x11Root.render(
      React.createElement(
        'window',
        { width: 300, height: 200 },
        withChild
          ? React.createElement('window', { width: 10, height: 10 })
          : null,
      ),
    );

  render(false);
  assert.strictEqual(app.windows.length, 1);
  const top = app.windows[0];

  render(true);
  assert.strictEqual(app.windows.length, 2);
  const child = app.windows[1];
  assert.strictEqual(
    child.attributes.parent,
    top,
    'late-added child should be created against its real parent',
  );
  assert.strictEqual(child.mapped, true);
  assert.ok(!child.calls.some(([name]) => name === 'reparentTo'));

  await x11Root.unmount();
});

test('destroys windows that are removed', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const render = (withChild) =>
    x11Root.render(
      React.createElement(
        'window',
        { width: 300, height: 200 },
        withChild
          ? React.createElement('window', { width: 10, height: 10 })
          : null,
      ),
    );

  render(true);
  assert.strictEqual(app.windows.length, 2);
  const child = app.windows.find((w) => w.attributes.parent);

  render(false);
  assert.strictEqual(
    child.destroyed,
    true,
    'removed child window should be destroyed',
  );

  await x11Root.unmount();
});

test('unmounting destroys the top-level window', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(React.createElement('window', { width: 100, height: 100 }));
  const wnd = app.windows[0];

  await x11Root.unmount();
  assert.strictEqual(wnd.destroyed, true);
});

test('function components and state-driven rendering work', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  function App({ title }) {
    return React.createElement('window', { width: 100, height: 100, title });
  }

  x11Root.render(React.createElement(App, { title: 'fn component' }));
  assert.strictEqual(app.windows[0].attributes.title, 'fn component');

  await x11Root.unmount();
});

test('lays out a flex box tree with yoga and paints it', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 100 },
      React.createElement(
        'box',
        { style: { flexDirection: 'row', flexGrow: 1 } },
        React.createElement('box', {
          style: { flexGrow: 1, backgroundColor: 'red' },
        }),
        React.createElement('box', {
          style: { flexGrow: 1, backgroundColor: 'blue' },
        }),
      ),
    ),
  );
  await tick();

  const wnd = app.windows[0];
  const windowNode = wnd._reactX11Node;
  const row = windowNode.children[0];
  const [left, right] = row.children;

  assert.deepStrictEqual(row.abs, { x: 0, y: 0, width: 200, height: 100 });
  assert.deepStrictEqual(left.abs, { x: 0, y: 0, width: 100, height: 100 });
  assert.deepStrictEqual(right.abs, { x: 100, y: 0, width: 100, height: 100 });

  const fills = wnd.ctx.ops.filter(([op]) => op === 'fillRect');
  assert.deepStrictEqual(fills.at(-2), ['fillRect', 0, 0, 100, 100, 'red']);
  assert.deepStrictEqual(fills.at(-1), ['fillRect', 100, 0, 100, 100, 'blue']);

  await x11Root.unmount();
});

test('updates reflow the tree', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const render = (direction) =>
    x11Root.render(
      React.createElement(
        'window',
        { width: 200, height: 100 },
        React.createElement(
          'box',
          { style: { flexDirection: direction, flexGrow: 1 } },
          React.createElement('box', { style: { flexGrow: 1 } }),
          React.createElement('box', { style: { flexGrow: 1 } }),
        ),
      ),
    );

  render('row');
  await tick();
  const row = app.windows[0]._reactX11Node.children[0];
  assert.strictEqual(row.children[1].abs.x, 100);

  render('column');
  await tick();
  assert.deepStrictEqual(
    [row.children[1].abs.x, row.children[1].abs.y],
    [0, 50],
  );

  await x11Root.unmount();
});

test('dispatches synthetic clicks, hover and focus events', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const log = [];
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 100 },
      React.createElement(
        'box',
        {
          onClick: () => log.push('outer'),
          style: { flexDirection: 'row', flexGrow: 1 },
        },
        React.createElement('box', {
          focusable: true,
          onClick: (ev) => {
            log.push(['left', ev.localX, ev.localY]);
            ev.stopPropagation();
          },
          onMouseEnter: () => log.push('enter-left'),
          onMouseLeave: () => log.push('leave-left'),
          onFocus: () => log.push('focus-left'),
          style: { flexGrow: 1 },
        }),
        React.createElement('box', { style: { flexGrow: 1 } }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];

  wnd.emit('mousemove', { x: 10, y: 10 });
  wnd.emit('mousedown', { x: 10, y: 10, keycode: 1 });
  wnd.emit('mouseup', { x: 10, y: 10, keycode: 1 });
  wnd.emit('mousemove', { x: 150, y: 10 });
  wnd.emit('mousedown', { x: 150, y: 10, keycode: 1 });
  wnd.emit('mouseup', { x: 150, y: 10, keycode: 1 });

  assert.deepStrictEqual(log, [
    'enter-left',
    'focus-left',
    ['left', 10, 10],
    'leave-left',
    'outer',
  ]);

  await x11Root.unmount();
});

test('zIndex controls hit testing order', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const log = [];
  x11Root.render(
    React.createElement(
      'window',
      { width: 100, height: 100 },
      React.createElement('box', {
        onClick: () => log.push('top'),
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          width: 100,
          height: 100,
          zIndex: 2,
        },
      }),
      React.createElement('box', {
        onClick: () => log.push('bottom'),
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          width: 100,
          height: 100,
        },
      }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  wnd.emit('mousedown', { x: 50, y: 50, keycode: 1 });
  wnd.emit('mouseup', { x: 50, y: 50, keycode: 1 });

  assert.deepStrictEqual(log, ['top']);
  await x11Root.unmount();
});

test('a scroll box scrolls, clamps and offsets hit testing', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const clicks = [];
  x11Root.render(
    React.createElement(
      'window',
      { width: 100, height: 100 },
      React.createElement(
        'box',
        { style: { overflow: 'scroll', flexGrow: 1 } },
        [0, 1, 2].map((i) =>
          React.createElement('box', {
            key: i,
            onClick: () => clicks.push(i),
            style: { height: 60 },
          }),
        ),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const sv = wnd._reactX11Node.children[0];

  assert.strictEqual(sv.contentHeight, 180);
  assert.strictEqual(sv.children[1].abs.y, 60);

  // a notch down scrolls by default
  spinWheel(wnd, 50, 50, { deltaY: 1 });
  await tick();
  assert.strictEqual(sv.scrollY, 48);
  assert.strictEqual(sv.children[1].abs.y, 12);

  // clamps to content height - viewport
  sv.scrollBy(1000);
  await tick();
  assert.strictEqual(sv.scrollY, 80);

  // hit testing sees scrolled positions: viewport y=10 is content y=90
  wnd.emit('mousedown', { x: 50, y: 10, keycode: 1 });
  wnd.emit('mouseup', { x: 50, y: 10, keycode: 1 });
  assert.deepStrictEqual(clicks, [1]);

  await x11Root.unmount();
});

test('a shrinking window shrinks the scroll box, not the footer out of view', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const Host = ({ height }) =>
    React.createElement(
      'window',
      { width: 200, height },
      React.createElement(
        'box',
        { style: { flexGrow: 1 } },
        React.createElement('box', { style: { height: 30 } }), // header
        React.createElement(
          'box',
          { style: { overflow: 'scroll', flexGrow: 1 } },
          ...Array.from({ length: 10 }, (_, i) =>
            React.createElement('box', {
              key: i,
              style: { height: 40, flexShrink: 0 },
            }),
          ),
        ),
        React.createElement('box', { style: { height: 24 } }), // footer
      ),
    );

  x11Root.render(React.createElement(Host, { height: 400 }));
  await tick();
  const wnd = app.windows[0];
  const root = wnd._reactX11Node;
  const [header, scroll, footer] = root.children[0].children;
  assert.strictEqual(header.abs.y, 0);
  assert.strictEqual(
    footer.abs.y + footer.abs.height,
    400,
    'footer at the bottom',
  );

  // the user drags the window smaller: 400 -> 160, less than the content
  wnd.width = 200;
  wnd.height = 160;
  wnd.emit('resize', { width: 200, height: 160, x: 0, y: 0 });
  await tick();
  await tick();

  assert.strictEqual(
    footer.abs.y + footer.abs.height,
    160,
    'footer is still on screen, not pushed past the bottom',
  );
  assert.strictEqual(
    scroll.abs.height,
    160 - 30 - 24,
    'the scroll box took the squeeze',
  );
  assert.ok(
    scroll.contentHeight > scroll.abs.height,
    'and its content now overflows, so it scrolls',
  );

  await x11Root.unmount();
});

test('scrollIntoView scrolls the minimum amount', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 100, height: 100 },
      React.createElement(
        'box',
        { style: { overflow: 'scroll', flexGrow: 1 } },
        [0, 1, 2].map((i) =>
          React.createElement('box', { key: i, style: { height: 60 } }),
        ),
      ),
    ),
  );
  await tick();
  const sv = app.windows[0]._reactX11Node.children[0];

  // last child (content 120..180) into a 100px viewport: scroll to its bottom
  sv.scrollIntoView(sv.children[2]);
  await tick();
  assert.strictEqual(sv.scrollY, 80);

  // first child is above the viewport: align its top
  sv.scrollIntoView(sv.children[0]);
  await tick();
  assert.strictEqual(sv.scrollY, 0);

  // already fully visible → no movement
  sv.scrollIntoView(sv.children[0]);
  await tick();
  assert.strictEqual(sv.scrollY, 0);

  // a node outside this scroll box is ignored
  sv.scrollIntoView(app.windows[0]._reactX11Node);
  await tick();
  assert.strictEqual(sv.scrollY, 0);

  await x11Root.unmount();
});

test('window manager hints pass through at creation and on update', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const render = (props) =>
    x11Root.render(
      React.createElement('window', { width: 200, height: 100, ...props }),
    );

  // creation goes through ntk's Window constructor as creation attributes
  render({
    resizable: false,
    wmClass: ['react-x11', 'React-X11'],
    windowType: 'dialog',
    minWidth: 120,
  });
  const wnd = app.windows[0];
  assert.strictEqual(wnd.attributes.resizable, false);
  assert.deepStrictEqual(wnd.attributes.wmClass, ['react-x11', 'React-X11']);
  assert.strictEqual(wnd.attributes.windowType, 'dialog');
  assert.deepStrictEqual(wnd.attributes.sizeHints, { minWidth: 120 });

  const hintCalls = () =>
    wnd.calls.filter(([name]) => name.startsWith('set') && name !== 'setTitle');

  // a re-render with identical hints must not re-send them: the hints are
  // collected into a fresh object every render, so identity always changes
  wnd.calls.length = 0;
  render({
    resizable: false,
    wmClass: ['react-x11', 'React-X11'],
    windowType: 'dialog',
    minWidth: 120,
  });
  assert.deepStrictEqual(hintCalls(), [], 'unchanged hints are not re-sent');

  // changing one hint sends only that one
  wnd.calls.length = 0;
  render({
    resizable: false,
    wmClass: ['react-x11', 'React-X11'],
    windowType: 'dialog',
    minWidth: 300,
    maxWidth: 900,
  });
  assert.deepStrictEqual(hintCalls(), [
    ['setSizeHints', { minWidth: 300, maxWidth: 900, resizable: false }],
  ]);

  // alwaysOnTop toggles both ways. It is sugar for the 'above' state now,
  // so it goes out through the same _NET_WM_STATE path as everything else
  wnd.calls.length = 0;
  render({ alwaysOnTop: true });
  assert.ok(
    wnd.calls.some(
      ([name, s, action]) =>
        name === 'setWmState' && s === 'above' && action === 'add',
    ),
    "alwaysOnTop adds 'above'",
  );

  wnd.calls.length = 0;
  render({ alwaysOnTop: false });
  assert.ok(
    wnd.calls.some(
      ([name, s, action]) =>
        name === 'setWmState' && s === 'above' && action === 'remove',
    ),
    "dropping alwaysOnTop removes 'above'",
  );

  await x11Root.unmount();
});

test('popup mounts as an override-redirect window and unmounts cleanly', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const render = (open) =>
    x11Root.render(
      React.createElement(
        'window',
        { width: 200, height: 100 },
        React.createElement(
          'box',
          { style: { flexGrow: 1 } },
          open
            ? React.createElement('popup', {
                x: 300,
                y: 150,
                width: 120,
                height: 80,
              })
            : null,
        ),
      ),
    );

  render(false);
  assert.strictEqual(app.windows.length, 1);

  render(true);
  assert.strictEqual(app.windows.length, 2);
  const popup = app.windows[1];
  assert.strictEqual(popup.attributes.overrideRedirect, true);
  // the EWMH type hint is additive — override-redirect still keeps the WM
  // from moving or decorating the menu; the hint only lets compositing
  // managers style it consistently (wm-spec asks for it on o-r windows)
  assert.strictEqual(popup.attributes.windowType, 'dropdown_menu');
  assert.deepStrictEqual([popup.attributes.x, popup.attributes.y], [300, 150]);
  assert.strictEqual(popup.mapped, true);

  render(false);
  assert.strictEqual(popup.destroyed, true);

  await x11Root.unmount();
});

test('cursor prop follows hover (feature-detected setCursor)', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 100 },
      React.createElement(
        'box',
        { style: { flexDirection: 'row', flexGrow: 1 } },
        React.createElement('box', {
          style: { flexGrow: 1, cursor: 'pointer' },
        }),
        React.createElement('box', { style: { flexGrow: 1 } }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];

  wnd.emit('mousemove', { x: 10, y: 10 });
  assert.strictEqual(wnd.cursor, 'pointer');

  wnd.emit('mousemove', { x: 150, y: 10 });
  assert.strictEqual(wnd.cursor, null, 'leaving the node restores the cursor');

  await x11Root.unmount();
});

test('textinput: typing, backspace, arrows, submit (uncontrolled)', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const changes = [];
  let submitted = null;
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 50 },
      React.createElement('textinput', {
        defaultValue: '',
        onChange: (ev) => changes.push(ev.target.value),
        onSubmit: (ev) => (submitted = ev.target.value),
        style: { flexGrow: 1 },
      }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const input = wnd._reactX11Node.children[0];

  // click focuses (focusableByDefault)
  wnd.emit('mousedown', { x: 10, y: 10, keycode: 1 });
  wnd.emit('mouseup', { x: 10, y: 10, keycode: 1 });
  assert.strictEqual(input._focused, true);

  pressKey(app, wnd, { keysym: 0x68, codepoint: 0x68 }); // h
  pressKey(app, wnd, { keysym: 0x69, codepoint: 0x69 }); // i
  assert.deepStrictEqual(changes, ['h', 'hi']);
  assert.strictEqual(input.value, 'hi');

  pressKey(app, wnd, { keysym: XK.BackSpace });
  assert.strictEqual(input.value, 'h');

  // caret movement + insert in the middle
  pressKey(app, wnd, { keysym: XK.Left });
  pressKey(app, wnd, { keysym: 0x6f, codepoint: 0x6f }); // o
  assert.strictEqual(input.value, 'oh');

  pressKey(app, wnd, { keysym: XK.Return });
  assert.strictEqual(submitted, 'oh');

  await x11Root.unmount();
});

test('textinput: controlled value does not change until props do', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const changes = [];
  const render = (value) =>
    x11Root.render(
      React.createElement(
        'window',
        { width: 200, height: 50 },
        React.createElement('textinput', {
          value,
          onChange: (ev) => changes.push(ev.target.value),
          style: { flexGrow: 1 },
        }),
      ),
    );
  render('abc');
  await tick();
  const wnd = app.windows[0];
  const input = wnd._reactX11Node.children[0];

  wnd.emit('mousedown', { x: 10, y: 10, keycode: 1 });
  wnd.emit('mouseup', { x: 10, y: 10, keycode: 1 });
  pressKey(app, wnd, { keysym: 0x78, codepoint: 0x78 }); // x

  assert.deepStrictEqual(changes, ['abcx']);
  assert.strictEqual(input.value, 'abc', 'display waits for the value prop');

  render('abcx');
  assert.strictEqual(input.value, 'abcx');

  await x11Root.unmount();
});

// issue #115: onChange/onSubmit hand over a synthetic event like every other
// handler, so `e.target.value` — what react-hook-form, formik and every
// tutorial's controlled input read — is the value the edit produced.
test('textinput: onChange gets a synthetic event carrying value and name', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const events = [];
  // `ev.target` is the live node, so what it reports has to be sampled while
  // the handler runs — that is the moment form libraries read it
  const seen = [];
  const record = (ev) => {
    events.push(ev);
    seen.push({ value: ev.target.value, name: ev.target.name });
  };
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 50 },
      React.createElement('textinput', {
        // controlled and never re-rendered: props.value stays 'ab', so a
        // stale read is visible rather than hidden by the uncontrolled path
        value: 'ab',
        name: 'email',
        onChange: record,
        onSubmit: record,
        style: { flexGrow: 1 },
      }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const input = wnd._reactX11Node.children[0];
  wnd.emit('mousedown', { x: 10, y: 10, keycode: 1 });
  wnd.emit('mouseup', { x: 10, y: 10, keycode: 1 });

  pressKey(app, wnd, { keysym: 0x63, codepoint: 0x63 }); // c
  assert.strictEqual(events.length, 1);
  const change = events[0];
  assert.strictEqual(change.type, 'change');
  assert.strictEqual(change.value, 'abc');
  assert.strictEqual(change.name, 'email');
  assert.strictEqual(change.target, input, 'target is the public node');
  assert.strictEqual(change.currentTarget, input);
  assert.deepStrictEqual(
    seen[0],
    { value: 'abc', name: 'email' },
    'target.value is the new value, not the stale controlled prop',
  );
  assert.strictEqual(typeof change.preventDefault, 'function');
  assert.strictEqual(typeof change.stopPropagation, 'function');
  // a keystroke carries the X event it came from — downshift reads
  // `ev.nativeEvent.preventDownshiftDefault` and a null there is a TypeError
  assert.strictEqual(change.nativeEvent?.codepoint, 0x63);

  // and the control is back to reporting its prop once the handler returns
  assert.strictEqual(input.value, 'ab');

  pressKey(app, wnd, { keysym: XK.Return });
  const submit = events[1];
  assert.strictEqual(submit.type, 'submit');
  assert.strictEqual(submit.value, 'ab');
  assert.strictEqual(submit.target, input);
  assert.strictEqual(submit.name, 'email');
  assert.deepStrictEqual(seen[1], { value: 'ab', name: 'email' });
  assert.ok(submit.nativeEvent, 'submit carries the key event it came from');

  await x11Root.unmount();
});

// react-hook-form's register() hands the field ref back and writes through
// it: `ref.value = ''` on mount and on reset(). A getter-only `value` made
// that a TypeError during commit, which took the whole render down.
test('textinput: node.value is writable, the way a DOM input is', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const changes = [];
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 50 },
      React.createElement('textinput', {
        defaultValue: 'start',
        onChange: (ev) => changes.push(ev.value),
        style: { flexGrow: 1 },
      }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const input = wnd._reactX11Node.children[0];

  input.value = 'written';
  assert.strictEqual(input.value, 'written');
  assert.deepStrictEqual(changes, [], 'assigning does not fire onChange');

  input.value = '';
  assert.strictEqual(input.value, '');
  // and it took an undo entry, like a value pushed in through props
  assert.strictEqual(input.undo(), true);
  assert.strictEqual(input.value, 'written');

  await x11Root.unmount();
});

test('textarea: Ctrl+Enter submits with the same event shape', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  let submitted = null;
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 90 },
      React.createElement('textarea', {
        defaultValue: 'note',
        name: 'body',
        onSubmit: (ev) => (submitted = ev),
        style: { flexGrow: 1 },
      }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  wnd.emit('mousedown', { x: 10, y: 10, keycode: 1 });
  wnd.emit('mouseup', { x: 10, y: 10, keycode: 1 });
  pressKey(app, wnd, { keysym: XK.Return, buttons: CTRL });
  assert.strictEqual(submitted?.type, 'submit');
  assert.strictEqual(submitted.value, 'note');
  assert.strictEqual(submitted.target.value, 'note');
  assert.strictEqual(submitted.name, 'body');
  assert.strictEqual(submitted.target.name, 'body');

  await x11Root.unmount();
});

// a throwing handler must not leave the control reporting a value it never
// took — `_pendingValue` is restored in a finally
test('textinput: a throwing onChange does not strand the pending value', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const errors = [];
  const console_error = console.error;
  console.error = (...args) => errors.push(args);
  try {
    x11Root.render(
      React.createElement(
        'window',
        { width: 200, height: 50 },
        React.createElement('textinput', {
          value: 'ab',
          onChange: () => {
            throw new Error('boom');
          },
          style: { flexGrow: 1 },
        }),
      ),
    );
    await tick();
    const wnd = app.windows[0];
    const input = wnd._reactX11Node.children[0];
    wnd.emit('mousedown', { x: 10, y: 10, keycode: 1 });
    wnd.emit('mouseup', { x: 10, y: 10, keycode: 1 });
    pressKey(app, wnd, { keysym: 0x63, codepoint: 0x63 });
    assert.strictEqual(input.value, 'ab');
    assert.strictEqual(
      errors.length,
      1,
      'the throw is reported, not swallowed',
    );
    await x11Root.unmount();
  } finally {
    console.error = console_error;
    process.exitCode = 0;
  }
});

test('textinput: clipboard shortcuts and middle-click PRIMARY paste', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  app.clipboard = {
    writes: [],
    write(text, opts) {
      this.writes.push([text, opts?.selection ?? 'CLIPBOARD']);
      return Promise.resolve();
    },
    read(opts) {
      return Promise.resolve(
        opts?.selection === 'PRIMARY' ? 'primary!' : 'clip!',
      );
    },
  };
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 50 },
      React.createElement('textinput', {
        defaultValue: 'hello',
        style: { flexGrow: 1 },
      }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const input = wnd._reactX11Node.children[0];

  wnd.emit('mousedown', { x: 10, y: 10, keycode: 1 });
  wnd.emit('mouseup', { x: 10, y: 10, keycode: 1 });

  pressKey(app, wnd, { keysym: 0x61, codepoint: 0x61, buttons: 4 }); // ctrl+a
  assert.deepStrictEqual(input._selection(), [0, 5]);

  pressKey(app, wnd, { keysym: 0x63, codepoint: 0x63, buttons: 4 }); // ctrl+c
  assert.deepStrictEqual(app.clipboard.writes.at(-1), ['hello', 'CLIPBOARD']);

  pressKey(app, wnd, { keysym: 0x76, codepoint: 0x76, buttons: 4 }); // ctrl+v
  await tick();
  assert.strictEqual(input.value, 'clip!', 'paste replaces the selection');

  wnd.emit('mousedown', { x: 10, y: 10, keycode: 2 }); // middle click
  await tick();
  assert.strictEqual(input.value, 'clip!primary!');

  await x11Root.unmount();
});

test('textinput: a copy and a paste carry the timestamp of the event behind them', async () => {
  // X arbitrates selection ownership by timestamp, and the right one is the
  // event that triggered the copy — not "whenever ntk's round trip asking
  // the server for the time happened to finish"
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  app.clipboard = {
    writes: [],
    reads: [],
    write(text, opts) {
      this.writes.push({ text, selection: opts?.selection, time: opts?.time });
      return Promise.resolve();
    },
    read(opts) {
      this.reads.push({ selection: opts?.selection, time: opts?.time });
      return Promise.resolve('pasted');
    },
  };
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 50 },
      React.createElement('textinput', {
        defaultValue: 'hello',
        style: { flexGrow: 1 },
      }),
    ),
  );
  await tick();
  const wnd = app.windows[0];

  wnd.emit('mousedown', { x: 10, y: 10, keycode: 1, time: 900 });
  wnd.emit('mouseup', { x: 10, y: 10, keycode: 1, time: 901 });

  pressKey(app, wnd, { keysym: 0x61, codepoint: 0x61, buttons: 4, time: 1000 }); // ctrl+a
  pressKey(app, wnd, { keysym: 0x63, codepoint: 0x63, buttons: 4, time: 1001 }); // ctrl+c
  assert.strictEqual(
    app.clipboard.writes.at(-1).time,
    1001,
    'the copy carries its own keystroke, not the select-all before it',
  );

  pressKey(app, wnd, { keysym: 0x76, codepoint: 0x76, buttons: 4, time: 1002 }); // ctrl+v
  await tick();
  assert.deepStrictEqual(app.clipboard.reads.at(-1), {
    selection: 'CLIPBOARD',
    time: 1002,
  });

  // middle-click paste is driven by the button event, so that is the stamp
  wnd.emit('mousedown', { x: 10, y: 10, keycode: 2, time: 1003 });
  await tick();
  assert.deepStrictEqual(app.clipboard.reads.at(-1), {
    selection: 'PRIMARY',
    time: 1003,
  });

  await x11Root.unmount();
});

test('textinput: with no input seen yet, ntk is left to find its own timestamp', async () => {
  // `undefined` rather than 0: CurrentTime is what ICCCM 2.1 forbids, and
  // ntk's own fallback asks the server for a real one
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const writes = [];
  app.clipboard = {
    write(text, opts) {
      writes.push(opts);
      return Promise.resolve();
    },
    read: () => Promise.resolve(''),
  };
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 50 },
      React.createElement('textinput', {
        defaultValue: 'hello',
        style: { flexGrow: 1 },
      }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const input = wnd._reactX11Node.children[0];
  input._anchor = 0;
  input._caret = 5;
  input._copySelection();
  assert.strictEqual(writes.length, 1);
  assert.ok(
    !('time' in writes[0]) || writes[0].time === undefined,
    'no invented timestamp',
  );

  await x11Root.unmount();
});

test('dashed borders emit setLineDash when the context supports it', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 100, height: 100 },
      React.createElement('box', {
        style: {
          flexGrow: 1,
          borderWidth: 2,
          borderColor: 'black',
          borderStyle: 'dashed',
        },
      }),
    ),
  );
  await tick();
  const dashOps = app.windows[0].ctx.ops.filter(([op]) => op === 'setLineDash');
  assert.deepStrictEqual(dashOps[0], ['setLineDash', [6, 4]]);
  assert.deepStrictEqual(dashOps.at(-1), ['setLineDash', []]);

  await x11Root.unmount();
});

test('textinput: double-click selects word, triple-click selects all', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  app.clipboard = {
    writes: [],
    write(text, opts) {
      this.writes.push([text, opts?.selection ?? 'CLIPBOARD']);
      return Promise.resolve();
    },
    read() {
      return Promise.resolve('');
    },
  };
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 50 },
      React.createElement('textinput', {
        defaultValue: 'hello world',
        style: { flexGrow: 1 },
      }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const input = wnd._reactX11Node.children[0];

  const clickAt = (x, y) => {
    wnd.emit('mousedown', { x, y, keycode: 1 });
    wnd.emit('mouseup', { x, y, keycode: 1 });
  };

  clickAt(10, 10); // focus, detail 1
  clickAt(10, 10); // detail 2 → word select
  assert.deepStrictEqual(input._selection(), [6, 11]);
  assert.deepStrictEqual(app.clipboard.writes.at(-1), ['world', 'PRIMARY']);

  clickAt(10, 10); // detail 3 → select all
  assert.deepStrictEqual(input._selection(), [0, 11]);

  await x11Root.unmount();
});

test('Select opens a popup menu, picks an option, closes on Escape', async () => {
  const { Select } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const picks = [];
  x11Root.render(
    React.createElement(
      'window',
      { width: 240, height: 120 },
      React.createElement(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        React.createElement(Select, {
          options: ['red', 'green', 'blue'],
          value: null,
          onChange: (ev) => picks.push(ev.value),
          style: { width: 160 },
        }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const windowNode = wnd._reactX11Node;

  const findFocusable = (node) => {
    if (node.props?.focusable) return node;
    for (const child of node.children) {
      if (child.isWindow) continue;
      const hit = findFocusable(child);
      if (hit) return hit;
    }
    return null;
  };
  const trigger = findFocusable(windowNode);
  assert.ok(trigger, 'Select trigger should be focusable');
  const cx = trigger.abs.x + 10;
  const cy = trigger.abs.y + trigger.abs.height / 2;

  wnd.emit('mousedown', { x: cx, y: cy, keycode: 1 });
  wnd.emit('mouseup', { x: cx, y: cy, keycode: 1 });
  await tick();

  assert.strictEqual(app.windows.length, 2, 'menu popup window created');
  const popup = app.windows[1];
  assert.strictEqual(popup.attributes.overrideRedirect, true);
  assert.strictEqual(popup.attributes.width, trigger.abs.width);
  await tick();

  // click the first option inside the popup's own window
  popup.emit('mousedown', { x: 20, y: 19, keycode: 1 });
  popup.emit('mouseup', { x: 20, y: 19, keycode: 1 });
  await tick();
  assert.deepStrictEqual(picks, ['red']);
  assert.strictEqual(popup.destroyed, true, 'menu closes after picking');

  // reopen (wait out the multi-click window), then Escape closes
  await new Promise((resolve) => setTimeout(resolve, 450));
  wnd.emit('mousedown', { x: cx, y: cy, keycode: 1 });
  wnd.emit('mouseup', { x: cx, y: cy, keycode: 1 });
  await tick();
  assert.strictEqual(app.windows.length, 3, 'menu reopened');
  pressKey(app, wnd, { keysym: 0xff1b }); // Escape
  await tick();
  assert.strictEqual(app.windows[2].destroyed, true);

  await x11Root.unmount();
});

test('Select: arrow keys move the active option, Enter picks it', async () => {
  const { Select } = await import('../src/index.js');
  const XK_DOWN = 0xff54;
  const XK_UP = 0xff52;
  const XK_HOME = 0xff50;
  const XK_END = 0xff57;
  const HOVER_BG = '#2980b9';

  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const picks = [];
  x11Root.render(
    React.createElement(
      'window',
      { width: 240, height: 120 },
      React.createElement(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        React.createElement(Select, {
          options: ['red', 'green', 'blue'],
          value: 'green',
          onChange: (ev) => picks.push(ev.value),
          style: { width: 160 },
        }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];

  const findFocusable = (node) => {
    if (node.props?.focusable) return node;
    for (const child of node.children) {
      if (child.isWindow) continue;
      const hit = findFocusable(child);
      if (hit) return hit;
    }
    return null;
  };
  const trigger = findFocusable(wnd._reactX11Node);
  const cx = trigger.abs.x + 10;
  const cy = trigger.abs.y + trigger.abs.height / 2;

  // the active option is the one painted with the highlight background
  const activeIndex = () => {
    const popup = app.windows.at(-1);
    let scroller = null;
    const walk = (n) => {
      if (n.isScroller?.()) scroller = n;
      else n.children.forEach(walk);
    };
    walk(popup._reactX11Node);
    return scroller.children.findIndex(
      (o) => o.style.backgroundColor === HOVER_BG,
    );
  };

  // click focuses the trigger and opens the menu on the selected option
  wnd.emit('mousedown', { x: cx, y: cy, keycode: 1 });
  wnd.emit('mouseup', { x: cx, y: cy, keycode: 1 });
  await tick();
  assert.strictEqual(activeIndex(), 1, 'opens on the current value');

  pressKey(app, wnd, { keysym: XK_DOWN });
  await tick();
  assert.strictEqual(activeIndex(), 2);

  pressKey(app, wnd, { keysym: XK_DOWN }); // wraps
  await tick();
  assert.strictEqual(activeIndex(), 0);

  pressKey(app, wnd, { keysym: XK_UP }); // wraps back
  await tick();
  assert.strictEqual(activeIndex(), 2);

  pressKey(app, wnd, { keysym: XK_HOME });
  await tick();
  assert.strictEqual(activeIndex(), 0);

  pressKey(app, wnd, { keysym: XK_END });
  await tick();
  assert.strictEqual(activeIndex(), 2);

  // Enter picks the active option (not the one under the pointer)
  pressKey(app, wnd, { keysym: XK.Return });
  await tick();
  assert.deepStrictEqual(picks, ['blue']);
  assert.strictEqual(app.windows[1].destroyed, true, 'menu closes on pick');

  // with the menu closed, Down reopens it — focus stayed on the trigger
  pressKey(app, wnd, { keysym: XK_DOWN });
  await tick();
  assert.strictEqual(app.windows.length, 3, 'Down reopens the menu');
  assert.strictEqual(activeIndex(), 1, 'still anchored on the current value');

  pressKey(app, wnd, { keysym: 0xff1b }); // Escape
  await tick();
  assert.strictEqual(app.windows[2].destroyed, true);
  assert.deepStrictEqual(picks, ['blue'], 'Escape does not pick');

  await x11Root.unmount();
});

test('Select: an overlong menu scrolls the active option into view', async () => {
  const { Select } = await import('../src/index.js');
  const XK_DOWN = 0xff54;
  const XK_END = 0xff57;
  // a row is its capitals plus even padding: 10 + 10 + 10 at the default
  // 14px body (`Select.js`, ITEM_HEIGHT)
  const ITEM_HEIGHT = 30;
  // the scroll box's own padding, which the menu's chrome is measured from
  // (`Select.js`, MENU_PAD — the same inset the menus use, and what the
  // option's own corner radius is derived from)
  const MENU_PAD = 4;
  const options = Array.from({ length: 12 }, (_, i) => `option-${i}`);

  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 120 },
      React.createElement(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        React.createElement(Select, {
          options,
          value: options[0],
          style: { width: 220 },
        }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];

  const findFocusable = (node) => {
    if (node.props?.focusable) return node;
    for (const child of node.children) {
      if (child.isWindow) continue;
      const hit = findFocusable(child);
      if (hit) return hit;
    }
    return null;
  };
  const trigger = findFocusable(wnd._reactX11Node);
  wnd.emit('mousedown', {
    x: trigger.abs.x + 10,
    y: trigger.abs.y + trigger.abs.height / 2,
    keycode: 1,
  });
  wnd.emit('mouseup', {
    x: trigger.abs.x + 10,
    y: trigger.abs.y + trigger.abs.height / 2,
    keycode: 1,
  });
  // scrollIntoView resolves on the popup's next layout pass, so a key press
  // needs the effect's tick plus the flush it schedules
  const settle = async () => {
    await tick();
    await tick();
  };
  await settle();

  const scroller = (() => {
    let found = null;
    const walk = (n) => {
      if (n.isScroller?.()) found = n;
      else n.children.forEach(walk);
    };
    walk(app.windows[1]._reactX11Node);
    return found;
  })();

  // the frame must shrink to the popup so the viewport is the clamped menu
  // height, not the full content height — otherwise nothing ever scrolls
  assert.ok(
    scroller.contentHeight > scroller.abs.height,
    `menu should overflow: content ${scroller.contentHeight} vs viewport ${scroller.abs.height}`,
  );
  assert.strictEqual(scroller.scrollY, 0);

  // arrowing down only scrolls once the active option leaves the viewport
  const visible = Math.floor((scroller.abs.height - MENU_PAD) / ITEM_HEIGHT);
  for (let i = 0; i < visible - 1; i++) pressKey(app, wnd, { keysym: XK_DOWN });
  await settle();
  assert.strictEqual(scroller.scrollY, 0, 'still within the viewport');

  pressKey(app, wnd, { keysym: XK_DOWN });
  await settle();
  assert.ok(scroller.scrollY > 0, 'scrolls to keep the active option visible');

  // End jumps to the last option: scrolled to the bottom of the content
  pressKey(app, wnd, { keysym: XK_END });
  await settle();
  assert.strictEqual(
    scroller.scrollY,
    MENU_PAD + options.length * ITEM_HEIGHT - scroller.abs.height,
  );

  await x11Root.unmount();
});

// The menu used to take the trigger's width, and the trigger is only ever as
// wide as the *selected* value — so picking a short option made every longer
// one wrap inside a fixed 28px row and overlap the option beneath it.
test('Select: the menu fits its longest option, not the selected one', async () => {
  const { Select } = await import('../src/index.js');
  const { measureLabel } = await import('../src/components/anchor.js');
  const { DEFAULT_TEXT_STYLE } = await import('../src/styles.js');

  const LONGEST = 'a considerably longer option than the trigger';
  const options = ['S', 'medium one', LONGEST];

  const openWith = async (selected) => {
    const app = createMockApp();
    const x11Root = await createRoot({ app });
    x11Root.render(
      React.createElement(
        'window',
        { width: 400, height: 200 },
        React.createElement(
          'box',
          { style: { flexGrow: 1, padding: 10 } },
          React.createElement(Select, {
            options,
            value: selected,
            style: { width: 60 },
          }),
        ),
      ),
    );
    await tick();
    const wnd = app.windows[0];
    const findFocusable = (node) => {
      if (node.props?.focusable) return node;
      for (const child of node.children) {
        if (child.isWindow) continue;
        const hit = findFocusable(child);
        if (hit) return hit;
      }
      return null;
    };
    const trigger = findFocusable(wnd._reactX11Node);
    const x = trigger.abs.x + 10;
    const y = trigger.abs.y + trigger.abs.height / 2;
    wnd.emit('mousedown', { x, y, keycode: 1 });
    wnd.emit('mouseup', { x, y, keycode: 1 });
    await tick();
    return { app, x11Root, trigger, popup: app.windows[1] };
  };

  const { x11Root, trigger, popup } = await openWith('S');
  assert.ok(
    popup.attributes.width > trigger.abs.width,
    `menu (${popup.attributes.width}) should outgrow the trigger (${trigger.abs.width})`,
  );

  // the longest label plus the row's own left padding has to fit, or the text
  // wraps into the row below it — which is the bug
  const longest = measureLabel(trigger, LONGEST, {
    size: DEFAULT_TEXT_STYLE.size,
  }).width;
  assert.ok(
    popup.attributes.width >= Math.ceil(longest) + 10,
    `menu (${popup.attributes.width}) should fit the longest label (${Math.ceil(longest)})`,
  );
  await x11Root.unmount();

  // and it does not depend on which option is selected: the widest one is
  // measured bold, the way Option paints it, so that case is the wider one
  const withLongSelected = await openWith(LONGEST);
  assert.ok(
    withLongSelected.popup.attributes.width >= popup.attributes.width,
    'selecting the longest option must not shrink the menu',
  );
  await withLongSelected.x11Root.unmount();
});

test('Select: the menu is never narrower than the trigger', async () => {
  const { Select } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 400, height: 200 },
      React.createElement(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        React.createElement(Select, {
          options: ['a', 'b'],
          value: 'a',
          style: { width: 240 },
        }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const findFocusable = (node) => {
    if (node.props?.focusable) return node;
    for (const child of node.children) {
      if (child.isWindow) continue;
      const hit = findFocusable(child);
      if (hit) return hit;
    }
    return null;
  };
  const trigger = findFocusable(wnd._reactX11Node);
  const x = trigger.abs.x + 10;
  const y = trigger.abs.y + trigger.abs.height / 2;
  wnd.emit('mousedown', { x, y, keycode: 1 });
  wnd.emit('mouseup', { x, y, keycode: 1 });
  await tick();

  assert.strictEqual(
    app.windows[1].attributes.width,
    trigger.abs.width,
    'two one-letter options still open a menu the width of the trigger',
  );
  await x11Root.unmount();
});

test('text spans collect nested styles', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 100, height: 100 },
      React.createElement(
        'text',
        { style: { color: 'black', fontSize: 12 } },
        'Hello ',
        React.createElement(
          'text',
          { style: { color: 'red', fontWeight: 'bold' } },
          'world',
        ),
      ),
    ),
  );

  const textNode = app.windows[0]._reactX11Node.children[0];
  // no base to hand over: a span inherits from the <text> around it through
  // the same cascade a <text> inherits from the <box> around it
  const spans = textNode.collectSpans([]);
  assert.strictEqual(spans.length, 2);
  assert.deepStrictEqual(
    [spans[0].text, spans[0].size, spans[0].color],
    ['Hello ', 12, 'black'],
  );
  assert.deepStrictEqual(
    [spans[1].text, spans[1].weight, spans[1].color],
    ['world', 'bold', 'red'],
  );

  await x11Root.unmount();
});

test('DevTools agent highlight tints the hovered node', async () => {
  const { EventEmitter } = await import('node:events');
  const { attachHighlightAgent } =
    await import('../src/DevToolsIntegration.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 100 },
      React.createElement(
        'box',
        { style: { flexDirection: 'row', flexGrow: 1 } },
        React.createElement('box', { style: { flexGrow: 1 } }),
        React.createElement('box', {
          style: { flexGrow: 1, backgroundColor: 'blue' },
        }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const right = wnd._reactX11Node.children[0].children[1];

  // DevTools' Highlighter/measure paths require this DOM-ish contract on
  // public instances before showNativeHighlight is ever emitted
  assert.strictEqual(typeof right.getClientRects, 'function');
  assert.deepStrictEqual(
    right.getClientRects()[0].width,
    100,
    'getClientRects reflects the laid-out rect',
  );
  assert.ok(
    right.ownerDocument && right.ownerDocument.documentElement === null,
    'ownerDocument stub prevents measureHostInstance crashes',
  );

  const agent = new EventEmitter();
  attachHighlightAgent(agent);

  agent.emit('showNativeHighlight', right);
  await tick();
  const tint = () =>
    wnd.ctx.ops.filter(
      ([op, , , , , style]) =>
        op === 'fillRect' && style === 'rgba(41, 128, 185, 0.35)',
    );
  assert.deepStrictEqual(tint().at(-1), [
    'fillRect',
    100,
    0,
    100,
    100,
    'rgba(41, 128, 185, 0.35)',
  ]);

  const before = wnd.ctx.ops.length;
  agent.emit('hideNativeHighlight');
  await tick();
  const newOps = wnd.ctx.ops.slice(before);
  assert.ok(
    !newOps.some(([, , , , , style]) => style === 'rgba(41, 128, 185, 0.35)'),
    'highlight cleared on hide',
  );

  await x11Root.unmount();
});

test('rich content elements mount, update and unmount headlessly', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const ui = (md) =>
    React.createElement(
      'window',
      { width: 400, height: 300 },
      React.createElement('markdown', null, md), // string child (react-markdown style)
      React.createElement('html', { source: '<p>hello</p>' }),
      React.createElement(
        'svg',
        { viewBox: '0 0 10 10', style: { width: 20, height: 20 } },
        React.createElement('rect', { width: 10, height: 10, fill: '#f00' }),
      ),
      React.createElement('svg', {
        source: '<svg viewBox="0 0 10 10"><circle r="5" fill="#00f"/></svg>',
      }),
      React.createElement('tex', { size: 20 }, 'x^2'),
    );

  x11Root.render(ui('# One'));
  await tick(); // paint flush: no fonts on the mock app, must not throw
  const [wnd] = app.windows;
  assert.ok(wnd.mapped, 'window mounted with rich content children');

  x11Root.render(ui('# Two'));
  await tick();

  await x11Root.unmount();
  assert.ok(wnd.destroyed, 'clean unmount');
});

// --- standard widgets (components.js) --------------------------------------

const findAllFocusable = (node, out = []) => {
  if (node.props?.focusable) out.push(node);
  for (const child of node.children) {
    if (!child.isWindow) findAllFocusable(child, out);
  }
  return out;
};

const clickNode = (wnd, node) => {
  const x = node.abs.x + node.abs.width / 2;
  const y = node.abs.y + node.abs.height / 2;
  wnd.emit('mousedown', { x, y, keycode: 1 });
  wnd.emit('mouseup', { x, y, keycode: 1 });
};

test('Button fires onPress via click and Space; disabled is inert', async () => {
  const { Button } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const presses = [];
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 200 },
      React.createElement(
        'box',
        {
          style: {
            flexGrow: 1,
            padding: 10,
            gap: 10,
            alignItems: 'flex-start',
          },
        },
        React.createElement(Button, {
          label: 'Go',
          onPress: () => presses.push('go'),
        }),
        React.createElement(Button, {
          label: 'Nope',
          disabled: true,
          onPress: () => presses.push('nope'),
        }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const focusables = findAllFocusable(wnd._reactX11Node);
  assert.strictEqual(focusables.length, 1, 'disabled button is not focusable');
  const [go] = focusables;

  clickNode(wnd, go);
  assert.deepStrictEqual(presses, ['go']);
  // the click focused it; Space activates
  pressKey(app, wnd, { codepoint: 32 });
  assert.deepStrictEqual(presses, ['go', 'go']);

  // clicking the disabled button does nothing
  const disabledText = (function find(n) {
    if (
      n.kind === 'text' &&
      n.children.some((c) => c.kind === 'textchunk' && c.text === 'Nope')
    ) {
      return n;
    }
    for (const c of n.children) {
      if (c.isWindow) continue;
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  })(wnd._reactX11Node);
  clickNode(wnd, disabledText.parent);
  assert.deepStrictEqual(presses, ['go', 'go']);
  await x11Root.unmount();
});

test('Checkbox and Switch toggle through onChange', async () => {
  const { Checkbox, Switch } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const log = [];
  function Wrapper() {
    const [checked, setChecked] = React.useState(false);
    const [on, setOn] = React.useState(false);
    return React.createElement(
      'box',
      {
        style: { flexGrow: 1, padding: 10, gap: 10, alignItems: 'flex-start' },
      },
      React.createElement(
        Checkbox,
        {
          checked,
          onChange: (ev) => {
            log.push(['check', ev.value]);
            setChecked(ev.value);
          },
        },
        'Enable',
      ),
      React.createElement(Switch, {
        checked: on,
        onChange: (ev) => {
          log.push(['switch', ev.value]);
          setOn(ev.value);
        },
      }),
    );
  }
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 200 },
      React.createElement(Wrapper),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const [checkbox, sw] = findAllFocusable(wnd._reactX11Node);

  clickNode(wnd, checkbox);
  await tick();
  pressKey(app, wnd, { codepoint: 32 }); // Space toggles back
  await tick();
  clickNode(wnd, sw);
  await tick();
  assert.deepStrictEqual(log, [
    ['check', true],
    ['check', false],
    ['switch', true],
  ]);
  await x11Root.unmount();
});

// One signature across the library: the value widgets hand `onChange` a
// change event, exactly as `<textinput>` does, so a form library's handler
// can be passed straight in with no per-widget adapter.
test('value widgets pass a named change event to onChange', async () => {
  const { Checkbox, RadioGroup, Radio, Slider } =
    await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const events = [];
  function Wrapper() {
    const [checked, setChecked] = React.useState(false);
    const [flavour, setFlavour] = React.useState('a');
    return React.createElement(
      'box',
      {
        style: { flexGrow: 1, padding: 10, gap: 10, alignItems: 'flex-start' },
      },
      React.createElement(
        Checkbox,
        {
          checked,
          name: 'agree',
          onChange: (ev) => {
            events.push(ev);
            setChecked(ev.value);
          },
        },
        'Agree',
      ),
      React.createElement(
        RadioGroup,
        {
          value: flavour,
          name: 'flavour',
          onChange: (ev) => {
            events.push(ev);
            setFlavour(ev.value);
          },
        },
        React.createElement(Radio, { value: 'a' }, 'A'),
        React.createElement(Radio, { value: 'b' }, 'B'),
      ),
      React.createElement(Slider, {
        value: 10,
        name: 'volume',
        onChange: (ev) => events.push(ev),
        style: { width: 100 },
      }),
    );
  }
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 240 },
      React.createElement(Wrapper),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const focusable = findAllFocusable(wnd._reactX11Node);

  clickNode(wnd, focusable[0]); // the checkbox
  await tick();
  clickNode(wnd, focusable[2]); // the second radio
  await tick();
  // the slider moves by keyboard: a click's value depends on laid-out width
  focusable[3].focus?.();
  pressKey(app, wnd, { keysym: 0xff53 }); // Right
  await tick();

  assert.deepStrictEqual(
    events.map((ev) => [ev.target.type, ev.name, ev.value]),
    [
      ['checkbox', 'agree', true],
      ['radio', 'flavour', 'b'],
      ['range', 'volume', 11],
    ],
  );
  // formik reads target.checked for a checkbox, react-hook-form reads it
  // after testing target.type — both have to find it
  assert.strictEqual(events[0].target.checked, true);
  assert.strictEqual(events[0].target.name, 'agree');
  assert.strictEqual(events[1].target.checked, undefined);
  // the event is the *only* argument: a handler taking one parameter, which
  // is what `onChange={formik.handleChange}` is, must receive the event and
  // not a bare value
  for (const ev of events) {
    assert.strictEqual(typeof ev, 'object');
    assert.strictEqual(ev.type, 'change');
  }
  await x11Root.unmount();
});

// The contract that matters, stated as the thing a user actually writes.
// A form library's handler reads the field out of `ev.target`, so passing it
// straight to a widget only works while the event is the first argument.
test('a one-parameter handler is handed the event, not the value', async () => {
  const { Checkbox } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const seen = [];
  // exactly the shape of formik's handleChange: one parameter, destructures
  // the field out of `.target`
  const handleChange = ({ target }) =>
    seen.push([target.name, target.type, target.checked]);
  function Wrapper() {
    const [checked, setChecked] = React.useState(false);
    return React.createElement(Checkbox, {
      name: 'agree',
      checked,
      onChange: (ev) => {
        handleChange(ev);
        setChecked(ev.value);
      },
    });
  }
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 100 },
      React.createElement(Wrapper),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  clickNode(wnd, findAllFocusable(wnd._reactX11Node)[0]);
  await tick();
  assert.deepStrictEqual(seen, [['agree', 'checkbox', true]]);
  await x11Root.unmount();
});

test('RadioGroup: click selects, arrow keys move selection (wrapping)', async () => {
  const { Radio, RadioGroup } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const picks = [];
  function Wrapper() {
    const [value, setValue] = React.useState('a');
    return React.createElement(
      RadioGroup,
      {
        value,
        onChange: (ev) => {
          picks.push(ev.value);
          setValue(ev.value);
        },
      },
      React.createElement(Radio, { value: 'a' }, 'A'),
      React.createElement(Radio, { value: 'b' }, 'B'),
      React.createElement(Radio, { value: 'c' }, 'C'),
    );
  }
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 200 },
      React.createElement(Wrapper),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const radios = findAllFocusable(wnd._reactX11Node);
  assert.strictEqual(radios.length, 3);

  clickNode(wnd, radios[1]); // select B (and focus it)
  await tick();
  pressKey(app, wnd, { keysym: 0xff54 }); // Down -> C
  await tick();
  pressKey(app, wnd, { keysym: 0xff54 }); // Down wraps -> A
  await tick();
  pressKey(app, wnd, { keysym: 0xff52 }); // Up wraps back -> C
  await tick();
  assert.deepStrictEqual(picks, ['b', 'c', 'a', 'c']);
  await x11Root.unmount();
});

test('ProgressBar fill width follows value', async () => {
  const { ProgressBar } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 100 },
      React.createElement(
        'box',
        { style: { flexGrow: 1, padding: 0 } },
        React.createElement(ProgressBar, { value: 0.5, style: { width: 200 } }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const track = (function find(n) {
    if (n.style?.overflow === 'hidden' && n.kind === 'box') return n;
    for (const c of n.children) {
      if (c.isWindow) continue;
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  })(wnd._reactX11Node);
  assert.ok(track, 'progress track renders');
  assert.strictEqual(track.abs.width, 200);
  const fill = track.children[0];
  assert.ok(
    Math.abs(fill.abs.width - 100) <= 1,
    `fill should be ~half the track, got ${fill.abs.width}`,
  );
  await x11Root.unmount();
});

// issue #130 -------------------------------------------------------------
//
// The hard part is not writing the property, it is resolving the prop: refs
// attach in the *layout* phase, after every mutation, so on the commit that
// mounts two sibling <window>s the second realizes while the first one's ref
// is still null. That is the case a multi-window app is made of.
test('transientFor resolves a ref that attaches after the window realized', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const main = React.createRef();
  const App = () =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement('window', { ref: main, width: 300, height: 200 }),
      React.createElement('window', {
        width: 200,
        height: 100,
        transientFor: main,
      }),
    );
  x11Root.render(React.createElement(App));
  const [owner, transient] = app.windows;
  // realize() ran with main.current still null, so nothing could be written
  assert.strictEqual(transient.transientFor, undefined);
  assert.ok(main.current, 'the ref attached in the layout phase');

  // the frame the mount scheduled is the first moment it can be resolved
  transient._reactX11Node.flush();
  assert.strictEqual(transient.transientFor, owner.id);
  // and it is not re-sent on every frame
  transient.calls.length = 0;
  transient._reactX11Node.flush();
  assert.strictEqual(
    transient.calls.some((c) => c[0] === 'setTransientFor'),
    false,
  );

  await x11Root.unmount();
});

test('transientFor takes an XID, a drawn-node ref, and null to clear', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const anchor = React.createRef();
  const render = (transientFor) =>
    x11Root.render(
      React.createElement(
        'window',
        { width: 300, height: 200 },
        React.createElement('box', { ref: anchor }),
        React.createElement('window', {
          width: 200,
          height: 100,
          transientFor,
        }),
      ),
    );

  render(4242);
  await tick();
  const [owner, transient] = app.windows;
  assert.strictEqual(transient.transientFor, 4242, 'a raw XID passes through');

  // a ref to a *drawn* node resolves to the window that owns it
  render(anchor);
  assert.strictEqual(transient.transientFor, owner.id);

  render('root');
  assert.strictEqual(transient.transientFor, 'root', 'the window-group form');

  transient.calls.length = 0;
  render(null);
  assert.strictEqual(transient.transientFor, null, 'null clears it');

  // and a window that never set one does not spend a DeleteProperty saying so
  const fresh = createMockApp();
  const x11Root_fresh = await createRoot({ app: fresh });
  x11Root_fresh.render(
    React.createElement('window', { width: 100, height: 100 }),
  );
  await tick();
  assert.strictEqual(
    fresh.windows[0].calls.some((c) => c[0] === 'setTransientFor'),
    false,
  );

  await x11Root.unmount();
  await x11Root_fresh.unmount();
});

test('a <popup> can opt out of override-redirect and be WM-managed', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 200 },
      React.createElement('popup', {
        x: 10,
        y: 10,
        width: 120,
        height: 80,
      }),
      React.createElement('popup', {
        x: 20,
        y: 20,
        width: 120,
        height: 80,
        overrideRedirect: false,
        windowType: 'dialog',
      }),
    ),
  );
  await tick();
  const [, menu, dialog] = app.windows;
  assert.strictEqual(
    menu.attributes.overrideRedirect,
    true,
    'menus keep the default that makes them menus',
  );
  assert.strictEqual(menu.attributes.windowType, 'dropdown_menu');
  assert.strictEqual(dialog.attributes.overrideRedirect, false);
  assert.strictEqual(dialog.attributes.windowType, 'dialog');

  await x11Root.unmount();
});

test('windowIdOf resolves windows, drawn nodes, refs and raw ids', async () => {
  const { windowIdOf } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const windowRef = React.createRef();
  const boxRef = React.createRef();
  x11Root.render(
    React.createElement(
      'window',
      { ref: windowRef, width: 300, height: 200 },
      React.createElement('box', { ref: boxRef }),
    ),
  );
  await tick();
  const id = app.windows[0].id;

  assert.strictEqual(windowIdOf(windowRef), id, 'a <window> ref');
  assert.strictEqual(windowIdOf(windowRef.current), id, 'and its instance');
  assert.strictEqual(
    windowIdOf(boxRef),
    id,
    'a drawn node resolves to its window',
  );
  assert.strictEqual(windowIdOf(boxRef.current), id);
  assert.strictEqual(windowIdOf(1234), 1234, 'a raw XID');
  assert.strictEqual(windowIdOf(null), null);
  assert.strictEqual(windowIdOf(React.createRef()), null, 'an empty ref');

  // the portal handle format: lowercase hex, no 0x
  assert.strictEqual(
    `x11:${windowIdOf(windowRef).toString(16)}`,
    `x11:${id.toString(16)}`,
  );

  await x11Root.unmount();
});

test('multiple root windows share one tree; onCloseRequest handles WM close', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const events = [];
  function Wrapper() {
    const [open, setOpen] = React.useState(true);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement('window', {
        width: 100,
        height: 80,
        title: 'main',
        onCloseRequest: () => events.push('main-close'),
      }),
      open &&
        React.createElement('window', {
          width: 90,
          height: 70,
          title: 'satellite',
          onCloseRequest: () => {
            events.push('sat-close');
            setOpen(false);
          },
        }),
    );
  }
  x11Root.render(React.createElement(Wrapper));
  await tick();
  assert.strictEqual(app.windows.length, 2, 'two real top-level windows');
  const sat = app.windows[1];

  // WM close button: ntk >= 5.3 decodes WM_DELETE_WINDOW into a cancellable
  // 'close' event (#160). react-x11 must always prevent the default — ntk
  // would destroy the window, and the unmount is React's decision.
  const closeEv = {
    name: 'close',
    time: 0,
    defaultPrevented: false,
    preventDefault() {
      closeEv.defaultPrevented = true;
    },
  };
  sat.emit('close', closeEv);
  await tick();
  assert.deepStrictEqual(events, ['sat-close']);
  assert.strictEqual(
    closeEv.defaultPrevented,
    true,
    "react-x11 prevents ntk's default destroy; the handler decides",
  );
  assert.strictEqual(
    sat.destroyed,
    true,
    'unmounting the closed <window> destroys the real window',
  );
  assert.strictEqual(app.windows[0].destroyed, false, 'main window stays');

  // raw client messages no longer reach the close path at all
  app.windows[0].emit('message', { format: 32, data: [999, 0, 0, 0, 0] });
  await tick();
  assert.deepStrictEqual(events, ['sat-close']);

  await x11Root.unmount();
});

test('Slider: drag keeps tracking after the pointer leaves the widget', async () => {
  const { Slider } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const seen = [];
  const Host = () => {
    const [v, setV] = React.useState(0);
    seen.push(v);
    return React.createElement(
      'window',
      { width: 400, height: 120 },
      React.createElement(
        'box',
        { style: { flexGrow: 1, padding: 20 } },
        React.createElement(Slider, {
          value: v,
          min: 0,
          max: 100,
          step: 1,
          onChange: (ev) => setV(ev.value),
          style: { width: 200 },
        }),
      ),
    );
  };
  x11Root.render(React.createElement(Host));
  await tick();

  const wnd = app.windows[0];
  const track = (function find(n) {
    if (n.props?.focusable) return n;
    for (const c of n.children) {
      if (c.isWindow) continue;
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  })(wnd._reactX11Node);
  assert.ok(track, 'slider track is focusable');

  const { x, y, width, height } = track.abs;
  const cy = y + height / 2;
  const THUMB = 16;
  const travel = width - THUMB; // thumb is centred on the value
  const atFraction = (f) => x + THUMB / 2 + travel * f;

  // A drag's moves are *continuous* priority, so React renders them from a
  // scheduler task rather than from the microtask a discrete press commits
  // in — one macrotask more than the press needs. It took two ticks here
  // before too; it only fit in one while the press's own commit was still
  // pending, leaving a scheduler task queued for the move to ride on.
  const dragged = async () => {
    await tick();
    await tick();
  };

  // press at the middle -> 50
  wnd.emit('mousedown', { x: atFraction(0.5), y: cy, keycode: 1 });
  await tick();
  assert.strictEqual(seen.at(-1), 50, 'press sets the value under the pointer');

  // drag while still inside
  wnd.emit('mousemove', { x: atFraction(0.25), y: cy });
  await dragged();
  assert.strictEqual(seen.at(-1), 25);

  // pointer leaves the widget entirely (far below and to the right).
  // without pointer capture this would dispatch to whatever is under the
  // pointer and the slider would stop following.
  wnd.emit('mousemove', { x: atFraction(0.9), y: cy + 400 });
  await dragged();
  assert.strictEqual(seen.at(-1), 90, 'still tracking outside the widget');

  // and clamps past the ends
  wnd.emit('mousemove', { x: x - 500, y: cy });
  await dragged();
  assert.strictEqual(seen.at(-1), 0, 'clamps at min');

  // release out of bounds ends the drag; later moves are ignored
  wnd.emit('mouseup', { x: x - 500, y: cy, keycode: 1 });
  await tick();
  const afterRelease = seen.at(-1);
  wnd.emit('mousemove', { x: atFraction(0.75), y: cy });
  await tick();
  assert.strictEqual(seen.at(-1), afterRelease, 'no tracking after release');

  await x11Root.unmount();
});

test('Slider: keyboard steps, Home/End and PageUp/Down', async () => {
  const { Slider } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  let current = 50;
  const Host = () => {
    const [v, setV] = React.useState(50);
    current = v;
    return React.createElement(
      'window',
      { width: 300, height: 100 },
      React.createElement(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        React.createElement(Slider, {
          value: v,
          min: 0,
          max: 100,
          step: 2,
          onChange: (ev) => setV(ev.value),
          style: { width: 200 },
        }),
      ),
    );
  };
  x11Root.render(React.createElement(Host));
  await tick();

  const wnd = app.windows[0];
  const track = (function find(n) {
    if (n.props?.focusable) return n;
    for (const c of n.children) {
      if (c.isWindow) continue;
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  })(wnd._reactX11Node);

  // focus it without changing the value: click, then reset
  wnd.emit('mousedown', { x: track.abs.x, y: track.abs.y + 8, keycode: 1 });
  wnd.emit('mouseup', { x: track.abs.x, y: track.abs.y + 8, keycode: 1 });
  await tick();

  const press = async (keysym) => {
    pressKey(app, wnd, { keysym });
    await tick();
  };

  await press(0xff53); // Right
  const afterRight = current;
  await press(0xff51); // Left
  assert.strictEqual(current, afterRight - 2, 'arrows move by step');

  await press(0xff57); // End
  assert.strictEqual(current, 100);
  await press(0xff50); // Home
  assert.strictEqual(current, 0);

  await press(0xff55); // PageUp -> ten steps
  assert.strictEqual(current, 20);
  await press(0xff56); // PageDown
  assert.strictEqual(current, 0);

  await x11Root.unmount();
});

test('Slider: thumb stays within the track at both extremes', async () => {
  const { Slider } = await import('../src/index.js');
  const findTrack = (n) =>
    n.props?.focusable
      ? n
      : n.children.reduce(
          (a, c) => a || (c.isWindow ? null : findTrack(c)),
          null,
        );

  for (const [value, expected] of [
    [0, 'flush left'],
    [50, 'centred'],
    [100, 'flush right'],
  ]) {
    const app = createMockApp();
    const x11Root = await createRoot({ app });
    x11Root.render(
      React.createElement(
        'window',
        { width: 400, height: 100 },
        React.createElement(
          'box',
          { style: { flexGrow: 1, padding: 20 } },
          React.createElement(Slider, {
            value,
            min: 0,
            max: 100,
            style: { width: 200 },
          }),
        ),
      ),
    );
    await tick();
    const track = findTrack(app.windows[0]._reactX11Node);
    const thumb = track.children.find((c) => c.style.position === 'absolute');
    assert.ok(
      thumb.abs.x >= track.abs.x - 0.5,
      `${expected}: thumb past the left edge at ${value}`,
    );
    assert.ok(
      thumb.abs.x + thumb.abs.width <= track.abs.x + track.abs.width + 0.5,
      `${expected}: thumb past the right edge at ${value}`,
    );
    if (value === 50) {
      const thumbMid = thumb.abs.x + thumb.abs.width / 2;
      const trackMid = track.abs.x + track.abs.width / 2;
      assert.ok(
        Math.abs(thumbMid - trackMid) < 1,
        'midpoint value centres the thumb',
      );
    }
    await x11Root.unmount();
  }
});

test('anchorRect places, flips at a screen edge and clamps', async () => {
  const { anchorRect } = await import('../src/index.js');
  const { setScreensForTests } = await import('../src/screens.js');
  // a stand-in node: laid-out rect, owner window position, and the monitor
  // it is on — which is what placement flips and clamps against
  // (`anchorArea`), the same answer an auto-sized window is capped by
  const node = (abs, win = { x: 100, y: 50 }, screen = [1000, 800]) => {
    const app = {};
    setScreensForTests(app, {
      monitors: [{ x: 0, y: 0, width: screen[0], height: screen[1] }],
    });
    return { abs, root: { window: win }, app };
  };

  // default: below the anchor, left edges aligned, in screen coordinates
  const below = anchorRect(node({ x: 10, y: 20, width: 160, height: 30 }), {
    height: 100,
  });
  assert.deepStrictEqual(
    [below.x, below.y, below.placement],
    [110, 102, 'bottom'],
    'win.x + abs.x, and win.y + abs.y + height + offset',
  );

  // no room below -> flips above the anchor
  const flipped = anchorRect(node({ x: 10, y: 700, width: 160, height: 30 }), {
    height: 100,
  });
  assert.strictEqual(flipped.placement, 'top');
  assert.strictEqual(flipped.y, 50 + 700 - 100 - 2, 'sits above the anchor');

  // ... but only if there is room above; otherwise it stays below
  const noRoomEither = anchorRect(
    node({ x: 10, y: 10, width: 160, height: 30 }, { x: 0, y: 0 }, [1000, 60]),
    { height: 100 },
  );
  assert.strictEqual(noRoomEither.placement, 'bottom');

  // centre alignment and right-edge clamping
  const centred = anchorRect(node({ x: 10, y: 20, width: 100, height: 30 }), {
    width: 40,
    height: 10,
    align: 'center',
  });
  assert.strictEqual(centred.x, 100 + 10 + (100 - 40) / 2);

  const clamped = anchorRect(node({ x: 850, y: 20, width: 100, height: 30 }), {
    width: 300,
    height: 10,
  });
  assert.strictEqual(clamped.x, 1000 - 300, 'clamped to the right edge');

  // side placement flips when it would overflow
  const right = anchorRect(node({ x: 10, y: 20, width: 100, height: 30 }), {
    placement: 'right',
    width: 80,
    height: 40,
  });
  assert.deepStrictEqual(
    [right.placement, right.x],
    ['right', 100 + 10 + 100 + 2],
  );

  const flipsLeft = anchorRect(
    node({ x: 800, y: 20, width: 100, height: 30 }),
    {
      placement: 'right',
      width: 300,
      height: 40,
    },
  );
  assert.strictEqual(flipsLeft.placement, 'left');

  // `alignTo` splits the axes: the placement edge from the node, the
  // alignment from another. This is a submenu — it belongs against the
  // *menu's* right edge, but lined up with the row that opened it, and the
  // row is inset by the menu's border and padding.
  const menu = { x: 0, y: 0, width: 140, height: 200 };
  const row = { abs: { x: 5, y: 60, width: 130, height: 26 } };
  const split = anchorRect(node(menu), {
    placement: 'right',
    align: 'start',
    offset: 0,
    alignTo: row,
    width: 120,
    height: 80,
  });
  assert.strictEqual(
    split.x,
    100 + 0 + 140,
    'flush with the menu edge, not five pixels inside it',
  );
  assert.strictEqual(split.y, 50 + 60, 'but level with the row');

  // and without it the row would have decided both, which is the overlap
  const overlapping = anchorRect(node(row.abs), {
    placement: 'right',
    offset: 0,
    width: 120,
    height: 80,
  });
  assert.strictEqual(
    overlapping.x,
    split.x - 5,
    'the inset the fix removes, stated as the amount it used to overlap',
  );

  // no screen geometry (headless mock): still places, just never clamps
  const noScreen = anchorRect({
    abs: { x: 5, y: 5, width: 50, height: 20 },
    root: { window: { x: 0, y: 0 } },
    app: {},
  });
  assert.deepStrictEqual([noScreen.x, noScreen.y], [5, 27]);

  assert.strictEqual(anchorRect(null), null, 'no node -> no rect');
});

test('window focus: the focused node keeps focus but stops looking active', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const events = [];
  x11Root.render(
    React.createElement(
      'window',
      {
        width: 200,
        height: 100,
        onFocus: () => events.push('window:focus'),
        onBlur: () => events.push('window:blur'),
      },
      React.createElement('textinput', {
        defaultValue: 'hi',
        style: { width: 120, height: 24 },
      }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const input = wnd._reactX11Node.children[0];

  input.focus();
  assert.strictEqual(input.focused, true, 'node focused');
  assert.ok(input._blinkTimer, 'caret blinking');

  // the window manager gives the keyboard to someone else
  wnd.emit('blur', {});
  await tick();
  assert.strictEqual(
    input.focused,
    true,
    'the node keeps focus, as in the DOM',
  );
  assert.strictEqual(input._blinkTimer, null, 'but the caret stops blinking');
  assert.deepStrictEqual(events, ['window:blur']);

  wnd.emit('focus', {});
  await tick();
  assert.ok(
    input._blinkTimer,
    'caret resumes when the window is focused again',
  );
  assert.deepStrictEqual(events, ['window:blur', 'window:focus']);

  await x11Root.unmount();
});

test('focus(): ref API, autoFocus, and blur', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const seen = [];
  const ref = React.createRef();
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 100 },
      React.createElement('box', {
        ref,
        focusable: true,
        onFocus: () => seen.push('a:focus'),
        onBlur: () => seen.push('a:blur'),
        style: { width: 40, height: 20 },
      }),
      React.createElement('box', {
        focusable: true,
        autoFocus: true,
        onFocus: () => seen.push('b:focus'),
        style: { width: 40, height: 20 },
      }),
    ),
  );
  await tick();

  assert.deepStrictEqual(seen, ['b:focus'], 'autoFocus took it at mount');

  ref.current.focus();
  assert.deepStrictEqual(seen, ['b:focus', 'a:focus']);
  assert.strictEqual(ref.current.focused, true);

  ref.current.blur();
  assert.strictEqual(ref.current.focused, false);
  assert.deepStrictEqual(seen, ['b:focus', 'a:focus', 'a:blur']);

  await x11Root.unmount();
});

test('Tab into a scroll box scrolls the focused node into view', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 100 },
      React.createElement(
        'box',
        { style: { overflow: 'scroll', flexGrow: 1 } },
        ...Array.from({ length: 12 }, (_, i) =>
          React.createElement('box', {
            key: i,
            focusable: true,
            style: { height: 30, flexShrink: 0 },
          }),
        ),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const scroll = wnd._reactX11Node.children[0];
  const last = scroll.children[scroll.children.length - 1];

  assert.strictEqual(scroll.scrollY, 0, 'starts at the top');
  last.focus();
  await tick();
  await tick();
  assert.ok(scroll.scrollY > 0, `scrolled to reveal it (${scroll.scrollY})`);

  await x11Root.unmount();
});

test('tabIndex orders Tab traversal; -1 focuses but never tabs', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const box = (tabIndex, extra) =>
    React.createElement('box', {
      key: String(tabIndex),
      focusable: true,
      ...(tabIndex == null ? {} : { tabIndex }),
      ...extra,
      style: { width: 100, height: 20 },
    });
  const refs = { plain: null, two: null, one: null, skip: null };
  x11Root.render(
    React.createElement(
      'window',
      { width: 200, height: 200 },
      box(null, { ref: (n) => (refs.plain = n) }),
      box(2, { ref: (n) => (refs.two = n) }),
      box(1, { ref: (n) => (refs.one = n) }),
      box(-1, { ref: (n) => (refs.skip = n) }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const tab = () => pressKey(app, wnd, { keysym: XK.Tab });

  // positive tabIndex first in ascending order, then the implicit-zero group
  tab();
  assert.strictEqual(refs.one.focused, true, 'tabIndex 1 goes first');
  tab();
  assert.strictEqual(refs.two.focused, true, 'then tabIndex 2');
  tab();
  assert.strictEqual(refs.plain.focused, true, 'then the implicit-zero group');
  tab();
  assert.strictEqual(refs.one.focused, true, 'and it wraps around');

  // tabIndex={-1}: never reached by Tab, but focusable by press and focus()
  const skip = refs.skip;
  wnd.emit('mousedown', { x: 5, y: skip.abs.y + 5, keycode: 1 });
  wnd.emit('mouseup', { x: 5, y: skip.abs.y + 5, keycode: 1 });
  assert.strictEqual(skip.focused, true, 'a press focuses tabIndex={-1}');
  tab();
  assert.strictEqual(
    refs.one.focused,
    true,
    'Tab out of it re-enters the tab order at the start',
  );
  skip.focus();
  assert.strictEqual(skip.focused, true, 'focus() works on it too');

  await x11Root.unmount();
});

test('<popup> shares the owner window focus, so keys reach into it', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const seen = [];
  let inner = null;
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 200, onKeyDown: () => seen.push('window') },
      React.createElement(
        'popup',
        { x: 40, y: 40, width: 120, height: 40 },
        React.createElement('box', {
          ref: (n) => (inner = n),
          focusable: true,
          autoFocus: true,
          onKeyDown: () => seen.push('box'),
          style: { width: 100, height: 20 },
        }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const popup = app.windows[1];

  assert.ok(
    popup.attributes.overrideRedirect,
    'the popup is override-redirect',
  );
  assert.strictEqual(inner.focused, true, 'a node inside the popup has focus');
  assert.strictEqual(
    wnd._reactX11Node.events.focused,
    inner,
    'focus is held by the owner window, which is what the X server keys',
  );
  assert.strictEqual(inner.focusWithin, true, 'focusWithin on the node itself');
  assert.strictEqual(
    wnd._reactX11Node.focusWithin,
    true,
    'and on the owner window, reaching through the popup',
  );

  // the key arrives at the owner window (the popup never gets the X focus)
  // and is dispatched to the popup node, bubbling out into the owner tree
  pressKey(app, wnd, { codepoint: 0x78 });
  assert.deepStrictEqual(seen, ['box', 'window']);

  await x11Root.unmount();
});

test('<popup trapFocus> traps Tab and restores focus when it closes', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const refs = { trigger: null, other: null, first: null, second: null };
  const App = ({ open }) =>
    React.createElement(
      'window',
      { width: 300, height: 200 },
      React.createElement('box', {
        ref: (n) => (refs.trigger = n),
        focusable: true,
        style: { width: 100, height: 20 },
      }),
      React.createElement('box', {
        ref: (n) => (refs.other = n),
        focusable: true,
        style: { width: 100, height: 20 },
      }),
      open &&
        React.createElement(
          'popup',
          { x: 40, y: 60, width: 140, height: 60, trapFocus: true },
          React.createElement('box', {
            ref: (n) => (refs.first = n),
            focusable: true,
            autoFocus: true,
            style: { width: 120, height: 20 },
          }),
          React.createElement('box', {
            ref: (n) => (refs.second = n),
            focusable: true,
            style: { width: 120, height: 20 },
          }),
        ),
    );

  x11Root.render(React.createElement(App, { open: false }));
  await tick();
  const wnd = app.windows[0];
  refs.trigger.focus();
  assert.strictEqual(refs.trigger.focused, true, 'the trigger has focus');

  x11Root.render(React.createElement(App, { open: true }));
  await tick();
  assert.strictEqual(refs.first.focused, true, 'the modal took focus');

  const tab = () => pressKey(app, wnd, { keysym: XK.Tab });
  tab();
  assert.strictEqual(refs.second.focused, true, 'Tab moves within the modal');
  tab();
  assert.strictEqual(
    refs.first.focused,
    true,
    'and wraps inside it — the trigger is never reached',
  );

  // a press on the window behind the modal does not steal focus
  const y = refs.trigger.abs.y + 5;
  wnd.emit('mousedown', { x: 5, y, keycode: 1 });
  wnd.emit('mouseup', { x: 5, y, keycode: 1 });
  assert.strictEqual(refs.trigger.focused, false, 'the press was inert');
  assert.strictEqual(refs.first.focused, true, 'focus stayed in the modal');

  x11Root.render(React.createElement(App, { open: false }));
  await tick();
  assert.strictEqual(
    refs.trigger.focused,
    true,
    'closing the modal handed focus back to the trigger',
  );

  await x11Root.unmount();
});

test('Dialog: modal popup, Escape closes it, focus goes back', async () => {
  const { Dialog, Button } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const closed = [];
  let trigger = null;
  let input = null;
  const App = ({ open }) =>
    React.createElement(
      'window',
      { width: 400, height: 300 },
      React.createElement(Button, {
        ref: (n) => (trigger = n),
        label: 'Open',
        onPress: () => {},
      }),
      React.createElement(
        Dialog,
        {
          open,
          title: 'Really?',
          onClose: () => closed.push('close'),
          actions: React.createElement(Button, { label: 'OK' }),
        },
        React.createElement('textinput', {
          ref: (n) => (input = n),
          autoFocus: true,
        }),
      ),
    );

  x11Root.render(React.createElement(App, { open: false }));
  await tick();
  const wnd = app.windows[0];
  assert.strictEqual(app.windows.length, 1, 'no popup while closed');
  trigger.focus();

  x11Root.render(React.createElement(App, { open: true }));
  await tick();
  const dialog = app.windows[1];
  assert.ok(dialog, 'the dialog is a popup window');
  // issue #130: a dialog is a *managed* window, so the WM frames it, keeps it
  // out of the taskbar and lets the user move it — and a client pointer grab
  // over a window the WM is trying to drag is a fight nobody wins
  assert.strictEqual(dialog.attributes.overrideRedirect, false);
  assert.strictEqual(dialog.attributes.windowType, 'dialog');
  assert.strictEqual(dialog.attributes.grab, false);
  assert.strictEqual(
    'transientFor' in dialog.attributes,
    false,
    'the ref is resolved in the commit phase, never handed to ntk',
  );
  // ntk's Window constructor registers any `onKeyDown`/`onFocus`/… it finds
  // in its creation args as a raw listener (events_map.toSnake). A handler
  // that got there would be called a second time with the native X event —
  // no preventDefault, no target — so no event prop may reach the
  // attributes, on creation or on the pre-realize update path.
  assert.deepStrictEqual(
    Object.keys(dialog.attributes).filter((k) => /^on[A-Z]/.test(k)),
    [],
    'event props are dispatched by the EventManager, never by ntk',
  );
  assert.strictEqual(input.focused, true, 'autoFocus inside the dialog won');

  // Escape reaches the dialog by bubbling out of the focused node
  pressKey(app, wnd, { keysym: 0xff1b });
  await tick();
  assert.deepStrictEqual(closed, ['close'], 'Escape asked to close');

  x11Root.render(React.createElement(App, { open: false }));
  await tick();
  assert.strictEqual(dialog.destroyed, true, 'popup gone');
  assert.strictEqual(
    trigger.focused,
    true,
    'and focus returned to what opened it',
  );

  await x11Root.unmount();
});

test('Dialog: with nothing to autoFocus, the surface takes focus', async () => {
  const { Dialog } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 400, height: 300 },
      React.createElement(
        Dialog,
        { open: true, title: 'Note' },
        'Nothing focusable in here.',
      ),
    ),
  );
  await tick();
  const dialog = app.windows[1];
  const surface = dialog._reactX11Node.children[0];

  assert.strictEqual(
    surface.focused,
    true,
    'the dialog surface holds focus so keys have a target',
  );
  assert.strictEqual(
    surface.props.tabIndex,
    -1,
    'but it is not a stop in the tab order',
  );

  await x11Root.unmount();
});

test('context menu: a press outside — the window frame — dismisses it', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const picked = [];
  await openNested(x11Root, picked);
  const menu = app.windows[1];

  // the root level asks for a pointer grab; that is what makes the press
  // below reach us at all instead of going to the window manager
  assert.strictEqual(menu.attributes.grab, true, 'root menu grabs the pointer');
  assert.ok(menu.grabbed, 'and the grab was taken');

  // a press on the title bar arrives here, outside our bounds
  menu.emit('mousedown', { x: -40, y: -12, keycode: 1 });
  await tick();
  await tick();
  assert.strictEqual(menu.destroyed, true, 'menu closed');
  assert.deepStrictEqual(picked, [], 'and nothing was selected');

  await x11Root.unmount();
});

test('a press inside the menu is a normal click, not a dismissal', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const picked = [];
  await openNested(x11Root, picked);
  const menu = app.windows[1];
  const row = rowsOf(app, 1)[0];

  menu.emit('mousedown', {
    x: row.abs.x + 4,
    y: row.abs.y + row.abs.height / 2,
    keycode: 1,
  });
  menu.emit('mouseup', {
    x: row.abs.x + 4,
    y: row.abs.y + row.abs.height / 2,
    keycode: 1,
  });
  await tick();
  await tick();
  assert.deepStrictEqual(picked, ['New'], 'the row was selected');

  await x11Root.unmount();
});

test('Slider keeps its width as the value changes (no drag feedback loop)', async () => {
  const { Slider } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  let setValue;
  const Host = () => {
    const [v, setV] = React.useState(0);
    setValue = setV;
    return React.createElement(
      'window',
      { width: 300, height: 80 },
      React.createElement(
        'box',
        {
          style: {
            flexDirection: 'row',
            alignItems: 'center',
            flexGrow: 1,
            gap: 10,
          },
        },
        React.createElement('box', { style: { width: 40, height: 10 } }),
        React.createElement(Slider, {
          min: 0,
          max: 100,
          value: v,
          onChange: (ev) => setV(ev.value),
          style: { flexGrow: 1 },
        }),
      ),
    );
  };

  x11Root.render(React.createElement(Host));
  await tick();
  const row = app.windows[0]._reactX11Node.children[0];
  const slider = row.children[1];
  const widths = [];
  for (const value of [0, 25, 50, 75, 100]) {
    setValue(value);
    await tick();
    await tick();
    widths.push(slider.abs.width);
  }

  // the fill used to be a percentage width, which fed back into the
  // control's own intrinsic width: at the maximum it grew, the handle
  // moved with it, and a drag oscillated between the two layouts
  assert.strictEqual(
    new Set(widths).size,
    1,
    `width is stable across the range, got ${widths.join(', ')}`,
  );

  await x11Root.unmount();
});

test('ProgressBar does not widen the box it sits in', async () => {
  const { ProgressBar } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const Card = ({ progress }) =>
    React.createElement(
      'box',
      { style: { flexGrow: 1, padding: 10 } },
      React.createElement(ProgressBar, { value: progress }),
    );

  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 120 },
      React.createElement(
        'box',
        { style: { flexDirection: 'row', flexGrow: 1, gap: 10 } },
        React.createElement(Card, { key: 'a', progress: 0.1 }),
        React.createElement(Card, { key: 'b', progress: 0.9 }),
      ),
    ),
  );
  await tick();

  const row = app.windows[0]._reactX11Node.children[0];
  const [low, high] = row.children;
  // a fuller bar used to make its card wider — the percentage width fed
  // back into the intrinsic size — and the row overflowed the window
  assert.strictEqual(low.abs.width, high.abs.width, 'cards are equal width');
  assert.ok(
    high.abs.x + high.abs.width <= 300,
    `the row fits the window (right edge ${high.abs.x + high.abs.width})`,
  );

  // and the fill still tracks the value
  const fill = high.children[0].children[0];
  const track = high.children[0];
  assert.ok(
    Math.abs(fill.abs.width / track.abs.width - 0.9) < 0.02,
    `fill is 90% of the track, got ${fill.abs.width}/${track.abs.width}`,
  );

  await x11Root.unmount();
});

test('Tooltip shows after the delay in a popup and hides on leave', async () => {
  const { Tooltip, Button } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 120 },
      React.createElement(
        'box',
        { style: { flexGrow: 1, padding: 20 } },
        React.createElement(
          Tooltip,
          { label: 'Save the file', delay: 20 },
          React.createElement(Button, { onPress: () => {} }, 'Save'),
        ),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const wrapper = wnd._reactX11Node.children[0].children[0];
  const { x, y, width, height } = wrapper.abs;
  const cx = x + width / 2;
  const cy = y + height / 2;

  assert.strictEqual(app.windows.length, 1, 'no popup before hovering');

  wnd.emit('mousemove', { x: cx, y: cy });
  await tick();
  assert.strictEqual(app.windows.length, 1, 'nothing shows before the delay');

  await new Promise((r) => setTimeout(r, 60));
  await tick();
  assert.strictEqual(app.windows.length, 2, 'popup appears after the delay');
  const tip = app.windows[1];
  assert.strictEqual(tip.attributes.overrideRedirect, true);
  assert.strictEqual(tip.attributes.windowType, 'tooltip');
  assert.ok(tip.attributes.width > 0 && tip.attributes.height > 0);

  // leaving hides it
  wnd.emit('mousemove', { x: 0, y: 0 });
  // mousemove runs at ContinuousEventPriority, so React schedules the
  // update rather than flushing it synchronously the way keydown does
  await tick();
  await tick();
  assert.strictEqual(tip.destroyed, true, 'popup destroyed on mouse leave');

  await x11Root.unmount();
});

test('Tooltip stays up when the pointer moves toward it, and is reachable', async () => {
  const { Tooltip, Button } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 160 },
      React.createElement(
        'box',
        { style: { flexGrow: 1, padding: 20 } },
        React.createElement(
          Tooltip,
          { label: 'Save the file', delay: 20 },
          React.createElement(Button, { onPress: () => {} }, 'Save'),
        ),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const wrapper = wnd._reactX11Node.children[0].children[0];
  const { x, y, width, height } = wrapper.abs;
  const cx = x + width / 2;
  const cy = y + height / 2;

  wnd.emit('mousemove', { x: cx, y: cy, rootx: cx, rooty: cy });
  await new Promise((r) => setTimeout(r, 60));
  await tick();
  assert.strictEqual(app.windows.length, 2, 'tooltip shown');
  const tip = app.windows[1];

  // leaving the trigger straight at the tooltip keeps it up. The tooltip
  // flips below the trigger here (it is near the top of the window), so
  // "toward it" is the gap just above its top edge.
  const rect = tip.attributes;
  const near =
    rect.y > cy ? { toward: rect.y - 2 } : { toward: rect.y + rect.height + 2 };
  wnd.emit('mousemove', {
    x: 0,
    y: 0,
    rootx: rect.x + rect.width / 2,
    rooty: near.toward,
  });
  await tick();
  await tick();
  assert.strictEqual(tip.destroyed, false, 'still up while heading for it');

  // and the pointer reaching it keeps it up for as long as it stays
  const content = tip._reactX11Node.children[0];
  tip.emit('mousemove', {
    x: content.abs.x + 2,
    y: content.abs.y + 2,
  });
  await new Promise((r) => setTimeout(r, 400));
  await tick();
  assert.strictEqual(tip.destroyed, false, 'hovering the tooltip holds it');

  // leaving the tooltip dismisses it
  tip.emit('mousemove', { x: -20, y: -20 });
  await tick();
  await tick();
  assert.strictEqual(tip.destroyed, true, 'gone once the pointer leaves');

  await x11Root.unmount();
});

test('Tooltip does not show if the pointer leaves before the delay', async () => {
  const { Tooltip, Button } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 120 },
      React.createElement(
        'box',
        { style: { flexGrow: 1, padding: 20 } },
        React.createElement(
          Tooltip,
          { label: 'Never seen', delay: 50 },
          React.createElement(Button, { onPress: () => {} }, 'Save'),
        ),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const wrapper = wnd._reactX11Node.children[0].children[0];

  wnd.emit('mousemove', {
    x: wrapper.abs.x + 2,
    y: wrapper.abs.y + wrapper.abs.height / 2,
  });
  await tick();
  wnd.emit('mousemove', { x: 0, y: 0 }); // leave well before the delay
  await tick();

  await new Promise((r) => setTimeout(r, 90));
  await tick();
  assert.strictEqual(app.windows.length, 1, 'the pending timer was cancelled');

  await x11Root.unmount();
});

const MENU_ITEMS = (picked) => [
  {
    label: 'Cut',
    shortcut: [['Control', 'X']],
    onSelect: () => picked.push('Cut'),
  },
  { label: 'Copy', onSelect: () => picked.push('Copy') },
  { type: 'separator' },
  { label: 'Paste', enabled: false, onSelect: () => picked.push('Paste') },
  { label: 'Delete', onSelect: () => picked.push('Delete') },
];

/** Index of the highlighted row inside the newest popup. */
function activeMenuIndex(app) {
  const popup = app.windows.at(-1);
  const rows = popup._reactX11Node.children[0].children;
  return rows.findIndex((r) => r.style.backgroundColor === '#2980b9');
}

test('ContextMenu opens at the pointer and skips separators/disabled', async () => {
  const { ContextMenu } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const picked = [];
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 200 },
      React.createElement(
        ContextMenu,
        { items: MENU_ITEMS(picked), style: { flexGrow: 1 } },
        React.createElement('box', { style: { flexGrow: 1 } }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];

  assert.strictEqual(app.windows.length, 1, 'closed until right-click');

  // right-click (button 3) opens at the pointer, in screen coordinates
  wnd.emit('mousedown', {
    x: 40,
    y: 30,
    keycode: 3,
    rootx: 540,
    rooty: 430,
  });
  await tick();
  assert.strictEqual(app.windows.length, 2, 'menu opened');
  const menu = app.windows[1];
  assert.strictEqual(menu.attributes.overrideRedirect, true);
  assert.strictEqual(menu.attributes.windowType, 'popup_menu');
  assert.deepStrictEqual(
    [menu.attributes.x, menu.attributes.y],
    [540, 430],
    'anchored at the pointer in screen coordinates',
  );
  assert.strictEqual(activeMenuIndex(app), -1, 'nothing active until a key');

  // Down from nothing -> first selectable
  pressKey(app, wnd, { keysym: 0xff54 });
  await tick();
  assert.strictEqual(activeMenuIndex(app), 0, 'Cut');

  pressKey(app, wnd, { keysym: 0xff54 });
  await tick();
  assert.strictEqual(activeMenuIndex(app), 1, 'Copy');

  // next Down must skip the separator (2) AND the disabled Paste (3)
  pressKey(app, wnd, { keysym: 0xff54 });
  await tick();
  assert.strictEqual(
    activeMenuIndex(app),
    4,
    'Delete — separator and disabled skipped',
  );

  // wraps back to the first selectable
  pressKey(app, wnd, { keysym: 0xff54 });
  await tick();
  assert.strictEqual(activeMenuIndex(app), 0, 'wraps');

  // Up wraps the other way, also skipping
  pressKey(app, wnd, { keysym: 0xff52 });
  await tick();
  assert.strictEqual(activeMenuIndex(app), 4);

  // End / Home
  pressKey(app, wnd, { keysym: 0xff50 });
  await tick();
  assert.strictEqual(activeMenuIndex(app), 0, 'Home -> first selectable');

  // Enter activates
  pressKey(app, wnd, { keysym: XK.Return });
  await tick();
  assert.deepStrictEqual(picked, ['Cut']);
  assert.strictEqual(app.windows[1].destroyed, true, 'closes after selecting');

  await x11Root.unmount();
});

test('ContextMenu: Escape closes without selecting; disabled items are inert', async () => {
  const { ContextMenu } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const picked = [];
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 200 },
      React.createElement(
        ContextMenu,
        { items: MENU_ITEMS(picked), style: { flexGrow: 1 } },
        React.createElement('box', { style: { flexGrow: 1 } }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];

  wnd.emit('mousedown', { x: 10, y: 10, keycode: 3, rootx: 100, rooty: 100 });
  await tick();
  await tick(); // the popup lays out a tick after creation
  const menu = app.windows[1];

  const rows = menu._reactX11Node.children[0].children;
  assert.ok(rows[0].abs.width > 0, 'rows are laid out — clicks below are real');

  const clickRow = (row) => {
    const x = row.abs.x + 5;
    const y = row.abs.y + row.abs.height / 2;
    menu.emit('mousedown', { x, y, keycode: 1 });
    menu.emit('mouseup', { x, y, keycode: 1 });
  };

  // clicking the disabled row does nothing
  const paste = rows[3];
  clickRow(paste);
  await tick();
  assert.deepStrictEqual(picked, [], 'disabled item is inert');
  assert.strictEqual(menu.destroyed, false, 'and does not close the menu');

  pressKey(app, wnd, { keysym: 0xff1b }); // Escape
  await tick();
  assert.strictEqual(menu.destroyed, true);
  assert.deepStrictEqual(picked, []);

  await x11Root.unmount();
});

test('ContextMenu: clicking an enabled row selects it and closes', async () => {
  const { ContextMenu } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const picked = [];
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 200 },
      React.createElement(
        ContextMenu,
        { items: MENU_ITEMS(picked), style: { flexGrow: 1 } },
        React.createElement('box', { style: { flexGrow: 1 } }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  wnd.emit('mousedown', { x: 10, y: 10, keycode: 3, rootx: 100, rooty: 100 });
  await tick();
  await tick(); // the popup lays out a tick after creation

  const menu = app.windows[1];
  const copy = menu._reactX11Node.children[0].children[1];
  assert.ok(copy.abs.width > 0, 'row is laid out');
  const x = copy.abs.x + 5;
  const y = copy.abs.y + copy.abs.height / 2;
  menu.emit('mousedown', { x, y, keycode: 1 });
  menu.emit('mouseup', { x, y, keycode: 1 });
  await tick();

  assert.deepStrictEqual(picked, ['Copy']);
  assert.strictEqual(menu.destroyed, true, 'closes after selecting');

  await x11Root.unmount();
});

test('MenuBar opens menus, switches on hover and walks with Left/Right', async () => {
  const { MenuBar } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const picked = [];
  const menus = [
    {
      label: 'File',
      items: [
        { label: 'New', onSelect: () => picked.push('New') },
        { label: 'Open', onSelect: () => picked.push('Open') },
      ],
    },
    {
      label: 'Edit',
      items: [{ label: 'Undo', onSelect: () => picked.push('Undo') }],
    },
  ];
  x11Root.render(
    React.createElement(
      'window',
      { width: 320, height: 200 },
      // the drawn bar is what this asserts on: on a machine running a panel
      // that shows application menus, the real `MenuBar` correctly draws
      // nothing at all. See test/globalmenu.test.js for that half.
      React.createElement(MenuBar, { menus, globalMenu: false }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const bar = wnd._reactX11Node.children[0];
  const [fileBtn, editBtn] = bar.children.filter((c) => c.props.focusable);

  const clickNode = (node) => {
    const x = node.abs.x + node.abs.width / 2;
    const y = node.abs.y + node.abs.height / 2;
    wnd.emit('mousedown', { x, y, keycode: 1 });
    wnd.emit('mouseup', { x, y, keycode: 1 });
  };

  clickNode(fileBtn);
  await tick();
  assert.strictEqual(app.windows.length, 2, 'File menu opened');
  const fileMenu = app.windows[1];
  // anchored below the button, in screen coordinates
  assert.strictEqual(
    fileMenu.attributes.y,
    fileBtn.abs.y + fileBtn.abs.height + 2,
  );

  // hovering Edit while File is open switches menus. The <popup> keeps its
  // place in the tree, so React reuses the same X window and moves it —
  // no destroy/recreate flicker between menus.
  wnd.emit('mousemove', {
    x: editBtn.abs.x + editBtn.abs.width / 2,
    y: editBtn.abs.y + editBtn.abs.height / 2,
  });
  await tick();
  await tick(); // mousemove is continuous priority
  assert.strictEqual(app.windows.length, 2, 'window reused, not recreated');
  assert.strictEqual(fileMenu.destroyed, false);
  assert.strictEqual(fileMenu.x, editBtn.abs.x, 'moved under Edit');

  // Left walks back to File
  pressKey(app, wnd, { keysym: 0xff51 });
  await tick();
  assert.strictEqual(fileMenu.x, fileBtn.abs.x, 'moved back under File');

  // Down then Enter picks the first item of the File menu
  pressKey(app, wnd, { keysym: 0xff54 });
  await tick();
  pressKey(app, wnd, { keysym: XK.Return });
  await tick();
  assert.deepStrictEqual(picked, ['New']);
  assert.strictEqual(fileMenu.destroyed, true, 'closes after selecting');

  await x11Root.unmount();
});

// An open bar menu holds a pointer grab, so a menu nobody can dismiss is
// worse than one that never opened. Both ways out — Escape, and clicking
// away — run through the *focused node*, so what is really under test is
// that opening a menu puts focus somewhere the menu can hear from, rather
// than leaving it wherever the gesture that opened it happened to land.
test('MenuBar: an open menu is always dismissible', async () => {
  const { MenuBar } = await import('../src/index.js');
  const menus = [
    { label: 'File', items: [{ label: 'New' }, { label: 'Open' }] },
    { label: 'Edit', items: [{ label: 'Undo' }] },
  ];

  const mount = async () => {
    const app = createMockApp();
    const x11Root = await createRoot({ app });
    x11Root.render(
      React.createElement(
        'window',
        { width: 320, height: 200 },
        React.createElement(
          'box',
          { style: { flexGrow: 1 } },
          React.createElement(MenuBar, { menus, globalMenu: false }),
          React.createElement('box', { style: { flexGrow: 1 } }),
        ),
      ),
    );
    await tick();
    const wnd = app.windows[0];
    const bar = wnd._reactX11Node.children[0].children[0];
    const buttons = bar.children.filter((c) => c.props.focusable);
    return { app, x11Root, wnd, buttons };
  };

  const openFile = (wnd, node) => {
    const x = node.abs.x + node.abs.width / 2;
    const y = node.abs.y + node.abs.height / 2;
    wnd.emit('mousedown', { x, y, keycode: 1 });
    wnd.emit('mouseup', { x, y, keycode: 1 });
  };

  // opening focuses the item the menu belongs to, deliberately — that is
  // the thread both dismissals hang off
  {
    const { x11Root, wnd, buttons } = await mount();
    openFile(wnd, buttons[0]);
    await tick();
    assert.strictEqual(app0Windows(wnd), 2, 'menu open');
    // `assert.ok` on the comparison, never `strictEqual` on two nodes: a
    // failing diff walks the whole retained tree and reports no test name
    assert.ok(
      wnd._reactX11Node.events.focused === buttons[0],
      'the bar item holds focus while its menu is up',
    );
    await x11Root.unmount();
  }

  // Escape
  {
    const { app, x11Root, wnd, buttons } = await mount();
    openFile(wnd, buttons[0]);
    await tick();
    pressKey(app, wnd, { keysym: 0xff1b });
    await tick();
    assert.strictEqual(app.windows[1].destroyed, true, 'Escape closes it');
    await x11Root.unmount();
  }

  // Escape while focus sits on a *different* item of the bar
  {
    const { app, x11Root, wnd, buttons } = await mount();
    openFile(wnd, buttons[0]);
    await tick();
    wnd._reactX11Node.events.focus(buttons[1], 'script');
    await tick();
    pressKey(app, wnd, { keysym: 0xff1b });
    await tick();
    assert.strictEqual(
      app.windows[1].destroyed,
      true,
      'Escape is not fussy about which item of the bar heard it',
    );
    await x11Root.unmount();
  }

  // the window losing the window manager's focus — alt-tab, a click in
  // another application. Nothing in the tree hears that on its own: the bar
  // item keeps the focus it took (a window blur leaves the focused node
  // focused and merely stops it looking active), so without
  // `useDismissOnWindowBlur` the menu stays up over an app the user has
  // switched away from, still holding its pointer grab.
  {
    const { app, x11Root, wnd, buttons } = await mount();
    openFile(wnd, buttons[0]);
    await tick();
    wnd.emit('blur', {});
    await tick();
    await tick();
    assert.strictEqual(
      app.windows[1].destroyed,
      true,
      'switching away closes it',
    );
    assert.ok(
      wnd._reactX11Node.events.focused === buttons[0],
      'and the bar item still holds focus, as a blurred window leaves it',
    );
    await x11Root.unmount();
  }

  // a press somewhere else in the window
  {
    const { app, x11Root, wnd, buttons } = await mount();
    openFile(wnd, buttons[0]);
    await tick();
    wnd.emit('mousedown', { x: 160, y: 170, keycode: 1 });
    wnd.emit('mouseup', { x: 160, y: 170, keycode: 1 });
    await tick();
    assert.strictEqual(
      app.windows[1].destroyed,
      true,
      'a press in the content closes it',
    );
    await x11Root.unmount();
  }

  // ...and the same, for a menu reached by sliding along the bar rather
  // than by pressing. This is the case the press cannot carry: hovering
  // does not move focus, so unless opening takes focus itself, the item now
  // showing a menu has none — and the press that dismisses it blurs the
  // wrong item, leaving the menu up with a pointer grab held.
  {
    const { app, x11Root, wnd, buttons } = await mount();
    openFile(wnd, buttons[0]);
    await tick();
    wnd.emit('mousemove', {
      x: buttons[1].abs.x + buttons[1].abs.width / 2,
      y: buttons[1].abs.y + buttons[1].abs.height / 2,
    });
    await tick();
    await tick(); // mousemove is continuous priority
    assert.ok(
      wnd._reactX11Node.events.focused === buttons[1],
      'sliding onto Edit hands it the focus with the menu',
    );
    wnd.emit('mousedown', { x: 160, y: 170, keycode: 1 });
    wnd.emit('mouseup', { x: 160, y: 170, keycode: 1 });
    await tick();
    assert.strictEqual(
      app.windows[1].destroyed,
      true,
      'so a press in the content still gets rid of it',
    );
    await x11Root.unmount();
  }

  // Taking focus must not also light a ring. A menu opened with the pointer
  // is already pointing at the item it came out of, so the ring is exactly
  // the noise `:focus-visible` exists to remove; a menu reached with the
  // arrow keys is the case that needs it.
  {
    const { x11Root, wnd, buttons } = await mount();
    openFile(wnd, buttons[0]);
    await tick();
    assert.strictEqual(
      buttons[0].states[':focus'],
      true,
      'focused, which is what makes it dismissible',
    );
    assert.strictEqual(
      buttons[0].states[':focus-visible'],
      false,
      'but no ring: the open menu already says where you are',
    );

    // and the same when the pointer slides along the bar
    wnd.emit('mousemove', {
      x: buttons[1].abs.x + buttons[1].abs.width / 2,
      y: buttons[1].abs.y + buttons[1].abs.height / 2,
    });
    await tick();
    await tick();
    assert.strictEqual(buttons[1].states[':focus-visible'], false, 'nor here');

    // Left walks the bar from the keyboard. That does count as keyboard
    // focus — but the item it lands on has opened its menu, and an item with
    // a menu hanging off it draws no ring: the menu already said it.
    pressKey(app0(wnd), wnd, { keysym: 0xff51 });
    await tick();
    assert.strictEqual(
      buttons[0].states[':focus-visible'],
      true,
      'the keyboard put focus here',
    );
    assert.strictEqual(
      buttons[0].style.outlineWidth,
      0,
      'and the open menu says so without one',
    );
    await x11Root.unmount();
  }

  // ...but an item that has only been *reached* has nothing else to show for
  // it, so it keeps the ring. This is the case the blanket opt-out would
  // lose, and it is the reader the ring exists for.
  {
    const { x11Root, wnd, buttons } = await mount();
    wnd._reactX11Node.events.focus(buttons[0], 'key');
    await tick();
    assert.strictEqual(
      buttons[0].states[':focus-visible'],
      true,
      'tabbed to, menu shut',
    );
    assert.notStrictEqual(
      buttons[0].style.outlineWidth,
      0,
      'nothing else marks where the keyboard is, so the ring stands',
    );
    await x11Root.unmount();
  }
});

const app0 = (wnd) => wnd._reactX11Node.app;

const app0Windows = (wnd) => wnd._reactX11Node.app.windows.length;

test('backgroundColor/borderColor "transparent" paints nothing (and does not throw)', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 100, height: 60 },
      React.createElement('box', {
        style: {
          flexGrow: 1,
          backgroundColor: 'transparent',
          borderWidth: 2,
          borderColor: 'transparent',
        },
      }),
      React.createElement('box', {
        style: { flexGrow: 1, backgroundColor: '#ff0000' },
      }),
    ),
  );
  await tick();
  const ops = app.windows[0].ctx.ops;
  // ntk's colour parser has no 'transparent' keyword and throws inside the
  // 2d context, which would take down the whole frame
  const fills = ops.filter(([op]) => op === 'fillRect').map((o) => o[5]);
  assert.ok(!fills.includes('transparent'), 'no transparent fill was issued');
  assert.ok(fills.includes('#ff0000'), 'real colours still paint');
  assert.ok(
    !ops.some(([op, style]) => op === 'stroke' && style === 'transparent'),
    'no transparent stroke was issued',
  );

  await x11Root.unmount();
});

const NESTED_ITEMS = (picked) => [
  { label: 'New', onSelect: () => picked.push('New') },
  {
    label: 'Export',
    items: [
      { label: 'PNG', onSelect: () => picked.push('PNG') },
      { type: 'separator' },
      { label: 'SVG', onSelect: () => picked.push('SVG') },
      { label: 'PDF', enabled: false },
    ],
  },
  { label: 'Quit', onSelect: () => picked.push('Quit') },
];

/** Rows of the popup at `index` among the app's windows. */
const rowsOf = (app, index) =>
  app.windows[index]._reactX11Node.children[0].children;
const activeIn = (app, index) =>
  rowsOf(app, index).findIndex((r) => r.style.backgroundColor === '#2980b9');
// A row whose submenu has taken the selection over is still the chosen one,
// but only the deepest open level wears the selection colour — the trail
// behind it goes quiet (`surfaceActive`).
const pathIn = (app, index) =>
  rowsOf(app, index).findIndex((r) => r.style.backgroundColor === '#e3e5ed');

async function openNested(x11Root, picked) {
  const { ContextMenu } = await import('../src/index.js');
  x11Root.render(
    React.createElement(
      'window',
      { width: 320, height: 220 },
      React.createElement(
        ContextMenu,
        { items: NESTED_ITEMS(picked), style: { flexGrow: 1 } },
        React.createElement('box', { style: { flexGrow: 1 } }),
      ),
    ),
  );
  await tick();
  const wnd = x11Root.app.windows[0];
  wnd.emit('mousedown', { x: 20, y: 20, keycode: 3, rootx: 200, rooty: 120 });
  // a popup lays out one tick after it is created: without this second
  // tick its rows still have zero rects and pointer assertions are vacuous
  await tick();
  await tick();
  return wnd;
}

test('submenu: Right opens it, Left leaves, Escape closes one level', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const picked = [];
  const wnd = await openNested(x11Root, picked);
  assert.strictEqual(app.windows.length, 2, 'root menu open');

  // move onto Export (index 1)
  pressKey(app, wnd, { keysym: 0xff54 }); // Down -> New
  await tick();
  pressKey(app, wnd, { keysym: 0xff54 }); // Down -> Export
  await tick();
  assert.strictEqual(activeIn(app, 1), 1, 'Export active');
  assert.strictEqual(app.windows.length, 2, 'not opened by arrowing alone');

  // Right enters the submenu, selecting its first selectable item
  pressKey(app, wnd, { keysym: 0xff53 });
  await tick();
  await tick();
  assert.strictEqual(app.windows.length, 3, 'submenu popup opened');
  assert.strictEqual(activeIn(app, 2), 0, 'PNG active');

  // Down inside the submenu skips the separator to SVG, and PDF is disabled
  pressKey(app, wnd, { keysym: 0xff54 });
  await tick();
  assert.strictEqual(activeIn(app, 2), 2, 'SVG (separator skipped)');
  pressKey(app, wnd, { keysym: 0xff54 });
  await tick();
  assert.strictEqual(
    activeIn(app, 2),
    0,
    'wraps past disabled PDF back to PNG',
  );

  // Left leaves the submenu without closing the root
  pressKey(app, wnd, { keysym: 0xff51 });
  await tick();
  await tick();
  assert.strictEqual(app.windows[2].destroyed, true, 'submenu closed');
  assert.strictEqual(app.windows[1].destroyed, false, 'root menu still open');
  assert.strictEqual(activeIn(app, 1), 1, 'Export still active');

  // Enter also opens a submenu
  pressKey(app, wnd, { keysym: XK.Return });
  await tick();
  await tick();
  assert.strictEqual(app.windows.length, 4, 'reopened via Enter');

  // Escape closes one level at a time
  pressKey(app, wnd, { keysym: 0xff1b });
  await tick();
  await tick();
  assert.strictEqual(app.windows[3].destroyed, true, 'submenu closed');
  assert.strictEqual(app.windows[1].destroyed, false, 'root survives');
  pressKey(app, wnd, { keysym: 0xff1b });
  await tick();
  assert.strictEqual(app.windows[1].destroyed, true, 'root closed');
  assert.deepStrictEqual(picked, []);

  await x11Root.unmount();
});

test('submenu: selecting a nested item closes every level', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const picked = [];
  const wnd = await openNested(x11Root, picked);

  pressKey(app, wnd, { keysym: 0xff54 }); // New
  await tick();
  pressKey(app, wnd, { keysym: 0xff54 }); // Export
  await tick();
  pressKey(app, wnd, { keysym: 0xff53 }); // into submenu -> PNG
  await tick();
  await tick();
  pressKey(app, wnd, { keysym: XK.Return });
  await tick();

  assert.deepStrictEqual(picked, ['PNG']);
  assert.strictEqual(app.windows[1].destroyed, true, 'root closed');
  assert.strictEqual(app.windows[2].destroyed, true, 'submenu closed');

  await x11Root.unmount();
});

test('submenu: hovering a parent row opens it with nothing selected inside', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const picked = [];
  await openNested(x11Root, picked);
  const menu = app.windows[1];
  const exportRow = rowsOf(app, 1)[1];

  menu.emit('mousemove', {
    x: exportRow.abs.x + 5,
    y: exportRow.abs.y + exportRow.abs.height / 2,
  });
  // hover is continuous priority (scheduled, not flushed), and the submenu
  // rect is then measured in an effect — so this settles over a few ticks
  for (let i = 0; i < 4; i++) await tick();
  assert.strictEqual(app.windows.length, 3, 'submenu opened on hover');
  assert.strictEqual(activeIn(app, 2), -1, 'nothing active inside yet');

  // hovering a sibling closes the submenu again
  const quitRow = rowsOf(app, 1)[2];
  menu.emit('mousemove', {
    x: quitRow.abs.x + 5,
    y: quitRow.abs.y + quitRow.abs.height / 2,
  });
  for (let i = 0; i < 4; i++) await tick();
  assert.strictEqual(app.windows[2].destroyed, true, 'submenu closed');
  assert.strictEqual(activeIn(app, 1), 2, 'Quit active');

  await x11Root.unmount();
});

test('submenu: a diagonal path toward it keeps it open (safe polygon)', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const picked = [];
  await openNested(x11Root, picked);
  const menu = app.windows[1];
  const rows = rowsOf(app, 1);
  const exportRow = rows[1];
  const quitRow = rows[2];

  // over the parent row: the submenu opens
  const overExport = {
    x: exportRow.abs.x + 5,
    y: exportRow.abs.y + exportRow.abs.height / 2,
  };
  menu.emit('mousemove', {
    ...overExport,
    rootx: overExport.x,
    rooty: overExport.y,
  });
  for (let i = 0; i < 4; i++) await tick();
  assert.strictEqual(app.windows.length, 3, 'submenu opened on hover');

  // a second move records where the pointer is on its way out, near the
  // right edge of the row — the apex of the safe polygon
  const apex = {
    x: exportRow.abs.x + exportRow.abs.width - 4,
    y: overExport.y,
  };
  menu.emit('mousemove', { ...apex, rootx: apex.x, rooty: apex.y });
  await tick();

  const submenu = app.windows[2].attributes;
  // now the diagonal: the pointer is over Quit, but heading into the gap
  // in front of the submenu — this is what used to close it
  menu.emit('mousemove', {
    x: quitRow.abs.x + 5,
    y: quitRow.abs.y + quitRow.abs.height / 2,
    rootx: submenu.x - 3,
    rooty: submenu.y + 10,
  });
  for (let i = 0; i < 4; i++) await tick();

  assert.strictEqual(app.windows[2].destroyed, false, 'submenu still open');
  assert.strictEqual(activeIn(app, 1), 1, 'Export still the active row');

  // moving away from the submenu switches immediately, as before
  menu.emit('mousemove', {
    x: quitRow.abs.x + 5,
    y: quitRow.abs.y + quitRow.abs.height / 2,
    rootx: quitRow.abs.x + 5,
    rooty: quitRow.abs.y + 40,
  });
  for (let i = 0; i < 4; i++) await tick();
  assert.strictEqual(app.windows[2].destroyed, true, 'submenu closed');
  assert.strictEqual(activeIn(app, 1), 2, 'Quit active');

  await x11Root.unmount();
});

test('submenu: a pointer that stops inside the safe polygon still switches', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const picked = [];
  await openNested(x11Root, picked);
  const menu = app.windows[1];
  const rows = rowsOf(app, 1);
  const exportRow = rows[1];
  const quitRow = rows[2];

  const overExport = {
    x: exportRow.abs.x + 5,
    y: exportRow.abs.y + exportRow.abs.height / 2,
  };
  menu.emit('mousemove', {
    ...overExport,
    rootx: overExport.x,
    rooty: overExport.y,
  });
  for (let i = 0; i < 4; i++) await tick();
  menu.emit('mousemove', {
    x: exportRow.abs.x + exportRow.abs.width - 4,
    y: overExport.y,
    rootx: exportRow.abs.x + exportRow.abs.width - 4,
    rooty: overExport.y,
  });
  await tick();

  const submenu = app.windows[2].attributes;
  menu.emit('mousemove', {
    x: quitRow.abs.x + 5,
    y: quitRow.abs.y + quitRow.abs.height / 2,
    rootx: submenu.x - 3,
    rooty: submenu.y + 10,
  });
  for (let i = 0; i < 4; i++) await tick();
  assert.strictEqual(activeIn(app, 1), 1, 'held back at first');

  // the hold is a delay, not a veto: a pointer parked there meant that row
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (let i = 0; i < 4; i++) await tick();
  assert.strictEqual(activeIn(app, 1), 2, 'Quit active once the delay lapses');

  await x11Root.unmount();
});

const typeChar = (app, wnd, ch) =>
  pressKey(app, wnd, { keysym: ch.charCodeAt(0), codepoint: ch.charCodeAt(0) });

test('Select: type-ahead jumps, refines and cycles', async () => {
  const { Select } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const options = ['apple', 'banana', 'blueberry', 'cherry'];
  let current = null;
  const Host = () => {
    const [v, setV] = React.useState(null);
    current = v;
    return React.createElement(
      'window',
      { width: 300, height: 120 },
      React.createElement(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        React.createElement(Select, {
          options,
          value: v,
          onChange: (ev) => setV(ev.value),
          style: { width: 200 },
        }),
      ),
    );
  };
  x11Root.render(React.createElement(Host));
  await tick();
  const wnd = app.windows[0];
  const findFocusable = (n) =>
    n.props?.focusable
      ? n
      : n.children.reduce(
          (a, c) => a || (c.isWindow ? null : findFocusable(c)),
          null,
        );
  const trigger = findFocusable(wnd._reactX11Node);
  const cx = trigger.abs.x + 10;
  const cy = trigger.abs.y + trigger.abs.height / 2;

  // closed: type-ahead changes the value outright, like a native select
  wnd.emit('mousedown', { x: cx, y: cy, keycode: 1 });
  wnd.emit('mouseup', { x: cx, y: cy, keycode: 1 });
  await tick();
  pressKey(app, wnd, { keysym: 0xff1b }); // close again, keep focus
  await tick();

  typeChar(app, wnd, 'c');
  await tick();
  assert.strictEqual(current, 'cherry', 'closed type-ahead selects');

  // open it and use type-ahead on the highlight
  await new Promise((r) => setTimeout(r, 800)); // let the query expire
  wnd.emit('mousedown', { x: cx, y: cy, keycode: 1 });
  wnd.emit('mouseup', { x: cx, y: cy, keycode: 1 });
  await tick();

  const activeIndex = () => {
    const popup = app.windows.at(-1);
    let scroller = null;
    const walk = (n) => {
      if (n.isScroller?.()) scroller = n;
      else n.children.forEach(walk);
    };
    walk(popup._reactX11Node);
    return scroller.children.findIndex(
      (o) => o.style.backgroundColor === '#2980b9',
    );
  };

  typeChar(app, wnd, 'b');
  await tick();
  assert.strictEqual(activeIndex(), 1, 'b -> banana');

  // a growing query searches from the current entry
  typeChar(app, wnd, 'l');
  await tick();
  assert.strictEqual(activeIndex(), 2, 'bl -> blueberry');

  // repeating one letter cycles rather than sticking
  await new Promise((r) => setTimeout(r, 800));
  typeChar(app, wnd, 'b');
  await tick();
  assert.strictEqual(activeIndex(), 1, 'b -> banana again');
  typeChar(app, wnd, 'b');
  await tick();
  assert.strictEqual(activeIndex(), 2, 'bb cycles to blueberry');

  await x11Root.unmount();
});

test('menu type-ahead moves the active row and skips disabled entries', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const picked = [];
  const wnd = await openNested(x11Root, picked); // New / Export / Quit

  typeChar(app, wnd, 'q');
  await tick();
  assert.strictEqual(activeIn(app, 1), 2, 'q -> Quit');

  typeChar(app, wnd, 'e');
  await tick();
  // 'qe' matches nothing, so the active row stays put
  assert.strictEqual(activeIn(app, 1), 2, 'no match leaves the selection');

  await new Promise((r) => setTimeout(r, 800));
  typeChar(app, wnd, 'e');
  await tick();
  assert.strictEqual(activeIn(app, 1), 1, 'e -> Export');

  await x11Root.unmount();
});

test('menu type-ahead applies to the deepest open submenu', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const picked = [];
  const wnd = await openNested(x11Root, picked);

  // into Export's submenu: PNG / --- / SVG / PDF(disabled)
  pressKey(app, wnd, { keysym: 0xff54 });
  await tick();
  pressKey(app, wnd, { keysym: 0xff54 });
  await tick();
  pressKey(app, wnd, { keysym: 0xff53 });
  await tick();
  await tick();
  assert.strictEqual(app.windows.length, 3, 'submenu open');
  assert.strictEqual(activeIn(app, 2), 0, 'PNG active');

  typeChar(app, wnd, 's');
  await tick();
  assert.strictEqual(activeIn(app, 2), 2, 's -> SVG, inside the submenu');
  assert.strictEqual(pathIn(app, 1), 1, 'parent row unchanged, and quiet');

  // the disabled PDF is never matched
  await new Promise((r) => setTimeout(r, 800));
  typeChar(app, wnd, 'p');
  await tick();
  assert.strictEqual(activeIn(app, 2), 0, 'p -> PNG, never the disabled PDF');

  await x11Root.unmount();
});

test('textinput: Ctrl+arrow moves by word, Ctrl+Backspace/Delete removes one', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const changes = [];
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 80 },
      React.createElement('textinput', {
        defaultValue: 'foo-bar baz_qux end',
        onChange: (ev) => changes.push(ev.target.value),
      }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const input = wnd._reactX11Node.children[0];
  wnd.emit('mousedown', { x: 5, y: 5, keycode: 1 });
  wnd.emit('mouseup', { x: 5, y: 5, keycode: 1 });
  await tick();

  const caret = () => input._selection()[0];
  const ctrl = (keysym) => pressKey(app, wnd, { keysym, buttons: 4 });

  // 'foo-bar baz_qux end' — '-' is not a word char, '_' is
  input._caret = 0;
  input._anchor = 0;
  ctrl(0xff53); // Ctrl+Right
  assert.strictEqual(caret(), 3, 'end of "foo"');
  ctrl(0xff53);
  assert.strictEqual(caret(), 7, 'end of "bar" (hyphen is a separator)');
  ctrl(0xff53);
  assert.strictEqual(caret(), 15, 'end of "baz_qux" (underscore joins)');

  ctrl(0xff51); // Ctrl+Left
  assert.strictEqual(caret(), 8, 'start of "baz_qux"');

  // Ctrl+Backspace removes the word before the caret
  ctrl(0xff08);
  await tick();
  assert.strictEqual(changes.at(-1), 'foo-bar baz_qux end'.replace('bar ', ''));

  await x11Root.unmount();
});

test('textinput: shift+click extends the selection from the anchor', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 80 },
      React.createElement('textinput', { defaultValue: 'hello world' }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const input = wnd._reactX11Node.children[0];

  // click to place the caret, then shift+click elsewhere
  wnd.emit('mousedown', { x: 5, y: 5, keycode: 1 });
  wnd.emit('mouseup', { x: 5, y: 5, keycode: 1 });
  await tick();
  input._caret = 2;
  input._anchor = 2;

  // stub the hit index so the test does not depend on font metrics
  const realIndexAt = input._indexAtPoint;
  input._indexAtPoint = () => 8;
  wnd.emit('mousedown', { x: 60, y: 5, keycode: 1, buttons: 1 });
  wnd.emit('mouseup', { x: 60, y: 5, keycode: 1, buttons: 1 });
  input._indexAtPoint = realIndexAt;

  assert.deepStrictEqual(
    input._selection(),
    [2, 8],
    'anchor kept, caret moved to the shift+clicked index',
  );

  await x11Root.unmount();
});

// --- undo/redo -------------------------------------------------------------

// Mounts a focused <textinput> and returns helpers for driving it.
async function mountInput(props = {}) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 80 },
      React.createElement('textinput', props),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const input = wnd._reactX11Node.children[0];
  wnd.emit('mousedown', { x: 5, y: 5, keycode: 1 });
  wnd.emit('mouseup', { x: 5, y: 5, keycode: 1 });
  await tick();
  return {
    app,
    wnd,
    input,
    type: (text) => {
      for (const ch of text) {
        const cp = ch.codePointAt(0);
        pressKey(app, wnd, { keysym: cp, codepoint: cp });
      }
    },
    key: (keysym, buttons = 0) => pressKey(app, wnd, { keysym, buttons }),
    unmount: () => x11Root.unmount(),
  };
}

const XK_z = 0x7a;
const XK_y = 0x79;
const XK_END = 0xff57;
const CTRL = 4;
const SHIFT = 1;

test('textinput: Ctrl+Z undoes a run of typing, Ctrl+Shift+Z redoes it', async () => {
  const { input, type, key, unmount } = await mountInput({ defaultValue: '' });

  type('hi');
  assert.strictEqual(input.value, 'hi');

  key(XK_z, CTRL);
  assert.strictEqual(input.value, '', 'a run of typing undoes as one step');
  assert.strictEqual(input._caret, 0, 'caret goes back where the run started');
  assert.strictEqual(input.canUndo, false);

  key(XK_z, CTRL | SHIFT);
  assert.strictEqual(input.value, 'hi');
  assert.strictEqual(input._caret, 2, 'redo restores the caret it ended at');

  // Ctrl+Y redoes too, for the Windows-shaped muscle memory
  key(XK_z, CTRL);
  key(XK_y, CTRL);
  assert.strictEqual(input.value, 'hi');
  assert.strictEqual(input.canRedo, false);

  unmount();
});

test('textinput: undo works a word at a time', async () => {
  const { input, type, key, unmount } = await mountInput({ defaultValue: '' });

  type('hello world');
  key(XK_z, CTRL);
  assert.strictEqual(input.value, 'hello ', 'the space ends the run it joins');
  key(XK_z, CTRL);
  assert.strictEqual(input.value, '');

  unmount();
});

test('textinput: caret moves and deletes break the undo run', async () => {
  const { input, type, key, unmount } = await mountInput({ defaultValue: '' });

  type('ab');
  key(XK.Left); // moving the caret starts a new edit
  type('X');
  assert.strictEqual(input.value, 'aXb');

  key(XK_z, CTRL);
  assert.strictEqual(input.value, 'ab', 'only the second run comes back off');
  assert.strictEqual(input._caret, 1, 'caret where the undone insert happened');

  key(XK_z, CTRL);
  assert.strictEqual(input.value, '');

  // backspaces coalesce with each other, not with the typing before them
  key(XK_y, CTRL);
  key(XK_y, CTRL);
  assert.strictEqual(input.value, 'aXb');
  key(XK_END);
  key(XK.BackSpace);
  key(XK.BackSpace);
  assert.strictEqual(input.value, 'a');
  key(XK_z, CTRL);
  assert.strictEqual(input.value, 'aXb', 'both backspaces undo together');
  assert.strictEqual(input._caret, 3, 'caret back where deleting started');

  unmount();
});

test('textinput: a fresh edit drops the redo tail', async () => {
  const { input, type, key, unmount } = await mountInput({ defaultValue: '' });

  type('one ');
  type('two');
  key(XK_z, CTRL);
  assert.strictEqual(input.value, 'one ');
  assert.strictEqual(input.canRedo, true);

  type('six');
  assert.strictEqual(input.value, 'one six');
  assert.strictEqual(input.canRedo, false, '"two" is no longer reachable');

  key(XK_z, CTRL);
  assert.strictEqual(input.value, 'one ');

  unmount();
});

test('textinput: a paste is its own undo step', async () => {
  const { app, wnd, input, type, key, unmount } = await mountInput({
    defaultValue: '',
  });
  app.clipboard = {
    write: () => Promise.resolve(),
    read: () => Promise.resolve('pasted'),
  };

  type('ab');
  pressKey(app, wnd, { keysym: 0x76, codepoint: 0x76, buttons: CTRL }); // ctrl+v
  await tick();
  assert.strictEqual(input.value, 'abpasted');

  key(XK_z, CTRL);
  assert.strictEqual(input.value, 'ab', 'the paste undoes without the typing');
  key(XK_z, CTRL);
  assert.strictEqual(input.value, '');

  unmount();
});

test('textinput: undo in controlled mode reports through onChange', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const changes = [];
  const render = (value) =>
    x11Root.render(
      React.createElement(
        'window',
        { width: 300, height: 80 },
        React.createElement('textinput', {
          value,
          onChange: (ev) => {
            changes.push(ev.target.value);
            render(ev.target.value);
          },
        }),
      ),
    );
  render('');
  await tick();
  const wnd = app.windows[0];
  const input = wnd._reactX11Node.children[0];
  wnd.emit('mousedown', { x: 5, y: 5, keycode: 1 });
  wnd.emit('mouseup', { x: 5, y: 5, keycode: 1 });

  pressKey(app, wnd, { keysym: 0x68, codepoint: 0x68 }); // h
  pressKey(app, wnd, { keysym: 0x69, codepoint: 0x69 }); // i
  assert.strictEqual(input.value, 'hi');

  pressKey(app, wnd, { keysym: XK_z, buttons: CTRL });
  assert.deepStrictEqual(
    changes,
    ['h', 'hi', ''],
    'undo asks for the old value',
  );
  assert.strictEqual(input.value, '', 'and the display follows the prop back');

  pressKey(app, wnd, { keysym: XK_z, buttons: CTRL | SHIFT });
  assert.strictEqual(input.value, 'hi');

  await x11Root.unmount();
});

test('textinput: a value changed from outside becomes its own undo step', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const render = (value) =>
    x11Root.render(
      React.createElement(
        'window',
        { width: 300, height: 80 },
        React.createElement('textinput', { value }),
      ),
    );
  render('typed');
  await tick();
  const wnd = app.windows[0];
  const input = wnd._reactX11Node.children[0];
  wnd.emit('mousedown', { x: 5, y: 5, keycode: 1 });
  wnd.emit('mouseup', { x: 5, y: 5, keycode: 1 });

  render(''); // the form was reset behind the control's back
  assert.strictEqual(input.canUndo, true);
  assert.strictEqual(input.undo(), true, 'undo asks for the pre-reset value');
  assert.strictEqual(input._historyValue, 'typed');

  await x11Root.unmount();
});

test('textarea: undo restores across lines, Enter is its own step', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 200 },
      React.createElement('textarea', { defaultValue: '', rows: 4 }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const area = wnd._reactX11Node.children[0];
  wnd.emit('mousedown', { x: 5, y: 5, keycode: 1 });
  wnd.emit('mouseup', { x: 5, y: 5, keycode: 1 });

  for (const cp of [0x61, 0x62])
    pressKey(app, wnd, { keysym: cp, codepoint: cp });
  pressKey(app, wnd, { keysym: XK.Return });
  for (const cp of [0x63, 0x64])
    pressKey(app, wnd, { keysym: cp, codepoint: cp });
  assert.strictEqual(area.value, 'ab\ncd');

  pressKey(app, wnd, { keysym: XK_z, buttons: CTRL });
  assert.strictEqual(area.value, 'ab\n');
  pressKey(app, wnd, { keysym: XK_z, buttons: CTRL });
  assert.strictEqual(area.value, 'ab', 'the newline undoes on its own');
  pressKey(app, wnd, { keysym: XK_z, buttons: CTRL });
  assert.strictEqual(area.value, '');

  await x11Root.unmount();
});

// --- right-click / the built-in edit menu ----------------------------------

// A focused <textinput> with everything selected, plus a working clipboard.
async function mountSelected(props = {}) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const writes = [];
  app.clipboard = {
    write(text, opts) {
      writes.push([text, opts?.selection ?? 'CLIPBOARD']);
      return Promise.resolve();
    },
    read: () => Promise.resolve('pasted'),
  };
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 80 },
      React.createElement('textinput', {
        defaultValue: 'hello world',
        ...props,
      }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const input = wnd._reactX11Node.children[0];
  wnd.emit('mousedown', { x: 5, y: 5, keycode: 1 });
  wnd.emit('mouseup', { x: 5, y: 5, keycode: 1 });
  pressKey(app, wnd, { keysym: 0x61, codepoint: 0x61, buttons: CTRL }); // ctrl+a
  return { app, wnd, input, writes };
}

test('textinput: select-all owns PRIMARY, both ways in', async () => {
  // Every other selection gesture already did; GTK and Qt do it for
  // select-all too, so a middle-click paste right after Ctrl+A pastes what
  // is on screen rather than whatever was selected before it.
  const { writes } = await mountSelected(); // its last act is Ctrl+A
  assert.deepStrictEqual(
    writes.at(-1),
    ['hello world', 'PRIMARY'],
    'Ctrl+A published the selection',
  );

  const { input, writes: menuWrites } = await mountSelected();
  menuWrites.length = 0;
  input._runEditAction('selectAll');
  assert.deepStrictEqual(input._selection(), [0, 11]);
  assert.deepStrictEqual(
    menuWrites.at(-1),
    ['hello world', 'PRIMARY'],
    'the menu row published it too',
  );
});

const rightClick = (wnd, x = 40, y = 10) =>
  wnd.emit('mousedown', { x, y, keycode: 3 });

test('textinput: right-click keeps the selection it lands inside', async () => {
  const { app, wnd, input } = await mountSelected();
  const x11Root = await createRoot({ app });
  assert.deepStrictEqual(input._selection(), [0, 11]);

  rightClick(wnd);
  assert.deepStrictEqual(
    input._selection(),
    [0, 11],
    'the menu is about to act on it — it must survive the click',
  );
  assert.strictEqual(input._dragging, false, 'and no drag was started');
  assert.strictEqual(
    input._showsSelection(),
    true,
    'still painted while the menu holds the keyboard',
  );

  await x11Root.unmount();
});

test('textinput: right-click outside the selection moves the caret', async () => {
  const { app, wnd, input } = await mountSelected();
  const x11Root = await createRoot({ app });
  input._indexAtPoint = () => 3; // stub: headless text measures 0x0
  input._caret = 6;
  input._anchor = 8; // a selection of [6, 8] — the click at 3 is outside it

  rightClick(wnd);
  assert.deepStrictEqual(input._selection(), [3, 3], 'caret follows the click');

  await x11Root.unmount();
});

test('textinput: right-click opens a menu whose rows match the state', async () => {
  const { app, wnd, input } = await mountSelected();
  const x11Root = await createRoot({ app });
  const before = app.windows.length;

  rightClick(wnd);
  assert.ok(input._editMenu, 'a popup is open');
  assert.strictEqual(app.windows.length, before + 1, 'and it is a real window');

  const rows = Object.fromEntries(
    input
      ._editMenuItems()
      .filter((i) => i.type !== 'separator')
      .map((i) => [i.id, i.enabled]),
  );
  assert.deepStrictEqual(rows, {
    undo: false, // nothing has been edited yet
    redo: false,
    cut: true, // there is a selection
    copy: true,
    paste: true, // there is a clipboard to ask
    selectAll: false, // everything is already selected
  });

  await x11Root.unmount();
});

test('textinput: choosing Copy closes the menu and copies', async () => {
  const { app, wnd, input, writes } = await mountSelected();
  const x11Root = await createRoot({ app });
  rightClick(wnd);

  input._chooseEditMenu('copy');
  assert.strictEqual(input._editMenu, null, 'the menu closes');
  assert.deepStrictEqual(writes.at(-1), ['hello world', 'CLIPBOARD']);
  assert.deepStrictEqual(input._selection(), [0, 11], 'selection survives');
  assert.strictEqual(input._focused, true, 'focus comes back to the field');

  await x11Root.unmount();
});

test('textinput: Cut through the menu is one undoable step', async () => {
  const { app, wnd, input } = await mountSelected();
  const x11Root = await createRoot({ app });
  rightClick(wnd);
  input._chooseEditMenu('cut');

  assert.strictEqual(input.value, '');
  assert.strictEqual(input.canUndo, true);
  input.undo();
  assert.strictEqual(input.value, 'hello world', 'one undo brings it back');

  await x11Root.unmount();
});

test('textinput: Escape closes the menu, leaving the text alone', async () => {
  const { app, wnd, input } = await mountSelected();
  const x11Root = await createRoot({ app });
  rightClick(wnd);
  const popup = input._editMenu;
  const canvas = popup.children[0];

  canvas.props.onKeyDown({ keysym: 0xff1b }); // Escape
  assert.strictEqual(input._editMenu, null);
  assert.strictEqual(input.value, 'hello world');
  assert.strictEqual(input._focused, true);

  await x11Root.unmount();
});

test('textinput: arrows walk the menu, skipping disabled rows', async () => {
  const { app, wnd, input } = await mountSelected();
  const x11Root = await createRoot({ app });
  rightClick(wnd);
  const canvas = input._editMenu.children[0];
  const items = input._editMenuItems();

  // Undo and Redo are disabled and Select All is too, so Down from nothing
  // lands on Cut — the first row that would actually do something
  canvas.props.onKeyDown({ keysym: 0xff54 }); // Down
  canvas.props.onKeyDown({ keysym: 0xff0d }); // Enter
  assert.strictEqual(input._editMenu, null, 'Enter chose a row and closed');
  assert.strictEqual(input.value, '', 'and the row it chose was Cut');
  assert.strictEqual(items[3].id, 'cut');

  await x11Root.unmount();
});

test('textinput: onContextMenu fires, and preventDefault suppresses the menu', async () => {
  const seen = [];
  const { app, wnd, input } = await mountSelected({
    onContextMenu: (ev) => {
      seen.push(ev.button);
      ev.preventDefault();
    },
  });
  const x11Root = await createRoot({ app });

  rightClick(wnd);
  assert.deepStrictEqual(seen, [3], 'the handler ran');
  assert.strictEqual(
    input._editMenu,
    null,
    'and the built-in menu stayed shut',
  );

  await x11Root.unmount();
});

test('textinput: contextMenu={false} opts out of the built-in menu', async () => {
  const { app, wnd, input } = await mountSelected({ contextMenu: false });
  const x11Root = await createRoot({ app });
  rightClick(wnd);
  assert.strictEqual(input._editMenu, null);
  assert.deepStrictEqual(
    input._selection(),
    [0, 11],
    'opting out still must not eat the selection',
  );

  await x11Root.unmount();
});

test('textinput: a press outside dismisses the menu', async () => {
  const { app, wnd, input } = await mountSelected();
  const x11Root = await createRoot({ app });
  rightClick(wnd);
  const popup = input._editMenu;

  popup.props.onDismiss({});
  assert.strictEqual(input._editMenu, null);

  await x11Root.unmount();
});

test('ContextMenu around a textinput replaces the built-in menu', async () => {
  const { ContextMenu } = await import('../src/index.js');
  const findKind = (node, kind) =>
    node.kind === kind
      ? node
      : node.children.reduce((f, c) => f ?? findKind(c, kind), null);
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 120 },
      React.createElement(
        ContextMenu,
        {
          items: [{ id: 'app', label: 'App action' }],
          style: { flexGrow: 1 },
        },
        React.createElement('textinput', { defaultValue: 'hello' }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const input = findKind(wnd._reactX11Node, 'textinput');
  const before = app.windows.length;

  // land the press on the textinput itself, so both menus are in play
  wnd.emit('mousedown', { x: 20, y: 8, keycode: 3, rootx: 300, rooty: 200 });
  await tick();

  assert.strictEqual(
    input._editMenu,
    null,
    'the built-in menu defers to the one wrapped around it',
  );
  assert.strictEqual(
    app.windows.length,
    before + 1,
    'exactly one popup, not two stacked on each other',
  );

  await x11Root.unmount();
});

test('textarea: right-click gets the same menu', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 200 },
      React.createElement('textarea', { defaultValue: 'a\nb', rows: 3 }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const area = wnd._reactX11Node.children[0];
  wnd.emit('mousedown', { x: 5, y: 5, keycode: 1 });
  wnd.emit('mouseup', { x: 5, y: 5, keycode: 1 });

  rightClick(wnd, 20, 20);
  assert.ok(area._editMenu, 'the editing core is shared, so the menu is too');
  area._chooseEditMenu('selectAll');
  assert.deepStrictEqual(area._selection(), [0, 3]);

  await x11Root.unmount();
});

test('textarea: PageDown/PageUp move by a viewport of lines', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 200 },
      React.createElement('textarea', {
        defaultValue: Array.from({ length: 40 }, (_, i) => `line ${i}`).join(
          '\n',
        ),
        rows: 4,
      }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const area = wnd._reactX11Node.children[0];
  // keys route to the focused node, so focus it the way a user would
  wnd.emit('mousedown', { x: 5, y: 5, keycode: 1 });
  wnd.emit('mouseup', { x: 5, y: 5, keycode: 1 });
  await tick();

  // the mock app has no font stack, so drive the layout the node uses
  const LINES = 40;
  const lineH = 10;
  const fakeLayout = {
    height: LINES * lineH,
    lines: Array.from({ length: LINES }, (_, i) => ({
      x: 0,
      y: i * lineH,
      width: 50,
      ascent: 8,
      descent: 2,
    })),
    caretPosition: (i) => ({
      x: 0,
      y: Math.floor(i / 8) * lineH,
      height: lineH,
      line: Math.floor(i / 8),
    }),
    // y is mid-line, so floor maps it to the line containing it
    indexAt: (x, y) => Math.floor(y / lineH) * 8,
    draw: () => {},
  };
  area._valueLayout = () => fakeLayout;
  area._lineHeight = () => lineH;
  area._focused = true;
  area._caret = 0;
  area._anchor = 0;

  const pageLines = area._pageLines();
  assert.ok(pageLines > 1, `viewport holds ${pageLines} lines`);

  pressKey(app, wnd, { keysym: 0xff56 }); // Page Down
  assert.strictEqual(
    area._selection()[0],
    pageLines * 8,
    'caret moved down one viewport of lines',
  );

  pressKey(app, wnd, { keysym: 0xff55 }); // Page Up
  assert.strictEqual(area._selection()[0], 0, 'and back up again');

  // past the top clamps to the start rather than going negative
  pressKey(app, wnd, { keysym: 0xff55 });
  assert.strictEqual(area._selection()[0], 0);

  await x11Root.unmount();
});

test('textarea: draws a scrollbar thumb only when the text overflows', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 200 },
      React.createElement('textarea', { defaultValue: 'x', rows: 3 }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const area = wnd._reactX11Node.children[0];
  const content = area.contentBox();

  const paintWith = (layoutHeight) => {
    area._valueLayout = () => ({
      height: layoutHeight,
      lines: [{ x: 0, y: 0, width: 10, ascent: 8, descent: 2 }],
      caretPosition: () => ({ x: 0, y: 0, height: 10, line: 0 }),
      indexAt: () => 0,
      draw: () => {},
    });
    wnd.ctx.ops.length = 0;
    area.paint(wnd.ctx);
    return wnd.ctx.ops;
  };

  // the clip path is a 'rect' too, so identify the thumb by its 6px track
  const findThumb = (ops) =>
    ops.find(([op, , , w]) => (op === 'roundRect' || op === 'rect') && w === 6);

  // fits: no thumb
  let ops = paintWith(content.height - 5);
  assert.ok(!findThumb(ops), 'no scrollbar when the content fits');

  // overflows: a thumb is drawn inside the content box
  ops = paintWith(content.height * 4);
  const thumb = findThumb(ops);
  assert.ok(thumb, 'thumb drawn when the content overflows');
  const [, tx, ty, tw, th] = thumb;
  assert.ok(tw > 0 && th >= 20, 'thumb has a usable size');
  assert.ok(
    tx + tw <= content.x + content.width + 0.01,
    'thumb sits inside the content box',
  );
  assert.ok(ty >= content.y - 0.01, 'thumb starts at or below the top');

  await x11Root.unmount();
});

test('Select: PageDown/PageUp move by a menu viewport, clamped at the ends', async () => {
  const { Select } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const options = Array.from({ length: 40 }, (_, i) => `option-${i}`);
  x11Root.render(
    React.createElement(
      'window',
      { width: 300, height: 120 },
      React.createElement(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        React.createElement(Select, {
          options,
          value: options[0],
          style: { width: 200 },
        }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const findFocusable = (n) =>
    n.props?.focusable
      ? n
      : n.children.reduce(
          (a, c) => a || (c.isWindow ? null : findFocusable(c)),
          null,
        );
  const trigger = findFocusable(wnd._reactX11Node);
  wnd.emit('mousedown', {
    x: trigger.abs.x + 10,
    y: trigger.abs.y + trigger.abs.height / 2,
    keycode: 1,
  });
  wnd.emit('mouseup', {
    x: trigger.abs.x + 10,
    y: trigger.abs.y + trigger.abs.height / 2,
    keycode: 1,
  });
  await tick();
  await tick();

  const scroller = (() => {
    let found = null;
    const walk = (n) => {
      if (n.isScroller?.()) found = n;
      else n.children.forEach(walk);
    };
    walk(app.windows[1]._reactX11Node);
    return found;
  })();
  const active = () =>
    scroller.children.findIndex((o) => o.style.backgroundColor === '#2980b9');

  assert.strictEqual(active(), 0, 'opens on the current value');
  // page = floor(MAX_MENU_HEIGHT / ITEM_HEIGHT) = floor(220 / 28) = 7
  const PAGE = 7;

  pressKey(app, wnd, { keysym: 0xff56 }); // Page Down
  await tick();
  assert.strictEqual(active(), PAGE, 'down one page');

  pressKey(app, wnd, { keysym: 0xff56 });
  await tick();
  assert.strictEqual(active(), PAGE * 2);

  pressKey(app, wnd, { keysym: 0xff55 }); // Page Up
  await tick();
  assert.strictEqual(active(), PAGE, 'back up one page');

  // paging past an end clamps rather than wrapping — unlike the arrows.
  // each press needs its own tick: a synchronous burst would not re-render
  // between them, so the handler would keep reading the same index
  for (let i = 0; i < 10; i++) {
    pressKey(app, wnd, { keysym: 0xff56 });
    await tick();
  }
  assert.strictEqual(active(), options.length - 1, 'clamps at the last option');

  for (let i = 0; i < 10; i++) {
    pressKey(app, wnd, { keysym: 0xff55 });
    await tick();
  }
  assert.strictEqual(active(), 0, 'clamps at the first option');

  await x11Root.unmount();
});

test('menu: PageDown/PageUp land on a selectable row, never a separator', async () => {
  const { ContextMenu } = await import('../src/index.js');
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const picked = [];
  // 12 rows where the row a page-stride away (index 10) is a separator, so
  // a naive jump would land on something unselectable
  const items = Array.from({ length: 12 }, (_, i) =>
    i === 10
      ? { type: 'separator' }
      : { label: `entry-${i}`, onSelect: () => picked.push(i) },
  );
  x11Root.render(
    React.createElement(
      'window',
      { width: 320, height: 220 },
      React.createElement(
        ContextMenu,
        { items, style: { flexGrow: 1 } },
        React.createElement('box', { style: { flexGrow: 1 } }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  wnd.emit('mousedown', { x: 20, y: 20, keycode: 3, rootx: 100, rooty: 100 });
  await tick();
  await tick();

  const rows = () => app.windows[1]._reactX11Node.children[0].children;
  const active = () =>
    rows().findIndex((r) => r.style.backgroundColor === '#2980b9');

  pressKey(app, wnd, { keysym: 0xff54 }); // Down -> entry-0
  await tick();
  assert.strictEqual(active(), 0);

  // a page is 10 rows: index 10 is the separator, so it must settle on a
  // selectable row instead
  pressKey(app, wnd, { keysym: 0xff56 }); // Page Down
  await tick();
  const landed = active();
  assert.notStrictEqual(landed, 10, 'never lands on the separator');
  assert.ok(
    rows()[landed].style.backgroundColor === '#2980b9',
    'landed on a real row',
  );
  assert.ok(landed > 0, 'and moved forward');

  // paging back is symmetric in *rows*, not a history undo: the page down
  // settled on 11 after skipping the separator, so 10 rows up is 1
  pressKey(app, wnd, { keysym: 0xff55 }); // Page Up
  await tick();
  assert.strictEqual(active(), landed - 10, 'a page back in rows');

  pressKey(app, wnd, { keysym: 0xff55 });
  await tick();
  assert.strictEqual(active(), 0, 'and clamps at the first entry');

  await x11Root.unmount();
});

test('injectIntoDevTools registers the renderer metadata from the host config', async () => {
  // react-reconciler 0.33 dropped injectIntoDevTools' parameter; the config
  // that used to be passed there was silently discarded, taking the
  // renderer's name and version with it (#121). What the hook receives is
  // the only observable, so assert on that rather than on the call.
  const { Renderer } = await import('../src/index.js');
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );

  const injected = [];
  const previous = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    inject: (internals) => {
      injected.push(internals);
      return 1;
    },
  };
  try {
    Renderer.injectIntoDevTools();
  } finally {
    if (previous === undefined) delete global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    else global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = previous;
  }

  assert.strictEqual(injected.length, 1, 'the hook was injected into');
  const internals = injected[0];
  assert.strictEqual(internals.rendererPackageName, pkg.name);
  assert.strictEqual(internals.version, pkg.version);
  assert.strictEqual(
    typeof internals.currentDispatcherRef,
    'object',
    'the field DevTools 7 actually keys off to pick the fiber renderer',
  );
  assert.strictEqual(
    internals.rendererConfig,
    undefined,
    'extraDevToolsConfig is null, so no rendererConfig is advertised',
  );
});

// --- window states (#122) ---------------------------------------------------

const stateCalls = (wnd) =>
  wnd.calls.filter(([name]) => name === 'setWmState').map(([, s, a]) => [s, a]);

test('window states are declared before the map, so a window can open fullscreen', async () => {
  // EWMH 7.7: an unmapped window *declares* its state by writing the
  // property; a mapped one has to *ask* the WM. Only the first can open
  // already fullscreen instead of flashing at the normal size first.
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement('window', { width: 100, height: 80, fullscreen: true }),
  );
  await tick();

  const wnd = app.windows[0];
  const names = wnd.calls.map(([name]) => name);
  assert.ok(names.includes('setWmState'), 'the state was asked for');
  assert.ok(
    names.indexOf('setWmState') < names.indexOf('map'),
    'and asked for before the map, which is what makes it the initial state',
  );
  assert.deepStrictEqual(stateCalls(wnd), [['fullscreen', 'add']]);

  await x11Root.unmount();
});

test('states, fullscreen and alwaysOnTop union rather than compete', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    React.createElement('window', {
      width: 100,
      height: 80,
      states: ['skip_taskbar', 'skip_pager'],
      fullscreen: true,
      alwaysOnTop: true,
    }),
  );
  await tick();

  assert.deepStrictEqual(
    stateCalls(app.windows[0])
      .map(([s]) => s)
      .sort(),
    ['above', 'fullscreen', 'skip_pager', 'skip_taskbar'],
    'the booleans are sugar over the same set, not a second channel',
  );
  // one message per name: EWMH carries two states per ClientMessage and
  // 'maximized' already uses both slots, so splitting by name is the only
  // chunking that cannot land a pair across a boundary
  for (const [name] of stateCalls(app.windows[0])) {
    assert.strictEqual(typeof name, 'string', 'one state per message');
  }

  await x11Root.unmount();
});

test('a state change sends only the difference, and only when props change', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const render = (states) =>
    x11Root.render(
      React.createElement('window', { width: 100, height: 80, states }),
    );
  render(['fullscreen', 'skip_taskbar']);
  await tick();
  const wnd = app.windows[0];

  // a re-render with an equal-but-fresh array must not re-send anything:
  // re-asserting every commit is exactly how a controlled prop would fight
  // a window manager that changed the state behind our back
  wnd.calls.length = 0;
  render(['fullscreen', 'skip_taskbar']);
  await tick();
  assert.deepStrictEqual(
    stateCalls(wnd),
    [],
    'unchanged states are not re-sent',
  );

  wnd.calls.length = 0;
  render(['fullscreen', 'above']);
  await tick();
  assert.deepStrictEqual(
    stateCalls(wnd).sort(),
    [
      ['above', 'add'],
      ['skip_taskbar', 'remove'],
    ],
    'only the difference, in both directions',
  );

  await x11Root.unmount();
});

test('onStatesChange reports what the window manager actually did', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const seen = [];
  x11Root.render(
    React.createElement('window', {
      width: 100,
      height: 80,
      fullscreen: true,
      onStatesChange: (states) => seen.push(states),
    }),
  );
  await tick();

  // the user hit the WM's un-fullscreen hotkey: reality diverges from the
  // prop, and the app hears about it rather than react-x11 forcing it back
  app.windows[0].emit('statechange', ['above']);
  await tick();
  assert.deepStrictEqual(seen, [['above']]);

  // and react-x11 does not re-assert 'fullscreen' in response
  const wnd = app.windows[0];
  wnd.calls.length = 0;
  await tick();
  assert.deepStrictEqual(stateCalls(wnd), [], 'the WM is not fought');

  await x11Root.unmount();
});

test('decorations={false} writes _MOTIF_WM_HINTS with its own type atom', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const render = (decorations) =>
    x11Root.render(
      React.createElement('window', { width: 100, height: 80, decorations }),
    );
  render(false);
  await tick();

  const wnd = app.windows[0];
  const motif = wnd.calls.find(([name]) => name === 'setProperty');
  assert.ok(motif, 'the hint was written');
  assert.deepStrictEqual(motif[1], '_MOTIF_WM_HINTS');
  assert.deepStrictEqual(motif[2], [2, 0, 0, 0, 0], 'flags=2, decorations=0');
  assert.strictEqual(
    motif[3].type,
    '_MOTIF_WM_HINTS',
    'the type atom is the property itself, not CARDINAL — a WM that checks ' +
      'the type ignores the hint otherwise',
  );
  assert.strictEqual(motif[3].format, 32);

  wnd.calls.length = 0;
  render(true);
  await tick();
  const back = wnd.calls.find(([name]) => name === 'setProperty');
  assert.deepStrictEqual(back[2], [2, 0, 1, 0, 0], 'decorations back on');

  await x11Root.unmount();
});
