// The palette's **vocabulary**: what a theme can say, as opposed to how a
// theme reaches a node (styling.md's `$token`) or what shape it gives a
// control (theme-type.test.js).
//
// Three things are asserted here and they are all issue #258. The palette
// had no way to say "this failed" — every alert and validation message in
// every app hard-coded a hex, which is the one thing tokens exist to
// prevent. It had one `background` doing two jobs, the window's ground and
// the fill of everything raised off it, which is why all three demo themes
// in `examples/themes.js` had invented a `canvas` of their own. And `dim`
// named a colour by how it looks rather than by what it is.
//
// The contrast assertions compute the ratio rather than comparing hexes: a
// test that pins `'#c0392b'` passes against any string at all, including the
// one a careless edit leaves behind. What has to stay true of a status
// colour is that it can be *read*, in both schemes.
import assert from 'node:assert';
import { test } from 'node:test';
import React from 'react';

import { Checkbox, Select, ThemeProvider, createRoot } from '../src/index.js';
import {
  DarkTheme,
  DefaultTheme,
  paletteFor,
  resolveTheme,
} from '../src/palette.js';
import { readableInk } from '../src/styles.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  await tick();
  await tick();
};

const STATUS = ['danger', 'success', 'warning', 'info'];

// WCAG's ratio, written out here rather than imported so that a change to
// the implementation's idea of contrast cannot quietly agree with itself.
function ratio(a, b) {
  const channels = (c) => {
    const hex = c === 'white' ? '#ffffff' : c;
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  };
  const luminance = (c) => {
    const [r, g, bl] = channels(c).map((v) =>
      v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// --- the desktop's accent ---------------------------------------------------

// What the built-in palette becomes on a desktop that reports an accent:
// the accent family and the focus ring move, `info` and the status colours
// do not, and the steps are taken the way each scheme takes them.
test('the desktop accent moves the accent family and nothing else', () => {
  // the pressed step comes back as `rgba(...)` from `stepBeyond`
  const hex = (c) => {
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
    return m
      ? '#' +
          m
            .slice(1, 4)
            .map((v) => (+v).toString(16).padStart(2, '0'))
            .join('')
      : c;
  };
  const lum = (c) => ratio(hex(c), '#000000');
  for (const [scheme, base] of [
    ['light', DefaultTheme],
    ['dark', DarkTheme],
  ]) {
    const palette = paletteFor({
      colorScheme: scheme,
      accent: '#f7821b',
      accentText: '#ffffff',
    });
    assert.equal(palette.accent, '#f7821b', scheme);
    assert.equal(palette.hoverBackground, '#f7821b', scheme);
    // the desktop's ink, not the contrast pick (which is dark on orange)
    assert.equal(palette.accentText, '#ffffff', scheme);
    assert.equal(palette.hoverText, '#ffffff', scheme);
    // the hover sinks into a light ground and lifts off a dark one, and the
    // press keeps going the same way
    const direction = scheme === 'dark' ? 1 : -1;
    assert.ok(
      Math.sign(lum(palette.accentHover) - lum(palette.accent)) === direction,
      `${scheme}: hover steps the palette's way`,
    );
    assert.ok(
      Math.sign(lum(palette.accentActive) - lum(palette.accentHover)) ===
        direction,
      `${scheme}: the press steps beyond the hover`,
    );
    assert.equal(
      palette.focusRing,
      scheme === 'dark' ? palette.accentHover : palette.accent,
      `${scheme}: the focus ring is the accent, lifted on dark`,
    );
    assert.equal(palette.borderFocus, palette.focusRing, scheme);
    for (const token of [...STATUS, 'background', 'surface', 'text']) {
      assert.equal(palette[token], base[token], `${scheme}: ${token} stays`);
    }
    // one object per desktop answer: identity is what the token cache keys on
    assert.equal(
      palette,
      paletteFor({
        colorScheme: scheme,
        accent: '#f7821b',
        accentText: '#ffffff',
      }),
    );
  }
  // no accent is the built-in palette itself, not a copy of it
  assert.equal(paletteFor({ colorScheme: 'dark', accent: null }), DarkTheme);
  assert.equal(
    paletteFor({ colorScheme: 'light', accent: null }),
    DefaultTheme,
  );
  assert.equal(
    paletteFor({ colorScheme: 'no-preference', accent: null }),
    DefaultTheme,
  );
});

// The portal names a fill and nothing about what goes on it, so there the
// ink is the contrast pick — the same rule any theme gets for a fill it
// names and stops at.
test('a desktop accent with no ink gets the legible one', () => {
  for (const [scheme, base] of [
    ['light', DefaultTheme],
    ['dark', DarkTheme],
  ]) {
    for (const accent of ['#f7821b', '#ffd60a', '#1c3f95']) {
      const palette = paletteFor({
        colorScheme: scheme,
        accent,
        accentText: null,
      });
      assert.equal(
        palette.accentText,
        readableInk(accent, [base.text, base.background]),
        `${scheme} ${accent}`,
      );
      assert.ok(
        ratio(
          palette.accentText === 'white' ? '#ffffff' : palette.accentText,
          accent,
        ) >= 3,
        `${scheme} ${accent}: readable`,
      );
    }
  }
});

// --- the status family ------------------------------------------------------

test('both palettes can say failed, worked, careful and note', () => {
  for (const [name, palette] of Object.entries({ DefaultTheme, DarkTheme })) {
    for (const token of STATUS) {
      assert.equal(
        typeof palette[token],
        'string',
        `${name} has no ${token} — an app that renders an error has to hard-code one`,
      );
    }
  }
});

test('a status colour is ink as well as fill, in both schemes', () => {
  for (const [name, palette] of Object.entries({ DefaultTheme, DarkTheme })) {
    for (const token of STATUS) {
      // as ink: "Password too short" under a field is the status colour on
      // the palette's own ground, and that is the harder of the two jobs —
      // a fill only has to be seen, letters have to be read
      const asInk = ratio(palette[token], palette.background);
      assert.ok(
        asInk >= 4.5,
        `${name}.${token} on the ground is ${asInk.toFixed(2)}:1, under 4.5`,
      );
      // as fill: the letters the palette puts on it
      const onFill = ratio(palette[token], palette[`${token}Text`]);
      assert.ok(
        onFill >= 3,
        `${name}.${token}Text on it is ${onFill.toFixed(2)}:1, under 3`,
      );
    }
  }
});

test('danger is the one status colour with a press, because it is the one you press', () => {
  for (const palette of [DefaultTheme, DarkTheme]) {
    assert.equal(typeof palette.dangerHover, 'string');
    assert.equal(typeof palette.dangerActive, 'string');
    for (const token of ['success', 'warning', 'info']) {
      assert.equal(
        palette[`${token}Hover`],
        undefined,
        `${token} is something the app says, not something the user clicks`,
      );
    }
  }
});

test('the pressed step of danger is derived, like every other family', () => {
  const stepped = resolveTheme({ danger: '#ff0000', dangerHover: '#cc0000' });
  const [, r] = /rgba\((\d+)/.exec(stepped.dangerActive);
  assert.ok(
    Number(r) < 0xcc,
    `the press keeps going the way the hover went (got ${stepped.dangerActive})`,
  );
  assert.strictEqual(
    resolveTheme({ danger: '#ff0000', dangerActive: '#001122' }).dangerActive,
    '#001122',
    'an explicit one wins',
  );
});

// --- the ink on a fill ------------------------------------------------------

test('readableInk takes the ratio, not the lightness of the fill', () => {
  const inks = ['#2d3436', 'white'];
  assert.equal(readableInk('#f1c40f', inks), '#2d3436', 'dark ink on a yellow');
  assert.equal(readableInk('#1a2a6c', inks), 'white', 'light ink on a navy');
  // a colour it cannot parse is not a reason to throw on a paint path
  assert.equal(readableInk('not a colour', inks), '#2d3436');
});

test('a palette that names a fill and no ink gets a legible one', () => {
  const yellow = resolveTheme({ accent: '#f1c40f' });
  assert.equal(
    yellow.accentText,
    DefaultTheme.text,
    'inheriting `accentText: white` would have painted an invisible label',
  );
  const navy = resolveTheme({ danger: '#1a2a6c' });
  assert.equal(navy.dangerText, DefaultTheme.background);
  assert.equal(
    resolveTheme({ accent: '#f1c40f', accentText: '#ffffff' }).accentText,
    '#ffffff',
    'a palette that means it wins, as everywhere else',
  );
  assert.strictEqual(
    resolveTheme({ radius: 8 }).accentText,
    DefaultTheme.accentText,
    'a palette that touched no colour keeps what was in force',
  );
});

// --- the ground and what is raised off it -----------------------------------

test('surface follows background unless a palette names it', () => {
  const flat = resolveTheme({ background: '#1f1f23' });
  assert.equal(
    flat.surface,
    '#1f1f23',
    'a theme with one ground has one ground — not the built-in dark surface',
  );
  const raised = resolveTheme({ background: '#0d1117', surface: '#161b22' });
  assert.equal(raised.surface, '#161b22');
  // and the pressed step is measured from whichever of the two it turned out
  // to be, so it does not step from a colour this palette replaced
  const pressed = resolveTheme({
    background: '#0d1117',
    surfaceHover: '#21262d',
  });
  const [, r, g, b] = /rgba\((\d+), (\d+), (\d+)/.exec(pressed.surfaceActive);
  assert.ok(
    Number(r) > 0x21 && Number(g) > 0x26 && Number(b) > 0x2d,
    `the press keeps lightening (got ${pressed.surfaceActive})`,
  );
});

test('the dark palette raises its surface off its ground', () => {
  assert.notEqual(
    DarkTheme.surface,
    DarkTheme.background,
    'a card at the ground’s own colour is a card you cannot see',
  );
  assert.equal(
    DefaultTheme.surface,
    DefaultTheme.background,
    'and the light one does not have to, which is what the default has always been',
  );
});

test('a control fills with the surface, not with the window’s ground', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const theme = { background: '#101010', surface: '#303030', text: '#ffffff' };
  x11Root.render(
    h(
      ThemeProvider,
      { value: theme, colorScheme: 'dark' },
      h(
        'window',
        { width: 300, height: 200 },
        h(Checkbox, { checked: false, label: 'ready' }),
        h(Select, { options: [{ value: 'a', label: 'A' }], value: 'a' }),
      ),
    ),
  );
  await settle();
  const root = app.windows[0]._reactX11Node;
  const fills = [];
  const walk = (node) => {
    if (node.style?.backgroundColor) fills.push(node.style.backgroundColor);
    for (const child of node.children) if (!child.isWindow) walk(child);
  };
  walk(root);
  assert.ok(
    fills.includes('#303030'),
    `the well and the field take the surface (saw ${fills.join(', ')})`,
  );
  assert.ok(
    !fills.includes('#101010'),
    'and nothing inside repaints the ground the window already painted',
  );
  await x11Root.unmount();
});

// --- the names that moved ---------------------------------------------------

test('the muted ink is named for the text it is', () => {
  for (const palette of [DefaultTheme, DarkTheme]) {
    assert.equal(typeof palette.textMuted, 'string');
    assert.equal(typeof palette.textMutedActive, 'string');
    assert.equal(palette.dim, undefined);
    assert.equal(palette.dimActive, undefined);
  }
});
