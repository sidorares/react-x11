// `<image src={{ symbol }}>` (#591): the platform's own icons by name, drawn
// in the text colour inside a window — SF Symbols on the Cocoa backend, the
// freedesktop icon theme everywhere else.
//
// Four parts. The theme lookup is the Icon Theme Specification's, over an
// in-memory filesystem, since what it decides is which file among many. The
// pixels are the in-process X server's, over the small theme in
// test/fixtures/icons: a symbolic square to tint, a coloured icon to leave
// alone, a name that is both, and a parent theme to inherit from. The Cocoa
// half is what reaches the fake bridge, since CoreText draws it. And the
// source's own shape is checked where it is written.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import React from 'react';

import { IconTheme, parseIndexTheme } from '../src/icontheme.js';
import { imageSourceChanged, validateImageProps } from '../src/imagesource.js';
import { iconSizeFor, setIconThemeForTests } from '../src/symbols.js';
import { setXSettingsForTests } from '../src/xsettings.js';
import { cleanup, pixelAt, renderX11 } from '../src/testing/index.js';
import { CocoaSymbols } from '../src/cocoa/symbols.js';
import { loadNative } from '../src/cocoa/native.js';
import { cleanupCocoa, mountCocoa } from './helpers/cocoa-bridge.js';

const h = React.createElement;
const ICONS = new URL('./fixtures/icons', import.meta.url).pathname;

afterEach(async () => {
  await cleanup();
  await cleanupCocoa();
});

// --- the lookup ---------------------------------------------------------------

/** A filesystem of `{ path: contents }`, for `IconTheme`'s two calls. */
function memoryFs(files) {
  const dirs = new Map();
  for (const path of Object.keys(files)) {
    const cut = path.lastIndexOf('/');
    const dir = path.slice(0, cut);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(path.slice(cut + 1));
  }
  const missing = (path) =>
    Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    readdirSync(dir) {
      if (!dirs.has(dir)) throw missing(dir);
      return dirs.get(dir);
    },
    readFileSync(path) {
      if (!(path in files)) throw missing(path);
      return files[path];
    },
  };
}

/** An `index.theme` naming `dirs` — `{ name: { Size, Type, … } }` — and
 *  what it inherits. */
function index(dirs, inherits = '') {
  const lines = [
    '[Icon Theme]',
    `Directories=${Object.keys(dirs).join(',')}`,
    ...(inherits ? [`Inherits=${inherits}`] : []),
  ];
  for (const [name, keys] of Object.entries(dirs)) {
    lines.push('', `[${name}]`);
    for (const [key, value] of Object.entries(keys)) {
      lines.push(`${key}=${value}`);
    }
  }
  return lines.join('\n');
}

const theme = (files, options = {}) =>
  new IconTheme({
    theme: 'T',
    baseDirs: ['/a', '/b'],
    pixmapDirs: ['/pixmaps'],
    fs: memoryFs(files),
    ...options,
  });

