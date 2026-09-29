// A child culled by its box when what it paints reaches past it. The paint
// walk skipped a child whose box lay outside the window or a clipping
// ancestor, and a row scrolled just out of a pane still reaches into it
// with whatever hangs off it — a child that overflows the row, a descender
// below a trimmed line box. Culled, none of that was drawn in a full
// repaint, while a scroll's copy carried it in from the frame before.
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
const W = 200;
const H = 120;

async function mount(t, rows) {
  const server = xserver.createServer({ width: 400, height: 300 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  // one face with a descender that hangs well below its cap-trimmed box
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
  const app = await createClient({ stream: clientEnd, fontSource });
  const x11Root = await createRoot({ app });
  t.after(async () => {
    await x11Root.unmount();
    await app.close();
  });
  const ref = React.createRef();
  const root = (
    await new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: W, height: H, style: { backgroundColor: '#ffffff' } },
          h(
            'box',
            { ref, style: { overflow: 'scroll', height: 100, marginTop: 10 } },
            ...rows,
          ),
        ),
        resolve,
      ),
    )
  )._reactX11Node;
  const frame = async () => {
    root._scheduled = false;
    root.flush();
    await new Promise((resolve) => app.X.GetInputFocus(() => resolve()));
  };
  await frame();
  await frame();
  const read = () =>
    new Promise((resolve, reject) =>
      root._ctx.getImageData(0, 0, W, H, (err, data) =>
        err ? reject(err) : resolve(Buffer.from(data.data)),
      ),
    );
  const repaint = async () => {
    root.invalidate(false);
    await frame();
    return read();
  };
  return { ref, frame, read, repaint };
}

// rows that paint nothing, so whatever hangs into them shows
const filler = (i) =>
  h('box', { key: `f${i}`, style: { height: 20, flexShrink: 0 } });

test('a child that overflows a row scrolled out of the pane is still drawn', async (t) => {
  // the second row carries a red block twice its height, hanging below it
  const rows = [
    filler(0),
    h(
      'box',
      { key: 'hang', style: { height: 20, flexShrink: 0 } },
      h('box', {
        style: {
          width: 30,
          height: 40,
          marginLeft: 20,
          flexShrink: 0,
          backgroundColor: '#e01b24',
        },
      }),
    ),
    ...Array.from({ length: 10 }, (_, i) => filler(i + 2)),
  ];
  const { ref, frame, repaint } = await mount(t, rows);
  // the row is 20..40 in the pane; scrolled by 45 it is out above, and the
  // block's last 15px are the pane's first rows
  ref.current.scrollTo(45);
  await frame();
  const whole = await repaint();
  const at = (x, y) => [
    ...whole.subarray((y * W + x) * 4, (y * W + x) * 4 + 3),
  ];
  // the pane starts at y 10; the block is 20..50 across
  const [r, g, b] = at(30, 14);
  assert.ok(
    r > 200 && g < 80 && b < 80,
    `the block's overhang is drawn: ${[r, g, b]}`,
  );
});
