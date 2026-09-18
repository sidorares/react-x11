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
}

export class Win32FontManager {
  constructor(native) {
    this._native = native;
    this._faces = new Map();
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
        family: familyOf(this._native, span.fontFamily ?? base.fontFamily),
        size: span.fontSize ?? base.fontSize ?? 12,
        weight: weightOf(span.fontWeight ?? base.fontWeight ?? 400),
        italic: (span.fontStyle ?? base.fontStyle) === 'italic',
        ...(ink ? ink : {}),
      });
    }

    const handle = this._native.layoutCreate(
      text,
      {
        family: familyOf(this._native, base.fontFamily),
        size: base.fontSize ?? 12,
        weight: weightOf(base.fontWeight ?? 400),
        italic: base.fontStyle === 'italic',
        maxWidth: options.maxWidth,
        align: options.align,
        lineHeight: options.lineHeight,
        maxLines: options.maxLines,
        rtl: options.direction === 'rtl',
      },
      ranges,
    );

    const raw = this._native.layoutMetrics(handle);
    // `descent` is what halfLeading() in nodes/text.js subtracts to recreate
    // CSS half-leading, and DirectWrite reports a baseline and a height per
    // line rather than a descent.
    const lines = (raw.lines ?? []).map((line) => ({
      ...line,
      descent: Math.max(0, line.height - line.baseline),
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
