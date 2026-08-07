// PasswordInput: the editing model, what never leaves the widget, and the
// scribble arithmetic the mask is drawn from.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { PasswordInput, createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';
import {
  hash32,
  maskWidth,
  scribblePoints,
  seededRandom,
} from '../src/components/scribble.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  await tick();
  await tick();
};

const XK = {
  BACKSPACE: 0xff08,
  DELETE: 0xffff,
  INSERT: 0xff63,
  RETURN: 0xff0d,
};
const MOD = { Shift: 1, Lock: 2, Control: 4 };

const treeOf = (app) => app.windows[0]._reactX11Node;

function nodes(from, pred, out = []) {
  if (pred(from)) out.push(from);
  for (const child of from.children) nodes(child, pred, out);
  return out;
}

const texts = (app) =>
  nodes(treeOf(app), (n) => n.kind === 'text').map((n) =>
    String(n.props.children),
  );
const canvases = (app) => nodes(treeOf(app), (n) => n.kind === 'canvas');
const field = (app) =>
  nodes(treeOf(app), (n) => n.props?.role === 'textbox')[0];

/** Type one character, as the X server delivers it. */
function type(app, char, { ctrl = false, shift = false, lock = false } = {}) {
  const codepoint = char.codePointAt(0);
  const keycode = (codepoint % 248) + 8;
  app.X.keycode2keysyms[keycode] = [codepoint];
  app.windows[0].emit('keydown', {
    keycode,
    codepoint,
    buttons:
      (ctrl ? MOD.Control : 0) |
      (shift ? MOD.Shift : 0) |
      (lock ? MOD.Lock : 0),
  });
}

function press(app, keysym, { ctrl = false, shift = false } = {}) {
  const keycode = (keysym % 248) + 8;
  app.X.keycode2keysyms[keycode] = [keysym];
  app.windows[0].emit('keydown', {
    keycode,
    buttons: (ctrl ? MOD.Control : 0) | (shift ? MOD.Shift : 0),
  });
}

const click = (app, node) => {
  const x = node.abs.x + node.abs.width / 2;
  const y = node.abs.y + node.abs.height / 2;
  app.windows[0].emit('mousedown', { x, y, keycode: 1 });
  app.windows[0].emit('mouseup', { x, y, keycode: 1 });
};

async function mount(props) {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    h(
      'window',
      { width: 320, height: 120 },
      h(PasswordInput, { ...props, style: { width: 240 } }),
    ),
  );
  await settle();
  field(app).focus();
  return { app, root };
}

test('typing reports the value and never draws the characters', async () => {
  const seen = [];
  const { app, root } = await mount({ onChange: (ev) => seen.push(ev.value) });

  for (const ch of 'hunter2') type(app, ch);
  await settle();

  assert.strictEqual(seen.at(-1), 'hunter2');
  assert.deepStrictEqual(
    texts(app),
    [],
    'no <text> anywhere: not the secret, and not a placeholder either',
  );
  assert.strictEqual(canvases(app).length, 2, 'the mask, and the eye');

  await root.unmount();
});

test('Backspace takes one, Ctrl+Backspace and Delete take the lot', async () => {
  const seen = [];
  const { app, root } = await mount({ onChange: (ev) => seen.push(ev.value) });

  for (const ch of 'abc') type(app, ch);
  press(app, XK.BACKSPACE);
  await settle();
  assert.strictEqual(seen.at(-1), 'ab');

  press(app, XK.BACKSPACE, { ctrl: true });
  await settle();
  assert.strictEqual(seen.at(-1), '');

  for (const ch of 'xy') type(app, ch);
  press(app, XK.DELETE);
  await settle();
  assert.strictEqual(seen.at(-1), '');

  await root.unmount();
});

test('a surrogate pair is one character, not two halves', async () => {
  const seen = [];
  const { app, root } = await mount({ onChange: (ev) => seen.push(ev.value) });

  type(app, 'a');
  type(app, '🔑');
  await settle();
  assert.strictEqual(seen.at(-1), 'a🔑');

  press(app, XK.BACKSPACE);
  await settle();
  assert.strictEqual(seen.at(-1), 'a', 'the whole key went, not half of it');

  await root.unmount();
});

test('the secret does not leave by the clipboard, and paste brings one in', async () => {
  const seen = [];
  const { app, root } = await mount({ onChange: (ev) => seen.push(ev.value) });

  for (const ch of 'secret') type(app, ch);
  type(app, 'c', { ctrl: true });
  type(app, 'x', { ctrl: true });
  type(app, 'a', { ctrl: true });
  await settle();

  assert.deepStrictEqual(
    app.clipboard.writes,
    [],
    'nothing this field holds was ever offered to a selection',
  );
  assert.strictEqual(seen.at(-1), 'secret', 'and the chords typed no letters');

  // what a password manager does: own the clipboard, then the app pastes
  await app.clipboard.write('from-the-manager\n');
  type(app, 'v', { ctrl: true });
  await settle();
  assert.strictEqual(
    seen.at(-1),
    'secretfrom-the-manager',
    'pasted, with the manager’s trailing newline left out of the secret',
  );

  press(app, XK.INSERT, { shift: true });
  await settle();
  assert.strictEqual(seen.at(-1), 'secretfrom-the-managerfrom-the-manager');

  await root.unmount();
});

