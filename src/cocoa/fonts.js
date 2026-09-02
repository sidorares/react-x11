// The Cocoa text engine: CoreText behind the same `app.fonts` contract ntk's
// FontManager answers on the X11 backend. The renderer touches exactly this
// surface (docs/macos.md §"Text: the engine contract"):
//
//   fonts.layout(spans, base, { maxWidth, align, lineHeight, maxLines,
//                               overflow, direction })
//     -> { width, height, lines, draw(ctx, x, y),
//          indexAt(x, y), caretPosition(cp) }
//   fonts.match(family, { weight, style }) -> { metrics(size) }
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

export class CocoaFontManager {
  constructor() {
    this._native = loadNative();
    this._fonts = new Map(); // family|weight|italic|size -> handle
    this._faces = new Map(); // family|weight|italic -> face wrapper
    this._registered = new Map(); // lowercase family -> [{cg, weight, italic}]
    this._byKey = new Map(); // ntk Font key -> { cg } | { ps }
    this._sized = new Map(); // face key|size|variations -> CTFont handle
    this._layouts = new Map(); // layout signature -> CocoaTextLayout (LRU)
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
   * from. The face defers size, like ntk's: `metrics(size)` answers for a
   * concrete pixel size.
   */
  match(family, { weight, style } = {}) {
    const w = numericWeight(weight);
    const italic = isItalic(style);
    const key = `${family}|${w}|${italic}`;
    let face = this._faces.get(key);
    if (!face) {
      const manager = this;
      face = {
        metrics(size) {
          return manager._native.fontMetrics(
            manager._font(family, w, italic, size ?? 14),
          );
        },
        hasGlyph(char) {
          return manager._native.fontHasGlyph(
            manager._font(family, w, italic, 14),
            String(char),
          );
        },
      };
      this._faces.set(key, face);
    }
    return face;
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
        face && (face.postscriptName || face.path || face.fk)
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
