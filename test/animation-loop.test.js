// `style.animation` — the looping half of the animation machinery, and
// `<ProgressBar indeterminate>` on top of it.
//
// A transition stops because it arrives. A loop never does, so most of what
// is worth pinning here is the *stopping*: unmapped, minimized, obscured,
// hidden by a style, unmounted, and a desktop that asked for less motion.
// Each one is a window that would otherwise keep drawing frames nobody can
// see — a battery going down with nothing on screen to show for it, which
// no other test would ever notice.
//
// Headless: the mock app, and the frame clock driven by hand rather than
// slept through.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { ProgressBar } from '../src/components/index.js';
import { setAnimationClock } from '../src/nodes.js';
import { animationValueAt, animationsOf, interpolate } from '../src/styles.js';
import { setDesktopSettingsForTests } from '../src/desktopsettings.js';
import { setWindowStateForTests } from '../src/windowstate.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const nodeOf = (app, index = 0) => app.windows[index]._reactX11Node;

/** A window with `children`, the animation clock stopped at 1000, and the
 *  clock put back however the test goes. */
async function withClock(children, body) {
  let clock = 1000;
  setAnimationClock(() => clock);
  let root;
  try {
    const app = createMockApp();
    root = await createRoot({ app });
    root.render(h('window', { width: 400, height: 200 }, children));
    await tick();
    const window = nodeOf(app);
    await body({
      app,
      root,
      window,
      get now() {
        return clock;
      },
      /** Advance the clock and run the frame it would have caused. */
      frame(ms) {
        clock += ms;
        window._advanceAnimations(clock);
        return clock;
      },
      render(next) {
        root.render(h('window', { width: 400, height: 200 }, next));
        return tick();
      },
    });
  } finally {
    // The mock window has no `requestAnimationFrame`, so an unstopped loop
    // reschedules itself through `setImmediate` for as long as the process
    // lives — the test would pass and the runner would never exit.
    root?.unmount();
    setAnimationClock(() => Date.now());
  }
}

const bar = (style) =>
  h('box', { style: { width: 200, height: 20 } }, h('box', { style }));

const SLIDE = {
  position: 'absolute',
  top: 0,
  width: '40%',
  height: 20,
  left: '-40%',
  backgroundColor: '#3b82f6',
  animation: { left: { to: '100%', duration: 1000 } },
};

test('a loop keeps going where a transition would have landed', async () => {
  await withClock(bar(SLIDE), ({ window, frame }) => {
    const block = window.children[0].children[0];
    assert.strictEqual(
      block.style.left,
      '-40%',
      'the resting value is `from`, before any frame has run',
    );
    assert.strictEqual(window._animating.size, 1, 'the clock is running');

    frame(250);
    assert.strictEqual(block.style.left, '-5%');
    frame(250);
    assert.strictEqual(block.style.left, '30%', 'linear by default');

    // …and past the end, where a transition would have stopped
    frame(500);
    assert.strictEqual(block.style.left, '-40%', 'back to the start');
    assert.strictEqual(
      window._animating.size,
      1,
      'and still asking for frames',
    );
    frame(250);
    assert.strictEqual(block.style.left, '-5%', 'a second crossing');
  });
});

test('the layout follows the loop, so a percentage travel needs no measuring', async () => {
  await withClock(bar(SLIDE), ({ window, frame }) => {
    const block = window.children[0].children[0];
    assert.deepStrictEqual(
      { x: block.abs.x, width: block.abs.width },
      { x: -80, width: 80 },
      '40% of a 200px track, starting off its edge',
    );
    frame(500);
    window.flush();
    assert.strictEqual(block.abs.x, 60, 'a third of the way across');
  });
});

test('a loop claims the bar it moves, not the window', async () => {
  await withClock(
    h(ProgressBar, { indeterminate: true, style: { width: 200 } }),
    ({ window, frame }) => {
      window._damage = null;
      frame(100);
      // The track, because the block is out of flow and clipped to it — and
      // never the 400x200 window, which is the whole reason this is a
      // renderer feature rather than a setInterval in a component. 202x10 is
      // a 200x8 bar with the one pixel of slack every claim carries.
      assert.deepStrictEqual(
        window._damage,
        [{ x: -1, y: -1, width: 202, height: 10 }],
        'the frame repaints the bar, not the window',
      );
    },
  );
});

test('alternate turns the loop around instead of wrapping', async () => {
  const spec = {
    ...SLIDE,
    animation: { left: { to: '100%', duration: 1000, alternate: true } },
  };
  await withClock(bar(spec), ({ window, frame }) => {
    const block = window.children[0].children[0];
    frame(500);
    assert.strictEqual(block.style.left, '30%');
    frame(500);
    assert.strictEqual(block.style.left, '100%', 'the far end');
    frame(500);
    assert.strictEqual(block.style.left, '30%', 'coming back');
    frame(500);
    assert.strictEqual(block.style.left, '-40%');
  });
});

