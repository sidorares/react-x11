// `visibility: 'hidden'` — laid out, never drawn, never reached
// (src/visibility.js, docs/styling.md "Visibility").
//
// What it is for: revealing something — a message's copy button on hover —
// without the transcript around it moving. So the two halves are pinned
// against each other: the boxes are exactly where a visible subtree's would
// be, and nothing else of the subtree exists — no draw code runs, no
// pointer, no focus, no accessible. And switching it is a repaint, never a
// layout pass.
//
// The mock app for counts, focus and the accessibility model; the
// in-process X server for pixels and for `fireEvent`, which refuses a node
// nobody can see.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import {
  a11yChildren,
  a11yStates,
  ATSPI_STATE,
  subtreeText,
} from '../src/a11y.js';
import {
  act,
  cleanup,
  fireEvent,
  pixelAt,
  renderX11,
} from '../src/testing/index.js';
import { createMockApp, flushFrames } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

afterEach(async () => {
  await cleanup();
});

async function mount(element, { width = 200, height = 120 } = {}) {
  const app = createMockApp();
  const root = await createRoot({ app });
  const render = (el) => root.render(h('window', { width, height }, el));
  render(element);
  await tick();
  const wnd = app.windows[0];
  const tree = wnd._reactX11Node;
  flushFrames(wnd);
  return { app, root, wnd, tree, render, events: tree.events };
}

/** Every node under `node`, in tree order. */
function all(node, out = []) {
  out.push(node);
  for (const child of node.children) all(child, out);
  return out;
}

/** Named nodes only, and compared by name: `assert.equal` on two nodes walks
 *  the whole retained tree when it fails. */
const byName = (tree, name) =>
  all(tree).find((n) => n.props?.name === name) ?? null;

const rectOf = (n) => ({ ...n.abs });

/** A card: a row of padded boxes, one holding a canvas, one holding text and
 *  a nested box — enough structure for a layout difference to show. */
function card(cardStyle, extra = {}) {
  return h(
    'box',
    {
      name: 'outer',
      style: { flexDirection: 'column', padding: 4, backgroundColor: '#fff' },
    },
    h('box', { name: 'above', style: { height: 10, backgroundColor: '#eee' } }),
    h(
      'box',
      {
        name: 'card',
        style: { flexDirection: 'row', padding: 6, gap: 3, ...cardStyle },
      },
      h('box', {
        name: 'swatch',
        focusable: true,
        style: { width: 20, height: 14, margin: 2, backgroundColor: '#f00' },
      }),
      h('canvas', {
        name: 'canvas',
        style: { width: 16, height: 16 },
        onDraw: extra.onDraw ?? (() => {}),
      }),
      h(
        'box',
        { name: 'nested', style: { flexGrow: 1, padding: 1, minHeight: 12 } },
        h('text', { name: 'label' }, 'copy'),
      ),
    ),
    h('box', { name: 'below', style: { height: 10, backgroundColor: '#ddd' } }),
  );
}

const NAMES = [
  'outer',
  'above',
  'card',
  'swatch',
  'canvas',
  'nested',
  'label',
  'below',
];

test('a hidden subtree is laid out exactly where a visible one is', async () => {
  const shown = await mount(card({}));
  const hidden = await mount(card({ visibility: 'hidden' }));
  for (const name of NAMES) {
    assert.deepEqual(
      rectOf(byName(hidden.tree, name)),
      rectOf(byName(shown.tree, name)),
      `${name} has the same box hidden as shown`,
    );
  }
  // a premise: the layout ran, or equal rects would prove nothing
  assert.ok(byName(shown.tree, 'swatch').abs.width === 20);
  assert.ok(byName(shown.tree, 'below').abs.y > 30);
});

