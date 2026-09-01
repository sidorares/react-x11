// The native-controls policy (docs/macos.md §Native controls): the theme's
// `controls` token and the per-instance `native` prop decide whether a
// control wears the platform bezel, and a backend without the capability —
// the mock, X11 — draws the themed controls under every setting. The bezels
// themselves are Cocoa-only and verified against the live backend; what is
// pinned here is the resolution logic and that the drawn path is untouched.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import {
  Button,
  Checkbox,
  Switch,
  ThemeProvider,
  createRoot,
} from '../src/index.js';
import { useSupports } from '../src/appcontext.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  await tick();
  await tick();
};

const rootOf = (app) => app.windows[0]._reactX11Node;

async function mount(element, width = 400, height = 300) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(h('window', { width, height }, element));
  await settle();
  return { app, x11Root, tree: rootOf(app) };
}

const findRole = (tree, role) => {
  let found = null;
  const walk = (n) => {
    if (found) return;
    if (n.props?.role === role) {
      found = n;
      return;
    }
    for (const c of n.children) if (!c.isWindow) walk(c);
  };
  walk(tree);
  return found;
};

test('the mock backend draws the themed controls under every policy', async () => {
  for (const controls of ['auto', 'native', 'drawn']) {
    const { x11Root, tree } = await mount(
      h(
        ThemeProvider,
        { value: { controls } },
        h(Button, null, 'Save'),
        h(Checkbox, { checked: true }, 'Agree'),
        h(Switch, { checked: false }),
      ),
    );
    const button = findRole(tree, 'button');
    const checkbox = findRole(tree, 'checkbox');
    const toggle = findRole(tree, 'switch');
    // The drawn button is its label; the native one would carry a bezel
    // <canvas> and a wash overlay box around it.
    assert.deepStrictEqual(
      [...button.children].map((c) => c.kind),
      ['text'],
      `controls: ${controls} — button gained non-drawn children`,
    );
    // the drawn well is a box; the native well is a canvas
    assert.strictEqual(checkbox.children[0].kind, 'box');
    // the drawn switch holds its sliding thumb box
    assert.strictEqual(toggle.children[0].kind, 'box');
    // the drawn look keeps its background answer
    assert.ok(button.style.backgroundColor);
    await x11Root.unmount();
  }
});

test("controls: 'native' without the capability warns once, not per control", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const { x11Root } = await mount(
      h(
        ThemeProvider,
        { value: { controls: 'native' } },
        h(Button, null, 'One'),
        h(Button, null, 'Two'),
        h(Checkbox, {}, 'Three'),
      ),
    );
    await x11Root.unmount();
  } finally {
    console.warn = original;
  }
  const relevant = warnings.filter((w) => w.includes('native control'));
  // once across the whole app — module-level, deliberately, because the
  // theme is app-wide and one line says everything three hundred would
  assert.ok(relevant.length <= 1, `warned ${relevant.length} times`);
});

test('useSupports(nativeControls) answers false off the Cocoa backend', async () => {
  let answer = null;
  function Probe() {
    answer = useSupports('nativeControls');
    return null;
  }
  const { x11Root } = await mount(h(Probe));
  assert.strictEqual(answer, false);
  await x11Root.unmount();
});

test('native={false} is a complete opt-out whatever the theme says', async () => {
  // On the mock this is indistinguishable from drawn-by-incapacity, so what
  // is pinned is that the prop is accepted and renders the drawn control —
  // the Cocoa half of the contract is verified against the live backend.
  const { x11Root, tree } = await mount(
    h(
      ThemeProvider,
      { value: { controls: 'native' } },
      h(Button, { native: false }, 'Branded'),
    ),
  );
  const button = findRole(tree, 'button');
  assert.deepStrictEqual(
    [...button.children].map((c) => c.kind),
    ['text'],
  );
  await x11Root.unmount();
});
