// `position: 'sticky'`: laid out in flow like `relative`, then held inside the
// nearest scroll pane's edges by its insets — and never out of its parent's
// content box, which is what lets the next section push a header off
// (docs/styling.md, "Sticky positioning"). The placement runs after every
// layout pass, the one a scroll runs included (nodes.js,
// `WindowNode._placeNodes`), so these tests scroll and read `abs` the frame
// after — there is no later frame for the answer to arrive in.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';
import {
  renderX11,
  cleanup,
  userEvent,
  expectPixel,
} from '../src/testing/index.js';
import { createMockApp } from './helpers/mock-app.js';
import { presenterFor } from './helpers/layer-presenter.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function mount(children, { width = 200, height = 100, scale } = {}) {
  const app = createMockApp();
  const x11Root = await createRoot({ app, ...(scale && { scale }) });
  const render = (kids) => x11Root.render(h('window', { width, height }, kids));
  render(children);
  await tick();
  await tick();
  const wnd = app.windows[0];
  return { app, wnd, root: wnd._reactX11Node, x11Root, render };
}

const frame = () => tick().then(tick);

/** A section: a header that sticks, and rows under it. */
const HEADER = 20;
const ROW = 30;
function section(key, ref, { rows = 4, header = {}, style = {} } = {}) {
  return h(
    'box',
    { key, style: { flexShrink: 0, ...style } },
    h('box', {
      ref,
      style: {
        height: HEADER,
        flexShrink: 0,
        position: 'sticky',
        top: 0,
        backgroundColor: '#336699',
        ...header,
      },
    }),
    ...Array.from({ length: rows }, (_, i) =>
      h('box', { key: i, style: { height: ROW, flexShrink: 0 } }),
    ),
  );
}

/** Three sections of 140 in a 200x100 pane: 420 of content, 320 of scroll. */
async function sections(options = {}) {
  const pane = React.createRef();
  const headers = [React.createRef(), React.createRef(), React.createRef()];
  const mounted = await mount(
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      headers.map((ref, i) => section(i, ref, options)),
    ),
  );
  return {
    ...mounted,
    pane: pane.current,
    headers: headers.map((r) => r.current),
  };
}

const top = (node, pane) => node.abs.y - pane.abs.y;

test('a header sticks to the top of its pane and the next section pushes it off', async () => {
  const { pane, headers } = await sections();
  const at = () => headers.map((header) => top(header, pane));
  assert.deepStrictEqual(at(), [0, 140, 280], 'laid out in flow');

  pane.scrollTo(50);
  await frame();
  assert.deepStrictEqual(at(), [0, 90, 230], 'held at the top edge');

  // the first section ends at 140; its header may not leave it, so with
  // 10px of the section left above the fold it is 10px from gone
  pane.scrollTo(130);
  await frame();
  assert.deepStrictEqual(at(), [-10, 10, 150], 'pushed by its section’s end');

  pane.scrollTo(150);
  await frame();
  assert.deepStrictEqual(at(), [-30, 0, 130], 'and the next one took over');

  pane.scrollTo(0);
  await frame();
  assert.deepStrictEqual(at(), [0, 140, 280], 'and all the way back');
});

test('the insets are thresholds, never offsets', async () => {
  const sticky = React.createRef();
  const relative = React.createRef();
  const { root } = await mount(
    h(
      'box',
      { style: { overflow: 'scroll', flexGrow: 1, flexDirection: 'row' } },
      h(
        'box',
        { style: { width: 50 } },
        h('box', { style: { height: 40, flexShrink: 0 } }),
        h('box', {
          ref: sticky,
          style: { height: 10, position: 'sticky', top: 10, left: 7 },
        }),
      ),
      h(
        'box',
        { style: { width: 50 } },
        h('box', { style: { height: 40, flexShrink: 0 } }),
        h('box', {
          ref: relative,
          style: { height: 10, position: 'relative', top: 10, left: 7 },
        }),
      ),
    ),
  );
  assert.ok(root);
  // 40 down the pane is well past a 10px threshold, so nothing holds it —
  // and yoga never saw the `top: 10` as an offset the way it does for
  // `relative`, where the same style moves the node
  assert.strictEqual(sticky.current.abs.y, 40);
  assert.strictEqual(sticky.current.abs.x, 0);
  assert.strictEqual(relative.current.abs.y, 50);
  assert.strictEqual(relative.current.abs.x, 57);
});

