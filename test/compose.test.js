// Composition (#272): dead keys and the Compose key, from the state machine
// up to a character landing in a `<textinput>` with one undo entry behind it.
//
// The unit half drives `Composer` directly, because that is where the rules
// live — X's fallback, the stacking, the abandon. The rest goes through the
// event pipeline, since the whole bug being fixed was a *missing state*
// between an X key event and an insert, and only the pipeline has both ends.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

import { createRoot } from '../src/index.js';
import { registerElement, unregisterElement } from '../src/host.js';
import { Node } from '../src/node.js';
import {
  Composer,
  composeTable,
  parseCompose,
  builtinCompose,
} from '../src/compose.js';
import {
  keysymOf,
  XK_MULTI_KEY,
  XK_DEAD_ACUTE,
  XK_DEAD_BREVE,
  XK_DEAD_CIRCUMFLEX,
  XK_DEAD_DIAERESIS,
  XK_DEAD_STROKE,
  XK_ESCAPE,
  XK_LEFT,
  XK_SHIFT_L,
  XK_SPACE,
  isDeadKeysym,
} from '../src/keysyms.js';
import {
  renderX11,
  cleanup,
  act,
  screen,
  userEvent,
  countPixels,
} from '../src/testing/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const require = createRequire(import.meta.url);
const FONTS = {
  'sans-serif': path.join(
    path.dirname(require.resolve('katex/package.json')),
    'dist',
    'fonts',
    'KaTeX_Main-Regular.ttf',
  ),
};

/** Feed a whole sequence, returning what each key produced. */
function sequence(keys, table) {
  const composer = new Composer(table);
  return keys.map((key) =>
    composer.feed(typeof key === 'string' ? keysymOf(key) : key),
  );
}

/** What a sequence typed, in order — the empty string for a key that only
 * moved the machine along. */
const typed = (keys, table) =>
  sequence(keys, table)
    .map((r) => r.text ?? '')
    .join('');

// --- the machine -----------------------------------------------------------

test('a dead key composes with the letter after it', () => {
  const steps = sequence([XK_DEAD_ACUTE, 'e']);
  // the accent shows while it waits: pressing it has to say something
  assert.equal(steps[0].preedit, '´');
  assert.equal(steps[0].text, null);
  assert.equal(steps[0].consumed, true);
  assert.equal(steps[1].text, 'é');
  assert.equal(steps[1].preedit, '');
  assert.equal(typed([XK_DEAD_DIAERESIS, 'o']), 'ö');
  assert.equal(typed([XK_DEAD_CIRCUMFLEX, 'a']), 'â');
});

test('every base letter, not a table of the ones somebody listed', () => {
  // Unicode's composition, so scripts nobody wrote an entry for work too
  assert.equal(typed([XK_DEAD_BREVE, 'и']), 'й');
  assert.equal(typed([XK_DEAD_ACUTE, 'α']), 'ά');
  assert.equal(typed([XK_DEAD_DIAERESIS, 'y']), 'ÿ');
  // …and a mark on a letter Unicode has no single character for is not a
  // character: it falls back rather than leaving a combining mark loose
  assert.equal(typed([XK_DEAD_ACUTE, 'и']), '´и');
});

test('a sequence that composes nothing types what was pressed', () => {
  // X's rule: a failed composition swallows nothing
  assert.equal(typed([XK_DEAD_ACUTE, 'q']), '´q');
  assert.equal(typed([XK_MULTI_KEY, 'z', 'q']), 'zq');
});

test('a dead key and a space is the accent itself', () => {
  assert.equal(typed([XK_DEAD_ACUTE, XK_SPACE]), '´');
  // …and so is pressing it twice, which is how most layouts spell it
  assert.equal(typed([XK_DEAD_ACUTE, XK_DEAD_ACUTE]), '´');
});

test('dead keys stack', () => {
  const steps = sequence([XK_DEAD_CIRCUMFLEX, XK_DEAD_ACUTE, 'e']);
  assert.equal(steps[1].preedit, '^´');
  assert.equal(steps[2].text, 'ế');
});

