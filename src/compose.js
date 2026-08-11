// Composition: dead keys and the Compose key, client-side.
//
// A key event carries one keysym and at most one code point, so the path
// from `EventManager._onKey` to `TextInputNode._insert` could only ever type
// what one key produces. That is enough for a US layout and for nothing
// else: `é` on a French, German or us-intl layout is `dead_acute` then `e`,
// and `dead_acute` is a keysym with no code point at all — it used to arrive
// and be dropped, so the accent vanished and the letter came out bare
// (issue #272).
//
// This is the state that was missing between those two points. It is
// entirely client-side: no X extension, no input-method process, no
// protocol. `XK_dead_*` and `XK_Multi_key` are ordinary keysyms that already
// arrive; what turns a *sequence* of them into a character is a table and a
// small machine in front of the insert.
//
// ## The table is Unicode's, not ours
//
// The obvious implementation is X's `Compose` file: six thousand lines
// mapping keysym sequences to strings. Bundling it would be 300 kB of data
// for the Latin coverage alone, and it would still be a snapshot of one
// machine's locale.
//
// A dead key *is* a combining mark, so the composition is the one Unicode
// already specifies: `dead_acute` is U+0301, and `dead_acute` + `e` is
// `'é'.normalize('NFC')`. That is 30 entries instead of 6000, it
// covers every base letter in every script — Cyrillic, Greek, Vietnamese
// with two stacked marks — and it cannot drift, because the data is the
// runtime's. Only the sequences Unicode has no canonical composition for
// need naming by hand: `dead_stroke` + `o` is `ø`, whose decomposition
// Unicode deliberately does not define, and the `Multi_key` symbol
// sequences (`Compose o c` is `©`), which are conventions rather than
// characters.
//
// ## Default, and the seam
//
// The built-in table is what an app gets with no configuration, and it is
// chosen to cover what a Latin-script keyboard can type: every dead key on
// every common layout, plus the punctuation and symbol sequences people
// actually reach for. The seam is `createRoot({ compose })` — `'system'`
// adds the machine's own Compose file (which is what picks up a personal
// `~/.XCompose`), `{ sequences }` adds or overrides individual ones, and
// `false` turns the whole thing off for an app that means to do its own.
//
// What this does *not* do is an input method: there is no preedit coming
// from another process, no candidate window, and therefore no CJK. That is
// XIM or an IBus/Fcitx D-Bus client, and it is the next tier of #272 — but
// it lands on this machinery rather than beside it, because the preedit
// buffer and the composition events it needs are the ones below.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  charOf,
  keysymOf,
  isDeadKeysym,
  XK_MULTI_KEY,
  XK_ESCAPE,
  XK_BACKSPACE,
  XK_SPACE,
  XK_DEAD_GRAVE,
  XK_DEAD_ACUTE,
  XK_DEAD_CIRCUMFLEX,
  XK_DEAD_TILDE,
  XK_DEAD_MACRON,
  XK_DEAD_BREVE,
  XK_DEAD_ABOVEDOT,
  XK_DEAD_DIAERESIS,
  XK_DEAD_ABOVERING,
  XK_DEAD_DOUBLEACUTE,
  XK_DEAD_CARON,
  XK_DEAD_CEDILLA,
  XK_DEAD_OGONEK,
  XK_DEAD_IOTA,
  XK_DEAD_VOICED_SOUND,
  XK_DEAD_SEMIVOICED_SOUND,
  XK_DEAD_BELOWDOT,
  XK_DEAD_HOOK,
  XK_DEAD_HORN,
  XK_DEAD_STROKE,
  XK_DEAD_ABOVECOMMA,
  XK_DEAD_ABOVEREVERSEDCOMMA,
  XK_DEAD_DOUBLEGRAVE,
  XK_DEAD_BELOWRING,
  XK_DEAD_BELOWMACRON,
  XK_DEAD_BELOWCIRCUMFLEX,
  XK_DEAD_BELOWTILDE,
  XK_DEAD_BELOWBREVE,
  XK_DEAD_BELOWDIAERESIS,
  XK_DEAD_INVERTEDBREVE,
  XK_DEAD_BELOWCOMMA,
  XK_DEAD_CURRENCY,
} from './keysyms.js';

