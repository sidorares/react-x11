// Opening a font file, from the application's side of the seam.
//
// An app that wants to *look at* a font — a picker, a specimen, a
// preferences page that shows a family name — or to *ship* one had to leave
// react-x11 to do either (issue #346). The reading half was ntk's own class,
// `Font.loadSync(path)`, reached through an import an application author has
// no reason to know exists; the drawing half was a second, unrelated call,
// `app.fonts.load(path, { family: 'a-name-i-made-up' })`, and the made-up
// name then had to be kept consistent between the two by hand. Two calls,
// two mental models, and a string with no author.
//
// The two verbs here are the two things that were being confused:
//
//   openFont(app, source)   read the file. Nothing about the app changes.
//   loadFont(app, source)   read it *and* make it drawable, under a family
//                           name taken off the file and handed back.
//
// **Why opening does not register.** A registered face is not just an entry
// in a lookup table: ntk consults every registered font, in registration
// order, for *any codepoint the current face is missing* (`fallbackFor`), so
// an app that registered each file it merely previewed would quietly change
// which face draws the bullets and the curly quotes in its own UI. Reading a
// file and installing a font are different acts, so they are different
// calls, and the one whose name says "open" is the one that changes nothing.
//
// **Why both go through `app.fonts`.** The manager is the connection's one
// font cache, and a `Font` carries a glyph cache and a server-side glyphset
// with it: a second copy of a face is a second atlas uploaded over the wire,
// and a node built against one copy cannot be painted by the other. So
// neither verb parses a file the manager has already read — `loadFont` after
// `openFont` on the same path re-uses the open face rather than opening a
// second one, and a face fontconfig already matched is not re-read either.
//
// The same rule is why `react-x11/ntk` exists, for the code that does need
// `Font` itself: import ntk through react-x11, never as a dependency of its
// own (docs/styling.md#a-font-file-of-your-own).

import { basename, extname } from 'node:path';

import { Font } from 'ntk';

/**
 * Per-app bookkeeping. Keyed on the app rather than stored on it, like
 * `inputtime.js`: one process can drive several roots on several
 * connections, and a family registered on one is not registered on another.
 *
 * `opened` maps a source key to the handle for it, which is what makes both
 * verbs idempotent — a component that calls `useFont` on every render
 * re-reads nothing and registers nothing twice. `claims` is the family
 * namespace: `family|weight|italic` -> the key of the file that holds it.
 */
const state = new WeakMap();

function stateFor(app) {
  let s = state.get(app);
  if (!s) {
    s = { opened: new Map(), dataKeys: new WeakMap(), claims: new Map(), n: 0 };
    state.set(app, s);
  }
  return s;
}

function managerOf(app, fn) {
  const fonts = app?.fonts;
  if (!fonts) {
    throw new Error(
      `react-x11: ${fn}(app, …) needs the ntk connection — the app from ` +
        '`createRoot({ app })` or `useApp()`, which is what carries `app.fonts`',
    );
  }
  return fonts;
}

/**
 * The cache key for a source.
 *
 * A path's key is the one ntk computes for itself
 * (`` `${path}#${postscriptName}` ``, its font.js) rather than one of ours,
 * which is what makes `loadFont`'s `app.fonts.load()` land on the face
 * `openFont` already opened instead of parsing the file a second time.
 *
 * Bytes have no name to key on, so they are keyed by the identity of the
 * buffer they arrived in — the same array is the same font, a copy of it is
 * not, which is the only answer available without hashing megabytes.
 */
function keyFor(st, source, postscriptName) {
  if (typeof source === 'string') return `${source}#${postscriptName || ''}`;
  let key = st.dataKeys.get(source);
  if (!key) {
    key = `data:${st.n++}#${postscriptName || ''}`;
    st.dataKeys.set(source, key);
  }
  return key;
}

/**
 * ntk's cache, reached through the method that owns it.
 *
 * `_open` is underscored because ntk has no public "open without
 * registering" — this module *is* that route from an application, which is
 * the whole of issue #346. If a future ntk renames it, parsing directly is
 * the honest fallback: a duplicated face costs memory and an extra glyph
 * atlas, where throwing would cost the feature entirely.
 */
