// The Mac's text-editing keys in <textinput> and <textarea>
// (src/nodes/textkeys.js): AppKit's own bindings, on a backend whose
// shortcuts are ⌘ (`app.primaryModifier`) — ⌥ by word, ⌘ to the ends of a
// line and of the document, ⌥⌫ and ⌘⌫, and the Emacs-style ⌃ keys.
//
// Input goes through the bridge's own event shape (`app._route`), with the
// kVK `keyCode` and the character views AppKit fills for each key, so what
// reaches the field is what a real NSEvent would make of it. The last block
// is the other half of the rule: an app whose shortcuts are Ctrl keeps the
// bindings it always had, so the Mac's are a backend's and not everyone's.
import assert from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import { cleanupCocoa, mountCocoa, tick } from './helpers/cocoa-bridge.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;

afterEach(cleanupCocoa);

// kVK codes, and the characters AppKit puts on the keys that have them
const LEFT = { keyCode: 123 };
const RIGHT = { keyCode: 124 };
const DOWN = { keyCode: 125 };
const UP = { keyCode: 126 };
const BACKSPACE = { keyCode: 51 };
const DELETE = { keyCode: 117 };
const letter = (keyCode, ch) => ({
  keyCode,
  chars: ch,
  charsShifted: ch,
  charsBase: ch,
});
const KEY = {
  a: letter(0, 'a'),
  b: letter(11, 'b'),
  d: letter(2, 'd'),
  e: letter(14, 'e'),
  f: letter(3, 'f'),
  h: letter(4, 'h'),
  k: letter(40, 'k'),
  n: letter(45, 'n'),
  p: letter(35, 'p'),
  s: letter(1, 's'),
  y: letter(16, 'y'),
};
// ⌃ turns `chars` into a control character; the other two views keep the
// letter, which is the one a chord is named by
const ctrl = (key) => ({
  ...key,
  chars: String.fromCharCode(key.chars.charCodeAt(0) & 0x1f),
  control: true,
});

/** One key as the bridge reports it: down, then up. */
function press(app, wnd, ev) {
  const base = { windowNumber: wnd.windowNumber, time: performance.now() };
  app._route({ type: 'keydown', ...base, ...ev });
  app._route({ type: 'keyup', ...base, ...ev });
}

async function mountField(element, props) {
  const ref = React.createRef();
  const changes = [];
  const mounted = await mountCocoa(
    h(element, {
      ref,
      onChange: (ev) => changes.push(ev.target.value),
      style: { width: 560 },
      ...props,
    }),
    { width: 600, height: 200 },
  );
  ref.current.focus();
  mounted.frame();
  await tick();
  const field = ref.current;
  return {
    ...mounted,
    field,
    changes,
    key: (ev) => press(mounted.app, mounted.wnd, ev),
    caret: () => field._caret,
    selected: () => field._selectedText(),
    put: (index) => {
      field._caret = index;
      field._anchor = index;
    },
  };
}

