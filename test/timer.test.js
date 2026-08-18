// examples/timer.jsx — the claims a countdown has to earn.
//
// Every assertion here is about the thing that makes this app different from
// a number that goes down: it follows a clock it does not control. The clock
// is a seam, so the whole file runs in milliseconds and can close a laptop
// lid for half an hour between two statements.
import { test, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import {
  renderX11,
  cleanup,
  screen,
  waitFor,
  userEvent,
  within,
  textOf,
  act,
} from '../src/testing/index.js';

process.env.REACT_X11_NO_AUTORUN = '1';

const { TimerPanel, manualClock, parseDuration, parseTimerUri } =
  await import('../examples/timer.jsx');

afterEach(cleanup);

const h = React.createElement;
const silent = () => {};

/** A notifier that counts, so "exactly once" is a number and not a feeling. */
function recorder(behaviour = async () => {}) {
  const sent = [];
  return {
    sent,
    kind: 'desktop',
    async notify(message) {
      sent.push(message);
      return behaviour(message);
    },
  };
}

const mount = async (props) => {
  const handle = await renderX11(
    h(
      'window',
      { width: 620, height: 430, style: { flexGrow: 1 } },
      h(TimerPanel, { log: silent, ...props }),
    ),
    { width: 620, height: 430 },
  );
  // Not a timer's name — every test brings its own set, and one of them
  // brings none. The status line is always there.
  await waitFor(() => {
    const field = screen.getByPlaceholder('25m');
    assert.ok(field.abs?.width > 0, 'not laid out yet');
  });
  return handle;
};

/** The row for a label, since a control's own text is not its timer's name. */
const rowFor = (label) => within(screen.getByRole('group', { name: label }));
const clockOf = (label) => textOf(rowFor(label).getByText(/^\d+:\d\d$/));

describe('examples/timer', () => {
  test('the countdown follows the clock, not the ticks', async () => {
    // The whole design decision, as one assertion. The lid is closed for half
    // an hour and no tick fires while the process is away, so the only way to
    // come back with the right number is to have stored the moment it ends.
    //
    // Note the *unfinished* timer: asserting only that a slept-through timer
    // reads 0:00 proves nothing, because expiry is decided by the deadline
    // directly — a countdown that subtracted its own interval would also show
    // 0:00 there, and pass. Half an hour off a one-hour timer is the assertion
    // that can tell the two apart.
    const clock = manualClock();
    await mount({ clock, notifier: recorder(), initial: [['Nap', 3_600_000]] });

    await userEvent.click(rowFor('Nap').getByText('Start'));
    await waitFor(() => rowFor('Nap').getByText('Pause'));

    clock.sleep(30 * 60_000);
    await waitFor(() => assert.equal(clockOf('Nap'), '30:00'));

    // …and then through the end of it, still asleep.
    clock.sleep(31 * 60_000);
    await waitFor(() => assert.equal(clockOf('Nap'), '0:00'));
  });

  test('it rings once, not once a tick', async () => {
    const clock = manualClock();
    const notifier = recorder();
    await mount({ clock, notifier, initial: [['Egg', 2000]] });

    await userEvent.click(rowFor('Egg').getByText('Start'));
    await waitFor(() => rowFor('Egg').getByText('Pause'));

    // Stepped, not one jump. `advance` fires its ticks synchronously and
    // React batches the lot into a single commit, so a burst reaches the
    // expiry effect once however long it is — and a version that rang from
    // the tick instead of from the transition would pass. Eight commits after
    // the deadline is what makes the difference visible.
    for (let i = 0; i < 8; i += 1) await act(() => clock.advance(1000));

    assert.equal(clockOf('Egg'), '0:00');
    assert.equal(notifier.sent.length, 1);
    assert.equal(notifier.sent[0].title, 'Egg finished');
  });

  test('pause holds the remaining time, and resume does not restart it', async () => {
    const clock = manualClock();
    await mount({ clock, notifier: recorder(), initial: [['Steep', 60_000]] });

    await userEvent.click(rowFor('Steep').getByText('Start'));
    clock.advance(20_000);
    await waitFor(() => assert.equal(clockOf('Steep'), '0:40'));

    await userEvent.click(rowFor('Steep').getByText('Pause'));
    // Paused means the clock is no longer this timer's clock: an hour of it
    // changes nothing.
    clock.advance(3_600_000);
    await waitFor(() => assert.equal(clockOf('Steep'), '0:40'));

    await userEvent.click(rowFor('Steep').getByText('Resume'));
    clock.advance(10_000);
    await waitFor(() => assert.equal(clockOf('Steep'), '0:30'));
  });

  test('a notifier that fails does not stop the clock', async () => {
    const clock = manualClock();
    const notifier = recorder(async () => {
      throw new Error('no notification service');
    });
    await mount({
      clock,
      notifier,
      initial: [
        ['First', 1000],
        ['Second', 5000],
      ],
    });

    await userEvent.click(rowFor('First').getByText('Start'));
    await userEvent.click(rowFor('Second').getByText('Start'));

    clock.advance(2000);
    await waitFor(() => assert.equal(clockOf('First'), '0:00'));

    // The rejection is the point: the second timer is still counting, which
    // is what "log it and keep going" has to mean.
    clock.advance(1000);
    await waitFor(() => assert.equal(clockOf('Second'), '0:02'));
    assert.equal(notifier.sent.length, 1);
  });

  test('reset goes back to the duration, from finished as well as from running', async () => {
    const clock = manualClock();
    await mount({ clock, notifier: recorder(), initial: [['Brew', 4000]] });

    await userEvent.click(rowFor('Brew').getByText('Start'));
    clock.advance(6000);
    await waitFor(() => assert.equal(clockOf('Brew'), '0:00'));

    await userEvent.click(rowFor('Brew').getByText('Reset'));
    await waitFor(() => assert.equal(clockOf('Brew'), '0:04'));
    // …and a reset timer is idle, not paused mid-way: Start, not Resume.
    rowFor('Brew').getByText('Start');
  });

  test('a duration that is not one cannot be added', async () => {
    await mount({ clock: manualClock(), notifier: recorder(), initial: [] });

    await userEvent.type(screen.getByPlaceholder('25m'), '25 monkeys');
    await waitFor(() => screen.getByText('not a duration'));
    assert.equal(screen.queryAllByRole('group').length, 0);

    // `25` alone is minutes — the one shorthand a kitchen timer has to take.
    // `userEvent.key` takes a **keysym number**: a name binds a spare keycode
    // and the field never sees a key it knows, which looks exactly like a
    // field that ignores BackSpace.
    const BACKSPACE = 0xff08;
    for (let i = 0; i < '25 monkeys'.length; i += 1)
      await userEvent.key(BACKSPACE);
    await userEvent.type(screen.getByPlaceholder('what for'), 'Rice');
    await userEvent.type(screen.getByPlaceholder('25m'), '12');
    await userEvent.click(screen.getByText('Add'));

    await waitFor(() => assert.equal(clockOf('Rice'), '12:00'));
  });

  test('the parser takes the links people actually type', () => {
    // Pure, and cheap enough to be exhaustive where the window cannot be.
    assert.equal(parseDuration('1h30m'), 5_400_000);
    assert.equal(parseDuration('90s'), 90_000);
    assert.equal(parseDuration('25'), 1_500_000);
    assert.equal(parseDuration('25 monkeys'), null);
    assert.equal(parseDuration('0m'), null);

    const url = 'com.example.x11timer://start/2m/Tea';
    assert.deepEqual(parseTimerUri(url), { ms: 120_000, label: 'Tea' });
    // written without the slashes, which is what a shell tends to produce
    assert.deepEqual(parseTimerUri('com.example.x11timer:start/90s'), {
      ms: 90_000,
      label: 'Timer',
    });
    assert.equal(parseTimerUri('com.example.x11timer://stop'), null);
    assert.equal(parseTimerUri('https://example.com/start/2m'), null);
  });
});
