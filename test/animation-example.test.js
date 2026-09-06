// examples/animation.jsx — the claims the example makes, pinned.
//
// The example is a demonstration of *where* an animation runs and *when*
// it stops, and each caption in it is a claim: the chip reverses from where
// it got to, reduced motion stops the loops and not the transitions, and on
// the layer presenter the three plain-box loops cost no frames. A caption
// that drifted from the code would be worse than no example, so every one
// of them is a test.
//
// Headless: the in-process X server for the frame-clock half, the mock
// harness with the layer presenter over a recording bridge for the offload,
// and a CocoaApp over a fake bridge for the surface presenter's promotion.
import { test, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import {
  act,
  cleanup,
  pressButton,
  renderX11,
  screen,
  userEvent,
  withFrameClock,
} from '../src/testing/index.js';
import { setDesktopSettingsForTests } from '../src/desktopsettings.js';
import { fakeCocoaApp, pointerOver } from './helpers/cocoa-bridge.js';
import { animatingPresenterFor } from './helpers/layer-presenter.js';

process.env.REACT_X11_NO_AUTORUN = '1';

const { AnimationPanel } = await import('../examples/animation.jsx');

afterEach(cleanup);

const h = React.createElement;

const mount = (options) =>
  renderX11(h(AnimationPanel), { width: 640, height: 570, ...options });

/** The properties the frame clock is animating, across every node. */
const onTheClock = (windowNode) =>
  [
    ...new Set(
      [...windowNode._animating].flatMap((n) => [...(n._anim?.keys() ?? [])]),
    ),
  ].sort();

describe('examples/animation', () => {
  test('every loop it declares runs, and on the frame clock', async () => {
    const clock = withFrameClock();
    try {
      const { windowNode } = await mount();
      assert.deepEqual(onTheClock(windowNode), [
        'backgroundColor',
        'borderRadius',
        'borderWidth',
        'color',
        'start',
      ]);
      // three tiles, four easing dots, the bar's block, the ink
      assert.equal(windowNode._animating.size, 9);
      // …and the frame clock moves them: the dots leave together
      const before = screen.getByTestName('pulse').style.backgroundColor;
      clock.advance(450);
      await act();
      assert.notEqual(
        screen.getByTestName('pulse').style.backgroundColor,
        before,
      );
    } finally {
      clock.restore();
    }
  });

  test('the chip reverses from where it got to, per property', async () => {
    const clock = withFrameClock();
    try {
      await mount();
      const chip = screen.getByTestName('chip');
      await userEvent.click(chip);
      const first = chip._anim.get('borderWidth');
      assert.deepEqual([first.from, first.to], [1, 6]);
      assert.deepEqual(
        [...chip._anim.keys()].sort(),
        ['backgroundColor', 'borderColor', 'borderRadius', 'borderWidth'],
        '`transition: 600` covers every property that changed',
      );

      clock.advance(300);
      await act();
      const partway = chip.style.borderWidth;
      assert.ok(partway > 1 && partway < 6, `mid-flight at ${partway}`);

      await userEvent.click(chip); // change of mind before it lands
      const back = chip._anim.get('borderWidth');
      assert.deepEqual(
        [back.from, back.to],
        [partway, 1],
        'from what is on screen, not from the end',
      );
      clock.advance(600);
      await act();
      assert.equal(chip.style.borderWidth, 1);
      assert.ok(!chip._anim?.size, 'over when it arrives');
    } finally {
      clock.restore();
    }
  });

  test('reduce motion stops the loops and leaves the transitions alone', async () => {
    const clock = withFrameClock();
    try {
      const { windowNode, app } = await mount();
      setDesktopSettingsForTests(app, { animations: false });
      await act();
      assert.equal(windowNode._animating.size, 0, 'every loop stopped');
      const pulse = screen.getByTestName('pulse');
      assert.ok(!pulse._anim?.size, 'resting at the declared value');

      const chip = screen.getByTestName('chip');
      await userEvent.click(chip);
      assert.ok(
        chip._anim?.get('borderWidth'),
        'a transition still answers the click',
      );
      assert.ok(windowNode._animating.has(chip));

      setDesktopSettingsForTests(app, { animations: true });
      await act();
      assert.ok(windowNode._animating.has(pulse), 'back, live');
    } finally {
      clock.restore();
    }
  });

  test('unticking a column takes its loops off the clock', async () => {
    const clock = withFrameClock();
    try {
      const { windowNode } = await mount();
      const column = screen.getByRole('checkbox', { name: /colour/ });
      await userEvent.click(column);
      assert.deepEqual(onTheClock(windowNode), ['color', 'start']);
      await userEvent.click(column);
      assert.ok(
        onTheClock(windowNode).includes('backgroundColor'),
        'ticked again: from the top',
      );
    } finally {
      clock.restore();
    }
  });

  test('on the surface presenter the plain-box loops, the chip and the hovered card get layers of their own, and cost no frames', async () => {
    const clock = withFrameClock();
    try {
      const { app, native } = fakeCocoaApp();
      const { windowNode } = await mount({ app });
      const promotion = windowNode.window._promotion;
      assert.ok(promotion, 'the surface window promotes');
      await act();
      const promoted = () =>
        [...promotion.promoted.keys()]
          .map((n) => n.props['data-testname'] ?? n.kind)
          .sort();
      // declared at mount, the three loops moved over on the first frame
      assert.deepEqual(promoted(), ['breathe', 'pulse', 'round']);
      assert.deepEqual(
        onTheClock(windowNode),
        ['color', 'start'],
        'the other column stays on the clock',
      );
      const taken = native
        .of('addAnimation')
        .map(([, keyPath, opts]) => [keyPath, opts.repeat, opts.autoreverse])
        .sort();
      assert.deepEqual(taken, [
        ['backgroundColor', Infinity, true],
        ['borderWidth', Infinity, true],
        ['cornerRadius', Infinity, true],
      ]);
      // every promoted layer is a sublayer of the window root, and the
      // three tiles kept their paint order
      const rootLayer = windowNode.window._layer;
      for (const { visual } of promotion.promoted.values()) {
        assert.equal(visual.layer.parent, rootLayer);
      }

      // the hover card answers on a layer of its own — text and all
      const card = screen.getByText('hover, press').parent;
      pointerOver(app, card);
      await act();
      assert.ok(card._promoted, 'promoted for the fade');
      assert.ok(
        promotion.promoted.get(card).content,
        'its two captions ride the layer as one raster',
      );
      assert.equal(
        native
          .of('addAnimation')
          .filter(
            ([layer]) => layer === promotion.promoted.get(card).visual.layer,
          ).length,
        2,
        'backgroundColor and borderColor, in the render server',
      );
      assert.ok(!windowNode._animating.has(card));

      // …and the chip, a plain box inside a bordered card: promoted on the
      // click, above its card's raster
      const chip = screen.getByTestName('chip');
      pointerOver(app, chip, { press: true });
      await act();
      assert.ok(chip._promoted);
      assert.deepEqual([...chip._anim.keys()].sort(), [
        'backgroundColor',
        'borderColor',
        'borderRadius',
        'borderWidth',
      ]);
      assert.ok([...chip._anim.values()].every((a) => a.offloaded));

      // untick the clock column, and nothing is left for the frame clock
      const column = screen.getByRole('checkbox', { name: /position/ });
      pointerOver(app, column, { press: true, dx: -column.abs.width / 2 + 16 });
      await act();
      assert.equal(windowNode._animating.size, 0, 'zero frames a second');
      assert.ok(promotion.animations.live.size >= 3, 'the tiles, still going');
    } finally {
      clock.restore();
    }
  });

  test('on the layer presenter the plain-box loops cost no frames', async () => {
    const clock = withFrameClock();
    try {
      const mounted = await mount({ backend: 'mock' });
      const { windowNode } = mounted;
      const { presenter, bridge } = animatingPresenterFor(mounted);
      // Declared at mount, the loops started on the clock before the window
      // had a presenter; the next swap with the same declarations moves
      // over what the presenter can take.
      await mounted.rerender(h(AnimationPanel));
      presenter.frame(windowNode);

      const taken = bridge
        .argsOf('addAnimation')
        .map(([keyPath, opts]) => [keyPath, opts.repeat, opts.autoreverse])
        .sort();
      assert.deepEqual(taken, [
        ['backgroundColor', Infinity, true],
        ['borderWidth', Infinity, true],
        ['cornerRadius', Infinity, true],
      ]);
      assert.deepEqual(
        onTheClock(windowNode),
        ['color', 'start'],
        'the other column stays on the clock',
      );

      // untick it, and nothing is left for the frame clock to do
      const column = screen.getByRole('checkbox', { name: /position/ });
      pressButton(windowNode.window, column.abs.x + 8, column.abs.y + 8);
      await act();
      assert.equal(windowNode._animating.size, 0, 'zero frames a second');
      assert.equal(
        presenter.animations.live.size,
        3,
        'three tiles, still going',
      );
    } finally {
      clock.restore();
    }
  });
});
