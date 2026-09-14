// The XKB keymap reader (src/wayland/xkb.js), against a keymap in the shape
// libxkbcommon serialises: keycodes, types with modifier→level maps, symbols
// with two groups and an AltGr level, and the compat/modmap lines that bind
// the LevelThree virtual modifier to a real one. Pure — no compositor.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { XkbKeymap, REAL_MODS } from '../../src/wayland/xkb.js';
import { keysymFromName } from '../../src/wayland/keysymnames.js';

const KEYMAP = `xkb_keymap {
xkb_keycodes "(unnamed)" {
	minimum = 8;
	maximum = 255;
	<ESC>                = 9;
	<AE01>               = 10;
	<AD01>               = 24;
	<AD03>               = 26;
	<AC01>               = 38;
	<CAPS>               = 66;
	<LFSH>               = 50;
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
	key <LVL3>               {	[ ISO_Level3_Shift ] };
	key <RALT>               {	[ ISO_Level3_Shift ] };
	modifier_map Shift { <LFSH> };
	modifier_map Lock { <CAPS> };
	modifier_map Mod5 { <LVL3>, <RALT> };
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
  assert.equal(km.keys.size, 9);
});

test('virtual modifiers resolve through interpret + modifier_map', () => {
  const km = XkbKeymap.parse(KEYMAP);
  // ISO_Level3_Shift sets LevelThree, and the keys that produce it sit in Mod5
  assert.equal(km.vmods.get('LevelThree'), REAL_MODS.Mod5);
  assert.equal(km.modmap.get(92), REAL_MODS.Mod5);
  assert.equal(km.modmap.get(66), REAL_MODS.Lock);
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

test('the X state word carries modifiers low and the group in bits 13-14', () => {
  assert.equal(XkbKeymap.stateOf(REAL_MODS.Shift | REAL_MODS.Control, 0), 5);
  assert.equal(XkbKeymap.stateOf(0, 1), 1 << 13);
  assert.equal(XkbKeymap.stateOf(REAL_MODS.Lock, 2), 2 | (2 << 13));
});