/**
 * The combining mark each dead key applies. This is the whole dead-key
 * table: everything else about `dead_acute` + `e` follows from Unicode
 * normalisation.
 */
const MARKS = {
  [XK_DEAD_GRAVE]: '̀',
  [XK_DEAD_ACUTE]: '́',
  [XK_DEAD_CIRCUMFLEX]: '̂',
  [XK_DEAD_TILDE]: '̃',
  [XK_DEAD_MACRON]: '̄',
  [XK_DEAD_BREVE]: '̆',
  [XK_DEAD_ABOVEDOT]: '̇',
  [XK_DEAD_DIAERESIS]: '̈',
  [XK_DEAD_HOOK]: '̉',
  [XK_DEAD_ABOVERING]: '̊',
  [XK_DEAD_DOUBLEACUTE]: '̋',
  [XK_DEAD_CARON]: '̌',
  [XK_DEAD_DOUBLEGRAVE]: '̏',
  [XK_DEAD_INVERTEDBREVE]: '̑',
  [XK_DEAD_ABOVECOMMA]: '̓',
  [XK_DEAD_ABOVEREVERSEDCOMMA]: '̔',
  [XK_DEAD_HORN]: '̛',
  [XK_DEAD_BELOWDOT]: '̣',
  [XK_DEAD_BELOWDIAERESIS]: '̤',
  [XK_DEAD_BELOWRING]: '̥',
  [XK_DEAD_BELOWCOMMA]: '̦',
  [XK_DEAD_CEDILLA]: '̧',
  [XK_DEAD_OGONEK]: '̨',
  [XK_DEAD_BELOWCIRCUMFLEX]: '̭',
  [XK_DEAD_BELOWBREVE]: '̮',
  [XK_DEAD_BELOWTILDE]: '̰',
  [XK_DEAD_BELOWMACRON]: '̱',
  [XK_DEAD_STROKE]: '̸',
  [XK_DEAD_IOTA]: 'ͅ',
  [XK_DEAD_VOICED_SOUND]: '゙',
  [XK_DEAD_SEMIVOICED_SOUND]: '゚',
};

/**
 * What a dead key shows while it is pending, and what it types on its own —
 * `dead_acute` then space is `´`, which is how the accent character itself
 * is typed on a layout that has no separate key for it.
 *
 * A mark with no spacing form of its own falls back to the mark on a space,
 * which renders as the mark: not beautiful in every font, but it is the
 * accent, which is what the user needs to see.
 */
const SPACING = {
  [XK_DEAD_GRAVE]: '`',
  [XK_DEAD_ACUTE]: '´',
  [XK_DEAD_CIRCUMFLEX]: '^',
  [XK_DEAD_TILDE]: '~',
  [XK_DEAD_MACRON]: '¯',
  [XK_DEAD_BREVE]: '˘',
  [XK_DEAD_ABOVEDOT]: '˙',
  [XK_DEAD_DIAERESIS]: '¨',
  [XK_DEAD_ABOVERING]: '°',
  [XK_DEAD_DOUBLEACUTE]: '˝',
  [XK_DEAD_CARON]: 'ˇ',
  [XK_DEAD_CEDILLA]: '¸',
  [XK_DEAD_OGONEK]: '˛',
  [XK_DEAD_STROKE]: '/',
  [XK_DEAD_CURRENCY]: '¤',
};

/**
 * The pairs Unicode will not compose, because the character has no
 * canonical decomposition: a stroke through a letter is a different letter,
 * not a decorated one, and a currency sign is not a decorated letter at all.
 * Small and closed, which is the test for what belongs here.
 */
