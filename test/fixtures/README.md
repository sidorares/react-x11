# Test fixtures

## `MonelogicsSubset[wght].ttf`

A variable font, for the `fontVariationSettings` tests. The KaTeX faces the
other tests use are static, so an axis has to come from somewhere; fontkit
cannot instantiate one out of a `.woff2`, so it has to be an uncompressed
face.

It is [monelogics](https://github.com/sklinkert/monelogics-font) 3.002 (a
derivative of Libre Franklin), subset to the glyphs the tests set with the
`wght` axis kept intact — 100–900, default 400. 187 KB down to 23 KB; the
axis and the `fvar`/`gvar` tables are untouched.

Licensed under the SIL Open Font License 1.1 — see `OFL.txt`.

## Why `katex` is a devDependency

It is **not** for typesetting anything. Nothing in this repo imports the
library — every reference is
`require.resolve('katex/package.json')` used to locate `dist/fonts/*.ttf`,
and 25 test files load four of those faces as the suite's deterministic
typeface: `KaTeX_Main-Regular` aliased as `sans-serif` in almost all of them,
plus Bold, Italic and `KaTeX_Typewriter-Regular` in a handful.

It resolved through ntk's dependency tree until ntk dropped its document
widgets, which is when it became a direct devDependency here rather than a
new requirement.

Three things rule out the obvious alternatives, so they do not have to be
rediscovered:

- **Not the font above.** It is subset to the glyphs the variation tests set
  — 76 glyphs, most of ASCII absent — and it is _variable_, where the tests
  that load Bold and Italic exist to prove ntk resolves a separate **file**
  per static weight and style.
- **Not system fonts.** The suite pins the colour scheme so that a pixel
  assertion means the same thing on every machine (see AGENTS.md); a face
  that varies by machine gives up the same guarantee for every metric.
- **Vendoring the four files** here would work — same bytes, no assertion
  moves, ~166 KB — and is the standing alternative if the 4.3 MB of
  dev-only dependency ever starts to matter. It does not today.

## `xkb-libxkbcommon-us-de.xkb`

A keymap as **libxkbcommon** serialises one, byte for byte — which is what
`test/wayland/xkb.test.js` needs and cannot get by hand, because the shape a
person writes from memory is `xkbcomp`'s and the two differ in exactly the
place the parser reads.

Generated with libxkbcommon 1.x from the stock rules, no local state:

```
xkbcli compile-keymap --rules evdev --model pc105 --layout us,de
```

(equivalently `xkb_keymap_new_from_names` + `xkb_keymap_get_as_string`, which
is the call a compositor makes before handing the text to the client over
`wl_keyboard.keymap`; that is how this file was produced, `xkbcli` not being
installed everywhere).

`us,de` rather than a single layout because the interesting spellings only
appear when something forces them:

- **two groups** put every printable key in the `symbols[1]= [ … ],
symbols[2]= [ … ]` form — a single-layout keymap writes those keys bare,
  which is why a one-layout dev machine never saw the bug;
- **German** brings a per-group `type[2]= "FOUR_LEVEL_PLUS_LOCK"` and an
  AltGr level;
- the **function keys** carry an explicit `type= "CTRL+ALT"`, which
  subscripts them even in a single-group keymap;
- `<ESC>`, `<RTRN>` and the rest still use the bare one-line form, so the
  file covers both spellings at once.

Keysyms in it are hex (`0x6c`), group names are `name[1]=`, and the keycode
range runs to 708 — all of it what a compositor actually sends, none of it
what the hand-written fixture in the test file says.