test('Enter submits, and Ctrl+U clears the way a pinentry does', async () => {
  const submitted = [];
  const { app, root } = await mount({ onSubmit: (v) => submitted.push(v) });

  for (const ch of 'pw') type(app, ch);
  press(app, XK.RETURN);
  await settle();
  assert.deepStrictEqual(submitted, ['pw']);

  type(app, 'u', { ctrl: true });
  await settle();
  assert.deepStrictEqual(
    texts(app),
    ['Password'],
    'cleared, so the placeholder is back',
  );
  press(app, XK.RETURN);
  await settle();
  assert.deepStrictEqual(submitted, ['pw', ''], 'and it is empty again');

  await root.unmount();
});

test('maxLength holds, and the placeholder shows only while empty', async () => {
  const seen = [];
  const { app, root } = await mount({
    maxLength: 4,
    placeholder: 'Passphrase',
    onChange: (ev) => seen.push(ev.value),
  });

  assert.deepStrictEqual(texts(app), ['Passphrase']);
  for (const ch of 'abcdefgh') type(app, ch);
  await settle();
  assert.strictEqual(seen.at(-1), 'abcd');
  assert.deepStrictEqual(texts(app), [], 'the placeholder is gone');

  await root.unmount();
});

test('the eye reveals the text, and blurring the field hides it again', async () => {
  const { app, root } = await mount({ defaultValue: 'letmein' });

  const eye = nodes(treeOf(app), (n) => n.props?.role === 'button')[0];
  click(app, eye);
  await settle();
  assert.deepStrictEqual(texts(app), ['letmein'], 'revealed on the click');

  field(app).blur();
  await settle();
  assert.deepStrictEqual(texts(app), [], 'and hidden on the way out');

  await root.unmount();
});

test('Caps Lock is reported while it is on, and only while masked', async () => {
  const { app, root } = await mount({});

  type(app, 'a');
  await settle();
  assert.strictEqual(canvases(app).length, 2, 'no warning yet');

  type(app, 'B', { lock: true });
  await settle();
  assert.strictEqual(canvases(app).length, 3, 'the caps indicator joined');

  type(app, 'c');
  await settle();
  assert.strictEqual(canvases(app).length, 2, 'and left when the key came up');

  await root.unmount();
});

test('drawMask replaces the scribble and hears the geometry', async () => {
  const calls = [];
  const { app, root } = await mount({
    drawMask: (ctx, info) => {
      calls.push(info);
      ctx.fillRect(0, 0, info.width, info.height);
    },
  });

  for (const ch of 'abcd') type(app, ch);
  await settle();

  const last = calls.at(-1);
  assert.strictEqual(last.length, 4);
  assert.ok(last.width > 0 && last.height > 0);
  assert.ok(
    calls.some((c) => c.seed !== last.seed),
    'the seed moved as the value did',
  );

  await root.unmount();
});

test('the mask widens with every character and never with the value alone', () => {
  const unit = 8;
  const seed = hash32('w4242');
  const widths = [0, 1, 2, 3, 4, 5].map((n) => maskWidth(n, unit, seed));

  for (let i = 1; i < widths.length; i++) {
    assert.ok(
      widths[i] > widths[i - 1],
      `${i} characters is wider than ${i - 1}`,
    );
  }
  assert.strictEqual(
    maskWidth(5, unit, seed),
    widths[5],
    'and the same length is the same width, whatever was typed',
  );
  // not a ruler: the steps differ from one another
  const steps = widths.slice(1).map((w, i) => w - widths[i]);
  assert.ok(
    new Set(steps.map((s) => s.toFixed(3))).size > 1,
    'the per-character steps are not all the same',
  );
  assert.strictEqual(maskWidth(500, unit, seed, 120), 120, 'and it is capped');
});

test('the scribble is a pure function of its seed, and stays in its box', () => {
  const box = { width: 120, height: 18 };
  const a = scribblePoints({ ...box, seed: 1234 });
  const again = scribblePoints({ ...box, seed: 1234 });
  const other = scribblePoints({ ...box, seed: 1235 });

  assert.deepStrictEqual(a, again, 'a repaint draws the same curve');
  assert.notDeepStrictEqual(a, other, 'a keystroke draws a different one');
  assert.strictEqual(
    a.length,
    7,
    'a fixed number of points, whatever is typed',
  );
  for (const p of a) {
    assert.ok(p.x >= 0 && p.x <= box.width, `x ${p.x} inside the box`);
    assert.ok(p.y >= 0 && p.y <= box.height, `y ${p.y} inside the box`);
  }
  // and x marches across it, so the stroke reads as writing rather than a
  // tangle in one corner
  assert.ok(a[6].x > a[0].x);
});

test('the generator is deterministic and spread over the unit interval', () => {
  const first = Array.from({ length: 5 }, seededRandom(7));
  assert.deepStrictEqual(
    Array.from({ length: 5 }, seededRandom(7)),
    first,
    'same seed, same sequence',
  );
  const many = Array.from({ length: 2000 }, seededRandom(99));
  assert.ok(Math.min(...many) >= 0 && Math.max(...many) < 1);
  const mean = many.reduce((a, b) => a + b, 0) / many.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05, `mean ${mean} is near the middle`);
});
