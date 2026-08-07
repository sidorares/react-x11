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
