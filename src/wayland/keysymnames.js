// Keysym names -> values, for reading an XKB keymap.
//
// An `xkb_symbols` section names its keysyms the way `keysymdef.h` does —
// `q`, `exclam`, `Return`, `ISO_Level3_Shift`, `dead_acute`, `KP_1` — with
// two extra spellings for anything the table does not have: `U20AC` for a
// Unicode code point and a plain hex number. node-x11 already ships the
// whole of keysymdef.h as `XK_<name>: { code }`, so this is a lookup and the
// two conventions, not a table of its own.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const table = require('x11/lib/keysyms.js');

const cache = new Map();

/**
 * @param {string} name a keysym as an XKB file spells it
 * @returns {number|undefined} the keysym, 0 for `NoSymbol`, undefined when unknown
 */
export function keysymFromName(name) {
  if (!name) return undefined;
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  let sym;
  if (name === 'NoSymbol' || name === 'VoidSymbol') sym = 0;
  else if (/^U[0-9A-Fa-f]{4,6}$/.test(name)) {
    const cp = parseInt(name.slice(1), 16);
    // Latin-1 is its own keysym range; everything else is 0x01000000 + cp.
    sym = cp >= 0x20 && cp <= 0xff ? cp : 0x01000000 + cp;
  } else if (/^0x[0-9A-Fa-f]+$/.test(name)) sym = parseInt(name, 16);
  else sym = table[`XK_${name}`]?.code;
  cache.set(name, sym);
  return sym;
}
