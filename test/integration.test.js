import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import { createRoot } from '../src/index.js';
import { anchorRect } from '../src/components/anchor.js';

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

function render(element, x11Root) {
  return new Promise((resolve) => {
    x11Root.render(element, (instance) => resolve(instance));
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

// getImageData is straight RGBA, like canvas -> [r, g, b]
const px = (image, w, x, y) => {
  const i = (y * w + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
};

const isNear = (rgb, want, tol = 40) =>
  rgb.every((c, i) => Math.abs(c - want[i]) <= tol);

async function waitForPixel(ctx, w, h, x, y, want, what) {
  const deadline = Date.now() + 3000;
  // no initializer: the loop below always assigns before anything reads it,
  // and eslint 10's no-useless-assignment flags the dead `= null`
  let last;
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
  const x11Root = await createRoot({ app });
  try {
    const instance = await render(
      React.createElement(
        'window',
        { width: 300, height: 200, title: 'integration' },
        React.createElement('window', { width: 50, height: 50, x: 10, y: 10 }),
      ),
      x11Root,
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
      x11Root,
    );

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

test('child windows stack bottom-to-top in JSX order on the server', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const refs = { a: React.createRef(), b: React.createRef() };
    // Two child windows on the same spot. The check is QueryTree, not
    // pixels: getImageData reads a window's backing pixmap, which stays
    // valid while the window is occluded, and the in-process server does
    // not composite children into the parent or the root either. QueryTree
    // is what stacking order *means* in the protocol.
    const ui = (order) =>
      React.createElement(
        'window',
        { width: 160, height: 120 },
        order.map((key) =>
          React.createElement(
            'window',
            { key, ref: refs[key], x: 20, y: 20, width: 80, height: 60 },
            React.createElement('box', {
              style: {
                flexGrow: 1,
                backgroundColor: key === 'a' ? 'red' : 'blue',
              },
            }),
          ),
        ),
      );

    const parent = await render(ui(['a', 'b']), x11Root);
    const queryTree = (id) =>
      new Promise((resolve, reject) =>
        app.X.QueryTree(id, (err, tree) => (err ? reject(err) : resolve(tree))),
      );

    // X reports children bottom to top, so this is the JSX order verbatim
    assert.deepStrictEqual(
      (await queryTree(parent.id)).children,
      [refs.a.current.id, refs.b.current.id],
      'the later sibling starts on top',
    );

    await render(ui(['b', 'a']), x11Root);
    assert.deepStrictEqual(
      (await queryTree(parent.id)).children,
      [refs.b.current.id, refs.a.current.id],
      'reordering the JSX restacks the real windows',
    );

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

test('paints a flex box tree and reflows on update', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ui = (leftColor) =>
      React.createElement(
        'window',
        { width: 160, height: 120 },
        React.createElement(
          'box',
          { style: { flexDirection: 'row', flexGrow: 1 } },
          React.createElement('box', {
            style: { flexGrow: 1, backgroundColor: leftColor },
          }),
          React.createElement('box', {
            style: { flexGrow: 1, backgroundColor: 'blue' },
          }),
        ),
      );

    const wnd = await render(ui('red'), x11Root);
    const ctx = wnd.getContext('2d');

    await waitForPixel(ctx, 160, 120, 40, 60, [255, 0, 0], 'left half red');
    await waitForPixel(ctx, 160, 120, 120, 60, [0, 0, 255], 'right half blue');

    // state-driven repaint
    await render(ui('green'), x11Root);
    await waitForPixel(ctx, 160, 120, 40, 60, [0, 128, 0], 'left half green');

    await x11Root.unmount();
  } finally {
    await app.close();
  }
});

test('scrollview scrolls content (pixel-verified)', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const wnd = await render(
      React.createElement(
        'window',
        { width: 100, height: 100 },
        React.createElement(
          'scrollview',
          { ref, scrollbar: false, style: { flexGrow: 1 } },
          React.createElement('box', {
            style: { height: 100, backgroundColor: 'red' },
          }),
          React.createElement('box', {
            style: { height: 100, backgroundColor: '#00ff00' },
          }),
        ),
      ),
      x11Root,
    );
    const ctx = wnd.getContext('2d');

    await waitForPixel(ctx, 100, 100, 40, 50, [255, 0, 0], 'unscrolled: red');
    ref.current.scrollTo(100);
    await waitForPixel(ctx, 100, 100, 40, 50, [0, 255, 0], 'scrolled: green');

    await x11Root.unmount();
  } finally {
    await app.close();
  }
});

test('popup is override-redirect on the server and paints', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ref = React.createRef();
    await render(
      React.createElement(
        'window',
        { width: 120, height: 80 },
        React.createElement(
          'box',
          { style: { flexGrow: 1 } },
          React.createElement(
            'popup',
            { ref, x: 10, y: 10, width: 60, height: 40 },
            React.createElement('box', {
              style: { flexGrow: 1, backgroundColor: 'red' },
            }),
          ),
        ),
      ),
      x11Root,
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

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

test('a popup anchors to the window even once a WM has reframed it', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const wnd = await render(
      React.createElement(
        'window',
        { width: 200, height: 120, x: 0, y: 0 },
        React.createElement('box', {
          ref,
          style: { marginTop: 30, marginLeft: 20, width: 80, height: 20 },
        }),
      ),
      x11Root,
    );
    await settle(app);

    const root = app.X.display.screen[0].root;
    // Stand in for a reparenting window manager: a frame at (150, 90) with
    // the client inside it, offset by a titlebar. After this the client's
    // ConfigureNotify coordinates are relative to the frame, which is
    // exactly the case that put popups in the corner of the screen.
    const frame = app.X.AllocID();
    app.X.CreateWindow(frame, root, 150, 90, 220, 150);
    app.X.ReparentWindow(wnd.id, frame, 10, 25);
    app.X.MapWindow(frame);
    await settle(app);

    wnd._reactX11Node._refreshScreenOrigin();
    await settle(app);

    const node = ref.current;
    const rect = anchorRect(node, { placement: 'bottom', height: 40 });
    // frame at 150,90 + client at 10,25 inside it + the box at 20,30
    assert.strictEqual(rect.x, 150 + 10 + 20, 'x is measured from the root');
    assert.strictEqual(
      rect.y,
      90 + 25 + 30 + 20 + 2,
      'and y clears the trigger, in root coordinates',
    );
    assert.deepStrictEqual(
      wnd._screenOrigin,
      { x: 160, y: 115 },
      'the origin came from the server, not from ConfigureNotify',
    );

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

test('textinput renders its value through the ntk text stack', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const wnd = await render(
      React.createElement(
        'window',
        { width: 200, height: 60, style: { backgroundColor: 'white' } },
        React.createElement('textinput', {
          value: 'Hello',
          style: { fontSize: 24, flexGrow: 1, backgroundColor: 'white' },
        }),
      ),
      x11Root,
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

    await x11Root.unmount();
  } finally {
    await app.close();
  }
});

test('an unfocused field shows the start of its value, not the caret', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    // The caret starts at the *end* of the value, and the paint used to chase
    // it whether or not the field had ever been focused — so a field holding
    // more text than fits opened scrolled past its own first characters, and a
    // textarea opened below its first lines. Both read as a rendering bug
    // rather than as a scroll position.
    const input = React.createRef();
    const area = React.createRef();
    const wnd = await render(
      React.createElement(
        'window',
        { width: 200, height: 140, style: { backgroundColor: 'white' } },
        React.createElement('textinput', {
          ref: input,
          // comfortably wider than the 120px box at this size
          value: 'a value far too long to fit inside the box it is in',
          style: { width: 120, fontSize: 13 },
        }),
        React.createElement('textarea', {
          ref: area,
          value: 'one\ntwo\nthree\nfour\nfive\nsix',
          rows: 2,
          style: { width: 120, fontSize: 13 },
        }),
      ),
      x11Root,
    );

    // paint at least once: the offsets are settled during _paintContent
    const root = wnd._reactX11Node;
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setImmediate(r));
      root._scheduled = false;
      root.flush();
      await new Promise((resolve) => app.X.GetInputFocus(() => resolve()));
    }

    assert.ok(
      input.current._prefixWidth(input.current.value.length) > 120,
      'the premise: the value must overflow its box, or there is nothing to ' +
        'scroll and the test proves nothing',
    );
    assert.strictEqual(
      input.current._scrollX,
      0,
      'an unfocused textinput is scrolled to the start of its value',
    );
    assert.strictEqual(
      area.current._scrollY,
      0,
      'an unfocused textarea shows its first lines',
    );

    await x11Root.unmount();
  } finally {
    await app.close();
  }
});

test('textinput caret advances past trailing spaces', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ref = React.createRef();
    await render(
      React.createElement(
        'window',
        { width: 200, height: 60 },
        React.createElement('textinput', {
          ref,
          defaultValue: 'hi  x',
          style: { flexGrow: 1 },
        }),
      ),
      x11Root,
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

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

test('renders <text> through the ntk text stack', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const wnd = await render(
      React.createElement(
        'window',
        { width: 160, height: 60, style: { backgroundColor: 'white' } },
        React.createElement(
          'text',
          { style: { fontSize: 24, color: 'black' } },
          'Hello',
        ),
      ),
      x11Root,
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

    await x11Root.unmount();
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

test('centered text is vertically balanced (half-leading)', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const wnd = await render(
      React.createElement(
        'window',
        { width: 200, height: 100, style: { backgroundColor: 'white' } },
        React.createElement(
          'box',
          {
            style: {
              flexGrow: 1,
              alignItems: 'center',
              justifyContent: 'center',
            },
          },
          React.createElement(
            'text',
            { style: { fontSize: 48, color: 'black' } },
            'HHH',
          ),
        ),
      ),
      x11Root,
    );
    const ctx = wnd.getContext('2d');
    await waitForInk(
      ctx,
      200,
      100,
      { x: 0, y: 0, width: 200, height: 100 },
      isDark,
      40,
      'centered text ink',
    );

    // TextLayout packs the line's leading below the glyphs; painting must
    // redistribute it (CSS half-leading), or centered labels ride high.
    // Cap-only text sits (ascent - capHeight - descent) / 2 above the true
    // center (KaTeX Main: ~1.3px at 48px); without the half-leading shift
    // it would be ~3.6px off.
    const image = await readPixels(ctx, 200, 100);
    let inkTop = null;
    let inkBottom = null;
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 200; x++) {
        if (isDark(px(image, 200, x, y))) {
          if (inkTop == null) inkTop = y;
          inkBottom = y;
          break;
        }
      }
    }
    const offset = (inkTop + inkBottom + 1) / 2 - 50;
    assert.ok(
      Math.abs(offset) <= 2.5,
      `centered text ink [${inkTop}..${inkBottom}] should straddle y=50, ` +
        `off by ${offset}px`,
    );

    await x11Root.unmount();
  } finally {
    await app.close();
  }
});

test('rich content scrolled out of a scrollview leaves no ink behind', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    // a math fence: KaTeX draws glyph runs and vector shapes of its own,
    // which used to bypass the 2d clip and paint over whatever was above
    // the scrollview once they were scrolled out (fixed in ntk 3.7.1)
    const source = `# Heading\n\n\`\`\`math\n\\sqrt{\\frac{x+1}{2}}\n\`\`\`\n\n${'filler paragraph. '.repeat(40)}\n`;
    const wnd = await render(
      React.createElement(
        'window',
        { width: 300, height: 300, style: { backgroundColor: 'white' } },
        React.createElement(
          'box',
          { style: { flexGrow: 1, padding: 20 } },
          React.createElement('box', { style: { height: 60 } }), // the band above it
          React.createElement(
            'scrollview',
            { style: { flexGrow: 1 } },
            React.createElement('markdown', { source }),
          ),
        ),
      ),
      x11Root,
    );
    const ctx = wnd.getContext('2d');
    const node = wnd._reactX11Node;
    const scroll = node.children[0].children[1];

    // wait until the document has laid out and drawn something
    await waitForInk(
      ctx,
      300,
      300,
      { x: 20, y: 80, width: 260, height: 200 },
      isDark,
      20,
      'markdown ink inside the scrollview',
    );

    const inkAbove = async () => {
      const image = await readPixels(ctx, 300, 300);
      let n = 0;
      for (let y = 20; y < 79; y++) {
        for (let x = 20; x < 280; x++) if (isDark(px(image, 300, x, y))) n++;
      }
      return n;
    };
    assert.equal(await inkAbove(), 0, 'nothing above it to begin with');

    for (const offset of [120, 160, 200]) {
      scroll.scrollTo(offset);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(
        await inkAbove(),
        0,
        `nothing painted above the scrollview at offset ${offset}`,
      );
    }

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

test('<markdown> survives a document being typed down to nothing', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    let setText;
    const Host = () => {
      const [text, set] = React.useState('# hello\n\nsome **text**');
      setText = set;
      return React.createElement(
        'window',
        { width: 300, height: 200, style: { backgroundColor: 'white' } },
        React.createElement(
          'scrollview',
          { style: { flexGrow: 1 } },
          React.createElement('markdown', { style: { padding: 6 } }, text),
        ),
      );
    };
    await render(React.createElement(Host), x11Root);

    // a live preview goes through these states on the way to empty, and a
    // blank block lays out with no spans at all — which used to throw
    // inside TextLayout and take the frame with it (ntk 3.7.2)
    for (const value of ['# h', '#', '', ' ', '\n\n', '- ']) {
      setText(value);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await settle(app);

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

test('<markdown> renders through MarkdownView and dispatches onLink', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const clicked = [];
    const wnd = await render(
      React.createElement(
        'window',
        { width: 300, height: 200, style: { backgroundColor: 'white' } },
        React.createElement('markdown', {
          source: '# Heading\n\n[the link](https://example.com/)',
          onLink: (href) => clicked.push(href),
        }),
      ),
      x11Root,
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

    await x11Root.unmount();
  } finally {
    await app.close();
  }
});

test('<html> renders styled boxes through HtmlView', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const wnd = await render(
      React.createElement(
        'window',
        { width: 200, height: 120, style: { backgroundColor: 'white' } },
        React.createElement('html', {
          source:
            '<div style="width: 80px; height: 40px; background: #0000ff; margin: 0"></div>',
        }),
      ),
      x11Root,
    );
    const ctx = wnd.getContext('2d');
    await waitForPixel(ctx, 200, 120, 20, 20, [0, 0, 255], 'html div blue');
    await x11Root.unmount();
  } finally {
    await app.close();
  }
});

test('<svg> scales its viewBox into the content box', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const wnd = await render(
      React.createElement(
        'window',
        { width: 100, height: 100, style: { backgroundColor: 'white' } },
        React.createElement('svg', {
          source:
            '<svg viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10" fill="#ff0000"/></svg>',
          style: { width: 60, height: 60 },
        }),
      ),
      x11Root,
    );
    const ctx = wnd.getContext('2d');
    await waitForPixel(ctx, 100, 100, 30, 30, [255, 0, 0], 'svg rect red');
    await waitForPixel(ctx, 100, 100, 80, 80, [255, 255, 255], 'outside white');
    await x11Root.unmount();
  } finally {
    await app.close();
  }
});

