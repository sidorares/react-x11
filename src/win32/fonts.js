// The Windows text engine: DirectWrite behind the same `app.fonts` contract
// ntk's FontManager answers on X11 and CoreText answers on macOS. The renderer
// touches exactly this surface (docs/windows.md §"Text"):
//
//   fonts.layout(spans, base, { maxWidth, align, lineHeight, maxLines,
//                               overflow, direction })
//     -> { width, height, lines, draw(ctx, x, y),
//          indexAt(x, y), caretPosition(cp) }
//   fonts.match(family, { weight, style }) -> face
//   fonts.fallbackFor(codepoint, family, { weight, style }) -> face | null
//
// Index spaces, because two meet here, exactly as they do in the Cocoa engine:
// `lines[].start/end` are UTF-16 code units — what `rangeBands` in
// nodes/text.js compares against — while `caretPosition()` takes and
// `indexAt()` returns code points, which is what the selection and the caret
// speak. DirectWrite is UTF-16 end to end, like CoreText, so the conversion
// happens at this boundary and nowhere else.
import { cssColorStraight } from 'ntk/color';

// REACT_X11_WIN32_DEBUG=1 reports the size each paragraph is shaped at, which
// is how to tell a scale that never reached the text engine from one that did.
const DEBUG = process.env.REACT_X11_WIN32_DEBUG === '1';

// A span's vocabulary is **ntk's TextLayout's, not CSS's**: `family`, `size`,
// `weight`, `style` — not `fontFamily`, `fontSize` and the rest. That is what
// `collectSpans` and `resolvedTextStyle` in nodes/text.js produce, and what
// the CoreText engine reads.
//
// Getting it wrong is silent and looks like something else entirely: every
// paragraph falls through to this default, so the whole app renders at one
// size whatever it asked for, and on a 150% display it reads as "the scale
// never reached the text engine" when the scale was never the problem. 14 is
// the same floor the Cocoa engine uses.
const DEFAULT_SIZE = 14;

// The size a coverage question is asked at. A cmap does not depend on one, so
// every `hasGlyph`/`glyphIdFor` shares a single handle per face rather than
// resolving one per size the caller happens to be drawing at.
const PROBE_SIZE = 16;

/** The CSS generics, which name no face on their own. */
const GENERIC_FAMILIES = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'system-ui',
  'ui-sans-serif',
  'ui-monospace',
]);
function sizeOf(value) {
  return typeof value === 'number' && value > 0 ? value : DEFAULT_SIZE;
}

// DirectWrite takes a numeric weight; CSS lets a style say the word.
function weightOf(value) {
  if (typeof value === 'number') return value;
  if (value === 'bold') return 700;
  if (value === 'bolder') return 800;
  if (value === 'lighter') return 300;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 400;
}

// A font stack resolves to the first family this machine actually has, which
// is the job fontconfig does on X11 and the system collection does here. The
// generic names are left for the bridge, which knows what Segoe UI is.
const GENERIC = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'system-ui',
  'cursive',
]);
//
// Two more ways a name reaches a face, both what Chrome does on Windows:
//
// - **A face of a family filed under another name.** DirectWrite groups
//   faces by weight, width and slope, so "Arial Black", "Segoe UI Light" and
//   "Franklin Gothic Medium" are faces of "Arial", "Segoe UI" and "Franklin
//   Gothic", and no family by those names exists. The bridge looks such a
//   name up as GDI does (`fontFamilyOf`) and answers the family and the
//   face's weight, width and slope, which then stand in for the request's
//   weight and width, as Blink has them (`font_cache_skia_win.cc`, the weight
//   and width suffixes): `font-weight: bold` on "Arial Black" is still Arial
//   Black. A slope is kept from either.
// - **Blink's alternate names** (`AlternateFamilyName`, font_cache.cc):
//   Courier and Courier New, Times and Times New Roman, Arial and Helvetica,
//   each tried for the other where it is missing. Windows has a Courier only
//   as a bitmap font DirectWrite does not read, and no Times or Helvetica,
//   and these three head a good many stacks on the web.
const ALTERNATES = new Map([
  ['courier', 'Courier New'],
  ['courier new', 'Courier'],
  ['times', 'Times New Roman'],
  ['times new roman', 'Times'],
  ['arial', 'Helvetica'],
  ['helvetica', 'Arial'],
]);

/**
 * A stack resolved: `{ family, face }`, the family the bridge is asked for
 * and, where the name reached a face of a family by another name, `face`:
 * its `weight`, `stretch` and `italic`. `face` is null otherwise.
 */
