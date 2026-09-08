// A native control in a box taller than its bezel (issue #510).
//
// The title of a native `<Button>`/`<Select>` is *placed*, not centred: it
// rides `TITLE_BASELINE` above the bezel body's bottom edge, which is where
// NSButtonCell puts it and is only right while the box is exactly the
// bezel's natural height. It was not always: the caller's `style` is applied
// last and flex stretches a box regardless, so `height: 44`, a `height:
// '100%'` in a taller parent or a bare `flexGrow: 1` made the box taller —
// and the bezel, an absolutely-filled `<canvas>` AppKit draws its cell into
// at the cell's own height, parted company with the title glued to the box's
// bottom. The label landed below the control it names.
//
// So a native control is two boxes now: the footprint the caller sizes, and
// the control itself at AppKit's metrics, centred in it. What is pinned here
// is that arrangement, in the layout the renderer actually computes — the
// bezels themselves are Cocoa-only and verified against the live backend.
//
// The load-bearing assertion is the **bezel's own height**: a title placed
// against a box says nothing while the bezel fills that same box, since both
// were wrong together. A bezel that is not 22pt is a bezel whose pixels sit
// somewhere other than where the title was placed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { Button, Select, createRoot } from '../src/index.js';
import { NATIVE_RING, TITLE_BASELINE } from '../src/components/native.js';
import { createMockApp, pressButton } from '../src/testing/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  await tick();
  await tick();
};

/**
 * AppKit's metrics, as a store the widgets can read off a mock app: a 22pt
 * control whose shadow rows are **not** symmetric, so a title placed against
 * the wrong edge cannot come out right by luck.
 */
const NATURAL = Object.freeze({ width: 60, height: 22 });
const SHADOW = Object.freeze({ top: 1, bottom: 2 });
/** how far the title's baseline sits above the bottom of the bezel's box */
const TITLE_UP = SHADOW.bottom + TITLE_BASELINE.regular;

function bezelledApp() {
  const app = createMockApp();
  app.nativeBezels = {
    natural: () => ({ ...NATURAL }),
    shadow: () => ({ ...SHADOW }),
    // the blit `Bezel`'s onDraw makes; the mock's ctx records it and draws
    // nothing, which is all this test needs from the pixels
    get: () => ({ surface: {}, sx: 0, sy: 0, sw: 1, sh: 1 }),
  };
  return app;
}

async function mount(element, { app = bezelledApp() } = {}) {
  const root = await createRoot({ app });
  root.render(h('window', { width: 400, height: 300 }, element));
  await settle();
  return { app, root, tree: app.windows[0]._reactX11Node };
}

/** every node under `tree`, in tree order, the popup windows excluded */
function nodes(tree) {
  const out = [];
  const walk = (n) => {
    out.push(n);
    for (const c of n.children) if (!c.isWindow) walk(c);
  };
  walk(tree);
  return out;
}

const byRole = (tree, role) =>
  nodes(tree).filter((n) => n.props?.role === role);

/** the control, the box it sits in, its bezel and its title */
function parts(tree, role) {
  const control = byRole(tree, role)[0];
  assert.ok(control, `no ${role} in the tree`);
  const footprint = nodes(tree).find((n) => n.children.includes(control));
  const bezel = control.children.find((c) => c.kind === 'canvas');
  const title = control.children.find((c) => c.kind === 'text');
  return { control, footprint, bezel, title };
}

const OPTIONS = [
  { value: 'Cocoa', label: 'Cocoa' },
  { value: 'X11', label: 'X11' },
];

/** the four shapes from the issue, and the untouched control beside them */
const CASES = [
  {
    name: 'untouched',
    box: 22,
    wrap: (control) => control({}),
  },
  {
    name: 'style={{ height: 44 }}',
    box: 44,
    wrap: (control) => control({ height: 44 }),
  },
  {
    name: "height: '100%' of a 44pt parent",
    box: 44,
    wrap: (control) =>
      h('box', { style: { height: 44 } }, control({ height: '100%' })),
  },
  {
    name: 'flexGrow: 1 in a 90pt column, no height named',
    box: 90,
    wrap: (control) =>
      h('box', { style: { height: 90 } }, control({ flexGrow: 1 })),
  },
];

