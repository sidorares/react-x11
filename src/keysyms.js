// X11 keysyms, as `react-x11/keysyms`.
//
// One vocabulary for app code and tests: the widget keyboard handlers read
// these, `fireEvent.key` takes them, and `onKeyDown` reports them on
// `ev.keysym`. The full X11 set is several thousand names; this is the part
// a GUI actually handles, plus the rule for everything else.
//
// Two facts make the long tail unnecessary:
//
// - **Latin-1 is identity.** For U+0020 to U+00FF the keysym *is* the code
//   point, so `'a'` is `0x61` and `'é'` is `0xe9`. That is the whole ASCII
//   and Latin-1 range, no table needed.
// - **Everything else is `0x01000000 + codePoint`.** That is the Unicode
//   keysym rule, and `keysymOf` below applies both.

/** The keysym for a single character, by the two rules above. */
export function keysymOf(char) {
  const code = String(char).codePointAt(0);
  if (code == null) return 0;
  if (code >= 0x20 && code <= 0xff) return code;
  return 0x01000000 + code;
}

/** The character a keysym produces, or `''` for a non-printing key. */
export function charOf(keysym) {
  if (keysym >= 0x20 && keysym <= 0xff) return String.fromCodePoint(keysym);
  if (keysym >= 0x01000100 && keysym <= 0x0110ffff) {
    return String.fromCodePoint(keysym - 0x01000000);
  }
  return '';
}

// --- editing and navigation ------------------------------------------------

export const XK_BACKSPACE = 0xff08;
export const XK_TAB = 0xff09;
export const XK_RETURN = 0xff0d;
export const XK_ESCAPE = 0xff1b;
export const XK_DELETE = 0xffff;
export const XK_INSERT = 0xff63;

export const XK_HOME = 0xff50;
export const XK_LEFT = 0xff51;
export const XK_UP = 0xff52;
export const XK_RIGHT = 0xff53;
export const XK_DOWN = 0xff54;
export const XK_PAGE_UP = 0xff55;
export const XK_PAGE_DOWN = 0xff56;
export const XK_END = 0xff57;

export const XK_KP_ENTER = 0xff8d;
export const XK_MENU = 0xff67;
export const XK_SPACE = 0x0020;

// --- composition -----------------------------------------------------------
//
// The keys that type nothing on their own. A dead key waits for the letter
// it decorates (`dead_acute` then `e` is `é`) and `Multi_key` — the Compose
// key — opens a sequence of them. They are ordinary keysyms that arrive on
// ordinary key events; what turns a run of them into a character is the
// state machine in `src/compose.js`, and `charOf` deliberately answers `''`
// for every one of them because on their own they produce no text.
//
// The whole `dead_*` block is here rather than the handful most layouts
// use: the names are the vocabulary an application matches on, and half a
// block is a table nobody can trust.

export const XK_MULTI_KEY = 0xff20;

export const XK_DEAD_GRAVE = 0xfe50;
export const XK_DEAD_ACUTE = 0xfe51;
export const XK_DEAD_CIRCUMFLEX = 0xfe52;
export const XK_DEAD_TILDE = 0xfe53;
export const XK_DEAD_MACRON = 0xfe54;
export const XK_DEAD_BREVE = 0xfe55;
export const XK_DEAD_ABOVEDOT = 0xfe56;
export const XK_DEAD_DIAERESIS = 0xfe57;
export const XK_DEAD_ABOVERING = 0xfe58;
export const XK_DEAD_DOUBLEACUTE = 0xfe59;
export const XK_DEAD_CARON = 0xfe5a;
export const XK_DEAD_CEDILLA = 0xfe5b;
export const XK_DEAD_OGONEK = 0xfe5c;
export const XK_DEAD_IOTA = 0xfe5d;
export const XK_DEAD_VOICED_SOUND = 0xfe5e;
export const XK_DEAD_SEMIVOICED_SOUND = 0xfe5f;
export const XK_DEAD_BELOWDOT = 0xfe60;
export const XK_DEAD_HOOK = 0xfe61;
export const XK_DEAD_HORN = 0xfe62;
export const XK_DEAD_STROKE = 0xfe63;
export const XK_DEAD_ABOVECOMMA = 0xfe64;
export const XK_DEAD_ABOVEREVERSEDCOMMA = 0xfe65;
export const XK_DEAD_DOUBLEGRAVE = 0xfe66;
export const XK_DEAD_BELOWRING = 0xfe67;
export const XK_DEAD_BELOWMACRON = 0xfe68;
export const XK_DEAD_BELOWCIRCUMFLEX = 0xfe69;
export const XK_DEAD_BELOWTILDE = 0xfe6a;
export const XK_DEAD_BELOWBREVE = 0xfe6b;
export const XK_DEAD_BELOWDIAERESIS = 0xfe6c;
export const XK_DEAD_INVERTEDBREVE = 0xfe6d;
export const XK_DEAD_BELOWCOMMA = 0xfe6e;
export const XK_DEAD_CURRENCY = 0xfe6f;

/** Whether a keysym is one of the `XK_dead_*` block. */
export function isDeadKeysym(keysym) {
  return keysym >= XK_DEAD_GRAVE && keysym <= XK_DEAD_CURRENCY;
}

// --- modifiers -------------------------------------------------------------

export const XK_SHIFT_L = 0xffe1;
export const XK_SHIFT_R = 0xffe2;
export const XK_CONTROL_L = 0xffe3;
export const XK_CONTROL_R = 0xffe4;
export const XK_CAPS_LOCK = 0xffe5;
export const XK_ALT_L = 0xffe9;
export const XK_ALT_R = 0xffea;
export const XK_SUPER_L = 0xffeb;
export const XK_SUPER_R = 0xffec;

