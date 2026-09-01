// macOS key events -> the renderer's keysym vocabulary (src/keysyms.js).
//
// The rule mirrors X's own: Latin-1 keysyms are their code points, everything
// else printable is 0x01000000 + code point, and the editing/navigation keys
// have fixed keysyms looked up here by kVK_* virtual key code. NSEvent's
// three character views map onto the three keysym roles events.js reads:
//
//   charsBase    (modifiers stripped)  -> baseKeysym — what chords match
//   charsShifted (only Shift applied)  -> keysym / codepoint — what was typed
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
  [49, 0x0020], // Space
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

const PRIVATE_USE = (cp) => cp >= 0xf700 && cp <= 0xf8ff;

function keysymFromChars(chars) {
  if (!chars) return 0;
  const cp = chars.codePointAt(0);
  if (cp == null || cp < 0x20 || PRIVATE_USE(cp)) return 0;
  return keysymOf(String.fromCodePoint(cp));
}

/**
 * The three key facts events.js reads off a native key event, from the raw
 * node-calayers payload.
 */
export function decodeKey(ev) {
  const fixed = VK_KEYSYMS.get(ev.keyCode);
  if (fixed) {
    return { keysym: fixed, baseKeysym: fixed, codepoint: undefined };
  }
  const keysym = keysymFromChars(ev.charsShifted);
  const baseKeysym = keysymFromChars(ev.charsBase) || keysym;
  const cp = ev.charsShifted?.codePointAt(0);
  const codepoint =
    cp != null && cp >= 0x20 && !PRIVATE_USE(cp) ? cp : undefined;
  return { keysym: keysym || baseKeysym, baseKeysym, codepoint };
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