describe('<textinput>', () => {
  const TEXT = 'hello brave new world';
  const mountInput = (props = {}) =>
    mountField('textinput', { defaultValue: TEXT, ...props });

  test('premise: the cocoa app edits with ⌘', async () => {
    const { app } = await mountInput();
    assert.equal(app.primaryModifier, 'Super');
  });

  test('⌥← and ⌥→ move by word, ⌥⇧ selects by word', async () => {
    const { key, caret, put, selected } = await mountInput();
    put(8); // inside "brave"
    key({ ...LEFT, option: true });
    assert.equal(caret(), 6, 'start of "brave"');
    key({ ...LEFT, option: true });
    assert.equal(caret(), 0, 'start of "hello"');
    key({ ...RIGHT, option: true });
    assert.equal(caret(), 5, 'end of "hello"');
    key({ ...RIGHT, option: true, shift: true });
    key({ ...RIGHT, option: true, shift: true });
    assert.equal(selected(), ' brave new');
  });

  test('⌘← and ⌘→ go to the ends of the line, and ⌃← ⌃→ do too', async () => {
    // ⌃← is Mission Control's on a Mac, and AppKit binds it beside ⌘← when
    // it gets through — never to a word, which is what Ctrl means on X11
    const { key, caret, put, selected } = await mountInput();
    put(8);
    key({ ...LEFT, command: true });
    assert.equal(caret(), 0);
    key({ ...RIGHT, command: true });
    assert.equal(caret(), TEXT.length);
    put(8);
    key({ ...LEFT, control: true });
    assert.equal(caret(), 0);
    key({ ...RIGHT, control: true });
    assert.equal(caret(), TEXT.length);
    put(8);
    key({ ...RIGHT, command: true, shift: true });
    assert.equal(selected(), 'ave new world');
  });

  test('↑ ↓ and ⌘↑ ⌘↓ go to the ends of a single line, as in an NSTextField', async () => {
    const { key, caret, put } = await mountInput();
    put(8);
    key(UP);
    assert.equal(caret(), 0);
    key(DOWN);
    assert.equal(caret(), TEXT.length);
    put(8);
    key({ ...UP, command: true });
    assert.equal(caret(), 0);
    key({ ...DOWN, command: true });
    assert.equal(caret(), TEXT.length);
  });

  test('⌥⌫ and ⌥⌦ delete a word, ⌘⌫ deletes to the start of the line', async () => {
    const { key, put, changes } = await mountInput();
    put(11); // after "brave"
    key({ ...BACKSPACE, option: true });
    assert.equal(changes.at(-1), 'hello  new world');
    key({ ...DELETE, option: true });
    assert.equal(changes.at(-1), 'hello  world');
    key({ ...BACKSPACE, command: true });
    assert.equal(changes.at(-1), ' world');
  });

  test('⌃⌫ takes the mark off the character before the caret', async () => {
    const { key, field, changes } = await mountInput({ defaultValue: 'café' });
    key({ ...BACKSPACE, control: true });
    assert.equal(changes.at(-1), 'cafe');
    assert.equal(field._caret, 4);
    // …and deletes a character that has none, a character and not a word
    key({ ...BACKSPACE, control: true });
    assert.equal(changes.at(-1), 'caf');
  });

  test('⌃A and ⌃E go to the ends, ⌃B ⌃F a character, ⌃H ⌃D delete one', async () => {
    const { key, caret, put, changes, selected } = await mountInput();
    put(8);
    key(ctrl(KEY.a));
    assert.equal(caret(), 0, '⌃A is the start, not Select All');
    assert.equal(selected(), '');
    key(ctrl(KEY.e));
    assert.equal(caret(), TEXT.length);
    key(ctrl(KEY.b));
    assert.equal(caret(), TEXT.length - 1);
    key(ctrl(KEY.f));
    assert.equal(caret(), TEXT.length);
    key(ctrl(KEY.h));
    assert.equal(changes.at(-1), 'hello brave new worl');
    put(0);
    key(ctrl(KEY.d));
    assert.equal(changes.at(-1), 'ello brave new worl');
    key({ ...ctrl(KEY.e), shift: true });
    assert.equal(selected(), 'ello brave new worl', '⌃⇧E selects');
  });

  test('⌃K kills to the end and ⌃Y yanks it back', async () => {
    const { key, put, changes, field } = await mountInput();
    put(11);
    key(ctrl(KEY.k));
    assert.equal(changes.at(-1), 'hello brave');
    put(0);
    key(ctrl(KEY.y));
    assert.equal(changes.at(-1), ' new worldhello brave');
    assert.equal(field._caret, ' new world'.length);
  });

  test('a ⌃ chord the Mac does not bind types nothing', async () => {
    const { key, changes, field } = await mountInput();
    key(ctrl(KEY.s));
    key(ctrl(letter(5, 'g')));
    await tick();
    assert.deepEqual(changes, []);
    assert.equal(field.value, TEXT);
  });

  test('an onKeyDown that prevents the default keeps the key', async () => {
    const { key, caret, put } = await mountInput({
      onKeyDown: (ev) => {
        if (ev.altKey) ev.preventDefault();
      },
    });
    put(8);
    key({ ...LEFT, option: true });
    assert.equal(caret(), 8);
  });
});

