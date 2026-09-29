// A `display: 'none'` subtree takes part in no layout: yoga leaves its
// children where the last pass that reached them left them, and a child
// inserted or moved while it was hidden with no layout at all — NaN. The
// frame still walked in: a scroll pane in a hidden tab measured its content
// from the moved row, got NaN, and threw out of the frame, which took the
// app down. Found by a random damage differential (a reorder, then another
// row's height and a scroll).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';

const h = React.createElement;
const W = 320;
const H = 200;

async function mount(t, scene) {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd });
  const x11Root = await createRoot({ app });
  t.after(async () => {
    await x11Root.unmount();
    await app.close();
  });
  const render = (...args) =>
    new Promise((resolve) => x11Root.render(scene(...args), resolve));
  return { app, render };
}

const row = (id, height) =>
  h(
    'box',
    { key: id, style: { height, flexShrink: 0, backgroundColor: '#8899aa' } },
    h('text', {}, `row ${id}`),
  );

test('a scroll pane in a hidden box survives a reorder, a resize and a scroll', async (t) => {
  const pane = React.createRef();
  const { app, render } = await mount(t, (rows, hidden) =>
    h(
      'window',
      { width: W, height: H },
      h(
        'box',
        { style: { flexGrow: 1, padding: 4 } },
        h(
          'box',
          { style: { width: 120, display: hidden ? 'none' : 'flex' } },
          h(
            'box',
            { ref: pane, style: { overflow: 'scroll', height: 80 } },
            ...rows.map(([id, height]) => row(id, height)),
          ),
        ),
        h('text', {}, 'visible'),
      ),
    ),
  );
  let rows = [3, 5, 7, 9, 11, 13, 15, 17, 19].map((id) => [id, 20]);
  const root = (await render(rows, true))._reactX11Node;
  const frame = () => {
    root._scheduled = false;
    root.flush();
  };
  frame();
  // move a row to the end, then give another a new height and scroll
  rows = [...rows.filter(([id]) => id !== 9), [9, 20]];
  await render(rows, true);
  frame();
  rows = rows.map(([id, height]) => [id, id === 19 ? 30 : height]);
  await render(rows, true);
  pane.current.scrollTo(72);
  assert.doesNotThrow(frame, 'the frame over a hidden pane');

  // shown again, it is laid out in the order it now has
  await render(rows, false);
  frame();
  let y = -Infinity;
  for (const child of pane.current.children) {
    assert.ok(
      Number.isFinite(child.abs.y),
      `row ${child.children[0]?.textContent?.()} placed`,
    );
    assert.ok(child.abs.y >= y, 'in order');
    y = child.abs.y;
  }
  assert.equal(pane.current.children.at(-1).children[0].textContent(), 'row 9');
  void app;
});

test('a hidden row of a visible pane leaves the pane’s content measurable', async (t) => {
  const { render } = await mount(t, (inner, first = 30) =>
    h(
      'window',
      { width: W, height: H },
      h(
        'box',
        { style: { overflow: 'scroll', height: 120 } },
        row(1, first),
        h(
          'box',
          { key: 'hidden', style: { display: 'none' } },
          ...inner.map((id) => row(id, 20)),
        ),
        row(2, 30),
      ),
    ),
  );
  const root = (await render([10, 11, 12]))._reactX11Node;
  const frame = () => {
    root._scheduled = false;
    root.flush();
  };
  frame();
  // a reorder inside the hidden row, then a visible change that makes the
  // pane measure its content again
  await render([12, 10, 11]);
  assert.doesNotThrow(frame);
  await render([12, 10, 11], 40);
  assert.doesNotThrow(frame);
  await render([11, 12], 50);
  assert.doesNotThrow(frame);
});

test('what a hidden box holds does not reach into its pane’s content', async (t) => {
  // CSS gives a `display: 'none'` element no scrollable overflow. Its own
  // layout here is empty, but its children keep the places they had before
  // it was hidden, and the pane measured its content through them: hidden,
  // a tall panel left its pane scrolling into blank space it no longer
  // held.
  const pane = React.createRef();
  const { render } = await mount(t, (hidden) =>
    h(
      'window',
      { width: W, height: H },
      h(
        'box',
        { ref: pane, style: { overflow: 'scroll', height: 100 } },
        row(1, 30),
        h(
          'box',
          { key: 'panel', style: { display: hidden ? 'none' : 'flex' } },
          h('box', { style: { height: 400, flexShrink: 0 } }),
        ),
      ),
    ),
  );
  const root = (await render(false))._reactX11Node;
  const frame = () => {
    root._scheduled = false;
    root.flush();
  };
  frame();
  assert.ok(pane.current.contentHeight >= 430, 'shown, the panel is content');
  await render(true);
  frame();
  assert.ok(
    pane.current.contentHeight <= 30,
    `hidden, it is not: content ${pane.current.contentHeight}px tall`,
  );
});

test('a box shown again after changes inside it is painted as a repaint paints it', async (t) => {
  const { app, render } = await mount(t, (rows, hidden) =>
    h(
      'window',
      { width: W, height: H, style: { backgroundColor: '#ffffff' } },
      h(
        'box',
        { style: { display: hidden ? 'none' : 'flex', padding: 4 } },
        ...rows.map(([id, height]) => row(id, height)),
      ),
    ),
  );
  let rows = [1, 2, 3, 4].map((id) => [id, 24]);
  const root = (await render(rows, false))._reactX11Node;
  const settle = () =>
    new Promise((resolve) => app.X.GetInputFocus(() => resolve()));
  const frame = async () => {
    root._scheduled = false;
    root.flush();
    await settle();
  };
  const read = () =>
    new Promise((resolve, reject) =>
      root._ctx.getImageData(0, 0, W, H, (err, data) =>
        err ? reject(err) : resolve(Buffer.from(data.data)),
      ),
    );
  await frame();
  await render(rows, true);
  await frame();
  rows = [
    [4, 30],
    [1, 24],
    [3, 18],
  ];
  await render(rows, true);
  await frame();
  await render(rows, false);
  await frame();
  const shown = await read();
  root.invalidate(false);
  await frame();
  assert.ok(
    shown.equals(await read()),
    'the frame is what a full repaint draws',
  );
});
