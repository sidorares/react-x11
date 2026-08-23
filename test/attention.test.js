// The `attention` event (ntk#37): the pointer looks like it is heading for
// this node, said before it gets there.
//
// The thing under test is the *routing*, which is unlike every other event
// here. Attention is not hit tested and does not bubble — candidates register
// themselves and are matched against the pointer's trajectory — so most of
// what follows is about which node wins and why, not about dispatch order.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createMockApp, moveMouse } from './helpers/mock-app.js';
import { isEventProp } from '../src/styles.js';

const h = React.createElement;
const tick = () => new Promise((r) => setImmediate(r));

/** An absolutely positioned box, so every rect in a test is stated. */
function boxAt(props, { x, y, width, height, ...style }) {
  return h('box', {
    ...props,
    style: { position: 'absolute', left: x, top: y, width, height, ...style },
  });
}

/**
 * Sweep the pointer along a straight line at a known speed. Samples carry
 * explicit timestamps: the tracker estimates velocity from consecutive
 * samples, so a test that let the wall clock supply them would be measuring
 * the machine.
 */
function sweep(wnd, from, to, { steps = 5, msPerStep = 10 } = {}) {
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    moveMouse(
      wnd,
      Math.round(from.x + (to.x - from.x) * k),
      Math.round(from.y + (to.y - from.y) * k),
      { time: 1000 + i * msPerStep },
    );
  }
}

async function mount(element) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const instance = await new Promise((res) => x11Root.render(element, res));
  const root = instance._reactX11Node;
  root._scheduled = false;
  root.flush();
  await tick();
  return { app, x11Root, root, wnd: app.windows[0] };
}

const find = (node, key) => {
  if (node.props?.testId === key) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, key);
    if (hit) return hit;
  }
  return null;
};

// --- the cost of not using it ----------------------------------------------

test('a tree with no attention anywhere runs nothing per motion event', async () => {
  const { x11Root, root, wnd } = await mount(
    h(
      'window',
      { width: 400, height: 400 },
      boxAt({}, { x: 200, y: 180, width: 60, height: 40 }),
      h('box', {
        style: { width: 10, height: 10, ':hover': { color: '#fff' } },
      }),
    ),
  );

  assert.strictEqual(
    root._attentionNodes.size,
    0,
    'nothing registered, so there is nothing to match against',
  );

  // the guard in _onMouseMove is a `size` read on this set; if it ever stops
  // being the only thing between a motion event and the tracker, this fails
  let ran = 0;
  const real = root.events._updateAttention.bind(root.events);
  root.events._updateAttention = (...a) => {
    ran++;
    return real(...a);
  };
  sweep(wnd, { x: 10, y: 200 }, { x: 120, y: 200 });
  await tick();
  assert.strictEqual(ran, 0, 'the tracker never ran');

  await x11Root.unmount();
});

test('a node registers by prop or by style block, and unregisters again', async () => {
  const { x11Root, root } = await mount(
    h(
      'window',
      { width: 400, height: 400 },
      boxAt(
        { testId: 'byProp', unstable_onAttention: () => {} },
        { x: 10, y: 10, width: 20, height: 20 },
      ),
      boxAt(
        { testId: 'byStyle' },
        {
          x: 40,
          y: 10,
          width: 20,
          height: 20,
          ':attention': { backgroundColor: '#f00' },
        },
      ),
      boxAt({ testId: 'neither' }, { x: 70, y: 10, width: 20, height: 20 }),
    ),
  );
  assert.strictEqual(
    root._attentionNodes.size,
    2,
    'the prop and the block, not the plain box',
  );
  assert.ok(root._attentionNodes.has(find(root, 'byProp')));
  assert.ok(root._attentionNodes.has(find(root, 'byStyle')));
  assert.ok(!root._attentionNodes.has(find(root, 'neither')));

  // dropping the prop drops the registration
  await new Promise((res) =>
    x11Root.render(
      h(
        'window',
        { width: 400, height: 400 },
        boxAt({ testId: 'byProp' }, { x: 10, y: 10, width: 20, height: 20 }),
        boxAt(
          { testId: 'byStyle' },
          {
            x: 40,
            y: 10,
            width: 20,
            height: 20,
            ':attention': { backgroundColor: '#f00' },
          },
        ),
        boxAt({ testId: 'neither' }, { x: 70, y: 10, width: 20, height: 20 }),
      ),
      res,
    ),
  );
  await tick();
  assert.strictEqual(
    root._attentionNodes.size,
    1,
    'only the style block is left',
  );

  await x11Root.unmount();
});

