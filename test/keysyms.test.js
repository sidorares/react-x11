// `charOf` (src/keysyms.js) and the table under it (src/keysymchars.js).
//
// Two rules and a table: Latin-1 is identity, the Unicode form is
// `0x01000000 + codePoint`, and everything in between — the legacy blocks a
// real keymap is actually written in — comes out of the generated table.
//
// The table is generated from X11's `keysymdef.h`, which is not installed on
// every machine and is not installed in CI. What *is* installed is node-x11,
// which ships its own copy of the same header with the character in each
// keysym's description — so the cross-check below holds the table to an
// independent transcription of the same source, and a regeneration that went
// wrong has somewhere to fail other than a user's keyboard.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { charOf, keysymOf, keysymToUpper } from '../src/keysyms.js';
import { KEYSYM_CHAR_RUNS } from '../src/keysymchars.js';

const require = createRequire(import.meta.url);

/** The table, expanded the way `charOf` expands it. */
function expand() {
  const out = new Map();
  for (const line of KEYSYM_CHAR_RUNS)
    for (const run of line.split(' ')) {
      const [keysyms, cp] = run.split(':');
      const [first, span] = keysyms.split('+');
      const from = parseInt(first, 16);
      const to = parseInt(cp, 16);
      for (let i = 0; i <= (span ? +span : 0); i++) out.set(from + i, to + i);
    }
  return out;
}

test('the generated table is well formed, and holds nothing a rule covers', () => {
  const table = expand();
  assert.ok(table.size > 700, `${table.size} entries`);

  let count = 0;
  for (const line of KEYSYM_CHAR_RUNS)
    for (const run of line.split(' ')) {
      assert.match(run, /^[0-9a-f]+(\+\d+)?:[0-9a-f]+$/, run);
      count += 1 + +(/\+(\d+):/.exec(run)?.[1] ?? 0);
    }
  assert.equal(count, table.size, 'the runs do not overlap');

  const keysyms = [...table.keys()];
  assert.deepEqual(
    keysyms,
    [...keysyms].sort((a, b) => a - b),
    'sorted',
  );

  for (const [keysym, cp] of table) {
    // Latin-1 and the Unicode form are rules, so an entry for one of them is
    // a row that can only ever disagree with the rule that shadows it.
    assert.ok(
      !(keysym >= 0x20 && keysym <= 0xff && keysym === cp),
      `0x${keysym.toString(16)} is the Latin-1 identity`,
    );
    assert.ok(
      !(keysym >= 0x01000000 && keysym - 0x01000000 === cp),
      `0x${keysym.toString(16)} is the Unicode keysym form`,
    );
    // A key that types a control character types nothing, and `charOf` says so.
    assert.ok(cp >= 0x20 && cp !== 0x7f, `0x${keysym.toString(16)} -> U+${cp}`);
  }
});

