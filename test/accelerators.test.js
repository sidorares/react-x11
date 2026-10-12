// Menu accelerators (#351): a `shortcut` a menu draws is a `shortcut` the
// menu answers.
//
// Before this, `shortcut` was measured, drawn, announced as
// `aria-keyshortcuts` and handed to the panel as dbusmenu's `aas` — and
// bound nowhere, so an app wrote the binding a second time in an
// `onKeyDown` and the two drifted. The rules these tests hold to are the
// ones a hand-rolled binding gets wrong: exact on the four modifiers,
// indifferent to the locks, gated by the item's own `enabled`/`visible`,
// behind whatever the focused element consumed, and matched against the
// Latin keysym so a Cyrillic layout does not switch it off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import {
  createRoot,
  MenuBar,
  ContextMenu,
  useAccelerator,
} from '../src/index.js';
import { resetAcceleratorWarningForTests } from '../src/acceleratorhooks.js';
import {
  acceleratedItem,
  matchesChord,
  matchesShortcut,
} from '../src/accelerators.js';
import { decodeKey } from '../src/ntk.js';
import {
  keysymFromName,
  keysymOf,
  MOD,
  XK_END,
  XK_KP_ENTER,
} from '../src/keysyms.js';
import { createMockApp } from './helpers/mock-app.js';
import {
  act,
  fireEvent,
  renderX11,
  screen,
  userEvent,
} from '../src/testing/index.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The bar measures itself on the frame clock, so mounting takes a few hops. */
async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

// --- the keymap the presses below are made against -------------------------
//
// evdev keycodes, the US positions, so `physicalLatinTable` fingerprints the
// scheme and the Cyrillic case has something to fall back to.

const XK_ESCAPE = 0xff1b;
const XK_BACKSPACE = 0xff08;
const XK_TAB = 0xff09;
const XK_RETURN = 0xff0d;
const XK_SPACE = 0x20;

const ANCHORS = {
  9: [XK_ESCAPE],
  22: [XK_BACKSPACE],
  23: [XK_TAB],
  36: [XK_RETURN],
  65: [XK_SPACE],
};

/** keycode → the pair a US layout puts on it. */
const US = { ...ANCHORS };
for (const [first, chars] of [
  [10, '1234567890'],
  [24, 'qwertyuiop'],
  [38, "asdfghjkl;'"],
  [52, 'zxcvbnm,./'],
]) {
  for (let i = 0; i < chars.length; i++) {
    US[first + i] = [keysymOf(chars[i]), keysymOf(chars[i].toUpperCase())];
  }
}
// the two keys whose shifted level is a different symbol rather than a capital
US[20] = [keysymOf('-'), keysymOf('_')];
US[21] = [keysymOf('='), keysymOf('+')];

const KEYCODE = {
  s: 39,
  c: 54,
  k: 45,
  r: 27,
  equal: 21,
};

const CYRILLIC_es = 0x06d3; // с — the Russian layout's C key
const CYRILLIC_ES = 0x06f3;

/**
 * One key, decoded the way a live connection decodes it — ntk's `decodeKey`
 * against the client's keymap and the event's state field — so the modifier
 * mask these tests hand over is the same mask X would have sent.
 */
function press(app, keycode, state = 0) {
  const key = decodeKey(app.X.keycode2keysyms[keycode], state);
  app.windows[0].emit('keydown', { keycode, buttons: state, ...key });
}

async function mount(element, { keymap = US, ...options } = {}) {
  const app = createMockApp();
  Object.assign(app.X.keycode2keysyms, keymap);
  const root = await createRoot({ app, ...options });
  root.render(h('window', { width: 420, height: 240 }, element));
  await settle();
  return { app, root };
}

/** A second binding on the chord the menu above claims. */
function Palette({ fired }) {
  useAccelerator([['Control', 'S']], () => fired.push('palette'));
  return null;
}

const findNode = (node, pred) => {
  if (pred(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, pred);
    if (found) return found;
  }
  return null;
};

// --- the matcher, on its own -----------------------------------------------

const ev = (keysym, mods = {}) => ({ keysym, codepoint: keysym, ...mods });

test('a chord matches its key with the modifiers it names, and no others', () => {
  const save = ['Control', 'S'];
  assert.equal(matchesChord(ev(keysymOf('s'), { ctrlKey: true }), save), true);
  assert.equal(matchesChord(ev(keysymOf('s')), save), false, 'no Control');
  assert.equal(
    matchesChord(ev(keysymOf('s'), { ctrlKey: true, shiftKey: true }), save),
    false,
    'Ctrl+Shift+S is a different shortcut',
  );
  assert.equal(
    matchesChord(ev(keysymOf('s'), { ctrlKey: true, altKey: true }), save),
    false,
  );
  assert.equal(
    matchesChord(ev(keysymOf('d'), { ctrlKey: true }), save),
    false,
    'a different key',
  );
});

