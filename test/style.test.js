// The style channel: `style` carries the CSS-like vocabulary, props carry
// element semantics, and no name means both. Runs headless on the mock app
// from smoke.test.js.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import ReactX11 from '../src/index.js';
import { createStyles, flattenStyle } from '../src/styles.js';
import { createMockApp, pressButton, moveMouse } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const nodeOf = (app, index = 0) => app.windows[index]._reactX11Node;

test('flattenStyle: arrays flatten left-to-right, falsy entries skipped', () => {
  const base = { padding: 4, backgroundColor: 'red' };
  assert.strictEqual(flattenStyle(base), base, 'a lone object is not copied');
  assert.deepStrictEqual(
    flattenStyle([base, false, null, { backgroundColor: 'blue' }]),
    { padding: 4, backgroundColor: 'blue' },
    'later entries win',
  );
  assert.deepStrictEqual(
    flattenStyle([
      { ':hover': { color: 'red' } },
      { ':hover': { backgroundColor: 'blue' } },
    ]),
    { ':hover': { color: 'red', backgroundColor: 'blue' } },
    'state blocks merge rather than replace',
  );
});

test('createStyles rejects unknown properties and layout in state blocks', () => {
  assert.throws(
    () => createStyles({ a: { paddin: 4 } }),
    /unknown style property "paddin" in styles\.a/,
  );
  assert.throws(
    () => createStyles({ a: { ':hovr': {} } }),
    /unknown style state ":hovr"/,
  );
  assert.throws(
    () => createStyles({ a: { ':hover': { padding: 8 } } }),
    /"padding" is not allowed inside ":hover"/,
    'a state block that could reflow is refused at declaration time',
  );
  // paint properties are fine
  createStyles({ a: { ':hover': { backgroundColor: 'red', color: 'blue' } } });
});

test('style drives layout and paint; props stay semantic', async () => {
  const app = createMockApp();
  ReactX11.render(
    h(
      'window',
      { width: 200, height: 100, title: 'main' },
      h('box', { style: { flexGrow: 1, backgroundColor: '#123456' } }),
    ),
    null,
    app,
  );
  await tick();

  const box = nodeOf(app).children[0];
  assert.strictEqual(box.style.backgroundColor, '#123456');
  assert.ok(box.abs.height > 0, 'flexGrow from style reached yoga');
  assert.ok(
    app.windows[0].ctx.ops.some(
      ([op, , , , , color]) => op === 'fillRect' && color === '#123456',
    ) ||
      app.windows[0].ctx.ops.some(
        ([op, color]) => op === 'fill' && color === '#123456',
      ),
    'the background painted',
  );

  ReactX11.unmountComponentAtNode(app);
});

test('a hoisted style is skipped by identity on re-render', () => {
  const app = createMockApp();
  const s = createStyles({ box: { flexGrow: 1, backgroundColor: 'red' } });
  const render = (title) =>
    ReactX11.render(
      h(
        'window',
        { width: 200, height: 100, title },
        h('box', { style: s.box }),
      ),
      null,
      app,
    );

  render('a');
  const box = nodeOf(app).children[0];
  const first = box.style;
  render('b');
  assert.strictEqual(box.style, first, 'same object, no re-application');

  ReactX11.unmountComponentAtNode(app);
});

test(':hover resolves in the renderer — a repaint, not a React render', async () => {
  const app = createMockApp();
  let renders = 0;
  function Target() {
    renders++;
    return h('box', {
      style: {
        width: 40,
        height: 40,
        backgroundColor: 'white',
        ':hover': { backgroundColor: 'red' },
      },
    });
  }
  ReactX11.render(
    h('window', { width: 100, height: 100 }, h(Target)),
    null,
    app,
  );
  await tick();

  const wnd = app.windows[0];
  const box = nodeOf(app).children[0];
  const rendersBefore = renders;
  assert.strictEqual(box.style.backgroundColor, 'white');

  moveMouse(wnd, 20, 20);
  assert.strictEqual(box.style.backgroundColor, 'red', 'hover block applied');
  assert.strictEqual(box.states[':hover'], true);

  moveMouse(wnd, 90, 90);
  assert.strictEqual(box.style.backgroundColor, 'white', 'and comes back off');
  assert.strictEqual(
    renders,
    rendersBefore,
    'the component never re-rendered for a visual-only state change',
  );

  ReactX11.unmountComponentAtNode(app);
});

