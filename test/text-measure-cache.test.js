// A <text> measured again at a width it has already been shaped for.
//
// A layout pass measures every label several times over — a flex basis, the
// width it is given, the content floors — so the answer for a width it has
// already seen has to cost next to nothing. It cost two string conversions of
// a fractional width and, for a trimmed label, a font lookup per measure: a
// fling down a `<Tree>` asked a hundred thousand times. What is cached has to
// stay exactly what it was, though, and that is most of what is asserted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';

const h = React.createElement;

async function mountLabels(t, labels) {
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd });
  const root = await createRoot({ app });
  t.after(async () => {
    await root.unmount();
    await app.close();
  });
  const render = (children) =>
    new Promise((resolve) =>
      root.render(
        h('window', { width: 300, height: 300 }, h('box', {}, ...children)),
        resolve,
      ),
    );
  const instance = await render(labels);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return {
    app,
    rerender: async (children) => {
      await render(children);
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
    texts: () => instance._reactX11Node.children[0].children,
  };
}

function counting(object, name) {
  const inner = object[name];
  const calls = { count: 0 };
  object[name] = function (...args) {
    calls.count++;
    return inner.apply(this, args);
  };
  return calls;
}

test('a width already shaped for is answered without shaping or a font lookup', async (t) => {
  const trimmed = { textBoxTrim: 'cap-alphabetic', fontSize: 20 };
  const { app, texts } = await mountLabels(t, [
    h('text', { key: 'a', style: trimmed }, 'Quarterly report'),
    h('text', { key: 'b', style: { fontSize: 20 } }, 'Quarterly report'),
  ]);
  const [label, plain] = texts();
  const widths = [Infinity, 245.33333333333334, 61.5];
  const first = widths.map((width) => label.measureContent({ width }));
  const firstPlain = widths.map((width) => plain.measureContent({ width }));

  const layouts = counting(app.fonts, 'layout');
  const matches = counting(app.fonts, 'match');
  for (let round = 0; round < 3; round++) {
    assert.deepEqual(
      widths.map((width) => label.measureContent({ width })),
      first,
    );
    assert.deepEqual(
      widths.map((width) => plain.measureContent({ width })),
      firstPlain,
    );
  }
  assert.equal(layouts.count, 0, 'nothing shaped again');
  assert.equal(matches.count, 0, 'the trim did not look its face up again');
  // and it is the trimmed box: shorter than the untrimmed line
  assert.ok(first[0].height < firstPlain[0].height);
});

test('a face that moves takes the layout and the trim with it', async (t) => {
  const label = (fontSize) =>
    h(
      'text',
      { key: 'a', style: { textBoxTrim: 'cap-alphabetic', fontSize } },
      'HEX',
    );
  const { rerender, texts } = await mountLabels(t, [label(20)]);
  const small = texts()[0].measureContent({ width: Infinity });
  await rerender([label(40)]);
  const node = texts()[0];
  const large = node.measureContent({ width: Infinity });
  // a cap height, roughly doubled — not the 20px face's trim on a 40px line
  assert.ok(
    Math.abs(large.height - 2 * small.height) <= 2,
    `${small.height} → ${large.height}`,
  );
  await rerender([label(20)]);
  assert.deepEqual(texts()[0].measureContent({ width: Infinity }), small);
});

test('an entry shaped with other truncation options is not handed back', async (t) => {
  const { texts } = await mountLabels(t, [
    h('text', { key: 'a' }, 'one two three four five six seven'),
  ]);
  const node = texts()[0];
  const real = node._layoutFor(80);
  // Only a style change moves `maxLines` or `textOverflow`, and it clears the
  // cache on its way — so this is staged: an entry for the same width that
  // was shaped under another cap must not answer for this one.
  const stale = { lines: [], width: 1, height: 1 };
  node._layouts.set(80, { layout: stale, maxLines: 2, overflow: undefined });
  const layout = node._layoutFor(80);
  assert.ok(layout !== stale, 'the entry for another cap was not used');
  assert.equal(layout.lines.length, real.lines.length);
  node._layouts.set(80, {
    layout: stale,
    maxLines: Infinity,
    overflow: 'ellipsis',
  });
  assert.ok(node._layoutFor(80) !== stale, 'nor for another overflow');
});