// --- function keys ---------------------------------------------------------

export const XK_F1 = 0xffbe;
export const XK_F2 = 0xffbf;
export const XK_F3 = 0xffc0;
export const XK_F4 = 0xffc1;
export const XK_F5 = 0xffc2;
export const XK_F6 = 0xffc3;
export const XK_F7 = 0xffc4;
export const XK_F8 = 0xffc5;
export const XK_F9 = 0xffc6;
export const XK_F10 = 0xffc7;
export const XK_F11 = 0xffc8;
export const XK_F12 = 0xffc9;

/**
 * The letter of a Ctrl chord, independent of Shift. ntk derives `codepoint`
 * from the *shifted* keysym, so Ctrl+Shift+Z arrives as `Z` while Ctrl+Z
 * arrives as `z` — the keysym does not shift, so match on that and fall back
 * to the codepoint when the keymap has not been read yet.
 *
 * Here rather than beside its first caller because both layers need it: the
 * `<textinput>` node reads Ctrl+C/V/Z, and so does any widget that answers a
 * chord of its own.
 */
export function ctrlChordLetter(ev) {
  const code = ev.keysym ?? ev.codepoint;
  if (code == null) return null;
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

/**
 * The X11 modifier mask bits, as they arrive on `ev.nativeEvent.buttons`
 * and as `fireEvent` takes them. Bit 3 (Mod1) is Alt and bit 6 (Mod4) is
 * Super on virtually every layout; those four — Shift, Control, Mod1, Mod4
 * — are the ones a synthetic event decodes, as `shiftKey`/`ctrlKey`/
 * `altKey`/`metaKey`.
 */
export const MOD = {
  Shift: 1,
  Lock: 2,
  Control: 4,
  Mod1: 8,
  Alt: 8,
  Mod2: 16,
  Mod3: 32,
  Mod4: 64,
  Super: 64,
  Mod5: 128,
};

// --- keysym names ----------------------------------------------------------
//
// X11 names the *key* rather than the character it types — `plus` and not
// `+`, `Return` and not `Enter` — and that is the vocabulary a menu
// `shortcut` speaks, because dbusmenu carries `gdk_keyval_name()` strings
// (`src/menuitem.js`). `keysymFromName` is the other direction from
// `charOf`: a name in, the keysym out, so a chord written for the panel is
// the same chord the key path matches against.

// The printable ASCII whose X11 name is a word. Everything else in that
// range is its own name — `a`, `7` — and goes through `keysymOf`.
// `quoteright` and `quoteleft` are the deprecated spellings of `apostrophe`
// and `grave`, still emitted by older importers.
const PUNCTUATION_NAMES = {
  exclam: '!',
  quotedbl: '"',
  numbersign: '#',
  dollar: '$',
  percent: '%',
  ampersand: '&',
  apostrophe: "'",
  quoteright: "'",
  parenleft: '(',
  parenright: ')',
  asterisk: '*',
  plus: '+',
  comma: ',',
  minus: '-',
  period: '.',
  slash: '/',
  colon: ':',
  semicolon: ';',
  less: '<',
  equal: '=',
  greater: '>',
  question: '?',
  at: '@',
  bracketleft: '[',
  backslash: '\\',
  bracketright: ']',
  asciicircum: '^',
  underscore: '_',
  grave: '`',
  quoteleft: '`',
  braceleft: '{',
  bar: '|',
  braceright: '}',
  asciitilde: '~',
  space: ' ',
};

// The keys that are not characters at all. `Prior`/`Next` are the core
// protocol's names for the page keys and `Page_Up`/`Page_Down` the ones
// everything since has used; both arrive, so both resolve.
const NAMED_KEYSYMS = {
  BackSpace: XK_BACKSPACE,
  Tab: XK_TAB,
  Return: XK_RETURN,
  Escape: XK_ESCAPE,
  Delete: XK_DELETE,
  Insert: XK_INSERT,
  Home: XK_HOME,
  Left: XK_LEFT,
  Up: XK_UP,
  Right: XK_RIGHT,
  Down: XK_DOWN,
  Prior: XK_PAGE_UP,
  Page_Up: XK_PAGE_UP,
  Next: XK_PAGE_DOWN,
  Page_Down: XK_PAGE_DOWN,
  End: XK_END,
  KP_Enter: XK_KP_ENTER,
  Menu: XK_MENU,
  Multi_key: XK_MULTI_KEY,
};

// `XK_F1` through `XK_F35` are one contiguous run, so the whole function row
// is arithmetic rather than 35 more table entries.
const FUNCTION_KEY = /^F([1-9]|[12]\d|3[0-5])$/;

/**
 * The keysym an X11 key *name* stands for — `'Return'`, `'plus'`, `'F5'`,
 * `'s'` — or `undefined` for a name nothing here knows.
 *
 * This is the vocabulary menu `shortcut` chords are written in, and the
 * reason it is public: a shortcut can be moved into or out of a menu
 * without being respelled. A one-character name is the character itself, by
 * `keysymOf`'s two rules, which covers the letters, the digits and anyone
 * who wrote `'+'` where X would have said `plus`.
 */
export function keysymFromName(name) {
  if (typeof name !== 'string' || name === '') return undefined;
  if ([...name].length === 1) return keysymOf(name);
  const named = NAMED_KEYSYMS[name];
  if (named !== undefined) return named;
  const punctuation = PUNCTUATION_NAMES[name];
  if (punctuation !== undefined) return keysymOf(punctuation);
  const fn = FUNCTION_KEY.exec(name);
  return fn ? XK_F1 + Number(fn[1]) - 1 : undefined;
}
