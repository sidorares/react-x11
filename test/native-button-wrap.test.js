// A native `<Button>` whose label wraps.
//
// A row too narrow for its buttons squeezes each one to its longest word, as
// it would squeeze a drawn button, and the label breaks onto a second line.
// The native button used to be AppKit's height whatever its label did, with
// the title placed on the bezel body's bottom edge: the second line went up,
// *above* the bezel, and read as a label floating over the control it names
// (the flow-stress toolbar in @react-x11/components, on a window narrower
// than its dozen buttons).
//
// So the control is as tall as its label needs and never less than AppKit's
// height, and the bezel store draws the taller box with the bezel AppKit has
// for it (src/cocoa/bezels.js, the flexible push — pinned in
// test/cocoa-bezel-flexible.test.js). What is pinned here is the layout the
// renderer computes, against a real font: the bezel is Cocoa's, and this
// store answers for it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import React from 'react';

import { createClient, StaticFontSource } from 'ntk';
import xserver from 'x11/lib/xserver/index.js';

import { Button, createRoot } from '../src/index.js';
import { TITLE_BASELINE } from '../src/components/native.js';

const require = createRequire(import.meta.url);
const FONT = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
  'KaTeX_Main-Regular.ttf',
);

const h = React.createElement;

/** AppKit's push metrics at both sizes, shadow rows asymmetric on purpose. */
const NATURAL = { regular: 22, small: 18 };
const SHADOW = Object.freeze({ top: 1, bottom: 2 });

/**
 * A server with a real font, and a bezel store on the app — so the widgets
 * take the native path and text measures as it will on screen. The store
 * remembers every size a bezel was asked for, and draws nothing.
 */
async function mount(element) {
  const server = xserver.createServer({ width: 900, height: 600 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(FONT), { family: 'Test Main' });
  fontSource.alias('sans-serif', 'Test Main');
  const app = await createClient({ stream: clientEnd, fontSource });
  const asked = [];
  app.nativeBezels = {
    natural: (kind, size = 'regular') => ({
      width: 60,
      height: NATURAL[size],
    }),
    shadow: () => ({ ...SHADOW }),
    get: (params, w, height, scale) => {
      asked.push({ params, w, height, scale });
      return null;
    },
  };
  const root = await createRoot({ app });
  const instance = await new Promise((resolve) =>
    root.render(element, resolve),
  );
  const tree = instance._reactX11Node;
  // the frame the scheduler would run, laid out and painted now
  tree._scheduled = false;
  tree.flush();
  await new Promise((resolve) => app.X.GetInputFocus(() => resolve()));
  return {
    tree,
    asked,
    unmount: async () => {
      await root.unmount();
      app.close?.();
    },
  };
}

function nodes(tree) {
  const out = [];
  const walk = (n) => {
    out.push(n);
    for (const c of n.children) if (!c.isWindow) walk(c);
  };
  walk(tree);
  return out;
}

/** Every native button, as the parts the assertions are about. */
function buttons(tree) {
  return nodes(tree)
    .filter((n) => n.props?.role === 'button')
    .map((control) => {
      const title = control.children.find((c) => c.kind === 'text');
      return {
        control,
        footprint: control.parent,
        bezel: control.children.find((c) => c.kind === 'canvas'),
        title,
        label: title ? title.textContent() : '',
        lines: title ? title._placedLayout().layout.lines : [],
      };
    });
}

/** A toolbar like flow-stress's, in a window too narrow for it. */
const SCENES = [
  '200 · lattice',
  '2,000 · lattice',
  '300 · fan-out',
  '400 · widgets',
  '200 · chart widgets',
];
const toolbar = (width, size) =>
  h(
    'window',
    { width, height: 160 },
    h(
      'box',
      {
        style: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          padding: 12,
        },
      },
      ...SCENES.map((label) => h(Button, { key: label, label, size })),
      h(Button, { key: 'fit', label: 'fit', size }),
    ),
  );

