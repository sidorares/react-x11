// A root warms the faces the widgets set text in beyond a family's four
// (src/faces.js): with fontconfig, a face nobody warmed is a synchronous
// `fc-match` inside the first frame that sets it — a menu bar's titles, in
// a medium, were 34 ms of a Linux desktop's first frame.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { defaultFontSource } from 'ntk';
import { createRoot, MenuBar } from '../src/index.js';
import { DefaultTheme } from '../src/palette.js';
import { MENU_TEXT_WEIGHT } from '../src/faces.js';
import { cleanup, renderX11 } from '../src/testing/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;

afterEach(cleanup);

test('a root asks its fonts for the widget faces as it connects', async () => {
  const app = createMockApp();
  const warmed = [];
  app.fonts = { prewarm: (family, faces) => warmed.push({ family, faces }) };
  const root = await createRoot({ app });
  assert.deepEqual(warmed, [
    { family: DefaultTheme.fontFamily, faces: [{ weight: MENU_TEXT_WEIGHT }] },
  ]);
  await root.unmount();
});

test('fonts with nothing to warm are left alone', async () => {
  // CoreText, DirectWrite, or an ntk from before the method
  const app = createMockApp();
  app.fonts = {};
  const root = await createRoot({ app });
  await root.unmount();
});

test("a menu bar's first frame sets no face that was not warmed", async () => {
  // the source warms sans-serif's regular, bold, italic and bold italic by
  // itself; anything else a menu bar sets has to be one the root warmed
  const source = defaultFontSource();
  const asked = [];
  source.matchSorted = function (pattern) {
    asked.push(pattern);
    return Object.getPrototypeOf(this).matchSorted.call(this, pattern);
  };
  try {
    await renderX11(
      h(MenuBar, {
        globalMenu: false,
        menus: [
          { label: 'File', items: [{ label: 'Open' }] },
          { label: 'Edit', items: [{ label: 'Copy' }] },
        ],
      }),
    );
  } finally {
    delete source.matchSorted;
  }
  const four = (p) =>
    p.family === 'sans-serif' && [400, 700].includes(p.weight);
  const ours = (p) =>
    p.family === DefaultTheme.fontFamily &&
    p.weight === MENU_TEXT_WEIGHT &&
    p.style === 'normal';
  assert.ok(asked.some(ours), 'the bar set its titles in the medium');
  assert.deepEqual(
    asked.filter((p) => !four(p) && !ours(p)),
    [],
    'every face the bar set was warmed',
  );
});
