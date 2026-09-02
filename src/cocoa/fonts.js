// The Cocoa text engine: CoreText behind the same `app.fonts` contract ntk's
// FontManager answers on the X11 backend. The renderer touches exactly this
// surface (docs/macos.md §"Text: the engine contract"):
//
//   fonts.layout(spans, base, { maxWidth, align, lineHeight, maxLines,
//                               overflow, direction })
//     -> { width, height, lines, draw(ctx, x, y),
//          indexAt(x, y), caretPosition(cp) }
//   fonts.match(family, { weight, style }) -> face
//   fonts.fallbackFor(codepoint, family, { weight, style }) -> face | null
//
// and a face is ntk's `Font` as far as a renderer that positions glyphs
// itself reads it — `metrics(size)`, `hasGlyph(cp)`, `glyphIdFor(cp)`,
// `advanceOf(id, size)`, `shape(text, size)` — so a run built here draws
// through `ctx.drawGlyphs` here (issue #432; the natives are
// windowkit/appkit#1).
//
// Index spaces, because two meet here: `lines[].start/end` and
// `runs[].start/end` are UTF-16 code units (what `rangeBands` in nodes.js
// compares against), while `caretPosition()` takes and `indexAt()` returns
// code points (what the selection and caret code speak). CoreText itself is
// UTF-16 end to end; the code-point conversion happens at this boundary and
// nowhere else.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

import { cssColorStraight, Font } from 'ntk';

import { loadNative } from './native.js';

/**
 * WOFF v1 -> sfnt: the same table directory, zlib per table. ~40 lines of
 * unwrapping is what lets every `.woff` an app already ships keep working
 * on this backend without a converter in the build.
 */
function woffToSfnt(woff) {
  const numTables = woff.readUInt16BE(12);
  const flavor = woff.readUInt32BE(4);
  const entries = [];
  for (let i = 0; i < numTables; i++) {
    const at = 44 + i * 20;
    const compLength = woff.readUInt32BE(at + 8);
    const origLength = woff.readUInt32BE(at + 12);
    const offset = woff.readUInt32BE(at + 4);
    const compressed = woff.subarray(offset, offset + compLength);
    entries.push({
      tag: woff.readUInt32BE(at),
      checksum: woff.readUInt32BE(at + 16),
      data: compLength === origLength ? compressed : inflateSync(compressed),
      origLength,
    });
  }
  const headerSize = 12 + numTables * 16;
  let total = headerSize;
  for (const entry of entries) total += (entry.origLength + 3) & ~3;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(numTables, 4);
  const pow2 = 1 << Math.floor(Math.log2(numTables));
  out.writeUInt16BE(pow2 * 16, 6); // searchRange
  out.writeUInt16BE(Math.floor(Math.log2(numTables)), 8); // entrySelector
  out.writeUInt16BE(numTables * 16 - pow2 * 16, 10); // rangeShift
  let dataAt = headerSize;
  entries.forEach((entry, i) => {
    const dir = 12 + i * 16;
    out.writeUInt32BE(entry.tag, dir);
    out.writeUInt32BE(entry.checksum, dir + 4);
    out.writeUInt32BE(dataAt, dir + 8);
    out.writeUInt32BE(entry.origLength, dir + 12);
    entry.data.copy(out, dataAt);
    dataAt += (entry.origLength + 3) & ~3;
  });
  return out;
}

