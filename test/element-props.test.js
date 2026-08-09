// Element props against the style vocabulary. The house rule is that a name
// is either style or an element's own semantics and never both, which is
// what keeps `<window width>` unambiguous — and the DEV assertion that
// enforces it (`assertNoFlatStyleProps`) is the only thing standing between
// a developer and a silently-dropped prop.
//
// Issue #118: three elements read `this.props.width` / `this.props.height` /
// `this.props.color` without claiming those names, so the branch was
// unreachable in development (it threw) and reachable in production (it
// worked) — the same JSX crashing in dev and rendering in prod. The sweep
// below is what would have caught it for free: construct every element with
// every style name flat, and check the outcome against what the element
// says it claims.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import React from 'react';

import { createRoot } from '../src/index.js';
import { HOST_TYPES } from '../src/Reconciler.js';
import {
  BoxNode,
  TextNode,
  TextInputNode,
  TextAreaNode,
  ImageNode,
  CanvasNode,
  WindowNode,
  PopupNode,
} from '../src/nodes.js';
import { MarkdownNode, HtmlNode, SvgNode, TexNode } from '../src/richnodes.js';
import { DefaultTheme } from '../src/palette.js';
import { GlAreaNode } from '../src/glnodes.js';
import { isStyleProp } from '../src/styles.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

// One constructor per host element. Window nodes take (app, attributes,
// props); drawn nodes take (props, app).
const BUILD = {
  window: (app, props) => new WindowNode(app, {}, props),
  popup: (app, props) => new PopupNode(app, {}, props),
  box: (app, props) => new BoxNode(props, app),
  text: (app, props) => new TextNode(props, app, { span: false }),
  textinput: (app, props) => new TextInputNode(props, app),
  textarea: (app, props) => new TextAreaNode(props, app),
  image: (app, props) => new ImageNode(props, app),
  canvas: (app, props) => new CanvasNode(props, app),
  markdown: (app, props) => new MarkdownNode(props, app),
  html: (app, props) => new HtmlNode(props, app),
  svg: (app, props) => new SvgNode(props, app),
  tex: (app, props) => new TexNode(props, app),
  glarea: (app, props) => new GlAreaNode(props, app),
};

// A spread of the style vocabulary: one from each family, plus every name an
// element has actually wanted for itself. Checked against `isStyleProp`
// below, so a name that stops being style fails here rather than quietly
// testing nothing.
const STYLE_NAMES = [
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'aspectRatio',
  'flexGrow',
  'position',
  'top',
  'left',
  'margin',
  'padding',
  'gap',
  'display',
  'overflow',
  'backgroundColor',
  'borderColor',
  'borderRadius',
  'borderWidth',
  'borderStyle',
  'zIndex',
  'color',
  'fontSize',
  'fontFamily',
  'textAlign',
  'lineHeight',
  'cursor',
  'pointerEvents',
  'transition',
];

// A `<popup>` is a WindowNode, so it reports itself as `window` — its
// geometry props are the X window's for the same reason.
const WINDOW_LIKE = new Set(['window', 'popup']);

test('the element list here is the whole element list', () => {
  // HOST_TYPES is what the reconciler's switch and the unknown-element error
  // are both built from, so a new element has to be added to BUILD too —
  // which is what makes the sweep below a net rather than a snapshot of what
  // existed the day it was written.
  assert.deepStrictEqual(
    HOST_TYPES.filter((kind) => !BUILD[kind]),
    [],
    'every host element needs a line in BUILD',
  );
  assert.deepStrictEqual(
    Object.keys(BUILD).filter((kind) => !HOST_TYPES.includes(kind)),
    [],
    'and BUILD has no elements of its own',
  );
});

test('a style name is style on every element that does not claim it', () => {
  const app = createMockApp();
  for (const kind of HOST_TYPES) {
    const build = BUILD[kind];
    const node = build(app, {});
    const semantic = node.semanticNames;
    for (const name of STYLE_NAMES) {
      assert.ok(isStyleProp(name), `${name} is a style property`);
      const attempt = () => build(app, { [name]: 1 });
      if (semantic.has(name)) {
        // claimed: it is this element's own vocabulary and must go through
        assert.doesNotThrow(attempt, `<${kind} ${name}> is semantic`);
      } else {
        assert.throws(
          attempt,
          new RegExp(`<${node.kind} ${name}=…> is a style property`),
          `<${kind} ${name}> should say to pass it in style`,
        );
      }
    }
  }
});

