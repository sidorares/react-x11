// The style channel: `style` carries the CSS-like vocabulary, props carry
// element semantics, and no name means both. Runs headless on the mock app
// from smoke.test.js.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import ReactX11, { ThemeProvider, useTheme } from '../src/index.js';
import { createStyles, flattenStyle, resolveTokens } from '../src/styles.js';
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

// --- transitions -----------------------------------------------------------

test('interpolating a translucent colour does not darken it', async () => {
  const { interpolate } = await import('../src/styles.js');

  // Interpolating a colour with itself must return itself. This is the whole
  // bug in one line: the components are parsed, lerped, and formatted back
  // into an rgba() string, so they have to be *straight*. Premultiplied ones
  // get scaled by alpha again when the paint path re-parses the string, and
  // half-alpha red comes back as rgba(128, 0, 0, 0.5) — the same alpha at
  // half the brightness.
  assert.strictEqual(
    interpolate('rgba(255, 0, 0, 0.5)', 'rgba(255, 0, 0, 0.5)', 0.5),
    'rgba(255, 0, 0, 0.5)',
  );

  // both endpoints, too
  assert.strictEqual(
    interpolate('rgba(0, 0, 255, 0.25)', 'rgba(255, 0, 0, 0.75)', 0),
    'rgba(0, 0, 255, 0.25)',
  );
  assert.strictEqual(
    interpolate('rgba(0, 0, 255, 0.25)', 'rgba(255, 0, 0, 0.75)', 1),
    'rgba(255, 0, 0, 0.75)',
  );

  // The midpoint moves alpha, and the *hue does not travel*. This assertion
  // used to read rgba(128, 128, 128, 0.5) — lerping the four straight channels
  // — and that was wrong in a way nothing here noticed, because `transparent`
  // is black at zero alpha and so a straight lerp drags every fade-in towards
  // black on the way. Interpolation happens premultiplied, which is what CSS
  // specifies for exactly this reason: white at half alpha, not grey.
  assert.strictEqual(
    interpolate('rgba(0, 0, 0, 0)', 'rgba(255, 255, 255, 1)', 0.5),
    'rgba(255, 255, 255, 0.5)',
  );

  // opaque colours are unaffected either way, which is why the existing
  // transition test never caught this
  assert.strictEqual(
    interpolate('#000000', '#ffffff', 0.5),
    'rgba(128, 128, 128, 1)',
  );
});

test('fading in from transparent never darkens on the way', async () => {
  const { interpolate } = await import('../src/styles.js');

  // The user-visible bug: `Tabs` transitions `backgroundColor` between
  // `transparent` and a near-white hover fill, and hover moving between two
  // adjacent tabs fades one out while the other fades in. Lerping straight
  // channels sent both through mid grey — brightness over white went
  // 1.000, 0.809, 0.736, 0.782, 0.945, which is not even monotonic — and a
  // grey rectangle flashed across both tabs before the colours settled.
  //
  // So the property to hold is monotonicity, not any single value: a fade from
  // transparent to a lighter-than-background fill must only ever approach it.
  const overWhite = (s) => {
    const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(s);
    assert.ok(m, `unparseable colour: ${s}`);
    const alpha = Number(m[4]);
    return (alpha * (Number(m[1]) / 255) + (1 - alpha)) * 255;
  };

  let previous = 256;
  for (const t of [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1]) {
    const grey = overWhite(interpolate('transparent', '#f1f2f6', t));
    assert.ok(
      grey <= previous + 1e-6,
      `at t=${t} the fade brightened back to ${grey.toFixed(1)} from ` +
        `${previous.toFixed(1)} — it is dipping dark and coming back`,
    );
    previous = grey;
  }
  // and it lands exactly on the target
  assert.strictEqual(
    interpolate('transparent', '#f1f2f6', 1),
    'rgba(241, 242, 246, 1)',
  );
});

