// Keyboard layouts (#85): typing follows the active layout, shortcuts do
// not.
//
// The two halves are decided in different places and both are here. What
// the key *types* is ntk's `decodeKey` reading the active XKB group out of
// the event's state field, so these tests decode with the real one rather
// than hand-writing a codepoint onto the event — the group arithmetic is
// half of what is being tested. What a chord *matches* is `src/keyboard.js`,
// on this side, and the cases that matter are the two where group 1 is not
// Latin: `ru,us` on Linux, and XQuartz after it has overwritten the keymap
// with the macOS layout and left no Latin group anywhere.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { decodeKey } from '../src/ntk.js';
import { createRoot } from '../src/index.js';
import {
  isNonLatinKeysym,
  latinKeysym,
  physicalLatinTable,
} from '../src/keyboard.js';
import {
  keysymOf,
  XK_BACKSPACE,
  XK_ESCAPE,
  XK_RETURN,
  XK_SPACE,
  XK_TAB,
} from '../src/keysyms.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const MOD_SHIFT = 1;
const MOD_CONTROL = 4;
/** The XKB group lives in bits 13-14 of the state field. */
const group = (n) => n << 13;

const XK_z = keysymOf('z');
const XK_Z = keysymOf('Z');
const XK_c = keysymOf('c');
const XK_C = keysymOf('C');
const CYRILLIC_ya = 0x06d1; // я — the Russian layout's Z key
const CYRILLIC_YA = 0x06f1;
const CYRILLIC_es = 0x06d3; // с — its C key
const CYRILLIC_ES = 0x06f3;
const GREEK_alpha = 0x07e1;
const UNICODE_shorti = 0x0100_0439; // й as a direct Unicode keysym

// The keys whose keysym no layout moves, which is what the physical-position
// fallback fingerprints the keycode scheme with.
const EVDEV_ANCHORS = {
  9: [XK_ESCAPE],
  22: [XK_BACKSPACE],
  23: [XK_TAB],
  36: [XK_RETURN],
  65: [XK_SPACE],
};
const MACOS_ANCHORS = {
  44: [XK_RETURN],
  56: [XK_TAB],
  57: [XK_SPACE],
  59: [XK_BACKSPACE],
  61: [XK_ESCAPE],
};

// The physical Z and C keys, in each scheme's keycodes.
const EVDEV_Z = 52;
const EVDEV_C = 54;
const MACOS_Z = 14;
const MACOS_C = 16;

// --- the rule --------------------------------------------------------------

test('only a keysym from another script needs resolving', () => {
  // Latin-1 is Latin, whatever the accent
  assert.equal(isNonLatinKeysym(XK_z), false);
  assert.equal(isNonLatinKeysym(0xe9 /* eacute */), false);
  // keys rather than characters: the same on every layout
  assert.equal(isNonLatinKeysym(XK_RETURN), false);
  assert.equal(isNonLatinKeysym(0xffbe /* F1 */), false);
  assert.equal(isNonLatinKeysym(undefined), false);
  // other scripts, legacy blocks and the direct-Unicode range alike
  assert.equal(isNonLatinKeysym(CYRILLIC_ya), true);
  assert.equal(isNonLatinKeysym(GREEK_alpha), true);
  assert.equal(isNonLatinKeysym(UNICODE_shorti), true);
  // …but a direct-Unicode keysym for a Latin letter is still Latin
  assert.equal(isNonLatinKeysym(keysymOf('ł')), false);
});

test('a Latin group on the same key wins over the physical position', () => {
  // `fr,ru`: the Latin group is AZERTY, so the physical Q key is `a` — the
  // answer the keymap gives, not the one a US table would
  const azerty = [CYRILLIC_ya, CYRILLIC_YA, keysymOf('a'), keysymOf('A')];
  const physical = physicalLatinTable({ ...EVDEV_ANCHORS });
  assert.equal(latinKeysym(CYRILLIC_ya, azerty, 24, physical), keysymOf('a'));
});