test('an inset holds even before any scroll, when the node starts past it', async () => {
  const header = React.createRef();
  const { root } = await mount(
    h(
      'box',
      { style: { overflow: 'scroll', flexGrow: 1 } },
      h(
        'box',
        { style: { flexShrink: 0, height: 300 } },
        h('box', {
          ref: header,
          style: { height: 20, flexShrink: 0, position: 'sticky', top: 12 },
        }),
      ),
    ),
  );
  assert.ok(root);
  // CSS's rule, not a scroll rule: the edge may not be nearer the pane's
  // top than 12, and the section has the room to move it
  assert.strictEqual(header.current.abs.y, 12);
});

test('bottom holds a footer at the bottom edge until its section’s top meets it', async () => {
  const pane = React.createRef();
  const footers = [React.createRef(), React.createRef()];
  await mount(
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      footers.map((ref, i) =>
        h(
          'box',
          { key: i, style: { flexShrink: 0 } },
          ...Array.from({ length: 5 }, (_, r) =>
            h('box', { key: r, style: { height: ROW, flexShrink: 0 } }),
          ),
          h('box', {
            ref,
            style: {
              height: 20,
              flexShrink: 0,
              position: 'sticky',
              bottom: 0,
            },
          }),
        ),
      ),
    ),
  );
  const p = pane.current;
  const [a, b] = footers.map((r) => r.current);
  // the first footer is laid out at 150, past a 100px pane: held at 80
  assert.strictEqual(top(a, p), 80);
  // the second belongs to a section starting at 170 — it may rise no higher
  // than that, so it waits below the fold with its section
  assert.strictEqual(top(b, p), 170);
  p.scrollTo(90);
  await frame();
  assert.strictEqual(top(a, p), 60, 'back in flow once its place is on screen');
  assert.strictEqual(top(b, p), 80, 'and the next one is held in its turn');
});

test('left sticks in a horizontal pane, and a group pushes its label off', async () => {
  const pane = React.createRef();
  const labels = [React.createRef(), React.createRef()];
  await mount(
    h(
      'box',
      {
        ref: pane,
        style: { overflow: 'scroll', flexGrow: 1, flexDirection: 'row' },
      },
      labels.map((ref, i) =>
        h(
          'box',
          { key: i, style: { flexDirection: 'row', flexShrink: 0 } },
          h('box', {
            ref,
            style: { width: 30, flexShrink: 0, position: 'sticky', left: 0 },
          }),
          ...Array.from({ length: 5 }, (_, c) =>
            h('box', { key: c, style: { width: 40, flexShrink: 0 } }),
          ),
        ),
      ),
    ),
  );
  const p = pane.current;
  const [a, b] = labels.map((r) => r.current);
  const left = (node) => node.abs.x - p.abs.x;
  p.scrollTo({ x: 50 });
  await frame();
  assert.strictEqual(left(a), 0);
  assert.strictEqual(left(b), 180);
  p.scrollTo({ x: 215 });
  await frame();
  // the first group ends at 230 - 215 = 15 on screen: its label, 30 wide,
  // is half gone
  assert.strictEqual(left(a), -15);
  assert.strictEqual(left(b), 15);
});

