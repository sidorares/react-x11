// <image> sources beyond a file path (issue #367): in-memory pixels in three
// forms, `cacheKey` as the caller-controlled identity behind them, and the
// two server-side sources that composite without an upload.
//
// The unit half runs against the mock app — classification, validation, the
// refcounted cache, ownership on unmount. The pixel half runs against the
// in-process X server, because "composited an existing Picture" is a claim
// about what reaches the surface, and only a readback proves it.
import assert from 'node:assert';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, afterEach } from 'node:test';
import React from 'react';
import { PNG } from 'pngjs';
import * as ntk from 'ntk';

import { createRoot } from '../src/index.js';
import {
  imageSourceChanged,
  isPathImageSource,
  toLoadablePath,
  validateImageProps,
} from '../src/imagesource.js';
import {
  renderX11,
  cleanup,
  createMockApp,
  expectPixel,
} from '../src/testing/index.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

afterEach(cleanup);

/** Raw straight-RGBA source: `pixels` is rows of [r, g, b] triples. */
function raw(pixels) {
  const height = pixels.length;
  const width = pixels[0].length;
  const data = new Uint8Array(width * height * 4);
  pixels.flat().forEach(([r, g, b], i) => {
    data.set([r, g, b, 255], i * 4);
  });
  return { width, height, data };
}

/** Encoded PNG bytes for the same rows-of-triples shape. */
function png(pixels) {
  const { width, height, data } = raw(pixels);
  const image = new PNG({ width, height });
  Buffer.from(data).copy(image.data);
  return PNG.sync.write(image);
}

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];

/** Mount one element in a mock-app window and hand back its node. */
async function mounted(element, { width = 200, height = 200 } = {}) {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h('window', { width, height }, element));
  await tick();
  const node = app.windows[0]._reactX11Node.children[0];
  return { app, root, node };
}

// --- classification and validation ------------------------------------------

test('validateImageProps rejects two sources, naming both', () => {
  assert.throws(
    () =>
      validateImageProps({
        src: 'a.png',
        picture: { id: 1, width: 8, height: 8 },
      }),
    /one source.*src, picture/s,
  );
});

test('validateImageProps explains the server-source shape', () => {
  assert.throws(
    () => validateImageProps({ picture: { id: 5 } }),
    /round trip/,
    'the error says why the caller states the size',
  );
  assert.throws(
    () => validateImageProps({ drawable: { id: 0 } }),
    /X resource id/,
  );
  assert.throws(
    () =>
      validateImageProps({
        drawable: { id: 5, width: 8, height: 8, depth: 16 },
      }),
    /depth 24.*32.*8/s,
  );
});

test('validateImageProps rejects cacheKey on a server-side source', () => {
  assert.throws(
    () =>
      validateImageProps({
        picture: { id: 1, width: 8, height: 8 },
        cacheKey: 'k',
      }),
    /nothing to cache/,
  );
});

test('validateImageProps checks the raw form arithmetic', () => {
  assert.throws(
    () =>
      validateImageProps({
        src: { width: 2, height: 2, data: new Uint8Array(15) },
      }),
    /width × height × 4 = 16, got 15/,
  );
  assert.throws(
    () => validateImageProps({ src: 42 }),
    /file path.*Uint8Array/s,
  );
});

test('imageSourceChanged: a stable cacheKey vouches for a rebuilt buffer', () => {
  const a = png([[RED]]);
  const b = png([[RED]]);
  assert.equal(
    imageSourceChanged({ src: a, cacheKey: 'k' }, { src: b, cacheKey: 'k' }),
    false,
  );
  assert.equal(
    imageSourceChanged({ src: a, cacheKey: 'k' }, { src: b, cacheKey: 'j' }),
    true,
  );
  assert.equal(imageSourceChanged({ src: a }, { src: b }), true);
  assert.equal(imageSourceChanged({ src: a }, { src: a }), false);
});

