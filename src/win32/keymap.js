// Windows key events -> the renderer's keysym vocabulary (src/keysyms.js).
//
// The rule mirrors X's own, as the Cocoa map does: a Latin-1 keysym is its
// code point, anything else printable is 0x01000000 + code point, and the
// editing and navigation keys have fixed keysyms looked up here by virtual
// key code.
//
// The bridge has already done the part only it can do — asking the active
// layout what the key types, once with the modifiers that are down and once
// with none (src/win32.cc, EmitKey). That gives the two character roles
// events.js reads:
//
//   baseCodepoint (nothing held)      -> baseKeysym — what chords match
//   codepoint     (Shift/AltGr held)  -> keysym / codepoint — what was typed
//
// A key that types nothing reports 0 for both, and the table below is what
// gives it a keysym at all. Tab is the one to keep an eye on: it *does* type
// a character on Windows (U+0009), and letting the character rule have it
// would make the keysym 9 instead of XK_Tab — which is why the table wins.
import { keysymOf, MOD } from '../keysyms.js';

// Virtual key codes -> X keysyms, for keys whose character is a control code
// or nothing at all.
const VK_KEYSYMS = new Map([
  [0x08, 0xff08], // Backspace
  [0x09, 0xff09], // Tab
  [0x0d, 0xff0d], // Return
  [0x13, 0xff13], // Pause
  [0x14, 0xffe5], // Caps Lock
  [0x1b, 0xff1b], // Escape
  [0x21, 0xff55], // Page Up
  [0x22, 0xff56], // Page Down
  [0x23, 0xff57], // End
  [0x24, 0xff50], // Home
  [0x25, 0xff51], // Left
  [0x26, 0xff52], // Up
  [0x27, 0xff53], // Right
  [0x28, 0xff54], // Down
  [0x2c, 0xfd1d], // Print Screen -> XK_3270_PrintScreen
  [0x2d, 0xff63], // Insert
  [0x2e, 0xffff], // Delete
  [0x5b, 0xffeb], // Left Super
  [0x5c, 0xffec], // Right Super
  [0x5d, 0xff67], // Menu
  [0x90, 0xff7f], // Num Lock
  [0x91, 0xff14], // Scroll Lock
  [0xa0, 0xffe1], // Left Shift
  [0xa1, 0xffe2], // Right Shift
  [0xa2, 0xffe3], // Left Control
  [0xa3, 0xffe4], // Right Control
  [0xa4, 0xffe9], // Left Alt
  [0xa5, 0xffea], // Right Alt
  // The keypad, which has keysyms of its own so that a caret can tell
  // KP_Left from Left even when Num Lock is off.
  [0x6a, 0xffaa], // KP_Multiply
  [0x6b, 0xffab], // KP_Add
  [0x6d, 0xffad], // KP_Subtract
  [0x6e, 0xffae], // KP_Decimal
  [0x6f, 0xffaf], // KP_Divide
]);

// F1..F24 are contiguous on both sides, so they are a range rather than 24
// table entries.
const VK_F1 = 0x70;
const XK_F1 = 0xffbe;

// The keypad digits, likewise: VK_NUMPAD0..9 -> XK_KP_0..9.
const VK_NUMPAD0 = 0x60;
const XK_KP_0 = 0xffb0;

function fixedKeysym(vk) {
  const known = VK_KEYSYMS.get(vk);
  if (known) return known;
  if (vk >= VK_F1 && vk <= VK_F1 + 23) return XK_F1 + (vk - VK_F1);
  if (vk >= VK_NUMPAD0 && vk <= VK_NUMPAD0 + 9)
    return XK_KP_0 + (vk - VK_NUMPAD0);
  return 0;
}

const keysymFromCodepoint = (cp) =>
  cp && cp >= 0x20 ? keysymOf(String.fromCodePoint(cp)) : 0;

/**
 * The three key facts events.js reads off a native key event, from the
 * bridge's payload: `a` the virtual key, `b` what it typed, `c` what it
 * would type with nothing held.
 */
export function decodeKey(event) {
  const vk = event.a;
  const fixed = fixedKeysym(vk);
  if (fixed) {
    // A key with a fixed keysym reports no code point even when Windows
    // says it types one. Tab and Return type U+0009 and U+000D, and letting
    // those through would insert a control character into every text field
    // the moment a caret was in one.
    return { keysym: fixed, baseKeysym: fixed, codepoint: undefined };
  }
  const keysym = keysymFromCodepoint(event.b);
  const baseKeysym = keysymFromCodepoint(event.c) || keysym;
  return {
    keysym: keysym || baseKeysym,
    baseKeysym,
    codepoint: event.b ? event.b : undefined,
  };
}

/** The bridge's modifier bits -> the X-style state mask events carry. */
export function modifierMask(bits) {
  let mask = 0;
  if (bits & 1) mask |= MOD.Shift;
  if (bits & 2) mask |= MOD.Control;
  if (bits & 4) mask |= MOD.Alt;
  if (bits & 8) mask |= MOD.Super;
  if (bits & 16) mask |= MOD.Lock;
  return mask;
}
