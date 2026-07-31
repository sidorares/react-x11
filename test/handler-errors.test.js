// A throwing event handler must not take the process with it (#113).
//
// The handler runs from an X event, not from a render, so React is not on
// the stack and no error boundary can catch it. Left bare the throw unwinds
// into ntk's socket handler; these tests pin the contract that replaced it.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createMockApp, pressButton } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Capture console.error and process.exitCode around a body. */
async function captured(body) {
  const errors = [];
  const origError = console.error;
  const origCode = process.exitCode;
  console.error = (...a) => errors.push(a.map(String).join(' '));
  try {
    await body();
  } finally {
    console.error = origError;
    process.exitCode = origCode;
  }
  return errors;
}

const app0 = () => createMockApp();

test('a throwing onClick is reported, and the dispatch survives it', async () => {
  const app = app0();
  const root = await createRoot({ app });
  const seen = [];
  root.render(
    h(
      'window',
      { width: 100, height: 60 },
      h(
        'box',
        { onClick: () => seen.push('outer') },
        h('box', {
          style: { width: 40, height: 20 },
          onClick: () => {
            throw new Error('boom');
          },
        }),
      ),
    ),
  );
  await tick();

  let exitCode;
  const errors = await captured(async () => {
    pressButton(app.windows[0], 10, 10);
    await tick();
    exitCode = process.exitCode;
  });

  assert.match(errors.join('\n'), /onClick on <box>/, 'names what threw');
  assert.match(errors.join('\n'), /boom/, 'and carries the error');
  assert.strictEqual(exitCode, 1, 'a crashed handler must not exit 0');
  assert.deepStrictEqual(
    seen,
    ['outer'],
    'the bubble phase continued past the throw',
  );

  await root.unmount();
});

test('the message names the component that rendered the node', async () => {
  const app = app0();
  const root = await createRoot({ app });
  function Panel() {
    return h('box', {
      style: { width: 40, height: 20 },
      onClick: () => {
        throw new Error('boom');
      },
    });
  }
  root.render(h('window', { width: 100, height: 60 }, h(Panel)));
  await tick();

  const errors = await captured(async () => {
    pressButton(app.windows[0], 10, 10);
    await tick();
  });
  assert.match(
    errors.join('\n'),
    /in Panel/,
    '<box> alone never says whose box it was',
  );

  await root.unmount();
});

test('onUncaughtError takes over, and then nothing is logged or exits nonzero', async () => {
  const app = app0();
  const caught = [];
  const root = await createRoot({
    app,
    onUncaughtError: (error, info) => caught.push([error.message, info]),
  });
  root.render(
    h(
      'window',
      { width: 100, height: 60 },
      h('box', {
        style: { width: 40, height: 20 },
        onClick: () => {
          throw new Error('boom');
        },
      }),
    ),
  );
  await tick();

  let exitCode;
  const errors = await captured(async () => {
    process.exitCode = undefined;
    pressButton(app.windows[0], 10, 10);
    await tick();
    exitCode = process.exitCode;
  });

  assert.strictEqual(caught.length, 1, 'the root handler saw it');
  assert.strictEqual(caught[0][0], 'boom');
  assert.strictEqual(caught[0][1].handler, 'onClick');
  assert.strictEqual(caught[0][1].element, '<box>');
  assert.deepStrictEqual(errors, [], 'and the default said nothing');
  assert.strictEqual(
    exitCode,
    undefined,
    'a kiosk that wants to crash loudly decides that itself',
  );

  await root.unmount();
});

test('the root handler is dropped on unmount, so the default comes back', async () => {
  const app = app0();
  const caught = [];
  const first = await createRoot({
    app,
    onUncaughtError: (error) => caught.push(error.message),
  });
  first.render(h('window', { width: 100, height: 60 }));
  await tick();
  await first.unmount();

  const second = await createRoot({ app });
  second.render(
    h(
      'window',
      { width: 100, height: 60 },
      h('box', {
        style: { width: 40, height: 20 },
        onClick: () => {
          throw new Error('boom');
        },
      }),
    ),
  );
  await tick();

  const errors = await captured(async () => {
    pressButton(app.windows[app.windows.length - 1], 10, 10);
    await tick();
  });
  assert.deepStrictEqual(caught, [], 'the unmounted root heard nothing');
  assert.match(errors.join('\n'), /boom/, 'the default is back');

  await second.unmount();
});