test('imageSourceChanged: server descriptors compare by value, not identity', () => {
  const next = { picture: { id: 7, width: 8, height: 8 } };
  const prev = { picture: { id: 7, width: 8, height: 8 } };
  assert.equal(imageSourceChanged(next, prev), false);
  assert.equal(
    imageSourceChanged({ picture: { id: 8, width: 8, height: 8 } }, prev),
    true,
  );
  assert.equal(
    imageSourceChanged(
      { drawable: { id: 7, width: 8, height: 8, depth: 32 } },
      { drawable: { id: 7, width: 8, height: 8 } },
    ),
    true,
    'a depth change re-creates the picture over the drawable',
  );
});

test('imageSourceChanged: a direct source is its own identity, key or no key', () => {
  const direct = { width: 1, height: 1, picture: () => null };
  const other = { width: 1, height: 1, picture: () => null };
  assert.equal(
    imageSourceChanged(
      { src: direct, cacheKey: 'k' },
      { src: other, cacheKey: 'k' },
    ),
    true,
  );
  assert.equal(imageSourceChanged({ src: direct }, { src: direct }), false);
});

test('a URL is a path source, matched structurally like the declared FileUrl', () => {
  const url = pathToFileURL('/tmp/logo.png');
  assert.equal(isPathImageSource(url), true);
  assert.equal(isPathImageSource('/tmp/logo.png'), true);
  // the structural stand-in the declarations use, normalized to a real URL
  const structural = { href: url.href, protocol: url.protocol };
  assert.equal(isPathImageSource(structural), true);
  assert.ok(toLoadablePath(structural) instanceof URL);
  assert.equal(toLoadablePath(structural).href, url.href);
  assert.equal(isPathImageSource(new Uint8Array(4)), false);
  assert.equal(isPathImageSource({ width: 1, height: 1, data: null }), false);
});

// --- resolution, headless ---------------------------------------------------

test('raw RGBA decodes synchronously and measures at its natural size', async () => {
  const { node } = await mounted(
    h('image', {
      src: raw([[RED, GREEN, BLUE, WHITE]]),
      style: { alignSelf: 'flex-start' },
    }),
  );
  assert.equal(node.image?.width, 4);
  assert.equal(node.image?.height, 1);
  assert.deepStrictEqual([node.abs.width, node.abs.height], [4, 1]);
});

test('encoded PNG bytes decode without a temp file', async () => {
  const { node } = await mounted(
    h('image', {
      src: png([
        [RED, GREEN],
        [BLUE, WHITE],
      ]),
      style: { alignSelf: 'flex-start' },
    }),
  );
  assert.equal(node.image?.width, 2);
  assert.equal(node.image?.height, 2);
});

test('an ntk Image passed as src is used as-is and never destroyed', async () => {
  const image = new ntk.Image(raw([[RED]]));
  let destroyed = 0;
  const original = image.destroy.bind(image);
  image.destroy = () => {
    destroyed++;
    original();
  };
  const { root, node } = await mounted(h('image', { src: image }));
  assert.equal(node.image, image, 'the object itself, no copy, no re-decode');
  root.render(null);
  await tick();
  assert.equal(destroyed, 0, 'the caller owns it; unmount must not free it');
});

test('a node-owned image is freed when the node unmounts', async () => {
  const { root, node } = await mounted(h('image', { src: png([[RED]]) }));
  let destroyed = 0;
  const original = node.image.destroy.bind(node.image);
  node.image.destroy = () => {
    destroyed++;
    original();
  };
  root.render(null);
  await tick();
  assert.equal(destroyed, 1);
});

test('a stable cacheKey skips the re-decode a rebuilt buffer would cost', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  const render = (bytes) =>
    root.render(
      h(
        'window',
        { width: 200, height: 200 },
        h('image', { src: bytes, cacheKey: 'icon:1' }),
      ),
    );
  render(png([[RED]]));
  await tick();
  const node = app.windows[0]._reactX11Node.children[0];
  const first = node.image;
  assert.ok(first, 'decoded on first flush');
  // a structurally new buffer whose *content* the key vouches for — and to
  // prove the decode was skipped, one that decodes to different pixels
  render(png([[GREEN]]));
  await tick();
  assert.equal(node.image, first, 'same key, same image — no re-decode');
  render(png([[GREEN]]));
  await tick();
  assert.equal(node.image, first);
});