for (const size of ['medium', 'small']) {
  const controlSize = size === 'small' ? 'small' : 'regular';
  const natural = NATURAL[controlSize];

  test(`a native ${size} button grows with a label that wrapped, and its title stays on the bezel`, async () => {
    const { tree, asked, unmount } = await mount(toolbar(420, size));
    const all = buttons(tree);
    const wrapped = all.filter((b) => b.lines.length > 1);
    assert.ok(
      wrapped.length >= 3,
      `the premise: labels wrap in a row this narrow (${all
        .map((b) => `"${b.label}" ${b.lines.length}`)
        .join(', ')})`,
    );

    // the one that fits, for the room over its capitals
    const fit = all.find((b) => b.label === 'fit');
    assert.equal(fit.lines.length, 1, 'the premise: "fit" fits');
    const capsRoom = fit.title.abs.y - fit.control.abs.y;

    for (const { control, footprint, bezel, title, label } of wrapped) {
      const top = control.abs.y;
      const bottom = control.abs.y + control.abs.height;
      assert.ok(
        control.abs.height > natural,
        `"${label}": the control is taller than one line (${control.abs.height})`,
      );
      // the whole title inside the bezel's body — the rows between its
      // shadows — rather than a line of it riding over the top edge
      assert.ok(
        title.abs.y >= top + SHADOW.top &&
          title.abs.y + title.abs.height <= bottom - SHADOW.bottom,
        `"${label}": title ${title.abs.y}..${title.abs.y + title.abs.height} ` +
          `in a control ${top}..${bottom}`,
      );
      // with the room a one-line title has over its capitals…
      assert.equal(title.abs.y - top, capsRoom, `"${label}": over the caps`);
      // …and on the same baseline, above the bottom edge
      assert.equal(
        bottom - (title.abs.y + title.abs.height),
        SHADOW.bottom + TITLE_BASELINE[controlSize],
        `"${label}": the last baseline`,
      );
      // the slot it sits in grows with it, so the row makes room for it
      // rather than the control spilling over what is above and below
      assert.equal(footprint.abs.y, top, `"${label}": the footprint's top`);
      assert.equal(footprint.abs.height, control.abs.height, 'and height');
      assert.equal(bezel.abs.height, control.abs.height, 'the bezel fills it');
      // what the store is asked to draw is that box, so the pixels AppKit
      // makes for it are as tall as the control
      assert.ok(
        asked.some(
          (a) =>
            a.w === bezel.abs.width * a.scale &&
            a.height === bezel.abs.height * a.scale,
        ),
        `"${label}": a bezel ${bezel.abs.width}x${bezel.abs.height} was asked for`,
      );
    }
    await unmount();
  });

  test(`a native ${size} button whose label fits is exactly AppKit's height`, async () => {
    const { tree, unmount } = await mount(toolbar(900, size));
    for (const { control, title, label, lines } of buttons(tree)) {
      assert.equal(lines.length, 1, `the premise: "${label}" fits`);
      assert.equal(control.abs.height, natural, `"${label}"`);
      // on the baseline NSButtonCell puts a title on
      assert.equal(
        control.abs.y + control.abs.height - (title.abs.y + title.abs.height),
        SHADOW.bottom + TITLE_BASELINE[controlSize],
        `"${label}": the baseline`,
      );
    }
    await unmount();
  });
}

// A wrapped title is centred line by line, as AppKit centres one and a
// browser centres a `<button>`'s — a short second line under a long first
// one does not hang off the left edge of the bezel.
test("a wrapped title's lines are centred", async () => {
  const { tree, unmount } = await mount(toolbar(420, 'medium'));
  const wrapped = buttons(tree).filter((b) => b.lines.length > 1);
  assert.ok(wrapped.length > 0, 'the premise: something wrapped');
  for (const { title, label, lines } of wrapped) {
    const widths = lines.map((l) => l.width);
    assert.ok(
      Math.max(...widths) - Math.min(...widths) > 4,
      `the premise: "${label}" has lines of different lengths (${widths})`,
    );
    for (const line of lines) {
      const centre = line.x + line.width / 2;
      assert.ok(
        Math.abs(centre - title.abs.width / 2) <= 1,
        `"${label}": a line centred at ${centre} in a ${title.abs.width}px title`,
      );
    }
  }
  await unmount();
});

// An icon is not a title: it is centred on the bezel's body, as AppKit
// centres an image, and one as tall as the body holds leaves the control at
// AppKit's height. A control that grew for its icon would switch to the
// taller bezel for a button with nothing on a second line.
test('an icon is centred on the body and does not grow the control', async () => {
  const icon = (key) => h('box', { key, style: { width: 16, height: 16 } });
  const { tree, unmount } = await mount(
    h(
      'window',
      { width: 300, height: 100 },
      h(
        'box',
        { style: { flexDirection: 'row', padding: 12, gap: 8 } },
        h(Button, { 'aria-label': 'icon' }, icon('glyph')),
        h(Button, null, icon('glyph'), 'Save'),
      ),
    ),
  );
  for (const { control } of buttons(tree)) {
    assert.equal(control.abs.height, NATURAL.regular);
    const glyph = control.children.find(
      (c) => c.kind === 'box' && c.style.width === 16,
    );
    const body = {
      top: control.abs.y + SHADOW.top,
      bottom: control.abs.y + control.abs.height - SHADOW.bottom,
    };
    // centred to the pixel: a 16px icon in a 19px body has an odd pixel
    // over, and layout gives it to one side
    const above = glyph.abs.y - body.top;
    const below = body.bottom - (glyph.abs.y + glyph.abs.height);
    assert.ok(
      above >= 0 && below >= 0 && Math.abs(above - below) <= 1,
      `the icon ${glyph.abs.y}..${glyph.abs.y + glyph.abs.height} centred ` +
        `on a body ${body.top}..${body.bottom}`,
    );
  }
  await unmount();
});
