// examples/chat.jsx, driven through `react-x11/test` — and the reason the
// example's transport is a seam rather than a module-level socket: the whole
// app runs here against a fake server with its timers turned down, on the
// in-process X server, with no display.
//
// Three of the claims the example's header makes are the three tests: an
// optimistic message reconciles, a failed one rolls back, and a channel
// hidden behind <Activity> keeps its draft. All three were checked by
// mutation — break the thing each names and that test, and only that test,
// goes red. The fourth claim is not testable from here; see the note at the
// bottom.
//
// Note what the queries have to work around: **every channel is mounted**,
// which is the whole point of the example, so `getByRole('log')` would find
// three. The panes are told apart by their placeholder and a `data-testname`.
import { test, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import {
  renderX11,
  cleanup,
  screen,
  textOf,
  userEvent,
  waitFor,
} from '../src/testing/index.js';

process.env.REACT_X11_NO_AUTORUN = '1';

const { App, fixtureTransport, clearHistory } =
  await import('../examples/chat.jsx');

afterEach(() => {
  cleanup();
  clearHistory();
});

// No bots, so nothing arrives that a test did not ask for — and `hold`, so
// sends park until `flush()` rather than finishing on a timer.
//
// The timer version of this raced. An optimistic entry only exists between
// the send and its answer, so asserting on it means getting there first, and
// a 150ms window is a coin flip on a loaded runner. Holding the send makes
// the window unbounded and the test deterministic: there is no duration
// anywhere in this file.
const testTransport = (overrides = {}) =>
  fixtureTransport({ hold: true, botEvery: 0, ...overrides });

async function mount(transport) {
  const handle = await renderX11(React.createElement(App, { transport }), {
    width: 720,
    height: 520,
  });
  // Every pane suspends on its own history promise. Wait for the content
  // rather than for a duration: React throttles a commit that follows a
  // fallback shown very recently (docs/react-features.md).
  //
  // And wait for it to be *laid out*, not merely present. Layout runs on the
  // frame clock, a frame behind the commit, and `userEvent.click` needs a
  // rect to aim at — existing and being clickable are two different moments.
  await waitFor(() => {
    const node = screen.getByPlaceholder('message #general');
    assert.ok(node.abs?.width > 0, 'composer is not laid out yet');
  });
  return handle;
}

const composer = (channel) => screen.getByPlaceholder(`message ${channel}`);
const log = (channel) => screen.getByTestName(`log-${channel}`);
const channelRow = (channel) => screen.getByRole('listitem', { name: channel });

describe('examples/chat', () => {
  test('an optimistic message appears, then reconciles', async () => {
    const transport = testTransport();
    await mount(transport);

    await userEvent.type(composer('#general'), 'hello x11\n');

    // The send is parked, so this is the optimistic entry and nothing else:
    // on screen, and unacknowledged — the pane draws no tick until delivery.
    assert.match(textOf(log('#general')), /hello x11/);
    assert.doesNotMatch(textOf(log('#general')), /✓/);

    transport.flush();

    // The delivered message replaces it — same line, now acknowledged, and
    // still only one of it.
    await waitFor(() => {
      const body = textOf(log('#general'));
      assert.match(body, /✓/);
      assert.equal((body.match(/hello x11/g) ?? []).length, 1);
    });

    // What this does NOT pin: the reducer's idempotency. A blind append
    // duplicates the line only between `onDelivered` and the end of the
    // transition — one render, often not even a painted frame — so it is
    // invisible from out here. It is still a real trap; it is guarded by the
    // comment at the reducer, not by this test.
  });

  test('a send that fails rolls the message back', async () => {
    const transport = testTransport();
    await mount(transport);
    transport.state.failNext = true;

    await userEvent.type(composer('#general'), 'this one drops\n');
    assert.match(textOf(log('#general')), /this one drops/);

    transport.flush();

    // Nothing in the example removes it. React discards the optimistic state
    // when the transition ends, and the real list never had it.
    await waitFor(() => {
      assert.doesNotMatch(textOf(log('#general')), /this one drops/);
      screen.getByText('not sent');
    });
  });

  test('a channel keeps its draft across a switch', async () => {
    await mount(testTransport());

    await userEvent.type(composer('#general'), 'half a thought');
    await userEvent.click(channelRow('#x11'));
    await userEvent.click(channelRow('#general'));

    // Not restored from a store — the pane was never unmounted. Replace the
    // <Activity> with `channel === current ? <Pane/> : null` and this is the
    // assertion that fails, which is what makes it worth having.
    assert.equal(composer('#general').value, 'half a thought');
  });

  // Deliberately not tested here: the #202/#323 promise that a hidden pane
  // stops taking keys. This app cannot isolate it — the only way to hide a
  // channel is to click another one, and that click moves the focus itself,
  // so the assertion passes whether or not visibility is doing anything. A
  // test that passes for the wrong reason is worse than none; core's own
  // coverage is in test/focus-visibility.test.js.
});
