// src/keysymchars.js holds the character each **legacy** keysym produces —
// the blocks that are neither Latin-1 (where the keysym is the code point)
// nor the Unicode form (`0x01000000 + codePoint`), which is to say Cyrillic,
// Greek, Latin-2/3/4/8/9, Arabic, Hebrew, Thai, Korean, the technical and
// publishing symbols, and the keypad. Run this to regenerate it:
//
//   node scripts/keysym-chars.mjs
//   KEYSYMDEF=/path/to/keysymdef.h node scripts/keysym-chars.mjs
//
// The source is X11's `keysymdef.h`, whose comments carry the code point:
//
//   #define XK_Cyrillic_shorti  0x06ca  /* U+0439 CYRILLIC SMALL LETTER SHORT I */
//
// which is where libxkbcommon's own table comes from too, so the two agree by
// construction rather than by luck. `test/keysyms.test.js` then holds the
// generated table to node-x11's copy of keysymdef.h, which is a dependency and
// therefore present in CI where the header is not.
//
// Three things are added on top of the header, all of them libxkbcommon's, and
// all of them deliberate:
//
//   - **The keypad.** `keysymdef.h` annotates none of `KP_0`…`KP_9`,
//     `KP_Decimal` and friends, and libxkbcommon spells them in code. Without
//     them the numeric keypad types nothing at all.
//   - **The two angle brackets.** `leftanglebracket`/`rightanglebracket` are
//     annotated U+2329/U+232A, which Unicode has since deprecated in favour of
//     U+27E8/U+27E9. libxkbcommon maps them to the latter.
//   - **Nothing below U+0020, and not U+007F.** `keysymdef.h` gives BackSpace,
//     Tab, Return, Escape and Delete control characters. `charOf`'s contract is
//     the character a key *types*, and those type nothing — the same answer it
//     gives for a dead key.
//
// What is left out needs no table: Latin-1 is identity and the Unicode form is
// arithmetic, so a keysym whose code point either rule already produces is not
// written here even when the header annotates it.
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = new URL('../src/keysymchars.js', import.meta.url);

const CANDIDATES = [
  process.env.KEYSYMDEF,
  '/usr/include/X11/keysymdef.h',
  '/usr/X11R6/include/X11/keysymdef.h',
  '/opt/X11/include/X11/keysymdef.h',
  '/opt/homebrew/include/X11/keysymdef.h',
].filter(Boolean);

// The high byte of a keysym is its block in keysymdef.h, and the file is
// written block by block — so naming them here is what makes the generated
// table readable, one line per block, rather than 780 numbers in a row. A
// block that turns up unnamed is an error rather than a fallback: it means
// the header grew something this comment should describe.
const BLOCKS = [
  [0x01, 'Latin-2'],
  [0x02, 'Latin-3'],
  [0x03, 'Latin-4'],
  [0x04, 'Katakana'],
  [0x05, 'Arabic'],
  [0x06, 'Cyrillic'],
  [0x07, 'Greek'],
  [0x08, 'Technical'],
  [0x09, 'Special'],
  [0x0a, 'Publishing'],
  [0x0b, 'APL'],
  [0x0c, 'Hebrew'],
  [0x0d, 'Thai'],
  [0x0e, 'Korean'],
  [0x13, 'Latin-8 and Latin-9'],
  [0x20, 'Currency'],
  [0xff, 'the keypad'],
];

function readKeysymdef() {
  for (const path of CANDIDATES) {
    try {
      return { path, text: readFileSync(path, 'utf8') };
    } catch {
      /* the next candidate */
    }
  }
  throw new Error(
    `no keysymdef.h in ${CANDIDATES.join(', ')} — install the X11 headers ` +
      '(x11proto-dev, libx11-dev, xorgproto) or set KEYSYMDEF',
  );
}