const UNCOMPOSED = {
  [XK_DEAD_STROKE]: {
    o: 'ø',
    O: 'Ø',
    d: 'đ',
    D: 'Đ',
    l: 'ł',
    L: 'Ł',
    t: 'ŧ',
    T: 'Ŧ',
    h: 'ħ',
    H: 'Ħ',
    b: 'ƀ',
    B: 'Ƀ',
    g: 'ǥ',
    G: 'Ǥ',
    i: 'ɨ',
    I: 'Ɨ',
  },
  [XK_DEAD_CURRENCY]: {
    e: '€',
    E: '€',
    l: '£',
    L: '£',
    y: '¥',
    Y: '¥',
    c: '¢',
    C: '¢',
    r: '₹',
    R: '₹',
    w: '₩',
    W: '₩',
    f: '₣',
    F: '₣',
    d: '$',
    D: '$',
  },
};

/**
 * A character that names an accent when it follows `Multi_key`. This is
 * what makes `Compose ' e` type `é` without a table entry per letter: the
 * quote resolves to `dead_acute` and the ordinary dead-key path takes it
 * from there, in either order (`Compose e '` too, which is how half the
 * standard Compose file is written).
 */
const ACCENTS = {
  "'": XK_DEAD_ACUTE,
  '`': XK_DEAD_GRAVE,
  '^': XK_DEAD_CIRCUMFLEX,
  '~': XK_DEAD_TILDE,
  '"': XK_DEAD_DIAERESIS,
  ',': XK_DEAD_CEDILLA,
  ';': XK_DEAD_OGONEK,
  _: XK_DEAD_MACRON,
  '.': XK_DEAD_ABOVEDOT,
  '/': XK_DEAD_STROKE,
  o: XK_DEAD_ABOVERING,
  v: XK_DEAD_CARON,
  U: XK_DEAD_BREVE,
};

/**
 * The `Multi_key` sequences, keyed by the characters that follow it. These
 * are the ones that are conventions rather than compositions — no rule
 * derives `©` from `o` and `c` — so they are named, and the list is the
 * part of X's Compose file people actually press. Anything reachable
 * through an accent (`Compose ' e`) is deliberately absent: `ACCENTS`
 * covers those by rule.
 */
const SYMBOLS = {
  oc: '©',
  oC: '©',
  Oc: '©',
  OC: '©',
  or: '®',
  oR: '®',
  Or: '®',
  OR: '®',
  tm: '™',
  TM: '™',
  '+-': '±',
  xx: '×',
  ':-': '÷',
  '-:': '÷',
  oo: '°',
  '..': '…',
  '--.': '–',
  '---': '—',
  '<<': '«',
  '>>': '»',
  '"<': '“',
  '<"': '“',
  '">': '”',
  '>"': '”',
  "'<": '‘',
  "<'": '‘',
  "'>": '’',
  ">'": '’',
  '??': '¿',
  '!!': '¡',
  ss: 'ß',
  SS: 'ẞ',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  12: '½',
  13: '⅓',
  14: '¼',
  34: '¾',
  '=e': '€',
  '=E': '€',
  '=l': '£',
  '=L': '£',
  '=y': '¥',
  '=Y': '¥',
  '=r': '₹',
  '=R': '₹',
  '=w': '₩',
  '=W': '₩',
  'c/': '¢',
  '/c': '¢',
  '->': '→',
  '<-': '←',
  '<=': '≤',
  '>=': '≥',
  '%o': '‰',
  '/u': 'µ',
  mu: 'µ',
  '.=': '•',
  so: '§',
  'p!': '¶',
  'P!': '¶',
  '+z': '†',
};

/**
 * What the Compose key itself shows while a sequence is open.
 *
 * Not nothing: pressing Compose and seeing the field sit there is the
 * "answer the input, not the outcome" failure (AGENTS.md) in its purest
 * form — the key did something, and the only evidence is that the next
 * two keys will behave strangely.
 */
const COMPOSE_MARK = '·';

/** A sequence trie: keysym arrays in, `{ text, prefix }` out. */
class ComposeTable {
  constructor() {
    this.root = { children: new Map(), text: undefined };
  }

