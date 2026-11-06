// The X11 capture rung (src/media/x11capture.js) against node-x11's
// in-process X server. A real server answers `GetImage` on the root with
// what it composited there, windows included; the in-process one reads the
// root's own raster and nothing of its children — so these tests paint the
// root itself, a known colour at a known place, and what a screenshot and a
// screen stream must find is that. That a window shows up in the capture is
// a real display's to check.
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { afterEach, test } from 'node:test';
import React from 'react';

import {
  captureScreenshot,
  desktopCapability,
  displaySources,
  getDisplayMedia,
  getUserMedia,
} from '../src/index.js';
import { cleanup, renderX11, settle } from '../src/testing/index.js';

const h = React.createElement;

afterEach(async () => {
  await cleanup();
});

const RED = [200, 30, 40];

/** A mounted app, and a 120x80 rectangle of RED painted on its root. */
async function painted() {
  const result = await renderX11(h('box', null), { width: 120, height: 80 });
  await settle(result.app);
  const X = result.app.X;
  const root = X.display.screen[0].root;
  const gc = X.AllocID();
  X.CreateGC(gc, root, {
    foreground: (RED[0] << 16) | (RED[1] << 8) | RED[2],
  });
  const at = { x: 300, y: 200 };
  X.PolyFillRectangle(root, gc, [at.x, at.y, 120, 80]);
  await settle(result.app);
  return { ...result, at };
}

const rgbAt = (shot, x, y) => {
  const i = (y * shot.width + x) * 4;
  return [shot.data[i], shot.data[i + 1], shot.data[i + 2], shot.data[i + 3]];
};

test('screen capture over X11: no picker, sources listed, screenshots and frames read off the root', async () => {
  const { app, at } = await painted();
  const cap = await desktopCapability('screenCapture', { app });
  assert.equal(cap.available, true);
  assert.equal(cap.backend, 'x11');
  assert.equal(cap.features.picker, false);
  assert.equal(cap.features.enumerate, true);
  // no camera on X11: the rung is the screen's alone
  assert.equal((await desktopCapability('camera', { app })).available, false);
  await assert.rejects(getUserMedia({ video: true }, { app }), {
    name: 'NotFoundError',
  });

  const sources = await displaySources({
    app,
    thumbnail: { width: 64, height: 64 },
  });
  const screen = sources.find((s) => s.kind === 'screen');
  assert.ok(screen, 'the root, as one screen');
  assert.equal(screen.id, 'screen:0');
  assert.ok(screen.thumbnail.width <= 64 && screen.thumbnail.height <= 64);

  // the whole screen, and our window in it where it is
  const shot = await captureScreenshot({ app });
  assert.equal(shot.width, screen.width);
  assert.deepEqual(rgbAt(shot, at.x + 60, at.y + 40), [...RED, 255]);
  // a region of it
  const part = await captureScreenshot({
    app,
    source: 'screen:0',
    region: { x: at.x + 10, y: at.y + 10, width: 20, height: 10 },
  });
  assert.deepEqual([part.width, part.height], [20, 10]);
  assert.deepEqual(rgbAt(part, 0, 0), [...RED, 255]);
  // and as a PNG: the signature, the size, the first pixel
  const png = part.png();
  assert.deepEqual(
    [...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join(''),
    'PNG',
  );
  assert.equal(png.readUInt32BE(16), 20);
  assert.equal(png.readUInt32BE(20), 10);
  const idat = png.indexOf('IDAT');
  const raw = inflateSync(
    png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)),
  );
  assert.deepEqual([...raw.subarray(1, 5)], [...RED, 255]);

  // a stream of it: BGRA frames of the screen, read only while wanted
  const stream = await getDisplayMedia({ video: { frameRate: 30 } }, { app });
  const [track] = stream.getVideoTracks();
  assert.equal(track.getSettings().displaySurface, 'monitor');
  const frame = await new Promise((resolve) => {
    const off = track.onFrame((f) => {
      off();
      resolve(f);
    });
  });
  assert.equal(frame.format, 'BGRA');
  assert.equal(frame.width, screen.width);
  const i = (at.y + 40) * frame.strides[0] + (at.x + 60) * 4;
  assert.deepEqual(
    [frame.planes[0][i + 2], frame.planes[0][i + 1], frame.planes[0][i]],
    RED,
  );
  track.stop();
});

test('a source that is not there is NotFoundError', async () => {
  const { app } = await painted();
  await assert.rejects(captureScreenshot({ app, source: 'screen:9' }), {
    name: 'NotFoundError',
  });
  await assert.rejects(getDisplayMedia({ source: 'window:12345' }, { app }), {
    name: 'NotFoundError',
  });
});