function openThrough(fonts, candidate) {
  if (typeof fonts._open === 'function') return fonts._open(candidate);
  return candidate.path !== undefined
    ? Font.loadSync(candidate.path, candidate.postscriptName)
    : Font.fromData(candidate.data, candidate);
}

/** `/usr/share/fonts/Inter-Variable.ttf` -> `Inter-Variable`. */
function stemOf(source) {
  if (typeof source !== 'string') return '';
  return basename(source, extname(source));
}

/**
 * Where in a family this face sits — `weight|italic`, the two things ntk
 * resolves a family's faces by.
 *
 * This mirrors ntk's own `detectStyle`, which is not exported. Mirroring is
 * safe here in a way it would not be on the paint path: the answer only
 * decides what a file is *named*, so drifting from ntk costs a scoped alias
 * where none was needed, never a wrong glyph.
 */
function faceOf(font, opts) {
  const os2 = font.fk?.['OS/2'];
  const weight = opts.weight ?? (os2 ? os2.usWeightClass : 400);
  const italic =
    opts.style !== undefined
      ? /italic|oblique/i.test(opts.style)
      : !!(
          os2?.fsSelection?.italic ||
          font.fk?.italicAngle ||
          /italic|oblique/i.test(font.fk?.subfamilyName || '')
        );
  return `${weight}|${italic}`;
}

/**
 * The family name a loaded file is registered under, when the caller did not
 * name one.
 *
 * **The font's own name**, which is the decision worth stating: an app that
 * ships `Inter.ttf` wants `fontFamily: 'Inter'` to mean *its* Inter, in
 * every style it has already written, and registered faces beat fontconfig
 * in `match()` — this is `@font-face` behaving the way the web taught
 * everyone it behaves.
 *
 * **Scoped only when the face would be unreachable**, which is the other
 * half. A family is a set of faces, so `Inter-Regular.ttf` and
 * `Inter-Bold.ttf` both want to be "Inter" and `fontWeight` picks between
 * them — that is a family being assembled, not a collision. Two *different*
 * files claiming the same family at the same weight and slant are a
 * collision, because ntk resolves that tie to whichever was registered first
 * and the second file would never draw: it gets `Ubuntu 2`. Nobody has to
 * know that happened — the family to draw with is the one `loadFont` hands
 * back, and a caller that always uses it is always right.
 *
 * A name the `family` option asked for is used verbatim: two faces under one
 * alias is a thing a caller may well mean, and second-guessing a name
 * somebody chose is worse than the tie. It still claims its slot, so a later
 * auto-derived name never lands on top of it.
 */
function claim(st, key, base, face, verbatim) {
  const slot = (name) => `${name.toLowerCase()}|${face}`;
  const held = (name) => st.claims.get(slot(name));
  if (verbatim || !held(base) || held(base) === key) {
    st.claims.set(slot(base), key);
    return base;
  }
  for (let n = 2; ; n++) {
    const alias = `${base} ${n}`;
    if (!held(alias) || held(alias) === key) {
      st.claims.set(slot(alias), key);
      return alias;
    }
  }
}

/**
 * Read a font file: metrics, coverage, variation axes.
 *
 * ```js
 * const font = openFont(app, '/usr/share/fonts/truetype/inter/Inter.ttf');
 * font.familyName; // 'Inter'
 * font.metrics(30); // { ascent, descent, lineGap, capHeight, … }
 * font.variationAxes; // { wght: { name, min, default, max } }
 * font.hasGlyph(0x20b8); // is the tenge sign in this face?
 * ```
 *
 * `source` is a path to a `.ttf`/`.otf`/`.ttc`/`.woff`/`.woff2`, or the
 * file's bytes. `postscriptName` picks one face out of a `.ttc` collection
 * (the first otherwise).
 *
 * **Nothing about the app changes.** The face is not registered, so it is
 * not a candidate for any `fontFamily` — and, the part that is easy to miss,
 * it does not join the fallback chain either, which is what stops a font
 * browser from changing the glyphs its own UI falls back to. {@link loadFont}
 * is the call for when the point is to draw with it.
 *
 * The file is read once per app: the face is cached in the connection's font
 * manager, so opening it again — every render, every repaint — hands back
 * the same `Font`, and so does {@link loadFont} afterwards.
 *
 * Throws what ntk throws for a file that is missing or unparseable. When the
 * path came from a user (a file dialog), that is a `try`/`catch` around this
 * call rather than an error boundary.
 *
 * @param {object} app the ntk connection (`useApp()`)
 * @param {string|Uint8Array|Buffer} source path, or the font file's bytes
 * @param {{ postscriptName?: string }} [opts]
 * @returns {object} ntk's `Font`
 */