  /** Later definitions win, which is what makes a Compose file an override
   * of the built-ins rather than an addition beside them. */
  add(keysyms, text) {
    let node = this.root;
    for (const k of keysyms) {
      let next = node.children.get(k);
      if (!next) {
        next = { children: new Map(), text: undefined };
        node.children.set(k, next);
      }
      node = next;
    }
    node.text = text;
  }

  lookup(keysyms) {
    let node = this.root;
    for (const k of keysyms) {
      node = node.children.get(k);
      if (!node) return { text: undefined, prefix: false };
    }
    return { text: node.text, prefix: node.children.size > 0 };
  }
}

let builtinTable = null;

/** The table every app gets without asking. Built once, lazily. */
export function builtinCompose() {
  if (builtinTable) return builtinTable;
  const table = new ComposeTable();
  for (const [seq, text] of Object.entries(SYMBOLS)) {
    table.add([XK_MULTI_KEY, ...Array.from(seq, keysymOf)], text);
  }
  builtinTable = table;
  return table;
}

// --- Compose files ---------------------------------------------------------

/**
 * X keysym names for the ASCII range, which is what a Compose file's input
 * side is written in. Generated rather than listed: the letters and digits
 * name themselves, and only the punctuation has names to remember.
 */
const ASCII_NAMES = (() => {
  const names = new Map();
  const punctuation = {
    0x20: 'space',
    0x21: 'exclam',
    0x22: 'quotedbl',
    0x23: 'numbersign',
    0x24: 'dollar',
    0x25: 'percent',
    0x26: 'ampersand',
    0x27: 'apostrophe',
    0x28: 'parenleft',
    0x29: 'parenright',
    0x2a: 'asterisk',
    0x2b: 'plus',
    0x2c: 'comma',
    0x2d: 'minus',
    0x2e: 'period',
    0x2f: 'slash',
    0x3a: 'colon',
    0x3b: 'semicolon',
    0x3c: 'less',
    0x3d: 'equal',
    0x3e: 'greater',
    0x3f: 'question',
    0x40: 'at',
    0x5b: 'bracketleft',
    0x5c: 'backslash',
    0x5d: 'bracketright',
    0x5e: 'asciicircum',
    0x5f: 'underscore',
    0x60: 'grave',
    0x7b: 'braceleft',
    0x7c: 'bar',
    0x7d: 'braceright',
    0x7e: 'asciitilde',
  };
  for (const [code, name] of Object.entries(punctuation)) {
    names.set(name, Number(code));
  }
  for (let c = 0x30; c <= 0x39; c++) names.set(String.fromCharCode(c), c);
  for (let c = 0x41; c <= 0x5a; c++) names.set(String.fromCharCode(c), c);
  for (let c = 0x61; c <= 0x7a; c++) names.set(String.fromCharCode(c), c);
  return names;
})();