test('<tex> lays out and draws a formula', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const wnd = await render(
      React.createElement(
        'window',
        { width: 200, height: 80, style: { backgroundColor: 'white' } },
        React.createElement('tex', {
          source: 'x = \\frac{1}{2}',
          size: 32,
          displayMode: true,
        }),
      ),
      x11Root,
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
    await x11Root.unmount();
  } finally {
    await app.close();
  }
});

test('<html> repaints when async content arrives (ntk onInvalidate)', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    // an <img> decodes off the render pass, so the first paint has nothing to
    // draw there; HtmlView then fires onInvalidate, which is the only thing
    // that gets the element re-measured and painted again
    const svg =
      'data:image/svg+xml,' +
      encodeURIComponent(
        '<svg viewBox="0 0 4 4"><rect width="4" height="4" fill="#0000ff"/></svg>',
      );
    const wnd = await render(
      React.createElement(
        'window',
        { width: 200, height: 120, style: { backgroundColor: 'white' } },
        React.createElement('html', {
          source: `<div style="margin:0;padding:0"><img width="40" height="40" src="${svg}"></div>`,
        }),
      ),
      x11Root,
    );
    const ctx = wnd.getContext('2d');
    await waitForPixel(ctx, 200, 120, 20, 20, [0, 0, 255], 'html svg img blue');
    await x11Root.unmount();
  } finally {
    await app.close();
  }
});

