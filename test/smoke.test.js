import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import ReactX11 from '../src/index.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

// A minimal stand-in for an ntk application object, so the renderer can be
// exercised without a running X server.
function createMockApp() {
  const app = {
    X: {
      display: { screen: [{ root: 1 }] },
      keycode2keysyms: {},
      InternAtom(onlyIfExists, name, cb) {
        cb(null, name === 'WM_DELETE_WINDOW' ? 999 : 1);
      },
    },
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
        moveTo(x, y) {
          ops.push(['moveTo', x, y]);
        },
        lineTo(x, y) {
          ops.push(['lineTo', x, y]);
        },
        closePath() {
          ops.push(['closePath']);
        },
        drawImage(...args) {
          ops.push(['drawImage']);
        },
        // enough of the canvas surface for SvgView.draw to run headlessly
        scale(sx, sy) {
          ops.push(['scale', sx, sy]);
        },
        transform() {},
        setTransform() {},
        getTransform() {
          return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        },
        arc() {},
        ellipse() {},
        bezierCurveTo() {},
        quadraticCurveTo() {},
        createLinearGradient() {
          return { addColorStop() {} };
        },
        createRadialGradient() {
          return { addColorStop() {} };
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
        setSizeHints(hints) {
          wnd.calls.push(['setSizeHints', hints]);
        },
        setClass(instance, className) {
          wnd.calls.push(['setClass', instance, className]);
        },
        setWindowType(type) {
          wnd.calls.push(['setWindowType', type]);
        },
        setAlwaysOnTop(on) {
          wnd.calls.push(['setAlwaysOnTop', on]);
        },
        setActions() {
          wnd.calls.push(['setActions']);
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

test('scrollview scrollIntoView scrolls the minimum amount', async () => {
  const app = createMockApp();
  ReactX11.render(
    React.createElement(
      'window',
      { width: 100, height: 100 },
      React.createElement(
        'scrollview',
        { flexGrow: 1 },
        [0, 1, 2].map((i) =>
          React.createElement('box', { key: i, height: 60 }),
        ),
      ),
    ),
    null,
    app,
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

  // a node outside this scrollview is ignored
  sv.scrollIntoView(app.windows[0]._reactX11Node);
  await tick();
  assert.strictEqual(sv.scrollY, 0);

  ReactX11.unmountComponentAtNode(app);
});

test('window manager hints pass through at creation and on update', () => {
  const app = createMockApp();
  const render = (props) =>
    ReactX11.render(
      React.createElement('window', { width: 200, height: 100, ...props }),
      null,
      app,
    );

  // creation goes through ntk's Window constructor as creation attributes
  render({
    resizable: false,
    wmClass: ['react-x11', 'React-X11'],
    windowType: 'dialog',
    sizeHints: { minWidth: 120 },
  });
  const wnd = app.windows[0];
  assert.strictEqual(wnd.attributes.resizable, false);
  assert.deepStrictEqual(wnd.attributes.wmClass, ['react-x11', 'React-X11']);
  assert.strictEqual(wnd.attributes.windowType, 'dialog');
  assert.deepStrictEqual(wnd.attributes.sizeHints, { minWidth: 120 });

  const hintCalls = () =>
    wnd.calls.filter(([name]) => name.startsWith('set') && name !== 'setTitle');

  // a re-render with identical hints must not re-send them: sizeHints is an
  // inline object literal, so identity changes every render
  wnd.calls.length = 0;
  render({
    resizable: false,
    wmClass: ['react-x11', 'React-X11'],
    windowType: 'dialog',
    sizeHints: { minWidth: 120 },
  });
  assert.deepStrictEqual(hintCalls(), [], 'unchanged hints are not re-sent');

  // changing one hint sends only that one
  wnd.calls.length = 0;
  render({
    resizable: false,
    wmClass: ['react-x11', 'React-X11'],
    windowType: 'dialog',
    sizeHints: { minWidth: 300, maxWidth: 900 },
  });
  assert.deepStrictEqual(hintCalls(), [
    ['setSizeHints', { minWidth: 300, maxWidth: 900, resizable: false }],
  ]);

  // alwaysOnTop toggles both ways
  wnd.calls.length = 0;
  render({ alwaysOnTop: true });
  assert.ok(
    wnd.calls.some(([name, on]) => name === 'setAlwaysOnTop' && on === true),
    'setAlwaysOnTop(true) on enable',
  );

  wnd.calls.length = 0;
  render({ alwaysOnTop: false });
  assert.ok(
    wnd.calls.some(([name, on]) => name === 'setAlwaysOnTop' && on === false),
    'setAlwaysOnTop(false) on disable',
  );

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
  // the EWMH type hint is additive — override-redirect still keeps the WM
  // from moving or decorating the menu; the hint only lets compositing
  // managers style it consistently (wm-spec asks for it on o-r windows)
  assert.strictEqual(popup.attributes.windowType, 'dropdown_menu');
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

test('textinput: double-click selects word, triple-click selects all', async () => {
  const app = createMockApp();
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
  ReactX11.render(
    React.createElement(
      'window',
      { width: 200, height: 50 },
      React.createElement('textinput', {
        defaultValue: 'hello world',
        flexGrow: 1,
      }),
    ),
    null,
    app,
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

  ReactX11.unmountComponentAtNode(app);
});

test('Select opens a popup menu, picks an option, closes on Escape', async () => {
  const { Select } = await import('../src/index.js');
  const app = createMockApp();
  const picks = [];
  ReactX11.render(
    React.createElement(
      'window',
      { width: 240, height: 120 },
      React.createElement(
        'box',
        { flexGrow: 1, padding: 10 },
        React.createElement(Select, {
          options: ['red', 'green', 'blue'],
          value: null,
          width: 160,
          onChange: (v) => picks.push(v),
        }),
      ),
    ),
    null,
    app,
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

  ReactX11.unmountComponentAtNode(app);
});

test('Select: arrow keys move the active option, Enter picks it', async () => {
  const { Select } = await import('../src/index.js');
  const XK_DOWN = 0xff54;
  const XK_UP = 0xff52;
  const XK_HOME = 0xff50;
  const XK_END = 0xff57;
  const HOVER_BG = '#2980b9';

  const app = createMockApp();
  const picks = [];
  ReactX11.render(
    React.createElement(
      'window',
      { width: 240, height: 120 },
      React.createElement(
        'box',
        { flexGrow: 1, padding: 10 },
        React.createElement(Select, {
          options: ['red', 'green', 'blue'],
          value: 'green',
          width: 160,
          onChange: (v) => picks.push(v),
        }),
      ),
    ),
    null,
    app,
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
      if (n.kind === 'scrollview') scroller = n;
      else n.children.forEach(walk);
    };
    walk(popup._reactX11Node);
    return scroller.children.findIndex(
      (o) => o.props.backgroundColor === HOVER_BG,
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

  ReactX11.unmountComponentAtNode(app);
});

test('Select: an overlong menu scrolls the active option into view', async () => {
  const { Select } = await import('../src/index.js');
  const XK_DOWN = 0xff54;
  const XK_END = 0xff57;
  const ITEM_HEIGHT = 28;
  const options = Array.from({ length: 12 }, (_, i) => `option-${i}`);

  const app = createMockApp();
  ReactX11.render(
    React.createElement(
      'window',
      { width: 300, height: 120 },
      React.createElement(
        'box',
        { flexGrow: 1, padding: 10 },
        React.createElement(Select, { options, value: options[0], width: 220 }),
      ),
    ),
    null,
    app,
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
      if (n.kind === 'scrollview') found = n;
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
  const visible = Math.floor((scroller.abs.height - 4) / ITEM_HEIGHT);
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
    4 + options.length * ITEM_HEIGHT - scroller.abs.height,
  );

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

test('DevTools agent highlight tints the hovered node', async () => {
  const { EventEmitter } = await import('node:events');
  const { attachHighlightAgent } =
    await import('../src/DevToolsIntegration.js');
  const app = createMockApp();
  ReactX11.render(
    React.createElement(
      'window',
      { width: 200, height: 100 },
      React.createElement(
        'box',
        { flexDirection: 'row', flexGrow: 1 },
        React.createElement('box', { flexGrow: 1 }),
        React.createElement('box', { flexGrow: 1, backgroundColor: 'blue' }),
      ),
    ),
    null,
    app,
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

  ReactX11.unmountComponentAtNode(app);
});

test('rich content elements mount, update and unmount headlessly', async () => {
  const app = createMockApp();
  const ui = (md) =>
    React.createElement(
      'window',
      { width: 400, height: 300 },
      React.createElement('markdown', null, md), // string child (react-markdown style)
      React.createElement('html', { source: '<p>hello</p>' }),
      React.createElement(
        'svg',
        { viewBox: '0 0 10 10', width: 20, height: 20 },
        React.createElement('rect', { width: 10, height: 10, fill: '#f00' }),
      ),
      React.createElement('svg', {
        source: '<svg viewBox="0 0 10 10"><circle r="5" fill="#00f"/></svg>',
      }),
      React.createElement('tex', { size: 20 }, 'x^2'),
    );

  ReactX11.render(ui('# One'), null, app);
  await tick(); // paint flush: no fonts on the mock app, must not throw
  const [wnd] = app.windows;
  assert.ok(wnd.mapped, 'window mounted with rich content children');

  ReactX11.render(ui('# Two'), null, app);
  await tick();

  ReactX11.unmountComponentAtNode(app);
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
  const presses = [];
  ReactX11.render(
    React.createElement(
      'window',
      { width: 300, height: 200 },
      React.createElement(
        'box',
        { flexGrow: 1, padding: 10, gap: 10, alignItems: 'flex-start' },
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
    null,
    app,
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
  ReactX11.unmountComponentAtNode(app);
});

test('Checkbox and Switch toggle through onChange', async () => {
  const { Checkbox, Switch } = await import('../src/index.js');
  const app = createMockApp();
  const log = [];
  function Wrapper() {
    const [checked, setChecked] = React.useState(false);
    const [on, setOn] = React.useState(false);
    return React.createElement(
      'box',
      { flexGrow: 1, padding: 10, gap: 10, alignItems: 'flex-start' },
      React.createElement(
        Checkbox,
        {
          checked,
          onChange: (next) => {
            log.push(['check', next]);
            setChecked(next);
          },
        },
        'Enable',
      ),
      React.createElement(Switch, {
        checked: on,
        onChange: (next) => {
          log.push(['switch', next]);
          setOn(next);
        },
      }),
    );
  }
  ReactX11.render(
    React.createElement(
      'window',
      { width: 300, height: 200 },
      React.createElement(Wrapper),
    ),
    null,
    app,
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
  ReactX11.unmountComponentAtNode(app);
});

test('RadioGroup: click selects, arrow keys move selection (wrapping)', async () => {
  const { Radio, RadioGroup } = await import('../src/index.js');
  const app = createMockApp();
  const picks = [];
  function Wrapper() {
    const [value, setValue] = React.useState('a');
    return React.createElement(
      RadioGroup,
      {
        value,
        onChange: (v) => {
          picks.push(v);
          setValue(v);
        },
      },
      React.createElement(Radio, { value: 'a' }, 'A'),
      React.createElement(Radio, { value: 'b' }, 'B'),
      React.createElement(Radio, { value: 'c' }, 'C'),
    );
  }
  ReactX11.render(
    React.createElement(
      'window',
      { width: 300, height: 200 },
      React.createElement(Wrapper),
    ),
    null,
    app,
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
  ReactX11.unmountComponentAtNode(app);
});

test('ProgressBar fill width follows value', async () => {
  const { ProgressBar } = await import('../src/index.js');
  const app = createMockApp();
  ReactX11.render(
    React.createElement(
      'window',
      { width: 300, height: 100 },
      React.createElement(
        'box',
        { flexGrow: 1, padding: 0 },
        React.createElement(ProgressBar, { value: 0.5, width: 200 }),
      ),
    ),
    null,
    app,
  );
  await tick();
  const wnd = app.windows[0];
  const track = (function find(n) {
    if (n.props?.overflow === 'hidden' && n.kind === 'box') return n;
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
  ReactX11.unmountComponentAtNode(app);
});

test('multiple root windows share one tree; onCloseRequest handles WM close', async () => {
  const app = createMockApp();
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
  ReactX11.render(React.createElement(Wrapper), null, app);
  await tick();
  assert.strictEqual(app.windows.length, 2, 'two real top-level windows');
  const sat = app.windows[1];
  assert.ok(
    sat.calls.some((c) => c[0] === 'setActions'),
    'onCloseRequest opts the window into WM_DELETE_WINDOW',
  );

  // WM close button: ClientMessage with data[0] = WM_DELETE_WINDOW atom
  sat.emit('message', { format: 32, data: [999, 0, 0, 0, 0] });
  await tick();
  assert.deepStrictEqual(events, ['sat-close']);
  assert.strictEqual(
    sat.destroyed,
    true,
    'unmounting the closed <window> destroys the real window',
  );
  assert.strictEqual(app.windows[0].destroyed, false, 'main window stays');

  // unrelated client messages do not fire the handler
  app.windows[0].emit('message', { format: 32, data: [123, 0, 0, 0, 0] });
  await tick();
  assert.deepStrictEqual(events, ['sat-close']);

  ReactX11.unmountComponentAtNode(app);
});

test('Slider: drag keeps tracking after the pointer leaves the widget', async () => {
  const { Slider } = await import('../src/index.js');
  const app = createMockApp();
  const seen = [];
  const Host = () => {
    const [v, setV] = React.useState(0);
    seen.push(v);
    return React.createElement(
      'window',
      { width: 400, height: 120 },
      React.createElement(
        'box',
        { flexGrow: 1, padding: 20 },
        React.createElement(Slider, {
          value: v,
          min: 0,
          max: 100,
          step: 1,
          width: 200,
          onChange: setV,
        }),
      ),
    );
  };
  ReactX11.render(React.createElement(Host), null, app);
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

  // press at the middle -> 50
  wnd.emit('mousedown', { x: atFraction(0.5), y: cy, keycode: 1 });
  await tick();
  assert.strictEqual(seen.at(-1), 50, 'press sets the value under the pointer');

  // drag while still inside
  wnd.emit('mousemove', { x: atFraction(0.25), y: cy });
  await tick();
  assert.strictEqual(seen.at(-1), 25);

  // pointer leaves the widget entirely (far below and to the right).
  // without pointer capture this would dispatch to whatever is under the
  // pointer and the slider would stop following.
  wnd.emit('mousemove', { x: atFraction(0.9), y: cy + 400 });
  await tick();
  assert.strictEqual(seen.at(-1), 90, 'still tracking outside the widget');

  // and clamps past the ends
  wnd.emit('mousemove', { x: x - 500, y: cy });
  await tick();
  assert.strictEqual(seen.at(-1), 0, 'clamps at min');

  // release out of bounds ends the drag; later moves are ignored
  wnd.emit('mouseup', { x: x - 500, y: cy, keycode: 1 });
  await tick();
  const afterRelease = seen.at(-1);
  wnd.emit('mousemove', { x: atFraction(0.75), y: cy });
  await tick();
  assert.strictEqual(seen.at(-1), afterRelease, 'no tracking after release');

  ReactX11.unmountComponentAtNode(app);
});

test('Slider: keyboard steps, Home/End and PageUp/Down', async () => {
  const { Slider } = await import('../src/index.js');
  const app = createMockApp();
  let current = 50;
  const Host = () => {
    const [v, setV] = React.useState(50);
    current = v;
    return React.createElement(
      'window',
      { width: 300, height: 100 },
      React.createElement(
        'box',
        { flexGrow: 1, padding: 10 },
        React.createElement(Slider, {
          value: v,
          min: 0,
          max: 100,
          step: 2,
          width: 200,
          onChange: setV,
        }),
      ),
    );
  };
  ReactX11.render(React.createElement(Host), null, app);
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

  ReactX11.unmountComponentAtNode(app);
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
    ReactX11.render(
      React.createElement(
        'window',
        { width: 400, height: 100 },
        React.createElement(
          'box',
          { flexGrow: 1, padding: 20 },
          React.createElement(Slider, { value, min: 0, max: 100, width: 200 }),
        ),
      ),
      null,
      app,
    );
    await tick();
    const track = findTrack(app.windows[0]._reactX11Node);
    const thumb = track.children.find((c) => c.props.position === 'absolute');
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
    ReactX11.unmountComponentAtNode(app);
  }
});