test('an AltGr level that reaches ASCII is not a Latin group', () => {
  // Four keysyms on a keycode are two groups of two levels under `us,ru` and
  // one group of four levels under a layout with an AltGr row, and the core
  // map cannot say which. Only a Latin letter and its own capital counts, so
  // macOS's Option layer — full of ASCII punctuation — does not.
  const optionLayer = [CYRILLIC_ya, CYRILLIC_YA, keysymOf('/'), keysymOf('?')];
  const physical = physicalLatinTable({ ...MACOS_ANCHORS });
  assert.equal(latinKeysym(CYRILLIC_ya, optionLayer, MACOS_Z, physical), XK_z);
});

test('the keycode scheme is read off the keys no layout moves', () => {
  const evdev = physicalLatinTable({ ...EVDEV_ANCHORS });
  const macos = physicalLatinTable({ ...MACOS_ANCHORS });
  assert.equal(evdev[EVDEV_Z], XK_z);
  assert.equal(macos[MACOS_Z], XK_z);
  assert.equal(evdev[EVDEV_C], XK_c);
  assert.equal(macos[MACOS_C], XK_c);
  // the same keycode means different keys in the two schemes, which is what
  // makes the fingerprint worth taking
  assert.notEqual(evdev[MACOS_Z], XK_z);
});

test('an unknown keycode scheme keeps the key it was given', () => {
  // A wrong shortcut is worse than a missing one: with no Latin group and no
  // table, the keysym stays what the layout said.
  assert.equal(physicalLatinTable({ 1: [XK_RETURN] }), null);
  assert.equal(
    latinKeysym(CYRILLIC_ya, [CYRILLIC_ya, CYRILLIC_YA], 52, null),
    CYRILLIC_ya,
  );
});

// --- through the event pipeline --------------------------------------------

/**
 * One key, decoded the way a live connection decodes it: ntk's `decodeKey`
 * against the client's copy of the keymap and the event's state field.
 */
function press(app, keycode, state = 0) {
  const key = decodeKey(app.X.keycode2keysyms[keycode], state);
  app.windows[0].emit('keydown', { keycode, buttons: state, ...key });
}

const treeOf = (app) => app.windows[0]._reactX11Node;

function find(node, pred) {
  if (pred(node)) return node;
  for (const child of node.children) {
    const hit = find(child, pred);
    if (hit) return hit;
  }
  return null;
}

/** A `<textinput>` with focus, on a connection whose keymap is `keys`. */
async function mount(keys, options = {}) {
  const app = createMockApp();
  Object.assign(app.X.keycode2keysyms, keys);
  const root = await createRoot({ app, ...options });
  const seen = [];
  root.render(
    h(
      'window',
      { width: 300, height: 120 },
      h('textinput', { defaultValue: '', onKeyDown: (ev) => seen.push(ev) }),
    ),
  );
  await tick();
  const input = find(treeOf(app), (n) => n.kind === 'textinput');
  input.focus();
  return { app, input, seen };
}

test('the active group types, and reports itself', async () => {
  // `us,ru`: one keymap, the group chooses which half of it is live. No
  // MappingNotify is sent for a switch, so the group bits are the only
  // notice a client gets that one happened at all.
  const { app, input, seen } = await mount({
    ...EVDEV_ANCHORS,
    [EVDEV_Z]: [XK_z, XK_Z, CYRILLIC_ya, CYRILLIC_YA],
  });
  press(app, EVDEV_Z);
  press(app, EVDEV_Z, group(1));
  press(app, EVDEV_Z, group(1) | MOD_SHIFT);
  assert.equal(input.value, 'zяЯ');
  assert.deepEqual(
    seen.map((ev) => ev.group),
    [0, 1, 1],
  );
});

