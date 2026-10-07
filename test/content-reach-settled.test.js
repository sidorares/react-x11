// A box a pass reached only because its parent was laid out again keeps the
// content reach it had, when none of its own children was laid out again
// (src/nodes/scrollable.js, `childrenSettled`). A column laid out for one
// block that grew flags every block in it; before this, each such block's
// children were read back out of yoga to find the reach it already had —
// most of an edit's walk over a 600 KB document's 1,704 blocks.
//
// What has to hold is the extent: what overflows a block that did not change
// still counts, a change inside one is still seen, and a block that lost its
// only child no longer reaches past itself — the one change a child's flag
// cannot report, since there is no child left to carry it.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createMockApp, flushFrames } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function mountPane(render) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  const draw = (props) =>
    x11Root.render(
      h(
        'window',
        { width: 200, height: 100 },
        h(
          'box',
          { ref, style: { overflow: 'scroll', flexGrow: 1 } },
          render(props),
        ),
      ),
    );
  return {
    app,
    ref,
    async show(props) {
      draw(props);
      await tick();
      flushFrames(app.windows[0]);
      await tick();
    },
  };
}

// A column of blocks 20 high. Block `tall` holds a child 90 high that
// overflows it; block 0 is `first` high; `bare` has no child at all.
const column = ({ first = 20, tall = 7, blocks = 12, bare = -1 }) =>
  h(
    'box',
    { style: { flexDirection: 'column' } },
    ...Array.from({ length: blocks }, (_, i) =>
      h(
        'box',
        { key: i, style: { height: i === 0 ? first : 20, flexShrink: 0 } },
        i === bare
          ? null
          : h('box', {
              style: { height: i === tall ? 90 : 10, flexShrink: 0 },
            }),
      ),
    ),
  );

test('a block the column moved still reaches as far as it did', async () => {
  const pane = await mountPane(column);
  await pane.show({ tall: 11 });
  // the last block starts at 11 * 20 = 220, and its child reaches 90 below
  assert.equal(pane.ref.current.contentHeight, 310);

  // the first block growing lays the column out again, and every block in it
  // with it: the last one's overflow moves down by the 30 it grew
  await pane.show({ tall: 11, first: 50 });
  assert.equal(
    pane.ref.current.contentHeight,
    340,
    'the overflow moved with its block',
  );
});

test('a change inside a block that moved is still seen', async () => {
  const pane = await mountPane(column);
  await pane.show({ tall: 11 });
  await pane.show({ tall: 10, first: 50 });
  // the overflow went from the last block to the one before it, as the
  // column grew by 30: it reaches from 50 + 9 * 20 = 230, 90 down
  assert.equal(pane.ref.current.contentHeight, 320);
});

test('a block that lost its only child reaches no further than itself', async () => {
  const pane = await mountPane(column);
  await pane.show({ tall: 11 });
  assert.equal(pane.ref.current.contentHeight, 310);
  // the overflowing child goes, and the column is laid out again for the
  // first block as well, so the last block is flagged with nothing in it
  await pane.show({ tall: 11, first: 50, bare: 11 });
  assert.equal(pane.ref.current.contentHeight, 50 + 11 * 20);
});