describe('the icon theme lookup', () => {
  test('index.theme is sections of keys, comments aside', () => {
    const sections = parseIndexTheme(
      '# a comment\n[Icon Theme]\nName=T\nDirectories=16x16/a, 32x32/a\n\n[16x16/a]\nSize = 16\n',
    );
    assert.equal(
      sections.get('Icon Theme').get('Directories'),
      '16x16/a, 32x32/a',
    );
    assert.equal(sections.get('16x16/a').get('Size'), '16');
  });

  test('a directory of the size asked for, among fixed ones', () => {
    const t = theme({
      '/a/T/index.theme': index({
        '16x16/a': { Size: 16, Type: 'Fixed' },
        '32x32/a': { Size: 32, Type: 'Fixed' },
      }),
      '/a/T/16x16/a/go.png': '',
      '/a/T/32x32/a/go.png': '',
    });
    assert.equal(t.find('go', 32), '/a/T/32x32/a/go.png');
    assert.equal(t.find('go', 16), '/a/T/16x16/a/go.png');
  });

  test('a threshold directory takes sizes near its own, a scalable one a range', () => {
    const t = theme({
      '/a/T/index.theme': index({
        // closer to 24, but fixed: a directory that matches comes first
        '25x25/a': { Size: 25, Type: 'Fixed' },
        '22x22/a': { Size: 22 },
        'scalable/a': { Size: 16, MinSize: 64, MaxSize: 512, Type: 'Scalable' },
      }),
      '/a/T/25x25/a/go.png': '',
      '/a/T/22x22/a/go.png': '',
      '/a/T/scalable/a/go.svg': '',
    });
    assert.equal(t.find('go', 24), '/a/T/22x22/a/go.png', '22 ± the default 2');
    assert.equal(t.find('go', 300), '/a/T/scalable/a/go.svg');
  });

  test('with no directory of the size, the closest one', () => {
    const t = theme({
      '/a/T/index.theme': index({
        '16x16/a': { Size: 16, Type: 'Fixed' },
        '48x48/a': { Size: 48, Type: 'Fixed' },
      }),
      '/a/T/16x16/a/go.png': '',
      '/a/T/48x48/a/go.png': '',
    });
    assert.equal(t.find('go', 40), '/a/T/48x48/a/go.png');
    assert.equal(t.find('go', 20), '/a/T/16x16/a/go.png');
  });

  test('the display scale picks the directory drawn for it', () => {
    const t = theme({
      '/a/T/index.theme': index({
        '16x16/a': { Size: 16, Type: 'Fixed' },
        '16x16@2/a': { Size: 16, Scale: 2, Type: 'Fixed' },
      }),
      '/a/T/16x16/a/go.png': '',
      '/a/T/16x16@2/a/go.png': '',
    });
    assert.equal(t.find('go', 16, 2), '/a/T/16x16@2/a/go.png');
    assert.equal(t.find('go', 16, 1), '/a/T/16x16/a/go.png');
  });

  test('PNG before SVG in one directory, and the first base directory first', () => {
    const t = theme({
      '/a/T/index.theme': index({
        'scalable/a': { Size: 16, MinSize: 1, MaxSize: 512, Type: 'Scalable' },
      }),
      '/a/T/scalable/a/go.svg': '',
      '/a/T/scalable/a/go.png': '',
      '/b/T/scalable/a/stop.svg': '',
      '/a/T/scalable/a/stop.svg': '',
    });
    assert.equal(t.find('go', 16), '/a/T/scalable/a/go.png');
    assert.equal(t.find('stop', 16), '/a/T/scalable/a/stop.svg');

    // …for the closest directory too, when none is the size asked for
    const far = theme({
      '/a/T/index.theme': index({ '48x48/a': { Size: 48, Type: 'Fixed' } }),
      '/a/T/48x48/a/go.png': '',
      '/b/T/48x48/a/go.png': '',
    });
    assert.equal(far.find('go', 16), '/a/T/48x48/a/go.png');
  });

  test('then what the theme inherits, then hicolor, then the loose pixmaps', () => {
    const scalable = {
      'scalable/a': { Size: 16, MinSize: 1, MaxSize: 512, Type: 'Scalable' },
    };
    const t = theme({
      '/a/T/index.theme': index(scalable, 'P'),
      '/b/P/index.theme': index(scalable, 'T'), // a cycle, which must end
      '/a/hicolor/index.theme': index(scalable),
      '/a/T/scalable/a/own.svg': '',
      '/b/P/scalable/a/own.svg': '',
      '/b/P/scalable/a/parent.svg': '',
      '/a/hicolor/scalable/a/app.png': '',
      '/pixmaps/loose.png': '',
    });
    assert.equal(t.find('own', 16), '/a/T/scalable/a/own.svg', 'its own first');
    assert.equal(t.find('parent', 16), '/b/P/scalable/a/parent.svg');
    assert.equal(t.find('app', 16), '/a/hicolor/scalable/a/app.png');
    assert.equal(t.find('loose', 16), '/pixmaps/loose.png');
    assert.equal(t.find('nowhere', 16), null);
  });

  test('a theme that is not installed falls back on hicolor', () => {
    const t = theme(
      {
        '/a/hicolor/index.theme': index({ '16x16/a': { Size: 16 } }),
        '/a/hicolor/16x16/a/go.png': '',
      },
      { theme: 'Missing' },
    );
    assert.equal(t.find('go', 16), '/a/hicolor/16x16/a/go.png');
  });

  test('a theme is asked for 16 beside 14px text, in proportion from there', () => {
    assert.deepEqual([12, 14, 21, 28].map(iconSizeFor), [14, 16, 24, 32]);
  });
});

// --- the pixels, from a theme -------------------------------------------------

const RED = [255, 0, 0];
const WHITE = [255, 255, 255];

/** Symbols in a row at `fontSize` 14 in red on white, from the fixture theme. */
async function row(images, { fontSize = 14, color = '#ff0000' } = {}) {
  const refs = images.map(() => React.createRef());
  const tree = (style = {}) =>
    h(
      'box',
      {
        style: {
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: 4,
          padding: 4,
          backgroundColor: '#ffffff',
          color,
          fontSize,
          ...style,
        },
      },
      ...images.map((props, i) => h('image', { ref: refs[i], ...props })),
    );
  const api = await renderX11(h('box', null), { width: 240, height: 80 });
  setIconThemeForTests(api.windowNode.app, {
    theme: 'Test',
    baseDirs: [ICONS],
    pixmapDirs: [],
  });
  await api.rerender(tree());
  const at = (i, dx, dy) =>
    pixelAt(api.ctx, refs[i].current.abs.x + dx, refs[i].current.abs.y + dy);
  return { api, refs, at, tree };
}