test('the key is the key, not the character it types', () => {
  // dbusmenu carries the key, so `['Control', 's']` and `['Control', 'S']`
  // are one binding — which is also what stops a menu drawing two of them.
  for (const spelling of ['s', 'S']) {
    assert.equal(
      matchesChord(ev(keysymOf('s'), { ctrlKey: true }), ['Control', spelling]),
      true,
    );
  }
});

test('a chord with Shift needs Shift', () => {
  const chord = ['Control', 'Shift', 'S'];
  assert.equal(
    matchesChord(ev(keysymOf('s'), { ctrlKey: true, shiftKey: true }), chord),
    true,
  );
  assert.equal(
    matchesChord(ev(keysymOf('s'), { ctrlKey: true }), chord),
    false,
  );
});

test('a symbol chord matches the character the key produced', () => {
  // `+` is the shifted `=` on every US keyboard, so a matcher that only
  // compared the base keysym would draw Ctrl++ and never fire it.
  const zoomIn = ['Control', 'plus'];
  const shifted = {
    keysym: keysymOf('='),
    codepoint: keysymOf('+'),
    ctrlKey: true,
    shiftKey: true,
  };
  assert.equal(matchesChord(shifted, zoomIn), true);
  // and the letters stay out of that path, which is the whole reason it is
  // narrow: this is exactly how Ctrl+Shift+S would fire a Ctrl+S binding
  assert.equal(
    matchesChord(
      {
        keysym: keysymOf('s'),
        codepoint: keysymOf('S'),
        ctrlKey: true,
        shiftKey: true,
      },
      ['Control', 'S'],
    ),
    false,
  );
});

test('`aas` is a list of alternatives, and any of them counts', () => {
  const shortcut = [['Control', 'S'], ['F2']];
  assert.equal(
    matchesShortcut(ev(keysymOf('s'), { ctrlKey: true }), shortcut),
    true,
  );
  assert.equal(matchesShortcut(ev(keysymFromName('F2')), shortcut), true);
  assert.equal(matchesShortcut(ev(keysymFromName('F3')), shortcut), false);
  assert.equal(
    matchesShortcut(ev(keysymOf('s')), 'Ctrl+S'),
    false,
    'a string binds nothing',
  );
});

test("under a primary of 'Super', `Control` is ⌘ and ⌃ is not a match", () => {
  // The Cocoa backend's rule (`app.primaryModifier`): the key the menu bar
  // installs and the row prints for `['Control', 'S']` is ⌘S, so that is
  // the key the binding answers — and exactly that key, on the same four
  // bits as anywhere else.
  const mac = { primary: 'Super' };
  const save = ['Control', 'S'];
  const s = keysymOf('s');
  assert.equal(matchesChord(ev(s, { metaKey: true }), save, mac), true, '⌘S');
  assert.equal(matchesChord(ev(s, { ctrlKey: true }), save, mac), false, '⌃S');
  assert.equal(
    matchesChord(ev(s, { ctrlKey: true, metaKey: true }), save, mac),
    false,
    '⌃⌘S is a different chord',
  );
  assert.equal(
    matchesChord(ev(s, { metaKey: true, shiftKey: true }), save, mac),
    false,
    '⇧⌘S is Save As',
  );
  assert.equal(
    matchesChord(
      ev(s, { metaKey: true, shiftKey: true }),
      ['Control', 'Shift', 'S'],
      mac,
    ),
    true,
  );
  // `Super` is ⌘ there too, and naming both is still one ⌘
  for (const chord of [
    ['Super', 'S'],
    ['Control', 'Super', 'S'],
  ]) {
    assert.equal(matchesChord(ev(s, { metaKey: true }), chord, mac), true);
  }
  assert.equal(
    matchesShortcut(ev(s, { metaKey: true }), [['F2'], save], mac),
    true,
    'and matchesShortcut passes it on',
  );
  // with no primary, or Control's, the chord means what it says
  assert.equal(matchesChord(ev(s, { metaKey: true }), save), false);
  assert.equal(
    matchesChord(ev(s, { ctrlKey: true }), save, { primary: 'Control' }),
    true,
  );
  // …and acceleratedItem finds the item the row says ⌘S beside
  const item = { label: 'Save', shortcut: [save] };
  assert.equal(acceleratedItem([item], ev(s, { metaKey: true }), mac), item);
  assert.equal(acceleratedItem([item], ev(s, { ctrlKey: true }), mac), null);
});

