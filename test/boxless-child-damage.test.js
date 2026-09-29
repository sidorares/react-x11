// A child with no box of its own — a `<text>`'s run of characters, or a
// `<text>` nested in one — arriving or leaving. It is drawn by the box it is
// in, so it is that box that has to be repainted, and it was not:
//
// - inside a scroll pane a child-list change claims the leaving child's own
//   rect and lets the layout diff claim where an arriving one lands
//   (`_childListFine`), and a run of characters has neither, so a label
//   emptied or filled there claimed nothing and its old glyphs stayed;
// - a span has no rect of its own, so one that gained or lost its text
//   claimed a pixel at the window's origin, pane or no pane.
//
// Held to pixels: the frame as it was painted against the same state painted
// again from scratch. Found by a random differential of exactly that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';

const h = React.createElement;
const require = createRequire(import.meta.url);
const W = 320;
const H = 160;

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

const readPixels = (ctx) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, W, H, (err, data) =>
      err ? reject(err) : resolve(Buffer.from(data.data)),
    ),
  );

const label = (text, span) =>
  span
    ? h(
        'text',
        { style: { color: '#26a269', fontSize: 12 } },
        'before ',
        h('text', { style: { color: '#e01b24' } }, text),
        ' after',
      )
    : h('text', { style: { color: '#26a269', fontSize: 12 } }, text);

const rows = (text, span) =>
  Array.from({ length: 12 }, (_, i) =>
    h(
      'box',
      {
        key: i,
        style: {
          height: 20,
          flexShrink: 0,
          backgroundColor: i % 2 ? '#dbe4ee' : '#ffffff',
        },
      },
      i === 2
        ? label(text, span)
        : h('text', { style: { fontSize: 12 } }, `row ${i}`),
    ),
  );

const scene = ({ pane, span }, text, ref) =>
  h(
    'window',
    { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
    pane
      ? h(
          'box',
          { ref, style: { overflow: 'scroll', height: 100, margin: 4 } },
          ...rows(text, span),
        )
      : h('box', { style: { height: 20, margin: 4 } }, label(text, span)),
  );

async function frameMatchesRepaint(t, where, from, to, { scroll = 0 } = {}) {
  const app = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  t.after(async () => {
    await x11Root.unmount();
    await app.close();
  });
  const ref = React.createRef();
  const render = (text) =>
    new Promise((resolve) => x11Root.render(scene(where, text, ref), resolve));
  const root = (await render(from))._reactX11Node;
  const frame = async () => {
    root._scheduled = false;
    root.flush();
    await settle(app);
  };
  await frame();
  await frame();
  await render(to);
  if (scroll) ref.current.scrollTo(scroll);
  await frame();
  const painted = await readPixels(root._ctx);
  root.invalidate(false);
  await frame();
  const repainted = await readPixels(root._ctx);
  return painted.equals(repainted);
}

for (const [name, where] of [
  ['a label in a scroll pane', { pane: true, span: false }],
  ['a span in a scroll pane', { pane: true, span: true }],
  ['a span', { pane: false, span: true }],
  ['a label', { pane: false, span: false }],
]) {
  test(`${name} emptied is repainted`, async (t) => {
    assert.ok(await frameMatchesRepaint(t, where, 'Quarterly report', ''));
  });
  test(`${name} filled is repainted`, async (t) => {
    assert.ok(await frameMatchesRepaint(t, where, '', 'Quarterly report'));
  });
}

test('a label emptied in the frame its pane scrolls is repainted', async (t) => {
  for (const [from, to] of [
    ['Quarterly report', ''],
    ['', 'Quarterly report'],
  ]) {
    assert.ok(
      await frameMatchesRepaint(t, { pane: true, span: false }, from, to, {
        scroll: 20,
      }),
      `${JSON.stringify(from)} → ${JSON.stringify(to)}`,
    );
  }
});
