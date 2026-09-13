// An XKB keymap, read from the text the compositor sends.
//
// On X11 the server interprets the keyboard: a key event arrives with a
// keycode and the client asks `GetKeyboardMapping` what it means. On Wayland
// the compositor sends the whole keymap once — as a file descriptor holding
// `xkb_keymap { ... }` in libxkbcommon's text format — and every event after
// that is a raw keycode the client interprets itself. libxkbcommon is how a C
// client does that. This file is how this one does, and it is here rather
// than a `dlopen` of libxkbcommon for the reason the RFC gave: a keymap
// parser is the kind of code this project writes well, it runs on every
// runtime without a native library, and the subset a desktop actually uses
// is small.
//
// What is read:
//
//   xkb_keycodes   `<AD01> = 24;`                 name -> keycode
//   xkb_types      `type "FOUR_LEVEL" { modifiers= Shift+LevelThree;
//                     map[Shift]= 2; ... }`       modifier set -> level
//   xkb_symbols    `key <AD01> { [ q, Q ] };`     keycode -> keysyms per level,
//                  with `symbols[Group2]` and `type=` where given
//                  `modifier_map Mod5 { <LVL3> }` real modifier -> keycodes
//   xkb_compat     `interpret ISO_Level3_Shift { virtualModifier= LevelThree; }`
//                                                keysym -> virtual modifier
//
// From the last two, a virtual modifier like `LevelThree` resolves to the
// real modifier bit the compositor will actually report in
// `wl_keyboard.modifiers` — which is what makes AltGr work rather than being
// assumed to be Mod5. The assumptions are kept as a fallback for a keymap
// that does not say.
//
// What is not read: key actions (the compositor applies those; we only see
// their effect in the modifier state), indicators, geometry, and the
// per-type `preserve` rules.
//
// The output is two things. `keycode2keysyms` is the X core shape —
// `[g1l1, g1l2, g2l1, g2l2, …]` — because that is what `keyboard.js`'s
// accelerator resolution and ntk's `decodeKey` already consume, unchanged.
// `decode()` is the full answer, using the key's real type so that level 3
// and 4 (AltGr) resolve where the two-level core shape cannot express them.

import { charOf } from '../keysyms.js';
import { keysymFromName } from './keysymnames.js';

/** Real modifier bits, as X and XKB both number them. */
export const REAL_MODS = {
  Shift: 1,
  Lock: 2,
  Control: 4,
  Mod1: 8,
  Mod2: 16,
  Mod3: 32,
  Mod4: 64,
  Mod5: 128,
};

/** What a virtual modifier means when the keymap does not say. */
const VMOD_FALLBACK = {
  LevelThree: REAL_MODS.Mod5,
  NumLock: REAL_MODS.Mod2,
  Alt: REAL_MODS.Mod1,
  Meta: REAL_MODS.Mod1,
  Super: REAL_MODS.Mod4,
  Hyper: REAL_MODS.Mod4,
  LevelFive: REAL_MODS.Mod3,
  ScrollLock: 0,
  AltGr: REAL_MODS.Mod5,
};

const GROUP_SHIFT = 13;

export class XkbKeymap {
  constructor() {
    this.minKeycode = 8;
    this.maxKeycode = 255;
    /** name -> keycode, e.g. AD01 -> 24 */
    this.names = new Map();
    /** type name -> { mask, map: Map<modmask, level>, levels } */
    this.types = new Map();
    /** keycode -> { groups: Array<{ type, syms: number[] }> } */
    this.keys = new Map();
    /** virtual modifier name -> real modifier mask */
    this.vmods = new Map();
    /** keycode -> real modifier mask (from modifier_map) */
    this.modmap = new Map();
    /** keycode -> keysyms in the X core layout */
    this.keycode2keysyms = [];
    /** keysym -> keycode, for the accelerator path's reverse lookups */
    this.keysym2keycode = new Map();
  }

  static parse(text) {
    const km = new XkbKeymap();
    km._parse(text);
    return km;
  }

  // ---- parsing -------------------------------------------------------------

