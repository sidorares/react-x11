// REACT_X11_DEBUG_PAINT (issue #127): damage-rect flashing, the
// full-repaint warning with its captured stack, and the invalidation
// reasons both of them print. Headless over the mock app; the switch is
// flipped through setDebugPaint, the runtime seam for the once-read env.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { setDebugPaint } from '../src/nodes.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function mount(children, windowProps = {}) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h('window', { width: 200, height: 100, ...windowProps }, children),
  );
  return { app, wnd: app.windows[0], root: app.windows[0]._reactX11Node };
}

const strokes = (wnd) =>
  wnd.ctx.ops.filter(([op, , width]) => op === 'stroke' && width === 2);

// stateful (a :hover block), so setStyleState really repaints
const hoverBox = (ref) =>
  h('box', {
    ref,
    style: {
      width: 80,
      height: 40,
      backgroundColor: '#111111',
      ':hover': { backgroundColor: '#333333' },
    },
  });

test('flashing strokes each damage rect, in a colour that rotates', async (t) => {
  setDebugPaint('1');
  t.after(() => setDebugPaint(''));
  const ref = React.createRef();
  const { wnd } = await mount(hoverBox(ref));
  await tick(); // mount frame paints (and flashes) once
  wnd.ctx.ops.length = 0;

  // a bounded repaint: restyle the box twice, two frames, two colours
  ref.current.setStyleState(':hover', true);
  await tick();
  const first = strokes(wnd);
  assert.strictEqual(first.length, 1, 'one damage rect, one flash stroke');
  wnd.ctx.ops.length = 0;
  ref.current.setStyleState(':hover', false);
  await tick();
  const second = strokes(wnd);
  assert.strictEqual(second.length, 1);
  assert.notStrictEqual(
    first[0][1],
    second[0][1],
    'the flash colour rotates per frame',
  );
});

test('flashing is off (and free) by default', async () => {
  const ref = React.createRef();
  const { wnd } = await mount(hoverBox(ref));
  await tick();
  wnd.ctx.ops.length = 0;
  ref.current.setStyleState(':hover', true);
  await tick();
  const painted = wnd.ctx.ops.some(([op]) => op === 'fillRect');
  assert.ok(painted, 'the hover restyle repainted');
  assert.strictEqual(strokes(wnd).length, 0);
});

test('=full warns on a full-window repaint, naming reason and origin', async (t) => {
  setDebugPaint('full');
  t.after(() => setDebugPaint(''));
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => (console.warn = original));

  const { root } = await mount(h('box', { style: { flexGrow: 1 } }));
  await tick(); // the mount frame is legitimately full — and says why
  assert.ok(
    warnings.some(
      (w) => w.includes('full-window repaint') && w.includes('mount'),
    ),
    `mount frame warns with its reason, got: ${warnings.join('\n')}`,
  );

  warnings.length = 0;
  function culpritInvalidate() {
    root.invalidate(false, null, 'highlight');
  }
  culpritInvalidate();
  await tick();
  const warning = warnings.find((w) => w.includes('full-window repaint'));
  assert.ok(warning, 'an unbounded invalidate warns');
  assert.match(warning, /reasons=highlight/);
  assert.match(
    warning,
    /culpritInvalidate/,
    'the stack is the invalidate call, not the flush',
  );
});

test('a bounded frame does not warn under =full', async (t) => {
  setDebugPaint('full');
  t.after(() => setDebugPaint(''));
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => (console.warn = original));

  const ref = React.createRef();
  await mount(
    h('box', {
      ref,
      style: { width: 80, height: 40, backgroundColor: '#111111' },
    }),
  );
  await tick();
  warnings.length = 0;
  ref.current.setStyleState(':hover', true); // bounded: the box's own rect
  await tick();
  assert.strictEqual(warnings.length, 0, warnings.join('\n'));
});

test('a frame collects reasons and clears them for the next one', async () => {
  const ref = React.createRef();
  const { root } = await mount(
    h(
      'box',
      { ref, style: { overflow: 'scroll', flexGrow: 1 } },
      ...Array.from({ length: 10 }, (_, i) =>
        h('box', { key: i, style: { height: 40, flexShrink: 0 } }),
      ),
    ),
  );
  await tick();
  ref.current.scrollTo(60);
  await tick();
  assert.deepStrictEqual(root._lastReasons, ['scroll']);

  // nothing happened since: the next frame reports no stale reasons
  root.needsPaint = true;
  root._scheduled = false;
  root.flush();
  assert.deepStrictEqual(root._lastReasons, []);
});

test('an unknown reason warns in DEV instead of vanishing silently', async (t) => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => (console.warn = original));
  const { root } = await mount(h('box', { style: { flexGrow: 1 } }));
  await tick();
  root.invalidate(false, null, 'tyop');
  assert.ok(warnings.some((w) => w.includes('unknown reason')));
});