test('the token vocabulary is the one the menu draws from', () => {
  // The names are X11's, which is what `gdk_keyval_name()` emits and what a
  // panel's importer parses — so the matcher and the row read one table.
  assert.equal(keysymFromName('Return'), XK_RETURN);
  assert.equal(keysymFromName('Prior'), 0xff55);
  assert.equal(keysymFromName('bracketleft'), keysymOf('['));
  assert.equal(keysymFromName('space'), 0x20);
  assert.equal(keysymFromName('F11'), 0xffc8);
  assert.equal(keysymFromName('nonesuch'), undefined);
});

test('a disabled or hidden item is not reachable by its chord either', () => {
  const items = [
    { label: 'Save', shortcut: [['Control', 'S']], enabled: false },
    { label: 'Quit', shortcut: [['Control', 'Q']], visible: false },
    {
      label: 'More',
      items: [{ label: 'Deep', shortcut: [['Control', 'D']] }],
    },
    {
      label: 'Locked',
      enabled: false,
      items: [{ label: 'Inner', shortcut: [['Control', 'I']] }],
    },
  ];
  const chord = (letter) => ev(keysymOf(letter), { ctrlKey: true });
  assert.equal(acceleratedItem(items, chord('s')), null, 'disabled');
  assert.equal(acceleratedItem(items, chord('q')), null, 'hidden');
  assert.equal(
    acceleratedItem(items, chord('d'))?.label,
    'Deep',
    'in a submenu',
  );
  assert.equal(
    acceleratedItem(items, chord('i')),
    null,
    'a disabled parent gates the submenu it cannot be opened to',
  );
});

// --- through a mounted menu ------------------------------------------------

const MENUS = (fired) => [
  {
    label: 'File',
    items: [
      {
        label: 'New',
        shortcut: [['Control', 'N']],
        onSelect: () => fired.push('new'),
      },
      { type: 'separator' },
      {
        label: 'Save',
        shortcut: [['Control', 'S']],
        onSelect: () => fired.push('save'),
      },
      {
        label: 'Save As…',
        shortcut: [['Control', 'Shift', 'S']],
        onSelect: () => fired.push('save-as'),
      },
      {
        label: 'Revert',
        enabled: false,
        shortcut: [['Control', 'R']],
        onSelect: () => fired.push('revert'),
      },
      {
        label: 'More',
        items: [
          {
            label: 'Close All',
            shortcut: [['Control', 'K']],
            onSelect: () => fired.push('close-all'),
          },
        ],
      },
    ],
  },
];

test('a shortcut on a mounted MenuBar fires the item it is drawn on', async () => {
  const fired = [];
  const { app, root } = await mount(
    h(MenuBar, {
      menus: MENUS(fired),
      globalMenu: false,
      onSelect: (i) => fired.push(`bar:${i.label}`),
    }),
  );

  press(app, KEYCODE.s, MOD.Control);
  await settle();
  assert.deepEqual(
    fired,
    ['save', 'bar:Save'],
    "the item's own handler, then the bar's",
  );

  // and a submenu's item, which is the case a shortcut exists for: the
  // command is two menus deep and the chord is one key
  press(app, KEYCODE.k, MOD.Control);
  await settle();
  assert.equal(fired.at(-2), 'close-all');

  await root.unmount();
});

test('Ctrl+S does not fire Ctrl+Shift+S, and the locks are not modifiers', async () => {
  const fired = [];
  const { app, root } = await mount(
    h(MenuBar, { menus: MENUS(fired), globalMenu: false }),
  );

  press(app, KEYCODE.s, MOD.Control | MOD.Shift);
  await settle();
  assert.deepEqual(fired, ['save-as'], 'the shifted item, not the plain one');

  // Caps Lock and Num Lock are on. They are not in the comparison at all —
  // which is the single line every hand-rolled binding gets wrong.
  press(app, KEYCODE.s, MOD.Control | MOD.Lock | MOD.Mod2);
  await settle();
  assert.deepEqual(fired, ['save-as', 'save']);

  await root.unmount();
});

test("a disabled item's chord fires nothing", async () => {
  const fired = [];
  const { app, root } = await mount(
    h(MenuBar, { menus: MENUS(fired), globalMenu: false }),
  );
  press(app, KEYCODE.r, MOD.Control);
  await settle();
  assert.deepEqual(fired, []);
  await root.unmount();
});

