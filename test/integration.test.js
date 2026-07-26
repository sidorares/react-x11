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

test('textinput caret advances past trailing spaces', async () => {
  const { app } = await createHeadlessApp();
  try {
    const ref = React.createRef();
    await render(
      React.createElement(
        'window',
        { width: 200, height: 60 },
        React.createElement('textinput', {
          ref,
          defaultValue: 'hi  x',
          flexGrow: 1,
        }),
      ),
      app,
    );
    const input = ref.current;

    // TextLayout strips trailing whitespace, so prefix widths must add
    // space advances back: each typed space moves the caret.
    const w2 = input._prefixWidth(2); // "hi"
    const w3 = input._prefixWidth(3); // "hi "
    const w4 = input._prefixWidth(4); // "hi  "
    const w5 = input._prefixWidth(5); // "hi  x"
    assert.ok(w3 > w2, `caret must advance after a space (${w3} > ${w2})`);
    assert.ok(w4 > w3, `and after a second space (${w4} > ${w3})`);
    assert.ok(w5 > w4, `and after the next character (${w5} > ${w4})`);
    // the explicit space advance should match real shaping: "hi  x" vs
    // measured solid text should agree within a pixel
    const full = app.fonts.layout('hi  x', {
      family: 'sans-serif',
      size: 14,
    }).width;
    assert.ok(
      Math.abs(w5 - full) < 1.5,
      `synthetic advance tracks shaping (${w5} vs ${full})`,
    );

    ReactX11.unmountComponentAtNode(app);
    await settle(app);
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

// Scan a region until it contains at least `minInk` pixels matching `match`.
async function waitForInk(ctx, w, h, region, match, minInk, what) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const image = await readPixels(ctx, w, h);
    const hits = [];
    for (let y = region.y; y < region.y + region.height; y++) {
      for (let x = region.x; x < region.x + region.width; x++) {
        if (match(px(image, w, x, y))) hits.push([x, y]);
      }
    }
    if (hits.length >= minInk) return hits;
    if (Date.now() > deadline) {
      assert.fail(`${what}: found only ${hits.length}/${minInk} pixels`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const isDark = ([r, g, b]) => r < 128 && g < 128 && b < 128;

test('<markdown> renders through MarkdownView and dispatches onLink', async () => {
  const { app } = await createHeadlessApp();
  try {
    const clicked = [];
    const wnd = await render(
      React.createElement(
        'window',
        { width: 300, height: 200, backgroundColor: 'white' },
        React.createElement('markdown', {
          source: '# Heading\n\n[the link](https://example.com/)',
          onLink: (href) => clicked.push(href),
        }),
      ),
      app,
    );
    const ctx = wnd.getContext('2d');

    // heading ink (2em bold) in the top region
    await waitForInk(
      ctx,
      300,
      200,
      { x: 0, y: 0, width: 200, height: 50 },
      isDark,
      20,
      'markdown heading ink',
    );
    // the link paragraph paints in the theme link color; click it
    const linkPixels = await waitForInk(
      ctx,
      300,
      200,
      { x: 0, y: 0, width: 300, height: 120 },
      ([r, g, b]) => b > 140 && b - r > 60 && b - g > 40,
      5,
      'link-colored ink',
    );
    const [lx, ly] = linkPixels[Math.floor(linkPixels.length / 2)];
    wnd.emit('mousedown', { x: lx, y: ly, keycode: 1 });
    wnd.emit('mouseup', { x: lx, y: ly, keycode: 1 });
    assert.deepStrictEqual(clicked, ['https://example.com/']);

    ReactX11.unmountComponentAtNode(app);
  } finally {
    await app.close();
  }
});

test('<html> renders styled boxes through HtmlView', async () => {
  const { app } = await createHeadlessApp();
  try {
    const wnd = await render(
      React.createElement(
        'window',
        { width: 200, height: 120, backgroundColor: 'white' },
        React.createElement('html', {
          source:
            '<div style="width: 80px; height: 40px; background: #0000ff; margin: 0"></div>',
        }),
      ),
      app,
    );
    const ctx = wnd.getContext('2d');
    await waitForPixel(ctx, 200, 120, 20, 20, [0, 0, 255], 'html div blue');
    ReactX11.unmountComponentAtNode(app);
  } finally {
    await app.close();
  }
});

test('<svg> scales its viewBox into the content box', async () => {
  const { app } = await createHeadlessApp();
  try {
    const wnd = await render(
      React.createElement(
        'window',
        { width: 100, height: 100, backgroundColor: 'white' },
        React.createElement('svg', {
          width: 60,
          height: 60,
          source:
            '<svg viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10" fill="#ff0000"/></svg>',
        }),
      ),
      app,
    );
    const ctx = wnd.getContext('2d');
    await waitForPixel(ctx, 100, 100, 30, 30, [255, 0, 0], 'svg rect red');
    await waitForPixel(ctx, 100, 100, 80, 80, [255, 255, 255], 'outside white');
    ReactX11.unmountComponentAtNode(app);
  } finally {
    await app.close();
  }
});

test('<tex> lays out and draws a formula', async () => {
  const { app } = await createHeadlessApp();
  try {
    const wnd = await render(
      React.createElement(
        'window',
        { width: 200, height: 80, backgroundColor: 'white' },
        React.createElement('tex', {
          source: 'x = \\frac{1}{2}',
          size: 32,
          displayMode: true,
        }),
      ),
      app,
    );
    const ctx = wnd.getContext('2d');
    await waitForInk(
      ctx,
      200,
      80,
      { x: 0, y: 0, width: 150, height: 80 },
      isDark,
      15,
      'tex formula ink',
    );
    ReactX11.unmountComponentAtNode(app);
  } finally {
    await app.close();
  }
});

test('<markdown> mermaid fence reflows into a diagram (ntk onInvalidate)', async () => {
  const { app } = await createHeadlessApp();
  try {
    const wnd = await render(
      React.createElement(
        'window',
        { width: 300, height: 200, backgroundColor: 'white' },
        React.createElement('markdown', {
          source: '```mermaid\nflowchart LR\n  A[Hello] --> B[World]\n```',
        }),
      ),
      app,
    );
    const ctx = wnd.getContext('2d');

    // the fence first paints as a code block; when the async mermaid model
    // arrives the widget fires onInvalidate and the element reflows into
    // diagram node boxes (theme fill #ececff). The grammar loads lazily,
    // so allow more time than the default waitForInk deadline.
    const isNodeFill = ([r, g, b]) =>
      r > 220 && g > 220 && b > 245 && b > r + 8;
    const deadline = Date.now() + 10000;
    for (;;) {
      const image = await readPixels(ctx, 300, 200);
      let hits = 0;
      for (let y = 0; y < 120; y++) {
        for (let x = 0; x < 300; x++) {
          if (isNodeFill(px(image, 300, x, y))) hits++;
        }
      }
      if (hits > 50) break;
      if (Date.now() > deadline) {
        assert.fail(`mermaid diagram never painted (${hits} fill pixels)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    ReactX11.unmountComponentAtNode(app);
  } finally {
    await app.close();
  }
});
