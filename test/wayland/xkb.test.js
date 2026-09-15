// The XKB keymap reader (src/wayland/xkb.js): keycodes, types with
// modifier→level maps, symbols with two groups and an AltGr level, and the
// compat/modmap lines that bind the LevelThree virtual modifier to a real
// one. Pure — no compositor.
//
// Two fixtures, because the grammar has two spellings in the wild and only
// one of them ever reaches this parser for real:
//
//  - `KEYMAP` below is hand-written in **xkbcomp's** spelling, the one
//    `xkbcomp -xkb :0` prints — keysyms by name, `symbols[Group1]`. It is
//    where the level, group and modifier rules are asserted, because it can
//    be read.
//  - `test/fixtures/xkb-libxkbcommon-us-de.xkb` is **libxkbcommon's** output,
//    byte for byte, which is what every compositor sends over
//    `wl_keyboard.keymap`: hex keysyms, and the group subscript as a bare
//    number (`symbols[1]`). Hand-writing that shape is how it went wrong the
//    first time — the parser read only `symbols[Group1]`, fell through to
//    the bare-form fallback, and took the subscript `[1]` for the symbol
//    list, so every key on the keyboard typed `1`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { XkbKeymap, REAL_MODS } from '../../src/wayland/xkb.js';
import { keysymFromName } from '../../src/wayland/keysymnames.js';

const KEYMAP = `xkb_keymap {
xkb_keycodes "(unnamed)" {
	minimum = 8;
	maximum = 255;
	<ESC>                = 9;
	<AE01>               = 10;
	<AE02>               = 11;
	<AD01>               = 24;
	<AD03>               = 26;
	<AC01>               = 38;
	<CAPS>               = 66;
	<LFSH>               = 50;
	<NMLK>               = 77;
	<KP7>                = 79;
	<KPDL>               = 91;
	<LVL3>               = 92;
	<RALT>               = 108;
	alias <LatQ> = <AD01>;
};

xkb_types "(unnamed)" {
	virtual_modifiers NumLock,Alt,LevelThree,LevelFive,Meta,Super,Hyper,ScrollLock;

	type "ONE_LEVEL" {
		modifiers= none;
		level_name[1]= "Any";
	};
	type "TWO_LEVEL" {
		modifiers= Shift;
		map[Shift]= 2;
		level_name[1]= "Base";
		level_name[2]= "Shift";
	};
	type "ALPHABETIC" {
		modifiers= Shift+Lock;
		map[Shift]= 2;
		map[Lock]= 2;
		level_name[1]= "Base";
		level_name[2]= "Caps";
	};
	type "FOUR_LEVEL" {
		modifiers= Shift+LevelThree;
		map[Shift]= 2;
		map[LevelThree]= 3;
		map[Shift+LevelThree]= 4;
		level_name[1]= "Base";
		level_name[2]= "Shift";
		level_name[3]= "Alt Base";
		level_name[4]= "Shift Alt";
	};
	type "KEYPAD" {
		modifiers= Shift+NumLock;
		map[NumLock]= 2;
		level_name[1]= "Base";
		level_name[2]= "Number";
	};
	type "FOUR_LEVEL_KEYPAD" {
		modifiers= Shift+NumLock+LevelThree;
		map[Shift]= 2;
		map[NumLock]= 2;
		map[Shift+NumLock]= 1;
		map[LevelThree]= 3;
		map[Shift+LevelThree]= 4;
		map[NumLock+LevelThree]= 4;
		map[Shift+NumLock+LevelThree]= 3;
		level_name[1]= "Base";
		level_name[2]= "Shift/Numlock";
		level_name[3]= "AltGr";
		level_name[4]= "Shift AltGr";
	};
	type "FOUR_LEVEL_ALPHABETIC" {
		modifiers= Shift+Lock+LevelThree;
		map[Shift]= 2;
		map[Lock]= 2;
		map[LevelThree]= 3;
		map[Shift+LevelThree]= 4;
		map[Lock+LevelThree]= 4;
		map[Shift+Lock+LevelThree]= 3;
		level_name[1]= "Base";
		level_name[2]= "Shift";
		level_name[3]= "AltGr";
		level_name[4]= "Shift AltGr";
	};
};

xkb_compatibility "(unnamed)" {
	virtual_modifiers NumLock,Alt,LevelThree,LevelFive,Meta,Super,Hyper,ScrollLock;

	interpret.useModMapMods= AnyLevel;
	interpret ISO_Level3_Shift+AnyOf(all) {
		virtualModifier= LevelThree;
		useModMapMods=level1;
		action= SetMods(modifiers=LevelThree,clearLocks);
	};
	interpret Alt_R+AnyOf(all) {
		virtualModifier= Alt;
		action= SetMods(modifiers=modMapMods,clearLocks);
	};
	interpret Shift_L+AnyOf(all) {
		action= SetMods(modifiers=Shift,clearLocks);
	};
};

xkb_symbols "(unnamed)" {
	name[Group1]="English (US)";
	name[Group2]="Russian";

	key <ESC>                {	[          Escape ] };
	key <AE01>               {
		type= "FOUR_LEVEL",
		symbols[Group1]= [               1,          exclam,      onesuperior,      exclamdown ],
		symbols[Group2]= [               1,          exclam ]
	};
	key <AE02>               {
		type= "FOUR_LEVEL",
		symbols[Group1]= [          eacute,               2,       asciitilde,           breve ],
		symbols[Group2]= [        Cyrillic_tse,    Cyrillic_TSE ]
	};
	key <AD01>               {
		symbols[Group1]= [               q,               Q ],
		symbols[Group2]= [     Cyrillic_shorti, Cyrillic_SHORTI ]
	};
	key <AD03>               {
		type= "FOUR_LEVEL_ALPHABETIC",
		symbols[Group1]= [               e,               E,         EuroSign,            cent ],
		symbols[Group2]= [       Cyrillic_u,      Cyrillic_U ]
	};
	key <AC01>               {	[               a,               A ] };
	key <CAPS>               {	[       Caps_Lock ] };
	key <LFSH>               {	[         Shift_L ] };
	key <NMLK>               {	[        Num_Lock ] };
	key <KP7>                {	[         KP_Home,            KP_7 ] };
	key <KPDL>               {	[       KP_Delete,      KP_Decimal,       KP_Delete,      KP_Decimal ] };
	key <LVL3>               {	[ ISO_Level3_Shift ] };
	key <RALT>               {
		type= "ONE_LEVEL",
		symbols[Group1]= [           Alt_R ],
		symbols[Group2]= [ ISO_Level3_Shift ]
	};
	modifier_map Shift { <LFSH> };
	modifier_map Lock { <CAPS> };
	modifier_map Mod2 { <NMLK> };
	modifier_map Mod1 { <RALT> };
	modifier_map Mod5 { <LVL3> };
};

};
`;

