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
