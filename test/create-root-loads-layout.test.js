// `createRoot()` loads the layout engine before anything builds a node.
//
// Every drawn node creates a yoga node in its constructor, and the engine's
// WebAssembly is loaded rather than imported (src/yoga.js keeps top-level
// await out of the bundle). While the engine was ntk's, ntk's `createClient`
// did the loading and `createRoot({ app })` free-rode on it. The engine is
// ours now, so `createRoot` is the one place that knows — and if it ever
// stops, the first render throws "the layout engine is not loaded" instead
// of rendering.
//
// **This file must not import the mock app** (`test/helpers/mock-app.js`),
// which awaits `loadLayout()` at module scope: the assertion below is that
// the engine was *not* already loaded, and that import would satisfy it for
// the wrong reason. It is a file of its own so that stays structural rather
// than a matter of test order.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';
import { layoutLoaded } from '../src/yoga.js';

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

test('createRoot loads the layout engine, borrowed connection included', async () => {
  assert.equal(
    layoutLoaded(),
    false,
    'nothing has loaded it yet — ntk loading its own says nothing about ours',
  );

  const server = xserver.createServer({ width: 200, height: 150 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  fontSource.alias('sans-serif', 'Test Main');

  // a connection built outside react-x11 and handed over: the path that used
  // to depend on ntk having loaded the engine on our behalf
  const app = await createClient({ stream: clientEnd, fontSource });
  const root = await createRoot({ app });
  try {
    assert.equal(layoutLoaded(), true, 'createRoot loaded it');

    // and the tree it was loaded for actually lays out
    const wnd = await new Promise((resolve) =>
      root.render(
        React.createElement(
          'window',
          { width: 200, height: 150 },
          React.createElement('box', {
            style: { width: 40, height: 20, backgroundColor: '#ff0000' },
          }),
        ),
        (instance) => resolve(instance),
      ),
    );
    // let the first frame run to completion, so nothing is still queued on
    // the frame clock when the connection goes
    await new Promise((resolve) => setTimeout(resolve, 100));

    const box = wnd._reactX11Node.children[0];
    assert.deepStrictEqual(
      [box.abs.width, box.abs.height],
      [40, 20],
      'the box got a computed size, so a real yoga node backed it',
    );
    await root.unmount();
    // drain the in-flight request/reply chains before closing, or a frame
    // still on the immediate queue reaches a closing connection
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve, reject) =>
        app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
      );
    }
  } finally {
    await app.close();
  }
});
