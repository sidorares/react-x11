// The two accessors a drawing element reads: `contentBox()` and
// `resolvedTextStyle()` (#254).
//
// Both were internal, and both were therefore re-derived by hand outside
// this package — the padding out of `this.style` with a `parseFloat` and a
// hope, the font out of `this.style.fontFamily` with the palette missing
// from under it. Neither hand-rolled version can be right: the insets are
// resolved by yoga against this frame's size (percentages, per-side
// overrides, the border), and the text style is the *cascade's* answer, not
// the style bag's.
//
// So the tests come in two halves. The headless ones pin what the accessors
// answer, including the cases the hand-rolled arithmetic gets wrong. The
// pixel one is the acceptance criterion in the issue: a registered element
// that draws with them is, pixel for pixel, a `<text>` sibling.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';

import { registerElement, unregisterElement } from '../src/host.js';
import { Node } from '../src/node.js';
import { renderX11, cleanup } from '../src/testing/index.js';

const h = React.createElement;

const require = createRequire(import.meta.url);
const FONTS = {
  // The only face in this server. The theme below names it explicitly, so
  // an element that failed to inherit would fall back to `sans-serif` — and
  // to 14 pixels of it, which is what the pixels are asked about.
  'Test Main': join(
    dirname(require.resolve('katex/package.json')),
    'dist',
    'fonts',
    'KaTeX_Main-Regular.ttf',
  ),
};

/**
 * A third-party element that draws a line of text, written the way the docs
 * say to: nothing in it names `this.yoga`, an underscore, or a font
 * property of its own.
 */
class BadgeNode extends Node {
  constructor(props, app) {
    super('badge', props, app);
    this.painted = null;
  }

  paint(ctx) {
    super.paint(ctx); // background, border, clip
    const fonts = this.app?.fonts;
    if (!fonts) return; // headless: no font manager to shape with
    const box = this.contentBox();
    const style = this.resolvedTextStyle();
    this.painted = { box, style };
    const layout = fonts.layout(String(this.props.label ?? ''), style, {
      maxWidth: box.width || undefined,
    });
    // `<text>` centres the line box in the same rectangle. Matching that is
    // what makes the two renders comparable pixel for pixel; the styling
    // and the box are what the test is actually about.
    const last = layout.lines?.[layout.lines.length - 1];
    const halfLeading = last
      ? Math.max(0, (layout.height - (last.baseline + last.descent)) / 2)
      : 0;
    layout.draw(ctx, box.x, box.y + halfLeading);
  }
}

const registered = new Set();
function register(type, definition) {
  registerElement(type, definition);
  registered.add(type);
}

afterEach(async () => {
  await cleanup();
  for (const type of registered) unregisterElement(type);
  registered.clear();
});

const badge = (props) => h('badge', { label: 'Handgloves', ...props });

const found = (node, kind) =>
  node.kind === kind
    ? node
    : (node.children.map((c) => found(c, kind)).find(Boolean) ?? null);

/** Mount into the mock connection: layout, no server, no fonts. */
const mount = (windowProps, ...children) =>
  renderX11(h('window', { title: 'accessors', ...windowProps }, ...children), {
    backend: 'mock',
  });

// --- contentBox --------------------------------------------------------------

test('the content box is the border box inset by border and padding', async () => {
  register('badge', { create: (p, a) => new BadgeNode(p, a) });
  const { windowNode } = await mount(
    { width: 300, height: 100 },
    badge({ style: { width: 200, height: 60, padding: 8, borderWidth: 2 } }),
  );
  const node = found(windowNode, 'badge');
  assert.deepStrictEqual(node.contentBox(), {
    x: node.abs.x + 10,
    y: node.abs.y + 10,
    width: 200 - 20,
    height: 60 - 20,
  });
});

test('per-side padding and per-side borders inset their own side', async () => {
  register('badge', { create: (p, a) => new BadgeNode(p, a) });
  const { windowNode } = await mount(
    { width: 300, height: 100 },
    badge({
      style: {
        width: 200,
        height: 60,
        padding: 4,
        paddingLeft: 20,
        borderWidth: 1,
        borderBottomWidth: 5,
      },
    }),
  );
  const node = found(windowNode, 'badge');
  const box = node.contentBox();
  assert.deepStrictEqual(
    [box.x - node.abs.x, box.y - node.abs.y, box.width, box.height],
    [21, 5, 200 - 21 - 5, 60 - 5 - 9],
    'left is its own padding plus its own border; the bottom border is 5',
  );
});

// The case that makes this an accessor rather than a snippet to copy: there
// is no number in the style bag to read here. The percentage is resolved by
// layout, against the containing block, at the size this frame came out at.
test('percentage padding is resolved, not parsed', async () => {
  register('badge', { create: (p, a) => new BadgeNode(p, a) });
  const { windowNode } = await mount(
    { width: 300, height: 100 },
    badge({ style: { width: 200, height: 60, padding: '10%' } }),
  );
  const node = found(windowNode, 'badge');
  const box = node.contentBox();
  const inset = box.x - node.abs.x;
  assert.ok(inset > 0, `a percentage resolved to ${inset}`);
  assert.deepStrictEqual(
    [box.width, box.height],
    [200 - inset * 2, 60 - inset * 2],
    'and the same inset came off all four edges',
  );
});