function resolveStack(native, stack) {
  if (!stack) return { family: 'sans-serif', face: null };
  for (const raw of String(stack).split(',')) {
    const name = raw.trim().replace(/^["']|["']$/g, '');
    if (!name) continue;
    if (GENERIC.has(name)) return { family: name, face: null };
    if (native.fontExists(name)) return { family: name, face: null };
    const face = native.fontFamilyOf?.(name);
    if (face?.family) {
      return {
        family: face.family,
        face: {
          weight: weightOf(face.weight),
          stretch: face.stretch,
          italic: face.italic === true,
        },
      };
    }
    const alternate = ALTERNATES.get(name.toLowerCase());
    if (alternate && native.fontExists(alternate)) {
      return { family: alternate, face: null };
    }
  }
  return { family: 'sans-serif', face: null };
}

/** What a span or a base asks for, with its stack resolved: the family,
 *  weight, width and slope the bridge is handed. */
function requestOf(resolved, weight, style) {
  const italic = style === 'italic' || style === 'oblique';
  const { family, face } = resolved;
  if (!face) {
    return { family, weight: weightOf(weight ?? 400), stretch: 5, italic };
  }
  return {
    family,
    weight: face.weight,
    stretch: face.stretch,
    italic: italic || face.italic,
  };
}

function colorOf(value) {
  if (!value) return null;
  try {
    const [r, g, b, a] = cssColorStraight(value);
    return { r, g, b, a };
  } catch {
    return null;
  }
}

/**
 * A span's letter spacing and OpenType features, as the bridge takes them:
 * `letterSpacing` in pixels after each character, `features` by tag. Letter
 * spacing turns the optional ligatures off, as ntk and the Cocoa engine have
 * it, so the three agree on what a spaced word is made of. Left out, a
 * `letter-spacing` was set tight on Windows, and <Html>, which justifies a
 * line through letter spacing where an engine cannot, laid a justified
 * line's words over each other.
 */
const OPTIONAL_LIGATURES_OFF = Object.freeze({
  liga: 0,
  clig: 0,
  dlig: 0,
  hlig: 0,
});
function spacingOf(span, base) {
  const raw = span.letterSpacing ?? base.letterSpacing;
  const spacing = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  const own = span.features ?? base.features;
  const features = spacing
    ? own
      ? { ...OPTIONAL_LIGATURES_OFF, ...own }
      : OPTIONAL_LIGATURES_OFF
    : own;
  return {
    ...(spacing ? { letterSpacing: spacing } : {}),
    ...(features && typeof features === 'object' ? { features } : {}),
  };
}

/** What an eliding paragraph ends in. */
const ELLIPSIS = '…';

/**
 * The spans' text over `[from, to)` in code units, each span cut where the
 * range cuts it and a span the range takes whole kept as the caller's own
 * object; `mark` goes on the end of the last, in its style.
 */
function spansBetween(spans, from, to, mark = '') {
  const out = [];
  let at = 0;
  for (const span of spans) {
    const text = String(span.text);
    const start = at;
    at += text.length;
    if (at <= from) continue;
    if (start >= to) break;
    const piece = text.slice(Math.max(0, from - start), to - start);
    if (piece) out.push(piece === text ? span : { ...span, text: piece });
  }
  if (mark) {
    if (out.length) {
      const last = out[out.length - 1];
      out[out.length - 1] = { ...last, text: String(last.text) + mark };
    } else if (spans.length) {
      out.push({ ...spans[0], text: mark });
    }
  }
  return out;
}

/**
 * A line's width without the white space it ends on, from where the layout
 * puts the caret before that white space. Left to right only: on a line a
 * right-to-left run is on, where the space goes is the bidi algorithm's,
 * and the line keeps the bridge's width.
 */
function inkWidth(native, handle, text, line) {
  const end = trimmedEnd(text, line.start, line.end);
  if (end === line.end) return line.width;
  if (end === line.start) return 0;
  if ((line.runs ?? []).some((run) => run.rtl)) return line.width;
  const caret = native.layoutCaret(handle, end);
  if (!caret || !Number.isFinite(caret.x)) return line.width;
  return Math.max(0, Math.min(line.width, caret.x - line.x));
}

/** The spans up to code unit `to`, with `mark` after them. */
function spansTo(spans, to, mark = '') {
  return spansBetween(spans, 0, to, mark);
}

/** The white space a line may end on and leaves out of its width: the
 *  spaces a line breaks at, and the line separator <Html> asks for a break
 *  with — not a no-break space, which is part of the line as a letter is. */
const BREAKING_SPACE =
  /[\t\n\v\f\r \u1680\u2000-\u200a\u2028\u2029\u205f\u3000]/;

/** `end` moved back over the white space before it, not past `start`. */
function trimmedEnd(text, start, end) {
  let at = end;
  while (at > start && BREAKING_SPACE.test(text[at - 1])) at--;
  return at;
}

/** A code-unit offset not inside a surrogate pair: `at`, or one before. */
function pointAtOrBefore(text, at) {
  const unit = text.charCodeAt(at - 1);
  return unit >= 0xd800 && unit <= 0xdbff ? at - 1 : at;
}

/** The code-unit offset one code point before `at`. */
function previousPoint(text, at) {
  return Math.max(0, pointAtOrBefore(text, at - 1));
}

/** Code-unit offset of each code point, so the two index spaces can be
 * converted without walking the string twice per query. */
function codeUnitOffsets(text) {
  const offsets = [];
  for (let i = 0; i < text.length;) {
    offsets.push(i);
    i += text.codePointAt(i) > 0xffff ? 2 : 1;
  }
  offsets.push(text.length);
  return offsets;
}

class Win32TextLayout {
  constructor(manager, handle, text, metrics) {
    this._manager = manager;
    this._native = manager._native;
    // BackendContext2D reads this when it draws a layout, which is what makes
    // the name part of the bridge contract rather than ours.
    this._handle = handle;
    this._text = text;
    this._metrics = metrics;
    this._offsets = null;
    // Tells BackendContext2D that the ink comes from the context's own fill
    // rather than from inside the layout — so a <text> whose colour is a
    // gradient reaches drawLayoutGradient.
    this._contextInk = true;
    // ntk's: whether a `maxLines` cap dropped any of the text
    this.truncated = false;
  }

  /**
   * Hang each run off the span it was laid out from, as ntk's runs hang:
   * `span` is the caller's own object, markers and all — what a painter
   * reads a link's underline or a code chip's background off — and `run`
   * the face and size it was set in, and its direction. The bridge makes a
   * run of each stretch of one direction, a link beside plain text in
   * one, so a run is cut where two spans meet, at the offset the layout
   * puts that index at. Without it a document drew no underline, chip or
   * highlight on Windows and could find no link under the pointer.
   *
   * `laid` is what was laid out — `sources` cut at a cap, an ellipsis on
   * the last — span for span, so the offsets are its and the objects the
   * caller's.
   */
  _hangRuns(sources, laid, runOf) {
    const starts = [];
    let at = 0;
    for (const span of laid) {
      starts.push(at);
      at += String(span.text).length;
    }
    for (const line of this.lines) {
      const runs = [];
      for (const r of line.runs) {
        this._cutRun(
          r,
          line,
          starts,
          (i, rtl) => {
            const span = sources[i];
            return { span, run: runOf(span, rtl) };
          },
          runs,
        );
      }
      line.runs = runs;
    }
  }

  _cutRun(r, line, starts, hangOf, out) {
    if (!starts.length) {
      out.push(r);
      return;
    }
    // the span holding the run's first unit
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= r.start) lo = mid;
      else hi = mid - 1;
    }
    const hang = (run, source) => {
      const { span, run: set } = hangOf(source, run.rtl);
      run.span = span;
      run.run = set;
      return run;
    };
    let next = lo + 1;
    if (next >= starts.length || starts[next] >= r.end) {
      out.push(hang(r, lo));
      return;
    }
    // where each span that starts inside the run begins, from the line's
    // origin, as the run's own `x` is measured
    const edges = [r.start];
    const at = [r.rtl ? r.x + r.width : r.x];
    const sources = [lo];
    for (; next < starts.length && starts[next] < r.end; next += 1) {
      edges.push(starts[next]);
      const caret = this._native.layoutCaret(this._handle, starts[next]);
      at.push((caret?.x ?? 0) - line.x);
      sources.push(next);
    }
    edges.push(r.end);
    at.push(r.rtl ? r.x : r.x + r.width);
    const pieces = [];
    for (let i = 0; i < sources.length; i += 1) {
      const a = at[i];
      const b = at[i + 1];
      pieces.push(
        hang(
          {
            ...r,
            start: edges[i],
            end: edges[i + 1],
            x: Math.min(a, b),
            width: Math.abs(b - a),
          },
          sources[i],
        ),
      );
    }
    // a line's runs go left to right, and a right-to-left run's first span
    // is its rightmost piece
    if (r.rtl) pieces.reverse();
    out.push(...pieces);
  }

  get width() {
    return this._metrics.width;
  }

  get height() {
    return this._metrics.height;
  }

  get lines() {
    return this._metrics.lines;
  }

  /** The min-content width, which yoga's floors pass asks for with a width
   * offer of zero. DirectWrite answers it natively (`DetermineMinWidth`),
   * where CoreText cannot and the Cocoa engine breaks at `linebreak`'s
   * opportunities itself. */
  get minWidth() {
    return this._metrics.minWidth;
  }

  draw(ctx, x, y) {
    ctx._drawLayout(this, x, y);
  }

  indexAt(x, y) {
    const unit = this._native.layoutIndexAt(this._handle, x, y);
    return this._cpOf(unit);
  }

  caretPosition(cp) {
    return this._native.layoutCaret(this._handle, this._cuOf(cp));
  }

  /**
   * How much of each device pixel the glyphs cover, one byte a pixel,
   * without drawing them anywhere (#673) — for text that is drawn where a 2D
   * context is not, a GL surface's labels. The raster is the layout's box in
   * whole pixels with `pad` round it, the layout's origin at (pad, pad).
   *
   * DirectWrite's own glyph-run analysis rather than a surface read back:
   * grayscale, grid fit off, and none of the gamma or enhanced contrast
   * Direct2D gives text it blends — the outlines' coverage, which is what a
   * distance field is made from. Null on a bridge that predates it
   * (`@windowkit/win32` before `layoutCoverage`), so a caller keeps its
   * readback.
   */
  coverage({ pad = 0 } = {}) {
    if (this._handle == null) return null;
    if (typeof this._native.layoutCoverage !== 'function') return null;
    return this._native.layoutCoverage(this._handle, pad) ?? null;
  }

  _cuOf(cp) {
    this._offsets ??= codeUnitOffsets(this._text);
    const at = Math.max(0, Math.min(this._offsets.length - 1, cp));
    return this._offsets[at];
  }

  _cpOf(unit) {
    this._offsets ??= codeUnitOffsets(this._text);
    // The last offset not past `unit` — a binary search would be the same
    // answer, and paragraphs here are short enough that it would not pay.
    let cp = 0;
    while (cp + 1 < this._offsets.length && this._offsets[cp + 1] <= unit) cp++;
    return cp;
  }

  destroy() {
    if (this._handle == null) return;
    this._native.layoutRelease(this._handle);
    this._handle = null;
  }
}

