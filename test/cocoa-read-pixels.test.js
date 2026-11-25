// `readPixels` on the Cocoa context: the pixels of a rectangle, straight
// RGBA, read now — `getImageData`'s bytes without its tick. Over the fake
// bridge for the shape, and over the real one, where it loads, for the
// bytes.
import assert from 'node:assert';
import { afterEach, describe, test } from 'node:test';

import { loadNative } from '../src/cocoa/native.js';
import { CocoaSurface } from '../src/cocoa/surface.js';
import { Surface } from '../src/ntk.js';
import { cleanup } from '../src/testing/index.js';
import { fakeCocoaApp } from './helpers/cocoa-bridge.js';

afterEach(cleanup);

test('readPixels answers the rectangle at once, as an ImageData-shaped object', () => {
  const { app } = fakeCocoaApp();
  const surface = new Surface(app, { width: 8, height: 8 });
  const ctx = surface.getContext('2d');
  const read = ctx.readPixels(1, 2, 3, 2);
  assert.equal(read.width, 3);
  assert.equal(read.height, 2);
  assert.ok(read.data instanceof Uint8ClampedArray);
  assert.equal(read.data.length, 3 * 2 * 4);
});

test('getImageData is readPixels delivered a tick later', async () => {
  const { app } = fakeCocoaApp();
  const surface = new Surface(app, { width: 8, height: 8 });
  const ctx = surface.getContext('2d');
  const now = ctx.readPixels(0, 0, 2, 2);
  const later = await ctx.getImageData(0, 0, 2, 2);
  assert.deepEqual([...later.data], [...now.data]);
  assert.equal(later.width, now.width);
});

let bridge = null;
try {
  bridge = loadNative();
} catch {
  /* not here */
}

describe(
  'over the real bridge',
  {
    skip: bridge ? false : 'the @windowkit/appkit bridge is not loadable here',
  },
  () => {
    test('what was drawn is what is read, straight', () => {
      const app = { _native: bridge, fonts: null, scale: 1 };
      const surface = new CocoaSurface(app, { width: 4, height: 4 });
      const ctx = surface.getContext('2d');
      ctx.fillStyle = 'rgb(200, 100, 50)';
      ctx.fillRect(0, 0, 2, 2);
      const { data } = ctx.readPixels(0, 0, 4, 1);
      assert.deepEqual([...data.subarray(0, 4)], [200, 100, 50, 255]);
      assert.deepEqual([...data.subarray(8, 12)], [0, 0, 0, 0]);
      surface.destroy();
    });
  },
);
