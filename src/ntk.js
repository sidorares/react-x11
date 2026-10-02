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
// One name is not a plain re-export. `Surface` (src/offscreen.js) asks the app it is
// handed for the implementation, because ntk's own is a pixmap and a
// Picture — an X connection's — and a component allocates its buffer
// without knowing which backend it was mounted on. This subpath is where a
// drawing-adjacent name gets its backend-neutral answer; the X-only names
// (`createClient`, `Pixmap`, `Picture`, `XEmbedSocket`) stay X-only.
//
// One name is not ntk's at all. `decodeImageBytes` (src/imagedecode.js) is
// the decoder ladder behind `<image>`'s bytes and files — the runtime's own
// decoder where there is one, WebP where ntk reads only PNG and JPEG — and
// an element that draws images of its own (`<Html>`'s `<img>`, a CSS
// background) decodes through it so that an image shows there exactly when
// it would show in an `<image>`. It is a name of its own rather than ntk's
// `decodeImage` answered differently, because that one is synchronous and a
// caller may read the size off what it returns; this one answers a promise
// wherever the decode is not.
import * as ntk from 'ntk';

import { adoptNtk } from './ntkroot.js';

export * from 'ntk';
export { default } from 'ntk';
export { Surface } from './offscreen.js';
export { decodeImageBytes } from './imagedecode.js';

// what src/ntkroot.js would load, already loaded: handed over rather than
// imported twice
adoptNtk(ntk);
