// A blurred `boxShadow` must carry its blur in its **pixels**, not as a
// filter on its picture.
//
// The distinction is invisible in every other assertion and it decides
// whether a shadowed UI is usable. XRender's `convolution` filter is applied
// by the server on **every composite** of the picture it is set on, so a
// cached shadow whose picture still carries the filter costs its whole
// kernel every frame it is drawn — the cache hits, nothing re-renders, and
// the frame is as expensive as it ever was. Measured on XQuartz, one card's
// `:hover` repaint took 1.6s and a full-window repaint 9s; with the blur
// baked into the surface, 1.5ms and 13ms.
//
// Nothing else catches it: request counts are identical (the filter is set
// once either way), the composited area is identical, the pixels are
// identical, and the paint-cache statistics say "hit". So this asserts the
// one fact that differs — what the server holds against the cached
// surface's picture — by reading it out of the in-process server, which
// stores `filter`/`filterParams` per picture the way a real one does.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import { createRoot } from '../src/index.js';
import { shadowReach } from 'ntk';
import { blurKernel } from '../src/decorations.js';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

const h = React.createElement;
const settle = (app) =>
  new Promise((resolve, reject) =>
    app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
  );

async function headless() {
  const server = xserver.createServer({ width: 400, height: 300 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  fontSource.alias('sans-serif', 'Test Main');
  const app = await createClient({ stream: clientEnd, fontSource });
  return { app, server };
}

const card = () =>
  h(
    'window',
    { width: 400, height: 300, style: { backgroundColor: '#ffffff' } },
    h('box', {
      style: {
        width: 160,
        height: 80,
        marginTop: 40,
        marginLeft: 40,
        borderRadius: 10,
        backgroundColor: '#ffffff',
        boxShadow: '0 6px 18px rgba(0, 0, 0, 0.4)',
      },
    }),
  );

test('a cached blurred shadow composites as a plain mask', async () => {
  const { app, server } = await headless();
  const x11Root = await createRoot({ app });
  const instance = await new Promise((resolve) =>
    x11Root.render(card(), resolve),
  );
  const root = instance._reactX11Node;
  const frame = () => {
    root._scheduled = false;
    root.flush();
  };
  frame();
  await settle(app);
  // The cache keeps a drawing it has seen **twice** — the first paint goes
  // live — so the entry only exists after a second frame.
  root.invalidate(false, null, 'style');
  frame();
  await settle(app);

  const cache = root._paintCache;
  assert.ok(cache, 'the window has a paint cache');
  const entry = [...cache.entries.values()].find((e) =>
    e.key.startsWith('shadow|'),
  );
  assert.ok(entry, 'the blurred shadow was cached');

  const picture = server.resources.get(entry.surface.picture().id);
  assert.ok(picture, 'the cached surface has a live picture on the server');
  assert.notEqual(
    picture.filter,
    'convolution',
    'the blur must be baked into the pixels: a convolution left on the ' +
      'picture is re-run by the server on every composite',
  );

  await x11Root.unmount();
  await app.close();
});

test('the coverage surface is padded for the kernel ntk will run', () => {
  // The blur is ntk's (`blurCoverage`), and it derives its own kernel from
  // sigma — so the padding react-x11 puts around the shape has to cover
  // *that* reach. Too little and the convolution samples past the surface,
  // where RepeatNone reads transparent, and the shadow ends in a straight
  // line down its own edge. Nothing about that looks like a bug from the
  // style, and no pixel test in this repo draws a shadow big enough to show
  // it, so the agreement is asserted directly.
  for (const blur of [1, 4, 8, 20, 22, 42, 120, 4000]) {
    const { sigma, pad } = blurKernel(blur);
    assert.ok(
      pad >= shadowReach(sigma),
      `blur ${blur}: pad ${pad} must cover reach ${shadowReach(sigma)}`,
    );
  }
});
