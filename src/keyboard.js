// The accelerator half of a key event: which keysym a shortcut matches
// against when the user is typing in another script (issue #85).
//
// A key event answers two different questions and they have different
// answers the moment a non-Latin layout is active:
//
// - **text input** — the active group, the active level. `ev.codepoint` and
//   `ev.key`, both decoded by ntk against the keymap and the event's state
//   field, so a Cyrillic layout types Cyrillic.
// - **accelerators** — the *Latin* keysym for that physical key, whichever
//   group happens to hold it. `ev.keysym`, resolved here. Shortcuts do not
//   move with the layout: GTK, Qt and the browsers all resolve them this
//   way, and Ctrl+Z has to keep undoing while the user types Russian.
//
// ntk hands us group 1 level 1 as `baseKeysym`, which is the right answer
// whenever group 1 is Latin — the `us,ru` ordering everybody on Linux
// actually uses. It is the wrong answer in the two cases this module is
// for:
//
// - **`ru,us`** — the Latin layout is group 2, so group 1 level 1 is
//   `Cyrillic_ya` and a chord matched against it matches nothing. The
//   keysym we want is on the same keycode, two entries along.
// - **XQuartz** — there are no groups at all. XQuartz synthesizes the keymap
//   from the active macOS layout and *overwrites* it when the input menu
//   changes (Preferences → Input → "Follow system keyboard layout"), so
//   after a switch to Russian no group anywhere holds Latin. Nothing in the
//   keymap can answer, and the only thing left that still means "the Z key"
//   is the keycode itself.
//
// So: the base keysym if it is already Latin, else the Latin letter another
// group puts on the same keycode, else the letter the *physical position*
// carries on a US keyboard. The last step needs to know which keycodes the
// server is speaking, which is what `SCHEMES` fingerprints.

import { keysymOf } from './keysyms.js';

// Keysyms from 0xfd00 to 0xffff are keys rather than characters — Return,
// the arrows, the function row, the modifiers, ISO_Level3_Shift, the dead
// keys. They are the same in every layout and never need resolving.
const KEY_LOW = 0xfd00;

// Direct Unicode keysyms: 0x01000000 + code point.
const UNICODE_LOW = 0x01000000;
const UNICODE_HIGH = 0x0110ffff;

// The legacy keysym blocks that are not Latin script. Below 0x400 is
// Latin-1 through Latin-4; 0x800-0xbff are technical, publishing and APL
// symbols; 0x1200-0x13ff are Latin-8 and Latin-9 and 0x1e00-0x1eff is
// Vietnamese, all of them Latin. What is left is the scripts a shortcut
// cannot be written in.
const NON_LATIN_BLOCKS = [
  [0x0400, 0x04ff], // Kana
  [0x0500, 0x05ff], // Arabic
  [0x0600, 0x06ff], // Cyrillic
  [0x0700, 0x07ff], // Greek
  [0x0c00, 0x0cff], // Hebrew
  [0x0d00, 0x0dff], // Thai
  [0x0e00, 0x0eff], // Korean
  [0x1400, 0x16ff], // Armenian, Georgian, Caucasus
];

// For the direct-Unicode block, where there is no block structure to read:
// anything that is not Latin script and not script-neutral (digits,
// punctuation, symbols, spaces) is a letter of some other alphabet.
const LATIN_OR_NEUTRAL =
  /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]$/u;

/**
 * Whether a keysym is a letter of a script an accelerator cannot be written
 * in — the question that decides whether anything below runs at all.
 */
export function isNonLatinKeysym(keysym) {
  if (typeof keysym !== 'number' || keysym <= 0xff) return false;
  if (keysym >= KEY_LOW && keysym <= 0xffff) return false;
  if (keysym >= UNICODE_LOW) {
    if (keysym > UNICODE_HIGH) return false;
    return !LATIN_OR_NEUTRAL.test(String.fromCodePoint(keysym - UNICODE_LOW));
  }
  return NON_LATIN_BLOCKS.some(([lo, hi]) => keysym >= lo && keysym <= hi);
}

// An ASCII keysym is its own code point, so `a`-`z` is a range.
const LOWER_A = 0x61;
const LOWER_Z = 0x7a;
const TO_UPPER = -0x20;

/**
 * The Latin letter another group puts on this keycode, if one does.
 *
 * The core keyboard map flattens XKB's groups into pairs —
 * `[g1l1, g1l2, g2l1, g2l2, ...]` — so the second group starts at index 2.
 * What the core map cannot say is whether those two entries are a second
 * *group* or levels 3 and 4 of the first one: four keysyms on a keycode are
 * `us,ru` under one reading and `us(intl)` under the other, and the request
 * that would settle it (XkbGetMap) is not implemented downstream. ntk's
 * `decodeKey` refuses to guess and reads groups only; this refuses in the
 * other direction, by taking a later pair only when it looks like a Latin
 * letter and its own capital.
 *
 * That is deliberately narrow. An AltGr row that happens to reach an ASCII
 * symbol — macOS's Option layer is full of them — must not be mistaken for
 * a Latin layout, and a Latin *letter* pair is both the thing that is
 * unlikely to be an accident and the thing accelerators are made of.
 */
function latinInLaterGroup(syms) {
  for (let i = 2; i < syms.length; i += 2) {
    const lower = syms[i];
    const upper = syms[i + 1];
    if (lower < LOWER_A || lower > LOWER_Z) continue;
    // "if the second element is NoSymbol, the group is treated as the lower
    // and upper case of the first" — X core protocol
    if (!upper || upper === lower + TO_UPPER) return lower;
  }
  return undefined;
}

