// examples/configurator — the page is a function of one config object over
// a static catalogue, so what is worth pinning is that function showing
// through the UI: the price is the sum of what is chosen, the radio groups
// answer the keyboard, and Add to Bag acknowledges. Pixels stay out of it —
// a `boxShadow` does not paint on the in-process X server (ntk#287), and the
// selected ring is a shadow — so the assertions are the accessible states
// and the text a screen reader would be given.
import { test, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import {
  renderX11,
  cleanup,
  screen,
  waitFor,
  userEvent,
  fireEvent,
  act,
  textOf,
  XK_DOWN,
} from '../src/testing/index.js';

process.env.REACT_X11_NO_AUTORUN = '1';

const { Configurator, CATALOG, priceOf } =
  await import('../examples/configurator/index.jsx');
const { laptopPose } = await import('../examples/configurator/laptop3d.jsx');

afterEach(cleanup);

const h = React.createElement;

const mount = async (props) => {
  // 700 tall is below the artwork's `@height` query on purpose: the laptop
  // folds away and every interaction repaints that much less, which is the
  // difference between these tests and the suite timeout.
  const handle = await renderX11(h(Configurator, props), {
    width: 1120,
    height: 700,
  });
  // Wait for layout, not just mount: clicks need a rect to aim at.
  await waitFor(() => {
    const card = radio('Argon 9 Pro');
    assert.ok(card.abs?.width > 0, 'not laid out yet');
  });
  return handle;
};

// The accessible name of a card is all of its text, so `getByRole` with a
// short name matches several cards ("Argon 9" is inside "Argon 9 Pro" too).
// The `aria-label` is the crisp identity, so query by exactly that.
const labeled = (role) => (label) => {
  const found = screen.all(
    (n) => n.props?.role === role && n.props?.['aria-label'] === label,
  );
  assert.equal(found.length, 1, `one ${role} labeled "${label}"`);
  return found[0];
};
const radio = labeled('radio');
const checkbox = labeled('checkbox');
const button = labeled('button');

const checked = (node) => node.props['aria-checked'] === true;
const total = () => textOf(screen.getByTestName('total'));

// The options pane scrolls, and a card below the fold has no rect a click
// can land on. Focusing scrolls it into view — the same path a Tab reaches
// it by — so this is a user gesture, not test reach-around.
const shown = async (node) => {
  await act(() => node.focus());
  return node;
};

describe('examples/configurator', () => {
  test('the price is the sum of what is chosen', async () => {
    await mount();
    assert.equal(total(), '$1,599'); // CATALOG.base, formatted

    await userEvent.click(radio('Argon 9 Max')); // +$700
    await waitFor(() => assert.equal(total(), '$2,299'));

    await userEvent.click(await shown(checkbox('Meridian Care+'))); // +$199
    await waitFor(() => assert.equal(total(), '$2,498'));

    // …and the same number the catalogue arithmetic gives, so the test
    // fails if the two ever drift apart rather than agreeing on a typo.
    const expected = priceOf({
      finish: 'fog',
      chip: 'argon9max',
      memory: 'm16',
      storage: 's512',
      extras: ['care'],
    });
    assert.equal(total(), `$${expected.toLocaleString('en-US')}`);
  });

  test('a choice is one selection per group, announced as checked', async () => {
    await mount();
    assert.ok(checked(radio('Argon 9')));

    await userEvent.click(radio('Argon 9 Pro'));
    await waitFor(() => assert.ok(checked(radio('Argon 9 Pro'))));
    assert.ok(!checked(radio('Argon 9')), 'the old choice is unchecked');
    // the other groups did not move
    assert.ok(checked(radio('16 GB')));
    assert.ok(checked(radio('512 GB')));
  });

  test('the arrow keys rove a radio group, and the price follows', async () => {
    await mount();
    // A click focuses the card (focus follows mousedown), so the arrows
    // land on the group from wherever the user last chose.
    await userEvent.click(await shown(radio('512 GB')));
    await act(() => fireEvent.key(XK_DOWN));
    await waitFor(() => assert.ok(checked(radio('1 TB'))));
    assert.equal(total(), '$1,849');
  });

  test('an upgraded build says it ships later', async () => {
    await mount({
      initial: {
        finish: 'clay',
        chip: 'argon9max',
        memory: 'm24',
        storage: 's2tb',
        extras: [],
      },
    });
    // The estimate is part of the configuration's answer, not decoration.
    assert.match(textOf(screen.getByTestName('delivery')), /2–3 WEEKS/);
    assert.match(
      textOf(screen.getByTestName('summary')),
      /^CLAY · ARGON 9 MAX/,
    );
  });

  test('an extra toggles off as well as on', async () => {
    await mount();
    await userEvent.click(await shown(checkbox('Aurora keys')));
    await waitFor(() => assert.ok(checked(checkbox('Aurora keys'))));
    assert.equal(total(), '$1,648');

    await userEvent.click(checkbox('Aurora keys'));
    await waitFor(() => assert.ok(!checked(checkbox('Aurora keys'))));
    assert.equal(total(), '$1,599');
  });

  test('the finish reaches the artwork summary', async () => {
    await mount();
    await userEvent.click(radio('Graphite'));
    await waitFor(() =>
      assert.match(textOf(screen.getByTestName('summary')), /^GRAPHITE · /),
    );
  });

  test('Add to Bag acknowledges, counts, and hands the config out', async () => {
    const added = [];
    // The acknowledgment is a wall-clock transient, so the assertion below
    // would be racing one: `ackMs` takes the clock out of it rather than
    // trusting that a click stays faster than 1800ms on every machine.
    await mount({
      onAddToBag: (config, price) => added.push({ config, price }),
      ackMs: 60_000,
    });

    await userEvent.click(button('Add to Bag'));
    await waitFor(() => screen.getByText('✓ Added'));
    assert.match(textOf(screen.getByTestName('bag')), /1/);

    assert.equal(added.length, 1);
    assert.equal(added[0].price, CATALOG.base);
    assert.equal(added[0].config.chip, 'argon9');
  });
  test('the laptop is shut at the top of the page and open at the bottom', () => {
    // The pose is the only part of the 3D panel a headless test can see: GL
    // renders where GetImage cannot read it, so there is no pixel to assert
    // on (docs/glx.md). What matters is that it is a *function of the scroll
    // position* — the same offset gives the same frame, and it only opens.
    const shut = laptopPose(0);
    const open = laptopPose(1);
    assert.ok(shut.lid < 0.1, `shut at the top, got ${shut.lid}`);
    assert.ok(open.lid > 1.9, `open at the bottom, got ${open.lid}`);
    assert.ok(open.turn > shut.turn, 'and it turns as it opens');

    let previous = -Infinity;
    for (let i = 0; i <= 20; i++) {
      const { lid } = laptopPose(i / 20);
      assert.ok(lid >= previous, `the lid never closes again (at ${i / 20})`);
      previous = lid;
    }
    // Past either end it holds rather than folding through itself, because a
    // scroll container answers with offsets outside its own travel.
    assert.deepEqual(laptopPose(-3), shut);
    assert.deepEqual(laptopPose(9), open);
  });

  test('without a shader-capable GL context the flat laptop is what renders', async () => {
    // Which is what this suite runs on: the in-process server has no GLX, so
    // `useSupports('shaders')` is false and the ladder goes down a rung. The
    // page still has its product shot, and every assertion above still held.
    await mount();
    screen.getByTestName('stage');
    assert.equal(screen.queryAllByTestName('stage-gl').length, 0);
  });
});