for (const { name, box, wrap } of CASES) {
  test(`a native button is AppKit's height, centred in a box — ${name}`, async () => {
    const { root, tree } = await mount(
      wrap((style) => h(Button, { style }, 'Done')),
    );
    const { control, footprint, bezel, title } = parts(tree, 'button');

    assert.equal(footprint.abs.height, box, 'the caller sizes the footprint');
    assert.equal(control.abs.height, NATURAL.height, 'the control does not');
    assert.equal(
      bezel.abs.height,
      NATURAL.height,
      'and neither does the bezel',
    );
    assert.equal(
      control.abs.y - footprint.abs.y,
      Math.floor((box - NATURAL.height) / 2),
      'the control is centred in the footprint',
    );
    // the title against the bezel it belongs to, not against the footprint
    assert.equal(title.abs.y, bezel.abs.y + bezel.abs.height - TITLE_UP);
    // and the bezel spans the footprint's width, so a wide box is a wide button
    assert.equal(bezel.abs.width, footprint.abs.width);
    await root.unmount();
  });

  test(`a native popup is too — ${name}`, async () => {
    const { root, tree } = await mount(
      wrap((style) => h(Select, { options: OPTIONS, value: 'Cocoa', style })),
    );
    const { control, footprint, bezel, title } = parts(tree, 'combobox');

    assert.equal(footprint.abs.height, box);
    assert.equal(control.abs.height, NATURAL.height);
    assert.equal(bezel.abs.height, NATURAL.height);
    assert.equal(
      control.abs.y - footprint.abs.y,
      Math.floor((box - NATURAL.height) / 2),
    );
    assert.equal(title.abs.y, bezel.abs.y + bezel.abs.height - TITLE_UP);
    await root.unmount();
  });
}

// …and the keyboard ring goes with it. It is the control's own outline, on
// the node the focus lands on, so it follows the bezel's box: a ring drawn
// round a 44pt footprint with a 22pt control in it would be the rectangle
// beside a rectangle that `NATIVE_RING` was written to avoid.
test("the ring and the focus are the control's, not the footprint's", async () => {
  const { root, tree } = await mount(
    h(Button, { style: { height: 44 } }, 'Done'),
  );
  const { control, footprint } = parts(tree, 'button');

  assert.equal(control.props.focusable, true, 'the control takes the focus');
  assert.equal(footprint.props.focusable, undefined, 'the footprint does not');
  assert.deepEqual(control.style[':focus-visible'], {
    outlineWidth: NATIVE_RING.width,
    outlineOffset: NATIVE_RING.offset,
  });
  assert.equal(footprint.style[':focus-visible'], undefined);
  assert.equal(control.abs.height, NATURAL.height, 'so the ring is 22pt tall');
  await root.unmount();
});

// The footprint is a slot, not a bigger button. A press in the slack above a
// 22pt control in a 44pt slot does nothing at all — which is what AppKit does
// with a cell in an oversized frame, and the honest answer here: the press
// wash is the control's, so a button that fired from up there would act with
// no visible answer to the press that acted.
//
// The slot is the test's own box, not the widget's, so the press lands on
// the same point either way: before this it was the button's own top edge.
test('the press belongs to the control, not to the slack around it', async () => {
  const presses = [];
  const slot = React.createRef();
  const { app, root, tree } = await mount(
    h(
      'box',
      { ref: slot, style: { height: 44 } },
      h(
        Button,
        { style: { height: '100%' }, onPress: () => presses.push('press') },
        'Done',
      ),
    ),
  );
  const { control } = parts(tree, 'button');
  const wnd = app.windows[0];

  pressButton(wnd, slot.current.abs.x + 20, slot.current.abs.y + 2);
  await settle();
  assert.deepEqual(
    presses,
    [],
    'the slack above the control is not the button',
  );

  pressButton(wnd, control.abs.x + 20, control.abs.y + 11);
  await settle();
  assert.deepEqual(presses, ['press'], 'the control is');
  await root.unmount();
});

// Nothing above reaches a backend without bezels: the drawn control is one
// box, and the caller's style still sizes the box that *is* the control —
// which is why a stretched drawn control was only ever roomy.
test('the drawn control is one box, sized by the caller', async () => {
  const { root, tree } = await mount(
    h(Button, { style: { height: 44 } }, 'Done'),
    { app: createMockApp() },
  );
  const button = byRole(tree, 'button')[0];
  assert.equal(button.abs.height, 44);
  assert.deepEqual(
    button.children.map((c) => c.kind),
    ['text'],
    'no bezel, no wash, no footprint around it',
  );
  await root.unmount();
});
