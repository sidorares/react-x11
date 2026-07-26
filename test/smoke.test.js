import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import ReactX11 from '../src/index.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

// A minimal stand-in for an ntk application object, so the renderer can be
// exercised without a running X server.
function createMockApp() {
  const app = {
    X: { display: { screen: [{ root: 1 }] }, keycode2keysyms: {} },
    windows: [],
    createWindow(attributes) {
      const handlers = {};
      const ops = [];
      const ctx = {
        ops,
        fillStyle: null,
        strokeStyle: null,
        lineWidth: 1,
        fillRect(x, y, w, h) {
          ops.push(['fillRect', x, y, w, h, ctx.fillStyle]);
        },
        beginPath() {},
        rect(x, y, w, h) {
          ops.push(['rect', x, y, w, h]);
        },
        roundRect(x, y, w, h, r) {
          ops.push(['roundRect', x, y, w, h, r]);
        },
        fill() {
          ops.push(['fill', ctx.fillStyle]);
        },
        stroke() {
          ops.push(['stroke', ctx.strokeStyle, ctx.lineWidth]);
        },
        clip() {
          ops.push(['clip']);
        },
        save() {
          ops.push(['save']);
        },
        restore() {
          ops.push(['restore']);
        },
        translate(x, y) {
          ops.push(['translate', x, y]);
        },
        setLineDash(segments) {
          ops.push(['setLineDash', segments]);
        },
        drawImage(...args) {
          ops.push(['drawImage']);
        },
      };
      const wnd = {
        id: app.windows.length + 100,
        X: app.X,
        attributes,
        x: attributes.x,
        y: attributes.y,
        width: attributes.width,
        height: attributes.height,
        title: attributes.title,
        mapped: false,
        destroyed: false,
        parent: null,
        calls: [],
        ctx,
        map() {
          wnd.mapped = true;
          wnd.calls.push(['map']);
        },
        unmap() {
          wnd.mapped = false;
          wnd.calls.push(['unmap']);
        },
        reparentTo(parent, x, y) {
          wnd.parent = parent;
          wnd.calls.push(['reparentTo', parent.id, x, y]);
        },
        destroy() {
          wnd.destroyed = true;
          wnd.calls.push(['destroy']);
        },
        resize(width, height) {
          wnd.width = width;
          wnd.height = height;
          wnd.calls.push(['resize', width, height]);
        },
        move(x, y) {
          wnd.x = x;
          wnd.y = y;
          wnd.calls.push(['move', x, y]);
        },
        setTitle(title) {
          wnd.title = title;
          wnd.calls.push(['setTitle', title]);
        },
        setCursor(name) {
          wnd.cursor = name;
          wnd.calls.push(['setCursor', name]);
        },
        getContext() {
          return ctx;
        },
        on(name, fn) {
          (handlers[name] ??= []).push(fn);
        },
        emit(name, ev) {
          for (const fn of handlers[name] ?? []) fn(ev);
        },
      };
      app.windows.push(wnd);
      return wnd;
    },
  };
  return app;
}

// Simulate an ntk keydown: registers the keysym for a synthetic keycode and
// emits the raw event shape the EventManager consumes.
function pressKey(app, wnd, { keysym, codepoint, buttons = 0 }) {
  const keycode = ((keysym ?? codepoint) % 248) + 8;
  app.X.keycode2keysyms[keycode] = [keysym ?? codepoint];
  wnd.emit('keydown', { keycode, codepoint, buttons });
}

const XK = {
  BackSpace: 0xff08,
  Return: 0xff0d,
  Left: 0xff51,
};

test('renders a top-level window with a child window', () => {
  const app = createMockApp();
  const element = React.createElement(
    'window',
    { width: 300, height: 200, title: 'main' },
    React.createElement('window', { width: 50, height: 50, x: 10, y: 10 }),
  );

  ReactX11.render(element, null, app);

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

  ReactX11.unmountComponentAtNode(app);
});

test('applies prop updates to the window', () => {
  const app = createMockApp();
  const render = (props) =>
    ReactX11.render(React.createElement('window', props), null, app);

  render({ width: 300, height: 200, title: 'before', x: 0, y: 0 });
  const wnd = app.windows[0];

  render({ width: 400, height: 250, title: 'after', x: 20, y: 30 });

  assert.strictEqual(app.windows.length, 1, 'window instance should be reused');
  assert.strictEqual(wnd.title, 'after');
  assert.deepStrictEqual([wnd.width, wnd.height], [400, 250]);
  assert.deepStrictEqual([wnd.x, wnd.y], [20, 30]);

  ReactX11.unmountComponentAtNode(app);
});

