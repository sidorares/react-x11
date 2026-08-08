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
 * and as `fireEvent` takes them. Bit 3 (Mod1) is Alt on virtually every
 * layout; the renderer reads Shift, Control and Mod1.
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