test('keysym names resolve: keysymdef, Unicode and hex spellings', () => {
  assert.equal(keysymFromName('q'), 0x71);
  assert.equal(keysymFromName('exclam'), 0x21);
  assert.equal(keysymFromName('Escape'), 0xff1b);
  assert.equal(keysymFromName('ISO_Level3_Shift'), 0xfe03);
  assert.equal(keysymFromName('Cyrillic_shorti'), 0x6ca);
  assert.equal(keysymFromName('EuroSign'), 0x20ac);
  assert.equal(keysymFromName('U20AC'), 0x01000000 + 0x20ac);
  assert.equal(
    keysymFromName('U0041'),
    0x41,
    'Latin-1 code points are their own keysyms',
  );
  assert.equal(keysymFromName('0xff0d'), 0xff0d);
  assert.equal(keysymFromName('NoSymbol'), 0);
  assert.equal(keysymFromName('not_a_keysym_anyone_has'), undefined);
});

test('keycodes, aliases and the X core table', () => {
  const km = XkbKeymap.parse(KEYMAP);
  assert.equal(km.names.get('AD01'), 24);
  assert.equal(km.names.get('LatQ'), 24, 'aliases resolve to the same code');
  // two keysyms per group, groups side by side — what GetKeyboardMapping answers
  assert.deepEqual(km.keycode2keysyms[24], [0x71, 0x51, 0x6ca, 0x6ea]);
  assert.deepEqual(km.keycode2keysyms[10].slice(0, 2), [0x31, 0x21]);
  assert.equal(km.keysym2keycode.get(0x71), 24);
  assert.equal(km.keys.size, 13);
});