/** A face, as far as a renderer that positions glyphs itself reads one.
 * Size is deferred the way ntk's is. */
class Win32Face {
  constructor(
    manager,
    family,
    { weight = 400, style = 'normal', stretch = 5 } = {},
  ) {
    this._manager = manager;
    this.family = family;
    this.weight = weightOf(weight);
    this.style = style;
    this.italic = style === 'italic' || style === 'oblique';
    // DirectWrite's width, 1–9 with 5 normal: a face such as Arial Narrow is
    // reached through it (`resolveStack`)
    this.stretch = stretch;
  }

  /**
   * Kept per size: a face's metrics never change, and the bridge answers
   * each call by resolving the family through DirectWrite again. A trimmed
   * `<text>` asks on every placement of its layout (`_trim`), which on a
   * graph of widget cards was every body on every step of a drag.
   */
  metrics(size) {
    this._metrics ??= new Map();
    let m = this._metrics.get(size);
    if (m === undefined) {
      m = this._manager._native.fontMetrics(
        this.family,
        size,
        this.weight,
        this.italic,
        this.stretch,
      );
      // ntk's `lineHeight` beside DirectWrite's names, as the Cocoa engine
      // gives CoreText's, so a caller written against ntk reads a finite
      // line height: <Html>'s `line-height: normal` read `NaN` here, and a
      // `NaN` in a block's height culled the whole document from the paint.
      if (m && typeof m === 'object' && !Number.isFinite(m.lineHeight)) {
        m = { ...m, lineHeight: m.ascent + m.descent + (m.lineGap || 0) };
      }
      this._metrics.set(size, m);
    }
    return m;
  }