/** family list string -> array: 'Inter, "SF Pro", sans-serif' */
function familyList(family) {
  if (Array.isArray(family)) return family;
  return String(family ?? 'sans-serif')
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function numericWeight(weight) {
  if (typeof weight === 'number') return weight;
  if (weight === 'bold') return 700;
  if (weight === 'medium') return 500;
  if (weight === 'semibold') return 600;
  if (weight === 'light') return 300;
  return 400;
}

const isItalic = (style) => style === 'italic' || style === 'oblique';

function parseColor(color) {
  const parsed = cssColorStraight(color ?? '#000');
  return parsed ?? [0, 0, 0, 1];
}

/** UTF-16 offset of each code point boundary, plus the end. */
function codeUnitOffsets(text) {
  const offsets = [0];
  for (const ch of text) offsets.push(offsets[offsets.length - 1] + ch.length);
  return offsets;
}

class CocoaTextLayout {
  constructor(native, raw, text) {
    this._native = native;
    this._handle = raw.handle;
    this._text = text;
    this._cpToCu = codeUnitOffsets(text);
    this.width = raw.width;
    this.height = raw.height;
    this.lines = raw.lines;
  }

  _cuOf(cp) {
    const t = this._cpToCu;
    return t[Math.max(0, Math.min(cp, t.length - 1))];
  }

  _cpOf(cu) {
    const t = this._cpToCu;
    // t is sorted; layouts are short, a linear walk is fine
    for (let i = 0; i < t.length; i++) if (t[i] >= cu) return i;
    return t.length - 1;
  }

  draw(ctx, x, y) {
    ctx._drawLayout(this, x, y);
  }

  /** Code point boundary nearest the point, in layout coordinates. */
  indexAt(x, y) {
    return this._cpOf(this._native.layoutIndexAt(this._handle, x, y));
  }

  /** Caret rect for a code-point index: { x, y, height }. */
  caretPosition(cp) {
    return this._native.layoutCaret(this._handle, this._cuOf(cp));
  }
}

const ALIGN_FLUSH = { left: 0, center: 0.5, right: 1 };

function flushFor(align, direction) {
  if (align === 'start' || align === undefined) {
    return direction === 'rtl' ? 1 : 0;
  }
  if (align === 'end') return direction === 'rtl' ? 0 : 1;
  return ALIGN_FLUSH[align] ?? 0;
}

const GENERIC_FAMILIES = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'system-ui',
  'ui-sans-serif',
  'ui-monospace',
]);

/** The size a face is probed at when the question has no size in it. */
const PROBE_SIZE = 14;

/**
 * A face — what `match()` and `fallbackFor()` answer — in the shape of
 * ntk's `Font` as far as a renderer that positions glyphs itself reads it
 * (ntk docs/text.md#glyph-runs): `metrics`, `hasGlyph`, `glyphIdFor`,
 * `advanceOf`, `shape`. The face defers size the way ntk's does: `_handle`
 * is the CTFont at a concrete pixel size, and every member that needs one
 * asks for it, so one face serves a terminal at 13px and a label at 24px.
 *
 * Glyph ids are the font's own indices in both engines, so a run built
 * from `glyphIdFor` here draws through `ctx.drawGlyphs` here with no
 * translation; `run.font` is simply this object.
 */
export class CocoaFace {
  /**
   * @param manager the CocoaFontManager
   * @param key stable identity (the match key, or the PostScript name of a
   *   face that arrived by substitution)
   * @param sizedHandle (size) => CTFont handle for this face at that size
   */
  constructor(manager, key, sizedHandle) {
    this._manager = manager;
    this.key = key;
    this._sizedHandle = sizedHandle;
    this._sized = new Map(); // size -> handle
    this._names = null;
  }

  _handle(size) {
    const s = Number.isFinite(size) && size > 0 ? size : PROBE_SIZE;
    let handle = this._sized.get(s);
    if (handle === undefined) {
      handle = this._sizedHandle(s) ?? null;
      this._sized.set(s, handle);
    }
    return handle;
  }

  _name() {
    if (!this._names) {
      const m = this._manager._native.fontMetrics(this._handle(PROBE_SIZE));
      this._names = {
        familyName: m.familyName ?? '',
        postscriptName: m.postScriptName ?? '',
      };
    }
    return this._names;
  }

  /** The family CoreText resolved — `Menlo`, `Apple Color Emoji`. */
  get familyName() {
    return this._name().familyName;
  }

  /** ntk's spelling of the PostScript name, for callers written against
   *  its `Font`. */
  get postscriptName() {
    return this._name().postscriptName;
  }

