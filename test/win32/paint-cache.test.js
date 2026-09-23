// The Windows window takes its frames through `presentFrame`, and the paint
// cache was only ever set up on the other path — the ntk window's. So on
// Windows no `<canvas cacheKey>` was served from it (every pass over one drew
// it afresh: a graph pane's card canvases, on every step of a drag), and a
// shadow, which is only ever baked into the cache (issue #413), was not drawn
// at all. A presenter whose frame is the ordinary paint walk says so
// (`usesPaintCache`), and paints through the cache like an ntk window.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import React from 'react';

import { createRoot } from '../../src/index.js';
import { Win32App } from '../../src/win32/app.js';
import { createFakeBridge } from './fake-bridge.js';

const h = React.createElement;

async function waitFor(check, what, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('win32 paint cache', () => {
  it('a <canvas cacheKey> is drawn until it is cached, then served from the cache', async () => {
    const bridge = createFakeBridge();
    Object.assign(bridge, {
      dropTargetEnable() {},
      systemAppearance: () => null,
      windowAppId() {},
      windowRelaunch() {},
    });
    const app = new Win32App(bridge, {});
    const root = await createRoot({ app });
    let drawn = 0;
    const draw = (ctx) => {
      drawn++;
      ctx.fillStyle = '#336699';
      ctx.fillRect(0, 0, 80, 40);
    };
    // a box over the canvas whose colour changes: a pass over the canvas's
    // pixels every time, and nothing the canvas shows changed
    const tree = (color) =>
      h(
        'window',
        { width: 200, height: 120 },
        h('canvas', {
          style: { width: 80, height: 40 },
          cacheKey: 'card',
          onDraw: draw,
        }),
        h('box', {
          style: {
            position: 'absolute',
            left: 10,
            top: 10,
            width: 20,
            height: 20,
            backgroundColor: color,
          },
        }),
      );
    try {
      root.render(tree('#ff0000'));
      await waitFor(() => bridge.windows.size > 0, 'the window');
      const [id] = bridge.windows.keys();
      app._route({ type: 'window-ready', id, a: 0, b: 0 });
      await waitFor(() => drawn > 0, 'the first frame');
      const colours = ['#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff'];
      for (const colour of colours) {
        const before = bridge.drawn.length;
        root.render(tree(colour));
        await waitFor(
          () => bridge.drawn.length > before,
          `a frame for ${colour}`,
        );
      }
      assert.ok(
        drawn <= 2,
        `drawn ${drawn} times over ${colours.length + 1} passes — the cache ` +
          'admits a key the second time it sees it, and serves it after',
      );
      assert.ok(
        bridge.calls.some(([name]) => name === 'ctxDrawSurface'),
        'the cached drawing was blitted',
      );
    } finally {
      await root.unmount();
    }
  });
});