test('start and end follow the direction', async () => {
  const pane = React.createRef();
  const label = React.createRef();
  await mount(
    h(
      'box',
      {
        ref: pane,
        style: {
          overflow: 'scroll',
          flexGrow: 1,
          flexDirection: 'row',
          direction: 'rtl',
        },
      },
      h(
        'box',
        { style: { flexDirection: 'row', flexShrink: 0 } },
        h('box', {
          ref: label,
          style: { width: 30, flexShrink: 0, position: 'sticky', start: 0 },
        }),
        ...Array.from({ length: 8 }, (_, c) =>
          h('box', { key: c, style: { width: 40, flexShrink: 0 } }),
        ),
      ),
    ),
  );
  const p = pane.current;
  const l = label.current;
  const right = (node) => node.abs.x + node.abs.width;
  assert.strictEqual(right(l), right(p), 'the start edge is the right one');
  // scrolling an RTL pane moves its content right, and `start` holds the
  // label at the edge it started at
  p.scrollTo({ x: 60 });
  await frame();
  assert.strictEqual(right(l), right(p));
});

test('a percentage inset is of the pane’s scrollport', async () => {
  const header = React.createRef();
  await mount(
    h(
      'box',
      { style: { overflow: 'scroll', flexGrow: 1 } },
      h(
        'box',
        { style: { flexShrink: 0, height: 300 } },
        h('box', {
          ref: header,
          style: { height: 10, flexShrink: 0, position: 'sticky', top: '25%' },
        }),
      ),
    ),
  );
  assert.strictEqual(header.current.abs.y, 25);
});

test('the margin box stays in the parent’s content box', async () => {
  const pane = React.createRef();
  const header = React.createRef();
  await mount(
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      h(
        'box',
        { style: { flexShrink: 0, paddingBottom: 6 } },
        h('box', {
          ref: header,
          style: {
            height: 20,
            flexShrink: 0,
            marginTop: 5,
            marginBottom: 7,
            position: 'sticky',
            top: 0,
          },
        }),
        ...Array.from({ length: 4 }, (_, r) =>
          h('box', { key: r, style: { height: ROW, flexShrink: 0 } }),
        ),
      ),
      h('box', { style: { height: 400, flexShrink: 0 } }),
    ),
  );
  const p = pane.current;
  const hd = header.current;
  p.scrollTo(40);
  await frame();
  assert.strictEqual(top(hd, p), 0, 'the border box meets the edge');
  // the section's content box ends at 5 + 20 + 7 + 120 = 152, above its
  // 6px of padding, and the header's margin box has to fit inside it: its
  // border box may come down to 152 - 7 - 20 = 125
  p.scrollTo(140);
  await frame();
  assert.strictEqual(top(hd, p), 125 - 140);
});

test('the pane’s edges are inside its border and over its padding', async () => {
  const pane = React.createRef();
  const header = React.createRef();
  await mount(
    h(
      'box',
      {
        ref: pane,
        style: {
          overflow: 'scroll',
          flexGrow: 1,
          borderWidth: 4,
          paddingTop: 10,
        },
      },
      h('box', {
        ref: header,
        style: { height: 20, flexShrink: 0, position: 'sticky', top: 0 },
      }),
      h('box', { style: { height: 400, flexShrink: 0 } }),
    ),
  );
  const p = pane.current;
  const hd = header.current;
  assert.strictEqual(top(hd, p), 14, 'laid out past the border and padding');
  p.scrollTo(30);
  await frame();
  assert.strictEqual(top(hd, p), 4, 'held just inside the border');
});

test('a direct child of the pane sticks for the whole of the scroll', async () => {
  const pane = React.createRef();
  const header = React.createRef();
  await mount(
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      h('box', {
        ref: header,
        style: { height: 20, flexShrink: 0, position: 'sticky', top: 0 },
      }),
      ...Array.from({ length: 10 }, (_, r) =>
        h('box', { key: r, style: { height: ROW, flexShrink: 0 } }),
      ),
    ),
  );
  const p = pane.current;
  p.scrollTo(10_000);
  await frame();
  assert.strictEqual(p.scrollY, 220, 'at the end of the content');
  assert.strictEqual(top(header.current, p), 0);
});

test('a direct child of the pane is limited by the content, not by the viewport', async () => {
  const pane = React.createRef();
  const header = React.createRef();
  await mount(
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      h('box', {
        ref: header,
        style: { height: 20, flexShrink: 0, position: 'sticky', top: 90 },
      }),
      ...Array.from({ length: 10 }, (_, r) =>
        h('box', { key: r, style: { height: ROW, flexShrink: 0 } }),
      ),
    ),
  );
  // held 90 down a 100px pane, half past its bottom edge: the header's
  // parent is the pane's whole content, not the part of it on screen
  assert.strictEqual(top(header.current, pane.current), 90);
});