describe('a symbol from the icon theme', () => {
  test('a symbolic icon is drawn in the text colour, and follows it', async () => {
    const { api, refs, at, tree } = await row([{ src: { symbol: 'square' } }]);
    const node = refs[0].current;
    assert.deepEqual([node.abs.width, node.abs.height], [16, 16]);
    assert.deepEqual(await at(0, 8, 8), RED);
    await api.rerender(tree({ color: '#0000ff' }));
    assert.deepEqual(
      await at(0, 8, 8),
      [0, 0, 255],
      'a new colour, a new tint',
    );
  });

  test('an icon drawn in its own colours is shown as it is', async () => {
    const { at } = await row([{ src: { symbol: 'green' } }]);
    assert.deepEqual(await at(0, 8, 8), [0, 160, 0]);
  });

  test('the symbolic variant is preferred where a name has both', async () => {
    const { at } = await row([{ src: { symbol: 'both' } }]);
    assert.deepEqual(await at(0, 8, 8), RED, 'the red tint, not the blue PNG');
  });

  test('a name the theme inherits is found in its parent', async () => {
    const { at } = await row([{ src: { symbol: 'half' } }]);
    assert.deepEqual(await at(0, 4, 8), RED);
    assert.deepEqual(await at(0, 12, 8), WHITE);
  });

  test('it is the size of the text beside it, and fits a box of its own', async () => {
    const big = await row([{ src: { symbol: 'square' } }], { fontSize: 28 });
    assert.equal(big.refs[0].current.abs.width, 32);
    await cleanup();
    const boxed = await row([
      { src: { symbol: 'square' }, style: { width: 40, height: 20 } },
    ]);
    // a 20px square, centred in the 40 × 20 box
    assert.deepEqual(await boxed.at(0, 5, 10), WHITE);
    assert.deepEqual(await boxed.at(0, 15, 10), RED);
    assert.deepEqual(await boxed.at(0, 35, 10), WHITE);
  });

  test('a name the theme does not have takes no room, and says so once', async (t) => {
    const warnings = [];
    t.mock.method(console, 'warn', (message) => warnings.push(message));
    const { refs } = await row([
      { src: { symbol: 'no-such-icon' } },
      { src: { symbol: 'square' } },
    ]);
    assert.equal(refs[0].current.abs.width, 0);
    assert.equal(refs[1].current.abs.x, 4 + 4, 'the next one takes its place');
    assert.equal(
      warnings.filter((w) => w.includes('"no-such-icon"')).length,
      1,
      warnings.join('\n'),
    );
  });

  test('a new name is measured again', async () => {
    const ref = React.createRef();
    const scene = (symbol) =>
      h(
        'box',
        { style: { alignItems: 'flex-start', color: '#ff0000', fontSize: 14 } },
        h('image', { ref, src: { symbol } }),
      );
    const api = await renderX11(h('box', null), { width: 60, height: 40 });
    setIconThemeForTests(api.windowNode.app, {
      theme: 'Test',
      baseDirs: [ICONS],
      pixmapDirs: [],
    });
    await api.rerender(scene('no-such-icon'));
    const node = ref.current;
    assert.equal(node.abs.width, 0);
    await api.rerender(scene('square'));
    assert.ok(ref.current === node, 'the same element, given a new name');
    assert.equal(node.abs.width, 16);
  });

  test("the theme is the settings daemon's, when nothing says otherwise", async () => {
    const dataDirs = process.env.XDG_DATA_DIRS;
    const dataHome = process.env.XDG_DATA_HOME;
    // test/fixtures holds `icons/Test`, as a data directory holds `icons/…`
    process.env.XDG_DATA_DIRS = new URL('./fixtures', import.meta.url).pathname;
    process.env.XDG_DATA_HOME = '/nonexistent';
    try {
      const ref = React.createRef();
      const api = await renderX11(h('box', null), { width: 60, height: 40 });
      const app = api.windowNode.app;
      setXSettingsForTests(app, new Map([['Net/IconThemeName', 'Test']]));
      setIconThemeForTests(app, null); // back to the default provider
      await api.rerender(
        h(
          'box',
          {
            style: { color: '#ff0000', fontSize: 14, alignItems: 'flex-start' },
          },
          h('image', { ref, src: { symbol: 'square' } }),
        ),
      );
      assert.equal(ref.current.abs.width, 16);
    } finally {
      if (dataDirs === undefined) delete process.env.XDG_DATA_DIRS;
      else process.env.XDG_DATA_DIRS = dataDirs;
      if (dataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = dataHome;
    }
  });
});

// --- SF Symbols on the Cocoa backend -------------------------------------------

describe('an SF Symbol on the Cocoa backend', () => {
  const scene = (src, style = {}) =>
    h(
      'box',
      {
        style: {
          alignItems: 'flex-start',
          color: '#ff0000',
          fontSize: 20,
          fontWeight: 'bold',
          ...style,
        },
      },
      h('image', { src }),
    );
  const imageOf = (node) => node.children[0].children[0];

  test('asked at the size and weight of the text, and drawn in its colour', async () => {
    const m = await mountCocoa(scene({ symbol: 'star.fill' }));
    const [name, options] = m.native.of('symbolSize').at(-1);
    assert.equal(name, 'star.fill');
    assert.deepEqual(options, { pointSize: 20, weight: 700 });
    const image = imageOf(m.node);
    // 1.25 × 20 across and 20 down in the fake, in points; device at scale 2
    assert.deepEqual([image.abs.width, image.abs.height], [50, 40]);

    const calls = m.native.calls.map((c) => c.name);
    const drawn = calls.lastIndexOf('ctxDrawSymbol');
    assert.ok(drawn > 0, 'drawn');
    const fill = m.native.calls
      .slice(0, drawn)
      .findLast((c) => c.name === 'ctxSetFillColor');
    assert.deepEqual(fill.args.slice(1), [1, 0, 0, 1], 'in the text colour');
    const args = m.native.calls[drawn].args;
    assert.deepEqual(
      args.slice(1, 6),
      ['star.fill', image.abs.x, image.abs.y, 50, 40],
      'into its box',
    );
  });

  test("the source's own weight, scale and value win", async () => {
    const m = await mountCocoa(
      scene({
        symbol: 'speaker.wave.3.fill',
        weight: 300,
        scale: 'large',
        variableValue: 0.5,
      }),
    );
    assert.deepEqual(m.native.of('symbolSize').at(-1)[1], {
      pointSize: 20,
      weight: 300,
      scale: 'large',
      variableValue: 0.5,
    });
  });

  test('a name the catalogue does not know takes no room', async () => {
    const m = await mountCocoa(scene({ symbol: 'no.such.symbol' }));
    assert.equal(imageOf(m.node).abs.width, 0);
  });
});

let bridge = null;
try {
  bridge = loadNative();
} catch {
  bridge = null;
}

describe(
  'SF Symbols over the real bridge',
  {
    skip: bridge ? false : 'the @windowkit/appkit bridge is not loadable here',
  },
  () => {
    test('a symbol has a size at a point size, and an unknown name has none', () => {
      const symbols = new CocoaSymbols(bridge);
      const small = symbols.size('star.fill', { pointSize: 13, weight: 400 });
      const large = symbols.size('star.fill', { pointSize: 26, weight: 400 });
      assert.ok(small?.width > 0 && small.height > 0, JSON.stringify(small));
      assert.ok(large.height > small.height * 1.8, 'in proportion');
      assert.equal(
        symbols.size('no.such.symbol', { pointSize: 13, weight: 400 }),
        null,
      );
    });
  },
);

// --- the source ---------------------------------------------------------------

test('a symbol source says what is wrong with it', () => {
  const bad = [
    [{ src: { symbol: '' } }, /needs a name/],
    [{ src: { symbol: 7 } }, /needs a name/],
    [{ src: { symbol: 'star', weight: 'heavy' } }, /weight "heavy"/],
    [{ src: { symbol: 'star', scale: 'huge' } }, /scale "huge"/],
    [{ src: { symbol: 'star', variableValue: 2 } }, /variableValue 2/],
    [{ src: { symbol: 'star' }, cacheKey: 'k' }, /nothing to cache/],
  ];
  for (const [props, message] of bad) {
    assert.throws(() => validateImageProps(props), message);
  }
  validateImageProps({
    src: { symbol: 'star', weight: 600, scale: 'small', variableValue: 0 },
  });
});

test('an equal symbol literal is not a new source', () => {
  const was = { src: { symbol: 'star', weight: 600 } };
  assert.equal(
    imageSourceChanged({ src: { symbol: 'star', weight: 600 } }, was),
    false,
  );
  assert.equal(
    imageSourceChanged({ src: { symbol: 'star', weight: 700 } }, was),
    true,
  );
  assert.equal(imageSourceChanged({ src: './star.png' }, was), true);
});