test('<svg> JSX children render and update declaratively', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ui = (fill) =>
      React.createElement(
        'window',
        { width: 100, height: 100, style: { backgroundColor: 'white' } },
        React.createElement(
          'svg',
          { viewBox: '0 0 10 10', style: { width: 60, height: 60 } },
          React.createElement('rect', {
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            fill,
          }),
        ),
      );

    const wnd = await render(ui('#ff0000'), x11Root);
    const ctx = wnd.getContext('2d');
    await waitForPixel(ctx, 100, 100, 30, 30, [255, 0, 0], 'children rect red');

    // prop update on the SVG child re-renders the drawing
    await render(ui('#00ff00'), x11Root);
    await waitForPixel(
      ctx,
      100,
      100,
      30,
      30,
      [0, 255, 0],
      'children rect green',
    );

    await x11Root.unmount();
  } finally {
    await app.close();
  }
});

test('<markdown> accepts its content as a string child', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const wnd = await render(
      React.createElement(
        'window',
        { width: 300, height: 100, style: { backgroundColor: 'white' } },
        React.createElement('markdown', null, '# From a child string'),
      ),
      x11Root,
    );
    const ctx = wnd.getContext('2d');
    await waitForInk(
      ctx,
      300,
      100,
      { x: 0, y: 0, width: 280, height: 50 },
      isDark,
      20,
      'child-string markdown heading ink',
    );
    await x11Root.unmount();
  } finally {
    await app.close();
  }
});

