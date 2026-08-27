// A style that arrives before a node's first frame is the node's first
// appearance, not a change — so no transition may start from it.
//
// The case that found this (examples/configurator): a node is constructed
// *detached*, so its `$accent` resolves against the desktop palette; attach
// re-resolves it against the app's `theme`. With a `transition` on the
// property, the mount then animated from a colour that was never on screen —
// on a dark desktop, every themed card faded in from the dark palette, and
// under a stalled frame clock it simply stayed there. CSS's rule is the one
// pinned here: an inserted element appears at its style, and transitions
// start on the changes that come after.
//
// Headless: the mock app, with the animation clock frozen so a transition
// that does start is caught at its `from` value rather than raced to its
// end.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { setAnimationClock } from '../src/nodes.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const chip = (style) =>
  h('box', {
    style: {
      width: 40,
      height: 40,
      backgroundColor: '$accent',
      transition: { backgroundColor: 400 },
      ...style,
    },
  });

async function mounted(children, body) {
  setAnimationClock(() => 1000);
  const app = createMockApp();
  const root = await createRoot({ app });
  try {
    const render = (kids) =>
      root.render(
        h(
          'window',
          { width: 400, height: 200, theme: { accent: '#123456' } },
          kids,
        ),
      );
    render(children);
    await body({
      window: app.windows[0]._reactX11Node,
      render,
    });
  } finally {
    root.unmount();
    setAnimationClock(() => Date.now());
  }
}

test('mounting under a theme does not transition from the desktop palette', async () => {
  await mounted(chip(), async ({ window }) => {
    const node = window.children[0];
    // Synchronously after the mount — before any frame — the node already
    // sits at the app's colour. The bug this pins: attach re-resolves the
    // token and the transition machinery took that for a change, so the
    // style here was the *desktop* accent, travelling.
    assert.equal(node.style.backgroundColor, '#123456');
    assert.ok(!node._anim?.size, 'no transition may run at mount');
    await tick(); // the first frame changes nothing about that
    assert.equal(node.style.backgroundColor, '#123456');
  });
});

test('a change after the first frame still transitions', async () => {
  await mounted(chip(), async ({ window, render }) => {
    await tick(); // first frame: the node is placed now
    render(chip({ backgroundColor: '#abcdef' }));
    const node = window.children[0];
    assert.equal(node._anim?.size, 1, 'the change animates');
    // the clock is frozen, so the style still shows the journey's start —
    // which is the colour that was actually on screen
    assert.equal(node.style.backgroundColor, '#123456');
  });
});