test('a re-render with the same declaration does not restart the loop', async () => {
  await withClock(bar(SLIDE), ({ window, frame, render }) => {
    const block = window.children[0].children[0];
    frame(500);
    assert.strictEqual(block.style.left, '30%');
    // a fresh object with the same contents — which is what every render of
    // a component that declares its style inline hands down
    return render(
      bar({ ...SLIDE, animation: { left: { to: '100%', duration: 1000 } } }),
    ).then(() => {
      assert.strictEqual(
        block.style.left,
        '30%',
        'the phase survived the commit',
      );
      frame(250);
      assert.strictEqual(block.style.left, '65%', 'and carried on from it');
    });
  });
});

test('a changed declaration starts again from the top', async () => {
  await withClock(bar(SLIDE), async ({ window, frame, render }) => {
    const block = window.children[0].children[0];
    frame(500);
    assert.strictEqual(block.style.left, '30%');
    await render(
      bar({ ...SLIDE, animation: { left: { to: '100%', duration: 500 } } }),
    );
    assert.strictEqual(
      block.style.left,
      '-40%',
      'a different motion is a different loop',
    );
  });
});

test('dropping the animation stops the loop and leaves the property at rest', async () => {
  await withClock(bar(SLIDE), async ({ window, frame, render }) => {
    const block = window.children[0].children[0];
    frame(500);
    const { animation, ...still } = SLIDE;
    assert.ok(animation, 'the fixture has one to drop');
    await render(bar(still));
    assert.strictEqual(block.style.left, '-40%');
    assert.strictEqual(window._animating.size, 0, 'the clock is idle');
  });
});

test('a loop stops when the node is unmounted', async () => {
  await withClock(bar(SLIDE), async ({ window, render }) => {
    assert.strictEqual(window._animating.size, 1);
    await render(h('box', { style: { width: 200, height: 20 } }));
    assert.strictEqual(window._animating.size, 0, 'the clock is idle');
    assert.strictEqual(window._loopNodes.size, 0, 'and nothing is remembered');
  });
});

test('a loop stops when something above it is display: none', async () => {
  const wrapped = (display) =>
    h(
      'box',
      { style: { width: 200, height: 20, display } },
      h('box', { style: SLIDE }),
    );
  await withClock(wrapped(undefined), async ({ window, render, frame }) => {
    assert.strictEqual(window._animating.size, 1);
    await render(wrapped('none'));
    assert.strictEqual(window._animating.size, 0, 'the clock is idle');
    await render(wrapped(undefined));
    assert.strictEqual(window._animating.size, 1, 'and runs again on reveal');
    const block = window.children[0].children[0];
    frame(500);
    assert.strictEqual(block.style.left, '30%');
  });
});

test('a loop stops while the window is unmapped', async () => {
  await withClock(bar(SLIDE), ({ window }) => {
    assert.strictEqual(window._animating.size, 1);
    window.setHidden(true);
    assert.strictEqual(window._animating.size, 0, 'the clock is idle');
    assert.strictEqual(window._loopsPaused, true);
    window.setHidden(false);
    assert.strictEqual(window._animating.size, 1, 'and again once mapped');
  });
});

test('a loop stops when the window manager minimizes or buries the window', async () => {
  await withClock(bar(SLIDE), ({ app, window }) => {
    assert.strictEqual(window._animating.size, 1);

    setWindowStateForTests(app, window, { states: ['hidden'] });
    assert.strictEqual(window._animating.size, 0, 'iconified: the clock idles');

    setWindowStateForTests(app, window, { states: [] });
    assert.strictEqual(window._animating.size, 1);

    // …and fully covered by another window, which only a bare window manager
    // reports (see the compositor caveat in windowstate.js)
    setWindowStateForTests(app, window, { obscured: true });
    assert.strictEqual(window._animating.size, 0, 'obscured: the clock idles');
    setWindowStateForTests(app, window, { obscured: false });
    assert.strictEqual(window._animating.size, 1);
  });
});

test('a desktop that asked for less motion never gets a loop', async () => {
  await withClock(bar(SLIDE), ({ app, window }) => {
    setDesktopSettingsForTests(app, { animations: false });
    assert.strictEqual(window._animating.size, 0, 'stopped where it was');
    const block = window.children[0].children[0];
    assert.strictEqual(block.style.left, '-40%', 'and left at its rest value');

    setDesktopSettingsForTests(app, { animations: true });
    assert.strictEqual(
      window._animating.size,
      1,
      'turning it back on is live, not a restart of the app',
    );
  });
});