test('a sticky node inside a sticky node: a banner held at the top, its label at the left', async () => {
  const pane = React.createRef();
  const banner = React.createRef();
  const label = React.createRef();
  await mount(
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      h(
        'box',
        { style: { flexShrink: 0, width: 600 } },
        h(
          'box',
          {
            ref: banner,
            style: {
              height: 20,
              flexShrink: 0,
              flexDirection: 'row',
              position: 'sticky',
              top: 0,
            },
          },
          h('box', {
            ref: label,
            style: { width: 60, flexShrink: 0, position: 'sticky', left: 0 },
          }),
        ),
        h('box', { style: { height: 400, flexShrink: 0 } }),
      ),
    ),
  );
  const p = pane.current;
  p.scrollTo({ x: 70, y: 90 });
  await frame();
  assert.strictEqual(top(banner.current, p), 0, 'the banner is held down');
  assert.strictEqual(
    banner.current.abs.x - p.abs.x,
    -70,
    '…and scrolls across',
  );
  assert.strictEqual(top(label.current, p), 0, 'its label rides the banner');
  assert.strictEqual(label.current.abs.x - p.abs.x, 0, '…and is held across');
});

test('a sticky node inside another is placed after it, whichever became sticky first', async () => {
  const pane = React.createRef();
  const outer = React.createRef();
  const inner = React.createRef();
  const tree = (position) =>
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      h(
        'box',
        { style: { flexShrink: 0, height: 400 } },
        h('box', { style: { height: 60, flexShrink: 0 } }),
        h(
          'box',
          {
            ref: outer,
            style: { height: 40, flexShrink: 0, position, top: 0 },
          },
          h('box', { style: { height: 20, flexShrink: 0 } }),
          h('box', {
            ref: inner,
            style: { height: 10, flexShrink: 0, position: 'sticky', top: 5 },
          }),
        ),
      ),
    );
  const { render, root } = await mount(tree('relative'));
  render(tree('sticky'));
  await frame();
  const registered = [...root._placedNodes];
  assert.ok(
    registered[0] === inner.current && registered[1] === outer.current,
    'the inner one registered first',
  );
  pane.current.scrollTo(120);
  await frame();
  assert.strictEqual(top(outer.current, pane.current), 0, 'the outer is held');
  // measured from where the outer box was left, the inner one is 20 down —
  // clear of its own 5px threshold. Measured from where the outer box was
  // before its shift, it would have pushed itself down and then been
  // carried 60 further by the outer's move.
  assert.strictEqual(top(inner.current, pane.current), 20);
});

test('a node sticks to the nearest pane that scrolls, and rides the panes around it', async () => {
  const outer = React.createRef();
  const inner = React.createRef();
  const header = React.createRef();
  await mount(
    h(
      'box',
      { ref: outer, style: { overflow: 'scroll', flexGrow: 1 } },
      h('box', { style: { height: 30, flexShrink: 0 } }),
      h(
        'box',
        {
          ref: inner,
          style: { height: 60, flexShrink: 0, overflow: 'scroll' },
        },
        section('s', header, { rows: 6 }),
      ),
      h('box', { style: { height: 300, flexShrink: 0 } }),
    ),
  );
  inner.current.scrollTo(40);
  await frame();
  assert.strictEqual(top(header.current, inner.current), 0);
  // the outer pane moves the inner one, header and all
  outer.current.scrollTo(25);
  inner.current.scrollTo(50);
  await frame();
  assert.strictEqual(inner.current.abs.y, 5);
  assert.strictEqual(header.current.abs.y, 5, 'still held by the inner pane');
});