test('<textarea> edits multi-line text with line-aware caret movement', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const wnd = await render(
      React.createElement(
        'window',
        { width: 220, height: 140, style: { backgroundColor: 'white' } },
        React.createElement('textarea', {
          ref,
          defaultValue: 'hello\nworld',
          style: { flexGrow: 1, backgroundColor: 'white' },
        }),
      ),
      x11Root,
    );
    const ta = ref.current;
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.strictEqual(ta._valueLayout().lines.length, 2, 'two lines');

    // focus by clicking at the end of "world" (line 2)
    const content = ta.contentBox();
    wnd.emit('mousedown', {
      x: content.x + 200,
      y: content.y + 25,
      keycode: 1,
    });
    wnd.emit('mouseup', { x: content.x + 200, y: content.y + 25, keycode: 1 });
    assert.strictEqual(ta._caret, 11, 'click at line end places caret there');

    const press = (keysym, codepoint, extra = {}) => {
      app.X.keycode2keysyms[254] = [keysym];
      wnd.emit('keydown', { keycode: 254, codepoint, buttons: 0, ...extra });
    };

    press(0xff52); // Up -> same column on line 1 -> after "hello"
    assert.strictEqual(ta._caret, 5, 'Up keeps the goal column');
    press(0xff50); // Home -> line start
    assert.strictEqual(ta._caret, 0, 'Home goes to line start');
    press(0xff54); // Down -> line 2 column 0
    assert.strictEqual(ta._caret, 6, 'Down lands at the same column below');
    press(0xff57); // End -> end of "world"
    assert.strictEqual(ta._caret, 11, 'End goes to the visual line end');

    // Enter inserts a newline (unlike <textinput>)
    press(0xff0d, 0x0d);
    press(0x21, 0x21); // '!'
    assert.strictEqual(ta.value, 'hello\nworld\n!');
    assert.strictEqual(ta._valueLayout().lines.length, 3, 'three lines now');

    // word-wrap: a long unbroken-by-newline text wraps at the content width
    const wrapped = app.fonts.layout(
      [
        {
          text: 'aaa bbb ccc ddd eee fff ggg',
          family: 'sans-serif',
          size: 14,
          color: 'black',
        },
      ],
      { family: 'sans-serif', size: 14 },
      { maxWidth: 60 },
    );
    assert.ok(wrapped.lines.length > 1, 'TextLayout wraps at maxWidth');

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

test('window hints reach the X server as real properties', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    // the render callback resolves to the live ntk window (getPublicInstance)
    const wnd = await render(
      React.createElement('window', {
        width: 300,
        height: 200,
        resizable: false,
        wmClass: ['react-x11', 'React-X11'],
        windowType: 'dialog',
      }),
      x11Root,
    );
    await settle(app, 6); // deferred InternAtom -> ChangeProperty chains

    const X = app.X;
    const win = wnd.id;
    assert.ok(win > 0, 'render resolved to a realized ntk window');

    const getProp = (atom, type = 0) =>
      new Promise((resolve, reject) =>
        X.GetProperty(0, win, atom, type, 0, 1024, (err, p) =>
          err ? reject(err) : resolve(p),
        ),
      );
    const intern = (name) =>
      new Promise((resolve, reject) =>
        X.InternAtom(false, name, (err, a) => (err ? reject(err) : resolve(a))),
      );

    // WM_NORMAL_HINTS: resizable={false} pins min and max to the size
    const hints = await getProp(X.atoms.WM_NORMAL_HINTS);
    const w = [];
    for (let i = 0; i + 4 <= hints.data.length; i += 4) {
      w.push(hints.data.readUInt32LE(i));
    }
    assert.strictEqual(w.length, 18, 'XSizeHints is 18 words');
    assert.strictEqual(w[0] & 16, 16, 'PMinSize set');
    assert.strictEqual(w[0] & 32, 32, 'PMaxSize set');
    assert.deepStrictEqual([w[5], w[6]], [300, 200], 'min == created size');
    assert.deepStrictEqual([w[7], w[8]], [300, 200], 'max == created size');

    const cls = await getProp(X.atoms.WM_CLASS);
    assert.strictEqual(cls.data.toString('latin1'), 'react-x11\0React-X11\0');

    const [typeAtom, dialog] = await Promise.all([
      intern('_NET_WM_WINDOW_TYPE'),
      intern('_NET_WM_WINDOW_TYPE_DIALOG'),
    ]);
    const type = await getProp(typeAtom);
    assert.strictEqual(type.data.readUInt32LE(0), dialog);

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});

