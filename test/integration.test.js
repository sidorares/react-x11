import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import ReactX11 from '../src/index.js';

// End-to-end test: react-x11 -> real ntk client -> node-x11's pure-JS
// in-process X server. No $DISPLAY needed (see ntk docs/xserver.md).
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

async function createHeadlessApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);

  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  fontSource.alias('sans-serif', 'Test Main');

  const app = await createClient({ stream: clientEnd, fontSource });
  return { server, app };
}

function render(element, app) {
  return new Promise((resolve) => {
    ReactX11.render(element, (instance) => resolve(instance), app);
  });
}

// Drain in-flight request/reply chains (e.g. setTitle's nested InternAtom
// round trips for _NET_WM_NAME) before closing the connection.
async function settle(app, roundTrips = 3) {
  for (let i = 0; i < roundTrips; i++) {
    await new Promise((resolve, reject) =>
      app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
    );
  }
}

const readPixels = (ctx, w, h) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, w, h, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );

// BGRA readback -> [r, g, b]
const px = (image, w, x, y) => {
  const i = (y * w + x) * 4;
  return [image.data[i + 2], image.data[i + 1], image.data[i]];
};

const isNear = (rgb, want, tol = 40) =>
  rgb.every((c, i) => Math.abs(c - want[i]) <= tol);

