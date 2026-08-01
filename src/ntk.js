// `react-x11/ntk` — the toolkit underneath, re-exported.
//
// A package that adds an element draws with ntk's 2d context, may need a
// `Path2D`, an `Image`, a `Pixmap` or a `FontSource`, and an application
// embedding react-x11 may want `createClient` to build the connection it
// then passes as `createRoot({ app })`. Reaching those through here rather
// than declaring a second `ntk` dependency is what keeps one copy in the
// process: two copies mean two Yoga instances and two font caches, and a
// node built against one cannot be painted by the other.
export * from 'ntk';
export { default } from 'ntk';