test('`accelerators={false}` leaves the chords to the app', async () => {
  const fired = [];
  const { app, root } = await mount(
    h(MenuBar, { menus: MENUS(fired), globalMenu: false, accelerators: false }),
  );
  press(app, KEYCODE.s, MOD.Control);
  await settle();
  assert.deepEqual(fired, [], 'drawn, announced, exported — and not bound');
  await root.unmount();
});

test('a ContextMenu binds its items too', async () => {
  const fired = [];
  const items = [
    {
      label: 'Copy',
      shortcut: [['Control', 'C']],
      onSelect: () => fired.push('copy'),
    },
  ];
  const { app, root } = await mount(
    h(ContextMenu, { items, style: { flexGrow: 1 } }, h('text', null, 'body')),
  );
  press(app, KEYCODE.c, MOD.Control);
  await settle();
  assert.deepEqual(fired, ['copy']);
  await root.unmount();
});

// --- who gets the key first ------------------------------------------------

test('a focused text field keeps the chords it answers, and passes on the rest', async () => {
  const fired = [];
  const menus = [
    {
      label: 'Edit',
      items: [
        {
          label: 'Copy',
          shortcut: [['Control', 'C']],
          onSelect: () => fired.push('menu-copy'),
        },
        {
          label: 'Save',
          shortcut: [['Control', 'S']],
          onSelect: () => fired.push('menu-save'),
        },
      ],
    },
  ];
  const { app, root } = await mount(
    h(
      React.Fragment,
      null,
      h(MenuBar, { menus, globalMenu: false }),
      h('textinput', { defaultValue: 'hello' }),
    ),
  );
  const input = findNode(
    app.windows[0]._reactX11Node,
    (n) => n.kind === 'textinput',
  );
  input.focus();
  await settle();

  // Ctrl+C is the field's: it is what copies a selection, and the menu row
  // saying so is describing the field's own behaviour, not competing with it
  press(app, KEYCODE.c, MOD.Control);
  await settle();
  assert.deepEqual(fired, [], 'the field consumed it');

  // Ctrl+S is nobody's in a text field, so it reaches the menu — a field
  // that swallowed every chord would be a field no app can put a shortcut
  // behind
  press(app, KEYCODE.s, MOD.Control);
  await settle();
  assert.deepEqual(fired, ['menu-save']);

  await root.unmount();
});

test('an application handler still wins, by the ordinary preventDefault', async () => {
  const fired = [];
  const menus = [
    {
      label: 'File',
      items: [
        {
          label: 'Save',
          shortcut: [['Control', 'S']],
          onSelect: () => fired.push('menu'),
        },
      ],
    },
  ];
  const { app, root } = await mount(
    h(
      'box',
      {
        focusable: true,
        onKeyDown: (kev) => {
          if (kev.ctrlKey && kev.keysym === keysymOf('s')) {
            fired.push('app');
            kev.preventDefault();
          }
        },
      },
      h(MenuBar, { menus, globalMenu: false }),
    ),
  );
  const box = findNode(
    app.windows[0]._reactX11Node,
    (n) => n.props?.onKeyDown && n.props?.focusable,
  );
  box.focus();
  await settle();

  press(app, KEYCODE.s, MOD.Control);
  await settle();
  assert.deepEqual(fired, ['app']);
  await root.unmount();
});

// Return and Space are the keys a field submits with and a clickable box is
// pressed with — and Ctrl, Alt or Super on them makes a chord, a command,
// which both used to answer as the plain key, `preventDefault()` and all. So
// a menu row that printed Ctrl+Return fired from anywhere but the two places
// focus usually is (#935). Through the in-process X server, with the
// modifiers really held, so the mask is the one ntk decodes.

const RETURN_MENUS = (fired) => [
  {
    label: 'Run',
    items: [
      {
        label: 'Run',
        shortcut: [['Control', 'Return']],
        onSelect: () => fired.push('run'),
      },
      {
        label: 'Run in place',
        shortcut: [['Alt', 'Return']],
        onSelect: () => fired.push('run-alt'),
      },
      {
        label: 'Run elsewhere',
        shortcut: [['Super', 'Return']],
        onSelect: () => fired.push('run-super'),
      },
      {
        label: 'Toggle',
        shortcut: [['Control', 'space']],
        onSelect: () => fired.push('toggle'),
      },
    ],
  },
];