test('virtual modifiers resolve through interpret + modifier_map', () => {
  const km = XkbKeymap.parse(KEYMAP);
  // ISO_Level3_Shift sets LevelThree, and the keys that produce it sit in Mod5
  assert.equal(km.vmods.get('LevelThree'), REAL_MODS.Mod5);
  assert.equal(km.modmap.get(92), REAL_MODS.Mod5);
  assert.equal(km.modmap.get(66), REAL_MODS.Lock);
  // NumLock is bound by nothing here, which is the common case — a keymap
  // carries no `interpret Num_Lock`, so the assumption in VMOD_FALLBACK is
  // what the KEYPAD type's `map[NumLock]` resolves through.
  assert.equal(km.vmods.get('NumLock'), REAL_MODS.Mod2);
  // `<RALT>` is in Mod1 and carries ISO_Level3_Shift on its *second* group,
  // so the bits it lends are Alt's and not LevelThree's. Before, LevelThree
  // collected them too and came out Mod1|Mod5 — which `_levelFor` compares
  // for equality, so a real AltGr press (Mod5 alone) never matched level 3.
  assert.equal(km.vmods.get('Alt'), REAL_MODS.Mod1, "<RALT>'s primary symbol");
  assert.equal(km.modmap.get(108), REAL_MODS.Mod1);
});

test('the implicit type of a keypad key is KEYPAD, not TWO_LEVEL', () => {
  const km = XkbKeymap.parse(KEYMAP);
  // `[KP_Home, KP_7]` is not a case pair, so the ladder used to fall past
  // ALPHABETIC straight to TWO_LEVEL — whose `map[Shift]= 2` puts the digit
  // on Shift and leaves NumLock with nothing to do. That inverts the keypad:
  // the digit keys move the cursor and Shift is what types a number.
  const kp7 = km.names.get('KP7');
  assert.equal(km.keys.get(kp7).groups[0].type.name, 'KEYPAD');
  assert.equal(
    km.decode(kp7, REAL_MODS.Mod2, 0).keysym,
    0xffb7,
    'NumLock: KP_7',
  );
  assert.equal(km.decode(kp7, 0, 0).keysym, 0xff95, 'NumLock off: KP_Home');
  assert.equal(
    km.decode(kp7, REAL_MODS.Shift, 0).keysym,
    0xff95,
    'Shift is not what makes a digit',
  );
  assert.equal(
    km.decode(kp7, REAL_MODS.Shift | REAL_MODS.Mod2, 0).keysym,
    0xff95,
    'and it takes one away: KEYPAD maps Shift+NumLock to level 1',
  );

  // The same rung four levels up, which is where a layout that puts its own
  // symbols on the keypad lands (`kpdl`, `hu`, `bg`).
  const kpdl = km.names.get('KPDL');
  assert.equal(km.keys.get(kpdl).groups[0].type.name, 'FOUR_LEVEL_KEYPAD');
  assert.equal(km.decode(kpdl, REAL_MODS.Mod2, 0).keysym, 0xffae, 'KP_Decimal');
  assert.equal(km.decode(kpdl, 0, 0).keysym, 0xff9f, 'KP_Delete');
});

test('a NoSymbol level is a level, not an absence', () => {
  // `key <ALT> { [ NoSymbol, Alt_L ] };` — a real keymap writes the extra
  // modifier keys this way. Counting the non-zero entries made it ONE_LEVEL,
  // and the one level it had was NoSymbol, so the key decoded to nothing in
  // every modifier state. Only *trailing* NoSymbols are trimmed.
  const km = XkbKeymap.parse(LIBXKBCOMMON);
  const alt = km.names.get('ALT');
  assert.equal(km.keys.get(alt).groups[0].type.name, 'TWO_LEVEL');
  assert.equal(km.decode(alt, 0, 0), undefined, 'level 1 still types nothing');
  assert.equal(km.decode(alt, REAL_MODS.Shift, 0).keysym, 0xffe9, 'Alt_L');
  assert.equal(
    km.decode(km.names.get('META'), REAL_MODS.Shift, 0).keysym,
    0xffe7,
    'Meta_L, the same shape',
  );
  assert.equal(
    km.decode(km.names.get('SUPR'), REAL_MODS.Shift, 0).keysym,
    0xffeb,
  );
  assert.equal(
    km.decode(km.names.get('HYPR'), REAL_MODS.Shift, 0).keysym,
    0xffed,
  );
});