test('overflow hidden clips without being a pane', async () => {
  const pane = React.createRef();
  const header = React.createRef();
  await mount(
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      h(
        'box',
        { style: { flexShrink: 0, overflow: 'hidden', borderRadius: 8 } },
        section('s', header, { rows: 6 }),
      ),
      h('box', { style: { height: 300, flexShrink: 0 } }),
    ),
  );
  pane.current.scrollTo(50);
  await frame();
  // CSS would make the card the scroll container and the header would
  // never move; here the card only clips, and the pane holds the header
  assert.strictEqual(top(header.current, pane.current), 0);
});

test('with nothing above that scrolls, it stays where layout put it', async () => {
  const header = React.createRef();
  await mount(
    h(
      'box',
      { style: { flexGrow: 1, overflow: 'hidden' } },
      h('box', { style: { height: 10, flexShrink: 0 } }),
      h('box', {
        ref: header,
        style: { height: 20, flexShrink: 0, position: 'sticky', top: 30 },
      }),
    ),
  );
  assert.strictEqual(header.current.abs.y, 10);
});

test('a node that stops being sticky goes back where layout has it, and one that starts sticks', async () => {
  const pane = React.createRef();
  const header = React.createRef();
  const tree = (position) =>
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      section('s', header, { rows: 8, header: { position } }),
      h('box', { style: { height: 300, flexShrink: 0 } }),
    );
  const { render, root } = await mount(tree('sticky'));
  pane.current.scrollTo(60);
  await frame();
  assert.strictEqual(top(header.current, pane.current), 0);

  render(tree('relative'));
  await frame();
  assert.strictEqual(top(header.current, pane.current), -60, 'back in flow');
  assert.strictEqual(root._placedNodes.size, 0, 'and let go');

  render(tree('sticky'));
  await frame();
  assert.strictEqual(top(header.current, pane.current), 0, 'held again');
});

test('an unmounted sticky node leaves the registry', async () => {
  const pane = React.createRef();
  const header = React.createRef();
  const tree = (on) =>
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      on && section('s', header),
      h('box', { style: { height: 300, flexShrink: 0 } }),
    );
  const { render, root } = await mount(tree(true));
  assert.strictEqual(root._placedNodes.size, 1);
  render(tree(false));
  await frame();
  pane.current.scrollTo(20);
  await frame();
  assert.strictEqual(root._placedNodes.size, 0);
});

test('a sticky node paints over its later siblings and takes the press there', async () => {
  const { pane, headers, root } = await sections();
  pane.scrollTo(50);
  await frame();
  const header = headers[0];
  const parent = header.parent;
  const order = parent.paintOrder();
  // by identity, never strictEqual: a failing diff of two nodes walks the
  // whole retained tree before it says anything
  assert.ok(order.at(-1) === header, 'painted last among its siblings');
  const under = parent.children.find(
    (c) => c !== header && c.containsPoint(10, 5),
  );
  assert.ok(under, 'a row has scrolled under the held header there');
  assert.ok(root.hitTest(10, 5) === header, 'and the header takes the press');
});

test('zIndex still orders a sticky node among its siblings', async () => {
  const pane = React.createRef();
  const header = React.createRef();
  const row = React.createRef();
  await mount(
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      h(
        'box',
        { style: { flexShrink: 0 } },
        h('box', {
          ref: header,
          style: {
            height: 20,
            flexShrink: 0,
            position: 'sticky',
            top: 0,
            zIndex: -1,
          },
        }),
        h('box', { ref: row, style: { height: 300, flexShrink: 0 } }),
      ),
    ),
  );
  const order = header.current.parent.paintOrder();
  assert.ok(
    order[0] === header.current && order[1] === row.current,
    'a negative zIndex still puts it under',
  );
});

test('a held node’s reach is recounted up the tree', async () => {
  const pane = React.createRef();
  const header = React.createRef();
  await mount(
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      section('s', header, {
        rows: 3,
        header: { boxShadow: '0 10px 0 #0008' },
      }),
      h('box', { style: { height: 300, flexShrink: 0 } }),
    ),
  );
  pane.current.scrollTo(100);
  await frame();
  const hd = header.current;
  // pushed to the end of its 110px section, which ends 10px down the pane,
  // with a shadow reaching 10px past that: the section's cached reach has
  // to grow with it, or a frame culls the shadow as outside the section
  assert.strictEqual(top(hd, pane.current), -10);
  const own = hd._ownPaintBounds();
  const reach = hd.parent._subtreeBounds();
  assert.ok(
    reach.y + reach.height >= own.y + own.height,
    `the section reaches ${reach.y + reach.height}, the shadow ` +
      `${own.y + own.height}`,
  );
});