test('the pairs Unicode will not compose are named by hand', () => {
  assert.equal(typed([XK_DEAD_STROKE, 'o']), 'ø');
  assert.equal(typed([XK_DEAD_STROKE, 'd']), 'đ');
});

test('Multi_key sequences, in both the orders the Compose file spells', () => {
  assert.equal(typed([XK_MULTI_KEY, 'o', 'c']), '©');
  assert.equal(typed([XK_MULTI_KEY, 'T', 'M']), '™');
  assert.equal(typed([XK_MULTI_KEY, '-', '-', '-']), '—');
  assert.equal(typed([XK_MULTI_KEY, '=', 'e']), '€');
  assert.equal(typed([XK_MULTI_KEY, "'", 'e']), 'é');
  assert.equal(typed([XK_MULTI_KEY, 'e', "'"]), 'é');
  assert.equal(typed([XK_MULTI_KEY, ',', 'c']), 'ç');
  assert.equal(typed([XK_MULTI_KEY, 'o', 'a']), 'å');
});

test('the Compose key shows a mark of its own while it waits', () => {
  const steps = sequence([XK_MULTI_KEY, 'o']);
  assert.equal(steps[0].preedit, '·');
  assert.equal(steps[1].preedit, '·o');
  // …and that mark is never typed: it is a note about the keyboard
  assert.equal(typed([XK_MULTI_KEY, 'z', 'z']), 'zz');
});

test('Escape abandons the sequence, typing nothing', () => {
  const steps = sequence([XK_DEAD_ACUTE, XK_ESCAPE]);
  assert.equal(steps[1].consumed, true);
  assert.equal(steps[1].text, null);
  assert.equal(steps[1].preedit, '');
});

test('Backspace un-presses the last key of the sequence', () => {
  const composer = new Composer();
  composer.feed(XK_MULTI_KEY);
  composer.feed(keysymOf('o'));
  assert.equal(composer.preedit, '·o');
  composer.feed(0xff08 /* BackSpace */);
  assert.equal(composer.preedit, '·');
  composer.feed(0xff08);
  assert.equal(composer.composing, false);
});

test('a modifier does not break a sequence', () => {
  // reaching a capital means pressing Shift, and pressing Shift is a key
  const steps = sequence([XK_DEAD_ACUTE, XK_SHIFT_L, 'E']);
  assert.equal(steps[1].consumed, false);
  assert.equal(steps[1].preedit, null);
  assert.equal(steps[2].text, 'É');
});

test('a key with no character of its own gets its turn back', () => {
  // an arrow after a pending accent: the accent is typed, and the arrow is
  // still an arrow — `consumed` false is what hands it on
  const steps = sequence([XK_DEAD_ACUTE, XK_LEFT]);
  assert.equal(steps[1].consumed, false);
  assert.equal(steps[1].text, '´');
});

test('probing does not move the machine', () => {
  const composer = new Composer();
  composer.feed(XK_DEAD_ACUTE);
  const first = composer.probe(keysymOf('e'));
  const second = composer.probe(keysymOf('e'));
  assert.equal(first.text, 'é');
  assert.deepEqual(first, second);
  assert.equal(composer.preedit, '´');
});

test('keys outside composition are none of its business', () => {
  const steps = sequence(['a', 'b']);
  assert.ok(steps.every((s) => !s.consumed && s.text === null));
});

test('isDeadKeysym covers the block and nothing else', () => {
  assert.equal(isDeadKeysym(XK_DEAD_ACUTE), true);
  assert.equal(isDeadKeysym(XK_MULTI_KEY), false);
  assert.equal(isDeadKeysym(keysymOf('a')), false);
});

// --- the table and its seam ------------------------------------------------

