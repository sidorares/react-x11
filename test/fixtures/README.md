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