  /**
   * The bridge's handle for this face at a pixel size — a resolved
   * IDWriteFontFace and the em size to draw it at, which is the pair
   * DirectWrite's DrawGlyphRun takes and the pair CoreText folds into one
   * CTFont. Cached on the manager, so the same face at the same size is one
   * object across a frame and `drawGlyphs` can batch by it.
   */
  _handle(size) {
    return this._manager._handleFor(this, size);
  }

  /**
   * Coverage. A code point (ntk's contract) or a string — the two forms
   * `hasGlyph` has been asked in.
   */
  hasGlyph(codepoint) {
    if (typeof codepoint === 'number')
      return this.glyphIdFor(codepoint) !== null;
    const handle = this._handle(PROBE_SIZE);
    if (!handle) return false;
    return this._manager._native.fontHasGlyph(handle, String(codepoint));
  }

  /**
   * Glyph id for a code point, or `null` when this face does not map it —
   * the lookup twin of `hasGlyph` (ntk#254). A cmap lookup only: no shaping,
   * so text that needs ligatures or marks goes through the layout path, and
   * `hasGlyphRuns` on the renderer's side is the gate that decides.
   *
   * The size does not matter to a cmap, so this asks at one fixed size and
   * the answers are shared rather than looked up per size.
   */
  glyphIdFor(codepoint) {
    if (typeof codepoint !== 'number') return null;
    const handle = this._handle(PROBE_SIZE);
    if (!handle) return null;
    return this._manager._native.fontGlyphForCodepoint(handle, codepoint);
  }