test('a node with nothing to inset by has its own box', async () => {
  register('badge', { create: (p, a) => new BadgeNode(p, a) });
  const { windowNode } = await mount(
    { width: 300, height: 100 },
    badge({ style: { width: 200, height: 60 } }),
  );
  const node = found(windowNode, 'badge');
  assert.deepStrictEqual(node.contentBox(), { ...node.abs });
});

// --- resolvedTextStyle -------------------------------------------------------

test('the palette is under it, exactly as it is under <text>', async () => {
  register('badge', { create: (p, a) => new BadgeNode(p, a) });
  const { windowNode } = await mount(
    {
      width: 300,
      height: 100,
      theme: { fontFamily: 'Inter', fontSize: 22, text: '#c0392b' },
    },
    badge(),
    h('text', null, 'Handgloves'),
  );
  const node = found(windowNode, 'badge');
  const text = found(windowNode, 'text');
  assert.deepStrictEqual(node.resolvedTextStyle(), text.resolvedTextStyle());
  assert.deepStrictEqual(node.resolvedTextStyle(), {
    family: 'Inter',
    size: 22,
    weight: 'normal',
    style: 'normal',
    variations: undefined,
    textRendering: undefined,
    color: '#c0392b',
  });
});

test("the element's own style wins over what it inherits", async () => {
  register('badge', { create: (p, a) => new BadgeNode(p, a) });
  const { windowNode } = await mount(
    { width: 300, height: 100, theme: { fontFamily: 'Inter', fontSize: 22 } },
    badge({
      style: {
        fontSize: 30,
        fontWeight: 'bold',
        fontStyle: 'italic',
        color: '#123456',
        fontVariationSettings: { wght: 460 },
      },
    }),
  );
  const style = found(windowNode, 'badge').resolvedTextStyle();
  assert.deepStrictEqual(style, {
    family: 'Inter', // nothing said otherwise: still the palette's
    size: 30,
    weight: 'bold',
    style: 'italic',
    variations: { wght: 460 },
    textRendering: undefined,
    color: '#123456',
  });
});

test('a `$token` reaches it, since it is the resolved style it reads', async () => {
  register('badge', { create: (p, a) => new BadgeNode(p, a) });
  const { windowNode } = await mount(
    { width: 300, height: 100, theme: { monoFamily: 'Fira Code' } },
    badge({ style: { fontFamily: '$monoFamily' } }),
  );
  assert.equal(
    found(windowNode, 'badge').resolvedTextStyle().family,
    'Fira Code',
  );
});

test('a theme swap moves it, without the element hearing about it', async () => {
  register('badge', { create: (p, a) => new BadgeNode(p, a) });
  const tree = (theme) =>
    h(
      'window',
      { title: 'accessors', width: 300, height: 100, theme },
      badge(),
    );
  const { windowNode, rerender } = await renderX11(tree({ fontSize: 22 }), {
    backend: 'mock',
  });
  assert.equal(found(windowNode, 'badge').resolvedTextStyle().size, 22);
  await rerender(tree({ fontSize: 40 }));
  assert.equal(found(windowNode, 'badge').resolvedTextStyle().size, 40);
});

// --- the acceptance criterion ------------------------------------------------

const readPixels = (ctx, width, height) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, width, height, (err, image) =>
      err ? reject(err) : resolve(image),
    ),
  );

/** Pixels that differ between two reads of the same window, and the ink in
 *  the first — a blank frame must not pass as a match. */
const compare = (a, b) => {
  let differing = 0;
  let ink = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2]
    ) {
      differing++;
    }
    if (a.data[i] < 200 || a.data[i + 1] < 200 || a.data[i + 2] < 200) ink++;
  }
  return { differing, ink };
};

// The issue in one test: an element that inherits its face, its size and
// its ink from an ancestor draws what a `<text>` in its place would.
test('a registered element renders identically to a <text> sibling', async () => {
  register('badge', {
    create: (p, a) => new BadgeNode(p, a),
    semanticNames: ['label'],
  });
  const W = 300;
  const H = 80;
  const style = { width: W, height: H, padding: 12, borderWidth: 3 };
  const window = (child) =>
    h(
      'window',
      {
        title: 'accessors',
        width: W,
        height: H,
        theme: { fontFamily: 'Test Main', fontSize: 28, text: '#c0392b' },
        style: { backgroundColor: '#ffffff' },
      },
      child,
    );

  const { ctx, rerender } = await renderX11(window(badge({ style })), {
    fonts: FONTS,
    wrap: false,
    width: W,
    height: H,
  });
  const drawn = await readPixels(ctx, W, H);

  await rerender(window(h('text', { style }, 'Handgloves')));
  const reference = await readPixels(ctx, W, H);

  const { differing, ink } = compare(drawn, reference);
  assert.ok(ink > 200, `the badge drew something: ${ink} inked pixels`);
  assert.equal(
    differing,
    0,
    `${differing} pixels differ from the <text> that replaced it`,
  );
});
