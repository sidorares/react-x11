// examples/chat.jsx, driven through `react-x11/test` — and the reason the
// example's transport is a seam rather than a module-level socket: the whole
// app runs here against a fake server with its timers turned down, on the
// in-process X server, with no display.
//
// Each test was checked by mutation — break the thing it names and that test,
// and only that test, goes red.
//
// One of them is here because this file was wrong about its own limits. It
// used to carry a note saying the optimistic reducer's identity check could
// not be observed from outside, since a duplicate would live for a single
// render. A duplicate is exactly what a human then saw: a message posting,
// then flickering into two for a moment. The lesson is not that the note was
// mistaken about the window — it is that "too brief to test" was an
// assumption, and the assertion that catches it does not race the window at
// all. It asks whether the message kept its id, which is the property that
// makes the duplicate impossible.
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
  within,
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

/** The `msg-<id>` testname of the row carrying `text`, or undefined. */
function rowIdFor(channel, text) {
  const row = within(log(channel))
    .getAllByText(text)
    .map((n) => {
      let up = n;
      while (
        up &&
        !String(up.props?.['data-testname'] ?? '').startsWith('msg-')
      )
        up = up.parent;
      return up?.props?.['data-testname'];
    })
    .filter(Boolean);
  return row[0];
}

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
  });

  test('a delivered message keeps the id it was sent with', async () => {
    const transport = testTransport();
    await mount(transport);

    await userEvent.type(composer('#general'), 'keep my id\n');

    // The row the optimistic entry is drawn in.
    const optimisticId = rowIdFor('#general', 'keep my id');
    assert.ok(optimisticId, 'no row for the optimistic message');

    transport.flush();

    await waitFor(() => {
      assert.match(textOf(log('#general')), /✓/);
    });

    // Same row, same id. This is the whole of it: `useOptimistic`'s reducer
    // recognises the delivered message as the one it is already showing by
    // **id**, so it stops adding its own copy. Let the transport mint a fresh
    // id — which is what it used to do — and the reducer sees a list that
    // does not contain `local`, appends it again, and the message is on
    // screen twice until the transition ends. That flicker is visible to a
    // human and was not visible to this suite, which is why the id is on the
    // row rather than the assertion being about text alone.
    assert.equal(
      rowIdFor('#general', 'keep my id'),
      optimisticId,
      'the delivered message replaced the optimistic one instead of joining it',
    );
    assert.equal(
      (textOf(log('#general')).match(/keep my id/g) ?? []).length,
      1,
    );
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

  // Not tested here: that the current channel keeps its accent under the
  // pointer. It is a `:hover` block winning over a base colour, which is a
  // paint-time decision, and every attempt to read it back through `pixelAt`
  // in this harness returned an unpainted white window — a harness problem
  // rather than an app one, but a test that cannot see the thing it names is
  // worse than none. Verified on a real display instead; the styles carry the
  // reason in a comment.

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