  /** Nominal (unshaped) horizontal advance of a glyph id, in pixels at
   *  `size`. */
  advanceOf(glyphId, size) {
    const handle = this._handle(size);
    if (!handle) return 0;
    const advances = this._manager._native.fontGlyphAdvances(handle, [glyphId]);
    return advances?.[0] ?? 0;
  }
}

export class Win32FontManager {
  constructor(native) {
    this._native = native;
    this._faces = new Map();
    // family|weight|italic|size -> the bridge's handle, or null when there is
    // no such face
    this._handles = new Map();
  }

  /**
   * A face at a size, as the bridge's handle. Cached on the four things that
   * pick it, because a terminal asks for the same handful of faces on every
   * frame — and because `BackendContext2D.drawGlyphs` groups a frame's glyphs
   * by handle identity, so two asks for the same face must answer the same
   * number or a line of text goes out as one call per glyph.
   */
  _handleFor(face, size) {
    const px = Math.max(1, Math.round((size ?? 0) * 64)) / 64;
    const stretch = face.stretch ?? 5;
    const key = `${face.family}|${face.weight}|${face.italic ? 1 : 0}|${stretch}|${px}`;
    let handle = this._handles.get(key);
    if (handle === undefined) {
      handle =
        this._native.fontHandle(
          face.family,
          px,
          face.weight,
          face.italic,
          stretch,
        ) || null;
      this._handles.set(key, handle);
    }
    return handle;
  }

  /**
   * The handle a glyph run draws with (`BackendContext2D.drawGlyphs`): a face
   * this engine made, or one of ntk's `Font` objects, which carries the family
   * it was opened as — `loadFont()` registered the file with DirectWrite under
   * that name, so asking for it by name reaches the same face.
   */
  _runHandle(font, size) {
    if (font instanceof Win32Face) return font._handle(size);
    const family = font?.familyName ?? font?.family ?? font?.postscriptName;
    if (!family) return null;
    return this._handleFor(
      {
        family: String(family),
        weight: weightOf(font.weight ?? 400),
        italic: font.italic === true || font.style === 'italic',
      },
      size,
    );
  }