test('a chord matches the Latin keysym while the layout types Cyrillic', async () => {
  // `us,ru`, group 2 live: group 1 is still Latin, so this is the case that
  // worked by accident before there was a rule.
  const { app, input, seen } = await mount({
    ...EVDEV_ANCHORS,
    [EVDEV_Z]: [XK_z, XK_Z, CYRILLIC_ya, CYRILLIC_YA],
  });
  press(app, EVDEV_Z, group(1));
  assert.equal(input.value, 'я');
  press(app, EVDEV_Z, group(1) | MOD_CONTROL);
  assert.equal(input.value, '', 'Ctrl+Z undid');
  assert.equal(seen[0].keysym, XK_z);
  assert.equal(seen[0].key, 'я', 'the same key still typed Cyrillic');
});

test('a Latin group second — `ru,us` — still answers Ctrl+Z', async () => {
  const { app, input } = await mount({
    ...EVDEV_ANCHORS,
    [EVDEV_Z]: [CYRILLIC_ya, CYRILLIC_YA, XK_z, XK_Z],
    [EVDEV_C]: [CYRILLIC_es, CYRILLIC_ES, XK_c, XK_C],
  });
  press(app, EVDEV_Z);
  press(app, EVDEV_C);
  assert.equal(input.value, 'яс');
  press(app, EVDEV_Z, MOD_CONTROL);
  // one undo entry, because undo runs coalesce a word at a time
  assert.equal(input.value, '', 'Ctrl+Z undid');
});

test('a keymap with no Latin group at all — XQuartz — still answers Ctrl+Z', async () => {
  // XQuartz synthesizes the keymap from the active macOS layout and
  // overwrites it when the input menu changes, so after a switch to Russian
  // there is no group holding Latin: the keycode is the only thing left that
  // still means "the Z key".
  const { app, input } = await mount({
    ...MACOS_ANCHORS,
    [MACOS_Z]: [CYRILLIC_ya, CYRILLIC_YA, 0, 0],
  });
  press(app, MACOS_Z);
  assert.equal(input.value, 'я');
  press(app, MACOS_Z, MOD_CONTROL);
  assert.equal(input.value, '', 'Ctrl+Z undid');
});

test('`accelerators: "layout"` hands back the keysym the layout typed', async () => {
  const { app, input, seen } = await mount(
    {
      ...MACOS_ANCHORS,
      [MACOS_Z]: [CYRILLIC_ya, CYRILLIC_YA, 0, 0],
    },
    { accelerators: 'layout' },
  );
  press(app, MACOS_Z);
  press(app, MACOS_Z, MOD_CONTROL);
  assert.equal(seen[0].keysym, CYRILLIC_ya);
  assert.equal(input.value, 'я', 'nothing was undone: the chord matched no z');
});

test('`accelerators` takes a keycode table for a scheme nobody fingerprints', async () => {
  const { app, input, seen } = await mount(
    { 200: [CYRILLIC_ya, CYRILLIC_YA] },
    { accelerators: { 200: 'z' } },
  );
  press(app, 200);
  assert.equal(input.value, 'я');
  press(app, 200, MOD_CONTROL);
  assert.equal(seen[0].keysym, XK_z);
  assert.equal(input.value, '');
});

test('a name `accelerators` does not know is refused', async () => {
  // Not caught by the types: indexing a string gives a string back, so a
  // string satisfies the keycode-table half of the union.
  await assert.rejects(
    () => createRoot({ app: createMockApp(), accelerators: 'qwerty' }),
    /accelerators/,
  );
});

test('a Latin layout is untouched by any of it', async () => {
  const { app, input, seen } = await mount({
    ...EVDEV_ANCHORS,
    [EVDEV_Z]: [XK_z, XK_Z],
  });
  press(app, EVDEV_Z);
  press(app, EVDEV_Z, MOD_SHIFT);
  assert.equal(input.value, 'zZ');
  assert.deepEqual(
    seen.map((ev) => ev.keysym),
    [XK_z, XK_z],
    'the keysym does not shift, which is what a chord relies on',
  );
});
