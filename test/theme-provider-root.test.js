// A `<ThemeProvider>` written above the windows (issue #584).
//
// A `$token` resolves by walking the node tree, so a provider has to put its
// palette on a node. Inside a window that node is a `<box>`. Above the windows
// it cannot be — nothing drawn may sit at the root, and a window cannot be
// nested in a box — so the provider used to plant the palette on the windows
// it found among its children. It found only literal `<window>` elements: a
// component that renders the window, a window that is closed for now and a
// fragment of two all planted a box at the root, which failed as
// `child.realize is not a function` or as a window nested in a box nobody
// wrote. `<ThemeProvider><App/></ThemeProvider>` is the ordinary shape of an
// app, and it was the one that did not work.
//
// The provider's node is now decided by the renderer, which knows where it is
// (`createInstance`, host context): at the root it is a `ThemeScopeNode` that
// draws nothing and hands the palette to the windows under it
// (nodes/scope.js). These tests are the shapes from the issue, the things the
// scope takes over from a real parent — hiding, a swap, unmounting — and the
// messages that replace the two above.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import React from 'react';

import { Button, createRoot, ThemeProvider } from '../src/index.js';
import { ThemeScopeNode } from '../src/nodes/scope.js';
import { windowAttributes } from '../src/nodes/window/hints.js';
import { WindowNode } from '../src/nodes/window/window.js';
import { cleanup, countPixels, renderX11 } from '../src/testing/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const require = createRequire(import.meta.url);
const fonts = {
  'sans-serif': join(
    dirname(require.resolve('katex/package.json')),
    'dist',
    'fonts',
    'KaTeX_Main-Regular.ttf',
  ),
};

afterEach(cleanup);

/** `React.act` with the flag that says this is a test — and a few turns
 * after it, for the frame the commit scheduled. */
async function act(fn) {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await React.act(async () => fn());
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  for (let i = 0; i < 4; i++) await tick();
}

const BRAND = { accent: '#c03030', background: '#20242c' };

/** A window whose one child paints the accent token — the node-tree route,
 * which only a palette that reached the window can feed. */
function Painted({ title = 'painted', width = 120 }) {
  return h(
    'window',
    { title, width, height: 60 },
    h('box', { style: { flexGrow: 1, backgroundColor: '$accent' } }),
  );
}

/** Render `tree` into a mock app; any throw — from render or reported as
 * uncaught — is collected rather than lost. */
async function mount(tree) {
  const app = createMockApp();
  const errors = [];
  const root = await createRoot({
    app,
    onUncaughtError: (error) => errors.push(error),
  });
  try {
    root.render(tree);
  } catch (error) {
    errors.push(error);
  }
  await tick();
  return { app, root, errors };
}

/** The top-level window nodes, in the order the container lists them. */
const tops = (app) => app._rootChildren ?? [];

test('a provider above a component that renders the window hands the window its palette', async () => {
  // the issue's third row, and the shape nearly every app has
  const { app, root, errors } = await mount(
    h(ThemeProvider, { value: BRAND, colorScheme: 'light' }, h(Painted)),
  );
  assert.deepEqual(errors, []);
  const [win] = tops(app);
  assert.equal(win.kind, 'window');
  assert.equal(win.parent, null, 'still a top-level window, not a nested one');
  assert.equal(win.theme.accent, BRAND.accent);
  assert.equal(win.children[0].style.backgroundColor, BRAND.accent);
  // the floor under the cascade is read from the window, so it is the
  // provider's too — not only what a `$token` names
  assert.equal(win._windowBackground(), BRAND.background);
  await root.unmount();
});

test('the palette reaches the pixels, through the harness, with no window of its own', async () => {
  // `wrap: false` is the harness's answer for "my component renders the
  // window" — and a provider above it used to be the thing that broke it
  const api = await renderX11(
    h(
      ThemeProvider,
      { value: { accent: '#10a050' }, colorScheme: 'light' },
      h(Painted, { width: 40 }),
    ),
    { wrap: false, fonts },
  );
  assert.equal(api.windowNode.kind, 'window');
  const green = await countPixels(
    api.ctx,
    { width: 40, height: 60 },
    '#10a050',
  );
  assert.equal(green, 40 * 60, 'the whole window is the provider’s accent');
});

test('a window that is closed for now mounts nothing, and gets the palette when it opens', async () => {
  let setOpen;
  function App() {
    const [open, set] = React.useState(false);
    setOpen = set;
    return h(ThemeProvider, { value: BRAND }, open && h(Painted));
  }
  const { app, root, errors } = await mount(h(App));
  assert.deepEqual(errors, [], 'a provider around nothing is not an error');
  assert.equal(tops(app).length, 0);

  await act(() => setOpen(true));
  assert.equal(tops(app).length, 1);
  assert.equal(tops(app)[0].children[0].style.backgroundColor, BRAND.accent);

  await act(() => setOpen(false));
  assert.equal(tops(app).length, 0, 'closing it takes it off the list');
  assert.equal(app.windows.at(-1).destroyed, true, 'and destroys it');
  await root.unmount();
});

