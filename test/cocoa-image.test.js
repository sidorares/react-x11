// `ctx.drawImage(image)` and `<image src>` on the Cocoa backend: an ntk
// `Image` — straight RGBA in JS memory — uploaded into a CG bitmap on its
// first draw and composited from there. Before this the context answered
// only surfaces, and every `<image src>` on macOS was an empty box.
//
// Two layers, the shape of cocoa-surface.test.js: the JS over a fake bridge
// everywhere — what reaches the natives, and when the element lets go — and
// pixels where the real bridge loads, where the thing worth pinning is that
// a known PNG lands in its own colours: red is not blue, and straight alpha
// is blended once.
import assert from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import React from 'react';
import { PNG } from 'pngjs';
import * as ntk from 'ntk';

import { CocoaApp } from '../src/cocoa/app.js';
import { CocoaContext2D, releaseImageUpload } from '../src/cocoa/context2d.js';
import { loadNative } from '../src/cocoa/native.js';
import { CocoaSurface } from '../src/cocoa/surface.js';
import { setCompositingForTests } from '../src/compositing.js';
import { PictureSource, decodeImageSource } from '../src/imagesource.js';
import { createRoot } from '../src/index.js';
import { setScaleForTests } from '../src/scale.js';
import { setScreensForTests } from '../src/screens.js';

process.env.NO_AT_BRIDGE ??= '1';

const h = React.createElement;

const RED = [255, 0, 0, 255];
const HALF_GREEN = [0, 255, 0, 128];
const BLUE = [0, 0, 255, 255];

/** Encoded PNG bytes: the left half one straight-RGBA colour, the right
 * half another. */
function twoColourPng(width, height, left, right) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      png.data.set(x < width / 2 ? left : right, (y * width + x) * 4);
    }
  }
  return PNG.sync.write(png);
}

// --- the fake bridge ----------------------------------------------------------

/** A bridge shaped like @windowkit/appkit's: enough window for a React tree
 * to mount (cocoa-paint-cache.test.js's), and the surface verbs recorded. */
