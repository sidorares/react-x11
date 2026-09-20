// Windows key events becoming keysyms. The bridge has already asked the
// layout what a key types (src/win32.cc, EmitKey); what this file owns is the
// translation of that into the three roles src/events.js reads, and the one
// rule that is easy to get backwards — a key that types a control character
// is named, not typed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeKey, modifierMask } from '../../src/win32/keymap.js';
import { MOD } from '../../src/keysyms.js';

/** A bridge key event: virtual key, what it typed, what it would type bare. */
const event = (vk, typed = 0, base = 0, mods = 0) => ({
  a: vk,
  b: typed,
  c: base,
  d: mods,
});

describe('win32 keymap: characters', () => {
  it('gives a Latin-1 character its own code point as the keysym', () => {
    const decoded = decodeKey(event(0x41, 0x61, 0x61));
    assert.equal(decoded.keysym, 0x61); // XK_a
    assert.equal(decoded.codepoint, 0x61);
  });

  it('separates what was typed from what the key is', () => {
    // Shift+A: 'A' was typed, but a chord still matches the 'a' key.
    const decoded = decodeKey(event(0x41, 0x41, 0x61));
    assert.equal(decoded.keysym, 0x41); // XK_A
    assert.equal(decoded.baseKeysym, 0x61); // XK_a
    assert.equal(decoded.codepoint, 0x41);
  });

  it('puts a character above Latin-1 in the Unicode keysym block', () => {
    const decoded = decodeKey(event(0x41, 0x439, 0x439)); // Cyrillic short i
    assert.equal(decoded.keysym, 0x01000000 + 0x439);
    assert.equal(decoded.codepoint, 0x439);
  });

  it('falls back to the base keysym when the key typed nothing', () => {
    // A dead key mid-sequence: the layout reports no character yet.
    const decoded = decodeKey(event(0xdd, 0, 0x60));
    assert.equal(decoded.keysym, 0x60);
    assert.equal(decoded.baseKeysym, 0x60);
    assert.equal(decoded.codepoint, undefined);
  });
});

describe('win32 keymap: the keys that are not characters', () => {
  it('names Tab rather than typing one', () => {
    // Windows says VK_TAB types U+0009. Letting the character rule have it
    // would put a tab character into every focused text field and give the
    // key the keysym 9, which nothing matches Tab against.
    const decoded = decodeKey(event(0x09, 0x09, 0x09));
    assert.equal(decoded.keysym, 0xff09); // XK_Tab
    assert.equal(decoded.codepoint, undefined);
  });

  it('names Return and Backspace the same way', () => {
    assert.equal(decodeKey(event(0x0d, 0x0d, 0x0d)).keysym, 0xff0d);
    assert.equal(decodeKey(event(0x08, 0x08, 0x08)).keysym, 0xff08);
    assert.equal(decodeKey(event(0x1b, 0x1b, 0x1b)).keysym, 0xff1b);
  });

  it('still types a space, which is a character and not a named key', () => {
    const decoded = decodeKey(event(0x20, 0x20, 0x20));
    assert.equal(decoded.keysym, 0x20);
    assert.equal(decoded.codepoint, 0x20);
  });

  it('maps the arrows and the editing keys', () => {
    assert.equal(decodeKey(event(0x25)).keysym, 0xff51); // Left
    assert.equal(decodeKey(event(0x26)).keysym, 0xff52); // Up
    assert.equal(decodeKey(event(0x27)).keysym, 0xff53); // Right
    assert.equal(decodeKey(event(0x28)).keysym, 0xff54); // Down
    assert.equal(decodeKey(event(0x24)).keysym, 0xff50); // Home
    assert.equal(decodeKey(event(0x2e)).keysym, 0xffff); // Delete
  });

  it('maps the function keys as a range', () => {
    assert.equal(decodeKey(event(0x70)).keysym, 0xffbe); // F1
    assert.equal(decodeKey(event(0x7b)).keysym, 0xffc9); // F12
  });

  it('maps the keypad digits as a range', () => {
    assert.equal(decodeKey(event(0x60)).keysym, 0xffb0); // KP_0
    assert.equal(decodeKey(event(0x69)).keysym, 0xffb9); // KP_9
  });
});

describe('win32 keymap: modifiers', () => {
  it('translates the bridge bits into the X state mask', () => {
    assert.equal(modifierMask(0), 0);
    assert.equal(modifierMask(1), MOD.Shift);
    assert.equal(modifierMask(2), MOD.Control);
    assert.equal(modifierMask(4), MOD.Alt);
    assert.equal(modifierMask(8), MOD.Super);
    assert.equal(modifierMask(16), MOD.Lock);
    assert.equal(modifierMask(1 | 2), MOD.Shift | MOD.Control);
  });
});