  /**
   * Scaled to a pixel size. CoreText's names (`leading`) and ntk's
   * (`lineGap`, `lineHeight`) side by side, so a caller written against
   * either reads a finite line height.
   */
  metrics(size) {
    const m = this._manager._native.fontMetrics(this._handle(size));
    return {
      ...m,
      lineGap: m.leading,
      lineHeight: m.ascent + m.descent + m.leading,
    };
  }

  /**
   * Coverage. A code point (ntk's contract) or a string — the two forms
   * `hasGlyph` has been asked in.
   */
  hasGlyph(codepoint) {
    if (typeof codepoint === 'number')
      return this.glyphIdFor(codepoint) !== null;
    return this._manager._native.fontHasGlyph(
      this._handle(PROBE_SIZE),
      String(codepoint),
    );
  }

  /**
   * Glyph id for a code point, or `null` when this face does not map it —
   * the lookup twin of `hasGlyph` (ntk#254). A cmap lookup only: no
   * shaping, so text that needs ligatures or marks goes through `shape()`.
   */
  glyphIdFor(codepoint) {
    if (typeof codepoint !== 'number') return null;
    return this._manager._native.fontGlyphForCodepoint(
      this._handle(PROBE_SIZE),
      codepoint,
    );
  }

  /** Nominal (unshaped) horizontal advance of a glyph id, in pixels at
   *  `size`. */
  advanceOf(glyphId, size) {
    const advances = this._manager._native.fontGlyphAdvances(
      this._handle(size),
      [glyphId],
    );
    return advances[0] ?? 0;
  }

  /**
   * Shape a run of text at a pixel size: `{ font, size, direction, width,
   * glyphs: [{ id, ax, dx, dy }] }`, glyphs in visual order with ntk's
   * pen contract — `ax` the advance, `dx`/`dy` the drawing offset from the
   * pen (y up). One CTLine through the typesetter, which is what a cluster
   * (a base with combining marks, an emoji with a variation selector)
   * needs and a grid renderer bypasses for everything else.
   *
   * One thing ntk's `shape()` never does happens here: CoreText substitutes
   * a face for characters this one lacks instead of shaping them as
   * `.notdef`, and a glyph from a substituted run carries that face as
   * `font` — an extra field ntk's contract ignores and this backend's
   * `drawGlyphs` honours, so `☺️` in Menlo comes out as the emoji rather
   * than Menlo's glyph at the emoji font's index.
   */
  shape(text, size, opts = {}) {
    const manager = this._manager;
    const raw = manager._native.fontShapeText(this._handle(size), String(text));
    const glyphs = [];
    let pen = 0;
    for (const run of raw.runs) {
      const face = run.font ? manager._faceOfHandle(run.font, size) : null;
      for (let i = 0; i < run.glyphs.length; i++) {
        const ax = run.advances[i];
        const glyph = {
          id: run.glyphs[i],
          ax,
          dx: run.positions[i * 2] - pen,
          dy: run.positions[i * 2 + 1],
        };
        if (face) glyph.font = face;
        glyphs.push(glyph);
        pen += ax;
      }
    }
    return {
      font: this,
      size,
      direction: opts.direction ?? 'ltr',
      width: raw.width,
      glyphs,
    };
  }
}

export class CocoaFontManager {
  /** @param native the @windowkit/appkit module; the tests hand in a fake */
  constructor(native = loadNative()) {
    this._native = native;
    this._fonts = new Map(); // family|weight|italic|size -> handle
    this._faces = new Map(); // family|weight|italic -> face wrapper
    this._registered = new Map(); // lowercase family -> [{cg, weight, italic}]
    this._byKey = new Map(); // ntk Font key -> { cg } | { ps }
    this._sized = new Map(); // face key|size|variations -> CTFont handle
    this._layouts = new Map(); // layout signature -> CocoaTextLayout (LRU)
    this._fallbacks = new Map(); // family|weight|italic -> Map(cp -> face|null)
    this._faceByPs = new Map(); // PostScript name -> face CoreText chose itself
  }

