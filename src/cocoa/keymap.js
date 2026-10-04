// macOS key events -> the renderer's keysym vocabulary (src/keysyms.js).
//
// The rule mirrors X's own: Latin-1 keysyms are their code points, everything
// else printable is 0x01000000 + code point, and the editing/navigation keys
// have fixed keysyms looked up here by kVK_* virtual key code. NSEvent's
// three character views map onto the three keysym roles events.js reads:
//
//   charsBase    (modifiers stripped)        -> baseKeysym — what chords match
//   chars        (every modifier applied)    -> keysym / codepoint — what was
//                                               typed, unless ⌘ or ⌃ is held
//   charsShifted (only Shift applied)        -> keysym / codepoint of a ⌘ or
//                                               ⌃ chord, which types nothing
//
// **⌥ types on a Mac.** It is the layout's third and fourth level: ⌥S is ß on
// a US keyboard, and on a German one ⌥L is @, ⌥5 [ and ⌥8 { — the only way
// to type them. `charsShifted` is `charactersIgnoringModifiers`, which drops
// ⌥ along with everything but Shift, so reading the typed character there
// made ⌥S type `s` and left a German keyboard no @ at all. `chars` is
// `characters`, the layout's own answer with ⌥, Shift and Caps Lock applied —
// Caps Lock is the other thing `charsShifted` leaves out, so a field typed
// lower case with it on. It is also exactly the DOM's `key` on macOS: ⌥S is
// `ß`, ⌘S is `s`.
//
// There is no input method behind this. The bridge's view swallows
// `keyDown:` without `interpretKeyEvents:` and is no `NSTextInputClient`
// (docs/macos.md, "IME"), so these fields are all the text there is. Two
// consequences, both handled below:
//
// - **A dead key types nothing.** ⌥E on a US layout leaves `chars` empty, and
//   the key it is waiting for decides what the accent becomes. Typing the
//   key's own letter, which is what reading `charsShifted` did, put an `e` in
//   the field. Whether the next key's `chars` carries the composed `é` is the
//   window server's business — an NSEvent built in-process does not carry the
//   state, and a real keyboard was not measured — so nothing here depends on
//   it: a composed character is taken as typed, and a plain one is the
//   accent lost rather than a letter too many.
// - **A key can type more than one character** — the accent and a letter it
//   does not combine with, `´s`, where the layout composes. No code point
//   carries two, so the whole string rides `text` and events.js commits it
//   the way it commits an input method's text.
//
// Function and editing keys type Unicode private-use characters (U+F700…),
// which must never leak out as code points; the kVK table wins over the
// character rule for exactly those.
import { keysymOf, MOD } from '../keysyms.js';

// kVK_* virtual key codes -> X keysyms, for the keys whose characters are
// private-use or nothing at all.
const VK_KEYSYMS = new Map([
  [36, 0xff0d], // Return
  [48, 0xff09], // Tab
  // NOT space (kVK 49): space TYPES a character, so it goes through the
  // character rule below and keeps its code point — a table entry here made
  // `codepoint` undefined and a pressed spacebar inserted nothing.
  [51, 0xff08], // Delete (backspace)
  [53, 0xff1b], // Escape
  [76, 0xff8d], // KP_Enter
  [115, 0xff50], // Home
  [116, 0xff55], // Page Up
  [117, 0xffff], // Forward Delete
  [119, 0xff57], // End
  [121, 0xff56], // Page Down
  [123, 0xff51], // Left
  [124, 0xff53], // Right
  [125, 0xff54], // Down
  [126, 0xff52], // Up
  [114, 0xff63], // Help -> Insert
  [122, 0xffbe], // F1
  [120, 0xffbf], // F2
  [99, 0xffc0], // F3
  [118, 0xffc1], // F4
  [96, 0xffc2], // F5
  [97, 0xffc3], // F6
  [98, 0xffc4], // F7
  [100, 0xffc5], // F8
  [101, 0xffc6], // F9
  [109, 0xffc7], // F10
  [103, 0xffc8], // F11
  [111, 0xffc9], // F12
]);

// The block NSEvent's function-key constants live in (NSUpArrowFunctionKey is
// U+F700). Not the whole U+F700–U+F8FF range Apple reserves: U+F8FF is the
// Apple logo, which ⌥⇧K types and the system font draws.
const FUNCTION_KEY = (cp) => cp >= 0xf700 && cp <= 0xf7ff;

const printable = (cp) => cp != null && cp >= 0x20 && cp !== 0x7f;

function keysymFromChars(chars) {
  if (!chars) return 0;
  const cp = chars.codePointAt(0);
  if (!printable(cp) || FUNCTION_KEY(cp)) return 0;
  return keysymOf(String.fromCodePoint(cp));
}

/**
 * The key facts events.js reads off a native key event, from the raw
 * @windowkit/appkit payload: `keysym`, `baseKeysym` and `codepoint`, and
 * `text` when the key typed more than one character.
 */
export function decodeKey(ev) {
  const fixed = VK_KEYSYMS.get(ev.keyCode);
  if (fixed) {
    return { keysym: fixed, baseKeysym: fixed, codepoint: undefined };
  }
  const baseKeysym =
    keysymFromChars(ev.charsBase) || keysymFromChars(ev.charsShifted);
  // A ⌘ or ⌃ chord types nothing, and is named by its key: ⌘⌥S is a chord
  // on S, not on ß. (`chars` for ⌃S is a control character besides.)
  // `chars` is absent from a bridge older than the field, and from a test's
  // event that only says which key it was.
  const chord = ev.command || ev.control;
  const typed = chord ? ev.charsShifted : (ev.chars ?? ev.charsShifted);
  const points = typed ? Array.from(typed) : [];
  if (points.length > 1) {
    return {
      keysym: keysymFromChars(ev.charsShifted) || baseKeysym,
      baseKeysym,
      codepoint: undefined,
      text: typed,
    };
  }
  const keysym = keysymFromChars(typed);
  const cp = typed?.codePointAt(0);
  const codepoint = printable(cp) && !FUNCTION_KEY(cp) ? cp : undefined;
  return {
    // a dead key typed nothing; the key it sits on is what a chord names
    keysym: keysym || keysymFromChars(ev.charsShifted) || baseKeysym,
    baseKeysym,
    codepoint,
  };
}

/** AppKit modifier booleans -> the X-style state mask events carry. */
export function modifierMask(ev) {
  let mask = 0;
  if (ev.shift) mask |= MOD.Shift;
  if (ev.capsLock) mask |= MOD.Lock;
  if (ev.control) mask |= MOD.Control;
  if (ev.option) mask |= MOD.Alt; // ⌥ is Alt (Mod1), the DOM's own mapping
  if (ev.command) mask |= MOD.Super; // ⌘ is Super (Mod4) -> ev.metaKey
  return mask;
}