  _parse(text) {
    const src = stripComments(text);
    const section = (name) => {
      const m = src.match(new RegExp(`xkb_${name}\\s+(?:"[^"]*"\\s+)?\\{`));
      if (!m) return '';
      return balanced(src, m.index + m[0].length - 1);
    };
    this._parseKeycodes(section('keycodes'));
    this._parseTypes(section('types'));
    this._parseCompat(section('compatibility'));
    this._parseSymbols(section('symbols'));
    this._resolveVmods();
    this._buildCoreTable();
  }

  _parseKeycodes(s) {
    const range = s.match(/minimum\s*=\s*(\d+)\s*;\s*maximum\s*=\s*(\d+)/);
    if (range) {
      this.minKeycode = +range[1];
      this.maxKeycode = +range[2];
    }
    for (const m of s.matchAll(/<([A-Za-z0-9_+-]+)>\s*=\s*(\d+)\s*;/g)) {
      this.names.set(m[1], +m[2]);
    }
    // `alias <LatQ> = <AD01>;`
    for (const m of s.matchAll(
      /alias\s+<([A-Za-z0-9_+-]+)>\s*=\s*<([A-Za-z0-9_+-]+)>\s*;/g,
    )) {
      const code = this.names.get(m[2]);
      if (code !== undefined) this.names.set(m[1], code);
    }
  }