test('an inline handler does not repaint the node on every render', async () => {
  // `unstable_onAttention` does not match the plain `/^on[A-Z]/` an event prop
  // used to be recognised by, and both callers of `isEventProp` care. This is
  // the one that bites silently: `paintChanged` compares every prop it does
  // not know about by identity, so an unrecognised handler would make a fresh
  // inline arrow — which is what every render passes — read as a changed prop
  // and claim a full repaint of the node, forever.
  const { x11Root, root } = await mount(
    h(
      'window',
      { width: 400, height: 400 },
      boxAt(
        { testId: 'target', unstable_onAttention: () => {} },
        { x: 200, y: 180, width: 60, height: 40 },
      ),
    ),
  );
  const target = find(root, 'target');
  const prev = { unstable_onAttention: () => {} };
  const next = { unstable_onAttention: () => {} };
  assert.notStrictEqual(prev.unstable_onAttention, next.unstable_onAttention);
  assert.strictEqual(
    target.paintChanged(next, prev),
    false,
    'a new function identity is not a paint change',
  );
  // and the window path agrees: a handler is not a CreateWindow attribute
  assert.ok(isEventProp('unstable_onAttention'));
  await x11Root.unmount();
});

// --- the routing ------------------------------------------------------------

test('a box the pointer is heading for hears about it before the pointer arrives', async () => {
  const seen = [];
  const { x11Root, root, wnd } = await mount(
    h(
      'window',
      { width: 400, height: 400 },
      boxAt(
        { testId: 'ahead', unstable_onAttention: (ev) => seen.push(ev) },
        { x: 200, y: 180, width: 60, height: 40 },
      ),
    ),
  );

  // 10 → 60 along y=200 at 1 device px/ms: the box starts 140px ahead, which
  // is 140ms away and inside the horizon
  sweep(wnd, { x: 10, y: 200 }, { x: 60, y: 200 });
  await tick();

  assert.strictEqual(seen.length, 1, 'fired once, on arrival of attention');
  const ahead = find(root, 'ahead');
  assert.strictEqual(root.events.attentionNode, ahead);
  assert.ok(
    seen[0].eta > 100 && seen[0].eta < 200,
    `eta should be about 140ms, got ${seen[0].eta}`,
  );
  assert.ok(
    !ahead.states[':hover'],
    'and the pointer has not actually got there — that is the whole point',
  );

  await x11Root.unmount();
});

test('direction decides it, not distance: a box behind the pointer never matches', async () => {
  const seen = [];
  const { x11Root, wnd } = await mount(
    h(
      'window',
      { width: 400, height: 400 },
      // 30px behind the sweep's start, far closer than the box in the test
      // above, and never nominated
      boxAt(
        { unstable_onAttention: () => seen.push('behind') },
        { x: 100, y: 180, width: 40, height: 40 },
      ),
    ),
  );
  sweep(wnd, { x: 150, y: 200 }, { x: 200, y: 200 });
  await tick();
  assert.deepStrictEqual(seen, [], 'the pointer is moving away from it');
  await x11Root.unmount();
});

test('a box off the line of travel is not on the way', async () => {
  const seen = [];
  const { x11Root, wnd } = await mount(
    h(
      'window',
      { width: 400, height: 400 },
      // directly ahead in x, but the sweep runs along y=200 and this sits at
      // the top of the window
      boxAt(
        { unstable_onAttention: () => seen.push('aside') },
        { x: 200, y: 0, width: 60, height: 40 },
      ),
    ),
  );
  sweep(wnd, { x: 10, y: 200 }, { x: 60, y: 200 });
  await tick();
  assert.deepStrictEqual(seen, []);
  await x11Root.unmount();
});