const DEAD_NAMES = new Map([
  ['Multi_key', XK_MULTI_KEY],
  ['dead_grave', XK_DEAD_GRAVE],
  ['dead_acute', XK_DEAD_ACUTE],
  ['dead_circumflex', XK_DEAD_CIRCUMFLEX],
  ['dead_tilde', XK_DEAD_TILDE],
  ['dead_macron', XK_DEAD_MACRON],
  ['dead_breve', XK_DEAD_BREVE],
  ['dead_abovedot', XK_DEAD_ABOVEDOT],
  ['dead_diaeresis', XK_DEAD_DIAERESIS],
  ['dead_abovering', XK_DEAD_ABOVERING],
  ['dead_doubleacute', XK_DEAD_DOUBLEACUTE],
  ['dead_caron', XK_DEAD_CARON],
  ['dead_cedilla', XK_DEAD_CEDILLA],
  ['dead_ogonek', XK_DEAD_OGONEK],
  ['dead_iota', XK_DEAD_IOTA],
  ['dead_voiced_sound', XK_DEAD_VOICED_SOUND],
  ['dead_semivoiced_sound', XK_DEAD_SEMIVOICED_SOUND],
  ['dead_belowdot', XK_DEAD_BELOWDOT],
  ['dead_hook', XK_DEAD_HOOK],
  ['dead_horn', XK_DEAD_HORN],
  ['dead_stroke', XK_DEAD_STROKE],
  ['dead_abovecomma', XK_DEAD_ABOVECOMMA],
  ['dead_psili', XK_DEAD_ABOVECOMMA],
  ['dead_abovereversedcomma', XK_DEAD_ABOVEREVERSEDCOMMA],
  ['dead_dasia', XK_DEAD_ABOVEREVERSEDCOMMA],
  ['dead_doublegrave', XK_DEAD_DOUBLEGRAVE],
  ['dead_belowring', XK_DEAD_BELOWRING],
  ['dead_belowmacron', XK_DEAD_BELOWMACRON],
  ['dead_belowcircumflex', XK_DEAD_BELOWCIRCUMFLEX],
  ['dead_belowtilde', XK_DEAD_BELOWTILDE],
  ['dead_belowbreve', XK_DEAD_BELOWBREVE],
  ['dead_belowdiaeresis', XK_DEAD_BELOWDIAERESIS],
  ['dead_invertedbreve', XK_DEAD_INVERTEDBREVE],
  ['dead_belowcomma', XK_DEAD_BELOWCOMMA],
  ['dead_currency', XK_DEAD_CURRENCY],
]);

/** `<name>` → keysym, or undefined for a name outside what we can resolve. */
function keysymNamed(name) {
  const dead = DEAD_NAMES.get(name);
  if (dead !== undefined) return dead;
  const ascii = ASCII_NAMES.get(name);
  if (ascii !== undefined) return ascii;
  // the two escape hatches X's own format has for everything unnamed
  if (/^U[0-9A-Fa-f]{4,6}$/.test(name)) {
    return keysymOf(String.fromCodePoint(parseInt(name.slice(1), 16)));
  }
  if (/^0x[0-9A-Fa-f]+$/.test(name)) return Number(name);
  return undefined;
}

const LINE =
  /^\s*((?:<[A-Za-z_0-9]+>\s*)+):\s*(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_0-9]+))/;

function unescape(text) {
  return text.replace(/\\(x[0-9A-Fa-f]{2}|[0-7]{1,3}|.)/g, (_, esc) => {
    if (esc[0] === 'x') return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (/^[0-7]+$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    return { n: '\n', t: '\t', r: '\r' }[esc] ?? esc;
  });
}

/**
 * Parse X's Compose format — the one in `/usr/share/X11/locale/<locale>/Compose`
 * and in `~/.XCompose`:
 *
 * ```
 * <Multi_key> <o> <c>   : "©"   copyright
 * <dead_acute> <e>      : "é"   eacute
 * ```
 *
 * Returns the sequences it understood and a count of the lines it did not.
 * Two things it does not do, both stated rather than silently absorbed:
 * `include` directives are ignored (the system file's first line includes
 * the locale's, so a bare `~/.XCompose` may parse to almost nothing), and a
 * line whose input side names a keysym outside ASCII and the dead-key block
 * — `<Greek_alpha>`, `<Cyrillic_a>` — is skipped, because resolving those
 * names needs a table this package does not carry.
 */
export function parseCompose(text) {
  const sequences = [];
  let skipped = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = LINE.exec(line);
    if (!match) {
      if (!/^\s*include\b/.test(line)) skipped++;
      continue;
    }
    const [, lhs, quoted, named] = match;
    const keysyms = [];
    let ok = true;
    for (const [, name] of lhs.matchAll(/<([A-Za-z_0-9]+)>/g)) {
      const keysym = keysymNamed(name);
      if (keysym === undefined) {
        ok = false;
        break;
      }
      keysyms.push(keysym);
    }
    // the right-hand side may be a string, a keysym name, or both; the
    // string wins, and a bare name is the character that keysym types
    const result =
      quoted !== undefined ? unescape(quoted) : charOf(keysymNamed(named) ?? 0);
    if (!ok || !result) {
      skipped++;
      continue;
    }
    sequences.push([keysyms, result]);
  }
  return { sequences, skipped };
}

