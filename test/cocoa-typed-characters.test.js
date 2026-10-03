// What a key types on the cocoa backend (src/cocoa/keymap.js): the layout's
// own answer, with ⌥, Shift and Caps Lock applied.
//
// The bridge hands three views of each key: `chars` (NSEvent `characters`,
// every modifier applied), `charsShifted` (`charactersIgnoringModifiers`,
// Shift only) and `charsBase` (no modifiers). Text used to be read from
// `charsShifted`, which drops ⌥ — so ⌥S typed `s`, and a German keyboard,
// whose @, [ and { are all ⌥ keys, could not type them at all — and drops
// Caps Lock too.
//
// The events below are the ones AppKit makes for these keys: measured with
// NSEvent(cgEvent:) on the Australian (US) layout, and the German column with
// UCKeyTranslate over Apple's German layout. Nothing here has an input
// method behind it — the bridge's view is no NSTextInputClient — so a dead
// key is an event whose `chars` is empty, and the two things a real keyboard
// could put on the key after it are both covered.
import assert from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import React from 'react';

import { cleanupCocoa, mountCocoa, tick } from './helpers/cocoa-bridge.js';

const h = React.createElement;

afterEach(cleanupCocoa);

/** One key as the bridge reports it: down, then up. */
function press(app, wnd, ev) {
  const base = {
    windowNumber: wnd.windowNumber,
    time: performance.now(),
    ...ev,
  };
  app._route({ type: 'keydown', ...base });
  app._route({ type: 'keyup', ...base });
}

/** kVK codes */
const S = 1;
const E = 14;
const L = 37;
const K = 40;
const A = 0;
const FIVE = 23;

async function mountField(props = {}) {
  const input = React.createRef();
  const changes = [];
  const keys = [];
  const compositions = [];
  const mounted = await mountCocoa(
    h('textinput', {
      ref: input,
      defaultValue: '',
      onChange: (ev) => changes.push(ev.target.value),
      onKeyDown: (ev) => keys.push([ev.key, ev.keysym]),
      onCompositionEnd: (ev) => compositions.push(ev.data),
      ...props,
    }),
    { width: 300, height: 80 },
  );
  input.current.focus();
  await tick();
  return { ...mounted, input, changes, keys, compositions };
}

describe('⌥ types the character the layout puts on the key', () => {
  test('⌥S is ß, and the key the chord names is still S', async () => {
    const { app, wnd, input, changes, keys } = await mountField();
    press(app, wnd, {
      keyCode: S,
      chars: 'ß',
      charsShifted: 's',
      charsBase: 's',
      option: true,
    });
    await tick();
    assert.equal(input.current.value, 'ß');
    assert.deepEqual(changes, ['ß']);
    // `key` is what was typed, as the DOM's is on a Mac; `keysym` is the
    // key a chord names, which is what an Alt+S accelerator matches
    assert.deepEqual(keys, [['ß', 0x73]]);
  });

  test('a German keyboard types @, [ and { — all three are ⌥ keys there', async () => {
    const { app, wnd, input } = await mountField();
    press(app, wnd, {
      keyCode: L,
      chars: '@',
      charsShifted: 'l',
      charsBase: 'l',
      option: true,
    });
    press(app, wnd, {
      keyCode: FIVE,
      chars: '[',
      charsShifted: '5',
      charsBase: '5',
      option: true,
    });
    press(app, wnd, {
      keyCode: 28,
      chars: '{',
      charsShifted: '8',
      charsBase: '8',
      option: true,
    });
    await tick();
    assert.equal(input.current.value, '@[{');
  });

  test('⌥⇧K is the Apple logo, which sits in the private-use range', async () => {
    // U+F8FF is the last private-use code point, and NSEvent's function-key
    // constants are U+F700 on: the filter for the one must leave the other
    const { app, wnd, input } = await mountField();
    press(app, wnd, {
      keyCode: K,
      chars: '',
      charsShifted: 'K',
      charsBase: 'k',
      option: true,
      shift: true,
    });
    // F13 types U+F710, and that is not a character
    press(app, wnd, {
      keyCode: 105,
      chars: '',
      charsShifted: '',
      charsBase: '',
    });
    await tick();
    assert.equal(input.current.value, '');
  });

  test('Caps Lock types capitals', async () => {
    // `charactersIgnoringModifiers` leaves Caps Lock out as well as ⌥
    const { app, wnd, input } = await mountField();
    press(app, wnd, {
      keyCode: A,
      chars: 'A',
      charsShifted: 'a',
      charsBase: 'a',
      capsLock: true,
    });
    await tick();
    assert.equal(input.current.value, 'A');
  });
});