/** The chords above, pressed one after another, and what each fired. */
async function pressChords(fired) {
  const out = {};
  for (const [name, keysym, modifiers] of [
    ['Ctrl+Return', XK_RETURN, ['Control']],
    ['Alt+Return', XK_RETURN, ['Alt']],
    ['Super+Return', XK_RETURN, ['Super']],
    ['Ctrl+Space', XK_SPACE, ['Control']],
  ]) {
    fired.length = 0;
    await userEvent.key(keysym, { modifiers });
    out[name] = [...fired];
  }
  return out;
}

const CHORDS_FIRED = {
  'Ctrl+Return': ['run'],
  'Alt+Return': ['run-alt'],
  'Super+Return': ['run-super'],
  'Ctrl+Space': ['toggle'],
};

test('a modified Return in a text field is a shortcut, not a submit', async () => {
  const fired = [];
  const { unmount } = await renderX11(
    h(
      'window',
      { width: 400, height: 200 },
      h(MenuBar, { menus: RETURN_MENUS(fired), globalMenu: false }),
      h('textinput', {
        'data-testname': 'submits',
        defaultValue: 'hi',
        onSubmit: () => fired.push('submit'),
        style: { width: 200, height: 24 },
      }),
      // no `onSubmit`: nothing here answers Return, modified or not
      h('textinput', {
        'data-testname': 'plain',
        defaultValue: 'hi',
        style: { width: 200, height: 24 },
      }),
    ),
  );

  for (const name of ['submits', 'plain']) {
    await userEvent.click(screen.getByTestName(name));
    assert.deepEqual(await pressChords(fired), CHORDS_FIRED, name);
    assert.equal(screen.getByTestName(name).value, 'hi', 'and typed nothing');
  }

  // the keys without a chord are the field's, as they always were — Shift
  // included, which is not a command and submits in every toolkit's entry
  await userEvent.click(screen.getByTestName('submits'));
  fired.length = 0;
  await userEvent.key(XK_RETURN);
  await userEvent.key(XK_KP_ENTER);
  await userEvent.key(XK_RETURN, { modifiers: ['Shift'] });
  assert.deepEqual(fired, ['submit', 'submit', 'submit']);
  fired.length = 0;
  await userEvent.key(XK_KP_ENTER, { modifiers: ['Control'] });
  assert.deepEqual(fired, [], 'Ctrl+keypad Enter is a chord too');

  await unmount();
});

test('a text field with no onSubmit leaves Return to the shortcuts', async () => {
  // The field's answer to Return is `onSubmit`, and one with none has no
  // answer — so a form's `[['Return']]` reaches its default button from
  // inside the field, which is what Qt does with a line edit nobody
  // connected. A field that does submit keeps the key.
  const fired = [];
  function Form() {
    useAccelerator([['Return']], () => fired.push('default-button'));
    return h(
      'box',
      null,
      h('textinput', {
        'data-testname': 'submits',
        onSubmit: () => fired.push('submit'),
        style: { width: 200, height: 24 },
      }),
      h('textinput', {
        'data-testname': 'plain',
        style: { width: 200, height: 24 },
      }),
    );
  }
  const { unmount } = await renderX11(
    h('window', { width: 400, height: 200 }, h(Form)),
  );

  await userEvent.click(screen.getByTestName('submits'));
  await userEvent.key(XK_RETURN);
  assert.deepEqual(fired, ['submit'], 'the field took it');

  fired.length = 0;
  await userEvent.click(screen.getByTestName('plain'));
  await userEvent.key(XK_RETURN);
  assert.deepEqual(fired, ['default-button'], 'nothing took it, so it went on');

  await unmount();
});

test('a modified Return in a textarea is a shortcut, not a newline', async () => {
  // Plain and Shift+Return type a newline; Ctrl+Return is the field's
  // submit when it has an `onSubmit` and nobody's when it has none; Alt and
  // Super are chords, which a textarea types nothing for
  const fired = [];
  const { unmount } = await renderX11(
    h(
      'window',
      { width: 400, height: 200 },
      h(MenuBar, { menus: RETURN_MENUS(fired), globalMenu: false }),
      h('textarea', {
        'data-testname': 'area',
        defaultValue: 'x',
        style: { width: 200, height: 60 },
      }),
      h('textarea', {
        'data-testname': 'submits',
        defaultValue: 'x',
        onSubmit: () => fired.push('submit'),
        style: { width: 200, height: 60 },
      }),
    ),
  );
  const area = screen.getByTestName('area');
  await userEvent.click(area);
  assert.deepEqual(await pressChords(fired), CHORDS_FIRED);
  assert.equal(area.value, 'x', 'no newline, and no space either');

  fired.length = 0;
  await userEvent.key(XK_END);
  await userEvent.key(XK_RETURN);
  await userEvent.key(XK_RETURN, { modifiers: ['Shift'] });
  assert.equal(area.value, 'x\n\n', 'the unmodified keys are still text');
  assert.deepEqual(fired, []);

  // Ctrl+Return is a binding of the field's own, as Ctrl+C is: with an
  // `onSubmit` the field answers it and the menu does not
  await userEvent.click(screen.getByTestName('submits'));
  await userEvent.key(XK_RETURN, { modifiers: ['Control'] });
  assert.deepEqual(fired, ['submit']);

  await unmount();
});