test('the soonest candidate wins, and only one holds attention at a time', async () => {
  const seen = [];
  const { x11Root, root, wnd } = await mount(
    h(
      'window',
      { width: 400, height: 400 },
      boxAt(
        { testId: 'near', unstable_onAttention: () => seen.push('near') },
        { x: 150, y: 180, width: 40, height: 40 },
      ),
      boxAt(
        { testId: 'far', unstable_onAttention: () => seen.push('far') },
        { x: 260, y: 180, width: 40, height: 40 },
      ),
    ),
  );

  sweep(wnd, { x: 10, y: 200 }, { x: 60, y: 200 });
  await tick();
  assert.deepStrictEqual(seen, ['near'], 'the one it reaches first');
  assert.strictEqual(root.events.attentionNode, find(root, 'near'));
  assert.ok(find(root, 'near').states[':attention']);
  assert.ok(!find(root, 'far').states[':attention']);

  // carry on past the near box and the far one becomes the soonest
  sweep(wnd, { x: 200, y: 200 }, { x: 250, y: 200 });
  await tick();
  assert.deepStrictEqual(seen, ['near', 'far']);
  assert.strictEqual(root.events.attentionNode, find(root, 'far'));
  assert.ok(
    !find(root, 'near').states[':attention'],
    'the previous holder gives it up — only one node has attention',
  );

  await x11Root.unmount();
});

test('overlapping boxes are resolved by which one the trajectory enters first', async () => {
  const seen = [];
  const { x11Root, wnd } = await mount(
    h(
      'window',
      { width: 400, height: 400 },
      // `under` is painted first and reaches further left, so the ray enters
      // it first even though `over` is on top of it in the stack
      boxAt(
        { unstable_onAttention: () => seen.push('under') },
        { x: 180, y: 170, width: 120, height: 60 },
      ),
      boxAt(
        { unstable_onAttention: () => seen.push('over') },
        { x: 220, y: 180, width: 60, height: 40 },
      ),
    ),
  );
  sweep(wnd, { x: 10, y: 200 }, { x: 60, y: 200 });
  await tick();
  assert.deepStrictEqual(seen, ['under'], 'entry order, not stacking order');
  await x11Root.unmount();
});

test('attention does not bubble: a parent hears nothing for its child', async () => {
  const seen = [];
  const { x11Root, wnd } = await mount(
    h(
      'window',
      { width: 400, height: 400 },
      h(
        'box',
        {
          // the parent is not a candidate — no prop, no block — so its rect
          // containing the child's buys it nothing
          style: {
            position: 'absolute',
            left: 190,
            top: 170,
            width: 100,
            height: 60,
          },
        },
        boxAt(
          { unstable_onAttention: () => seen.push('child') },
          { x: 10, y: 10, width: 60, height: 40 },
        ),
      ),
      h('box', {
        unstable_onAttentionCapture: () => seen.push('capture'),
        style: { position: 'absolute', left: 0, top: 0, width: 1, height: 1 },
      }),
    ),
  );
  sweep(wnd, { x: 10, y: 200 }, { x: 60, y: 200 });
  await tick();
  assert.deepStrictEqual(
    seen,
    ['child'],
    'the matched node only — there is no capture or bubble phase',
  );
  await x11Root.unmount();
});

test('a resting pointer falls back to what is under it rather than extrapolating noise', async () => {
  const seen = [];
  const { x11Root, root, wnd } = await mount(
    h(
      'window',
      { width: 400, height: 400 },
      boxAt(
        { testId: 'under', unstable_onAttention: () => seen.push('under') },
        { x: 100, y: 180, width: 60, height: 40 },
      ),
      boxAt(
        { unstable_onAttention: () => seen.push('elsewhere') },
        { x: 300, y: 180, width: 60, height: 40 },
      ),
    ),
  );

  // a hand at rest: a pixel of jitter over 40ms is well under the speed floor
  moveMouse(wnd, 130, 200, { time: 1000 });
  moveMouse(wnd, 131, 200, { time: 1040 });
  moveMouse(wnd, 130, 201, { time: 1080 });
  await tick();

  assert.deepStrictEqual(seen, ['under'], 'the box the pointer is actually in');
  assert.strictEqual(root.events.attentionNode, find(root, 'under'));
  await x11Root.unmount();
});