test('adds a child to an already-mounted window top-down', () => {
  const app = createMockApp();
  const render = (withChild) =>
    ReactX11.render(
      React.createElement(
        'window',
        { width: 300, height: 200 },
        withChild
          ? React.createElement('window', { width: 10, height: 10 })
          : null,
      ),
      null,
      app,
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

  ReactX11.unmountComponentAtNode(app);
});

test('destroys windows that are removed', () => {
  const app = createMockApp();
  const render = (withChild) =>
    ReactX11.render(
      React.createElement(
        'window',
        { width: 300, height: 200 },
        withChild
          ? React.createElement('window', { width: 10, height: 10 })
          : null,
      ),
      null,
      app,
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

  ReactX11.unmountComponentAtNode(app);
});

test('unmounting destroys the top-level window', () => {
  const app = createMockApp();
  ReactX11.render(
    React.createElement('window', { width: 100, height: 100 }),
    null,
    app,
  );
  const wnd = app.windows[0];

  ReactX11.unmountComponentAtNode(app);
  assert.strictEqual(wnd.destroyed, true);
});

test('function components and state-driven rendering work', () => {
  const app = createMockApp();
  function App({ title }) {
    return React.createElement('window', { width: 100, height: 100, title });
  }

  ReactX11.render(
    React.createElement(App, { title: 'fn component' }),
    null,
    app,
  );
  assert.strictEqual(app.windows[0].attributes.title, 'fn component');

  ReactX11.unmountComponentAtNode(app);
});

test('lays out a flex box tree with yoga and paints it', async () => {
  const app = createMockApp();
  ReactX11.render(
    React.createElement(
      'window',
      { width: 200, height: 100 },
      React.createElement(
        'box',
        { flexDirection: 'row', flexGrow: 1 },
        React.createElement('box', { flexGrow: 1, backgroundColor: 'red' }),
        React.createElement('box', { flexGrow: 1, backgroundColor: 'blue' }),
      ),
    ),
    null,
    app,
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

  ReactX11.unmountComponentAtNode(app);
});

test('updates reflow the tree', async () => {
  const app = createMockApp();
  const render = (direction) =>
    ReactX11.render(
      React.createElement(
        'window',
        { width: 200, height: 100 },
        React.createElement(
          'box',
          { flexDirection: direction, flexGrow: 1 },
          React.createElement('box', { flexGrow: 1 }),
          React.createElement('box', { flexGrow: 1 }),
        ),
      ),
      null,
      app,
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

  ReactX11.unmountComponentAtNode(app);
});

test('dispatches synthetic clicks, hover and focus events', async () => {
  const app = createMockApp();
  const log = [];
  ReactX11.render(
    React.createElement(
      'window',
      { width: 200, height: 100 },
      React.createElement(
        'box',
        { flexDirection: 'row', flexGrow: 1, onClick: () => log.push('outer') },
        React.createElement('box', {
          flexGrow: 1,
          focusable: true,
          onClick: (ev) => {
            log.push(['left', ev.localX, ev.localY]);
            ev.stopPropagation();
          },
          onMouseEnter: () => log.push('enter-left'),
          onMouseLeave: () => log.push('leave-left'),
          onFocus: () => log.push('focus-left'),
        }),
        React.createElement('box', { flexGrow: 1 }),
      ),
    ),
    null,
    app,
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

  ReactX11.unmountComponentAtNode(app);
});

test('zIndex controls hit testing order', async () => {
  const app = createMockApp();
  const log = [];
  ReactX11.render(
    React.createElement(
      'window',
      { width: 100, height: 100 },
      React.createElement('box', {
        position: 'absolute',
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        zIndex: 2,
        onClick: () => log.push('top'),
      }),
      React.createElement('box', {
        position: 'absolute',
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        onClick: () => log.push('bottom'),
      }),
    ),
    null,
    app,
  );
  await tick();
  const wnd = app.windows[0];
  wnd.emit('mousedown', { x: 50, y: 50, keycode: 1 });
  wnd.emit('mouseup', { x: 50, y: 50, keycode: 1 });

  assert.deepStrictEqual(log, ['top']);
  ReactX11.unmountComponentAtNode(app);
});

test('scrollview scrolls, clamps and offsets hit testing', async () => {
  const app = createMockApp();
  const clicks = [];
  ReactX11.render(
    React.createElement(
      'window',
      { width: 100, height: 100 },
      React.createElement(
        'scrollview',
        { flexGrow: 1 },
        [0, 1, 2].map((i) =>
          React.createElement('box', {
            key: i,
            height: 60,
            onClick: () => clicks.push(i),
          }),
        ),
      ),
    ),
    null,
    app,
  );
  await tick();
  const wnd = app.windows[0];
  const sv = wnd._reactX11Node.children[0];

  assert.strictEqual(sv.contentHeight, 180);
  assert.strictEqual(sv.children[1].abs.y, 60);

  // wheel down (X button 5) scrolls by default
  wnd.emit('mousedown', { x: 50, y: 50, keycode: 5 });
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

  ReactX11.unmountComponentAtNode(app);
});

test('popup mounts as an override-redirect window and unmounts cleanly', () => {
  const app = createMockApp();
  const render = (open) =>
    ReactX11.render(
      React.createElement(
        'window',
        { width: 200, height: 100 },
        React.createElement(
          'box',
          { flexGrow: 1 },
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
      null,
      app,
    );

  render(false);
  assert.strictEqual(app.windows.length, 1);

  render(true);
  assert.strictEqual(app.windows.length, 2);
  const popup = app.windows[1];
  assert.strictEqual(popup.attributes.overrideRedirect, true);
  assert.deepStrictEqual([popup.attributes.x, popup.attributes.y], [300, 150]);
  assert.strictEqual(popup.mapped, true);

  render(false);
  assert.strictEqual(popup.destroyed, true);

  ReactX11.unmountComponentAtNode(app);
});

test('cursor prop follows hover (feature-detected setCursor)', async () => {
  const app = createMockApp();
  ReactX11.render(
    React.createElement(
      'window',
      { width: 200, height: 100 },
      React.createElement(
        'box',
        { flexDirection: 'row', flexGrow: 1 },
        React.createElement('box', { flexGrow: 1, cursor: 'pointer' }),
        React.createElement('box', { flexGrow: 1 }),
      ),
    ),
    null,
    app,
  );
  await tick();
  const wnd = app.windows[0];

  wnd.emit('mousemove', { x: 10, y: 10 });
  assert.strictEqual(wnd.cursor, 'pointer');

  wnd.emit('mousemove', { x: 150, y: 10 });
  assert.strictEqual(wnd.cursor, null, 'leaving the node restores the cursor');

  ReactX11.unmountComponentAtNode(app);
});

test('textinput: typing, backspace, arrows, submit (uncontrolled)', async () => {
  const app = createMockApp();
  const changes = [];
  let submitted = null;
  ReactX11.render(
    React.createElement(
      'window',
      { width: 200, height: 50 },
      React.createElement('textinput', {
        defaultValue: '',
        flexGrow: 1,
        onChange: (v) => changes.push(v),
        onSubmit: (v) => (submitted = v),
      }),
    ),
    null,
    app,
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

  ReactX11.unmountComponentAtNode(app);
});

test('textinput: controlled value does not change until props do', async () => {
  const app = createMockApp();
  const changes = [];
  const render = (value) =>
    ReactX11.render(
      React.createElement(
        'window',
        { width: 200, height: 50 },
        React.createElement('textinput', {
          value,
          flexGrow: 1,
          onChange: (v) => changes.push(v),
        }),
      ),
      null,
      app,
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

  ReactX11.unmountComponentAtNode(app);
});

test('textinput: clipboard shortcuts and middle-click PRIMARY paste', async () => {
  const app = createMockApp();
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
  ReactX11.render(
    React.createElement(
      'window',
      { width: 200, height: 50 },
      React.createElement('textinput', { defaultValue: 'hello', flexGrow: 1 }),
    ),
    null,
    app,
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

  ReactX11.unmountComponentAtNode(app);
});

test('dashed borders emit setLineDash when the context supports it', async () => {
  const app = createMockApp();
  ReactX11.render(
    React.createElement(
      'window',
      { width: 100, height: 100 },
      React.createElement('box', {
        flexGrow: 1,
        borderWidth: 2,
        borderColor: 'black',
        borderStyle: 'dashed',
      }),
    ),
    null,
    app,
  );
  await tick();
  const dashOps = app.windows[0].ctx.ops.filter(([op]) => op === 'setLineDash');
  assert.deepStrictEqual(dashOps[0], ['setLineDash', [6, 4]]);
  assert.deepStrictEqual(dashOps.at(-1), ['setLineDash', []]);

  ReactX11.unmountComponentAtNode(app);
});

test('text spans collect nested styles', () => {
  const app = createMockApp();
  ReactX11.render(
    React.createElement(
      'window',
      { width: 100, height: 100 },
      React.createElement(
        'text',
        { color: 'black', fontSize: 12 },
        'Hello ',
        React.createElement(
          'text',
          { color: 'red', fontWeight: 'bold' },
          'world',
        ),
      ),
    ),
    null,
    app,
  );

  const textNode = app.windows[0]._reactX11Node.children[0];
  const spans = textNode.collectSpans(
    {
      family: 'sans-serif',
      size: 14,
      weight: 'normal',
      style: 'normal',
      color: 'black',
    },
    [],
  );
  assert.strictEqual(spans.length, 2);
  assert.deepStrictEqual(
    [spans[0].text, spans[0].size, spans[0].color],
    ['Hello ', 12, 'black'],
  );
  assert.deepStrictEqual(
    [spans[1].text, spans[1].weight, spans[1].color],
    ['world', 'bold', 'red'],
  );

  ReactX11.unmountComponentAtNode(app);
});