  _parseTypes(s) {
    const re = /type\s+"([^"]+)"\s*\{/g;
    let m;
    while ((m = re.exec(s))) {
      const body = balanced(s, m.index + m[0].length - 1);
      re.lastIndex = m.index + m[0].length + body.length;
      const type = { name: m[1], mods: [], map: [], levels: 1 };
      const mods = body.match(/modifiers\s*=\s*([^;]+);/);
      if (mods)
        type.mods = mods[1]
          .split('+')
          .map((x) => x.trim())
          .filter((x) => x && x !== 'none' && x !== 'None');
      for (const e of body.matchAll(
        /map\[([^\]]+)\]\s*=\s*(?:Level)?(\d+)\s*;/gi,
      )) {
        const set = e[1]
          .split('+')
          .map((x) => x.trim())
          .filter(Boolean);
        const level = +e[2];
        type.map.push({ set, level });
        if (level > type.levels) type.levels = level;
      }
      for (const e of body.matchAll(/level_name\[(?:Level)?(\d+)\]/gi)) {
        if (+e[1] > type.levels) type.levels = +e[1];
      }
      this.types.set(type.name, type);
    }
  }

  _parseCompat(s) {
    // interpret <keysym>[+cond] { virtualModifier= X; ... }
    const re = /interpret\s+([A-Za-z0-9_]+)(?:\+[^{]*)?\s*\{/g;
    let m;
    while ((m = re.exec(s))) {
      const body = balanced(s, m.index + m[0].length - 1);
      re.lastIndex = m.index + m[0].length + body.length;
      const vm = body.match(/virtualModifier\s*=\s*([A-Za-z0-9_]+)/i);
      if (!vm) continue;
      const sym = keysymFromName(m[1]);
      if (sym) (this._interp ??= new Map()).set(sym, vm[1]);
    }
  }

  _parseSymbols(s) {
    // key <NAME> { ... };
    const re = /key\s+<([A-Za-z0-9_+-]+)>\s*\{/g;
    let m;
    while ((m = re.exec(s))) {
      const body = balanced(s, m.index + m[0].length - 1);
      re.lastIndex = m.index + m[0].length + body.length;
      const code = this.names.get(m[1]);
      if (code === undefined) continue;
      const key = { groups: [] };
      // explicit per-group or global type
      const typeAll = body.match(/(?:^|[,{\s])type\s*=\s*"([^"]+)"/);
      const typeByGroup = new Map();
      for (const t of body.matchAll(/type\[Group(\d)\]\s*=\s*"([^"]+)"/g))
        typeByGroup.set(+t[1], t[2]);
      // symbols[GroupN]= [ a, b ]  and the bare form { [ a, b ] }
      const lists = [];
      for (const g of body.matchAll(
        /symbols\[Group(\d)\]\s*=\s*\[([^\]]*)\]/g,
      )) {
        lists[+g[1] - 1] = g[2];
      }
      if (lists.length === 0) {
        const bare = body.match(/\[([^\]]*)\]/);
        if (bare) lists[0] = bare[1];
      }
      for (let gi = 0; gi < lists.length; gi++) {
        if (lists[gi] === undefined) continue;
        const syms = lists[gi]
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
          .map((name) => keysymFromName(name) ?? 0);
        const typeName =
          typeByGroup.get(gi + 1) ?? typeAll?.[1] ?? implicitType(syms);
        key.groups[gi] = {
          type:
            this.types.get(typeName) ??
            this.types.get(implicitType(syms)) ??
            null,
          syms,
        };
      }
      if (key.groups.length) this.keys.set(code, key);
    }
    // modifier_map Mod5 { <LVL3>, <RALT> };
    for (const mm of s.matchAll(
      /modifier_map\s+([A-Za-z0-9]+)\s*\{([^}]*)\}/g,
    )) {
      const bit = REAL_MODS[mm[1]];
      if (!bit) continue;
      for (const k of mm[2].matchAll(/<([A-Za-z0-9_+-]+)>/g)) {
        const code = this.names.get(k[1]);
        if (code !== undefined)
          this.modmap.set(code, (this.modmap.get(code) ?? 0) | bit);
      }
      // bare keysyms are allowed too: modifier_map Shift { Shift_L }
      for (const k of mm[2].split(',')) {
        const name = k.trim();
        if (!name || name.startsWith('<')) continue;
        const sym = keysymFromName(name);
        if (sym) (this._modmapSyms ??= []).push({ sym, bit });
      }
    }
  }

  /**
   * Virtual modifier -> real modifier: the keys whose keysym `interpret`
   * binds to the virtual modifier are looked up in `modifier_map`, and the
   * real bits found there are the answer.
   */
  _resolveVmods() {
    const bySym = new Map(); // keysym -> real mask, from modmap via symbols
    for (const [code, key] of this.keys) {
      const bits = this.modmap.get(code);
      if (!bits) continue;
      for (const g of key.groups)
        for (const sym of g?.syms ?? [])
          if (sym) bySym.set(sym, (bySym.get(sym) ?? 0) | bits);
    }
    for (const { sym, bit } of this._modmapSyms ?? [])
      bySym.set(sym, (bySym.get(sym) ?? 0) | bit);
    for (const [sym, vmod] of this._interp ?? []) {
      const real = bySym.get(sym);
      if (real) this.vmods.set(vmod, (this.vmods.get(vmod) ?? 0) | real);
    }
    for (const [name, bit] of Object.entries(VMOD_FALLBACK)) {
      if (!this.vmods.has(name)) this.vmods.set(name, bit);
    }
  }

  /** A modifier name (real or virtual) as a real mask. */
  _modMask(name) {
    if (name in REAL_MODS) return REAL_MODS[name];
    return this.vmods.get(name) ?? 0;
  }

  /**
   * The X core keyboard mapping — two keysyms per group, up to four groups —
   * which is what `GetKeyboardMapping` would have answered.
   */
  _buildCoreTable() {
    const table = [];
    for (const [code, key] of this.keys) {
      const row = [];
      const ngroups = Math.max(1, key.groups.length);
      for (let gi = 0; gi < ngroups; gi++) {
        const g = key.groups[gi];
        row.push(g?.syms?.[0] ?? 0, g?.syms?.[1] ?? 0);
      }
      table[code] = row;
      const first = key.groups[0]?.syms?.[0];
      if (first && !this.keysym2keycode.has(first))
        this.keysym2keycode.set(first, code);
    }
    this.keycode2keysyms = table;
  }

  // ---- decoding ------------------------------------------------------------

  /**
   * Which level of a key's type the current modifiers select.
   *
   * XKB semantics: only the type's own modifiers are considered; the first
   * `map[]` entry whose set equals the masked state wins; no entry means
   * level 1. The set is matched as a mask rather than by name so that a
   * virtual modifier bound to two real ones still matches.
   */
  _levelFor(type, mods) {
    if (!type) return mods & REAL_MODS.Shift ? 1 : 0;
    let relevant = 0;
    for (const m of type.mods) relevant |= this._modMask(m);
    const masked = mods & relevant;
    for (const { set, level } of type.map) {
      let want = 0;
      for (const m of set) want |= this._modMask(m);
      if (want === masked) return level - 1;
    }
    return 0;
  }

  /**
   * Decode a key event.
   *
   * @param {number} keycode X-style (evdev + 8)
   * @param {number} mods real modifier mask (depressed | latched | locked)
   * @param {number} group effective layout group
   * @returns {{keysym:number, baseKeysym:number, codepoint:number|undefined, group:number}|undefined}
   */
  decode(keycode, mods, group = 0) {
    const key = this.keys.get(keycode);
    if (!key) return undefined;
    let g = key.groups[group];
    // a group with nothing on this key falls back to the first, as X does
    if (!g || !g.syms.some(Boolean))
      g = key.groups.find((x) => x?.syms?.some(Boolean));
    if (!g) return undefined;
    let level = this._levelFor(g.type, mods);
    if (level >= g.syms.length || !g.syms[level]) {
      // Lock on a one-level key, or Shift on a key with no upper level:
      // fall back the way the core protocol does — the first symbol,
      // uppercased when it has a case.
      level = 0;
    }
    let keysym = g.syms[level] ?? 0;
    // Caps Lock on a plain two-level alphabetic key whose type does not
    // fold Lock (a keymap with only "TWO_LEVEL" for letters): X core rule.
    if (
      level === 0 &&
      mods & REAL_MODS.Lock &&
      g.syms.length >= 2 &&
      !(mods & REAL_MODS.Shift)
    ) {
      const lower = charOf(g.syms[0]);
      const upper = charOf(g.syms[1]);
      if (
        lower &&
        upper &&
        lower !== upper &&
        lower.toUpperCase() === upper &&
        g.type?.mods?.includes('Lock') === false
      ) {
        keysym = g.syms[1];
      }
    }
    if (!keysym) return undefined;
    const ch = charOf(keysym);
    const codepoint = ch ? ch.codePointAt(0) : undefined;
    const base = key.groups[0]?.syms?.[0] || keysym;
    return {
      keysym,
      baseKeysym: base,
      codepoint:
        codepoint !== undefined && codepoint >= 0x20 ? codepoint : undefined,
      group,
    };
  }

  /**
   * The X-style `state` word: real modifiers in the low byte, the group in
   * bits 13-14 — what events.js's `buttons` field carries and what ntk's
   * `groupForState` reads.
   */
  static stateOf(mods, group) {
    return (mods & 0xff) | ((group & 3) << GROUP_SHIFT);
  }
}

