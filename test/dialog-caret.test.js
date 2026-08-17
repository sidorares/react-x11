// The caret inside a `<Dialog>` (issue #333).
//
// A field is focused when the focus manager says so, and it *draws a caret*
// when it has been told so — `defaultFocus`, which is also what arms the
// blink. Two answers, and a managed `<popup>` is where they came apart: the
// dialog is a real window, so the window manager moves the X input focus off
// the owner and onto it, while the focused node lives in the owner's manager
// because a popup shares its owner's focus (`focusManager`, events.js). The
// owner heard "the keyboard left" and the popup heard "the keyboard arrived",
// and neither of them was both the one holding the node and the one holding
// the keyboard. The field drew its `:focus` ring and never a caret.
//
// Everything here therefore mounts against the in-process X server and then
// **plays the window manager**, because the missing step is the one a WM
// takes: `SetInputFocus` on the dialog. The harness does that once at mount
// for the window it mounted (harness.js) and no session has a WM that stops
// there — which is why the field looked fine under `react-x11/test` and was
// broken on a display.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';

import {
  renderX11,
  cleanup,
  act,
  windowNodesOf,
  countPixels,
  userEvent,
  XK_ESCAPE,
} from '../src/testing/index.js';
import { Dialog } from '../src/index.js';
import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const require = createRequire(import.meta.url);
const FONT = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
  'KaTeX_Main-Regular.ttf',
);
const fonts = { 'sans-serif': FONT };

// Not a colour any surface, border or glyph in the tree is, so a pixel of it
// is the caret and nothing else.
const CARET = '#ff00ff';

afterEach(cleanup);

/**
 * The window manager hands `node`'s window the keyboard — one `SetInputFocus`
 * and the FocusOut/FocusIn pair the server sends because of it. Injection
 * runs inside the server against the state it has *now*, so the request has
 * to have arrived before anything is read back (harness.js says the same
 * about event masks).
 */
async function windowManagerFocuses(api, node) {
  api.app.X.SetInputFocus(node.window.id, 2 /* RevertToParent */);
  await new Promise((resolve) => setImmediate(resolve));
  await act();
}

/** The `<popup>` the `Dialog` opened — its own X window, and its own ctx. */
function popupOf(api) {
  const popup = windowNodesOf(api.windowNode).find((w) => w.isPopup);
  assert.ok(popup, 'the dialog opened a <popup>');
  return popup;
}

/** How many caret-coloured pixels `node` is drawing, read back off the X
 * window it is actually in — which for a dialog is not the one that mounted. */
async function caretPixels(node) {
  const ctx = node.root.window.getContext('2d');
  const { x, y, width, height } = node.abs;
  return countPixels(ctx, { x, y, width, height }, CARET, 4);
}

const field = (props) =>
  h('textinput', {
    placeholder: 'in dialog',
    caretColor: CARET,
    style: { height: 28 },
    ...props,
  });

/** An owner window with a dialog over it — the reproduction in the issue. */
function OwnerWithDialog({ children, onClose = () => {} }) {
  return h(
    'window',
    { width: 380, height: 200, title: 'owner' },
    h('box', { style: { padding: 16 } }, h('text', null, 'owner')),
    h(
      Dialog,
      { open: true, title: 'D', width: 300, height: 150, onClose },
      children,
    ),
  );
}

/**
 * React first, and the act flag back off afterwards: the focus events below
 * are emitted the way the server emits them, outside `act`, and React warns
 * about every update they cause while the flag is still on.
 */
async function flush(fn) {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await React.act(async () => {
      await fn?.();
    });
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  await new Promise((resolve) => setImmediate(resolve));
}

const mount = (children, props) =>
  renderX11(h(OwnerWithDialog, { children, ...props }), {
    wrap: false,
    fonts,
  });

test('an autoFocus field in a Dialog draws its caret once the dialog has the keyboard', async () => {
  const api = await mount(field({ autoFocus: true }));
  const input = api.getByPlaceholder('in dialog');

  await windowManagerFocuses(api, popupOf(api));

  assert.strictEqual(input.focused, true, 'the field has focus');
  assert.strictEqual(
    input.states[':focus'],
    true,
    'and is drawn focused — the half that was never in doubt',
  );
  assert.ok(
    (await caretPixels(input)) > 0,
    'and there is a caret in it, which is the half the user was missing',
  );
});

test('so does a <textarea>', async () => {
  const api = await mount(
    h('textarea', {
      autoFocus: true,
      placeholder: 'in dialog',
      caretColor: CARET,
      style: { height: 48 },
    }),
  );
  const area = api.getByPlaceholder('in dialog');

  await windowManagerFocuses(api, popupOf(api));

  assert.strictEqual(area.focused, true);
  assert.ok((await caretPixels(area)) > 0, 'a caret in the textarea');
});