test('overflow: hidden still clips a child that really does overflow', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    // A clip that clips nothing is skipped, because each one costs a
    // server-side mask rebuild and a table sets `overflow: hidden` on every
    // cell so that *long* text truncates — almost all of which fits. The
    // skipping is only sound if a child that genuinely overflows is still cut,
    // which is what this checks: a 60px-wide child inside a 30px box, on a
    // white page, must leave the pixels past the box white.
    const W = 120;
    const H = 40;
    const wnd = await render(
      React.createElement(
        'window',
        { width: W, height: H, style: { backgroundColor: 'white' } },
        React.createElement(
          'box',
          {
            style: {
              width: 30,
              height: 20,
              marginLeft: 10,
              marginTop: 10,
              overflow: 'hidden',
            },
          },
          React.createElement('box', {
            style: { width: 60, height: 20, backgroundColor: 'black' },
          }),
        ),
      ),
      x11Root,
    );
    const ctx = wnd.getContext('2d');
    const root = wnd._reactX11Node;
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setImmediate(r));
      root._scheduled = false;
      root.flush();
      await new Promise((resolve) => app.X.GetInputFocus(() => resolve()));
    }

    const image = await readPixels(ctx, W, H);
    const dark = (x, y) => {
      const [r, g, b] = px(image, W, x, y);
      return r < 128 && g < 128 && b < 128;
    };
    // inside the 30px box: painted
    assert.ok(dark(20, 20), 'the child paints inside the box');
    assert.ok(dark(38, 20), 'and right up to the box edge');
    // past the box's right edge at x=40: the child wanted to reach x=70
    for (const x of [42, 50, 60, 68]) {
      assert.ok(
        !dark(x, 20),
        `the child must be clipped at the box edge, but x=${x} is painted`,
      );
    }

    await x11Root.unmount();
  } finally {
    await app.close();
  }
});

