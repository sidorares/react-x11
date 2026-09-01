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
import { cssColorStraight } from 'ntk';

import { loadNative } from './native.js';

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

export class CocoaFontManager {
  constructor() {
    this._native = loadNative();
    this._fonts = new Map(); // family|weight|italic|size -> handle
    this._faces = new Map(); // family|weight|italic -> face wrapper
    this._loaded = []; // families registered via load(), tried first
  }

  _font(family, weight, italic, size) {
    const key = `${family}|${weight}|${italic}|${size}`;
    let handle = this._fonts.get(key);
    if (!handle) {
      handle = this._native.matchFont({
        families: [...this._loaded, ...familyList(family)],
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
   * `loadFont()`'s engine half: register font bytes with CoreText for this
   * process and put the family first in every later match.
   */
  load(data) {
    const info = this._native.loadFontData(
      Buffer.isBuffer(data) ? data : Buffer.from(data),
    );
    if (!info) {
      throw new Error(
        'react-x11: loadFont — CoreText could not read the font data.',
      );
    }
    if (!this._loaded.includes(info.familyName)) {
      this._loaded.unshift(info.familyName);
    }
    // sized matches are stale the moment a better family exists
    this._fonts.clear();
    return { family: info.familyName, postScriptName: info.postScriptName };
  }

  layout(spans, base, options = {}) {
    const { maxWidth, align, lineHeight, maxLines, overflow, direction } =
      options;
    const nativeSpans = [];
    let text = '';
    for (const span of spans) {
      const t = String(span.text ?? '');
      if (!t) continue;
      text += t;
      nativeSpans.push({
        text: t,
        font: this._font(
          span.family ?? base.family,
          numericWeight(span.weight ?? base.weight),
          isItalic(span.style ?? base.style),
          span.size ?? base.size ?? 14,
        ),
        color: parseColor(span.color ?? base.color),
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
    return new CocoaTextLayout(this._native, raw, text);
  }
}
