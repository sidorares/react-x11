const { test } = require('node:test');
const assert = require('node:assert');
const React = require('react');
const ReactX11 = require('../src/index.js');

// A minimal stand-in for an ntk application object, so the renderer can be
// exercised without a running X server.
function createMockApp() {
  const app = {
    X: { display: { screen: [{ root: 1 }] } },
    windows: [],
    createWindow(attributes) {
      const wnd = {
        id: app.windows.length + 100,
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
        on() {},
      };
      app.windows.push(wnd);
      return wnd;
    },
  };
  return app;
}

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