test('several windows at once — a fragment, a component, nested providers — each take the palette', async () => {
  const { app, root, errors } = await mount(
    h(
      ThemeProvider,
      { value: { accent: '#111111', text: '#222222' } },
      h(
        React.Fragment,
        null,
        h('window', { title: 'a', width: 50, height: 50 }),
        h(Painted, { title: 'b' }),
      ),
      h(
        ThemeProvider,
        { value: { accent: '#333333' } },
        h(Painted, { title: 'c' }),
      ),
    ),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(
    tops(app).map((w) => w.props.title),
    ['a', 'b', 'c'],
    'the container lists the windows, never the providers’ nodes',
  );
  const [a, b, c] = tops(app);
  assert.equal(a.theme.accent, '#111111');
  assert.equal(b.children[0].style.backgroundColor, '#111111');
  assert.equal(c.theme.accent, '#333333', 'the inner provider wins');
  assert.equal(c.theme.text, '#222222', 'and keeps what it did not set');
  await root.unmount();
  assert.equal(tops(app).length, 0);
});

test('a new palette restyles the windows in place, without remounting them', async () => {
  let setAccent;
  function App() {
    const [accent, set] = React.useState('#aa0000');
    setAccent = set;
    return h(ThemeProvider, { value: { accent } }, h(Painted));
  }
  const { app, root } = await mount(h(App));
  const [win] = tops(app);
  const id = win.window.id;
  const { ops } = win.window.ctx;
  ops.length = 0;

  await act(() => setAccent('#00aa00'));
  assert.equal(tops(app)[0], win, 'the same node');
  assert.equal(win.window.id, id, 'and the same window');
  assert.equal(win.children[0].style.backgroundColor, '#00aa00');
  assert.ok(
    ops.some((op) => op.includes('#00aa00')),
    'a live swap repaints in the new accent',
  );
  await root.unmount();
});

test('React hiding the provider hides its windows, and an inner hide survives an outer reveal', async () => {
  let setOuter;
  let setInner;
  let setLate;
  function App() {
    const [outer, so] = React.useState('visible');
    const [inner, si] = React.useState('visible');
    const [late, sl] = React.useState(false);
    setOuter = so;
    setInner = si;
    setLate = sl;
    return h(
      React.Activity,
      { mode: outer },
      h(
        ThemeProvider,
        { value: BRAND },
        h(Painted, { title: 'plain' }),
        h(React.Activity, { mode: inner }, h(Painted, { title: 'inner' })),
        late && h(Painted, { title: 'late' }),
      ),
    );
  }
  const { app, root } = await mount(h(App));
  const byTitle = (title) => tops(app).find((w) => w.props.title === title);
  const plain = byTitle('plain');
  const inner = byTitle('inner');
  assert.equal(plain.window.mapped, true);

  await act(() => setOuter('hidden'));
  assert.equal(plain.hidden, true, 'the scope’s hide reaches the window');
  assert.equal(plain.window.mapped, false);
  assert.equal(inner.window.mapped, false);

  // React hid the scope, not what is under it, so a window mounted into it
  // now is hidden by nothing React will call — the scope has to say so
  await act(() => setLate(true));
  const late = byTitle('late');
  assert.equal(late.hidden, true, 'born inside a hidden scope');
  assert.equal(late.window.mapped, false);

  await act(() => setInner('hidden'));
  await act(() => setOuter('visible'));
  assert.equal(plain.window.mapped, true, 'revealed with the scope');
  assert.equal(late.window.mapped, true, 'and so is the one born hidden');
  assert.equal(inner.hidden, true, 'still hidden by its own boundary');
  assert.equal(inner.window.mapped, false);

  await act(() => setInner('visible'));
  assert.equal(inner.window.mapped, true);
  await root.unmount();
});

test('a window put under a scope that is already hidden is hidden, whoever put it there', () => {
  // Through React this is also covered by React itself, which hides the
  // scope again on every commit into a hidden <Activity> — so the scope's
  // own rule is pinned here, with nothing else acting.
  const app = createMockApp();
  const scope = new ThemeScopeNode({ theme: BRAND }, app);
  scope.setHidden(true);
  const props = { title: 'late', width: 40, height: 40 };
  const win = new WindowNode(app, windowAttributes(props, 1), props);
  scope.insertBefore(win, null);
  assert.equal(win.hidden, true);
  scope.setHidden(false);
  assert.equal(win.hidden, false);
});

test('a keyed reorder at the root lists each window once', async () => {
  let setOrder;
  function App() {
    const [order, set] = React.useState(['a', 'b']);
    setOrder = set;
    const windows = order.map((title) =>
      h('window', { key: title, title, width: 40, height: 40 }),
    );
    return h(
      React.Fragment,
      null,
      windows,
      h(
        ThemeProvider,
        { value: BRAND },
        order.map((title) => h(Painted, { key: title, title: `${title}!` })),
      ),
    );
  }
  const { app, root, errors } = await mount(h(App));
  const count = () => tops(app).length;
  assert.equal(count(), 4);

  await act(() => setOrder(['b', 'a']));
  assert.deepEqual(errors, []);
  assert.equal(count(), 4, 'a move is not a second mount');
  assert.equal(new Set(tops(app)).size, 4);
  await root.unmount();
});

test('the windows under a root provider are toplevels to assistive technology', async () => {
  const api = await renderX11(
    h(
      ThemeProvider,
      { value: BRAND },
      h(
        'window',
        { title: 'a11y', width: 120, height: 60 },
        h(Button, { onPress() {} }, 'Save'),
      ),
    ),
    { wrap: false, a11y: true },
  );
  assert.deepEqual(
    api.at.focusables().map((stop) => stop.utterance),
    ['Save, button'],
  );
});

test('a drawn element at the root says it must be inside a window', async () => {
  for (const [tree, element] of [
    [h('box'), '<box>'],
    [h('text', null, 'hi'), '<text>'],
    // a provider draws nothing up there, so it changes nothing about this
    [h(ThemeProvider, { value: BRAND }, h('box')), '<box>'],
  ]) {
    const { errors, root } = await mount(tree);
    assert.equal(errors.length, 1, `one error for ${element}`);
    assert.match(
      errors[0].message,
      new RegExp(`^react-x11: ${element} must be inside a <window>`),
    );
    assert.doesNotMatch(errors[0].message, /realize/);
    await root.unmount();
  }
  const { errors, root } = await mount(
    h(ThemeProvider, { value: BRAND }, 'loose'),
  );
  assert.match(
    errors[0]?.message ?? '',
    /raw text "loose" must be inside a <window>, in a <text> element/,
  );
  await root.unmount();
});

test('an element nobody registered keeps its own error at the root', async () => {
  const { errors, root } = await mount(h('div'));
  assert.match(errors[0]?.message ?? '', /unknown element type <div>/);
  await root.unmount();
});

test('inside a window the provider is still a box that fills', async () => {
  const { app, root, errors } = await mount(
    h(
      'window',
      { width: 100, height: 100 },
      h(
        ThemeProvider,
        { value: BRAND },
        h('box', { style: { height: 10, backgroundColor: '$accent' } }),
      ),
    ),
  );
  assert.deepEqual(errors, []);
  const planted = tops(app)[0].children[0];
  assert.equal(planted.kind, 'box');
  assert.equal(planted.style.flexGrow, 1);
  assert.equal(planted.children[0].style.backgroundColor, BRAND.accent);
  await root.unmount();
});

// --- directly inside a window: nested windows pass through ----------------

/** A nested window painting the accent token, rendered by a component. */
const Nested = ({ title }) =>
  h(
    'window',
    { title, x: 10, y: 10, width: 30, height: 30 },
    h('box', { style: { flexGrow: 1, backgroundColor: '$accent' } }),
  );

const childWindows = (win) => win.children.filter((c) => c.isWindow);

test('a provider directly inside a window hands nested windows on to it, literal or from a component', async () => {
  let setAccent;
  function App() {
    const [accent, set] = React.useState('#aa0000');
    setAccent = set;
    return h(
      'window',
      { title: 'outer', width: 200, height: 100 },
      h(
        ThemeProvider,
        { value: { accent } },
        h('box', { style: { height: 10, backgroundColor: '$accent' } }),
        h(
          'window',
          { title: 'literal', x: 50, y: 10, width: 30, height: 30 },
          h('box', { style: { flexGrow: 1, backgroundColor: '$accent' } }),
        ),
        h(Nested, { title: 'component' }),
      ),
    );
  }
  const { app, root, errors } = await mount(h(App));
  assert.deepEqual(errors, []);
  const [outer] = tops(app);
  const planted = outer.children.find((c) => c.kind === 'box');
  assert.deepEqual(
    childWindows(outer).map((w) => w.props.title),
    ['literal', 'component'],
    'the window holds them, as it holds any nested window',
  );
  assert.equal(childWindows(planted).length, 0, 'and the box does not');
  for (const win of childWindows(outer)) {
    assert.equal(win.parent, outer);
    assert.ok(win.window, `${win.props.title} is realized`);
    assert.equal(win.window.attributes.parent, outer.window);
    assert.equal(win.children[0].style.backgroundColor, '#aa0000');
  }

  await act(() => setAccent('#00aa00'));
  for (const win of childWindows(outer)) {
    assert.equal(
      win.children[0].style.backgroundColor,
      '#00aa00',
      `a swap reaches ${win.props.title}`,
    );
  }
  await root.unmount();
});

test('a passed window arrives after mount, leaves when it closes, and goes with the provider', async () => {
  let setShow;
  function App() {
    const [show, set] = React.useState({ nested: false, provider: true });
    setShow = set;
    return h(
      'window',
      { title: 'outer', width: 200, height: 100 },
      show.provider &&
        h(
          ThemeProvider,
          { value: BRAND },
          h(Nested, { title: 'stays' }),
          show.nested && h(Nested, { title: 'later' }),
        ),
    );
  }
  const { app, root, errors } = await mount(h(App));
  const [outer] = tops(app);
  const titles = () => childWindows(outer).map((w) => w.props.title);
  assert.deepEqual(titles(), ['stays']);

  // into a box that is already in its window: passed on at once
  await act(() => setShow({ nested: true, provider: true }));
  assert.deepEqual(titles(), ['stays', 'later']);
  const later = childWindows(outer)[1];
  const stays = childWindows(outer)[0];
  assert.equal(later.window?.attributes.parent, outer.window, 'realized in it');
  assert.equal(later.children[0].style.backgroundColor, BRAND.accent);

  await act(() => setShow({ nested: false, provider: true }));
  assert.deepEqual(titles(), ['stays']);
  assert.equal(later.destroyed, true);
  assert.equal(later.window, null, 'its X window is gone');

  await act(() => setShow({ nested: false, provider: false }));
  // lengths and titles only: a failing deepEqual over nodes diffs the whole
  // retained tree, and takes a minute to say so
  assert.deepEqual(titles(), [], 'the provider takes it along');
  assert.equal(stays.destroyed, true);
  assert.deepEqual(errors, []);
  await root.unmount();
});

test('hiding the provider inside a window hides the windows it passed on', async () => {
  let setMode;
  function App() {
    const [mode, set] = React.useState('visible');
    setMode = set;
    return h(
      'window',
      { title: 'outer', width: 200, height: 100 },
      h(
        React.Activity,
        { mode },
        h(ThemeProvider, { value: BRAND }, h(Nested, { title: 'nested' })),
      ),
    );
  }
  const { app, root } = await mount(h(App));
  const [nested] = childWindows(tops(app)[0]);
  assert.equal(nested.window.mapped, true);

  await act(() => setMode('hidden'));
  assert.equal(nested.hidden, true);
  assert.equal(nested.window.mapped, false);

  await act(() => setMode('visible'));
  assert.equal(nested.window.mapped, true);
  await root.unmount();
});

test('a provider directly inside a popup hands a nested window on to the popup', async () => {
  const { app, root, errors } = await mount(
    h(
      'window',
      { title: 'owner', width: 200, height: 100 },
      h(
        'popup',
        { x: 20, y: 20, width: 80, height: 60 },
        h(ThemeProvider, { value: BRAND }, h(Nested, { title: 'nested' })),
      ),
    ),
  );
  assert.deepEqual(errors, []);
  const popup = tops(app)[0].children.find((c) => c.isPopup);
  const [nested] = childWindows(popup);
  assert.equal(nested?.props.title, 'nested');
  assert.equal(nested.children[0].style.backgroundColor, BRAND.accent);
  await root.unmount();
});

test('a keyed move of a passed window keeps it once in its window', async () => {
  let setOrder;
  function App() {
    const [order, set] = React.useState(['a', 'b']);
    setOrder = set;
    return h(
      'window',
      { title: 'outer', width: 200, height: 100 },
      h(
        ThemeProvider,
        { value: BRAND },
        order.map((title) => h(Nested, { key: title, title })),
      ),
    );
  }
  const { app, root, errors } = await mount(h(App));
  const [outer] = tops(app);
  await act(() => setOrder(['b', 'a']));
  assert.deepEqual(errors, []);
  assert.deepEqual(
    childWindows(outer)
      .map((w) => w.props.title)
      .sort(),
    ['a', 'b'],
  );
  await root.unmount();
});

test('under a provider inside a box, a nested window says what to do', async () => {
  const { errors, root } = await mount(
    h(
      'window',
      { width: 100, height: 100 },
      h(
        'box',
        null,
        h(ThemeProvider, { value: BRAND }, h(Nested, { title: 'nested' })),
      ),
    ),
  );
  assert.match(
    errors[0]?.message ?? '',
    /a <window> under this <ThemeProvider> cannot be nested — the provider is inside a <box>/,
  );
  await root.unmount();
});
