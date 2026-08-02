// The capture path, from the server's pixels to a PNG's bytes.
//
// This is the test that was missing. `npm run screenshots` regenerated
// `docs/img/*.png` with red and blue exchanged for a whole ntk major —
// `getImageData` started speaking straight RGBA in 5.3.0 and the script kept
// converting as if it were BGRA — and nothing said so, because no test reads
// a screenshot and CI does not diff them. A committed PNG is the one output
// of this repo that has no other reader.
//
// So it asserts on colours that *cannot* survive a swap: pure red and pure
// blue, which is exactly what an equal-channel colour like `#00aa00` or a
// grey would have hidden.
import { test } from 'node:test';
import assert from 'node:assert';
import { PNG } from 'pngjs';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';
import {
  blit,
  captureDrawable,
  captureWindow,
  rgbAt,
  toPng,
} from '../scripts/capture.js';

const W = 60;
const H = 40;
const RED = [255, 0, 0];
const BLUE = [0, 0, 255];

const h = React.createElement;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A window with a red left half and a blue right half. */
async function paintedWindow() {
  const server = xserver.createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd });
  const created = [];
  const orig = app.createWindow.bind(app);
  app.createWindow = (attributes) => {
    const wnd = orig(attributes);
    created.push(wnd);
    return wnd;
  };
  const x11Root = await createRoot({ app });
  await new Promise((resolve) =>
    x11Root.render(
      h(
        'window',
        { width: W, height: H, style: { flexDirection: 'row' } },
        h('box', { style: { flexGrow: 1, backgroundColor: '#ff0000' } }),
        h('box', { style: { flexGrow: 1, backgroundColor: '#0000ff' } }),
      ),
      () => resolve(),
    ),
  );
  await sleep(200);
  return { app, x11Root, wnd: created[0] };
}

test('captureWindow reads straight RGBA, red where red was painted', async () => {
  const { app, x11Root, wnd } = await paintedWindow();
  try {
    const shot = await captureWindow(wnd);
    assert.strictEqual(shot.width, W);
    assert.strictEqual(shot.height, H);
    assert.deepStrictEqual(
      rgbAt(shot, 4, H / 2),
      RED,
      'the left half is red — swapped channels would read as blue',
    );
    assert.deepStrictEqual(
      rgbAt(shot, W - 4, H / 2),
      BLUE,
      'and the right blue',
    );
  } finally {
    await x11Root.unmount();
    await app.close();
  }
});

test('captureDrawable agrees with it, going the raw GetImage route', async () => {
  // The framed screenshots read a window manager's frame, which we do not
  // own and have no context for. That path unpacks the server's own bytes
  // using the display's pixel layout rather than assuming one — and it has
  // to land on the same answer as the context route, or the two kinds of
  // screenshot in this repo disagree about what red is.
  const { app, x11Root, wnd } = await paintedWindow();
  try {
    const shot = await captureDrawable(app, wnd.id);
    assert.strictEqual(shot.width, W);
    assert.deepStrictEqual(rgbAt(shot, 4, H / 2), RED);
    assert.deepStrictEqual(rgbAt(shot, W - 4, H / 2), BLUE);
  } finally {
    await x11Root.unmount();
    await app.close();
  }
});

test('the PNG keeps the channels in that order, and is opaque', async () => {
  const { app, x11Root, wnd } = await paintedWindow();
  try {
    const png = toPng(await captureWindow(wnd));
    // round-trip through the encoder: what a reader of docs/img sees
    const decoded = PNG.sync.read(PNG.sync.write(png));
    const at = (x, y) => {
      const i = (y * decoded.width + x) * 4;
      return [...decoded.data.slice(i, i + 4)];
    };
    assert.deepStrictEqual(at(4, H / 2), [...RED, 255]);
    assert.deepStrictEqual(at(W - 4, H / 2), [...BLUE, 255]);
  } finally {
    await x11Root.unmount();
    await app.close();
  }
});

test('blit places a capture at an offset and clips at the edges', async () => {
  // what `shotOver` composites a popup with
  const { app, x11Root, wnd } = await paintedWindow();
  try {
    const shot = await captureWindow(wnd);
    const png = new PNG({ width: W, height: H });
    png.data.fill(0);
    blit(png, shot, W - 6, 0);
    const at = (x, y) => {
      const i = (y * png.width + x) * 4;
      return [...png.data.slice(i, i + 3)];
    };
    assert.deepStrictEqual(
      at(W - 2, H / 2),
      RED,
      'the source origin lands at the offset',
    );
    assert.deepStrictEqual(at(2, H / 2), [0, 0, 0], 'nothing wraps around');
  } finally {
    await x11Root.unmount();
    await app.close();
  }
});