test('nothing in a hidden subtree runs its draw code', async () => {
  let draws = 0;
  const onDraw = () => draws++;
  const { wnd, tree, render } = await mount(
    card({ visibility: 'hidden' }, { onDraw }),
  );
  // Count every paint entry point of every node in the subtree: the walk
  // must stop at the hidden node, not visit each node to draw nothing.
  const counts = new Map();
  for (const node of all(byName(tree, 'card'))) {
    for (const method of [
      'paint',
      '_paintNode',
      '_paintBackground',
      'paintContent',
    ]) {
      const original = node[method];
      if (typeof original !== 'function') continue;
      node[method] = function (...args) {
        counts.set(
          node.props?.name ?? node.kind,
          (counts.get(node.props?.name ?? node.kind) ?? 0) + 1,
        );
        return original.apply(this, args);
      };
    }
  }
  tree.invalidate(false);
  flushFrames(wnd);
  tree.invalidate(false);
  flushFrames(wnd);
  assert.equal(draws, 0, 'onDraw never ran');
  assert.deepEqual([...counts], [], 'no node in the subtree was painted');
  // …and the counters work: shown, the same subtree draws
  render(card({}, { onDraw }));
  await tick();
  flushFrames(wnd);
  assert.ok(draws > 0, 'onDraw runs once the subtree is shown');
  assert.ok(
    counts.get('card') > 0 && counts.get('swatch') > 0,
    'and it paints',
  );
});

test('a descendant cannot show itself inside a hidden subtree', async () => {
  let draws = 0;
  const { wnd, tree } = await mount(
    h(
      'box',
      { name: 'parent', style: { visibility: 'hidden', padding: 4 } },
      h('canvas', {
        name: 'child',
        focusable: true,
        style: { width: 16, height: 16, visibility: 'visible' },
        onDraw: () => draws++,
      }),
    ),
  );
  tree.invalidate(false);
  flushFrames(wnd);
  assert.equal(draws, 0, "'visible' below a hidden node draws nothing");
  const child = byName(tree, 'child');
  const at = child.abs;
  assert.equal(tree.hitTest(at.x + 8, at.y + 8)?.props?.name ?? null, null);
});

test('hidden paints no pixels, and toggling repaints its area', async () => {
  const App = ({ hidden }) =>
    h(
      'box',
      {
        style: {
          flexDirection: 'row',
          flexGrow: 1,
          backgroundColor: '#ffffff',
        },
      },
      h(
        'box',
        {
          style: {
            width: 40,
            height: 40,
            backgroundColor: '#ff0000',
            visibility: hidden ? 'hidden' : undefined,
          },
        },
        h('box', {
          style: { width: 20, height: 20, backgroundColor: '#0000ff' },
        }),
      ),
      h('box', {
        style: { width: 40, height: 40, backgroundColor: '#00ff00' },
      }),
    );
  const api = await renderX11(h(App, { hidden: true }), {
    width: 100,
    height: 40,
  });
  await act();
  assert.deepEqual(
    (await pixelAt(api.ctx, 30, 30)).slice(0, 3),
    [255, 255, 255],
  );
  assert.deepEqual((await pixelAt(api.ctx, 5, 5)).slice(0, 3), [255, 255, 255]);
  assert.deepEqual((await pixelAt(api.ctx, 60, 20)).slice(0, 3), [0, 255, 0]);
  await api.rerender(h(App, { hidden: false }));
  assert.deepEqual((await pixelAt(api.ctx, 30, 30)).slice(0, 3), [255, 0, 0]);
  assert.deepEqual((await pixelAt(api.ctx, 5, 5)).slice(0, 3), [0, 0, 255]);
  await api.rerender(h(App, { hidden: true }));
  assert.deepEqual(
    (await pixelAt(api.ctx, 30, 30)).slice(0, 3),
    [255, 255, 255],
  );
  assert.deepEqual((await pixelAt(api.ctx, 5, 5)).slice(0, 3), [255, 255, 255]);
  assert.deepEqual((await pixelAt(api.ctx, 60, 20)).slice(0, 3), [0, 255, 0]);
});