test('leaving the window gives up attention', async () => {
  const { x11Root, root, wnd } = await mount(
    h(
      'window',
      { width: 400, height: 400 },
      boxAt(
        { testId: 'ahead', unstable_onAttention: () => {} },
        { x: 200, y: 180, width: 60, height: 40 },
      ),
    ),
  );
  sweep(wnd, { x: 10, y: 200 }, { x: 60, y: 200 });
  await tick();
  assert.ok(root.events.attentionNode, 'held');

  wnd.emit('mouseout', { x: -1, y: 200 });
  await tick();
  assert.strictEqual(root.events.attentionNode, null);
  assert.ok(!find(root, 'ahead').states[':attention']);
  await x11Root.unmount();
});

test('a popup keeps its own candidates: registries do not cross windows', async () => {
  const seen = [];
  const { x11Root, root, wnd } = await mount(
    h(
      'window',
      { width: 400, height: 400 },
      boxAt(
        { testId: 'inWindow', unstable_onAttention: () => seen.push('window') },
        { x: 200, y: 180, width: 60, height: 40 },
      ),
      h(
        'popup',
        { x: 10, y: 10, width: 200, height: 120 },
        boxAt(
          { testId: 'inPopup', unstable_onAttention: () => seen.push('popup') },
          { x: 100, y: 40, width: 60, height: 40 },
        ),
      ),
    ),
  );

  const popupNode = root.children.find((n) => n.isPopup);
  assert.ok(popupNode, 'the popup mounted');
  const inPopup = find(root, 'inPopup');
  const inWindow = find(root, 'inWindow');

  // A `<popup>` is its own X window with its own pointer stream and its own
  // coordinate space, so a candidate inside one must never be matched against
  // the owner's pointer — `abs` would be read in the wrong space and the
  // prediction would point at a rectangle that is somewhere else entirely.
  //
  // Two things happen to make that true, and only the second is a decision.
  // `insertBefore` splices a popup in as bookkeeping only and never hands it
  // the parent's root, so it keeps the `root = this` its constructor gave it
  // and its subtree registers with it. And the registry is **per window**
  // rather than per connection, which is the part worth pinning: one shared
  // set would be the obvious simplification, it would look right in every
  // single-window test, and it is what this fails on.
  assert.ok(
    root._attentionNodes.has(inWindow),
    'the window owns the box declared in it',
  );
  assert.ok(
    !root._attentionNodes.has(inPopup),
    'and not the one inside the popup',
  );
  assert.ok(popupNode._attentionNodes.has(inPopup), 'the popup owns that one');

  // driving the owner window's pointer can only ever reach the owner's
  // candidate, whatever the popup's geometry happens to overlap
  sweep(wnd, { x: 10, y: 200 }, { x: 60, y: 200 });
  await tick();
  assert.deepStrictEqual(seen, ['window']);
  assert.strictEqual(popupNode.events.attentionNode, null);

  await x11Root.unmount();
});

// --- the style block --------------------------------------------------------

test(':attention paints, and loses to :hover once the pointer really arrives', async () => {
  const { x11Root, root, wnd } = await mount(
    h(
      'window',
      { width: 400, height: 400, style: { backgroundColor: '#000' } },
      boxAt(
        { testId: 'target' },
        {
          x: 200,
          y: 180,
          width: 60,
          height: 40,
          backgroundColor: '#111111',
          ':attention': { backgroundColor: '#222222' },
          ':hover': { backgroundColor: '#333333' },
        },
      ),
    ),
  );
  const target = find(root, 'target');
  assert.strictEqual(target.style.backgroundColor, '#111111', 'resting');

  sweep(wnd, { x: 10, y: 200 }, { x: 60, y: 200 });
  await tick();
  assert.ok(target.states[':attention']);
  assert.strictEqual(
    target.style.backgroundColor,
    '#222222',
    'heading there, not there yet',
  );

  // and now actually arrive: both states are on, and `:hover` outranks the
  // prediction because it is a fact
  moveMouse(wnd, 230, 200, { time: 2000 });
  await tick();
  assert.ok(target.states[':hover']);
  assert.strictEqual(target.style.backgroundColor, '#333333');

  await x11Root.unmount();
});