describe('a ⌘ or ⌃ chord is named by its key', () => {
  test('⌘⌥S is a chord on S, and types nothing of ⌥S', async () => {
    const pressed = [];
    const { app, wnd } = await mountField({
      onKeyDown: (ev) => {
        pressed.push([ev.key, ev.metaKey, ev.altKey]);
        ev.preventDefault();
      },
    });
    press(app, wnd, {
      keyCode: S,
      chars: 'ß',
      charsShifted: 's',
      charsBase: 's',
      command: true,
      option: true,
    });
    await tick();
    assert.deepEqual(pressed, [['s', true, true]]);
  });
});

describe('a dead key', () => {
  const DEAD_E = {
    keyCode: E,
    chars: '',
    charsShifted: 'e',
    charsBase: 'e',
    option: true,
  };

  test('types nothing on its own', async () => {
    const { app, wnd, input, changes } = await mountField();
    press(app, wnd, DEAD_E);
    await tick();
    // the key's letter is what reading `charsShifted` typed here
    assert.equal(input.current.value, '');
    assert.deepEqual(changes, []);
  });

  test('…and the key after it types what the layout composed', async () => {
    const { app, wnd, input } = await mountField();
    press(app, wnd, DEAD_E);
    press(app, wnd, {
      keyCode: E,
      chars: 'é',
      charsShifted: 'e',
      charsBase: 'e',
    });
    await tick();
    assert.equal(input.current.value, 'é');
  });

  test('…or its own letter, where the event carries no composition', async () => {
    // NSEvent(cgEvent:) carries no dead-key state between keys, and a lost
    // accent is the cost — one letter, not the `ee` reading the key's own
    // character used to make of it
    const { app, wnd, input } = await mountField();
    press(app, wnd, DEAD_E);
    press(app, wnd, { keyCode: E, chars: 'e', charsShifted: 'e' });
    await tick();
    assert.equal(input.current.value, 'e');
  });

  test('…and a key it does not combine with types both, in one edit', async () => {
    // ⌥E then S is `´s` on a layout that composes — two characters on one
    // key, which no code point carries
    const { app, wnd, input, changes, compositions } = await mountField({
      defaultValue: 'a',
    });
    press(app, wnd, { keyCode: A, chars: 'a', charsShifted: 'a' });
    press(app, wnd, DEAD_E);
    press(app, wnd, {
      keyCode: S,
      chars: '´s',
      charsShifted: 's',
      charsBase: 's',
    });
    await tick();
    assert.equal(input.current.value, 'aa´s');
    assert.deepEqual(changes, ['aa', 'aa´s']);
    assert.deepEqual(compositions, ['´s']);

    // one undo step, like any typed run
    input.current.undo();
    await tick();
    assert.equal(input.current.value, 'a');
  });

  test('an application that takes the key takes all of its text', async () => {
    const { app, wnd, input, compositions } = await mountField({
      onKeyDown: (ev) => ev.preventDefault(),
    });
    press(app, wnd, {
      keyCode: S,
      chars: '´s',
      charsShifted: 's',
      charsBase: 's',
    });
    await tick();
    assert.equal(input.current.value, '');
    assert.deepEqual(compositions, []);
  });
});