/**
 * The type XKB assigns a key that names none: one symbol is ONE_LEVEL, two
 * are ALPHABETIC when they are a case pair and TWO_LEVEL otherwise, four are
 * FOUR_LEVEL(_ALPHABETIC / _SEMIALPHABETIC).
 */
function implicitType(syms) {
  const n = syms.filter(Boolean).length;
  if (n <= 1) return 'ONE_LEVEL';
  const casePair = (a, b) => {
    const la = charOf(a);
    const lb = charOf(b);
    return la && lb && la !== lb && la.toUpperCase() === lb;
  };
  if (n === 2) return casePair(syms[0], syms[1]) ? 'ALPHABETIC' : 'TWO_LEVEL';
  if (casePair(syms[0], syms[1]))
    return casePair(syms[2], syms[3])
      ? 'FOUR_LEVEL_ALPHABETIC'
      : 'FOUR_LEVEL_SEMIALPHABETIC';
  return 'FOUR_LEVEL';
}

/** Everything from `//` or `#` to the end of the line, outside strings. */
function stripComments(text) {
  return text.replace(/^\s*(\/\/|#).*$/gm, '');
}

/** The text between the brace at `open` and its match, exclusive. */
function balanced(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      i = s.indexOf('"', i + 1);
      if (i < 0) return s.slice(open + 1);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(open + 1, i);
  }
  return s.slice(open + 1);
}
