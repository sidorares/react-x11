/**
 * X11 keysyms — `react-x11/keysyms`. One vocabulary for app code, the
 * widgets and `fireEvent.key`.
 */

/**
 * The keysym for a character. Latin-1 (U+0020–U+00FF) is identity, so `'a'`
 * is `0x61` and `'é'` is `0xe9`; anything else is `0x01000000 + codePoint`.
 */
export function keysymOf(char: string): number;

/** The character a keysym produces, or `''` for a non-printing key. */
export function charOf(keysym: number): string;

/**
 * The letter of a Ctrl chord, independent of Shift — the keysym for its
 * lowercase form, so `keysymOf('z')` matches both Ctrl+Z and Ctrl+Shift+Z.
 * Null when the event carries neither a keysym nor a codepoint.
 *
 * ntk derives `codepoint` from the *shifted* keysym, so a handler that
 * compared code points would see `Z` for Ctrl+Shift+Z and miss the chord.
 * Here rather than inside `<textinput>` because both layers need it: the
 * built-in editors read Ctrl+C/V/Z, and so does any widget that answers a
 * chord of its own.
 *
 * ```js
 * if (ev.ctrlKey && ctrlChordLetter(ev) === keysymOf('d')) duplicateLine();
 * ```
 */
export function ctrlChordLetter(ev: {
  keysym?: number | null;
  codepoint?: number | null;
}): number | null;

export const XK_BACKSPACE: 0xff08;
export const XK_TAB: 0xff09;
export const XK_RETURN: 0xff0d;
export const XK_ESCAPE: 0xff1b;
export const XK_DELETE: 0xffff;
export const XK_INSERT: 0xff63;

export const XK_HOME: 0xff50;
export const XK_LEFT: 0xff51;
export const XK_UP: 0xff52;
export const XK_RIGHT: 0xff53;
export const XK_DOWN: 0xff54;
export const XK_PAGE_UP: 0xff55;
export const XK_PAGE_DOWN: 0xff56;
export const XK_END: 0xff57;

export const XK_KP_ENTER: 0xff8d;
export const XK_MENU: 0xff67;
export const XK_SPACE: 0x0020;

/**
 * The Compose key. It types nothing on its own: it opens a sequence that
 * the next keys finish — `Compose o c` is `©`. See
 * [docs/events.md](events.md#composition).
 */
export const XK_MULTI_KEY: 0xff20;

// The dead keys. Each waits for the character it decorates, so `dead_acute`
// then `e` is `é`; on its own — followed by a space, or pressed twice — it
// types the accent.
export const XK_DEAD_GRAVE: 0xfe50;
export const XK_DEAD_ACUTE: 0xfe51;
export const XK_DEAD_CIRCUMFLEX: 0xfe52;
export const XK_DEAD_TILDE: 0xfe53;
export const XK_DEAD_MACRON: 0xfe54;
export const XK_DEAD_BREVE: 0xfe55;
export const XK_DEAD_ABOVEDOT: 0xfe56;
export const XK_DEAD_DIAERESIS: 0xfe57;
export const XK_DEAD_ABOVERING: 0xfe58;
export const XK_DEAD_DOUBLEACUTE: 0xfe59;
export const XK_DEAD_CARON: 0xfe5a;
export const XK_DEAD_CEDILLA: 0xfe5b;
export const XK_DEAD_OGONEK: 0xfe5c;
export const XK_DEAD_IOTA: 0xfe5d;
export const XK_DEAD_VOICED_SOUND: 0xfe5e;
export const XK_DEAD_SEMIVOICED_SOUND: 0xfe5f;
export const XK_DEAD_BELOWDOT: 0xfe60;
export const XK_DEAD_HOOK: 0xfe61;
export const XK_DEAD_HORN: 0xfe62;
export const XK_DEAD_STROKE: 0xfe63;
export const XK_DEAD_ABOVECOMMA: 0xfe64;
export const XK_DEAD_ABOVEREVERSEDCOMMA: 0xfe65;
export const XK_DEAD_DOUBLEGRAVE: 0xfe66;
export const XK_DEAD_BELOWRING: 0xfe67;
export const XK_DEAD_BELOWMACRON: 0xfe68;
export const XK_DEAD_BELOWCIRCUMFLEX: 0xfe69;
export const XK_DEAD_BELOWTILDE: 0xfe6a;
export const XK_DEAD_BELOWBREVE: 0xfe6b;
export const XK_DEAD_BELOWDIAERESIS: 0xfe6c;
export const XK_DEAD_INVERTEDBREVE: 0xfe6d;
export const XK_DEAD_BELOWCOMMA: 0xfe6e;
export const XK_DEAD_CURRENCY: 0xfe6f;

/** Whether a keysym is one of the `XK_dead_*` block. */
export function isDeadKeysym(keysym: number): boolean;

export const XK_SHIFT_L: 0xffe1;
export const XK_SHIFT_R: 0xffe2;
export const XK_CONTROL_L: 0xffe3;
export const XK_CONTROL_R: 0xffe4;
export const XK_CAPS_LOCK: 0xffe5;
export const XK_ALT_L: 0xffe9;
export const XK_ALT_R: 0xffea;
export const XK_SUPER_L: 0xffeb;
export const XK_SUPER_R: 0xffec;

export const XK_F1: 0xffbe;
export const XK_F2: 0xffbf;
export const XK_F3: 0xffc0;
export const XK_F4: 0xffc1;
export const XK_F5: 0xffc2;
export const XK_F6: 0xffc3;
export const XK_F7: 0xffc4;
export const XK_F8: 0xffc5;
export const XK_F9: 0xffc6;
export const XK_F10: 0xffc7;
export const XK_F11: 0xffc8;
export const XK_F12: 0xffc9;

/** X11 modifier mask bits, as `ev.nativeEvent.buttons` carries them. */
export const MOD: {
  Shift: 1;
  Lock: 2;
  Control: 4;
  Mod1: 8;
  Alt: 8;
  Mod2: 16;
  Mod3: 32;
  Mod4: 64;
  Super: 64;
  Mod5: 128;
};

export type ModifierName = keyof typeof MOD;
