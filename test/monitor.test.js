// examples/monitor.jsx — the two registered elements, and the list they sit in.
//
// What this file can and cannot reach is worth saying up front, because the
// interesting half of the example is the half a headless test is worst at.
//
// **Testable here:** that `registerElement` produced elements which measure
// and paint — a `<sparkline>` has a size derived from its own data and puts
// ink where the series says, and a `<cpuhistory>` answers the scroll
// protocol off its extent rather than its position.
//
// **Not testable here:** the thing the example is *for*. Whether deferring
// keeps the field ahead of the list is a question about two renders landing
// at different times, and `act()` flushes both before an assertion can see
// either. The cost is real — one keystroke re-renders 800 rows in ~130ms,
// measured — but "the field stayed responsive" is a stopwatch and a pair of
// eyes. The switch in the header is there so it can be felt rather than
// asserted.
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
  windowNodesOf,
} from '../src/testing/index.js';

process.env.REACT_X11_NO_AUTORUN = '1';

const { MonitorPanel } = await import('../examples/monitor.jsx');

afterEach(cleanup);

const h = React.createElement;

/** Every node of a kind, anywhere under the root. */
function allOfKind(node, kind, out = []) {
  if (node.kind === kind) out.push(node);
  for (const child of node.children ?? []) allOfKind(child, kind, out);
  return out;
}

/** A sampler that answers from a table, so nothing here shells out to `ps`. */
function fakeSampler(rows, load = [10, 20, 30, 40]) {
  const listeners = new Set();
  const killed = [];
  return {
    killed,
    start() {
      listeners.forEach((fn) => fn({ rows, load }));
    },
    stop() {},
    onSample(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    kill(pid) {
      killed.push(pid);
      const err = new Error('operation not permitted');
      err.code = 'EPERM';
      throw err;
    },
  };
}

const proc = (i, name, cpu = 1) => ({
  pid: 1000 + i,
  cpu,
  mem: 1,
  name,
  history: Array.from({ length: 60 }, (_, j) => (j * 3) % 100),
});

describe('examples/monitor', () => {
  test('the list filters, and says how much of it is showing', async () => {
    const rows = [
      proc(0, 'alpha-one'),
      proc(1, 'beta-two'),
      proc(2, 'alpha-3'),
    ];
    await renderX11(h(MonitorPanel, { sampler: fakeSampler(rows) }), {
      width: 760,
      height: 560,
    });
    await waitFor(() => screen.getByText('3 of 3'));

    const field = screen.getByPlaceholder('filter — pid or name');
    field.props.onChange({ value: 'alpha' });

    await waitFor(() => screen.getByText('2 of 3'));
    screen.getByText('alpha-one');
    assert.equal(screen.queryAllByText('beta-two').length, 0);
  });

  test('a refused kill is shown rather than swallowed', async () => {
    const sampler = fakeSampler([proc(0, 'init')]);
    const { windowNode } = await renderX11(h(MonitorPanel, { sampler }), {
      width: 760,
      height: 560,
    });
    await waitFor(() => screen.getByText('1 of 1'));

    // Driven through the event system rather than by calling props: a prop
    // called by hand updates state outside `act`, and the flush that would
    // have opened the dialog never happens.
    await userEvent.click(screen.getByRole('option', { name: 'init' }));
    await userEvent.click(screen.getByText('Kill…'));

    // The dialog is a window of its own, so its button is not under the
    // toplevel — look through every pane for the one that is not "Kill…".
    const confirm = () => {
      for (const w of windowNodesOf(windowNode)) {
        const hit = within(w)
          .queryAllByText('Kill', { exact: true })
          .filter((n) => n !== null);
        if (hit.length) return hit[0];
      }
      return null;
    };
    await waitFor(() =>
      assert.ok(confirm(), 'the confirm dialog did not open'),
    );
    await userEvent.click(confirm());

    // Most processes are not yours to signal. The example's job is to say so
    // rather than to look like nothing happened.
    await waitFor(() => screen.getByText('not yours to kill'));
    assert.deepEqual(sampler.killed, [1000]);
  });

  test('<sparkline> is as wide as its capacity, not its samples', async () => {
    // The trap this pins: measuring the samples it happens to hold means the
    // element re-measures every tick and the whole list reflows once a
    // second. The size is its own, and stable.
    const rows = [proc(0, 'one')];
    await renderX11(h(MonitorPanel, { sampler: fakeSampler(rows) }), {
      width: 760,
      height: 560,
    });
    await waitFor(() => screen.getByText('1 of 1'));

    const spark = screen
      .getByRole('option', { name: 'one' })
      .children.find((n) => n.kind === 'sparkline');
    assert.ok(spark, 'no <sparkline> in the row');
    const wide = spark.abs.width;
    assert.ok(wide > 0, 'the sparkline measured to nothing');

    // half the samples, same width
    const short = [{ ...rows[0], history: rows[0].history.slice(0, 30) }];
    await renderX11(h(MonitorPanel, { sampler: fakeSampler(short) }), {
      width: 760,
      height: 560,
    });
    await waitFor(() => screen.getByText('1 of 1'));
    const spark2 = screen
      .getByRole('option', { name: 'one' })
      .children.find((n) => n.kind === 'sparkline');
    assert.equal(spark2.abs.width, wide);
  });

  test('<cpuhistory> answers the wheel off its extent, not its position', async () => {
    const long = Array.from({ length: 400 }, (_, i) => i % 100);
    const { windowNode } = await renderX11(
      h(MonitorPanel, { sampler: fakeSampler([proc(0, 'one')], long) }),
      { width: 760, height: 560 },
    );
    await waitFor(() => screen.getByText('1 of 1'));

    const [graph] = allOfKind(windowNode, 'cpuhistory');
    assert.ok(graph, 'no <cpuhistory> in the tree');

    // 400 samples at 3px each is wider than the pane, so the horizontal axis
    // has room. Both directions answer yes even at offset 0, and that is the
    // documented rule rather than a bug: `canScroll` reports the **extent,
    // not the position**, so a viewport at its end keeps the rest of a flick
    // instead of handing it to whatever is behind. I asserted the opposite
    // first and was wrong — extending.md says which.
    assert.equal(graph.canScroll(60, 0), true, 'no room on the wide axis');
    assert.equal(graph.canScroll(-60, 0), true, 'no room on the wide axis');

    // The vertical axis has no extent at all, and this is the half that
    // matters: an element that claimed the whole wheel would swallow a
    // downward flick and the list behind it would never scroll.
    assert.equal(graph.canScroll(0, 60), false, 'swallowed a vertical wheel');
    assert.equal(graph.canScroll(0, -60), false, 'swallowed a vertical wheel');

    graph.scrollBy({ x: 120, y: 0 });
    assert.equal(graph.scrollX, 120, 'scrollBy did not move the drawing');
  });
});