test('toggling is a repaint of the subtree, never a layout pass', async () => {
  const { wnd, tree, render } = await mount(card({}));
  const before = NAMES.map((n) => rectOf(byName(tree, n)));
  const layouts = [];
  const calculate = tree.yoga.calculateLayout;
  tree.yoga.calculateLayout = function (...args) {
    layouts.push(args);
    return calculate.apply(this, args);
  };
  const claims = [];
  const invalidate = tree.invalidate;
  tree.invalidate = function (layoutChanged, damage, ...rest) {
    claims.push({ layoutChanged, damage });
    return invalidate.call(this, layoutChanged, damage, ...rest);
  };
  for (const visibility of ['hidden', undefined, 'hidden']) {
    render(card({ visibility }));
    await tick();
    flushFrames(wnd);
  }
  assert.equal(layouts.length, 0, 'yoga laid nothing out');
  assert.equal(tree.needsLayout, false);
  assert.ok(claims.length > 0, 'a premise: the toggles claimed damage');
  assert.ok(
    claims.every((c) => !c.layoutChanged),
    'and every claim was a paint claim',
  );
  const cardNode = byName(tree, 'card');
  assert.ok(
    claims.some((c) => c.damage === cardNode),
    "the card claimed its own subtree's area",
  );
  assert.deepEqual(
    NAMES.map((n) => rectOf(byName(tree, n))),
    before,
    'and nothing moved',
  );
});

test('a hidden subtree takes no pointer: no click, no hover, no cursor', async () => {
  const seen = [];
  const { wnd, tree } = await mount(
    h(
      'box',
      {
        name: 'behind',
        onClick: (ev) => seen.push(`behind:${ev.target.props.name}`),
        style: { width: 100, height: 60, cursor: 'default' },
      },
      h('box', {
        name: 'ghost',
        onClick: () => seen.push('ghost'),
        onMouseEnter: () => seen.push('enter'),
        style: {
          width: 40,
          height: 40,
          cursor: 'pointer',
          visibility: 'hidden',
          ':hover': { backgroundColor: '#f00' },
        },
      }),
    ),
  );
  const ghost = byName(tree, 'ghost');
  const at = { x: ghost.abs.x + 20, y: ghost.abs.y + 20 };
  assert.equal(tree.hitTest(at.x, at.y)?.props.name, 'behind');
  wnd.emit('mousemove', { ...at, buttons: 0 });
  wnd.emit('mousedown', { ...at, keycode: 1 });
  wnd.emit('mouseup', { ...at, keycode: 1 });
  assert.deepEqual(seen, ['behind:behind'], 'the click went to what is behind');
  assert.notEqual(ghost.states[':hover'], true, 'no :hover');
  assert.notEqual(ghost.states[':active'], true, 'no :active');
});

test('fireEvent refuses a node inside a hidden subtree, and says why', async () => {
  const api = await renderX11(
    h(
      'box',
      { style: { visibility: 'hidden' } },
      h('box', { name: 'button', style: { width: 30, height: 20 } }),
    ),
    { width: 60, height: 40 },
  );
  await act();
  const button = byName(api.windowNode, 'button');
  await assert.rejects(
    async () => fireEvent.click(button),
    /visibility: 'hidden'/,
  );
});

test('a hidden subtree is out of the Tab order and refuses focus()', async () => {
  const { tree, events } = await mount(
    h(
      'box',
      null,
      h('box', {
        name: 'first',
        focusable: true,
        style: { width: 10, height: 10 },
      }),
      h(
        'box',
        { name: 'wrap', style: { visibility: 'hidden' } },
        h('box', {
          name: 'inside',
          focusable: true,
          style: { width: 10, height: 10 },
        }),
      ),
      h('box', {
        name: 'last',
        focusable: true,
        style: { width: 10, height: 10 },
      }),
    ),
  );
  const names = events._tabbables().map((n) => n.props.name);
  assert.deepEqual(names, ['first', 'last']);
  byName(tree, 'inside').focus();
  assert.equal(
    events.focused?.props.name ?? null,
    null,
    'focus() on a hidden control does nothing',
  );
});