test("Dialog's own fallback focus survives the same move", async () => {
  // Nothing claims `autoFocus`, so the dialog surface takes focus itself
  // (Dialog.js) — the thing that gives Escape and Tab somewhere to land.
  const closed = [];
  const api = await mount(field(), { onClose: () => closed.push('close') });
  const input = api.getByPlaceholder('in dialog');
  const popup = popupOf(api);
  assert.strictEqual(input.focused, false, 'the field did not ask for focus');

  await windowManagerFocuses(api, popup);

  // the keys now arrive at the *dialog's* window, which is the whole of what
  // moved, and the trap still answers them
  await userEvent.tab();
  assert.strictEqual(input.focused, true, 'Tab reached the field');
  assert.ok((await caretPixels(input)) > 0, 'and the field draws a caret');
  assert.strictEqual(
    api.server.focus.wid,
    popup.window.id,
    'without the dialog having to give the keyboard back to get one',
  );

  await userEvent.key(XK_ESCAPE);
  assert.deepStrictEqual(closed, ['close'], 'and Escape still closes it');
});

test('a field focused while the dialog already holds the keyboard draws a caret too', async () => {
  // The other order: the WM focuses the dialog first and `focus()` runs
  // afterwards, which is what a click or a Tab inside an open dialog does.
  const api = await mount(field());
  const input = api.getByPlaceholder('in dialog');
  await windowManagerFocuses(api, popupOf(api));

  input.focus();
  await act();

  assert.strictEqual(input.focused, true);
  assert.ok(
    (await caretPixels(input)) > 0,
    'the caret is on without waiting for another focus event',
  );
});

test('focusing inside an open dialog does not pull the keyboard back to its owner', async () => {
  // `focus()` asks the server for the input focus when the focus does not
  // have it — and asking on behalf of a node in a dialog that *does* have it
  // would hand the keyboard back to the window underneath.
  const api = await mount(field());
  const input = api.getByPlaceholder('in dialog');
  const popup = popupOf(api);
  await windowManagerFocuses(api, popup);

  input.focus();
  await act();

  assert.strictEqual(
    api.server.focus.wid,
    popup.window.id,
    'the dialog still has the X input focus',
  );
});

test('the caret goes out when the whole application loses the keyboard', async () => {
  // The dialog holds it, so the dialog is the window that has to lose it —
  // the owner lost it when the dialog opened and has nothing left to give.
  const api = await mount(field({ autoFocus: true }));
  const input = api.getByPlaceholder('in dialog');
  await windowManagerFocuses(api, popupOf(api));
  assert.ok((await caretPixels(input)) > 0, 'a caret to begin with');

  api.app.X.SetInputFocus(1 /* PointerRoot */, 2);
  await new Promise((resolve) => setImmediate(resolve));
  await act();

  assert.strictEqual(input.focused, true, 'the field keeps focus…');
  assert.strictEqual(
    await caretPixels(input),
    0,
    '…and stops drawing a caret, the way a browser blur does',
  );
});

// The order the two focus events arrive in is the X server's and the window
// manager's, not ours: closing a dialog can put the owner's FocusIn before
// the dialog's FocusOut. Whichever lands last has to leave the same answer,
// so both orders are pinned — against the mock app, which is the only place
// the order is ours to choose.
for (const order of ['blur first', 'focus first']) {
  test(`the dialog's caret comes on whichever way round the focus events arrive (${order})`, async () => {
    const app = createMockApp();
    const root = await createRoot({ app });
    let input = null;
    await flush(() =>
      root.render(
        h(OwnerWithDialog, {
          children: field({ autoFocus: true, ref: (n) => (input = n) }),
        }),
      ),
    );

    const [owner, popup] = app.windows;
    if (order === 'blur first') {
      owner.emit('blur', {});
      popup.emit('focus', {});
    } else {
      popup.emit('focus', {});
      owner.emit('blur', {});
    }

    assert.strictEqual(input.focused, true, 'the field has focus');
    assert.strictEqual(
      input._focused,
      true,
      'and has been told so — the caret and its blink live behind this flag',
    );
    await root.unmount();
  });
}

test('a dialog closing hands the keyboard back to the field underneath', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  let outside = null;
  const Owner = ({ open }) =>
    h(
      'window',
      { width: 380, height: 200, title: 'owner' },
      h('textinput', {
        autoFocus: true,
        ref: (n) => (outside = n),
        style: { height: 28 },
      }),
      h(
        Dialog,
        { open, title: 'D', width: 300, height: 150, onClose: () => {} },
        field({ autoFocus: true }),
      ),
    );

  await flush(() => root.render(h(Owner, { open: true })));
  const [owner, popup] = app.windows;
  owner.emit('blur', {});
  popup.emit('focus', {});

  await flush(() => root.render(h(Owner, { open: false })));
  // the WM gives it back to the owner, which is the event the record of
  // "the dialog is holding the keyboard" has to be undone by
  owner.emit('focus', {});

  assert.strictEqual(outside.focused, true, 'focus went back to the owner');
  assert.strictEqual(
    outside._focused,
    true,
    'and the field it went back to is drawing a caret again',
  );
  await root.unmount();
});