test('an app can add sequences of its own', () => {
  const table = composeTable({
    sequences: [
      [[XK_MULTI_KEY, keysymOf('l'), keysymOf('d')], '🦆'],
      // and override a built-in, which is what a Compose file mostly does
      [[XK_MULTI_KEY, keysymOf('o'), keysymOf('c')], 'CC'],
    ],
  });
  assert.equal(typed([XK_MULTI_KEY, 'l', 'd'], table), '🦆');
  assert.equal(typed([XK_MULTI_KEY, 'o', 'c'], table), 'CC');
  // the built-ins are still there beside them, and untouched for everyone else
  assert.equal(typed([XK_MULTI_KEY, 'T', 'M'], table), '™');
  assert.equal(typed([XK_MULTI_KEY, 'o', 'c'], builtinCompose()), '©');
});

test('compose: false is composition off, not an empty table', () => {
  assert.equal(composeTable(false), null);
});

test('parses X Compose files', () => {
  const { sequences, skipped } = parseCompose(`
# a comment
<Multi_key> <x> <y>          : "zz"   somename
<dead_acute> <e>             : "é"    eacute
<Multi_key> <numbersign>     : "#"
<Multi_key> <q> <q>          : "\\""
include "%L"
<Greek_alpha> <a>            : "aa"
`);
  const table = composeTable({ sequences });
  assert.equal(typed([XK_MULTI_KEY, 'x', 'y'], table), 'zz');
  assert.equal(typed([XK_MULTI_KEY, 'q', 'q'], table), '"');
  // a line naming keysyms outside ASCII and the dead block is counted, not
  // guessed at
  assert.equal(skipped, 1);
});

test('a Compose file overrides the built-in it collides with', () => {
  const { sequences } = parseCompose('<Multi_key> <o> <c> : "(c)"\n');
  const table = composeTable({ sequences });
  assert.equal(typed([XK_MULTI_KEY, 'o', 'c'], table), '(c)');
});

// --- through the event pipeline --------------------------------------------

const MOD = { Shift: 1, Control: 4 };

/** One keydown, as ntk decorates it. */
function press(app, keysym, { codepoint, ctrl = false } = {}) {
  const keycode = ((keysym ?? codepoint) % 248) + 8;
  app.X.keycode2keysyms[keycode] = [keysym ?? codepoint];
  app.windows[0].emit('keydown', {
    keycode,
    keysym,
    codepoint,
    buttons: ctrl ? MOD.Control : 0,
  });
}

const typeKey = (app, char) =>
  press(app, keysymOf(char), { codepoint: char.codePointAt(0) });

const treeOf = (app) => app.windows[0]._reactX11Node;

function find(node, pred) {
  if (pred(node)) return node;
  for (const child of node.children) {
    const hit = find(child, pred);
    if (hit) return hit;
  }
  return null;
}

async function mountInput(props = {}, options = {}) {
  const app = createMockApp();
  const root = await createRoot({ app, ...options });
  root.render(h('window', { width: 300, height: 200 }, h('textinput', props)));
  await tick();
  const input = find(treeOf(app), (n) => n.kind === 'textinput');
  input.focus();
  return { app, root, input };
}

test('a dead key sequence types one character into a <textinput>', async () => {
  const { app, input } = await mountInput({ defaultValue: '' });
  press(app, XK_DEAD_ACUTE);
  assert.equal(input.value, '', 'the dead key types nothing on its own');
  typeKey(app, 'e');
  assert.equal(input.value, 'é');
});

test('a composed character is one undo entry', async () => {
  const { app, input } = await mountInput({ defaultValue: '' });
  press(app, XK_DEAD_ACUTE);
  typeKey(app, 'e');
  assert.equal(input.value, 'é');
  input.undo();
  assert.equal(input.value, '', 'undo steps over the character, not into it');
  assert.equal(input.canUndo, false);
});

test('the preedit shows, and is not the value', async () => {
  const { app, input } = await mountInput({ defaultValue: 'ab' });
  press(app, XK_DEAD_ACUTE);
  assert.equal(input.value, 'ab');
  assert.equal(input._preedit, '´');
  assert.equal(input._displayValue(), 'ab´', 'drawn at the caret');
  typeKey(app, 'e');
  assert.equal(input._preedit, '');
  assert.equal(input.value, 'abé');
});

