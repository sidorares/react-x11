// Text values the engines do not survive — the style fuzzer's third find.
//
// A `fontStyle` of `7` threw from inside ntk's face matching, and a
// `lineHeight` of `'24px'` made a paragraph NaN pixels tall, which the
// layout pass throws on: both from a frame, both uncaught. A `fontSize` of
// `'20px'` did not throw; it set no text at all. Development now says so
// where the style is written, and what reaches the text anyway — a token, a
// production build — is not the property: the text inherits past it, as
// CSS inherits past a declaration it cannot parse.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function commitErrors(style) {
  const app = createMockApp();
  const errors = [];
  const root = await createRoot({
    app,
    onUncaughtError: (error) => errors.push(error),
  });
  root.render(
    h('window', { width: 100, height: 100 }, h('text', { style }, 'ink')),
  );
  await tick();
  await root.unmount();
  return errors.map((e) => e.message);
}

test('a text value no engine can set type with is an error at the commit', async () => {
  for (const [style, message] of [
    [
      { fontStyle: 7 },
      /invalid fontStyle 7 in <text style> \(expected 'normal'/,
    ],
    [{ fontStyle: 'bold' }, /invalid fontStyle "bold"/],
    [{ lineHeight: '24px' }, /invalid lineHeight "24px".*lineHeight: 1\.5/],
    [{ lineHeight: -3 }, /invalid lineHeight -3/],
    [{ fontSize: '20px' }, /invalid fontSize "20px".*fontSize: 14/],
    [{ fontSize: -1 }, /invalid fontSize -1/],
    [{ fontWeight: 1200 }, /invalid fontWeight 1200/],
    [{ fontFamily: 7 }, /invalid fontFamily 7/],
  ]) {
    const [first] = await commitErrors(style);
    assert.match(first ?? '(none)', message);
  }
});

test('what the engines read is not a mistake, numeric strings included', async () => {
  assert.deepEqual(
    await commitErrors({
      fontSize: '20',
      fontWeight: '600',
      fontStyle: 'oblique 10deg',
      fontFamily: 'monospace',
      lineHeight: '1.5',
    }),
    [],
  );
  // and unset, the way a conditional writes it
  assert.deepEqual(
    await commitErrors({
      fontSize: null,
      fontWeight: undefined,
      fontStyle: '',
      lineHeight: null,
    }),
    [],
  );
});

test('what reaches the text anyway is inherited past, and the frame goes on', async () => {
  // Tokens are checked once they resolve, past development's check at the
  // commit — the path every value takes in a production build.
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd });
  try {
    const uncaught = [];
    const root = await createRoot({
      app,
      onUncaughtError: (error) => uncaught.push(error),
    });
    const instance = await new Promise((resolve) =>
      root.render(
        h(
          'window',
          {
            width: 300,
            height: 200,
            theme: { tilt: 7, tall: '24px', big: '20px', wide: 'wide' },
            style: { fontSize: 18 },
          },
          h(
            'box',
            { style: { flexDirection: 'row', alignItems: 'flex-start' } },
            h('text', { style: { fontStyle: '$tilt' } }, 'Hello'),
            h('text', { style: { lineHeight: '$tall' } }, 'Hello'),
            h('text', { style: { fontSize: '$big' } }, 'Hello'),
            h('text', { style: { fontWeight: '$wide' } }, 'Hello'),
            h('text', {}, 'Hello'),
          ),
        ),
        resolve,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(
      uncaught.map((e) => e.message),
      [],
    );
    const [tilted, tall, big, wide, plain] =
      instance._reactX11Node.children[0].children;
    for (const [node, what] of [
      [tilted, 'fontStyle'],
      [tall, 'lineHeight'],
      [big, 'fontSize'],
      [wide, 'fontWeight'],
    ]) {
      // what the window above says, as if the value had not been written
      assert.equal(node.resolvedTextStyle().size, 18, what);
      assert.deepEqual(
        [node.abs.width, node.abs.height],
        [plain.abs.width, plain.abs.height],
        `${what}: set like the text beside it`,
      );
    }
    assert.ok(plain.abs.height > 0);
    await root.unmount();
  } finally {
    await app.close();
  }
});