test('a focused control that becomes hidden gives up focus, and gets it back', async () => {
  let blurs = 0;
  const App = ({ hidden }) =>
    h(
      'box',
      null,
      h(
        'box',
        { name: 'wrap', style: { visibility: hidden ? 'hidden' : 'visible' } },
        h(
          'box',
          null,
          h('box', {
            name: 'field',
            focusable: true,
            onBlur: () => blurs++,
            style: { width: 10, height: 10 },
          }),
        ),
      ),
    );
  const { wnd, tree, events, render } = await mount(h(App, { hidden: false }));
  byName(tree, 'field').focus();
  assert.equal(events.focused?.props.name, 'field');
  render(h(App, { hidden: true }));
  await tick();
  flushFrames(wnd);
  assert.equal(
    events.focused?.props.name ?? null,
    null,
    'hiding the wrapper took the keyboard',
  );
  assert.equal(blurs, 1, 'with a blur, as display: none does');
  render(h(App, { hidden: false }));
  await tick();
  flushFrames(wnd);
  assert.equal(events.focused?.props.name, 'field', 'restored on reveal');
});

test('a state block may hide a node, and it is a repaint', async () => {
  const App = ({ disabled }) =>
    h('box', {
      name: 'thing',
      disabled,
      focusable: true,
      style: {
        width: 20,
        height: 20,
        backgroundColor: '#f00',
        ':disabled': { visibility: 'hidden' },
      },
    });
  const { wnd, tree, events, render } = await mount(
    h(App, { disabled: false }),
  );
  const thing = byName(tree, 'thing');
  const at = { x: thing.abs.x + 10, y: thing.abs.y + 10 };
  assert.equal(tree.hitTest(at.x, at.y)?.props.name, 'thing');
  render(h(App, { disabled: true }));
  await tick();
  flushFrames(wnd);
  assert.equal(thing.style.visibility, 'hidden');
  assert.equal(tree.hitTest(at.x, at.y)?.props?.name ?? null, null);
  assert.ok(!events._tabbables().includes(thing));
});

test('a hidden subtree is not in the accessibility tree', async () => {
  const { tree, wnd, render } = await mount(
    h(
      'box',
      { name: 'parent', role: 'group', 'aria-label': 'message' },
      h('text', { name: 'body' }, 'hello'),
      h(
        'box',
        { name: 'actions', style: { visibility: 'hidden' } },
        h('box', { name: 'copy', role: 'button', 'aria-label': 'Copy' }),
        h('text', null, '12:04'),
      ),
    ),
  );
  const parent = byName(tree, 'parent');
  const names = (node) =>
    a11yChildren(node).map((n) => n.props?.name ?? n.kind);
  assert.deepEqual(names(parent), ['body']);
  assert.equal(subtreeText(parent), 'hello', 'its text names nothing');
  const copy = byName(tree, 'copy');
  const VISIBLE = ATSPI_STATE.VISIBLE;
  const visibleBit = (states) =>
    VISIBLE < 32
      ? states[0] & (1 << VISIBLE)
      : states[1] & (1 << (VISIBLE - 32));
  assert.equal(visibleBit(a11yStates(copy)), 0, 'and not VISIBLE if asked');
  // shown, it is back
  render(
    h(
      'box',
      { name: 'parent', role: 'group', 'aria-label': 'message' },
      h('text', { name: 'body' }, 'hello'),
      h(
        'box',
        { name: 'actions' },
        h('box', { name: 'copy', role: 'button', 'aria-label': 'Copy' }),
        h('text', null, '12:04'),
      ),
    ),
  );
  await tick();
  flushFrames(wnd);
  assert.ok(names(byName(tree, 'parent')).length > 1);
  assert.notEqual(visibleBit(a11yStates(byName(tree, 'copy'))), 0);
});

test('a visibility that is not a keyword says what to write', async () => {
  const app = createMockApp();
  const errors = [];
  const root = await createRoot({
    app,
    onUncaughtError: (error) => errors.push(error),
  });
  root.render(
    h('window', null, h('box', { style: { visibility: 'collapse' } })),
  );
  await tick();
  assert.match(errors[0]?.message ?? '', /invalid visibility "collapse"/);
  assert.match(errors[0].message, /display: 'none'/);
  errors.length = 0;
  // unset, the way a conditional writes it, and in a state block
  root.render(
    h(
      'window',
      null,
      h('box', {
        style: { visibility: undefined, ':hover': { visibility: 'hidden' } },
      }),
    ),
  );
  await tick();
  assert.deepEqual(errors, []);
});