test('a loop declaration says what is wrong with it, at the style', () => {
  const at = (animation) => () =>
    animationsOf({ left: 0, animation }, 'a style');
  assert.throws(at({ left: { duration: 100 } }), /has no "to" value/);
  assert.throws(at({ left: { to: 10 } }), /needs a positive "duration"/);
  assert.throws(
    at({ flexDirection: { to: 'row', duration: 100 } }),
    /"flexDirection" in a style cannot be animated/,
  );
  assert.throws(
    at({ left: { to: 10, duration: 100, easing: 'bouncy' } }),
    /unknown animation easing "bouncy"/,
  );
  assert.throws(
    at({ left: { to: 10, duration: 100, repeat: true } }),
    /unknown animation option "repeat"/,
  );
  assert.throws(
    () => animationsOf({ animation: { left: { to: 10, duration: 100 } } }),
    /has no "from" value/,
  );
  assert.throws(
    () =>
      animationsOf({
        animation: { left: { from: '50%', to: 10, duration: 100 } },
      }),
    /has no midpoint between "50%" and 10/,
  );
});

test('a loop takes theme tokens at both ends', async () => {
  const pulse = h(
    'box',
    { theme: { track: '#eeeeee', accent: '#3b82f6' } },
    h('box', {
      style: {
        width: 100,
        height: 20,
        backgroundColor: '$track',
        animation: {
          backgroundColor: { to: '$accent', duration: 1000, alternate: true },
        },
      },
    }),
  );
  await withClock(pulse, ({ window, frame }) => {
    const box = window.children[0].children[0];
    // `$track` is not a colour until the node has an ancestry to resolve it
    // against, which is after the style was written and validated — so the
    // ends are checked once they are real, and not before.
    assert.strictEqual(box.style.backgroundColor, 'rgba(238, 238, 238, 1)');
    frame(1000);
    assert.strictEqual(box.style.backgroundColor, 'rgba(59, 130, 246, 1)');
  });
});

test('percentages interpolate against each other and nothing else', () => {
  assert.strictEqual(interpolate('0%', '100%', 0.25), '25%');
  assert.strictEqual(interpolate('-40%', '100%', 0.5), '30%');
  assert.strictEqual(
    interpolate('10%', 20, 0.5),
    null,
    'a percentage and a pixel value have no midpoint before layout',
  );
  assert.strictEqual(interpolate('10%', 'auto', 0.5), null);
});

test('the phase comes from the elapsed time, not from counting cycles', () => {
  const [spec] = animationsOf({
    animation: { left: { from: 0, to: 100, duration: 1000 } },
  });
  assert.strictEqual(animationValueAt(spec, 0), 0);
  assert.strictEqual(animationValueAt(spec, 1000), 0, 'a whole cycle wraps');
  // an hour in, to the millisecond: a per-cycle restart would have drifted
  assert.strictEqual(animationValueAt(spec, 3600 * 1000 + 250), 25);
});

test('<ProgressBar indeterminate> announces busy with no value, and slides', async () => {
  await withClock(
    h(ProgressBar, { indeterminate: true, style: { width: 200 } }),
    ({ window, frame }) => {
      const track = window.children[0];
      assert.strictEqual(track.props.role, 'progressbar');
      assert.strictEqual(track.props['aria-busy'], true);
      assert.strictEqual(
        track.props['aria-valuenow'],
        undefined,
        'no value: "42%" is not coming',
      );

      const block = track.children[0];
      assert.strictEqual(block.abs.x, -80, 'parked off the start edge');
      frame(550);
      window.flush();
      assert.strictEqual(block.abs.x, 60, 'and travelling');
      assert.strictEqual(window._animating.size, 1);
    },
  );
});

test('<ProgressBar value> is unchanged: a value, no loop', async () => {
  await withClock(
    h(ProgressBar, { value: 0.25, style: { width: 200 } }),
    ({ window }) => {
      const track = window.children[0];
      assert.strictEqual(track.props['aria-valuenow'], 0.25);
      assert.strictEqual(track.props['aria-busy'], undefined);
      assert.strictEqual(window._animating.size, 0, 'nothing is animating');
    },
  );
});

test('<ProgressBar indeterminate> parks in the track when motion is reduced', async () => {
  let clock = 1000;
  let root;
  setAnimationClock(() => clock);
  try {
    const app = createMockApp();
    setDesktopSettingsForTests(app, { animations: false });
    root = await createRoot({ app });
    root.render(
      h(
        'window',
        { width: 400, height: 200 },
        h(ProgressBar, { indeterminate: true, style: { width: 200 } }),
      ),
    );
    await tick();
    const window = nodeOf(app);
    const track = window.children[0];
    const block = track.children[0];
    assert.strictEqual(window._animating.size, 0, 'nothing is moving');
    assert.strictEqual(
      block.abs.x,
      60,
      'the block sits in the track rather than off its edge — still working, ' +
        'and not a full bar, which is what finished looks like',
    );
    assert.strictEqual(track.props['aria-busy'], true, 'and still says so');
  } finally {
    root?.unmount();
    setAnimationClock(() => Date.now());
  }
});