export function openFont(app, source, opts = {}) {
  const fonts = managerOf(app, 'openFont');
  const st = stateFor(app);
  const key = keyFor(st, source, opts.postscriptName);
  const known = st.opened.get(key);
  if (known) return known.font;
  const font = openThrough(fonts, {
    key,
    postscriptName: opts.postscriptName,
    ...(typeof source === 'string' ? { path: source } : { data: source }),
  });
  st.opened.set(key, { font, family: null });
  return font;
}

/**
 * Read a font file **and** register it, so `fontFamily` can name it.
 *
 * ```jsx
 * const { font, family } = loadFont(app, '/path/to/Inter.ttf');
 * <text style={{ fontFamily: family, fontSize: 20 }}>Handgloves</text>;
 * ```
 *
 * `family` is read off the file rather than invented by the caller: the
 * font's own name, so an app that ships `Inter.ttf` can go on writing
 * `fontFamily: 'Inter'` in the styles it already has. Several faces of one
 * family — regular, bold, italic — all keep that name and `fontWeight` picks
 * between them. Only a second file that would be *unreachable* under it,
 * same family at the same weight and slant, is scoped: it comes back as
 * `Inter 2`. Draw with the name that comes back and the question never
 * arises.
 *
 * A registered face wins over fontconfig for its name, which is the point:
 * an app that ships a font means the one it ships. Pass `family` to name it
 * something else — `loadFont(app, picked, { family: 'preview' })` keeps a
 * file the user chose out of the way of the app's own type. `weight` and
 * `style` override what the file says about itself; `postscriptName` picks a
 * face out of a `.ttc`.
 *
 * Registering also puts the face in the fallback chain, ahead of the system
 * fonts: text in some other family that has no glyph for a character borrows
 * it from here before fontconfig is asked. That is what an app shipping a
 * symbol or icon face wants, and {@link openFont} is the call for when it is
 * not.
 *
 * Idempotent per app and file: calling it again returns the same handle and
 * registers nothing twice.
 *
 * @param {object} app the ntk connection (`useApp()`)
 * @param {string|Uint8Array|Buffer} source path, or the font file's bytes
 * @param {{ family?: string, weight?: number|string, style?: string,
 *   postscriptName?: string }} [opts]
 * @returns {{ font: object, family: string }} ntk's `Font`, and the family
 *   name to draw it with
 */
export function loadFont(app, source, opts = {}) {
  const fonts = managerOf(app, 'loadFont');
  const st = stateFor(app);
  const key = keyFor(st, source, opts.postscriptName);
  const known = st.opened.get(key);
  if (known?.family && (!opts.family || opts.family === known.family)) {
    return known;
  }

  // Opened first, because the name to register under is read off the face —
  // and this is the read that does not happen twice: for a path, `load()`
  // below computes the same cache key and gets this very font back.
  const font = openFont(app, source, opts);
  const family = claim(
    st,
    key,
    opts.family || font.familyName || stemOf(source) || 'font',
    faceOf(font, opts),
    !!opts.family,
  );

  const registered = fonts.load(source, { ...opts, family });
  // Bytes are the one source `load` cannot look up: the key it makes for
  // them counts entries rather than naming the data, so it parses the buffer
  // again and the face above is not the one that got registered. Keep the
  // registered face — it is the one that will be drawn with, and so the one
  // whose glyph cache is worth sharing — and let the other go.
  const handle = { font: registered ?? font, family };
  st.opened.set(key, handle);
  return handle;
}
