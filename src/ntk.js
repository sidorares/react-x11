// `react-x11/ntk` — the toolkit underneath, re-exported.
//
// A package that adds an element draws with ntk's 2d context, may need a
// `Path2D`, an `Image`, a `Pixmap` or a `FontSource`, and an application
// embedding react-x11 may want `createClient` to build the connection it
// then passes as `createRoot({ app })`. Reaching those through here rather
// than declaring a second `ntk` dependency is what keeps one copy in the
// process: two copies mean two font caches and two glyph atlases, and a
// node built against one cannot be painted by the other.
//
// The layout engine is **not** here. It used to be — ntk owned Yoga while
// its own document widgets laid out with flexbox — but the renderer is the
// only layout consumer now and owns it directly (`src/yoga.js`). Nothing
// outside needs it either: an element's `measureContent` is handed its
// constraints in words (`'at-most'`, `'exactly'`), precisely so that yoga's
// ABI does not become part of the extension seam.
export * from 'ntk';
export { default } from 'ntk';