test('the table agrees with node-x11’s copy of keysymdef.h', () => {
  const theirs = require('x11/lib/keysyms.js');
  const table = expand();
  // `(й) CYRILLIC SMALL LETTER SHORT I`, and `((┌) BOX DRAWINGS …)` where the
  // header's own comment was parenthesised. Entries with no character in the
  // description — the keypad, which `keysymdef.h` does not annotate either,
  // and the deprecated aliases — have nothing to compare.
  const CHAR = /^\(\(?(.)\)/u;
  let checked = 0;
  for (const entry of Object.values(theirs)) {
    const cp = table.get(entry.code);
    if (cp === undefined) continue;
    const m = CHAR.exec(entry.description ?? '');
    if (!m) continue;
    assert.equal(
      m[1].codePointAt(0),
      cp,
      `0x${entry.code.toString(16)}: ${entry.description}`,
    );
    checked++;
  }
  assert.ok(checked > 600, `only ${checked} entries could be cross-checked`);
});

test('charOf spells the legacy blocks', () => {
  // What the Wayland backend could not type: a Cyrillic layout, a Greek one,
  // Latin-2, Arabic, Hebrew and Thai, the Euro sign on a German AltGr level,
  // and the typographic quotes on a punctuation level.
  assert.equal(charOf(0x6ca), 'й', 'Cyrillic_shorti');
  assert.equal(charOf(0x6ea), 'Й', 'Cyrillic_SHORTI');
  assert.equal(charOf(0x7e1), 'α', 'Greek_alpha');
  assert.equal(charOf(0x7c1), 'Α', 'Greek_ALPHA');
  assert.equal(charOf(0x20ac), '€', 'EuroSign');
  assert.equal(charOf(0xad2), '“', 'leftdoublequotemark');
  assert.equal(charOf(0x1b1), 'ą', 'aogonek, Latin-2');
  assert.equal(charOf(0x5c7), 'ا', 'Arabic_alef');
  assert.equal(charOf(0xce0), 'א', 'hebrew_aleph');
  assert.equal(charOf(0xda1), 'ก', 'Thai_kokai');

  // The keypad, which is the one legacy block that is not a script: without
  // it the numeric keypad has the right keysyms and types nothing.
  assert.equal(charOf(0xffb7), '7', 'KP_7');
  assert.equal(charOf(0xffae), '.', 'KP_Decimal');
  assert.equal(charOf(0xffaa), '*', 'KP_Multiply');
  assert.equal(charOf(0xffbd), '=', 'KP_Equal');
  assert.equal(charOf(0xff80), ' ', 'KP_Space');
});

test('charOf still answers nothing for a key that types nothing', () => {
  assert.equal(charOf(0xff95), '', 'KP_Home — the keypad, minus NumLock');
  assert.equal(charOf(0xff8d), '', 'KP_Enter, whose code point is a newline');
  assert.equal(charOf(0xff08), '', 'BackSpace, U+0008 in the header');
  assert.equal(charOf(0xffff), '', 'Delete, U+007F in the header');
  assert.equal(charOf(0xff0d), '', 'Return');
  assert.equal(charOf(0xff1b), '', 'Escape');
  assert.equal(charOf(0xffe1), '', 'Shift_L');
  assert.equal(charOf(0xffbe), '', 'F1');
  assert.equal(charOf(0xfe51), '', 'dead_acute waits for the letter it marks');
  assert.equal(charOf(0xfe03), '', 'ISO_Level3_Shift');
  assert.equal(charOf(0x8f), '', 'the unassigned stretch of the Latin-1 range');
  assert.equal(charOf(0x01000000), '', 'the Unicode form of U+0000');
  assert.equal(charOf(0), '');
});

test('keysymToUpper answers in the spelling it was given', () => {
  // Caps Lock capitalises by case-mapping the keysym, so the answer has to be
  // comparable against the keysyms the keymap itself carries: a Cyrillic
  // keymap is written in the legacy block and wants the legacy answer.
  assert.equal(keysymToUpper(0x6ca), 0x6ea, 'й -> Й, in the Cyrillic block');
  assert.equal(keysymToUpper(0x7f3), 0x7d2, 'σ -> Σ, in the Greek block');
  assert.equal(keysymToUpper(0xe9), 0xc9, 'é -> É, Latin-1');
  assert.equal(keysymToUpper(0x1b1), 0x1a1, 'ą -> Ą, Latin-2');
  assert.equal(
    keysymToUpper(0xb5),
    0x7cc,
    'µ -> Greek_MU: Latin-1 in, legacy out',
  );
  assert.equal(
    keysymToUpper(0x010003b5),
    0x01000395,
    'ε -> Ε: a keysym written in the Unicode form keeps it',
  );
  assert.equal(
    keysymToUpper(0x0100017f),
    0x53,
    'ſ -> S: no key anywhere carries those two side by side',
  );

  // A keysym with no case comes back untouched, including the keys that have
  // a character but no case at all.
  for (const keysym of [0x51, 0x32, 0x20ac, 0xffb7, 0xff95, 0xffe1, 0])
    assert.equal(keysymToUpper(keysym), keysym, `0x${keysym.toString(16)}`);
  assert.equal(keysymToUpper(0x71), 0x51, 'q -> Q');

  // Idempotent: an uppercase keysym is its own uppercase, whichever block.
  for (const keysym of [0x6ca, 0x7f3, 0xe9, 0x1b1, 0xb5, 0x010003b5, 0x71])
    assert.equal(keysymToUpper(keysymToUpper(keysym)), keysymToUpper(keysym));
});

test('keysymToUpper takes the first code point where the case map grows one', () => {
  // `'ß'.toUpperCase()` is `'SS'`, two characters, and a key has one to give.
  // libxkbcommon's narrower table answers `ẞ` (U+1E9E) here; `S` is the more
  // useful of the two for a key about to insert a character, and this is the
  // whole of the disagreement between the two — it and the ligatures.
  assert.equal('ß'.toUpperCase(), 'SS');
  assert.equal(keysymToUpper(0xdf), 0x53, 'ß -> S');
  assert.equal('ﬁ'.toUpperCase(), 'FI');
  assert.equal(keysymToUpper(0x0100fb01), 0x46, 'ﬁ -> F');
});

test('the two rules still hold, and round-trip with keysymOf', () => {
  assert.equal(charOf(0x71), 'q');
  assert.equal(charOf(0x20), ' ');
  assert.equal(charOf(0xe9), 'é', 'Latin-1 is identity');
  assert.equal(charOf(0x01000439), 'й', 'the Unicode form of the same letter');
  assert.equal(charOf(0x0100263a), '☺');
  for (const ch of ['q', 'Q', ' ', 'é', '€', 'й', 'α', '☺'])
    assert.equal(charOf(keysymOf(ch)), ch, ch);
});