test('useModMapMods is read out of the keymap, not assumed', () => {
  // `useModMapMods= level1` is what narrows ISO_Level3_Shift to the primary
  // symbol, and `interpret.useModMapMods= AnyLevel` is the section default
  // beside it — so a keymap that means the wide rule says so, and gets it.
  // Take the one line out and LevelThree really does collect <RALT>'s Mod1.
  const wide = KEYMAP.replace(/\n\t\tuseModMapMods=level1;/, '');
  assert.notEqual(
    wide,
    KEYMAP,
    'the line the fixture is edited on still exists',
  );
  assert.equal(
    XkbKeymap.parse(wide).vmods.get('LevelThree'),
    REAL_MODS.Mod1 | REAL_MODS.Mod5,
  );
  // …and Alt, which never said level1, keeps its bits either way.
  assert.equal(XkbKeymap.parse(wide).vmods.get('Alt'), REAL_MODS.Mod1);
});

test('decode: levels by type, shift, caps and AltGr', () => {
  const km = XkbKeymap.parse(KEYMAP);
  const q = (mods, group = 0) => km.decode(24, mods, group);
  assert.equal(q(0).keysym, 0x71, 'q');
  assert.equal(q(REAL_MODS.Shift).keysym, 0x51, 'Q with shift');
  assert.equal(
    q(REAL_MODS.Lock).keysym,
    0x51,
    'Q with caps: ALPHABETIC folds Lock',
  );
  // ALPHABETIC maps Shift and Lock each to level 2 and says nothing about
  // both together, so both together select level 1 — Shift under Caps Lock
  // types lowercase, which is what every X desktop actually does.
  assert.equal(
    q(REAL_MODS.Lock | REAL_MODS.Shift).keysym,
    0x71,
    'shift+caps on ALPHABETIC is level 1 again',
  );
  assert.equal(q(0).codepoint, 0x71);
  assert.equal(
    q(REAL_MODS.Shift).baseKeysym,
    0x71,
    'the accelerator keysym is group 1 level 1',
  );

  const e = (mods) => km.decode(26, mods, 0);
  assert.equal(
    e(REAL_MODS.Mod5).keysym,
    0x20ac,
    'AltGr+e is the Euro sign through the resolved LevelThree',
  );
  assert.equal(
    e(REAL_MODS.Mod5 | REAL_MODS.Shift).keysym,
    0xa2,
    'Shift+AltGr+e is cent',
  );
  assert.equal(
    e(REAL_MODS.Mod5 | REAL_MODS.Lock).keysym,
    0xa2,
    'Lock+LevelThree maps to level 4 per the type',
  );

  const one = (mods) => km.decode(10, mods, 0);
  assert.equal(
    one(REAL_MODS.Lock).keysym,
    0x31,
    "caps is not among FOUR_LEVEL's modifiers, so the number row ignores it",
  );
  assert.equal(one(REAL_MODS.Shift).keysym, 0x21, '!');

  // group 2 (Russian): the Cyrillic level, with fallback to group 1 for keys
  // the layout does not define
  assert.equal(q(0, 1).keysym, 0x6ca);
  assert.equal(q(REAL_MODS.Shift, 1).keysym, 0x6ea);
  assert.equal(
    q(0, 1).baseKeysym,
    0x71,
    'Ctrl+Q stays Ctrl+Q while typing Cyrillic',
  );
  assert.equal(
    km.decode(9, 0, 1).keysym,
    0xff1b,
    'Escape has no group 2 and falls back to group 1',
  );
  assert.equal(
    km.decode(9, 0, 0).codepoint,
    undefined,
    'a control keysym types nothing',
  );
  assert.equal(
    km.decode(200, 0, 0),
    undefined,
    'an unmapped keycode decodes to nothing',
  );
});

test('a decoded key carries the character it types, whatever block it is in', () => {
  const km = XkbKeymap.parse(KEYMAP);
  // The keysym was always right and the code point was always missing, so a
  // Russian, Greek, Czech, Polish, Hebrew, Arabic or Thai layout had live
  // keys that typed nothing at all — `charOf` spelled Latin-1 and the
  // Unicode form and neither of those is what a keymap is written in.
  assert.equal(km.decode(24, 0, 1).codepoint, 0x439, 'й on the Russian group');
  assert.equal(
    km.decode(24, REAL_MODS.Shift, 1).codepoint,
    0x419,
    'Й with shift',
  );
  assert.equal(
    km.decode(26, REAL_MODS.Mod5, 0).codepoint,
    0x20ac,
    'AltGr+e types a Euro sign rather than nothing',
  );
  assert.equal(km.decode(24, 0, 0).codepoint, 0x71, 'and Latin-1 is unmoved');

  // The keypad is the same defect without a script behind it: the levels are
  // right (the KEYPAD type) and the digits typed nothing.
  const kp7 = km.names.get('KP7');
  assert.equal(km.decode(kp7, REAL_MODS.Mod2, 0).codepoint, 0x37, 'KP_7 is 7');
  assert.equal(
    km.decode(kp7, 0, 0).codepoint,
    undefined,
    'KP_Home still types nothing',
  );
  assert.equal(
    km.decode(km.names.get('KPDL'), REAL_MODS.Mod2, 0).codepoint,
    0x2e,
    'KP_Decimal is a full stop',
  );
});