describe('<textarea>', () => {
  const TEXT = 'first line\nsecond line here\nthird';
  const mountArea = (props = {}) =>
    mountField('textarea', { defaultValue: TEXT, rows: 4, ...props });
  const at = (s) => TEXT.indexOf(s);

  test('⌘↑ and ⌘↓ go to the ends of the value', async () => {
    const { key, caret, put, selected } = await mountArea();
    put(at('line here'));
    key({ ...UP, command: true });
    assert.equal(caret(), 0);
    key({ ...DOWN, command: true });
    assert.equal(caret(), TEXT.length);
    put(at('here'));
    key({ ...DOWN, command: true, shift: true });
    assert.equal(selected(), 'here\nthird');
  });

  test('⌘← and ⌘→ go to the ends of the line, not of the value', async () => {
    const { key, caret, put } = await mountArea();
    put(at('line here'));
    key({ ...LEFT, command: true });
    assert.equal(caret(), at('second'));
    key({ ...RIGHT, command: true });
    assert.equal(caret(), at('\nthird'));
  });

  test('⌥↑ and ⌥↓ go to the ends of the paragraph, then on to the next', async () => {
    const { key, caret, put } = await mountArea();
    put(at('line here'));
    key({ ...UP, option: true });
    assert.equal(caret(), at('second'));
    key({ ...UP, option: true });
    assert.equal(caret(), 0, 'already at a start: the previous paragraph');
    key({ ...DOWN, option: true });
    assert.equal(caret(), at('\nsecond'));
    key({ ...DOWN, option: true });
    assert.equal(caret(), at('\nthird'));
  });

  test('⌃A and ⌃E are the paragraph, ⌃P and ⌃N a line', async () => {
    const { key, caret, put } = await mountArea();
    put(at('line here'));
    key(ctrl(KEY.a));
    assert.equal(caret(), at('second'));
    key(ctrl(KEY.e));
    assert.equal(caret(), at('\nthird'));
    key(ctrl(KEY.p));
    assert.equal(caret(), at('\nsecond'), 'up a line, clamped to its end');
    key(ctrl(KEY.n));
    assert.equal(caret(), at('\nthird'), 'and back, to the goal column');
  });

  test('⌘⌫ deletes to the start of the line', async () => {
    const { key, put, changes } = await mountArea();
    put(at(' here'));
    key({ ...BACKSPACE, command: true });
    assert.equal(changes.at(-1), 'first line\n here\nthird');
  });

  test('⌃K ⌃K kills a line and its break, and ⌃Y yanks both', async () => {
    const { key, put, changes } = await mountArea();
    put(at('second'));
    key(ctrl(KEY.k));
    assert.equal(changes.at(-1), 'first line\n\nthird');
    key(ctrl(KEY.k));
    assert.equal(changes.at(-1), 'first line\nthird');
    put(0);
    key(ctrl(KEY.y));
    assert.equal(changes.at(-1), 'second line here\nfirst line\nthird');
  });

  test('a kill after something else starts a fresh kill', async () => {
    const { key, put, changes, field } = await mountArea();
    put(at('second'));
    key(ctrl(KEY.k));
    // the caret moved: the next kill is not part of this one
    put(field.value.indexOf('third'));
    key(ctrl(KEY.k));
    put(0);
    key(ctrl(KEY.y));
    assert.equal(changes.at(-1), 'thirdfirst line\n\n');
  });

  test('a sensitive field deletes, and keeps nothing to yank', async () => {
    const notes = React.createRef();
    const secret = React.createRef();
    const { app, wnd } = await mountCocoa(
      h(
        'box',
        null,
        h('textarea', { ref: notes, defaultValue: TEXT, rows: 4 }),
        h('textinput', {
          ref: secret,
          defaultValue: 'hunter2',
          sensitive: true,
        }),
      ),
      { width: 600, height: 200 },
    );
    notes.current.focus();
    notes.current._caret = notes.current._anchor = at('second');
    press(app, wnd, ctrl(KEY.k));

    secret.current.focus();
    secret.current._caret = secret.current._anchor = 0;
    press(app, wnd, ctrl(KEY.k));
    assert.equal(secret.current.value, '', 'the kill still deletes');

    notes.current.focus();
    notes.current._caret = notes.current._anchor = 0;
    press(app, wnd, ctrl(KEY.y));
    assert.equal(
      notes.current.value,
      'second line herefirst line\n\nthird',
      'what the other field killed, not the secret',
    );
  });

  test('one app kills, and another field of it yanks', async () => {
    const from = React.createRef();
    const to = React.createRef();
    const { app, wnd } = await mountCocoa(
      h(
        'box',
        null,
        h('textinput', { ref: from, defaultValue: 'cut this' }),
        h('textinput', { ref: to, defaultValue: '' }),
      ),
      { width: 600, height: 200 },
    );
    from.current.focus();
    from.current._caret = from.current._anchor = 3;
    press(app, wnd, ctrl(KEY.k));
    to.current.focus();
    press(app, wnd, ctrl(KEY.y));
    assert.equal(from.current.value, 'cut');
    assert.equal(to.current.value, ' this');
  });
});

describe('an app whose shortcuts are Ctrl', () => {
  test('keeps the X11 bindings: Ctrl+Left is a word, Ctrl+A is Select All', async () => {
    const app = createMockApp();
    assert.equal(app.primaryModifier, undefined, 'premise');
    const root = await createRoot({ app });
    const ref = React.createRef();
    root.render(
      h(
        'window',
        { width: 300, height: 80 },
        h('textinput', { ref, defaultValue: 'hello brave world' }),
      ),
    );
    await tick();
    const wnd = app.windows[0];
    const field = ref.current;
    field.focus();
    field._caret = field._anchor = 8;
    const pressX = (keysym, buttons) => {
      const keycode = (keysym % 248) + 8;
      app.X.keycode2keysyms[keycode] = [keysym];
      wnd.emit('keydown', { keycode, keysym, buttons });
    };
    pressX(0xff51, 4); // Ctrl+Left
    assert.equal(field._caret, 6);
    pressX(0xff51, 8); // Alt+Left: a character, not a word
    assert.equal(field._caret, 5);
    pressX(0x61, 4); // Ctrl+A
    assert.equal(field._selectedText(), 'hello brave world');
    await root.unmount();
  });
});