/**
 * The Compose file this machine would use, or `null` when there is none —
 * which is the normal answer on macOS, where XQuartz ships no locale tree.
 *
 * The search is Xlib's: `$XCOMPOSEFILE`, then a personal `~/.XCompose`,
 * then the locale's file under the X11 tree.
 */
export function systemComposeFile() {
  const candidates = [];
  if (process.env.XCOMPOSEFILE) candidates.push(process.env.XCOMPOSEFILE);
  const home = process.env.HOME || homedir();
  if (home) candidates.push(join(home, '.XCompose'));
  const locale =
    process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '';
  const name = locale.split(':')[0] || 'en_US.UTF-8';
  for (const dir of ['/usr/share/X11/locale', '/opt/X11/share/X11/locale']) {
    candidates.push(join(dir, name, 'Compose'));
    candidates.push(join(dir, 'en_US.UTF-8', 'Compose'));
  }
  for (const path of candidates) {
    try {
      readFileSync(path);
      return path;
    } catch {
      // not there, or not readable: try the next rung
    }
  }
  return null;
}

/**
 * Build the table a root composes with.
 *
 * `option` is `createRoot`'s `compose`:
 * `undefined` — the built-ins; `false` — no composition at all;
 * `'system'` — the built-ins plus this machine's Compose file;
 * `{ file, sequences }` — the built-ins plus a file and/or explicit
 * sequences, each overriding what came before it.
 */
export function composeTable(option) {
  if (option === false) return null;
  const settings =
    option === 'system'
      ? { file: 'system' }
      : typeof option === 'object' && option !== null
        ? option
        : {};
  const base = builtinCompose();
  if (!settings.file && !settings.sequences) return base;

  // a copy, so one root's Compose file is not every root's
  const extended = new ComposeTable();
  copyInto(extended, base.root, []);

  if (settings.file) {
    const path =
      settings.file === 'system' ? systemComposeFile() : settings.file;
    if (path) {
      let text = null;
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        // Named explicitly and not there is a mistake worth hearing about;
        // 'system' finding nothing is Tuesday on macOS and says nothing.
        if (settings.file !== 'system') {
          console.warn(
            `react-x11: could not read the Compose file ${path} ` +
              `(${err?.code ?? err?.message}). Composition falls back to the ` +
              'built-in sequences; pass compose: false to turn it off.',
          );
        }
      }
      if (text) {
        for (const [keysyms, result] of parseCompose(text).sequences) {
          extended.add(keysyms, result);
        }
      }
    }
  }
  for (const [keysyms, result] of settings.sequences ?? []) {
    extended.add(
      Array.from(keysyms, (k) => (typeof k === 'string' ? keysymOf(k) : k)),
      result,
    );
  }
  return extended;
}

function copyInto(table, node, path) {
  if (node.text !== undefined) table.add(path, node.text);
  for (const [keysym, child] of node.children) {
    copyInto(table, child, [...path, keysym]);
  }
}

/**
 * Install a root's table on its connection, the way the other per-root
 * settings ride the app object. Returns it so a caller can tell composition
 * off from composition on.
 */
export function beginCompose(app, option) {
  const table = composeTable(option);
  if (app) app._reactX11Compose = table;
  return table;
}

/** The table a window composes with: its root's, or the built-ins for an
 * app that never went through `createRoot` (a unit test, a mock). */
export function composeTableFor(app) {
  const table = app?._reactX11Compose;
  return table === undefined ? builtinCompose() : table;
}

// --- the machine -----------------------------------------------------------