test('onLayout reports where layout put the node, not where it is held', async () => {
  const pane = React.createRef();
  const reports = [];
  await mount(
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      h('box', { style: { height: 40, flexShrink: 0 } }),
      h('box', {
        style: { height: 20, flexShrink: 0, position: 'sticky', top: 0 },
        onLayout: (rect) => reports.push(rect),
      }),
      h('box', { style: { height: 300, flexShrink: 0 } }),
    ),
  );
  pane.current.scrollTo(100);
  await frame();
  await frame();
  assert.deepStrictEqual(reports, [{ x: 0, y: 40, width: 200, height: 20 }]);
});

test('insets are logical pixels at any scale', async () => {
  const pane = React.createRef();
  const header = React.createRef();
  await mount(
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      h(
        'box',
        { style: { flexShrink: 0 } },
        h('box', {
          ref: header,
          style: { height: 20, flexShrink: 0, position: 'sticky', top: 5 },
        }),
        h('box', { style: { height: 300, flexShrink: 0 } }),
      ),
    ),
    { scale: 2 },
  );
  pane.current.scrollTo(50); // logical, like every public offset
  await frame();
  assert.strictEqual(pane.current.scrollY, 100, 'device pixels underneath');
  assert.strictEqual(top(header.current, pane.current), 10);
  assert.strictEqual(header.current.abs.height, 40);
});

// --- what a scroll with headers in it costs --------------------------------

const blits = (wnd) => wnd.calls.filter(([name]) => name === 'scrollRegion');
const area = (rects) => rects.reduce((sum, r) => sum + r.width * r.height, 0);

async function blitScene(position = 'sticky') {
  const pane = React.createRef();
  const headers = [React.createRef(), React.createRef()];
  const mounted = await mount(
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      h('box', { style: { height: 200, flexShrink: 0 } }),
      headers.map((ref, i) =>
        section(i, ref, { rows: 12, header: { position } }),
      ),
    ),
    { width: 400, height: 400 },
  );
  await frame();
  return {
    ...mounted,
    pane: pane.current,
    headers: headers.map((r) => r.current),
  };
}

test('headers that ride the scroll cost the blit nothing', async () => {
  // the same scroll over the same boxes, once with the headers sticky and
  // once without — nowhere near the top, so none of them is held
  const frames = [];
  for (const position of ['relative', 'sticky']) {
    const { wnd, root, pane, headers } = await blitScene(position);
    wnd.calls.length = 0;
    pane.scrollTo(48);
    await frame();
    assert.strictEqual(top(headers[0], pane), 152, 'riding, not held');
    frames.push({ blits: blits(wnd), rects: root._lastDamageRects });
  }
  const [plain, sticky] = frames;
  assert.strictEqual(plain.blits.length, 1, 'the fast path fired');
  assert.ok(sticky.rects, 'bounded');
  assert.deepStrictEqual(sticky, plain);
});