test('a modified Return or Space on a clickable box is a shortcut, not a click', async () => {
  const fired = [];
  const { unmount } = await renderX11(
    h(
      'window',
      { width: 400, height: 200 },
      h(MenuBar, { menus: RETURN_MENUS(fired), globalMenu: false }),
      h(
        'box',
        {
          'data-testname': 'clickable',
          focusable: true,
          onClick: (ev) => fired.push(ev.shiftKey ? 'shift-click' : 'click'),
          style: { width: 100, height: 24 },
        },
        h('text', null, 'clickable'),
      ),
    ),
  );
  await userEvent.click(screen.getByTestName('clickable'));
  assert.deepEqual(await pressChords(fired), CHORDS_FIRED);

  // #329's keys are untouched: Return and Space press it, and Shift still
  // reads as a shift-click rather than as a chord
  fired.length = 0;
  await userEvent.key(XK_RETURN);
  await userEvent.key(XK_SPACE);
  await userEvent.key(XK_KP_ENTER);
  await userEvent.key(XK_RETURN, { modifiers: ['Shift'] });
  assert.deepEqual(fired, ['click', 'click', 'click', 'shift-click']);

  await unmount();
});

test('nothing fires while the menu itself is open', async () => {
  const fired = [];
  const { app, root } = await mount(
    h(MenuBar, { menus: MENUS(fired), globalMenu: false }),
  );
  const bar = app.windows[0]._reactX11Node.children[0];
  const fileTitle = bar.children[0];
  // open it the way a pointer does — a menu holds a grab from here on
  fileTitle.root.events.dispatch(
    'MouseDown',
    fileTitle,
    { x: fileTitle.abs.x + 2, y: fileTitle.abs.y + 2, buttons: 0 },
    { button: 1, detail: 1 },
  );
  await settle();
  assert.ok(app.windows.length > 1, 'the menu is up');

  press(app, KEYCODE.s, MOD.Control);
  await settle();
  assert.deepEqual(fired, [], 'the open menu owns the keyboard');

  await root.unmount();
});

test('a modal popup takes the shortcuts with the keyboard', async () => {
  const fired = [];

  function App({ modal }) {
    return h(
      React.Fragment,
      null,
      h(MenuBar, { menus: MENUS(fired), globalMenu: false }),
      modal &&
        h(
          'popup',
          { x: 20, y: 20, width: 120, height: 80, trapFocus: true },
          h('box', { focusable: true }),
        ),
    );
  }

  const app = createMockApp();
  Object.assign(app.X.keycode2keysyms, US);
  const root = await createRoot({ app });
  root.render(
    h('window', { width: 420, height: 240 }, h(App, { modal: false })),
  );
  await settle();

  press(app, KEYCODE.s, MOD.Control);
  await settle();
  assert.deepEqual(fired, ['save']);

  root.render(
    h('window', { width: 420, height: 240 }, h(App, { modal: true })),
  );
  await settle();
  press(app, KEYCODE.s, MOD.Control);
  await settle();
  assert.deepEqual(fired, ['save'], 'Ctrl+S saves nothing behind a modal');

  root.render(
    h('window', { width: 420, height: 240 }, h(App, { modal: false })),
  );
  await settle();
  press(app, KEYCODE.s, MOD.Control);
  await settle();
  assert.deepEqual(fired, ['save', 'save'], 'and works again once it closes');

  await root.unmount();
});