// The declarations are the list of props an element documents, so they are
// the other half of the check: a declared prop that is also a style name has
// to be one the element claims, or writing it throws in development and
// works in production. `<tex color>` was declared, read, and claimed by
// nobody — the exact shape.
function declaredProps() {
  const src = readFileSync(
    new URL('../src/types/elements.d.ts', import.meta.url),
    'utf8',
  );
  const interfaces = new Map();
  for (const m of src.matchAll(
    /export interface (\w+)([^{]*)\{([\s\S]*?)\n\}/g,
  )) {
    interfaces.set(m[1], {
      extends: [...m[2].matchAll(/\b([A-Z]\w*Props)\b/g)].map((x) => x[1]),
      own: [
        ...m[3].matchAll(/^ {2}(?:readonly )?([A-Za-z_]\w*)\??\s*[:(]/gm),
      ].map((x) => x[1]),
    });
  }
  const all = (name, seen = new Set()) => {
    if (seen.has(name) || !interfaces.has(name)) return [];
    seen.add(name);
    const face = interfaces.get(name);
    return face.own.concat(...face.extends.map((p) => all(p, seen)));
  };
  const byKind = new Map();
  const map = src.match(
    /export interface ReactX11Elements \{([\s\S]*?)\n\}/,
  )[1];
  for (const m of map.matchAll(/^ {2}([a-zA-Z]\w*): (\w+);/gm)) {
    byKind.set(m[1], all(m[2]));
  }
  return byKind;
}

test('a declared prop that is also a style name is one the element claims', () => {
  const app = createMockApp();
  const declared = declaredProps();
  assert.ok(
    declared.get('window')?.includes('width'),
    'the declarations parsed at all',
  );
  for (const kind of HOST_TYPES) {
    const semantic = BUILD[kind](app, {}).semanticNames;
    const unclaimed = (declared.get(kind) ?? [])
      .filter(isStyleProp)
      .filter((name) => !semantic.has(name));
    assert.deepStrictEqual(
      unclaimed,
      [],
      `<${kind}> declares ${unclaimed.join(', ')}, which JSX cannot pass flat`,
    );
  }
});

test('only the window elements claim style names as their own props', () => {
  // Issue #118 had two possible resolutions, and this pins the one taken:
  // `<image>`, `<svg>` and `<tex>` are sized and coloured by style like
  // everything else, rather than growing `semanticNames` of their own. A
  // window is the exception because its `width` is the X window's, which
  // yoga has no say in.
  const app = createMockApp();
  for (const kind of HOST_TYPES) {
    const claimed = [...BUILD[kind](app, {}).semanticNames].filter(isStyleProp);
    if (WINDOW_LIKE.has(kind)) {
      assert.deepStrictEqual(
        claimed.sort(),
        ['height', 'maxHeight', 'maxWidth', 'minHeight', 'minWidth', 'width'],
        `<${kind}> owns its geometry and the hints that constrain it`,
      );
    } else {
      assert.deepStrictEqual(claimed, [], `<${kind}> claims no style name`);
    }
  }
});

// --- what the style now drives ---------------------------------------------
//
// Sizing used to be read off props, so with the props unreachable the
// aspect-ratio behaviour documented for `<image>` never ran at all. It runs
// off the measure modes now, which is yoga answering the same question.

const laidOut = async (element) => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(h('window', { width: 200, height: 200 }, element));
  await tick();
  return app.windows[0]._reactX11Node.children[0];
};

// The decode is async and wants a real file; the natural size is all the
// measure function reads, so hand it over the way `_load` does.
const decoded = async (node, image) => {
  node.image = image;
  node.yoga.markDirty();
  node.root.invalidate(true, null, 'content');
  await tick();
  return node;
};

test('<image> takes its aspect ratio from a style height', async () => {
  const node = await laidOut(
    h('image', { style: { height: 20, alignSelf: 'flex-start' } }),
  );
  await decoded(node, { width: 200, height: 50 });
  assert.deepStrictEqual(
    [node.abs.width, node.abs.height],
    [80, 20],
    'a 4:1 image 20 tall is 80 wide, not stretched to the window',
  );
});

test('<image> shrinks to the width on offer, keeping its ratio', async () => {
  const node = await laidOut(
    h('image', { style: { alignSelf: 'flex-start' } }),
  );
  await decoded(node, { width: 400, height: 100 });
  assert.deepStrictEqual(
    [node.abs.width, node.abs.height],
    [200, 50],
    'a 400x100 image in a 200-wide window is 200x50',
  );
});

test('<svg> is sized like <image>, off the same style names', async () => {
  const source =
    '<svg viewBox="0 0 40 10"><rect width="40" height="10"/></svg>';
  const natural = await laidOut(
    h('svg', { source, style: { alignSelf: 'flex-start' } }),
  );
  assert.deepStrictEqual(
    [natural.abs.width, natural.abs.height],
    [40, 10],
    'the viewBox is the natural size',
  );

  const byHeight = await laidOut(
    h('svg', { source, style: { height: 20, alignSelf: 'flex-start' } }),
  );
  assert.deepStrictEqual(
    [byHeight.abs.width, byHeight.abs.height],
    [80, 20],
    'a style height scales the width with it',
  );

  const both = await laidOut(
    h('svg', { source, style: { width: 30, height: 30 } }),
  );
  assert.deepStrictEqual(
    [both.abs.width, both.abs.height],
    [30, 30],
    'both set wins outright — the drawing scales into the box',
  );
});

test('<svg> content still reflows when both dimensions are fixed', async () => {
  // The measure function used to be unset in this case, which made
  // `markDirty()` illegal and cost the node its own bookkeeping flag.
  const node = await laidOut(
    h('svg', {
      source: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
      style: { width: 24, height: 24 },
    }),
  );
  assert.doesNotThrow(() => node._textContentChanged());
  node.root._scheduled = false;
  node.root.flush();
  assert.deepStrictEqual([node.abs.width, node.abs.height], [24, 24]);
});

test('<tex> takes its ink colour from the style', () => {
  const app = createMockApp();
  const node = new TexNode({ source: 'x^2', size: 12 }, app);
  node._syncStyle({ source: 'x^2', style: { color: '#ff0000' } });
  node._ensureBox();
  assert.match(node._boxKey, /#ff0000/, 'the layout is keyed on the style');
  // Without one it is the palette's text colour, not a fixed shade: the
  // palette follows the desktop, and a hardcoded `#222222` is invisible on a
  // dark one. `createMockApp()` pins the light palette.
  const plain = new TexNode({ source: 'x^2', size: 12 }, app);
  plain._ensureBox();
  assert.match(
    plain._boxKey,
    new RegExp(DefaultTheme.text.replace('#', '\\#')),
    'and defaults to the palette without one',
  );
});