const { path, text } = readKeysymdef();
const chars = new Map();
for (const m of text.matchAll(
  /^#define\s+XK_(\w+)\s+(0x[0-9a-fA-F]+)\s*\/\*\s*(.*?)\s*\*\/\s*$/gm,
)) {
  // `/* U+0439 CYRILLIC … */`, and `/* (U+0E3E THAI …) */` for a keysym the
  // header marks deprecated — the parenthesis is the marker, not the mapping.
  const u = /^\(?U\+([0-9A-Fa-f]{4,6})/.exec(m[3]);
  if (u) chars.set(parseInt(m[2], 16), parseInt(u[1], 16));
}
if (chars.size < 1000) throw new Error(`only ${chars.size} entries in ${path}`);

chars.set(0xabc, 0x27e8); // leftanglebracket, U+2329 deprecated
chars.set(0xabe, 0x27e9); // rightanglebracket, U+232A deprecated
chars.set(0xff80, 0x20); // KP_Space
chars.set(0xffbd, 0x3d); // KP_Equal
// KP_Multiply … KP_Divide, then KP_0 … KP_9: `*+,-./` and `0`–`9`, one run.
for (let i = 0; i <= 0xffb9 - 0xffaa; i++) chars.set(0xffaa + i, 0x2a + i);

const algorithmic = (keysym, cp) =>
  (keysym >= 0x20 && keysym <= 0xff && keysym === cp) ||
  (keysym >= 0x01000000 && keysym <= 0x0110ffff && keysym - 0x01000000 === cp);

const entries = [...chars]
  .filter(
    ([keysym, cp]) => !algorithmic(keysym, cp) && cp >= 0x20 && cp !== 0x7f,
  )
  .sort((a, b) => a[0] - b[0]);

// `<keysym>:<codePoint>`, and `<keysym>+<n>:<codePoint>` where the next n
// keysyms carry the next n code points — which is most of Thai, Korean,
// Arabic and the keypad, and is what keeps the whole table under 4 KB.
const runs = [];
for (const [keysym, cp] of entries) {
  const last = runs.at(-1);
  if (last && keysym === last.keysym + last.n && cp === last.cp + last.n)
    last.n++;
  else runs.push({ keysym, cp, n: 1 });
}

const hex = (n) => n.toString(16);
const lines = [];
for (const [high, name] of BLOCKS) {
  const mine = runs.filter((r) => r.keysym >>> 8 === high);
  if (!mine.length) continue;
  const count = mine.reduce((a, r) => a + r.n, 0);
  const encoded = mine
    .map(
      (r) => hex(r.keysym) + (r.n > 1 ? `+${r.n - 1}` : '') + ':' + hex(r.cp),
    )
    .join(' ');
  lines.push(
    `  // ${name} (0x${hex(high).padStart(2, '0')}xx), ${count} keysyms\n  '${encoded}',`,
  );
}
const unnamed = runs.filter(
  (r) => !BLOCKS.some(([high]) => r.keysym >>> 8 === high),
);
if (unnamed.length)
  throw new Error(
    `keysym block 0x${hex(unnamed[0].keysym >>> 8)}xx has no name in BLOCKS`,
  );

writeFileSync(
  OUT,
  `// Generated by scripts/keysym-chars.mjs from X11's keysymdef.h — do not edit.
//
// The character each legacy keysym produces, run-length encoded: a run is
// \`<keysym>:<codePoint>\` in hex, or \`<keysym>+<n>:<codePoint>\` where the
// next n keysyms carry the next n code points. \`charOf\` (src/keysyms.js)
// expands it once, on first use. One line per keysymdef.h block, because that
// is how the header is organised and how a regeneration reads as a diff.
//
// Latin-1 and the Unicode keysym form are rules rather than entries and are
// not in here; neither is any keysym whose character is a control character,
// which is a key that types nothing.
export const KEYSYM_CHAR_RUNS = [
${lines.join('\n')}
];
`,
);
console.log(
  `${entries.length} keysyms in ${runs.length} runs, from ${path} -> src/keysymchars.js`,
);