test('a throwing accelerator is reported, and takes the key with it', async () => {
  const fired = [];
  const menus = [
    {
      label: 'File',
      items: [
        {
          label: 'Save',
          shortcut: [['Control', 'S']],
          onSelect: () => {
            throw new Error('boom');
          },
        },
      ],
    },
  ];
  const errors = [];
  const original = console.error;
  const code = process.exitCode;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    const { app, root } = await mount(
      h(
        React.Fragment,
        null,
        // the palette binds Ctrl+S first, so the bar — mounted after it —
        // is the one that answers, and the one that throws
        h(Palette, { fired }),
        h(MenuBar, { menus, globalMenu: false }),
      ),
    );
    press(app, KEYCODE.s, MOD.Control);
    await settle();
    await root.unmount();
  } finally {
    console.error = original;
    process.exitCode = code;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /an accelerator/);
  assert.deepEqual(
    fired,
    [],
    'the chord is spent: a second binding does not run because the first threw',
  );
});

// --- layouts ---------------------------------------------------------------

test('a Cyrillic layout does not switch the shortcuts off', async () => {
  // `ru,us`: group 1 is Cyrillic, so the key types `с` while `ev.keysym`
  // still says `c` — which is the whole of why a menu can bind a chord
  // without knowing that layouts exist. This is the thing that silently
  // regresses, hence a test with a keymap and not a unit assertion.
  const fired = [];
  const items = [
    {
      label: 'Copy',
      shortcut: [['Control', 'C']],
      onSelect: () => fired.push('copy'),
    },
  ];
  const { app, root } = await mount(
    h(ContextMenu, { items, style: { flexGrow: 1 } }, h('text', null, 'body')),
    {
      keymap: {
        ...US,
        [KEYCODE.c]: [CYRILLIC_es, CYRILLIC_ES, keysymOf('c'), keysymOf('C')],
      },
    },
  );
  press(app, KEYCODE.c, MOD.Control);
  await settle();
  assert.deepEqual(fired, ['copy'], 'Ctrl+С copied');
  await root.unmount();
});

test('a keymap with no Latin group at all still answers — XQuartz', async () => {
  // XQuartz overwrites the keymap from the active macOS layout, so after a
  // switch to Russian nothing in it holds Latin and the keycode's physical
  // position is the only thing left that means "the C key".
  const fired = [];
  const items = [
    {
      label: 'Copy',
      shortcut: [['Control', 'C']],
      onSelect: () => fired.push('copy'),
    },
  ];
  const { app, root } = await mount(
    h(ContextMenu, { items, style: { flexGrow: 1 } }, h('text', null, 'body')),
    {
      keymap: {
        44: [XK_RETURN],
        56: [XK_TAB],
        57: [XK_SPACE],
        59: [XK_BACKSPACE],
        61: [XK_ESCAPE],
        16: [CYRILLIC_es, CYRILLIC_ES, 0, 0], // the macOS C keycode
      },
    },
  );
  press(app, 16, MOD.Control);
  await settle();
  assert.deepEqual(fired, ['copy']);
  await root.unmount();
});

// --- against a real server -------------------------------------------------

test('the whole path, through the in-process X server', async () => {
  // Everything above drives the mock, which hands the renderer a keymap the
  // test wrote. This one goes through node-x11's own server and
  // `react-x11/test`'s `fireEvent.key`: real keycodes, real modifier
  // presses, ntk's own decode. It is the pass that would catch a chord that
  // only matches events a test built by hand.
  const fired = [];
  const menus = [
    {
      label: 'File',
      items: [
        {
          label: 'Save',
          shortcut: [['Control', 'S']],
          onSelect: () => fired.push('save'),
        },
        {
          label: 'Save As…',
          shortcut: [['Control', 'Shift', 'S']],
          onSelect: () => fired.push('save-as'),
        },
        {
          label: 'Zoom in',
          shortcut: [['Control', 'plus']],
          onSelect: () => fired.push('zoom'),
        },
      ],
    },
  ];
  const { unmount } = await renderX11(
    h(
      'window',
      { width: 400, height: 200 },
      h(MenuBar, { menus, globalMenu: false }),
    ),
  );
  await act(() => fireEvent.key(keysymOf('s'), { modifiers: ['Control'] }));
  await act(() =>
    fireEvent.key(keysymOf('s'), { modifiers: ['Control', 'Shift'] }),
  );
  // Ctrl+Shift+= is how a US keyboard presses Ctrl++
  await act(() =>
    fireEvent.key(keysymOf('='), { modifiers: ['Control', 'Shift'] }),
  );
  assert.deepEqual(fired, ['save', 'save-as', 'zoom']);
  await unmount();
});

// --- the shortcuts that are not in a menu ----------------------------------