test(':hover applies up the ancestor chain, like CSS', async () => {
  const app = createMockApp();
  ReactX11.render(
    h(
      'window',
      { width: 100, height: 100 },
      h(
        'box',
        { style: { flexGrow: 1, ':hover': { backgroundColor: 'green' } } },
        h('box', { style: { width: 20, height: 20 } }),
      ),
    ),
    null,
    app,
  );
  await tick();

  const outer = nodeOf(app).children[0];
  moveMouse(app.windows[0], 5, 5); // over the inner box
  assert.strictEqual(
    outer.style.backgroundColor,
    'green',
    'hovering a child hovers its ancestors',
  );

  ReactX11.unmountComponentAtNode(app);
});

test(':active follows the press, :disabled wins over :hover', async () => {
  const app = createMockApp();
  const style = {
    width: 40,
    height: 40,
    backgroundColor: 'white',
    ':hover': { backgroundColor: 'red' },
    ':active': { backgroundColor: 'blue' },
    ':disabled': { backgroundColor: 'grey' },
  };
  const render = (disabled) =>
    ReactX11.render(
      h(
        'window',
        { width: 100, height: 100 },
        h('box', { style, disabled, focusable: true }),
      ),
      null,
      app,
    );

  render(false);
  await tick();
  const wnd = app.windows[0];
  const box = nodeOf(app).children[0];

  moveMouse(wnd, 20, 20);
  assert.strictEqual(box.style.backgroundColor, 'red');
  pressButton(wnd, 20, 20, { release: false });
  assert.strictEqual(box.style.backgroundColor, 'blue', ':active beats :hover');
  pressButton(wnd, 20, 20, { press: false });
  assert.strictEqual(box.style.backgroundColor, 'red', 'released');

  render(true);
  await tick();
  assert.strictEqual(
    box.style.backgroundColor,
    'grey',
    ':disabled beats everything below it',
  );

  ReactX11.unmountComponentAtNode(app);
});

test('<window>: width/height are the X window, style is the root box', async () => {
  const app = createMockApp();
  ReactX11.render(
    h('window', {
      width: 300,
      height: 200,
      minWidth: 120,
      minHeight: 80,
      style: { padding: 10, backgroundColor: 'white' },
    }),
    null,
    app,
  );
  await tick();

  const wnd = app.windows[0];
  assert.strictEqual(wnd.width, 300, 'geometry went to the real window');
  assert.deepStrictEqual(
    wnd.attributes.sizeHints,
    { minWidth: 120, minHeight: 80 },
    'size hints are flat props now — no sizeHints object at the call site',
  );
  const root = nodeOf(app);
  assert.strictEqual(
    root.style.width,
    undefined,
    'the window geometry never leaked into the style bag',
  );
  assert.strictEqual(root.style.padding, 10);

  ReactX11.unmountComponentAtNode(app);
});

test('a style-only <window> can still size its root box with style', async () => {
  const app = createMockApp();
  ReactX11.render(
    h(
      'window',
      { width: 300, height: 200, style: { flexDirection: 'row' } },
      h('box', { style: { width: 50, height: 20, backgroundColor: 'red' } }),
    ),
    null,
    app,
  );
  await tick();
  const box = nodeOf(app).children[0];
  assert.strictEqual(box.abs.width, 50);
  assert.strictEqual(box.abs.height, 20);
  ReactX11.unmountComponentAtNode(app);
});

test('REACT_X11_STYLE_ONLY: a flat style prop is an error that names the fix', async () => {
  // The end state, proven without converting all 16 components first: with
  // the flag on there is exactly one way to set a style property. Checked in
  // a child process because the flag is read at module load.
  const { execFileSync } = await import('node:child_process');
  const script = `
    import { BoxNode, WindowNode } from './src/nodes.js';
    import { createMockApp } from './test/helpers/mock-app.js';
    const app = createMockApp();
    try {
      new BoxNode({ padding: 8 }, app);
      console.log('NO ERROR');
    } catch (err) {
      console.log(err.message);
    }
    // <window width>/<window minWidth> are geometry and hints, not style,
    // so they stay legal — the collision this design removes
    new WindowNode(app, {}, { width: 100, height: 100, minWidth: 50, style: { padding: 8 } });
    console.log('window ok');
  `;
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { env: { ...process.env, REACT_X11_STYLE_ONLY: '1' }, encoding: 'utf8' },
  );
  assert.match(out, /<box padding=…> is a style property/);
  assert.match(out, /style=\{\{ padding: … \}\}/, 'the error shows the fix');
  assert.match(out, /window ok/, '<window width>/<window minWidth> stay props');
});
