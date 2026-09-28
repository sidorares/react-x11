// A scroll pane's measure reads every box in it, and leaves each one for the
// walk that places it later in the same walk (`laidBox`, `layoutDiff.boxes`)
// rather than that walk reading it out of yoga a second time. What has to
// hold is that every box still lands where yoga put it — through a column
// that moved under a block that grew, a child that left, a pane scrolled
// part of the way down, and a pane inside a pane — and that nothing it read
// outlives the walk.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { layoutDiff } from '../src/nodes/damage.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Every box whose `abs` is not where yoga's own numbers put it. */
function misplaced(win) {
  const out = [];
  const walk = (node, ox, oy) => {
    for (const child of node.children) {
      if (!child.yoga || child.isWindow) continue;
      const yoga = child.yoga;
      const want = {
        x: ox + yoga.getComputedLeft(),
        y: oy + yoga.getComputedTop(),
        width: yoga.getComputedWidth(),
        height: yoga.getComputedHeight(),
      };
      const { x, y, width, height } = child.abs;
      if (
        x !== want.x ||
        y !== want.y ||
        width !== want.width ||
        height !== want.height
      ) {
        out.push(
          `${child.props.id ?? child.kind} at ${JSON.stringify(child.abs)}, ` +
            `laid out at ${JSON.stringify(want)}`,
        );
      }
      const scroller = child.isScroller?.() === true;
      walk(
        child,
        want.x - (scroller ? child.scrollX : 0),
        want.y - (scroller ? child.scrollY : 0),
      );
    }
  };
  walk(win, 0, 0);
  return out;
}

const pane = React.createRef();
const inner = React.createRef();

/**
 * A pane over a column of blocks, each holding a child that reaches past
 * it by `over`, one of them a pane of its own over a column of rows.
 */
const doc = ({ first = 20, over = 30, drop = -1, rows = 6, blocks = 8 }) =>
  h(
    'box',
    { id: 'pane', ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
    h(
      'box',
      { id: 'column', style: { padding: 4, gap: 3 } },
      ...Array.from({ length: blocks }, (_, i) =>
        i === 3
          ? h(
              'box',
              {
                key: i,
                id: 'inner',
                ref: inner,
                style: { overflow: 'scroll', height: 40, flexShrink: 0 },
              },
              ...Array.from({ length: rows }, (_, r) =>
                h('box', {
                  key: r,
                  id: `row ${r}`,
                  style: { height: 12, marginLeft: r, flexShrink: 0 },
                }),
              ),
            )
          : h(
              'box',
              {
                key: i,
                id: `block ${i}`,
                style: { height: i === 0 ? first : 20, flexShrink: 0 },
              },
              i === drop
                ? null
                : h('box', {
                    id: `inside ${i}`,
                    style: { height: 20 + over, width: 30 + i, flexShrink: 0 },
                  }),
            ),
      ),
    ),
  );

test('every box a pane measured lands where yoga put it', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  const show = async (props) => {
    root.render(h('window', { width: 200, height: 100 }, doc(props)));
    await tick();
    app.windows[0].flushFrame?.();
    await tick();
    const win = app.windows[0]._reactX11Node;
    assert.deepStrictEqual(misplaced(win), [], JSON.stringify(props));
    assert.strictEqual(layoutDiff.boxes, null, 'the walk kept nothing');
    return win;
  };
  await show({});
  // part of the way down, so every box is placed against an offset
  pane.current.scrollTo(37);
  inner.current.scrollTo(9);
  await show({});
  // the first block grows: the column is laid out again and every block in
  // it moves down, the ones whose children did not change included
  await show({ first: 55 });
  // a child leaves a block, and the overflow it carried goes with it
  await show({ first: 55, drop: 5 });
  // the pane inside the pane gains rows, and its reach with them
  await show({ first: 55, drop: 5, rows: 11 });
  // everything reaches less far, and the outer pane clamps up
  await show({ first: 10, over: 0, drop: 5, rows: 2, blocks: 5 });
  await root.unmount();
});