test('useAccelerator takes the same chords a menu does', async () => {
  const fired = [];
  function App({ enabled }) {
    useAccelerator([['Control', 'K']], () => fired.push('palette'), {
      enabled,
    });
    return h('box', { style: { flexGrow: 1 } });
  }

  const app = createMockApp();
  Object.assign(app.X.keycode2keysyms, US);
  const root = await createRoot({ app });
  root.render(
    h('window', { width: 300, height: 200 }, h(App, { enabled: true })),
  );
  await settle();

  press(app, KEYCODE.k, MOD.Control);
  await settle();
  assert.deepEqual(fired, ['palette']);

  press(app, KEYCODE.k, 0);
  await settle();
  assert.deepEqual(fired, ['palette'], 'no Control, no chord');

  root.render(
    h('window', { width: 300, height: 200 }, h(App, { enabled: false })),
  );
  await settle();
  press(app, KEYCODE.k, MOD.Control);
  await settle();
  assert.deepEqual(fired, ['palette'], '`enabled: false` unbinds it');

  await root.unmount();
});

test('an unmounted useAccelerator is unbound', async () => {
  const fired = [];
  function Palette() {
    useAccelerator([['Control', 'K']], () => fired.push('palette'));
    return null;
  }
  const app = createMockApp();
  Object.assign(app.X.keycode2keysyms, US);
  const root = await createRoot({ app });
  root.render(h('window', { width: 300, height: 200 }, h(Palette)));
  await settle();
  press(app, KEYCODE.k, MOD.Control);
  await settle();
  assert.equal(fired.length, 1);

  root.render(h('window', { width: 300, height: 200 }));
  await settle();
  press(app, KEYCODE.k, MOD.Control);
  await settle();
  assert.equal(fired.length, 1);

  await root.unmount();
});

test("a shortcut in a tray app's popover fires (#616)", async () => {
  // A menu-bar app has no `<window>` at all: the whole UI is the popover a
  // tray click opens, and `grabKeyboard` is what brings the keys to it. The
  // binding used to hang off `useTopLevelWindow()`, which left popups out,
  // find no event manager, and register nothing — silently, so the chord
  // was drawn and documented and simply never fired.
  //
  // Two bindings, because this is the pair docs/elements.md shows in the
  // tray-popover section: Space plays, Escape closes.
  const fired = [];
  function Controls() {
    useAccelerator([['space']], () => fired.push('toggle'));
    useAccelerator([['Escape']], () => fired.push('close'));
    return h('box', { style: { flexGrow: 1 } });
  }
  const app = createMockApp();
  Object.assign(app.X.keycode2keysyms, US);
  const root = await createRoot({ app });
  root.render(
    h(
      'popup',
      { x: 10, y: 10, width: 200, height: 120, grab: true, grabKeyboard: true },
      h(Controls),
    ),
  );
  await settle();

  press(app, 65 /* space */, 0);
  press(app, 9 /* Escape */, 0);
  await settle();
  assert.deepEqual(fired, ['toggle', 'close']);

  await root.unmount();
});

test('…and through the in-process X server, with no window anywhere', async () => {
  // The same tree against node-x11's own server: a real keymap, real
  // keycodes, ntk's decode, and a `<popup>` that is genuinely
  // override-redirect rather than a mock that says so.
  const fired = [];
  function Controls() {
    useAccelerator([['space']], () => fired.push('toggle'));
    return h('box', { style: { flexGrow: 1 } });
  }
  const { unmount } = await renderX11(
    h(
      'popup',
      { x: 10, y: 10, width: 200, height: 120, grabKeyboard: true },
      h(Controls),
    ),
    { wrap: false },
  );
  await act(() => fireEvent.key(XK_SPACE));
  assert.deepEqual(fired, ['toggle']);
  await unmount();
});

test('a binding with nothing to hang off says so, once', async () => {
  // The other half of #616: an anchor that resolves to nothing binds
  // nothing, and the effect runs once, so it never comes back. Development
  // says which knob fixes it rather than leaving a dead chord.
  resetAcceleratorWarningForTests();
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const app = createMockApp();
  Object.assign(app.X.keycode2keysyms, US);
  let root;
  try {
    function Shortcuts() {
      useAccelerator([['Control', 'K']], () => {});
      useAccelerator([['Control', 'R']], () => {});
      return null;
    }
    root = await createRoot({ app });
    // No window and no popup: nothing in the tree owns a keyboard.
    root.render(h(Shortcuts));
    await settle();
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1, 'once per process, not once per binding');
  assert.match(warnings[0], /scope/);
  assert.match(warnings[0], /never fire/);

  await root.unmount();
});