/** `{ 10: 0x31, 11: 0x32, … }` from runs of consecutive keycodes. */
function positions(runs) {
  const table = {};
  for (const [first, chars] of runs) {
    for (let i = 0; i < chars.length; i++)
      table[first + i] = chars.charCodeAt(i);
  }
  return table;
}

/**
 * What each physical key carries on a US keyboard, per keycode scheme, and
 * the layout-independent keys that identify the scheme.
 *
 * Keycodes are not a standard: they are whatever the server's input driver
 * assigns. Two schemes cover everything this renderer runs on — Linux's
 * evdev, and the macOS virtual keycodes XQuartz passes through with 8 added
 * — and they disagree everywhere, which is exactly what makes the probe
 * reliable. Return alone separates them (36 on evdev is `8` on macOS), and
 * five keys make it certain.
 */
const SCHEMES = [
  {
    name: 'evdev',
    probe: { 9: 0xff1b, 22: 0xff08, 23: 0xff09, 36: 0xff0d, 65: 0x20 },
    latin: positions([
      [10, '1234567890-='],
      [24, 'qwertyuiop[]'],
      [38, "asdfghjkl;'"],
      [49, '`'],
      [51, '\\'],
      [52, 'zxcvbnm,./'],
      [65, ' '],
    ]),
  },
  {
    name: 'macos',
    probe: { 44: 0xff0d, 56: 0xff09, 57: 0x20, 59: 0xff08, 61: 0xff1b },
    latin: positions([
      [8, 'asdfhgzxcv'],
      [19, 'b'],
      [20, 'qweryt'],
      [26, '123465=97-80'],
      [38, ']ou[ip'],
      [45, "lj'k;\\,/nm."],
      [57, ' '],
      [58, '`'],
    ]),
  },
];

/**
 * Which keycode scheme this keymap is speaking, or null if it is neither.
 *
 * The probe reads keys whose keysym no layout moves, so it answers the same
 * before and after a switch — which matters, because on XQuartz the keymap
 * it is reading is rewritten under it.
 */
export function physicalLatinTable(keycode2keysyms) {
  if (!keycode2keysyms) return null;
  for (const scheme of SCHEMES) {
    const matches = Object.entries(scheme.probe).every(
      ([keycode, keysym]) => keycode2keysyms[keycode]?.[0] === keysym,
    );
    if (matches) return scheme.latin;
  }
  return null;
}

/**
 * The keysym a shortcut matches against, given ntk's group 1 level 1 and
 * the keycode's whole row.
 *
 * `physical` is the keycode→Latin table for this server, or null when the
 * scheme is unknown — in which case a key with no Latin anywhere on it
 * keeps its own keysym, since a wrong shortcut is worse than a missing one.
 */
export function latinKeysym(base, syms, keycode, physical) {
  if (!isNonLatinKeysym(base)) return base;
  const fromGroup = syms ? latinInLaterGroup(syms) : undefined;
  if (fromGroup !== undefined) return fromGroup;
  return physical?.[keycode] ?? base;
}

/**
 * Record what `createRoot({ accelerators })` asked for.
 *
 * The default resolves; `'layout'` does not, for an application that wants
 * the keysym the key actually typed and will do its own matching. An object
 * is a keycode→Latin keysym table of your own, for a server whose keycodes
 * are neither of the two schemes above (and it still prefers a Latin group
 * on the key itself, which is the more accurate answer where there is one).
 */
export function beginKeyboard(app, accelerators) {
  if (!app || accelerators === undefined) return;
  if (accelerators === 'latin') {
    app._reactX11Accelerators = undefined;
    return;
  }
  if (accelerators === 'layout' || accelerators === false) {
    app._reactX11Accelerators = null;
    return;
  }
  if (typeof accelerators !== 'object') {
    throw new TypeError(
      `react-x11: createRoot({ accelerators }) takes 'latin', 'layout' or a ` +
        `keycode table, not ${JSON.stringify(accelerators)}.`,
    );
  }
  const table = {};
  for (const [keycode, value] of Object.entries(accelerators)) {
    table[keycode] = typeof value === 'string' ? keysymOf(value) : value;
  }
  app._reactX11Accelerators = { table };
}

/**
 * The accelerator keysym for one key event, cached per connection.
 *
 * Only the *scheme* is cached: the keymap itself is re-read on every
 * MappingNotify (ntk does that), and on XQuartz a layout switch is a
 * rewritten keymap, so the row has to be looked at fresh each time. The
 * scheme is fixed by the server's input driver and cannot change under a
 * running connection — but it is resolved lazily and not remembered until
 * it answers, because the first key can beat `GetKeyboardMapping`'s reply.
 */
export function acceleratorKeysym(app, keycode, base) {
  const config = app?._reactX11Accelerators;
  if (config === null) return base;
  // The common case, and every key event pays it: a Latin layout, or a key
  // that is a key rather than a character. One comparison and out.
  if (!isNonLatinKeysym(base)) return base;
  const syms = app?.X?.keycode2keysyms?.[keycode];
  if (config?.table) return latinKeysym(base, syms, keycode, config.table);
  if (app && !app._reactX11PhysicalLatin) {
    const table = physicalLatinTable(app.X?.keycode2keysyms);
    if (table) app._reactX11PhysicalLatin = table;
  }
  return latinKeysym(base, syms, keycode, app?._reactX11PhysicalLatin);
}