test('Caps Lock case-maps the keysym, it does not pair levels', () => {
  const km = XkbKeymap.parse(KEYMAP);
  // AZERTY's `é` key is `[é, 2, ~, ˘]` — level 2 is a digit, so there is no
  // uppercase sibling to find, and Caps Lock used to do nothing at all here.
  // FOUR_LEVEL never mentions Lock, so Lock is not consumed and the
  // capitalisation is still owed.
  const e = km.names.get('AE02');
  assert.equal(km.decode(e, 0, 0).keysym, 0xe9, 'é');
  assert.equal(km.decode(e, REAL_MODS.Lock, 0).keysym, 0xc9, 'Caps: É');
  assert.equal(km.decode(e, REAL_MODS.Lock, 0).codepoint, 0xc9);
  assert.equal(km.decode(e, REAL_MODS.Shift, 0).keysym, 0x32, 'Shift: 2');

  // Cyrillic capitalises too, which needed `charOf` to be able to spell it
  // before it could case-map it. Here the key is ALPHABETIC, so `map[Lock]`
  // has already picked level 2 and the transform must *not* run again.
  const q = km.names.get('AD01');
  assert.equal(km.keys.get(q).groups[1].type.name, 'ALPHABETIC');
  assert.equal(km.decode(q, REAL_MODS.Lock, 1).keysym, 0x6ea, 'Caps: Й');
  assert.equal(
    km.decode(q, REAL_MODS.Lock | REAL_MODS.Shift, 1).keysym,
    0x6ca,
    'Shift under Caps is lowercase again, and stays lowercase',
  );
  assert.equal(
    km.decode(km.names.get('AC01'), REAL_MODS.Lock, 0).keysym,
    0x41,
    'a plain ALPHABETIC key is capitalised once, not twice',
  );
  assert.equal(
    km.decode(km.names.get('ESC'), REAL_MODS.Lock, 0).keysym,
    0xff1b,
    'a key with no case is untouched',
  );
});

test('the X state word carries modifiers low and the group in bits 13-14', () => {
  assert.equal(XkbKeymap.stateOf(REAL_MODS.Shift | REAL_MODS.Control, 0), 5);
  assert.equal(XkbKeymap.stateOf(0, 1), 1 << 13);
  assert.equal(XkbKeymap.stateOf(REAL_MODS.Lock, 2), 2 | (2 << 13));
});

// --- the real thing ------------------------------------------------------
//
// `us,de` on pc105: two groups, so every printable key gets the subscripted
// form; German brings a per-group `type[2]=` and an AltGr level; and the
// function keys carry an explicit `type=`, which is what makes libxkbcommon
// write *them* subscripted even for a single-layout keymap. See
// `test/fixtures/README.md` for how it was generated.
const LIBXKBCOMMON = readFileSync(
  new URL('../fixtures/xkb-libxkbcommon-us-de.xkb', import.meta.url),
  'utf8',
);

test('the fixture is really in libxkbcommon spelling', () => {
  // Regenerating it with `xkbcomp -xkb` instead would quietly turn every
  // assertion below back into a test of the spelling that already worked.
  assert.match(LIBXKBCOMMON, /symbols\[1\]=/);
  assert.match(LIBXKBCOMMON, /type\[2\]=/);
  assert.doesNotMatch(LIBXKBCOMMON, /symbols\[Group\d\]/);
  assert.match(LIBXKBCOMMON, /maximum = 708/, 'the extended keycode range');
});