  /**
   * A font the app ships rather than one the system has — `loadFont()`'s
   * backend half. DirectWrite keeps app-supplied faces in a collection of
   * their own, and the bridge names that collection for exactly the families
   * that came from it, so afterwards the font is asked for by name like any
   * other.
   *
   * `null` on purpose: src/fonts.js keeps the fontkit face it already opened
   * as the handle — that is the one whose metrics an app can read — and what
   * draws is resolved by family name against the collection above.
   */
  load(source, opts = {}) {
    let data = source;
    if (typeof source === 'string') {
      // A path goes to DirectWrite as a path: it maps the file itself, and
      // the face outlives anything this process would have to hold.
      data = source;
    } else if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
      data = source;
    } else {
      throw new Error(
        'react-x11: loadFont — expected a file path or font bytes, got ' +
          typeof source,
      );
    }
    // The name to reach it by, which `loadFont` has already decided — the
    // file's own family, or one the caller asked for. A `postscriptName`
    // alongside it narrows the registration to that one face, which is what
    // naming a single face of a family (`Bahnschrift-Light`) means: without
    // it the name would reach every face in the file and the weight would be
    // whatever matching landed on.
    const loaded = this._native.fontLoad(data, {
      family: opts.family || undefined,
      postscriptName: opts.postscriptName || undefined,
    });
    if (!loaded) {
      throw new Error(
        'react-x11: loadFont — DirectWrite could not read the font' +
          (typeof source === 'string' ? ` in ${source}` : ' data') +
          '. It reads .ttf, .otf and .ttc; a .woff or .woff2 has to be ' +
          'unwrapped first.',
      );
    }
    // Faces matched before this one existed were matched against a smaller
    // set of fonts, and one of them may have fallen back to what this
    // replaces — a stack resolved past its name among them.
    this._faces.clear();
    this._handles.clear();
    this._stacks?.clear();
    return null;
  }

  /**
   * The catalogue seam ntk exposes as `fonts.source` — what the fonts app
   * browses. On X that is fontconfig; here it is DirectWrite's collections,
   * the app's own faces before the system's.
   *
   * Pattern syntax: the family, with fontconfig's `:modifiers` tolerated and
   * ignored (`Consolas:bold`, `:lang=ru` — the part after the colon is
   * fontconfig vocabulary DirectWrite does not speak). A query that is only
   * a modifier has no family in it and lists the catalogue instead, which is
   * what the app does with `:lang=ja` on a backend that cannot answer it.
   */
  get source() {
    return (this._source ??= {
      matchSortedAsync: async ({ family } = {}) => {
        const pattern = String(family ?? '').trim();
        let name = pattern.split(':')[0].trim();
        if (name && GENERIC_FAMILIES.has(name.toLowerCase())) {
          // Rendering resolves the generics itself (ResolveFamily in the
          // bridge); the catalogue wants a family it can actually enumerate,
          // and these are the faces that resolution lands on.
          name =
            {
              serif: 'Times New Roman',
              monospace: 'Consolas',
              'ui-monospace': 'Consolas',
              cursive: 'Segoe Script',
            }[name.toLowerCase()] ?? 'Segoe UI';
        }
        const rows = this._native.listFonts(
          name ? { family: name } : { limit: 400 },
        );
        return rows
          .filter((row) => row.path)
          .map((row) => ({
            path: row.path,
            postscriptName: row.postscriptName,
            family: row.family,
            style: row.style,
            // fontconfig's charset, which DirectWrite does not expose as a
            // string. Empty rather than wrong: the app shows it when it has
            // one and says nothing when it does not.
            charset: '',
          }));
      },
    });
  }

  /**
   * One IDWriteTextLayout over the joined string, with the spans as formatting
   * ranges. That is what makes a paragraph of mixed <text> chunks a single
   * layout rather than one per chunk — and therefore what makes line breaking
   * work *across* them, which is the whole reason the contract takes spans
   * rather than a string.
   *
   * The cap and the ellipsis are ntk's and are worked out here, since the
   * bridge has neither: the paragraph is broken at the width, the lines past
   * `maxLines` are dropped (`truncated` says whether any were), and an
   * eliding one ends its last line in `…`, as much of the line kept as fits
   * beside it. The bridge's own `maxLines` is never asked: it reads 1 as "do
   * not wrap", so a one-line `<text>` came back as the whole paragraph on
   * one line, as wide as all of it and with no ellipsis, and every paragraph
   * a caller laid out a line at a time through it overran its box.
   */
  layout(spans, base = {}, options = {}) {
    const list =
      typeof spans === 'string' ? [{ text: spans, ...base }] : (spans ?? []);
    // the caller's spans with text, which the runs hang off (`_hangRuns`)
    const sources = list.filter((span) => String(span?.text ?? ''));
    const { maxWidth, maxLines, overflow } = options;
    const cap = Number.isFinite(maxLines)
      ? Math.max(1, Math.floor(maxLines))
      : Infinity;
    const elides = overflow === 'ellipsis' && cap < Infinity;
    // A width offer of zero is yoga's min-content question (nodes/window/
    // floors.js), which the bridge answered with a layout built unbounded —
    // the whole paragraph on one line — so no `<text>` in a flex row could
    // give way below its full length. Its `minWidth` is DirectWrite's own
    // answer (`DetermineMinWidth`), and the paragraph laid out at it is the
    // floor. An eliding line's floor is the mark alone, as the Cocoa engine
    // has it (react-x11#512): it gives way, and says so with `…`.
    if (Number.isFinite(maxWidth) && maxWidth <= 0) {
      const open = { ...options, maxWidth: undefined };
      if (elides && cap === 1 && sources.length) {
        return this._laidOut([{ ...sources[0], text: ELLIPSIS }], base, open);
      }
      const wide = this._laidOut(sources, base, open);
      const least = wide.minWidth;
      if (!(least > 0) || least >= wide.width) return wide;
      wide.destroy();
      return this._laidOut(sources, base, { ...options, maxWidth: least });
    }
    let laid = sources;
    let layout = this._laidOut(laid, base, options);
    // With no width the bridge lays a paragraph out in a box a million
    // pixels wide, and aligns it there: a centred line's `x` was half a
    // million, an RTL one's a million, and <Html> measured a centred
    // heading in a shrink-to-fit box as wide as all the room it had. ntk
    // aligns the lines of an unbounded paragraph within its widest, and so
    // does a paragraph laid out again at that width.
    if (
      !(maxWidth > 0 && Number.isFinite(maxWidth)) &&
      layout.width > 0 &&
      layout.lines.some((line) => line.x > 0.5)
    ) {
      const widest = layout.width;
      layout.destroy();
      layout = this._laidOut(laid, base, { ...options, maxWidth: widest });
    }
    layout.truncated = layout.lines.length > cap;
    if (layout.truncated) {
      const last = layout.lines[cap - 1];
      const text = layout._text;
      layout.destroy();
      let end = last.end;
      if (elides) {
        end = this._ellipsisAt(sources, base, options, text, last.start, end);
      }
      laid = spansTo(sources, end, elides ? ELLIPSIS : '');
      layout = this._laidOut(laid, base, options);
      // where the mark wrapped after all — a width rounded the other way
      // than the probe's — the line gives up a character more, a few times
      for (let i = 0; elides && layout.lines.length > cap && i < 4; i++) {
        end = trimmedEnd(text, last.start, previousPoint(text, end));
        laid = spansTo(sources, end, ELLIPSIS);
        layout.destroy();
        layout = this._laidOut(laid, base, options);
      }
      layout.truncated = true;
    }
    layout._hangRuns(sources, laid, this._runOf(base));
    return layout;
  }

  /**
   * Where the last line kept of an eliding paragraph ends: as far into
   * `[start, end)` as fits beside the mark in `maxWidth`, white space before
   * the mark left out. Measured as that line alone, unwrapped.
   */
  _ellipsisAt(sources, base, options, text, start, end) {
    const room = options.maxWidth;
    if (!(room > 0) || !Number.isFinite(room)) return end;
    const open = { ...options, maxWidth: undefined, align: undefined };
    const fits = (at) => {
      const probe = this._laidOut(
        spansBetween(sources, start, trimmedEnd(text, start, at), ELLIPSIS),
        base,
        open,
      );
      const width = probe.width;
      probe.destroy();
      return width <= room;
    };
    if (fits(end)) return trimmedEnd(text, start, end);
    let lo = start;
    let hi = end;
    while (hi - lo > 1) {
      const mid = pointAtOrBefore(text, (lo + hi) >> 1);
      if (mid <= lo) break;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return trimmedEnd(text, start, lo);
  }

  /** What a run is set in — its face, size and direction, ntk's `run` — by
   *  the span it was laid out from, made once a span and direction. */
  _runOf(base) {
    const made = new Map();
    return (span, rtl) => {
      let byDirection = made.get(span);
      if (!byDirection) {
        byDirection = [null, null];
        made.set(span, byDirection);
      }
      const at = rtl ? 1 : 0;
      byDirection[at] ??= {
        font: this.match(span.family ?? base.family, {
          weight: span.weight ?? base.weight,
          style: span.style ?? base.style,
        }),
        size: sizeOf(span.size ?? base.size),
        direction: rtl ? 'rtl' : 'ltr',
      };
      return byDirection[at];
    };
  }

  /** The bridge's layout of `list`, as it lays it out: no cap, no mark. */
  _laidOut(list, base, options) {
    let text = '';
    const ranges = [];
    for (const span of list) {
      const piece = String(span?.text ?? '');
      if (!piece) continue;
      const start = text.length;
      text += piece;
      const ink = colorOf(span.color ?? base.color);
      const set = requestOf(
        this._stack(span.family ?? base.family),
        span.weight ?? base.weight,
        span.style ?? base.style,
      );
      ranges.push({
        start,
        length: piece.length,
        family: set.family,
        size: sizeOf(span.size ?? base.size),
        weight: set.weight,
        italic: set.italic,
        stretch: set.stretch,
        // A variable face's axes. Passed per span as well as on the base,
        // because a span carries its own and a paragraph is one layout.
        variations: span.variations ?? base.variations ?? undefined,
        ...spacingOf(span, base),
        ...(ink ? ink : {}),
      });
    }

    const own = requestOf(this._stack(base.family), base.weight, base.style);
    const handle = this._native.layoutCreate(
      text,
      {
        family: own.family,
        size: sizeOf(base.size),
        weight: own.weight,
        italic: own.italic,
        stretch: own.stretch,
        variations: base.variations ?? undefined,
        maxWidth: options.maxWidth,
        align: options.align,
        lineHeight: options.lineHeight,
        rtl: options.direction === 'rtl',
      },
      ranges,
    );

    const raw = this._native.layoutMetrics(handle);
    if (DEBUG) {
      // The family is in here because the one way this goes quietly wrong is
      // `resolveStack` not recognising a name and answering `sans-serif`: the
      // text still draws, in the wrong face, at the wrong metrics, and the
      // only tell is a width that does not match the face the app thinks it
      // asked for.
      console.error(
        `[win32] layout "${text.slice(0, 24)}" ${raw.width}x${raw.height} ` +
          `family=${JSON.stringify(ranges[0]?.family)} size=${base.size} ` +
          `vars=${JSON.stringify(base.variations ?? null)}`,
      );
    }

    // Every engine answers an ascent and a descent per line — a field and the
    // edit menu measure a line's ink as their sum — and the bridge measures
    // both off the faces on the line. A line it measured nothing on (an
    // empty one) takes them from its baseline. Worked out from the baseline
    // always, as they were before the bridge said, a `lineHeight` put the
    // descent below the line box: the bridge sets that baseline at 0.8 of
    // the face's, and a line at `lineHeight: 1` read as shorter than its
    // own strut, so <Html> laid every paragraph out a line at a time.
    //
    // And a baseline is ntk's: from the top of the layout. DirectWrite's is
    // from the top of its line, so every line but the first was read as
    // though its baseline were on the first — <Html> drew a link's
    // underline on the line above the link.
    //
    // A line's `width` is ntk's too: without the white space it ends on,
    // which its `advance` keeps. The bridge measures the line's runs, the
    // space a wrap ended it on among them, so a line that fitted read as
    // wider than its box: <Html> took each line beside a float for one that
    // did not fit there and moved it below the float, a line at a time.
    const lines = (raw.lines ?? []).map((line) => {
      const measured =
        line.ascent > 0 && Number.isFinite(line.descent) && line.descent >= 0;
      return {
        ...line,
        width: inkWidth(this._native, handle, text, line),
        advance: line.width,
        baseline: line.y + line.baseline,
        ascent: measured ? line.ascent : line.baseline,
        descent: measured
          ? line.descent
          : Math.max(0, line.height - line.baseline),
        // `rangeBands` walks a line's runs to build a selection highlight,
        // and reads each one's direction off a nested `run` object — ntk's
        // shape. A line with no runs is not an empty line here, it is a
        // crash: `line.runs is not iterable`.
        runs: (line.runs ?? []).map((run) => ({
          ...run,
          run: { direction: run.rtl ? 'rtl' : 'ltr' },
        })),
      };
    });
    // DirectWrite's width leaves out a no-break space a line ends on, as it
    // leaves out a space, where ntk's counts it as the letter it is to a
    // line: a lone one measured nothing, and <Html>, which spaces an inline
    // box's edges with one, made every edge a space too wide. The lines'
    // own widths keep it, in the whole pixels the bridge answers in.
    let width = raw.width;
    for (const line of lines) {
      width = Math.max(width, Math.ceil(line.width - 1e-3));
    }
    return new Win32TextLayout(this, handle, text, { ...raw, width, lines });
  }

  /** A stack resolved once (`resolveStack`): a named family is a
   *  DirectWrite lookup, and every layout asks for every span. */
  _stack(stack) {
    this._stacks ??= new Map();
    const key = stack ?? '';
    let resolved = this._stacks.get(key);
    if (resolved === undefined) {
      resolved = resolveStack(this._native, stack);
      this._stacks.set(key, resolved);
    }
    return resolved;
  }

  match(family, options = {}) {
    const set = requestOf(this._stack(family), options.weight, options.style);
    const style = set.italic ? 'italic' : 'normal';
    const key = `${set.family}|${set.weight}|${style}|${set.stretch}`;
    let face = this._faces.get(key);
    if (!face) {
      face = new Win32Face(this, set.family, {
        weight: set.weight,
        style,
        stretch: set.stretch,
      });
      this._faces.set(key, face);
    }
    return face;
  }

  /**
   * The system font fallback. DirectWrite's own
   * `IDWriteFontFallback::MapCharacters` is the right answer and is not bound
   * yet, so this reports that it has none rather than guessing a family —
   * a wrong face is worse than tofu, because nothing downstream can tell it
   * went wrong.
   */
  fallbackFor() {
    return null;
  }
}