test('Escape abandons a composition without reaching the element', async () => {
  const escapes = [];
  const { app, input } = await mountInput({
    defaultValue: 'x',
    onKeyDown: (ev) => {
      if (ev.keysym === XK_ESCAPE) escapes.push(ev.composing);
    },
  });
  press(app, XK_DEAD_ACUTE);
  press(app, XK_ESCAPE);
  assert.equal(input.value, 'x');
  assert.equal(input._preedit, '');
  // the application still hears the key — it is the composer that ate it,
  // and `composing` is how a handler tells this Escape from a dismissal
  assert.deepEqual(escapes, [true]);
});

test('a composing key carries no text of its own', async () => {
  const seen = [];
  const { app } = await mountInput({
    defaultValue: '',
    onKeyDown: (ev) => seen.push([ev.composing, ev.key, ev.codepoint]),
  });
  press(app, XK_MULTI_KEY);
  typeKey(app, 'o');
  typeKey(app, 'c');
  // every key of the sequence: composing, and with no `key`/`codepoint` —
  // an app that types from onKeyDown would otherwise insert `oc` and then ©
  assert.deepEqual(seen, [
    [true, undefined, undefined],
    [true, undefined, undefined],
    [true, undefined, undefined],
  ]);
});

test('an application chord still wins over composition', async () => {
  const { app, input } = await mountInput({
    defaultValue: '',
    onKeyDown: (ev) => {
      if (ev.keysym === XK_DEAD_ACUTE) ev.preventDefault();
    },
  });
  press(app, XK_DEAD_ACUTE);
  assert.equal(input._preedit, '', 'the composer never saw it');
  // …and the state machine is where it was, so the next key is ordinary text
  typeKey(app, 'e');
  assert.equal(input.value, 'e');
});

test('composition events arrive in the DOM order', async () => {
  const events = [];
  const record = (ev) => events.push([ev.type, ev.data]);
  const { app } = await mountInput({
    defaultValue: '',
    onCompositionStart: record,
    onCompositionUpdate: record,
    onCompositionEnd: record,
  });
  press(app, XK_DEAD_ACUTE);
  typeKey(app, 'e');
  assert.deepEqual(events, [
    ['compositionStart', ''],
    ['compositionUpdate', '´'],
    ['compositionEnd', 'é'],
  ]);
});

test('preventing the end event keeps the text out', async () => {
  const { app, input } = await mountInput({
    defaultValue: '',
    onCompositionEnd: (ev) => ev.preventDefault(),
  });
  press(app, XK_DEAD_ACUTE);
  typeKey(app, 'e');
  assert.equal(input.value, '');
});

test('a controlled value rewritten mid-composition does not corrupt it', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  let setValue;
  function Form() {
    const [value, set] = React.useState('a');
    setValue = set;
    return h('textinput', { value, onChange: (ev) => set(ev.value) });
  }
  root.render(h('window', { width: 300, height: 200 }, h(Form)));
  await tick();
  const input = find(treeOf(app), (n) => n.kind === 'textinput');
  input.focus();

  press(app, XK_DEAD_ACUTE);
  // The parent rewrites the value while the accent is pending — the classic
  // controlled-input-during-composition bug. The preedit is not in the
  // value, so there is nothing here to corrupt: the accent survives, and it
  // commits at the caret, which is exactly where an ordinary keystroke
  // would have gone (the caret was at 1 and a shorter value only clamps it).
  await act(() => setValue('xyz'));
  assert.equal(input._preedit, '´');
  typeKey(app, 'e');
  await tick();
  assert.equal(input.value, 'xéyz');
});

test('focus leaving discards the composition', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    h(
      'window',
      { width: 300, height: 200 },
      h('textinput', { defaultValue: '' }),
      h('textinput', { defaultValue: '' }),
    ),
  );
  await tick();
  const window = treeOf(app);
  const inputs = [];
  find(window, (n) => {
    if (n.kind === 'textinput') inputs.push(n);
    return false;
  });
  inputs[0].focus();
  press(app, XK_DEAD_ACUTE);
  assert.equal(inputs[0]._preedit, '´');
  inputs[1].focus();
  assert.equal(inputs[0]._preedit, '', 'the accent went with the focus');
  assert.equal(inputs[0].value, '');
  typeKey(app, 'e');
  assert.equal(inputs[1].value, 'e', 'and did not follow it either');
});