test('libxkbcommon: a bare group subscript is a group, not a symbol list', () => {
  const km = XkbKeymap.parse(LIBXKBCOMMON);
  const ab01 = km.names.get('AB01');
  // The key US calls `z` and Germany calls `y` — one key, both groups, the
  // whole point of the subscripted form.
  assert.equal(km.decode(ab01, 0, 0).keysym, 0x7a, 'z on the US group');
  assert.equal(km.decode(ab01, REAL_MODS.Shift, 0).keysym, 0x5a, 'Z');
  assert.equal(km.decode(ab01, 0, 1).keysym, 0x79, 'y on the German group');
  assert.equal(km.decode(ab01, 0, 0).codepoint, 0x7a);
  // …and the X core table gets both groups, which is what ntk's decodeKey
  // and the accelerator path read.
  assert.deepEqual(km.keycode2keysyms[ab01], [0x7a, 0x5a, 0x79, 0x59]);

  // Nothing is left to the bare-form fallback: before the fix every one of
  // these decoded to the keysym named `1`, which is the bug this fixture is
  // here to keep out. `AE01` is the only key that may legitimately say 0x31.
  const one = km.names.get('AE01');
  const wrong = [...km.keys.keys()].filter(
    (code) => code !== one && km.decode(code, 0, 0)?.keysym === 0x31,
  );
  assert.deepEqual(wrong, [], 'no key decodes to the keysym named `1`');
});

test('libxkbcommon: a per-group type subscript, and an implicit type beside it', () => {
  const km = XkbKeymap.parse(LIBXKBCOMMON);
  const ae11 = km.names.get('AE11');
  const groups = km.keys.get(ae11).groups;
  assert.equal(
    groups[1].type.name,
    'FOUR_LEVEL_PLUS_LOCK',
    'group 2 names its type as `type[2]=`',
  );
  assert.equal(
    groups[0].type.name,
    'TWO_LEVEL',
    'group 1 names none and falls to the implicit type for two symbols',
  );
  assert.equal(km.decode(ae11, 0, 0).keysym, 0x2d, '- on the US group');
  assert.equal(km.decode(ae11, 0, 1).keysym, 0xdf, 'ß on the German group');
});

test('libxkbcommon: an explicit type subscripts a single-group key too', () => {
  const km = XkbKeymap.parse(LIBXKBCOMMON);
  // F1 has one group, but `type= "CTRL+ALT"` makes libxkbcommon write it
  // `symbols[1]= [ ... ]` — so the function keys decode wrong on *every*
  // setup, single layout or not, where the letters only break at two.
  assert.equal(km.decode(km.names.get('FK01'), 0, 0).keysym, 0xffbe, 'F1');
  assert.equal(km.decode(km.names.get('FK12'), 0, 0).keysym, 0xffc9, 'F12');
  assert.equal(
    km.decode(km.names.get('KPDV'), 0, 0).keysym,
    0xffaf,
    'the keypad divide, same shape',
  );
});

test("libxkbcommon: the keypad is NumLock's, not Shift's", () => {
  const km = XkbKeymap.parse(LIBXKBCOMMON);
  // libxkbcommon writes the keypad bare — `key <KP7> { [ 0xff95, 0xffb7 ] };`
  // — so every keypad key on every layout takes the implicit type, and the
  // implicit type is the whole behaviour of the keypad.
  const kp7 = km.names.get('KP7');
  assert.equal(km.keys.get(kp7).groups[0].type.name, 'KEYPAD');
  assert.equal(
    km.decode(kp7, REAL_MODS.Mod2, 0).keysym,
    0xffb7,
    'NumLock: KP_7',
  );
  assert.equal(km.decode(kp7, 0, 0).keysym, 0xff95, 'NumLock off: KP_Home');
  assert.equal(
    km.decode(kp7, REAL_MODS.Shift, 0).keysym,
    0xff95,
    'Shift: KP_Home',
  );
  // Mod2 is what the compositor reports for NumLock, and the keymap agrees
  // through `modifier_map Mod2 { <NMLK> }`.
  assert.equal(km.modmap.get(km.names.get('NMLK')), REAL_MODS.Mod2);
});