test('two <image>s with one cacheKey share one decoded image, freed with the last', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  const pair = (count) =>
    root.render(
      h(
        'window',
        { width: 200, height: 200 },
        ...Array.from({ length: count }, (_, i) =>
          h('image', { key: i, src: png([[BLUE]]), cacheKey: 'shared' }),
        ),
      ),
    );
  pair(2);
  await tick();
  const [a, b] = app.windows[0]._reactX11Node.children;
  assert.ok(a.image, 'decoded');
  assert.equal(a.image, b.image, 'one decode for both nodes');
  let destroyed = 0;
  const original = a.image.destroy.bind(a.image);
  a.image.destroy = () => {
    destroyed++;
    original();
  };
  pair(1);
  await tick();
  assert.equal(destroyed, 0, 'still held by the survivor');
  root.render(null);
  await tick();
  assert.equal(destroyed, 1, 'the last hold frees the entry');
});

test('a file src under one cacheKey is read and decoded once for both holders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'react-x11-image-'));
  const file = join(dir, 'dot.png');
  await writeFile(file, png([[RED]]));
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    h(
      'window',
      { width: 200, height: 200 },
      h('image', { key: 'a', src: file, cacheKey: 'dot' }),
      // the second node joins the first's in-flight decode instead of
      // starting its own read
      h('image', { key: 'b', src: pathToFileURL(file), cacheKey: 'dot' }),
    ),
  );
  const nodes = app.windows[0]._reactX11Node.children;
  // a real read resolves on the event loop's schedule, not on a tick count
  for (let i = 0; i < 200 && !(nodes[0].image && nodes[1].image); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(nodes[0].image, 'the read landed');
  assert.equal(nodes[0].image, nodes[1].image, 'one decode, both nodes');
});

test('a changed cacheKey re-resolves and releases the old entry', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  const render = (key, bytes) =>
    root.render(
      h(
        'window',
        { width: 200, height: 200 },
        h('image', { src: bytes, cacheKey: key }),
      ),
    );
  render('a', png([[RED]]));
  await tick();
  const node = app.windows[0]._reactX11Node.children[0];
  const first = node.image;
  let destroyed = 0;
  const original = first.destroy.bind(first);
  first.destroy = () => {
    destroyed++;
    original();
  };
  render('b', png([[GREEN, GREEN]]));
  await tick();
  assert.notEqual(node.image, first);
  assert.equal(node.image.width, 2, 'the new key decoded the new bytes');
  assert.equal(destroyed, 1, 'nobody holds the old entry any more');
});

test('<image picture> measures at the stated size with no server call', async () => {
  const { node } = await mounted(
    h('image', {
      picture: { id: 7, width: 400, height: 100 },
      style: { alignSelf: 'flex-start' },
    }),
  );
  assert.deepStrictEqual(
    [node.abs.width, node.abs.height],
    [200, 50],
    'shrunk to the width on offer, ratio kept — the <image src> rule',
  );
});

test('a rebuilt but equal descriptor does not re-create the source', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  const render = (id) =>
    root.render(
      h(
        'window',
        { width: 200, height: 200 },
        h('image', { drawable: { id, width: 8, height: 8, depth: 32 } }),
      ),
    );
  render(7);
  await tick();
  const node = app.windows[0]._reactX11Node.children[0];
  const source = node._serverSource;
  assert.ok(source, 'resolved');
  render(7);
  await tick();
  assert.equal(node._serverSource, source, 'same numbers, same source');
  render(8);
  await tick();
  assert.notEqual(node._serverSource, source, 'a new id is a new source');
});

// --- pixels, against the real server ----------------------------------------

test('raw RGBA pixels reach the screen, unscaled and scaled', async () => {
  const source = raw([
    [RED, GREEN],
    [BLUE, WHITE],
  ]);
  const { ctx } = await renderX11(
    h(
      'box',
      { style: { flexDirection: 'row', alignItems: 'flex-start' } },
      h('image', { src: source, style: { width: 2, height: 2 } }),
      // the scaled path goes through the picture transform; sample the
      // quadrant interiors, clear of the bilinear seam
      h('image', { src: source, style: { width: 40, height: 40 } }),
    ),
  );
  await expectPixel(ctx, 0, 0, RED, { tolerance: 4 });
  await expectPixel(ctx, 1, 1, WHITE, { tolerance: 4 });
  await expectPixel(ctx, 2 + 10, 10, RED, { tolerance: 24 });
  await expectPixel(ctx, 2 + 29, 29, WHITE, { tolerance: 24 });
});