// Modifier keysyms, plus the two group/level switches. A sequence has to
// survive them: reaching an uppercase letter means pressing Shift, and
// AltGr is how half of Europe reaches a dead key in the first place.
const MODIFIER_LOW = 0xffe1;
const MODIFIER_HIGH = 0xffee;
const XK_MODE_SWITCH = 0xff7e;
const XK_ISO_LEVEL3_SHIFT = 0xfe03;
const XK_ISO_LEVEL5_SHIFT = 0xfe11;

function isModifier(keysym) {
  return (
    (keysym >= MODIFIER_LOW && keysym <= MODIFIER_HIGH) ||
    keysym === XK_MODE_SWITCH ||
    keysym === XK_ISO_LEVEL3_SHIFT ||
    keysym === XK_ISO_LEVEL5_SHIFT
  );
}

/** The character a pending keysym stands for. `Multi_key` is the one that
 * differs between the two readers: it *shows* as a mark, and it *types*
 * nothing, because `·` is a note about the keyboard rather than something
 * anybody pressed a key to say. */
function markOf(keysym) {
  return SPACING[keysym] ?? MARKS[keysym] ?? charOf(keysym);
}

/** What an open sequence shows in the preedit. */
function preeditOf(keys) {
  return keys
    .map((k) => (k === XK_MULTI_KEY ? COMPOSE_MARK : markOf(k)))
    .join('');
}

/** What an open sequence types when it turns out not to be one. */
function typedOf(keys) {
  return keys.map((k) => (k === XK_MULTI_KEY ? '' : markOf(k))).join('');
}

/** The dead key a pending keysym stands for, if any — a `dead_*` keysym is
 * itself, and a character after `Multi_key` may name one. */
function deadOf(keysym, viaMulti) {
  if (isDeadKeysym(keysym)) return keysym;
  if (!viaMulti) return undefined;
  return ACCENTS[charOf(keysym)];
}

/** Apply dead keys to a base keysym, or undefined if they do not compose. */
function applyDead(deads, base) {
  if (base === XK_SPACE) {
    // the accent on its own, which is how `´` is typed at all on a layout
    // whose only acute is a dead key
    return deads.map((d) => SPACING[d] ?? MARKS[d] ?? '').join('');
  }
  const char = charOf(base);
  if (!char) return undefined;
  if (deads.length === 1) {
    const named = UNCOMPOSED[deads[0]]?.[char];
    if (named) return named;
  }
  let text = char;
  for (const dead of deads) {
    const mark = MARKS[dead];
    if (!mark) return undefined;
    text += mark;
  }
  const composed = text.normalize('NFC');
  // A sequence that stays decomposed is one Unicode has no character for:
  // `dead_acute` + `q` normalises to `q` + U+0301 and is not a `q́` anybody
  // meant to type. Two code points out means no.
  return Array.from(composed).length === 1 ? composed : undefined;
}

/**
 * Everything the algorithmic path can make of a sequence — the dead-key
 * table, in both the orders the Compose file writes them.
 */
function derive(keys) {
  const viaMulti = keys[0] === XK_MULTI_KEY;
  const body = viaMulti ? keys.slice(1) : keys;
  if (body.length < 2) return undefined;
  const direct = inOrder(body, viaMulti);
  if (direct !== undefined) return direct;
  // `Compose e '` as well as `Compose ' e`: the standard file spells the
  // common ones both ways round, and a user who learned one is not going to
  // be told the other is the real one.
  if (viaMulti && body.length === 2) return inOrder([body[1], body[0]], true);
  return undefined;
}

/** Every key but the last read as a dead key, applied to the last. */
function inOrder(body, viaMulti) {
  const deads = [];
  for (const keysym of body.slice(0, -1)) {
    const dead = deadOf(keysym, viaMulti);
    if (dead === undefined) return undefined;
    deads.push(dead);
  }
  return applyDead(deads, body[body.length - 1]);
}

