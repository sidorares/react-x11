// The WM close handshake: which windows advertise WM_DELETE_WINDOW, and what
// happens to a close request no `onCloseRequest` answered.
//
// The arming half is asserted through `defaultPrevented`: react-x11 always
// prevents ntk's default (destroying the window under the reconciler), so a
// close event that comes back prevented is one a listener received, and an
// untouched one is a window that never armed the protocol.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function closeEvent() {
  const ev = {
    name: 'close',
    time: 0,
    defaultPrevented: false,
    preventDefault() {
      ev.defaultPrevented = true;
    },
  };
  return ev;
}

/** Run `fn` with console.warn captured. */
async function withWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test('a lone window arms WM_DELETE_WINDOW with no onCloseRequest', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(React.createElement('window', { width: 100, height: 80 }));
  await tick();

  const ev = closeEvent();
  app.windows[0].emit('close', ev);
  await tick();

  assert.strictEqual(
    ev.defaultPrevented,
    true,
    'the window is listening, so the WM can ask instead of killing us',
  );
});

test('closing the primary window unmounts the tree', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  const cleaned = [];
  function App() {
    React.useEffect(() => () => cleaned.push('effect'), []);
    return React.createElement('window', { width: 100, height: 80 });
  }
  root.render(React.createElement(App));
  await tick();
  const wnd = app.windows[0];

  wnd.emit('close', closeEvent());
  await tick();

  assert.strictEqual(wnd.destroyed, true, 'the window went away');
  assert.deepStrictEqual(
    cleaned,
    ['effect'],
    'effects cleaned up — the whole point of not being XKillClient-ed',
  );
});

test('onCloseRequest replaces the default: no unmount unless it says so', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  const seen = [];
  root.render(
    React.createElement('window', {
      width: 100,
      height: 80,
      onCloseRequest: () => seen.push('asked'),
    }),
  );
  await tick();
  const wnd = app.windows[0];

  wnd.emit('close', closeEvent());
  await tick();

  assert.deepStrictEqual(seen, ['asked']);
  assert.strictEqual(
    wnd.destroyed,
    false,
    'the handler decides; a window that ignores the request stays open',
  );
});

test('a second window refuses rather than guessing at app state', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement('window', { width: 100, height: 80, title: 'main' }),
      React.createElement('window', { width: 90, height: 70, title: 'second' }),
    ),
  );
  await tick();
  assert.strictEqual(app.windows.length, 2);
  const [main, second] = app.windows;

  const warnings = await withWarnings(async () => {
    second.emit('close', closeEvent());
    await tick();
  });

  assert.strictEqual(second.destroyed, false, 'not closed behind React');
  assert.strictEqual(main.destroyed, false, 'and the app did not quit');
  assert.strictEqual(warnings.length, 1, 'said out loud in dev');
  assert.match(warnings[0], /onCloseRequest/);
  assert.match(warnings[0], /second/, 'names the window that went inert');

  // repeated clicks are one piece of news, not a running commentary
  const again = await withWarnings(async () => {
    second.emit('close', closeEvent());
    await tick();
  });
  assert.deepStrictEqual(again, []);
});

test('closing the primary window still quits with a second window open', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement('window', { width: 100, height: 80, title: 'main' }),
      React.createElement('window', { width: 90, height: 70, title: 'second' }),
    ),
  );
  await tick();

  app.windows[0].emit('close', closeEvent());
  await tick();

  assert.strictEqual(app.windows[0].destroyed, true);
  assert.strictEqual(
    app.windows[1].destroyed,
    true,
    'the satellite goes with the app it belonged to',
  );
});

test('a dialog is not the primary window; the plain one behind it is', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  // declared in dialog-first order, so ordering alone would get this wrong
  root.render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement('window', {
        width: 90,
        height: 70,
        title: 'dialog',
        windowType: 'dialog',
      }),
      React.createElement('window', { width: 100, height: 80, title: 'main' }),
    ),
  );
  await tick();
  const [dialog, main] = app.windows;

  await withWarnings(async () => {
    dialog.emit('close', closeEvent());
    await tick();
  });
  assert.strictEqual(main.destroyed, false, 'a dialog closing is not a quit');

  main.emit('close', closeEvent());
  await tick();
  assert.strictEqual(main.destroyed, true, 'the plain window is the app');
});

test('a lone window is the app whatever type it declares', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    React.createElement('window', {
      width: 100,
      height: 80,
      windowType: 'utility',
    }),
  );
  await tick();

  app.windows[0].emit('close', closeEvent());
  await tick();

  assert.strictEqual(
    app.windows[0].destroyed,
    true,
    'a one-window app has to be closable however it labels its window',
  );
});

test('windows the WM does not frame never arm the protocol', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    React.createElement(
      'window',
      { width: 300, height: 200, title: 'main' },
      // a region: a real X subwindow, but inside the frame, with no close
      // button of its own
      React.createElement('window', { width: 50, height: 50, x: 10, y: 10 }),
      // a menu: override-redirect, so the WM does not manage it either
      React.createElement('popup', { width: 60, height: 40 }),
    ),
  );
  await tick();
  const [, child, popup] = app.windows;

  for (const [what, wnd] of [
    ['child <window>', child],
    ['<popup>', popup],
  ]) {
    const ev = closeEvent();
    wnd.emit('close', ev);
    await tick();
    assert.strictEqual(
      ev.defaultPrevented,
      false,
      `${what} has no close listener: the property would be dead weight`,
    );
  }
});

test('a WM-managed popup is a dialog and does arm', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  const seen = [];
  root.render(
    React.createElement(
      'window',
      { width: 300, height: 200, title: 'main' },
      React.createElement('popup', {
        width: 60,
        height: 40,
        overrideRedirect: false,
        grab: false,
        onCloseRequest: () => seen.push('asked'),
      }),
    ),
  );
  await tick();

  const popup = app.windows[app.windows.length - 1];
  const ev = closeEvent();
  popup.emit('close', ev);
  await tick();

  assert.strictEqual(ev.defaultPrevented, true);
  assert.deepStrictEqual(seen, ['asked']);
});
