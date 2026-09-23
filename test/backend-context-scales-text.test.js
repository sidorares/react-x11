// Whether a context draws text scaled under a transform that scales.
//
// An element that zooms — a graph, a map — would rather draw the text
// layouts it already has, scaled, than shape every label again at each step
// of a gesture. That is only right where the context scales the glyphs with
// the transform: the Windows and macOS context does (Direct2D and CoreText
// draw a layout's outlines through the matrix). ntk's context on X11 draws
// glyphs from a cache rasterized at the size they were shaped at, and says
// nothing — which reads as no.
import assert from 'node:assert';
import { test } from 'node:test';

import React from 'react';
import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { BackendContext2D } from '../src/backend/context2d.js';
import { createRoot } from '../src/index.js';

test('the Windows and macOS context scales text', () => {
  const native = new Proxy({}, { get: () => () => undefined });
  const ctx = new BackendContext2D(
    native,
    () => ({}),
    () => 1,
  );
  assert.strictEqual(ctx.scalesText, true);
});

test('ntk’s context on X11 does not say so', async () => {
  const server = xserver.createServer({ width: 64, height: 64 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd });
  const x11Root = await createRoot({ app });
  try {
    const wnd = await new Promise((resolve) =>
      x11Root.render(
        React.createElement('window', { width: 32, height: 32 }),
        resolve,
      ),
    );
    const ctx = wnd.getContext('2d');
    assert.strictEqual(typeof ctx.fillText, 'function', 'a real context');
    assert.notStrictEqual(ctx.scalesText, true);
  } finally {
    await x11Root.unmount();
    await app.close();
  }
});