// `textBoxTrim: 'cap-alphabetic'` makes a <text>'s box the letters — the
// capitals down to the last baseline — so padding around a label is even
// above and below instead of inheriting the font's ascent/descent asymmetry.
//
// The assertion is the ink, not the box: a shorter box would also come from
// simply dropping the descent, and that would leave the text riding high.
// "HEX" is measured because it is all caps with flat tops, no descenders and
// no round letters, so its ink top *is* the cap line and its ink bottom *is*
// the baseline — the two edges the trim is defined against.
test('textBoxTrim: cap-alphabetic centres a label on its capitals', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  const W = 200;
  const H = 120;
  const PAD = 12;

  /** Rows of the pill that contain ink, and the pill's own extent. */
  const inkOf = async (ctx, node) => {
    const image = await readPixels(ctx, W, H);
    const top = Math.round(node.abs.y);
    const bottom = Math.round(node.abs.y + node.abs.height);
    const rows = [];
    for (let y = top; y < bottom; y++) {
      for (
        let x = Math.round(node.abs.x);
        x < Math.round(node.abs.x + node.abs.width);
        x++
      ) {
        if (px(image, W, x, y)[0] < 120) {
          rows.push(y);
          break;
        }
      }
    }
    return { top, bottom, first: rows[0], last: rows[rows.length - 1] + 1 };
  };

  try {
    const pill = (trim) =>
      React.createElement(
        'box',
        {
          style: {
            alignSelf: 'flex-start',
            padding: PAD,
            backgroundColor: '#ffffff',
          },
        },
        React.createElement(
          'text',
          {
            style: {
              fontSize: 24,
              color: '#000000',
              ...(trim ? { textBoxTrim: 'cap-alphabetic' } : {}),
            },
          },
          'HEX',
        ),
      );

    const wnd = await render(
      React.createElement(
        'window',
        { width: W, height: H, style: { backgroundColor: '#ffffff' } },
        pill(false),
        pill(true),
      ),
      x11Root,
    );

    const ctx = wnd.getContext('2d');
    await waitForPixel(ctx, W, H, 2, 2, [255, 255, 255], 'window painted');

    const root = wnd._reactX11Node;
    const pills = root.children.filter((n) => n.kind === 'box');
    assert.strictEqual(pills.length, 2, 'two pills');

    // let the frame land before reading ink
    await new Promise((resolve) => setTimeout(resolve, 120));
    const plain = await inkOf(ctx, pills[0]);
    const trimmed = await inkOf(ctx, pills[1]);

    assert.ok(plain.first != null, 'the untrimmed label drew something');
    assert.ok(trimmed.first != null, 'the trimmed label drew something');

    // the trimmed box is the cap band plus the padding it was given
    assert.ok(
      pills[1].abs.height < pills[0].abs.height,
      `trimming should shorten the pill (${pills[1].abs.height} vs ${pills[0].abs.height})`,
    );
    assert.strictEqual(
      trimmed.last - trimmed.first,
      plain.last - plain.first,
      'the glyphs themselves are untouched — only the box around them moved',
    );

    // the point of the exercise: even space above the caps and below the
    // baseline, to within the pixel grid
    const above = trimmed.first - trimmed.top;
    const below = trimmed.bottom - trimmed.last;
    assert.ok(
      Math.abs(above - below) <= 1,
      `trimmed padding should be even: ${above} above the caps, ${below} below the baseline`,
    );
    assert.ok(
      Math.abs(above - PAD) <= 1,
      `and should be the padding that was asked for: ${above} vs ${PAD}`,
    );

    await x11Root.unmount();
  } finally {
    await app.close();
  }
});