test('libxkbcommon: AltGr reaches the third level of the second layout', () => {
  const km = XkbKeymap.parse(LIBXKBCOMMON);
  // The shape that broke it, straight out of the fixture: `<RALT>` is
  // `modifier_map Mod1` for the US group's Alt_R and carries
  // ISO_Level3_Shift for the German one, and it is the *second* group that
  // carries it — so LevelThree used to resolve to Mod1|Mod5 and AltGr did
  // nothing on any layout with a level 3.
  assert.equal(km.vmods.get('LevelThree'), REAL_MODS.Mod5);
  assert.equal(km.vmods.get('LevelFive'), REAL_MODS.Mod3);
  const ralt = km.names.get('RALT');
  assert.equal(km.modmap.get(ralt), REAL_MODS.Mod1);
  assert.deepEqual(
    km.keys.get(ralt).groups.map((g) => g.syms[0]),
    [0xffea, 0xfe03],
    'Alt_R primary, ISO_Level3_Shift on group 2',
  );

  // …so the German group's AltGr levels are reachable again. Group 2 of
  // `<AD03>` is [ e, E, EuroSign, EuroSign ].
  const ad03 = km.names.get('AD03');
  assert.equal(km.decode(ad03, 0, 1).keysym, 0x65, 'e');
  assert.equal(
    km.decode(ad03, REAL_MODS.Mod5, 1).keysym,
    0x20ac,
    'AltGr+e is €',
  );
  assert.equal(
    km.decode(km.names.get('AD01'), REAL_MODS.Mod5, 1).keysym,
    0x40,
    'AltGr+q is @',
  );
  assert.equal(
    km.decode(km.names.get('AE11'), REAL_MODS.Mod5, 1).keysym,
    0x5c,
    'AltGr+ß is a backslash',
  );
});

test('libxkbcommon: whether Caps Lock still owes a capitalisation is `preserve`', () => {
  const km = XkbKeymap.parse(LIBXKBCOMMON);
  const lock = REAL_MODS.Lock;
  const altgr = REAL_MODS.Mod5;
  const de = 1; // the German group

  // `[s, S, ſ, ẞ]` — two lower/upper pairs, so FOUR_LEVEL_ALPHABETIC, whose
  // `map[Lock+LevelThree]= 4` has already chosen the capital and consumes
  // Lock doing it. Capitalising on top would be doing it twice.
  const s = km.names.get('AC02');
  assert.equal(km.keys.get(s).groups[de].type.name, 'FOUR_LEVEL_ALPHABETIC');
  assert.equal(km.decode(s, altgr, de).keysym, 0x0100017f, 'AltGr: ſ');
  assert.equal(
    km.decode(s, altgr | lock, de).keysym,
    0x01001e9e,
    'Caps+AltGr: ẞ',
  );

  // `[w, W, ſ, §]` — `§` is not an uppercase letter, so
  // FOUR_LEVEL_SEMIALPHABETIC, whose `preserve[Lock+LevelThree]= Lock` hands
  // Lock back: level 3 is `ſ` and the capitalisation is still owed. There is
  // no key anywhere with `ſ` and `S` side by side, so no amount of pairing
  // levels could ever have found this one.
  const w = km.names.get('AD02');
  assert.equal(
    km.keys.get(w).groups[de].type.name,
    'FOUR_LEVEL_SEMIALPHABETIC',
  );
  assert.equal(km.decode(w, altgr, de).keysym, 0x0100017f, 'AltGr: ſ');
  assert.equal(km.decode(w, altgr | lock, de).keysym, 0x53, 'Caps+AltGr: S');
  assert.equal(
    km.decode(w, altgr | lock | REAL_MODS.Shift, de).keysym,
    0xa7,
    '§',
  );

  // The same preserved Lock over a level with no case at all leaves it alone.
  assert.equal(
    km.decode(km.names.get('AD01'), altgr | lock, de).keysym,
    0x40,
    'Caps+AltGr+q is still @',
  );
  // …and the ALPHABETIC ladder one rung up still picks the level itself.
  assert.equal(
    km.decode(km.names.get('AC01'), altgr | lock, de).keysym,
    0xc6,
    'Caps+AltGr+a is Æ, chosen by the type',
  );
  assert.equal(
    km.decode(km.names.get('AC01'), lock, de).keysym,
    0x41,
    'Caps: A',
  );
});

test('libxkbcommon: the bare one-line form still reads', () => {
  const km = XkbKeymap.parse(LIBXKBCOMMON);
  // A key with one group and no explicit type is written `key <ESC> { [ ... ] };`
  // — no subscript anywhere. These kept working throughout, which is why the
  // bug looked like "typing is broken but Return and the arrows are fine".
  assert.equal(km.decode(km.names.get('ESC'), 0, 0).keysym, 0xff1b);
  assert.equal(km.decode(km.names.get('RTRN'), 0, 0).keysym, 0xff0d);
  assert.equal(km.decode(km.names.get('SPCE'), 0, 0).codepoint, 0x20);
});