test('encoded PNG bytes render, and a cacheKey survives a source rebuild', async () => {
  // 2x2, so the scaled sample at the middle sits between same-colour pixel
  // centers — a 1x1 source bleeds its RepeatNone edge into every sample
  const dot = () =>
    png([
      [GREEN, GREEN],
      [GREEN, GREEN],
    ]);
  const { ctx, windowNode, rerender } = await renderX11(
    h('image', {
      src: dot(),
      cacheKey: 'dot',
      style: { width: 20, height: 20, alignSelf: 'flex-start' },
    }),
  );
  await expectPixel(ctx, 10, 10, GREEN, { tolerance: 4 });
  const node = windowNode.children[0];
  const first = node.image;
  await rerender(
    h('image', {
      src: dot(),
      cacheKey: 'dot',
      style: { width: 20, height: 20, alignSelf: 'flex-start' },
    }),
  );
  assert.equal(node.image, first, 'rebuilt bytes, same key: no re-decode');
  await expectPixel(ctx, 10, 10, GREEN, { tolerance: 4 });
});

test('one ntk Image in two <image>s is one server upload', async () => {
  const image = new ntk.Image(
    raw([
      [BLUE, BLUE],
      [BLUE, BLUE],
    ]),
  );
  const { ctx, app } = await renderX11(
    h(
      'box',
      { style: { flexDirection: 'row', alignItems: 'flex-start' } },
      h('image', { src: image, style: { width: 10, height: 10 } }),
      h('image', { src: image, style: { width: 10, height: 10 } }),
    ),
  );
  await expectPixel(ctx, 5, 5, BLUE, { tolerance: 4 });
  await expectPixel(ctx, 15, 5, BLUE, { tolerance: 4 });
  // the per-app upload cache is the point of handing over the object: two
  // composites, one PutImage. `_uploads` is the Image's own upload table.
  assert.equal(image._uploads.size, 1);
  assert.ok(image._uploads.has(app));
});

test('<image picture> composites an existing Picture without an upload', async () => {
  const { ctx, app, rerender } = await renderX11(h('box', null));
  // something the server already holds: a Surface, filled tomato
  const surface = new ntk.Surface(app, { width: 8, height: 8 });
  surface.render((sctx) => {
    sctx.fillStyle = '#ff6347';
    sctx.fillRect(0, 0, 8, 8);
  });
  const id = surface.picture(app).id;
  await rerender(
    h('image', {
      picture: { id, width: 8, height: 8 },
      style: { width: 8, height: 8, alignSelf: 'flex-start' },
    }),
  );
  await expectPixel(ctx, 4, 4, '#ff6347', { tolerance: 4 });
  surface.destroy();
});

test('<image drawable> composites an existing Pixmap by id', async () => {
  const { ctx, app, rerender } = await renderX11(h('box', null));
  const Render = app.display.Render;
  const pixmap = new ntk.Pixmap(app, { depth: 32, width: 8, height: 8 });
  {
    // fill it server-side; the fill colour is premultiplied floats 0..1
    const fill = new ntk.Picture(app, {
      drawable: pixmap,
      format: Render.rgba32,
    });
    Render.FillRectangles(
      Render.PictOp.Src,
      fill.id,
      [0, 1, 0, 1],
      [0, 0, 8, 8],
    );
    fill.destroy();
  }
  // the descriptor is { id, width, height, depth } — which an ntk Pixmap
  // already is, so the object goes straight in
  await rerender(
    h('image', {
      drawable: pixmap,
      style: { width: 8, height: 8, alignSelf: 'flex-start' },
    }),
  );
  await expectPixel(ctx, 4, 4, GREEN, { tolerance: 4 });
  pixmap.destroy();
});
