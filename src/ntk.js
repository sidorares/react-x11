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
//
// Documents are not here either, and never were ntk's to give: ntk 8 removed
// `MarkdownView`, `HtmlView` and `layoutTex` along with the layout engine, so
// `export *` no longer carries them. A package that was reaching through here
// for one — they were reachable but never declared — wants
// `@react-x11/components` (`<Markdown>`, `<Formula>`). `SvgView` is still
// here; a drawing is not a document.
//
// One name is not a plain re-export. `Surface` below asks the app it is
// handed for the implementation, because ntk's own is a pixmap and a
// Picture — an X connection's — and a component allocates its buffer
// without knowing which backend it was mounted on. This subpath is where a
// drawing-adjacent name gets its backend-neutral answer; the X-only names
// (`createClient`, `Pixmap`, `Picture`, `XEmbedSocket`) stay X-only.
import { Surface as NtkSurface } from 'ntk';

export * from 'ntk';
export { default } from 'ntk';

/**
 * ntk's offscreen `Surface`, on whichever backend `app` is.
 *
 * An app that makes its own surfaces answers `createSurface(options)` —
 * the Cocoa app does, over a CG bitmap (src/cocoa/surface.js) — and an ntk
 * connection has no such method and gets ntk's pixmap. The result is
 * whichever implementation answered, not an instance of this class: the
 * contract is the shape — `width`/`height`, `getContext('2d')`, `render`,
 * `clear`, `copyWithin`, `destroy`, and `ctx.drawImage(surface, …)` —
 * (docs/extending.md "Scrolling the pixels, not just the offset"), and
 * nothing needs `instanceof`.
 */
export class Surface {
  constructor(app, options) {
    if (typeof app?.createSurface === 'function') {
      return app.createSurface(options);
    }
    return new NtkSurface(app, options);
  }
}
