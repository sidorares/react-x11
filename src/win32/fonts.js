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
import { cssColorStraight } from 'ntk';

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
function familyOf(native, stack) {
  if (!stack) return 'sans-serif';
  for (const raw of String(stack).split(',')) {
    const name = raw.trim().replace(/^["']|["']$/g, '');
    if (!name) continue;
    if (GENERIC.has(name)) return name;
    if (native.fontExists(name)) return name;
  }
  return 'sans-serif';
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
  constructor(manager, family, { weight = 400, style = 'normal' } = {}) {
    this._manager = manager;
    this.family = family;
    this.weight = weightOf(weight);
    this.style = style;
    this.italic = style === 'italic' || style === 'oblique';
  }

  metrics(size) {
    return this._manager._native.fontMetrics(
      this.family,
      size,
      this.weight,
      this.italic,
    );
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
    if (typeof codepoint === 'number') return this.glyphIdFor(codepoint) !== null;
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
    const key = `${face.family}|${face.weight}|${face.italic ? 1 : 0}|${px}`;
    let handle = this._handles.get(key);
    if (handle === undefined) {
      handle = this._native.fontHandle(face.family, px, face.weight, face.italic) || null;
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
    const loaded = this._native.fontLoad(data);
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
    // replaces.
    this._faces.clear();
    this._handles.clear();
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
   */
  layout(spans, base = {}, options = {}) {
    const list =
      typeof spans === 'string' ? [{ text: spans, ...base }] : (spans ?? []);
    let text = '';
    const ranges = [];
    for (const span of list) {
      const piece = String(span?.text ?? '');
      if (!piece) continue;
      const start = text.length;
      text += piece;
      const ink = colorOf(span.color ?? base.color);
      ranges.push({
        start,
        length: piece.length,
        family: familyOf(this._native, span.family ?? base.family),
        size: sizeOf(span.size ?? base.size),
        weight: weightOf(span.weight ?? base.weight ?? 400),
        italic: (span.style ?? base.style) === 'italic',
        ...(ink ? ink : {}),
      });
    }

    const handle = this._native.layoutCreate(
      text,
      {
        family: familyOf(this._native, base.family),
        size: sizeOf(base.size),
        weight: weightOf(base.weight ?? 400),
        italic: base.style === 'italic',
        maxWidth: options.maxWidth,
        align: options.align,
        lineHeight: options.lineHeight,
        maxLines: options.maxLines,
        rtl: options.direction === 'rtl',
      },
      ranges,
    );

    if (DEBUG) {
      console.error(
        `[win32] layout "${text.slice(0, 24)}" base.size=${base.size} ` +
          `spans=${ranges.map((r) => r.size).join(',')}`,
      );
    }

    const raw = this._native.layoutMetrics(handle);
    // `descent` is what halfLeading() in nodes/text.js subtracts to recreate
    // CSS half-leading, and DirectWrite reports a baseline and a height per
    // line rather than a descent.
    const lines = (raw.lines ?? []).map((line) => ({
      ...line,
      descent: Math.max(0, line.height - line.baseline),
      // `rangeBands` walks a line's runs to build a selection highlight, and
      // reads each one's direction off a nested `run` object — ntk's shape.
      // A line with no runs is not an empty line here, it is a crash:
      // `line.runs is not iterable`.
      runs: (line.runs ?? []).map((run) => ({
        ...run,
        run: { direction: run.rtl ? 'rtl' : 'ltr' },
      })),
    }));
    return new Win32TextLayout(this, handle, text, { ...raw, lines });
  }

  match(family, options = {}) {
    const name = familyOf(this._native, family);
    const key = `${name}|${weightOf(options.weight)}|${options.style ?? 'normal'}`;
    let face = this._faces.get(key);
    if (!face) {
      face = new Win32Face(this, name, options);
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