async function waitForPixel(ctx, w, h, x, y, want, what) {
  const deadline = Date.now() + 3000;
  let last = null;
  for (;;) {
    const image = await readPixels(ctx, w, h);
    last = px(image, w, x, y);
    if (isNear(last, want)) return;
    if (Date.now() > deadline) {
      assert.fail(
        `${what}: expected ~rgb(${want}) at ${x},${y}, got rgb(${last})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('renders a window tree into an in-process X server', async () => {
  const { app } = await createHeadlessApp();
  try {
    const instance = await render(
      React.createElement(
        'window',
        { width: 300, height: 200, title: 'integration' },
        React.createElement('window', { width: 50, height: 50, x: 10, y: 10 }),
      ),
      app,
    );

    assert.ok(instance, 'render callback should receive the root instance');
    assert.ok(instance.id > 0, 'root instance should be a real X11 window');

    // Update pass: resize and retitle through React props.
    await render(
      React.createElement(
        'window',
        { width: 320, height: 240, title: 'integration-updated' },
        React.createElement('window', { width: 50, height: 50, x: 10, y: 10 }),
      ),
      app,
    );

    ReactX11.unmountComponentAtNode(app);
    await settle(app);
  } finally {
    await app.close();
  }
});

test('paints a flex box tree and reflows on update', async () => {
  const { app } = await createHeadlessApp();
  try {
    const ui = (leftColor) =>
      React.createElement(
        'window',
        { width: 160, height: 120 },
        React.createElement(
          'box',
          { flexDirection: 'row', flexGrow: 1 },
          React.createElement('box', {
            flexGrow: 1,
            backgroundColor: leftColor,
          }),
          React.createElement('box', { flexGrow: 1, backgroundColor: 'blue' }),
        ),
      );

    const wnd = await render(ui('red'), app);
    const ctx = wnd.getContext('2d');

    await waitForPixel(ctx, 160, 120, 40, 60, [255, 0, 0], 'left half red');
    await waitForPixel(ctx, 160, 120, 120, 60, [0, 0, 255], 'right half blue');

    // state-driven repaint
    await render(ui('green'), app);
    await waitForPixel(ctx, 160, 120, 40, 60, [0, 128, 0], 'left half green');

    ReactX11.unmountComponentAtNode(app);
  } finally {
    await app.close();
  }
});

test('scrollview scrolls content (pixel-verified)', async () => {
  const { app } = await createHeadlessApp();
  try {
    const ref = React.createRef();
    const wnd = await render(
      React.createElement(
        'window',
        { width: 100, height: 100 },
        React.createElement(
          'scrollview',
          { flexGrow: 1, ref, scrollbar: false },
          React.createElement('box', { height: 100, backgroundColor: 'red' }),
          React.createElement('box', {
            height: 100,
            backgroundColor: '#00ff00',
          }),
        ),
      ),
      app,
    );
    const ctx = wnd.getContext('2d');

    await waitForPixel(ctx, 100, 100, 40, 50, [255, 0, 0], 'unscrolled: red');
    ref.current.scrollTo(100);
    await waitForPixel(ctx, 100, 100, 40, 50, [0, 255, 0], 'scrolled: green');

    ReactX11.unmountComponentAtNode(app);
  } finally {
    await app.close();
  }
});

test('popup is override-redirect on the server and paints', async () => {
  const { app } = await createHeadlessApp();
  try {
    const ref = React.createRef();
    await render(
      React.createElement(
        'window',
        { width: 120, height: 80 },
        React.createElement(
          'box',
          { flexGrow: 1 },
          React.createElement(
            'popup',
            { ref, x: 10, y: 10, width: 60, height: 40 },
            React.createElement('box', {
              flexGrow: 1,
              backgroundColor: 'red',
            }),
          ),
        ),
      ),
      app,
    );

    const popupWindow = ref.current;
    assert.ok(popupWindow.id > 0, 'popup should be a real X11 window');

    const attrs = await new Promise((resolve, reject) =>
      app.X.GetWindowAttributes(popupWindow.id, (err, a) =>
        err ? reject(err) : resolve(a),
      ),
    );
    assert.strictEqual(
      Number(attrs.overrideRedirect),
      1,
      'popup window must have overrideRedirect set',
    );

    const ctx = popupWindow.getContext('2d');
    await waitForPixel(ctx, 60, 40, 30, 20, [255, 0, 0], 'popup content red');

    ReactX11.unmountComponentAtNode(app);
    await settle(app);
  } finally {
    await app.close();
  }
});

test('textinput renders its value through the ntk text stack', async () => {
  const { app } = await createHeadlessApp();
  try {
    const wnd = await render(
      React.createElement(
        'window',
        { width: 200, height: 60, backgroundColor: 'white' },
        React.createElement('textinput', {
          value: 'Hello',
          fontSize: 24,
          flexGrow: 1,
          backgroundColor: 'white',
        }),
      ),
      app,
    );
    const ctx = wnd.getContext('2d');

    const deadline = Date.now() + 3000;
    for (;;) {
      const image = await readPixels(ctx, 200, 60);
      let ink = 0;
      for (let y = 0; y < 60; y++) {
        for (let x = 0; x < 120; x++) {
          const [r, g, b] = px(image, 200, x, y);
          if (r < 128 && g < 128 && b < 128) ink++;
        }
      }
      if (ink > 20) break;
      if (Date.now() > deadline) {
        assert.fail(`expected textinput ink, found ${ink} dark pixels`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    ReactX11.unmountComponentAtNode(app);
  } finally {
    await app.close();
  }
});

test('renders <text> through the ntk text stack', async () => {
  const { app } = await createHeadlessApp();
  try {
    const wnd = await render(
      React.createElement(
        'window',
        { width: 160, height: 60, backgroundColor: 'white' },
        React.createElement('text', { fontSize: 24, color: 'black' }, 'Hello'),
      ),
      app,
    );
    const ctx = wnd.getContext('2d');

    // glyphs land in the top-left region; wait until some ink appears
    const deadline = Date.now() + 3000;
    for (;;) {
      const image = await readPixels(ctx, 160, 60);
      let ink = 0;
      for (let y = 0; y < 40; y++) {
        for (let x = 0; x < 100; x++) {
          const [r, g, b] = px(image, 160, x, y);
          if (r < 128 && g < 128 && b < 128) ink++;
        }
      }
      if (ink > 20) break;
      if (Date.now() > deadline) {
        assert.fail(
          `expected text ink in the top-left region, found ${ink} dark pixels`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    ReactX11.unmountComponentAtNode(app);
  } finally {
    await app.close();
  }
});