test('a held header keeps the blit, and repaints only where it was and where it is', async () => {
  const { wnd, root, pane, headers } = await blitScene();
  pane.scrollTo(248);
  await frame();
  assert.strictEqual(top(headers[0], pane), 0, 'held');
  wnd.calls.length = 0;
  pane.scrollTo(296);
  await frame();
  assert.strictEqual(blits(wnd).length, 1, 'the fast path still fired');
  assert.strictEqual(top(headers[0], pane), 0);
  const rects = root._lastDamageRects;
  assert.ok(rects, 'bounded');
  // the header's new place, at the top of the pane — the copy the blit
  // dragged up from there is above the fold and clipped away
  const covers = (x, y) =>
    rects.some(
      (r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height,
    );
  assert.ok(covers(10, 5) && covers(390, 15), JSON.stringify(rects));
  assert.ok(area(rects) < 400 * 400 * 0.3, JSON.stringify(rects));
});

// A header a fifth of the pane tall. It claims where it was and where it
// is, two rects a notch apart, and summed those came to more than the
// quarter of the viewport the ledger allows; scrolled back up, the band the
// blit dragged its copy down across is the exposed strip, which the frame
// repaints anyway. Priced as what they add to the strip, both notches cost
// the header's own rect.
test('a tall held header costs the blit its own rect, whichever way the pane scrolls', async () => {
  const pane = React.createRef();
  const header = React.createRef();
  const { wnd, root } = await mount(
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      h('box', { style: { height: 200, flexShrink: 0 } }),
      section(0, header, { rows: 20, header: { height: 80 } }),
    ),
    { width: 400, height: 400 },
  );
  pane.current.scrollTo(248);
  await frame();
  for (const to of [296, 248]) {
    wnd.calls.length = 0;
    pane.current.scrollTo(to);
    await frame();
    assert.strictEqual(top(header.current, pane.current), 0, 'held');
    assert.strictEqual(blits(wnd).length, 1, `the notch to ${to} blitted`);
    const rects = root._lastDamageRects;
    const covers = (x, y) =>
      rects.some(
        (r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height,
      );
    assert.ok(covers(5, 5) && covers(395, 75), JSON.stringify(rects));
    assert.ok(area(rects) < 400 * 400 * 0.4, JSON.stringify(rects));
  }
});

// --- the pixels, against the real ntk and an in-process X server ----------

const require = createRequire(import.meta.url);

async function createHeadlessApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(
    readFileSync(
      join(
        dirname(require.resolve('katex/package.json')),
        'dist',
        'fonts',
        'KaTeX_Main-Regular.ttf',
      ),
    ),
    { family: 'Test Main' },
  );
  fontSource.alias('sans-serif', 'Test Main');
  return await createClient({ stream: clientEnd, fontSource });
}

const settle = (app) =>
  new Promise((resolve, reject) =>
    app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
  );

const readPixels = (ctx, w, h) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, w, h, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );

test('a blitted scroll with held headers is byte-identical to a full repaint', async (t) => {
  const app = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const instance = await new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: 400, height: 300, style: { backgroundColor: '#f5f6fa' } },
          h(
            'box',
            { ref, style: { overflow: 'scroll', flexGrow: 1 } },
            ...Array.from({ length: 4 }, (_, s) =>
              h(
                'box',
                { key: s, style: { flexShrink: 0 } },
                h('box', {
                  style: {
                    height: 24,
                    flexShrink: 0,
                    position: 'sticky',
                    top: 0,
                    backgroundColor: [
                      '#c0392b',
                      '#2980b9',
                      '#27ae60',
                      '#8e44ad',
                    ][s],
                  },
                }),
                ...Array.from({ length: 8 }, (_, i) =>
                  h('box', {
                    key: i,
                    style: {
                      height: 40,
                      flexShrink: 0,
                      margin: 4,
                      backgroundColor: i % 2 ? '#ffffff' : '#dbe4ee',
                    },
                  }),
                ),
              ),
            ),
          ),
        ),
        resolve,
      ),
    );
    if (typeof instance.scrollRegion !== 'function') {
      t.skip('installed ntk has no Window.scrollRegion yet');
      return;
    }
    const root = instance._reactX11Node;
    const paint = () => {
      root._scheduled = false;
      root.flush();
    };
    paint();
    await settle(app);

    let blitCalls = 0;
    const realScrollRegion = instance.scrollRegion.bind(instance);
    instance.scrollRegion = (...args) => {
      blitCalls += 1;
      return realScrollRegion(...args);
    };
    // through a push: the red header held, then shoved off by the blue one
    for (let k = 0; k < 10; k++) {
      ref.current.scrollBy(40);
      paint();
      await settle(app);
    }
    assert.ok(blitCalls >= 8, `the fast path fired (${blitCalls} of 10)`);
    const blitted = await readPixels(root._ctx, 400, 300);

    root.invalidate(false);
    paint();
    await settle(app);
    const repainted = await readPixels(root._ctx, 400, 300);
    assert.ok(
      Buffer.from(blitted.data).equals(Buffer.from(repainted.data)),
      'blitted pixels differ from a full repaint of the same state',
    );
  } finally {
    await x11Root.unmount();
    await app.close();
  }
});