test('a transition eases a colour instead of snapping to it', async () => {
  const { setAnimationClock } = await import('../src/nodes.js');
  let clock = 1000;
  setAnimationClock(() => clock);
  try {
    const app = createMockApp();
    ReactX11.render(
      h(
        'window',
        { width: 100, height: 100 },
        h('box', {
          style: {
            width: 40,
            height: 40,
            backgroundColor: '#000000',
            transition: 100,
            ':hover': { backgroundColor: '#ffffff' },
          },
        }),
      ),
      null,
      app,
    );
    await tick();

    const root = nodeOf(app);
    const box = root.children[0];
    assert.strictEqual(box.style.backgroundColor, '#000000');

    moveMouse(app.windows[0], 20, 20);
    assert.strictEqual(
      box.style.backgroundColor,
      '#000000',
      'the frame the pointer arrives still shows the old value',
    );

    clock = 1050; // half way, eased
    root._advanceAnimations(clock);
    const mid = box.style.backgroundColor;
    assert.match(mid, /^rgba\(/, 'interpolated through ntk’s colour parser');
    const channel = Number(mid.slice(5).split(',')[0]);
    assert.ok(
      channel > 0 && channel < 255,
      `midpoint should be grey, got ${mid}`,
    );

    clock = 1200; // past the end
    root._advanceAnimations(clock);
    assert.strictEqual(
      box.style.backgroundColor,
      '#ffffff',
      'lands exactly on the declared value, not on a rounded rgba()',
    );
    assert.strictEqual(root._animating.size, 0, 'and stops asking for frames');
  } finally {
    setAnimationClock(() => Date.now());
  }
});

test('a transition after an idle spell still runs', async () => {
  const { setAnimationClock } = await import('../src/nodes.js');
  let clock = 1000;
  setAnimationClock(() => clock);
  try {
    const app = createMockApp();
    ReactX11.render(
      h(
        'window',
        { width: 100, height: 100 },
        h('box', {
          style: {
            width: 40,
            height: 40,
            backgroundColor: '#000000',
            transition: 100,
            ':hover': { backgroundColor: '#ffffff' },
          },
        }),
      ),
      null,
      app,
    );
    await tick();
    const window = nodeOf(app);
    const box = window.children[0];

    // nothing happens for five seconds — a window with no animation running
    // draws no frames, so this is the normal state of any idle UI
    clock = 6000;
    moveMouse(app.windows[0], 20, 20);

    clock = 6050; // half way through the transition
    window._advanceAnimations(clock);
    const mid = box.style.backgroundColor;
    assert.match(
      mid,
      /^rgba\(/,
      'the transition is mid-flight; it used to measure its start from the ' +
        'last frame drawn, so an idle gap made it finish before its first tick',
    );

    clock = 6200;
    window._advanceAnimations(clock);
    assert.strictEqual(box.style.backgroundColor, '#ffffff');
  } finally {
    setAnimationClock(() => Date.now());
  }
});

test('an interrupted transition reverses from where it got to', async () => {
  const { setAnimationClock } = await import('../src/nodes.js');
  let clock = 0;
  setAnimationClock(() => clock);
  try {
    const app = createMockApp();
    ReactX11.render(
      h(
        'window',
        { width: 100, height: 100 },
        h('box', {
          style: {
            width: 40,
            height: 40,
            backgroundColor: '#000000',
            transition: 100,
            ':hover': { backgroundColor: '#ffffff' },
          },
        }),
      ),
      null,
      app,
    );
    await tick();
    const root = nodeOf(app);
    const box = root.children[0];

    moveMouse(app.windows[0], 20, 20);
    clock = 30;
    root._advanceAnimations(clock);
    const partway = box.style.backgroundColor;

    moveMouse(app.windows[0], 90, 90); // leave before it finished
    assert.strictEqual(
      box.style.backgroundColor,
      partway,
      'the reverse starts from the current on-screen value, not from the end',
    );
    clock = 200;
    root._advanceAnimations(clock);
    assert.strictEqual(box.style.backgroundColor, '#000000');
  } finally {
    setAnimationClock(() => Date.now());
  }
});

test('transitions cover layout too, and relayout as they run', async () => {
  const { setAnimationClock } = await import('../src/nodes.js');
  let clock = 0;
  setAnimationClock(() => clock);
  try {
    const app = createMockApp();
    const ui = (left) =>
      h(
        'window',
        { width: 200, height: 100 },
        h('box', {
          style: {
            position: 'absolute',
            left,
            width: 20,
            height: 20,
            transition: { left: 100 },
          },
        }),
      );
    ReactX11.render(ui(0), null, app);
    await tick();
    const root = nodeOf(app);
    const box = root.children[0];
    assert.strictEqual(box.abs.x, 0);

    ReactX11.render(ui(100), null, app);
    clock = 50;
    root._advanceAnimations(clock);
    root.flush();
    assert.ok(
      box.abs.x > 0 && box.abs.x < 100,
      `mid-transition the box is laid out part way, got ${box.abs.x}`,
    );

    clock = 500;
    root._advanceAnimations(clock);
    root.flush();
    assert.strictEqual(box.abs.x, 100);
  } finally {
    setAnimationClock(() => Date.now());
  }
});

test('a transition started by a prop change schedules its own frames', async () => {
  const { setAnimationClock } = await import('../src/nodes.js');
  let clock = 1000;
  setAnimationClock(() => clock);
  try {
    const app = createMockApp();
    const ui = (backgroundColor) =>
      h(
        'window',
        { width: 100, height: 100 },
        h('box', {
          style: { flexGrow: 1, backgroundColor, transition: 200 },
        }),
      );
    ReactX11.render(ui('#000000'), null, app);
    await tick();
    const root = nodeOf(app);
    const box = root.children[0];
    const ops = app.windows[0].ctx.ops;
    const opsBefore = ops.length;

    // No hover, no focus, no other damage: the colour change is the whole
    // update. The commit's own damage test cannot see it — the first
    // displayed frame of a transition equals the previous style — so the
    // transition must schedule its first frame itself, or it only runs
    // when something else happens to dirty the window.
    ReactX11.render(ui('#ffffff'), null, app);

    clock = 1100; // half way
    await tick();
    await tick();
    const mid = box.style.backgroundColor;
    assert.match(
      mid,
      /^rgba\(/,
      'the transition ticked with nothing else waking the window',
    );
    const channel = Number(mid.slice(5).split(',')[0]);
    assert.ok(
      channel > 0 && channel < 255,
      `midpoint should be grey, got ${mid}`,
    );
    assert.ok(
      ops.slice(opsBefore).some((op) => op[0] === 'fillRect' && op[5] === mid),
      'the intermediate value actually painted',
    );

    clock = 1300; // past the end
    await tick();
    await tick();
    assert.strictEqual(box.style.backgroundColor, '#ffffff');
    assert.strictEqual(root._animating.size, 0, 'and stops asking for frames');
    assert.ok(
      ops
        .slice(opsBefore)
        .some((op) => op[0] === 'fillRect' && op[5] === '#ffffff'),
      'the final value painted too',
    );
  } finally {
    setAnimationClock(() => Date.now());
  }
});

test('a property with no midpoint snaps rather than animating', async () => {
  const app = createMockApp();
  ReactX11.render(
    h(
      'window',
      { width: 100, height: 100 },
      h('box', {
        style: {
          flexDirection: 'row',
          transition: 100,
          ':hover': { backgroundColor: 'red' },
        },
      }),
    ),
    null,
    app,
  );
  await tick();
  const root = nodeOf(app);
  ReactX11.render(
    h(
      'window',
      { width: 100, height: 100 },
      h('box', { style: { flexDirection: 'column', transition: 100 } }),
    ),
    null,
    app,
  );
  assert.strictEqual(
    root.children[0].style.flexDirection,
    'column',
    'an enum has no midpoint: it takes effect at once',
  );
  ReactX11.unmountComponentAtNode(app);
});

test('Switch: the thumb slides between the ends instead of snapping', async () => {
  const { Switch } = await import('../src/index.js');
  const { setAnimationClock } = await import('../src/nodes.js');
  let clock = 0;
  setAnimationClock(() => clock);
  try {
    const app = createMockApp();
    const render = (checked) =>
      ReactX11.render(
        h(
          'window',
          { width: 100, height: 60 },
          h(Switch, { checked, onChange: () => {} }),
        ),
        null,
        app,
      );

    render(false);
    await tick();
    const root = nodeOf(app);
    const thumb = root.children[0].children[0];
    const off = thumb.abs.x;

    render(true);
    clock = 60;
    root._advanceAnimations(clock);
    root.flush();
    const mid = thumb.abs.x;
    assert.ok(mid > off, `thumb should have moved by mid-flight, got ${mid}`);

    clock = 400;
    root._advanceAnimations(clock);
    root.flush();
    assert.ok(thumb.abs.x > mid, 'and keeps going to the on position');
    assert.strictEqual(root._animating.size, 0, 'then the frame loop stops');
  } finally {
    setAnimationClock(() => Date.now());
  }
});

// --- theme tokens ----------------------------------------------------------

const THEME = {
  panel: '#ffffff',
  ink: '#2d3436',
  gutter: 12,
  accent: '#2980b9',
};

test('a hoisted style resolves $tokens against the nearest theme', async () => {
  const app = createMockApp();
  const s = createStyles({
    card: { backgroundColor: '$panel', padding: '$gutter', flexGrow: 1 },
  });
  ReactX11.render(
    h(
      'window',
      { width: 100, height: 100, theme: THEME },
      h(
        'box',
        { style: s.card },
        h('text', { style: { color: '$ink' } }, 'hi'),
      ),
    ),
    null,
    app,
  );
  await tick();

  const box = nodeOf(app).children[0];
  assert.strictEqual(box.style.backgroundColor, '#ffffff');
  assert.strictEqual(box.style.padding, 12, 'tokens are not colour-only');
  assert.strictEqual(box.children[0].style.color, '#2d3436');
  assert.strictEqual(
    box.abs.width,
    100 - 0,
    'the resolved padding reached yoga',
  );

  ReactX11.unmountComponentAtNode(app);
});

test('a nested theme merges over the outer one', async () => {
  const app = createMockApp();
  ReactX11.render(
    h(
      'window',
      { width: 100, height: 100, theme: THEME },
      h(
        'box',
        { theme: { panel: '#000000' }, style: { backgroundColor: '$panel' } },
        h('text', { style: { color: '$ink' } }, 'hi'),
      ),
    ),
    null,
    app,
  );
  await tick();

  const box = nodeOf(app).children[0];
  assert.strictEqual(box.style.backgroundColor, '#000000', 'inner wins');
  assert.strictEqual(
    box.children[0].style.color,
    '#2d3436',
    'and the rest of the outer palette still applies',
  );

  ReactX11.unmountComponentAtNode(app);
});

test('changing the theme restyles the subtree', async () => {
  const app = createMockApp();
  const s = createStyles({ card: { backgroundColor: '$panel', flexGrow: 1 } });
  const render = (theme) =>
    ReactX11.render(
      h(
        'window',
        { width: 100, height: 100, theme },
        h(
          'box',
          { style: s.card },
          h('text', { style: { color: '$ink' } }, 'x'),
        ),
      ),
      null,
      app,
    );

  render(THEME);
  await tick();
  const box = nodeOf(app).children[0];
  assert.strictEqual(box.style.backgroundColor, '#ffffff');

  render({ ...THEME, panel: '#1e272e', ink: '#f5f6fa' });
  await tick();
  assert.strictEqual(box.style.backgroundColor, '#1e272e');
  assert.strictEqual(box.children[0].style.color, '#f5f6fa', 'deep nodes too');

  ReactX11.unmountComponentAtNode(app);
});

test('a popup inherits the theme of where it is written, not its window', async () => {
  const app = createMockApp();
  ReactX11.render(
    h(
      'window',
      { width: 200, height: 200, theme: THEME },
      h(
        'box',
        { theme: { panel: '#111111' } },
        h(
          'popup',
          { x: 0, y: 0, width: 50, height: 50 },
          h('box', { style: { backgroundColor: '$panel', flexGrow: 1 } }),
        ),
      ),
    ),
    null,
    app,
  );
  await tick();

  const popup = app.windows[1]._reactX11Node;
  assert.strictEqual(
    popup.children[0].style.backgroundColor,
    '#111111',
    'a menu follows the UI that opened it, across the window boundary',
  );

  ReactX11.unmountComponentAtNode(app);
});

test('an unknown token is an error naming what the theme has', async () => {
  const app = createMockApp();
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    ReactX11.render(
      h(
        'window',
        { width: 100, height: 100, theme: THEME },
        h('box', { style: { backgroundColor: '$pannel' } }),
      ),
      null,
      app,
    );
    await tick();
  } finally {
    console.error = orig;
  }
  assert.match(errors.join('\n'), /unknown theme token "\$pannel"/);
  assert.match(errors.join('\n'), /theme has panel, ink, gutter, accent/);
});

test('tokens keep the identity fast path: same style, same theme, same object', () => {
  const s = createStyles({ card: { backgroundColor: '$panel' } });
  const a = resolveTokens(s.card, THEME);
  const b = resolveTokens(s.card, THEME);
  assert.strictEqual(a, b, 'resolution is cached per (style, theme)');
  assert.notStrictEqual(a, resolveTokens(s.card, { ...THEME }));
});

test('a token change invalidates cached text, not just the style object', async () => {
  const app = createMockApp();
  const s = createStyles({ title: { fontSize: 20, color: '$ink' } });
  const render = (theme) =>
    ReactX11.render(
      h(
        'window',
        { width: 200, height: 80, theme },
        h(
          'box',
          { style: { flexGrow: 1 } },
          h('text', { style: s.title }, 'Dashboard'),
        ),
      ),
      null,
      app,
    );

  render(THEME);
  await tick();
  const text = nodeOf(app).children[0].children[0];
  text._layouts.set('stale', { width: 1, height: 1 });

  // the <text> element's own props do not change — only the theme above it —
  // so nothing re-renders it and the cached layout would otherwise survive
  // with the old colour baked in
  render({ ...THEME, ink: '#ffffff' });
  await tick();

  assert.strictEqual(text.style.color, '#ffffff');
  assert.strictEqual(
    text._layouts.size,
    0,
    'the memoised text layout was dropped, so the repaint uses the new colour',
  );

  ReactX11.unmountComponentAtNode(app);
});

// --- ThemeProvider ---------------------------------------------------------
//
// There are two consumers of a palette and they are not the same mechanism:
// widgets read React context, and `$token` resolution walks the *node* tree
// looking for a `theme` prop. `ThemeProvider` has to feed both, or the
// obvious first thing anyone writes silently paints nothing (#119).

test('ThemeProvider feeds both channels: useTheme and $token read one palette', async () => {
  const app = createMockApp();
  const s = createStyles({ card: { backgroundColor: '$accent', flexGrow: 1 } });
  let fromContext;
  const Probe = () => {
    fromContext = useTheme();
    return h('box', { style: s.card });
  };
  ReactX11.render(
    h(
      'window',
      { width: 100, height: 100 },
      h(ThemeProvider, { value: { accent: '#ff0000' } }, h(Probe)),
    ),
    null,
    app,
  );
  await tick();

  const provided = nodeOf(app).children[0];
  assert.strictEqual(
    provided.children[0].style.backgroundColor,
    '#ff0000',
    'the provider reached the node tree, not just the context',
  );
  assert.strictEqual(fromContext.accent, '#ff0000');
  assert.strictEqual(
    fromContext.text,
    '#2d3436',
    'a partial palette inherits the rest from the defaults',
  );
  assert.strictEqual(
    provided.props.theme,
    fromContext,
    'both channels carry the same object, so the resolution cache holds',
  );

  ReactX11.unmountComponentAtNode(app);
});

test('a nested ThemeProvider merges over the outer one, as a nested theme prop does', async () => {
  const app = createMockApp();
  let inner;
  const Probe = () => {
    inner = useTheme();
    return h('box', { style: { backgroundColor: '$accent', flexGrow: 1 } });
  };
  ReactX11.render(
    h(
      'window',
      { width: 100, height: 100 },
      h(
        ThemeProvider,
        { value: { accent: '#111111', text: '#222222' } },
        h(ThemeProvider, { value: { accent: '#333333' } }, h(Probe)),
      ),
    ),
    null,
    app,
  );
  await tick();

  assert.strictEqual(inner.accent, '#333333', 'the inner provider wins');
  assert.strictEqual(inner.text, '#222222', 'and keeps what it did not set');
  const box = nodeOf(app).children[0].children[0].children[0];
  assert.strictEqual(box.style.backgroundColor, '#333333', 'tokens agree');

  ReactX11.unmountComponentAtNode(app);
});

test('a ThemeProvider above a <window> plants the palette on the window', async () => {
  // a <window> may not sit inside a box, so the provider cannot wrap one —
  // it puts the prop on the window instead of coming between them
  const app = createMockApp();
  ReactX11.render(
    h(
      ThemeProvider,
      { value: { accent: '#abcdef' } },
      h(
        'window',
        { width: 100, height: 100 },
        h('box', { style: { backgroundColor: '$accent', flexGrow: 1 } }),
      ),
    ),
    null,
    app,
  );
  await tick();

  const win = nodeOf(app);
  assert.strictEqual(win.kind, 'window', 'no box came between them');
  assert.strictEqual(win.children[0].style.backgroundColor, '#abcdef');

  ReactX11.unmountComponentAtNode(app);
});

test('a $token with no theme anywhere is reported once, not silently dropped', async () => {
  const app = createMockApp();
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const render = (color) =>
      ReactX11.render(
        h(
          'window',
          { width: 100, height: 100 },
          h('box', {
            style: { backgroundColor: '$panel', color, flexGrow: 1 },
          }),
        ),
        null,
        app,
      );
    render('red');
    await tick();
    render('blue'); // a re-render must not warn again
    await tick();
  } finally {
    console.warn = orig;
  }

  assert.strictEqual(warnings.length, 1, 'once per node, not once per render');
  assert.match(warnings[0], /<box> uses \$panel but no theme is in force/);
  assert.match(warnings[0], /ThemeProvider/, 'it names the fix');

  ReactX11.unmountComponentAtNode(app);
});

test('a popup written under a theme does not trip the no-theme warning', async () => {
  // a <popup> is its own root from birth and only learns where it was
  // written when it attaches, so the check has to wait for the commit
  const app = createMockApp();
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    ReactX11.render(
      h(
        'window',
        { width: 200, height: 200, theme: THEME },
        h(
          'popup',
          { x: 0, y: 0, width: 50, height: 50 },
          h('box', { style: { backgroundColor: '$panel', flexGrow: 1 } }),
        ),
      ),
      null,
      app,
    );
    await tick();
  } finally {
    console.warn = orig;
  }
  assert.deepStrictEqual(warnings, []);

  ReactX11.unmountComponentAtNode(app);
});