function fakeBridge() {
  const calls = [];
  let seq = 0;
  let backendCb = null;
  const native = {
    calls,
    of: (name) => calls.filter((c) => c[0] === name).map((c) => c.slice(1)),
    listScreens: () => [
      {
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        scale: 1,
        visible: { x: 0, y: 0, width: 1440, height: 875 },
        primary: true,
      },
    ],
    createWindow2(options) {
      return { id: ++seq, options: { ...options } };
    },
    windowNumber: (handle) => handle.id,
    windowRootLayer: (handle) => ({ root: handle.id }),
    getWindowFrame: (handle) => ({
      x: 0,
      y: 0,
      width: handle.options.width,
      height: handle.options.height,
    }),
    windowIsVisible: () => true,
    setBackendEventCallback(cb) {
      backendCb = cb;
    },
    emit: (ev) => backendCb?.(ev),
    createSurfaceIOSurface(width, height, scale) {
      const id = ++seq;
      return { handle: { id, width, height, scale }, iosurfaceId: id };
    },
    createSurface(width, height, scale) {
      const handle = { id: ++seq, width, height, scale };
      calls.push(['createSurface', handle.id, width, height, scale]);
      return handle;
    },
    releaseSurface(handle) {
      calls.push(['releaseSurface', handle.id]);
    },
    surfaceSize: (handle) => ({
      width: handle.width,
      height: handle.height,
      scale: handle.scale,
    }),
    ctxPutImageData(handle, buf, w, hh, x, y) {
      assert.ok(Buffer.isBuffer(buf), 'the bridge takes a Buffer');
      calls.push(['ctxPutImageData', handle.id, [...buf], w, hh, x, y]);
    },
    ctxDrawSurface(dst, src, ...rest) {
      calls.push(['ctxDrawSurface', dst.id, src.id, ...rest]);
    },
  };
  return new Proxy(native, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
}

/** A context over a fresh surface of the bridge, as a window's is. */
function contextOver(native, width = 64, height = 32) {
  const target = native.createSurface(width, height, 1);
  const ctx = new CocoaContext2D(
    native,
    () => target,
    () => 1,
  );
  return { target, ctx };
}

// --- the context --------------------------------------------------------------

test('an Image goes up once, its straight RGBA as-is, and composites in every arity', () => {
  const native = fakeBridge();
  const { target, ctx } = contextOver(native);
  const image = new ntk.Image({
    width: 2,
    height: 1,
    data: new Uint8Array([...RED, ...HALF_GREEN]),
  });
  ctx.drawImage(image, 3, 4);
  ctx.drawImage(image, 3, 4, 8, 4);
  ctx.drawImage(image, 1, 0, 1, 1, 10, 20, 4, 4);
  // one bitmap of the image's size — at scale 1, since a drawImage source's
  // scale is inert — filled once with the bytes the Image holds: the
  // premultiply and the swizzle are the bridge's, so none happens here
  const [, upload] = native.of('createSurface');
  assert.deepEqual(upload.slice(1), [2, 1, 1]);
  const id = upload[0];
  assert.deepEqual(native.of('ctxPutImageData'), [
    [id, [...RED, ...HALF_GREEN], 2, 1, 0, 0],
  ]);
  assert.deepEqual(native.of('ctxDrawSurface'), [
    [target.id, id, 0, 0, 2, 1, 3, 4, 2, 1],
    [target.id, id, 0, 0, 2, 1, 3, 4, 8, 4],
    [target.id, id, 1, 0, 1, 1, 10, 20, 4, 4],
  ]);
  // a second context on the same bridge — another window — shares it
  const other = contextOver(native);
  other.ctx.drawImage(image, 0, 0);
  assert.equal(native.of('ctxPutImageData').length, 1, 'still one upload');
  assert.deepEqual(native.of('ctxDrawSurface').at(-1).slice(0, 2), [
    other.target.id,
    id,
  ]);
});

test('bytes in a view of a larger buffer go up as the view, not from offset 0', () => {
  const native = fakeBridge();
  const { ctx } = contextOver(native);
  const backing = new Uint8Array([...BLUE, ...RED, ...BLUE]);
  const image = new ntk.Image({
    width: 1,
    height: 1,
    data: new Uint8ClampedArray(backing.buffer, 4, 4),
  });
  ctx.drawImage(image, 0, 0);
  assert.deepEqual(native.of('ctxPutImageData')[0][1], RED);
  // putImageData shares the conversion, and so the fix
  ctx.putImageData(
    { width: 1, height: 1, data: backing.subarray(4, 8) },
    0.4,
    1.6,
  );
  assert.deepEqual(native.of('ctxPutImageData')[1].slice(1), [RED, 1, 1, 0, 2]);
});

test("releaseImage frees the Image's bitmap on the call, once, and a later draw uploads again", () => {
  const native = fakeBridge();
  const app = new CocoaApp(native);
  const { ctx } = contextOver(native);
  const image = decodeImageSource(twoColourPng(2, 2, RED, BLUE));
  app.releaseImage(image); // never drawn: nothing to free
  assert.equal(native.of('releaseSurface').length, 0);
  ctx.drawImage(image, 0, 0);
  const [id] = native.of('ctxPutImageData')[0];
  app.releaseImage(image);
  app.releaseImage(image);
  assert.deepEqual(native.of('releaseSurface'), [[id]]);
  // ntk's destroy() promises an Image stays drawable, and so does this
  ctx.drawImage(image, 0, 0);
  const uploads = native.of('ctxPutImageData');
  assert.equal(uploads.length, 2);
  assert.notEqual(uploads[1][0], id, 'a fresh bitmap');
  releaseImageUpload(image);
});

test('a source with no pixels here draws nothing: a destroyed surface quietly, an X picture with one warning', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const native = fakeBridge();
  const { ctx } = contextOver(native);
  const app = { _native: native, fonts: null, scale: 1 };
  const surface = new CocoaSurface(app, { width: 4, height: 4 });
  surface.destroy();
  ctx.drawImage(surface, 0, 0);
  ctx.drawImage(null, 0, 0);
  assert.equal(warn.mock.callCount(), 0, 'a surface that had pixels once');
  const picture = new PictureSource(app, { id: 7, width: 8, height: 8 });
  ctx.drawImage(picture, 0, 0);
  ctx.drawImage(picture, 0, 0, 16, 16);
  assert.equal(warn.mock.callCount(), 1, 'once per kind');
  assert.match(
    warn.mock.calls[0].arguments[0],
    /cocoa backend has no pixels for a PictureSource.*<image picture>.*no X server.*<image src>/,
  );
  // raw pixels are not an Image: ImageData changes between draws
  ctx.drawImage({ width: 1, height: 1, data: new Uint8Array(4) }, 0, 0);
  assert.equal(warn.mock.callCount(), 2);
  assert.match(warn.mock.calls[1].arguments[0], /new Image\(\{/);
  assert.equal(native.of('ctxDrawSurface').length, 0);
  assert.equal(native.of('ctxPutImageData').length, 0);
});

// --- the element --------------------------------------------------------------

const roots = new Set();
afterEach(async () => {
  for (const root of roots) await root.unmount();
  roots.clear();
});

async function mount(children) {
  const native = fakeBridge();
  const app = new CocoaApp(native);
  setScaleForTests(app, 1, 'cocoa');
  setScreensForTests(app, {
    monitors: [{ x: 0, y: 0, width: 1440, height: 900 }],
    workArea: { x: 0, y: 0, width: 1440, height: 875 },
  });
  setCompositingForTests(app, true);
  app._frameInterval = 0;
  native.setBackendEventCallback((ev) => app._route(ev));
  const root = await createRoot({ app });
  roots.add(root);
  const render = (kids) =>
    root.render(h('window', { width: 200, height: 200 }, ...kids));
  const frame = async (kids) => {
    render(kids);
    await new Promise((resolve) => setImmediate(resolve));
    app._tickFrames();
  };
  await frame(children);
  const node = [...app._windows.values()][0]._reactX11Node;
  const repaint = () => {
    node.invalidate(true, null, 'expose');
    app._tickFrames();
  };
  const unmount = async () => {
    roots.delete(root);
    await root.unmount();
  };
  return { native, app, frame, repaint, unmount };
}

/** The draws out of the upload whose bitmap is `id`. */
const drawsOf = (native, id) =>
  native.of('ctxDrawSurface').filter((c) => c[1] === id);

/** Which of these bitmaps were released, in order — the window's own
 * surfaces go too on unmount, and are not what these tests are about. */
const releasedOf = (native, ...ids) =>
  native
    .of('releaseSurface')
    .map(([id]) => id)
    .filter((id) => ids.includes(id));

test('<image src={png}> composites its upload into its box, and lets go of it on a new source and on unmount', async () => {
  const style = { width: 8, height: 4 };
  const png = twoColourPng(4, 2, RED, HALF_GREEN);
  const { native, frame, repaint, unmount } = await mount([
    h('image', { key: 'i', src: png, style }),
  ]);
  const uploads = native.of('ctxPutImageData');
  assert.equal(uploads.length, 1, 'one upload at first paint');
  const [id, bytes, w, hh] = uploads[0];
  assert.deepEqual([w, hh], [4, 2]);
  assert.deepEqual(bytes.slice(0, 4), RED);
  assert.deepEqual(bytes.slice(8, 12), HALF_GREEN, 'straight, as decoded');
  // the whole source into the whole box: 2x, the element's own layout
  const [draw] = drawsOf(native, id);
  assert.ok(draw, 'the upload was composited');
  assert.deepEqual(draw.slice(2, 6), [0, 0, 4, 2]);
  assert.deepEqual(draw.slice(8), [8, 4]);
  // a repaint composites the same bitmap again, without re-uploading
  repaint();
  assert.equal(native.of('ctxPutImageData').length, 1);
  assert.equal(drawsOf(native, id).length, 2);
  assert.deepEqual(releasedOf(native, id), []);

  // a new source frees the old bitmap and uploads the new pixels
  await frame([
    h('image', { key: 'i', src: twoColourPng(4, 2, BLUE, BLUE), style }),
  ]);
  assert.deepEqual(releasedOf(native, id), [id]);
  const [next, nextBytes] = native.of('ctxPutImageData')[1];
  assert.deepEqual(nextBytes.slice(0, 4), BLUE);
  assert.equal(drawsOf(native, next).length, 1);

  await unmount();
  assert.deepEqual(releasedOf(native, id, next), [id, next]);
});

test('two <image>s under one cacheKey share one upload, freed with the last of them', async () => {
  const style = { width: 4, height: 2 };
  const pic = (key) =>
    h('image', {
      key,
      // a fresh buffer each render, as a decoder hands over: the key says
      // it is the same picture
      src: twoColourPng(4, 2, RED, BLUE),
      cacheKey: 'shared',
      style,
    });
  const { native, frame } = await mount([pic('a'), pic('b')]);
  const uploads = native.of('ctxPutImageData');
  assert.equal(uploads.length, 1);
  const [id] = uploads[0];
  assert.equal(drawsOf(native, id).length, 2, 'one bitmap, two composites');
  await frame([pic('a')]);
  assert.deepEqual(releasedOf(native, id), [], 'still held');
  await frame([]);
  assert.deepEqual(releasedOf(native, id), [id]);
});

test("<image src={ntkImage}> is the caller's: composited, and never freed by the element", async () => {
  const image = decodeImageSource(twoColourPng(2, 2, RED, BLUE));
  const { native, unmount } = await mount([h('image', { src: image })]);
  const [id] = native.of('ctxPutImageData')[0];
  assert.equal(drawsOf(native, id).length, 1);
  await unmount();
  assert.deepEqual(releasedOf(native, id), [], "the caller's to free");
  releaseImageUpload(image);
});

// --- over the real bridge -----------------------------------------------------

let bridge = null;
if (process.platform === 'darwin') {
  try {
    bridge = loadNative();
  } catch {
    bridge = null;
  }
}

describe(
  'over the real bridge',
  {
    skip: bridge ? false : 'the @windowkit/appkit bridge is not loadable here',
  },
  () => {
    const app = () => ({ _native: bridge, fonts: null, scale: 1 });
    const pixel = (surface, x, y) => [
      ...bridge.ctxGetImageData(surface._surfaceHandle, x, y, 1, 1),
    ];
    /** Within the premultiply round trip's rounding. */
    const near = (actual, expected, what) =>
      assert.ok(
        actual.every((v, i) => Math.abs(v - expected[i]) <= 2),
        `${what}: got [${actual}], want [${expected}]`,
      );

    test('a two-colour PNG lands in its colours, scaled, its straight alpha blended once', () => {
      // 8x4: the left four columns opaque red, the right four half-alpha
      // green — drawn at 2x over white, probed well inside each half
      const image = decodeImageSource(twoColourPng(8, 4, RED, HALF_GREEN));
      const target = new CocoaSurface(app(), { width: 24, height: 12 });
      const ctx = target.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 24, 12);
      ctx.drawImage(image, 2, 2, 16, 8);
      near(pixel(target, 4, 5), RED, 'red, not blue: the channel order');
      near(pixel(target, 8, 8), RED, 'red at 2x');
      near(
        pixel(target, 14, 5),
        [128, 255, 128, 255],
        'half green over white: premultiplied once, by the bridge',
      );
      assert.deepEqual(pixel(target, 0, 0), [255, 255, 255, 255], 'outside');
      assert.deepEqual(pixel(target, 20, 11), [255, 255, 255, 255], 'outside');

      // onto transparent pixels, 1:1: the alpha comes back as it went in
      target.clear();
      ctx.drawImage(image, 0, 0);
      near(pixel(target, 1, 1), RED, 'opaque red');
      near(pixel(target, 6, 2), HALF_GREEN, 'straight half green');
      assert.deepEqual(pixel(target, 9, 1), [0, 0, 0, 0], 'past the image');
      releaseImageUpload(image);
      target.destroy();
    });
  },
);