test('the wheel’s own frame has the header held — no frame shows it scrolled away', async () => {
  const { windowNode, ctx } = await renderX11(
    h(
      'box',
      {
        'data-testid': 'pane',
        style: { overflow: 'scroll', flexGrow: 1, backgroundColor: '#ffffff' },
      },
      ...Array.from({ length: 3 }, (_, s) =>
        h(
          'box',
          { key: s, style: { flexShrink: 0 } },
          h('box', {
            'data-testid': `header-${s}`,
            style: {
              height: 20,
              flexShrink: 0,
              position: 'sticky',
              top: 0,
              backgroundColor: '#c0392b',
            },
          }),
          ...Array.from({ length: 10 }, (_, i) =>
            h('box', {
              key: i,
              style: { height: 30, flexShrink: 0, backgroundColor: '#dbe4ee' },
            }),
          ),
        ),
      ),
    ),
    { width: 200, height: 200 },
  );
  try {
    const pane = windowNode.children[0];
    const header = pane.children[0].children[0];
    const painted = [];
    const flushFrame = windowNode._flushFrame;
    windowNode._flushFrame = function () {
      const did = flushFrame.call(this);
      if (did) painted.push({ scrollY: pane.scrollY, y: header.abs.y });
      return did;
    };
    await userEvent.wheel(pane, { deltaY: 1 });
    await userEvent.wheel(pane, { deltaY: 2 });
    assert.ok(painted.length >= 2, 'the notches painted');
    for (const f of painted) {
      if (f.scrollY > 0) assert.strictEqual(f.y, 0, JSON.stringify(painted));
    }
    // and the pixels agree: the header's red at the top of the pane
    await expectPixel(ctx, 100, 10, '#c0392b', { tolerance: 8 });
  } finally {
    await cleanup();
  }
});

// --- the Cocoa layer presenter ------------------------------------------------

test('on a layer tree, a scroll re-frames the held header and no one else', async () => {
  const mounted = await renderX11(
    h(
      'box',
      { style: { overflow: 'scroll', flexGrow: 1 } },
      h(
        'box',
        { style: { flexShrink: 0 } },
        h('box', {
          style: {
            height: 20,
            flexShrink: 0,
            position: 'sticky',
            top: 0,
            backgroundColor: '#336699',
          },
        }),
        ...Array.from({ length: 10 }, (_, i) =>
          h('box', {
            key: i,
            style: { height: 30, flexShrink: 0, backgroundColor: '#dddddd' },
          }),
        ),
      ),
    ),
    { backend: 'mock', width: 200, height: 100 },
  );
  try {
    const { presenter, bridge } = presenterFor(mounted);
    const { windowNode } = mounted;
    presenter.frame(windowNode);
    const pane = windowNode.children[0];
    const header = pane.children[0].children[0];
    const rows = pane.children[0].children.slice(1);
    const layerOf = (node) => presenter.visuals.get(node).layer;
    const framesOf = (node) =>
      bridge.calls
        .filter(
          (c) => c.name === 'setLayerProps' && c.args[0] === layerOf(node),
        )
        .map((c) => c.args[1].frame)
        .filter(Boolean);
    bridge.calls.length = 0;
    pane.scrollTo(45);
    windowNode._scheduled = false;
    windowNode.flush();
    presenter.frame(windowNode);
    // content coordinates under the clip host, whose bounds carry the
    // scroll: the rows did not move in them, the held header did
    assert.deepStrictEqual(framesOf(header), [[0, 45, 200, 20]]);
    for (const row of rows) assert.deepStrictEqual(framesOf(row), []);
  } finally {
    await cleanup();
  }
});