/**
 * The composition state machine for one keyboard focus.
 *
 * `probe` is pure and `apply` is what commits the transition, deliberately:
 * the key event is dispatched to the application *before* the composer eats
 * it, so an `onKeyDown` that calls `preventDefault()` gets to keep its
 * chord — and it can only do that if asking what would happen has not
 * already changed anything.
 */
export class Composer {
  constructor(table = builtinCompose()) {
    this.table = table;
    this.keys = [];
  }

  get composing() {
    return this.keys.length > 0;
  }

  get preedit() {
    return preeditOf(this.keys);
  }

  reset() {
    this.keys = [];
  }

  /**
   * What this keysym would do, without doing it.
   *
   * @returns {{keys: number[], consumed: boolean,
   *   preedit: string|null, text: string|null}}
   *   `consumed` is whether the key belongs to the composition rather than
   *   to the application, `preedit` is what to show (null for "this key is
   *   nothing to do with composition"), and `text` is what to insert.
   */
  probe(keysym) {
    const idle = {
      keys: this.keys,
      consumed: false,
      preedit: null,
      text: null,
    };
    if (keysym == null || isModifier(keysym)) return idle;

    if (!this.composing) {
      if (keysym === XK_MULTI_KEY || isDeadKeysym(keysym)) {
        return this._pending([keysym]);
      }
      return idle;
    }

    // Escape abandons the sequence: nothing typed, and the accent that was
    // showing goes away. The one gesture every composing user needs and the
    // only one that cannot be a fallback, since Escape has no character.
    if (keysym === XK_ESCAPE) {
      return { keys: [], consumed: true, preedit: '', text: null };
    }
    // Backspace un-presses the last key of the sequence, the way it undoes
    // anything else half-typed.
    if (keysym === XK_BACKSPACE) {
      return this._pending(this.keys.slice(0, -1));
    }

    const candidate = [...this.keys, keysym];
    const hit = this.table.lookup(candidate);
    if (hit.text !== undefined) return this._commit(hit.text);
    const derived = derive(candidate);
    // A table entry that is also a prefix (`Compose - -` before
    // `Compose - - -`) commits the shorter one, because there is nothing to
    // wait for: X's own tables do not nest that way.
    if (derived !== undefined) return this._commit(derived);
    if (hit.prefix) return this._pending(candidate);
    // A dead key on a dead key stacks — Vietnamese `ế` is circumflex then
    // acute then `e` — except for the same one twice, which every layout
    // uses to type the accent itself.
    if (isDeadKeysym(keysym)) {
      if (keysym === this.keys[this.keys.length - 1]) {
        return this._commit(markOf(keysym));
      }
      return this._pending(candidate);
    }
    // The key straight after Compose always waits for one more, whatever the
    // table says. That is what makes `Compose e '` work as well as
    // `Compose ' e`: the standard file spells the common accents both ways
    // round, and the letter-first order cannot be recognised until the
    // accent after it has arrived.
    if (
      this.keys.length === 1 &&
      this.keys[0] === XK_MULTI_KEY &&
      charOf(keysym)
    ) {
      return this._pending(candidate);
    }

    // No sequence, so the keys are typed as they came: X's rule for a failed
    // composition is that nothing is swallowed. A key with no character of
    // its own — an arrow, Return — hands the accent over and then takes its
    // normal turn, which is why `consumed` is false while `text` is not null.
    const accent = typedOf(this.keys);
    const char = charOf(keysym);
    if (!char) {
      return { keys: [], consumed: false, preedit: '', text: accent };
    }
    return this._commit(accent + char);
  }

  _pending(keys) {
    if (keys.length === 0) {
      return { keys, consumed: true, preedit: '', text: null };
    }
    return { keys, consumed: true, preedit: preeditOf(keys), text: null };
  }

  _commit(text) {
    return { keys: [], consumed: true, preedit: '', text };
  }

  /** Commit a `probe` result. */
  apply(result) {
    this.keys = result.keys;
    return result;
  }

  /** Probe and apply in one step — what a test or a non-event caller wants. */
  feed(keysym) {
    return this.apply(this.probe(keysym));
  }
}
