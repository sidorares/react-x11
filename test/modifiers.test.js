// Alt and Super on synthetic events (#284).
//
// An X event's state field carries eight modifier rows, and the renderer
// used to decode two of them. Alt and Super are the two an application
// reaches for next — a terminal encodes Alt+key as an ESC prefix, an editor
// moves by word on Alt, a window manager owns Super — and until they were
// decoded here every one of them rediscovered `nativeEvent.buttons & 8` for
// itself.
//
// These go through the in-process server rather than a hand-built event
// object: the bit is set by pressing the real Alt_L/Super_L keycode, so what
// is tested is the mask the server computed, not one the test wrote down.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import {
  renderX11,
  cleanup,
  act,
  fireEvent,
  keysymOf,
} from '../src/testing/index.js';
import { MOD } from '../src/keysyms.js';

const h = React.createElement;

afterEach(cleanup);

/** The four booleans, in the order the event object lists them. */
const modsOf = (ev) => [ev.shiftKey, ev.ctrlKey, ev.altKey, ev.metaKey];

async function mount() {
  const events = [];
  const record = (ev) => events.push([ev.type, ...modsOf(ev)]);
  const { windowNode } = await renderX11(
    h(
      'window',
      { width: 200, height: 120, onMouseDown: record, onKeyDown: record },
      h('box', { style: { flexGrow: 1 } }),
    ),
  );
  return { events, target: windowNode.children[0] };
}

test('a press carries Alt and Super as altKey and metaKey', async () => {
  const { events, target } = await mount();

  await act(async () => fireEvent.mouseDown(target));
  assert.deepStrictEqual(
    events.at(-1),
    ['mouseDown', false, false, false, false],
    'no modifier held, none reported',
  );

  await act(async () => fireEvent.mouseDown(target, { modifiers: ['Alt'] }));
  assert.deepStrictEqual(events.at(-1), [
    'mouseDown',
    false,
    false,
    true,
    false,
  ]);

  await act(async () => fireEvent.mouseDown(target, { modifiers: ['Super'] }));
  assert.deepStrictEqual(events.at(-1), [
    'mouseDown',
    false,
    false,
    false,
    true,
  ]);

  // and they combine with each other and with the two that were always here
  await act(async () =>
    fireEvent.mouseDown(target, {
      modifiers: ['Shift', 'Control', 'Alt', 'Super'],
    }),
  );
  assert.deepStrictEqual(events.at(-1), ['mouseDown', true, true, true, true]);
});

test('a key carries them too, so Alt chords read like DOM ones', async () => {
  const { events, target } = await mount();

  await act(async () =>
    fireEvent.key(keysymOf('b'), { target, modifiers: ['Alt'] }),
  );
  assert.deepStrictEqual(events.at(-1), ['keyDown', false, false, true, false]);

  await act(async () =>
    fireEvent.key(keysymOf('l'), { target, modifiers: ['Super'] }),
  );
  assert.deepStrictEqual(events.at(-1), ['keyDown', false, false, false, true]);
});

test('the raw mask is still there for a keymap that disagrees', async () => {
  // Mod1 is Alt and Mod4 is Super by convention, not by protocol, so the
  // decode is a reading of the state field rather than a replacement for it:
  // `nativeEvent.buttons` is the mask exactly as it arrived, which is what a
  // remapped setup falls back to.
  const seen = [];
  const { windowNode } = await renderX11(
    h(
      'window',
      {
        width: 200,
        height: 120,
        onMouseDown: (ev) => seen.push(ev.nativeEvent.buttons),
      },
      h('box', { style: { flexGrow: 1 } }),
    ),
  );

  await act(async () =>
    fireEvent.mouseDown(windowNode.children[0], { modifiers: ['Alt'] }),
  );
  assert.strictEqual(seen.at(-1) & MOD.Mod1, MOD.Mod1);
});
