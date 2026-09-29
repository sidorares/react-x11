// A layout value the layout cannot take — `width: 'hidden'`, `padding:
// 'auto'`, `flexDirection: 'sideways'` — and the places it used to throw
// from.
//
// At a commit that is a throw React routes to a boundary, which is fine. But
// a query block is applied when it starts matching, and that is a frame: a
// resize into `'@width >= 600'` with a bad value in it threw out of the
// flush, where nothing could catch it, and the process went down. The style
// fuzzer found it. A `$token` inside a query block did the same with a good
// value, because the block's tokens were never resolved: yoga was handed
// the string `'$gutter'`.
//
// So development asks the question where the style is written — including
// inside a block that does not match yet — and the frame drops what the
// layout refuses and says so. `null` is unset, as it is everywhere else.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const nodeOf = (app) => app.windows[0]._reactX11Node;

/** What a real ConfigureNotify does. */
async function resize(app, width, height = 100) {
  const wnd = app.windows[0];
  wnd.width = width;
  wnd.height = height;
  wnd.emit('resize', { width, height });
  await tick();
}

/** Capture console.error and put back `process.exitCode` — a reported
 *  style problem marks the process failed, on purpose. */
async function capturing(fn) {
  const errors = [];
  const { error } = console;
  const code = process.exitCode;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await fn(errors);
  } finally {
    console.error = error;
    process.exitCode = code;
  }
  return errors;
}

async function mount(tree) {
  const app = createMockApp();
  const uncaught = [];
  const root = await createRoot({
    app,
    onUncaughtError: (error) => uncaught.push(error),
  });
  root.render(tree);
  await tick();
  return { app, root, uncaught };
}

test('null is unset for a layout property, the way a conditional writes it', async () => {
  const { app, root, uncaught } = await mount(
    h(
      'window',
      { width: 200, height: 100 },
      h(
        'box',
        { style: { flexDirection: 'row' } },
        h('box', {
          style: {
            width: null,
            minWidth: null,
            padding: null,
            flexDirection: null,
            flexGrow: 1,
            height: 10,
          },
        }),
      ),
    ),
  );
  // `width: null` threw "Cannot read properties of null (reading 'unit')"
  assert.deepEqual(
    uncaught.map((e) => e.message),
    [],
  );
  const box = nodeOf(app).children[0].children[0];
  assert.strictEqual(box.abs.width, 200, 'unset: the flexGrow fills the row');
  await root.unmount();
});

test('a value the layout cannot take is an error at the commit that names it', async () => {
  for (const [style, message] of [
    [{ width: 'hidden' }, /invalid width "hidden" in <box style> \(expected/],
    [{ width: true }, /invalid width true/],
    [{ padding: 'auto' }, /invalid padding "auto".*like '50%'\)/],
    [{ flexDirection: 'sideways' }, /invalid flexDirection "sideways"/],
    // …and inside a query block that does not match yet, which is the one
    // that used to wait for a resize to throw from the frame
    [
      { '@width >= 600': { width: 'hidden' } },
      /invalid width "hidden" in <box style> @width >= 600/,
    ],
    [
      { '@container width >= 50': { flexDirection: 'sideways' } },
      /invalid flexDirection "sideways"[^]*in <box style> @container width >= 50/,
    ],
  ]) {
    const { root, uncaught } = await mount(
      h('window', { width: 200, height: 100 }, h('box', { style })),
    );
    assert.match(uncaught[0]?.message ?? '(none)', message);
    await root.unmount();
  }
});

test('what the layout takes is not a mistake', async () => {
  const { root, uncaught } = await mount(
    h(
      'window',
      { width: 200, height: 100, theme: { gutter: 8 } },
      h('box', {
        style: {
          width: '50%',
          height: 'auto',
          top: 'auto',
          padding: '$gutter',
          marginLeft: 4,
          flexDirection: 'row',
          '@width >= 600': { padding: '$gutter', flexBasis: 'auto' },
        },
      }),
    ),
  );
  assert.deepEqual(
    uncaught.map((e) => e.message),
    [],
  );
  await root.unmount();
});

test('a token inside a query block resolves', async () => {
  const { app, root, uncaught } = await mount(
    h(
      'window',
      { width: 200, height: 100, theme: { gutter: 8 } },
      h(
        'box',
        { style: { padding: 0, '@width >= 300': { padding: '$gutter' } } },
        h('box', { style: { width: 10, height: 10 } }),
      ),
    ),
  );
  const box = nodeOf(app).children[0];
  assert.strictEqual(box.children[0].abs.x, 0);
  await resize(app, 400);
  assert.deepEqual(
    uncaught.map((e) => e.message),
    [],
  );
  assert.strictEqual(box.style.padding, 8, 'the block, resolved');
  assert.strictEqual(box.children[0].abs.x, 8, 'and laid out with it');
  await root.unmount();
});

test('a query block that starts matching mid-frame drops what the layout refuses, and says so', async () => {
  // A token is checked once it resolves, which is past development's check
  // at the commit — the path every value takes in a production build.
  const errors = await capturing(async () => {
    const { app, root, uncaught } = await mount(
      h(
        'window',
        {
          width: 200,
          height: 100,
          theme: { bad: 'hidden', side: 'sideways' },
        },
        h(
          'box',
          {
            style: {
              width: 50,
              height: 20,
              '@width >= 300': {
                width: '$bad',
                flexDirection: '$side',
                height: 30,
              },
            },
          },
          h('box', { style: { width: 10, height: 10 } }),
          h('box', { style: { width: 10, height: 10 } }),
        ),
      ),
    );
    await resize(app, 400);
    assert.deepEqual(
      uncaught.map((e) => e.message),
      [],
    );
    const box = nodeOf(app).children[0];
    // the refused two are dropped — the default width, a column — and the
    // rest of the block applies
    assert.strictEqual(box.abs.height, 30, 'height: 30 from the block');
    assert.strictEqual(box.abs.width, 400, 'no width: stretched');
    const [a, b] = box.children;
    assert.strictEqual(b.abs.y - a.abs.y, 10, 'stacked: the default column');
    // and it goes on laying out: shrinking back applies the base again
    await resize(app, 200);
    assert.strictEqual(box.abs.width, 50);
    assert.strictEqual(box.abs.height, 20);
    await root.unmount();
  });
  assert.ok(
    errors.some((e) =>
      /invalid width "hidden" \(Invalid value hidden for setWidth\) in <box style>, applied when a query block started matching/.test(
        e,
      ),
    ),
    errors.join('\n'),
  );
  assert.ok(
    errors.some((e) => /invalid flexDirection "sideways"/.test(e)),
    errors.join('\n'),
  );
});