// --- the seam a registered element sees ------------------------------------

const registered = new Set();
afterEach(() => {
  for (const type of registered) unregisterElement(type);
  registered.clear();
});

class EditorNode extends Node {
  constructor(props, app) {
    super('composeedit', props, app);
    this.focusableByDefault = true;
    this.log = [];
  }

  defaultKeyDown(ev) {
    this.log.push(`key:${ev.keysym}`);
  }

  defaultComposition(ev) {
    this.log.push(`${ev.type}:${ev.data}`);
  }
}

test('a composing key never reaches the element default action', async () => {
  registerElement('composeedit', {
    create: (p, app) => new EditorNode(p, app),
    childrenAllowed: false,
    override: true,
  });
  registered.add('composeedit');
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    h(
      'window',
      { width: 300, height: 200 },
      h('composeedit', { autoFocus: true }),
    ),
  );
  await tick();
  const editor = find(treeOf(app), (n) => n.kind === 'composeedit');
  editor.focus();
  editor.log.length = 0;

  press(app, XK_MULTI_KEY);
  typeKey(app, 'o');
  typeKey(app, 'c');
  assert.deepEqual(editor.log, [
    'compositionStart:',
    'compositionUpdate:·',
    'compositionUpdate:·o',
    'compositionEnd:©',
  ]);

  // and an ordinary key still is one
  typeKey(app, 'z');
  assert.deepEqual(editor.log.slice(-1), [`key:${keysymOf('z')}`]);
});

test('an element that forwards keys elsewhere is not composed for', async () => {
  // `<foreign>` hands the raw key to an embedded client that has an input
  // method of its own, so composing here would eat the dead key on its way
  // out and hand back a character with nowhere to go
  registerElement('forwardedit', {
    create: (p, app) => {
      const node = new EditorNode(p, app);
      node.kind = 'forwardedit';
      node.composes = false;
      return node;
    },
    childrenAllowed: false,
    override: true,
  });
  registered.add('forwardedit');
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h('window', { width: 300, height: 200 }, h('forwardedit', {})));
  await tick();
  const editor = find(treeOf(app), (n) => n.kind === 'forwardedit');
  editor.focus();
  editor.log.length = 0;

  press(app, XK_DEAD_ACUTE);
  typeKey(app, 'e');
  // both keys arrive whole, and no composition happened on this side
  assert.deepEqual(editor.log, [
    `key:${XK_DEAD_ACUTE}`,
    `key:${keysymOf('e')}`,
  ]);
});

// --- pixels ----------------------------------------------------------------

test('the composition is underlined, and the underline goes on commit', async () => {
  const { ctx } = await renderX11(
    h('textinput', {
      autoFocus: true,
      defaultValue: '',
      style: {
        width: 160,
        height: 30,
        color: '#000000',
        backgroundColor: '#ffffff',
        fontSize: 20,
      },
    }),
    { fonts: FONTS, wrap: true },
  );
  const field = screen.getByRole('textbox');
  const box = field.getClientRects()[0];
  const region = {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
  const ink = () => countPixels(ctx, region, '#000000', 40);

  const empty = await ink();
  await userEvent.key(0xfe57 /* dead_diaeresis */, { target: field });
  const composing = await ink();
  assert.ok(
    composing > empty,
    `a pending accent draws something (${empty} → ${composing})`,
  );

  await userEvent.type(field, 'o', { skipClick: true });
  assert.equal(field.value, 'ö');
  const committed = await ink();
  // the character it composed is drawn, and the underline under it is not:
  // `ö` is wider than nothing but it has lost the line the preedit had
  assert.ok(committed > empty, 'the composed character is drawn');
  assert.ok(
    committed < composing + Math.round(box.width * 0.2),
    'the underline is gone',
  );
  await cleanup();
});