  /**
   * `openFont()`'s engine seam (src/fonts.js `openThrough`): parse the face
   * with fontkit — the object applications read metrics and axes off — and
   * feed the same bytes to CoreText so the face RENDERS here too, by
   * family name or as a `span.font`. An opened file is a face the user
   * chose to look at; a backend where it measures but draws as the system
   * font answers a different question than the one asked.
   */
  _open(candidate) {
    const { key, path, data, postscriptName } = candidate;
    const font =
      path !== undefined
        ? Font.loadSync(path, postscriptName)
        : Font.fromData(data, candidate);
    try {
      let bytes =
        path !== undefined
          ? readFileSync(path)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data.buffer ?? data);
      const magic = bytes.length >= 4 ? bytes.readUInt32BE(0) : 0;
      if (magic === 0x774f4646) bytes = woffToSfnt(bytes);
      if (magic !== 0x774f4632 /* woff2 stays fontkit-only */) {
        const info = this._native.fontFromData(bytes);
        // a .ttc's data handle is its FIRST face; when a specific face was
        // asked for and this is not it, leave rendering to the PostScript
        // route (installed collections resolve there anyway)
        const face = postscriptName ?? font.postscriptName;
        if (info && (!face || info.postScriptName === face)) {
          this._byKey.set(font.key ?? key, { cg: info.cg });
          const family = (info.familyName ?? '').toLowerCase();
          if (family) {
            const faces = this._registered.get(family) ?? [];
            faces.push({
              cg: info.cg,
              weight: numericWeight(info.weight),
              italic: Boolean(info.italic),
            });
            this._registered.set(family, faces);
          }
          this._fonts.clear();
          this._faces.clear();
          this._sized.clear();
          this._fallbacks.clear();
        }
      }
    } catch {
      // the fontkit face still measures; rendering falls back by family
    }
    return font;
  }

  /**
   * A CTFont for an ntk `Font` face handed over as `span.font` — the way
   * the fonts app renders the face it opened, and the way `loadFont`'s
   * faces reach glyphs. Resolution: an installed face by its exact
   * PostScript name; otherwise the file's own bytes (unwrapping `.woff`),
   * cached per face key.
   */
  _faceFont(face, size, variations) {
    const key = face.key ?? `${face.path ?? ''}#${face.postscriptName ?? ''}`;
    let entry = this._byKey.get(key);
    if (!entry) {
      entry = {};
      const ps = face.postscriptName;
      if (ps && this._native.fontByPostScriptName(ps, 12)) {
        entry.ps = ps;
      } else {
        let data = null;
        if (face.path) {
          try {
            data = readFileSync(face.path);
          } catch {
            data = null;
          }
        }
        if (!data && face.fk?.stream?.buffer) {
          data = Buffer.from(face.fk.stream.buffer);
        }
        if (data) {
          if (data.length >= 4 && data.readUInt32BE(0) === 0x774f4646) {
            data = woffToSfnt(data);
          }
          const info = this._native.fontFromData(data);
          if (info) entry.cg = info.cg;
        }
      }
      this._byKey.set(key, entry);
    }
    const sizedKey = `${key}|${size}|${variations ? JSON.stringify(variations) : ''}`;
    let handle = this._sized.get(sizedKey);
    if (handle) return handle;
    if (entry.ps) handle = this._native.fontByPostScriptName(entry.ps, size);
    else if (entry.cg) handle = this._native.cgFontWithSize(entry.cg, size);
    if (!handle) return null;
    handle = this._withVariations(handle, variations);
    this._sized.set(sizedKey, handle);
    return handle;
  }

  _withVariations(handle, variations) {
    if (
      variations &&
      typeof variations === 'object' &&
      Object.keys(variations).length > 0
    ) {
      return this._native.fontApplyVariations(handle, variations);
    }
    return handle;
  }

  /**
   * The catalogue seam ntk exposes as `fonts.source` — what the fonts app
   * browses. On X that is fontconfig; here it is CoreText's collection.
   * Pattern syntax: the family, with fontconfig's `:modifiers` tolerated
   * and ignored (`Menlo:bold`, `:lang=ru` — the part after the colon is
   * fontconfig vocabulary CoreText does not speak).
   */
  get source() {
    return (this._source ??= {
      matchSortedAsync: async ({ family } = {}) => {
        const pattern = String(family ?? '').trim();
        let name = pattern.split(':')[0].trim();
        if (name && GENERIC_FAMILIES.has(name.toLowerCase())) {
          // Rendering resolves generics to the system face, but its family
          // is a hidden name (`.AppleSystemUIFont`) the catalogue cannot
          // enumerate — a browser wants the visible families instead.
          name =
            {
              serif: 'Times New Roman',
              monospace: 'Menlo',
              'ui-monospace': 'Menlo',
              cursive: 'Snell Roundhand',
            }[name.toLowerCase()] ?? 'Helvetica Neue';
        }
        const rows = this._native.listFonts(
          name ? { family: name } : { limit: 400 },
        );
        return rows
          .filter((row) => row.path)
          .map((row) => ({
            path: row.path,
            postscriptName: row.postScriptName,
            family: row.familyName,
            style: row.styleName,
            charset: '',
          }));
      },
    });
  }

  _font(family, weight, italic, size) {
    const key = `${family}|${weight}|${italic}|${size}`;
    let handle = this._fonts.get(key);
    if (!handle) {
      // Faces the app loaded win over system matching for their family —
      // an app that ships a font means the one it ships (src/fonts.js).
      for (const name of familyList(family)) {
        const faces = this._registered.get(name.toLowerCase());
        if (!faces?.length) continue;
        let best = null;
        let bestCost = Infinity;
        for (const face of faces) {
          const cost =
            Math.abs(face.weight - weight) +
            (face.italic === italic ? 0 : 1000);
          if (cost < bestCost) {
            bestCost = cost;
            best = face;
          }
        }
        handle = this._native.cgFontWithSize(best.cg, size);
        break;
      }
      handle ??= this._native.matchFont({
        families: familyList(family),
        size,
        weight,
        italic,
      });
      this._fonts.set(key, handle);
    }
    return handle;
  }

  /**
   * A face by family/weight/style — what `textBoxTrim` reads `capHeight`
   * from and what a terminal builds its glyph runs on. The face defers
   * size, like ntk's: `metrics(size)` answers for a concrete pixel size,
   * and the family re-resolves per size through `_font` (SF's optical
   * sizing is a different face at 13px and at 28px).
   */
  match(family, { weight, style } = {}) {
    const w = numericWeight(weight);
    const italic = isItalic(style);
    const key = `${family}|${w}|${italic}`;
    let face = this._faces.get(key);
    if (!face) {
      face = new CocoaFace(this, key, (size) =>
        this._font(family, w, italic, size),
      );
      this._faces.set(key, face);
    }
    return face;
  }

  /**
   * A face that covers `codepoint` when the one for `family` does not, or
   * `null` when nothing on the system does — ntk's
   * `FontManager.fallbackFor`, in its order: faces the app loaded first (an
   * app that ships a font means the one it ships), then CoreText's cascade
   * off the matched face (`CTFontCreateForString`), the same substitution
   * `layout()` gets from the typesetter. Cached per family, weight, style
   * and code point; the matched face itself when it already covers the
   * code point, so runs group with the base's.
   */
  fallbackFor(codepoint, family = 'sans-serif', opts = {}) {
    if (typeof codepoint !== 'number') {
      codepoint = String(codepoint).codePointAt(0) ?? -1;
    }
    const w = numericWeight(opts.weight);
    const italic = isItalic(opts.style);
    const cacheKey = `${family}|${w}|${italic}`;
    let perCp = this._fallbacks.get(cacheKey);
    if (!perCp) {
      perCp = new Map();
      this._fallbacks.set(cacheKey, perCp);
    }
    if (perCp.has(codepoint)) return perCp.get(codepoint);
    const base = this.match(family, {
      weight: w,
      style: italic ? 'italic' : 'normal',
    });
    let found = null;
    for (const faces of this._registered.values()) {
      for (const reg of faces) {
        const face = this._registeredFace(reg);
        if (face.glyphIdFor(codepoint) !== null) {
          found = face;
          break;
        }
      }
      if (found) break;
    }
    if (!found) {
      let text = null;
      try {
        text = String.fromCodePoint(codepoint);
      } catch {
        text = null; // not a scalar value: nothing covers it
      }
      const handle =
        text === null
          ? null
          : this._native.fontFallbackFor(base._handle(PROBE_SIZE), text);
      if (handle) found = this._faceOfHandle(handle, PROBE_SIZE);
    }
    if (
      found &&
      found !== base &&
      found.postscriptName === base.postscriptName
    ) {
      found = base;
    }
    perCp.set(codepoint, found);
    return found;
  }

  /** The face of a loaded file, over its own CGFont handle. */
  _registeredFace(reg) {
    if (!reg.face) {
      reg.face = new CocoaFace(this, 'registered', (size) =>
        this._native.cgFontWithSize(reg.cg, size),
      );
      reg.face.key = `registered:${reg.face.postscriptName}`;
    }
    return reg.face;
  }

  /**
   * The face behind a CTFont handle CoreText chose itself — a fallback, or
   * a substituted run inside `shape()` — one object per PostScript name, so
   * runs from either route group together in `drawGlyphs`. The handle seeds
   * the size it came at; other sizes are copies of it.
   */
  _faceOfHandle(handle, size) {
    const ps = this._native.fontMetrics(handle).postScriptName;
    let face = this._faceByPs.get(ps);
    if (!face) {
      face = new CocoaFace(this, `ps:${ps}`, (s) =>
        this._native.fontWithSize(handle, s),
      );
      this._faceByPs.set(ps, face);
    }
    if (!face._sized.has(size)) face._sized.set(size, handle);
    return face;
  }

  /**
   * The CTFont a glyph run draws with (`CocoaContext2D.drawGlyphs`): a face
   * of this engine's at the run's size, or an ntk `Font` — `openFont()`'s —
   * resolved to CoreText from the same bytes, so the glyph ids it shaped
   * with hold. Null for anything else, and the run is skipped.
   */
  _runHandle(font, size) {
    if (font instanceof CocoaFace) return font._handle(size);
    if (font && (font.postscriptName || font.path || font.fk)) {
      return this._faceFont(font, size);
    }
    return null;
  }

  /**
   * `loadFont()`'s engine half: register the face with CoreText so the
   * process can match it by family name (with real weight/italic traits —
   * they are read off the file, so four weights of one family resolve the
   * way `fontWeight` expects). `source` is a path or the font bytes, the
   * two shapes `src/fonts.js` hands over.
   *
   * Container rule: CoreText reads sfnt (ttf/otf/ttc). A `.woff` is those
   * same tables zlib-wrapped and is unwrapped here; a `.woff2` is a
   * different compression CoreText cannot take and this engine does not
   * rebuild — the error says what to load instead.
   */
  load(source, opts = {}) {
    let data;
    if (typeof source === 'string') {
      data = readFileSync(source);
    } else if (Buffer.isBuffer(source)) {
      data = source;
    } else if (source instanceof Uint8Array) {
      data = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    } else {
      throw new Error(
        'react-x11: loadFont — expected a file path or font bytes, got ' +
          typeof source,
      );
    }
    const magic = data.length >= 4 ? data.readUInt32BE(0) : 0;
    if (magic === 0x774f4632 /* wOF2 */) {
      throw new Error(
        'react-x11: loadFont — this is a .woff2 file, and the macOS font ' +
          'loader (CoreText) does not read that container. Load the .ttf, ' +
          '.otf or .woff of the same face instead — @fontsource packages ' +
          'ship a .woff beside every .woff2.',
      );
    }
    if (magic === 0x774f4646 /* wOFF */) data = woffToSfnt(data);
    const info = this._native.fontFromData(data);
    if (!info) {
      throw new Error(
        'react-x11: loadFont — CoreText could not read the font data' +
          (typeof source === 'string' ? ` in ${source}` : '') +
          ' (expected .ttf, .otf, .ttc or .woff).',
      );
    }
    // The process's own handle to the face, kept in a registry family
    // matching consults FIRST — CoreText registration of in-memory data is
    // best-effort at most, and rendering must not depend on it.
    const family = (opts.family ?? info.familyName ?? '').toLowerCase();
    if (family) {
      const faces = this._registered.get(family) ?? [];
      faces.push({
        cg: info.cg,
        weight: numericWeight(opts.weight ?? info.weight),
        italic: opts.style ? isItalic(opts.style) : Boolean(info.italic),
      });
      this._registered.set(family, faces);
    }
    // matches resolved before this face existed are stale now
    this._fonts.clear();
    this._faces.clear();
    this._sized.clear();
    this._layouts.clear();
    this._fallbacks.clear();
    // `null` on purpose: src/fonts.js keeps the fontkit face it already
    // opened as the handle, which is the one whose metrics apps can read;
    // the registry above is what rendering resolves against.
    return null;
  }

  layout(spans, base, options = {}) {
    // ntk's contract: a bare string or a single span are one-span
    // paragraphs. TextInputNode's value layout passes the string form, and
    // iterating a string as spans was a caret pinned to x = 0.
    if (typeof spans === 'string') spans = [{ text: spans }];
    else if (!Array.isArray(spans)) spans = [spans];
    // Memoized: an immediate-mode caller (the fonts app's specimen canvas,
    // a hover pass) lays the same paragraph out every repaint, and a
    // CTFramesetter per pointer move is what sluggish feels like. The key
    // is everything shaping reads; ~64 entries covers a screenful.
    const signature = JSON.stringify([
      spans.map((sp) => [
        sp.text,
        sp.family ?? base.family,
        sp.size ?? base.size,
        sp.weight ?? base.weight,
        sp.style ?? base.style,
        sp.color ?? base.color ?? null,
        sp.variations ?? base.variations ?? null,
        (sp.font ?? base.font)?.key ?? null,
      ]),
      options.maxWidth,
      options.align,
      options.lineHeight,
      options.maxLines,
      options.overflow,
      options.direction,
    ]);
    const hit = this._layouts.get(signature);
    if (hit) {
      // refresh LRU position
      this._layouts.delete(signature);
      this._layouts.set(signature, hit);
      return hit;
    }
    const { maxWidth, align, lineHeight, maxLines, overflow, direction } =
      options;
    const nativeSpans = [];
    let text = '';
    let contextInk = false;
    for (const span of spans) {
      const t = String(span.text ?? '');
      if (!t) continue;
      text += t;
      const size = span.size ?? base.size ?? 14;
      const variations = span.variations ?? base.variations;
      // A span may carry the face itself — an ntk Font from openFont(),
      // which is how the fonts app renders exactly the file it opened.
      const face = span.font ?? base.font;
      let handle =
        face instanceof CocoaFace
          ? this._withVariations(face._handle(size), variations)
          : face && (face.postscriptName || face.path || face.fk)
            ? this._faceFont(face, size, variations)
            : null;
      handle ??= this._withVariations(
        this._font(
          span.family ?? base.family,
          numericWeight(span.weight ?? base.weight),
          isItalic(span.style ?? base.style),
          size,
        ),
        variations,
      );
      const color = span.color ?? base.color;
      if (color == null) contextInk = true;
      nativeSpans.push({
        text: t,
        font: handle,
        ...(color == null ? {} : { color: parseColor(color) }),
      });
    }
    const raw = this._native.createLayout({
      spans: nativeSpans,
      maxWidth:
        Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : undefined,
      align: flushFor(align, direction),
      lineHeight: typeof lineHeight === 'number' ? lineHeight : undefined,
      maxLines: Number.isFinite(maxLines) ? maxLines : undefined,
      ellipsis: overflow === 'ellipsis',
      rtl: direction === 'rtl',
    });
    const layout = new CocoaTextLayout(this._native, raw, text);
    layout._contextInk = contextInk;
    this._layouts.set(signature, layout);
    if (this._layouts.size > 64) {
      this._layouts.delete(this._layouts.keys().next().value);
    }
    return layout;
  }
}
