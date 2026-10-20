// CSS's shorthands, as the longhands they set — and the one grammar every
// length in a style is read by.
//
// Pure, like decorations.js and grid.js: strings in, longhands out. The
// style funnel expands with it (`expandStyle`, from styles.js's
// `resolveComputedStyle`) and development validates with the same readers
// (`checkShorthand`, `readLength`), so the two cannot disagree about what a
// value means.
//
// Three decisions here are easy to undo:
//
// - **The more specific property wins, wherever it is written.**
//   `paddingLeft` beside `padding: '8px 16px'` is the left padding whether
//   it comes before or after it in the style — the rule `paddingLeft` beside
//   `padding: 8` has always followed, and the one `flex` follows. CSS decides
//   by order, and a flattened style array has no order left to decide by: a
//   longhand and its shorthand are two keys of one object. So a longhand
//   beats a shorthand, a side beats all four, and a pair (`paddingBlock`)
//   beats all four too. Among the shorthands that is `SHORTHAND_ORDER`.
//
// - **A length is a number of logical pixels however it is written.** `12`,
//   `'12'` and `'12px'` are the same value by the time anything reads it.
//   They were not: the display scale multiplies numbers only
//   (`scaleResolvedStyle`), so `'12px'` was six logical pixels at 2x; yoga's
//   border setter takes no strings, so `borderWidth: '2px'` drew nothing;
//   and the layout's fast paths read any string as a percentage. A unit this
//   file does not know is an error where the style is written, never
//   `parseFloat`'s guess — yoga read `'2em'` as two pixels.
//
// - **An omitted part is left unset, not reset.** CSS resets every longhand
//   a shorthand leaves out; here the longhand beside it would win anyway (the
//   first rule), so a reset could only ever reach a property nobody named.
//   Three exceptions, all CSS's: a border or an outline with no width is
//   `medium`, 3px — a border with no width draws nothing here, where CSS
//   would draw one — `none` is a width of 0, the way `border: none` and
//   `outline: none` are written to take one away, and a line with no colour
//   is `currentColor`. That last one is the weakest thing in the style: a
//   colour the style names for the same side anywhere else — `borderColor`
//   beside `borderBottom: '1px solid'` — is the one it takes
//   (`expandStyle`), which is what such a style meant before there was a
//   `currentColor` to fall back on.
import { cssColorStraight } from 'ntk/color';

import { isCurrentColor } from './currentcolor.js';
import { parseLinearGradient, splitTop } from './decorations.js';

/** What a length property takes besides pixels. */
const PERCENT = 1;
const AUTO = 2;
/** CSS's `thin`, `medium` and `thick`: a line's width only. */
const WIDTH_WORDS = 4;

/**
 * Every style property that is a distance on the screen, and what each takes
 * besides pixels. The same set the display scale multiplies
 * (`SCALED_LENGTH_PROPS` in styles.js is these keys), because they are the
 * same question: which values are lengths.
 *
 * `'auto'` and the percentages are what yoga's own setters take, which is the
 * source of truth for the layout half; the paint half — radius, outline,
 * font size, letter spacing — takes pixels only, since the paint reads a
 * number (`borderRadius: '50%'` used to paint square, silently). Border
 * widths refuse a percentage the way CSS's do; yoga's border setter
 * coerced one to a number.
 */
export const LENGTH_FORMS = new Map([
  ['width', PERCENT | AUTO],
  ['height', PERCENT | AUTO],
  ['minWidth', PERCENT],
  ['minHeight', PERCENT],
  ['maxWidth', PERCENT],
  ['maxHeight', PERCENT],
  ['flexBasis', PERCENT | AUTO],
  ['top', PERCENT | AUTO],
  ['right', PERCENT | AUTO],
  ['bottom', PERCENT | AUTO],
  ['left', PERCENT | AUTO],
  ['start', PERCENT | AUTO],
  ['end', PERCENT | AUTO],
  ['margin', PERCENT | AUTO],
  ['marginTop', PERCENT | AUTO],
  ['marginRight', PERCENT | AUTO],
  ['marginBottom', PERCENT | AUTO],
  ['marginLeft', PERCENT | AUTO],
  ['marginStart', PERCENT | AUTO],
  ['marginEnd', PERCENT | AUTO],
  ['padding', PERCENT],
  ['paddingTop', PERCENT],
  ['paddingRight', PERCENT],
  ['paddingBottom', PERCENT],
  ['paddingLeft', PERCENT],
  ['paddingStart', PERCENT],
  ['paddingEnd', PERCENT],
  ['gap', PERCENT],
  ['rowGap', PERCENT],
  ['columnGap', PERCENT],
  ['borderWidth', WIDTH_WORDS],
  ['borderTopWidth', WIDTH_WORDS],
  ['borderRightWidth', WIDTH_WORDS],
  ['borderBottomWidth', WIDTH_WORDS],
  ['borderLeftWidth', WIDTH_WORDS],
  ['borderStartWidth', WIDTH_WORDS],
  ['borderEndWidth', WIDTH_WORDS],
  ['borderRadius', 0],
  ['outlineWidth', WIDTH_WORDS],
  ['outlineOffset', 0],
  ['fontSize', 0],
  ['letterSpacing', 0],
]);

const WIDTHS = { thin: 1, medium: 3, thick: 5 };
/** What a border or an outline with no width of its own is: CSS's `medium`. */
const MEDIUM = WIDTHS.medium;

const NUMBER_AND_UNIT = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i;
/** A string the funnel can hand on as it is: a percentage, or `'auto'`. */
const AS_WRITTEN = /^(?:[+-]?(?:\d+\.?\d*|\.\d+)%|auto)$/;

/** The units CSS has that a react-x11 length does not read yet, named in
 *  the error so it says which one it met rather than "invalid". */
const RELATIVE_UNITS = new Set([
  'em',
  'rem',
  'ex',
  'ch',
  'lh',
  'rlh',
  'vw',
  'vh',
  'vmin',
  'vmax',
  'svw',
  'svh',
  'lvw',
  'lvh',
  'dvw',
  'dvh',
  'cqw',
  'cqh',
  'cqi',
  'cqb',
  'cqmin',
  'cqmax',
]);
const ABSOLUTE_UNITS = new Set(['pt', 'pc', 'in', 'cm', 'mm', 'q']);

const isToken = (v) =>
  typeof v === 'string' && /^\$[A-Za-z_][A-Za-z0-9_-]*$/.test(v);
const mentionsToken = (v) => typeof v === 'string' && v.includes('$');
/** A colour as the grammar reads one: anything ntk parses, and CSS's
 *  `currentColor`, which the paint resolves to the node's ink. */
const isColor = (v) =>
  typeof v === 'string' && (cssColorStraight(v) !== null || isCurrentColor(v));

/** What a line the shorthand gives no colour is drawn in. */
const CURRENT_COLOR = 'currentColor';

/** What a length property takes, said the way the errors say it. */
function expected(forms) {
  const words = ["a number of logical pixels, like 12 or '12px'"];
  if (forms & PERCENT) words.push("a percentage like '50%'");
  if (forms & AUTO) words.push("'auto'");
  if (forms & WIDTH_WORDS) words.push("'thin', 'medium' or 'thick'");
  return words.join(', or ');
}

/**
 * A value that does not read. The message says what was written, why it
 * does not read and what would; `in(where)` puts the place it was written
 * where every other style error has it — `invalid width "2em" in <box
 * style>: …` — once the caller knows the place, which a parser never does.
 */
export class StyleValueError extends Error {
  constructor(key, value, why, expectation) {
    super('');
    this.key = key;
    this.value = value;
    this.why = why;
    this.expectation = expectation;
    this.where = null;
    this.message = this.text();
  }

  text() {
    return (
      `react-x11: invalid ${this.key} ${JSON.stringify(this.value)}` +
      (this.where ? ` in ${this.where}` : '') +
      (this.why ? `: ${this.why}` : '') +
      (this.expectation ? ` (expected ${this.expectation})` : '')
    );
  }

  /** Said of `key` instead: a piece of a shorthand is named after the
   *  property that was written, not the longhand it was read as. */
  as(key) {
    this.key = key;
    this.message = this.text();
    return this;
  }

  in(where) {
    this.where = where;
    this.message = this.text();
    return this;
  }
}

/** Put `where` into an error a reader threw: in its place for one of ours,
 *  and on a line of its own for one from a parser that speaks its own
 *  sentences (a gradient's). */
export function locate(err, where) {
  if (err instanceof StyleValueError) return err.in(where);
  err.message += `\n  in ${where}`;
  return err;
}

const invalid = (key, value, why, forms) =>
  new StyleValueError(key, value, why, expected(forms));

/**
 * One length, as everything downstream reads it: a number of logical pixels,
 * a percentage string, or `'auto'`. Throws naming what was wrong — the unit
 * it does not know, the percentage this property does not take — and
 * `key`'s forms decide which those are.
 *
 * `value` is one value: a property that takes several goes through its
 * shorthand reader, which calls this per piece.
 */
export function readLength(key, value, forms = LENGTH_FORMS.get(key) ?? 0) {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw invalid(key, value, 'it is not a finite number', forms);
  }
  if (typeof value !== 'string') {
    throw invalid(key, value, null, forms);
  }
  const text = value.trim();
  if (forms & AUTO && text === 'auto') return 'auto';
  if (forms & WIDTH_WORDS && Object.hasOwn(WIDTHS, text)) return WIDTHS[text];
  const m = NUMBER_AND_UNIT.exec(text);
  if (!m) {
    if (splitTop(text, false).length > 1) {
      throw invalid(
        key,
        value,
        key === 'borderRadius'
          ? 'a radius per corner is not supported — one radius rounds all four'
          : `${key} takes one value`,
        forms,
      );
    }
    if (/^(?:calc|min|max|clamp)\(/i.test(text)) {
      throw invalid(
        key,
        value,
        `${text.slice(0, text.indexOf('('))}() is not supported — compute ` +
          'the number in JavaScript',
        forms,
      );
    }
    throw invalid(key, value, null, forms);
  }
  const unit = m[2].toLowerCase();
  const n = Number(m[1]);
  if (unit === '' || unit === 'px') return n;
  if (unit === '%') {
    if (forms & PERCENT) return `${m[1]}%`;
    throw invalid(
      key,
      value,
      key === 'borderRadius'
        ? 'a percentage radius is not supported yet — give it in pixels; ' +
            'one larger than the box holds rounds it to half its shorter ' +
            'side, so borderRadius: 9999 is a pill, and a circle on a square'
        : `${key} does not take a percentage`,
      forms,
    );
  }
  if (RELATIVE_UNITS.has(unit)) {
    throw invalid(
      key,
      value,
      `${unit} is not a unit react-x11 resolves yet`,
      forms,
    );
  }
  if (ABSOLUTE_UNITS.has(unit)) {
    throw invalid(
      key,
      value,
      `${unit} is a print unit — lengths here are logical pixels, which the ` +
        'display scale turns into device pixels',
      forms,
    );
  }
  throw invalid(key, value, `"${unit}" is not a unit`, forms);
}

/**
 * `readLength`, or the value as written where it would throw: the funnel's
 * reading. A layout property's applier reads it again and refuses it, which
 * is what reports it — thrown at a commit, dropped and said in a frame
 * (`applyLayoutStyle`) — and a paint property's reader passes over what is
 * not a number, as it always has.
 */
function lengthOrAsWritten(key, value) {
  try {
    return readLength(key, value);
  } catch {
    return value;
  }
}

/** Whether the funnel has to read a length value rather than hand it on. */
const needsReading = (value) =>
  typeof value === 'string' && !AS_WRITTEN.test(value);

const pieces = (value) => splitTop(String(value).trim(), false);

/** Whether a value is several, the way a top-level space separates them. A
 *  hover asks this of every `borderColor`, so a value with no space in it is
 *  answered without the split. */
const SPACE = /\S\s+\S/;
const isSeveral = (value) =>
  typeof value === 'string' && SPACE.test(value) && pieces(value).length > 1;

// ---------------------------------------------------------------------------
// The shorthands.

/** `padding: '8px 16px'` and the rest of CSS's one-to-four rule: top, right,
 *  bottom, left, a missing one taken from the side opposite. */
const EDGE_LISTS = {
  padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  margin: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'],
  inset: ['top', 'right', 'bottom', 'left'],
  borderWidth: [
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
  ],
  borderColor: [
    'borderTopColor',
    'borderRightColor',
    'borderBottomColor',
    'borderLeftColor',
  ],
};

/** The two-value shorthands: the first value and the second, the second
 *  taken from the first when it is left out. `gap` is row then column, as
 *  CSS writes it; the logical pairs are start then end. */
const PAIRS = {
  gap: ['rowGap', 'columnGap'],
  paddingInline: ['paddingStart', 'paddingEnd'],
  paddingBlock: ['paddingTop', 'paddingBottom'],
  marginInline: ['marginStart', 'marginEnd'],
  marginBlock: ['marginTop', 'marginBottom'],
};

/** `border` and its sides: which width and which colour each one sets. */
const LINES = {
  border: ['borderWidth', 'borderColor'],
  borderTop: ['borderTopWidth', 'borderTopColor'],
  borderRight: ['borderRightWidth', 'borderRightColor'],
  borderBottom: ['borderBottomWidth', 'borderBottomColor'],
  borderLeft: ['borderLeftWidth', 'borderLeftColor'],
  borderStart: ['borderStartWidth', 'borderStartColor'],
  borderEnd: ['borderEndWidth', 'borderEndColor'],
};

/** The line styles that paint, and the ones that take the line away. */
export const LINE_STYLES = new Set(['solid', 'dashed']);
const NO_LINE = new Set(['none', 'hidden']);
const UNPAINTED_STYLES = new Set([
  'dotted',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
]);

/**
 * Every shorthand, most specific first: when two write the same longhand,
 * the first one wins (a longhand the style names beats them all). `border`
 * leads because the style it names is the box's — `borderStyle` is one per
 * box, and a side's own style only says something when `border` did not.
 * Then the sides, which beat the four-side lists; then the pairs, which beat
 * them too; then the lists; then the ones that share no longhand with
 * anything.
 */
export const SHORTHAND_ORDER = [
  'border',
  'borderTop',
  'borderRight',
  'borderBottom',
  'borderLeft',
  'borderStart',
  'borderEnd',
  'paddingInline',
  'paddingBlock',
  'marginInline',
  'marginBlock',
  'padding',
  'margin',
  'inset',
  'borderWidth',
  'borderColor',
  'gap',
  'outline',
  'background',
  'flex',
];

/** The names that are only ever a shorthand — no yoga setter, no paint
 *  reads them. A style property in its own right (styles.js `STYLE_PROPS`). */
export const SHORTHAND_PROPS = new Set(
  SHORTHAND_ORDER.filter(
    (key) => !LENGTH_FORMS.has(key) && key !== 'borderColor',
  ),
);

/** …and the ones that are a longhand with one value and a shorthand with
 *  several: `padding: 8` is EDGE_ALL, `padding: '8px 16px'` is four sides. */
const SEVERAL_FORM = new Set([
  'padding',
  'margin',
  'borderWidth',
  'borderColor',
  'gap',
]);

/** Which shorthands set this longhand, nearest first — so a `transition`
 *  written against the shorthand reaches the longhands it expands into
 *  (`transitionFor`). */
export const SHORTHANDS_OF = (() => {
  const of = new Map();
  const add = (longhand, shorthand) => {
    if (!of.has(longhand)) of.set(longhand, []);
    if (!of.get(longhand).includes(shorthand)) of.get(longhand).push(shorthand);
  };
  for (const key of SHORTHAND_ORDER) {
    for (const longhand of longhandsOf(key)) add(longhand, key);
  }
  // `border` reaches a side's width and colour through the four-side
  // longhands it sets, which a side falls back to
  for (const [key, [width, color]] of Object.entries(LINES)) {
    if (key === 'border') continue;
    add(width, 'borderWidth');
    add(width, 'border');
    add(color, 'borderColor');
    add(color, 'border');
  }
  return of;
})();

function longhandsOf(key) {
  if (EDGE_LISTS[key]) return EDGE_LISTS[key];
  if (PAIRS[key]) return PAIRS[key];
  if (LINES[key]) return [...LINES[key], 'borderStyle'];
  switch (key) {
    case 'outline':
      return ['outlineWidth', 'outlineColor'];
    case 'background':
      return ['backgroundColor', 'backgroundImage'];
    case 'flex':
      return ['flexGrow', 'flexShrink', 'flexBasis'];
    default:
      return [];
  }
}

/**
 * Whether `style` holds anything the funnel has to rewrite: a shorthand, or a
 * length written as something other than a number, a percentage or `'auto'`.
 * The question `resolveComputedStyle` asks before allocating anything, so a
 * style written in numbers — nearly every one — costs a walk of its keys.
 */
export function needsExpanding(style) {
  for (const key in style) {
    if (SHORTHAND_PROPS.has(key)) return true;
    const value = style[key];
    if (typeof value !== 'string') continue;
    if (key === 'borderColor') {
      if (isSeveral(value)) return true;
    } else if (LENGTH_FORMS.has(key) && needsReading(value)) return true;
  }
  return false;
}

/**
 * The style with every shorthand expanded into its longhands and every
 * length read into a number: what the layout, the paint and the display
 * scale are handed. Never throws — this runs from a frame as often as from
 * a commit. A length that does not read, alone or as a piece of a list, goes
 * on as written for its longhand's reader to refuse, which is what reports
 * it (`lengthOrAsWritten`); a line, a background or a `flex` that does not
 * read is dropped whole, as CSS drops a declaration it cannot parse, since
 * which of its parts was meant is not something to guess. Development has
 * said so where the style was written either way.
 */
export function expandStyle(style) {
  const out = {};
  let found = null;
  for (const key of Object.keys(style)) {
    const value = style[key];
    if (
      SHORTHAND_PROPS.has(key) ||
      (SEVERAL_FORM.has(key) && isSeveral(value))
    ) {
      (found ??= new Set()).add(key);
      continue;
    }
    if (LENGTH_FORMS.has(key) && needsReading(value)) {
      out[key] = lengthOrAsWritten(key, value);
      continue;
    }
    out[key] = value;
  }
  if (found === null) return out;
  let implied = null;
  for (const key of SHORTHAND_ORDER) {
    if (!found.has(key)) continue;
    let longhands;
    try {
      longhands = readShorthand(key, style[key], false);
    } catch {
      continue;
    }
    const colorKey = impliedColorKey(key, longhands);
    if (colorKey !== null) (implied ??= []).push(colorKey);
    for (const longhand of Object.keys(longhands)) {
      const value = longhands[longhand];
      if (value !== undefined && out[longhand] == null) out[longhand] = value;
    }
  }
  // A line that named no colour is drawn in `currentColor` — after every
  // other shorthand has had its say, since it is the weakest thing in the
  // style: a colour named for that side anywhere, a side falling back to
  // `borderColor` included, is the one the line takes.
  for (const colorKey of implied ?? []) {
    if (out[colorKey] != null) continue;
    if (colorKey !== 'outlineColor' && out.borderColor != null) continue;
    out[colorKey] = CURRENT_COLOR;
  }
  return out;
}

/**
 * The colour key a line left to `currentColor`, or null: a border, a side
 * or an outline that drew a line and named no colour for it. `none`, or a
 * width of 0, draws no line and needs none.
 */
function impliedColorKey(key, longhands) {
  const [widthKey, colorKey] =
    key === 'outline' ? ['outlineWidth', 'outlineColor'] : (LINES[key] ?? []);
  if (colorKey === undefined || !(colorKey in longhands)) return null;
  if (longhands[colorKey] !== undefined || longhands[widthKey] === 0) {
    return null;
  }
  return colorKey;
}

/**
 * One shorthand's longhands, or a throw naming what did not read. A
 * longhand the value left out is absent from the result.
 *
 * `lenient` is development's reading of a value whose `$token`s have not
 * resolved yet: a token stands for one value of whatever kind the slot
 * wants, and nothing is returned for it.
 */
export function expandShorthand(key, value, lenient = false) {
  const longhands = readShorthand(key, value, lenient);
  // a token may be the colour a lenient reading skipped, so only a value
  // read whole says a line has none
  const colorKey = lenient ? null : impliedColorKey(key, longhands);
  if (colorKey !== null) longhands[colorKey] = CURRENT_COLOR;
  return longhands;
}

/** …as written: a line's colour left out is left out, for the funnel to
 *  weigh against the rest of the style (`expandStyle`). */
function readShorthand(key, value, lenient) {
  if (value == null || value === '') return {};
  if (EDGE_LISTS[key]) return readEdges(key, value, lenient);
  if (PAIRS[key]) return readPair(key, value, lenient);
  if (LINES[key]) return readLine(key, value, lenient);
  switch (key) {
    case 'outline':
      return readOutline(value, lenient);
    case 'background':
      return readBackground(value, lenient);
    case 'flex':
      return readFlex(value, lenient);
    default:
      throw new Error(`react-x11: ${key} is not a shorthand`);
  }
}

/** Development's check of a shorthand as written: the same reading as the
 *  funnel's, tokens standing in for whatever they will resolve to. */
export function checkShorthand(key, value) {
  expandShorthand(key, value, true);
}

/** Whether `key` is read by `checkShorthand` for this value — every
 *  shorthand, and a several-value longhand written with several. */
export const isShorthandValue = (key, value) =>
  SHORTHAND_PROPS.has(key) || (SEVERAL_FORM.has(key) && isSeveral(value));

/** One piece of an edge list or a pair: a length of the longhand's kind, or
 *  for `borderColor`, a colour. */
function readPiece(shorthand, longhand, piece, lenient) {
  if (lenient && mentionsToken(piece)) return undefined;
  if (shorthand === 'borderColor') {
    if (isColor(piece) || !lenient) return piece;
    throw new StyleValueError(
      'borderColor',
      piece,
      null,
      "a CSS colour per side — 'red', '#2980b9 transparent', or a $token",
    );
  }
  try {
    return readLength(longhand, piece);
  } catch (err) {
    // In the funnel the piece goes on as written — one a `$token` resolved
    // to — for the longhand's own reader to refuse, which is what reports
    // it; in development it is named after the property that was written.
    if (!lenient) return piece;
    throw err instanceof StyleValueError ? err.as(shorthand) : err;
  }
}

function readEdges(key, value, lenient) {
  const sides = EDGE_LISTS[key];
  const list = typeof value === 'number' ? [value] : pieces(value);
  if (list.length > 4) {
    throw new StyleValueError(
      key,
      value,
      `${list.length} values, where CSS takes one to four — top, right, ` +
        'bottom, left',
    );
  }
  const read = list.map((piece, i) =>
    readPiece(key, sides[i] ?? sides[0], piece, lenient),
  );
  // CSS's rule: a missing side is the one opposite it
  const [top, right = top, bottom = top, left = right] = read;
  return {
    [sides[0]]: top,
    [sides[1]]: right,
    [sides[2]]: bottom,
    [sides[3]]: left,
  };
}

function readPair(key, value, lenient) {
  const [first, second] = PAIRS[key];
  const list = typeof value === 'number' ? [value] : pieces(value);
  if (list.length > 2) {
    throw new StyleValueError(
      key,
      value,
      `${list.length} values, where it takes one or two — ${first}, then ` +
        second,
    );
  }
  const a = readPiece(key, first, list[0], lenient);
  const b = list.length > 1 ? readPiece(key, second, list[1], lenient) : a;
  return { [first]: a, [second]: b };
}

/**
 * A line — `border`, a side, an `outline` — as its width, its style and its
 * colour, each at most once and in any order: `'1px solid $border'`,
 * `'dashed red 2px'`, `'none'`. A number is the width.
 */
function readParts(key, value, lenient) {
  const parts = {
    width: undefined,
    style: undefined,
    color: undefined,
    none: false,
  };
  const bad = (why) =>
    new StyleValueError(
      key,
      value,
      why,
      "a width, a style and a colour in any order — '1px solid #d0d0d0', " +
        "'2px dashed $accent' — or 'none'",
    );
  if (typeof value === 'number') {
    parts.width = readLength(`${key} width`, value, WIDTH_WORDS);
    if (parts.width < 0) throw bad('a width cannot be negative');
    return parts;
  }
  if (typeof value !== 'string') throw bad('it is not a line');
  const list = pieces(value);
  if (list.length > 3)
    throw bad(`${list.length} values, where it takes three at most`);
  for (const piece of list) {
    const word = piece.toLowerCase();
    if (lenient && mentionsToken(piece)) continue;
    if (
      NO_LINE.has(word) ||
      LINE_STYLES.has(word) ||
      UNPAINTED_STYLES.has(word)
    ) {
      if (parts.style !== undefined || parts.none)
        throw bad('it names two styles');
      if (NO_LINE.has(word)) parts.none = true;
      else if (UNPAINTED_STYLES.has(word)) {
        throw bad(`${word} lines are not drawn here — solid and dashed are`);
      } else parts.style = word;
      continue;
    }
    if (Object.hasOwn(WIDTHS, word) || NUMBER_AND_UNIT.test(piece)) {
      if (parts.width !== undefined) throw bad('it names two widths');
      parts.width = readLength(`${key} width`, piece, WIDTH_WORDS);
      if (parts.width < 0) throw bad('a width cannot be negative');
      continue;
    }
    if (isColor(piece)) {
      if (parts.color !== undefined) throw bad('it names two colours');
      parts.color = piece;
      continue;
    }
    throw bad(`"${piece}" is neither a width, a line style nor a colour`);
  }
  return parts;
}

function readLine(key, value, lenient) {
  const [widthKey, colorKey] = LINES[key];
  const parts = readParts(key, value, lenient);
  if (parts.none) return { [widthKey]: 0 };
  return {
    [widthKey]: parts.width ?? MEDIUM,
    [colorKey]: parts.color,
    borderStyle: parts.style,
  };
}

function readOutline(value, lenient) {
  const parts = readParts('outline', value, lenient);
  if (parts.none) return { outlineWidth: 0 };
  if (parts.style === 'dashed') {
    throw new StyleValueError(
      'outline',
      value,
      "an outline is drawn solid — leave the style out, or write 'solid'",
    );
  }
  return { outlineWidth: parts.width ?? MEDIUM, outlineColor: parts.color };
}

/**
 * `background`: a colour, a gradient, or both — the two things a box paints
 * behind itself. Everything else CSS's `background` says (a `url()`, a size,
 * a repeat, a second layer) is something a box does not paint, and says so.
 */
function readBackground(value, lenient) {
  const bad = (why) =>
    new StyleValueError(
      'background',
      value,
      why,
      "a colour, a linear-gradient(…), both, or 'none'",
    );
  if (typeof value !== 'string') throw bad('it is not a colour');
  if (splitTop(value, true).length > 1) {
    throw bad('a box paints one layer — one gradient over one colour');
  }
  let color;
  let image;
  for (const piece of pieces(value)) {
    if (lenient && isToken(piece)) continue;
    const word = piece.toLowerCase();
    if (word === 'none') {
      if (image !== undefined) throw bad('it names two images');
      image = 'none';
      continue;
    }
    if (/^[a-z-]*gradient\(/.test(word)) {
      if (image !== undefined) throw bad('it names two images');
      // Its own parser, and its own message — a radial gradient is a
      // `<canvas onDraw>`, a stop that is not a colour names the stop. In
      // development only: the paint parses what it is handed, and drops a
      // gradient that does not parse, so the funnel need not do it twice.
      if (lenient && !mentionsToken(piece)) parseLinearGradient(piece);
      image = piece;
      continue;
    }
    if (word.startsWith('url(')) {
      throw bad('an image is an <image src> element here, not a background');
    }
    if (isColor(piece)) {
      if (color !== undefined) throw bad('it names two colours');
      color = piece;
      continue;
    }
    throw bad(`"${piece}" is neither a colour nor a gradient`);
  }
  // `none` takes the colour away with the image, as it does in CSS — the
  // way a `:hover` block says "no fill here"
  if (image === 'none' && color === undefined) color = 'transparent';
  return { backgroundColor: color, backgroundImage: image };
}

const FLEX_KEYWORDS = {
  none: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
  auto: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto' },
  initial: { flexGrow: 0, flexShrink: 1, flexBasis: 'auto' },
};

const FACTOR = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * CSS's `flex`. A number is `flex: <grow> 1 0` — "take this share of what is
 * left, from a base size of nothing" — which is what `flex: 1` means
 * everywhere it is written; the keywords are CSS's own. The rest is CSS's
 * grammar: one or two unitless factors (grow, then shrink) and a basis that
 * is a length or `auto`, before them or after: `'1 1 0'`, `'2 200px'`,
 * `'0 0 auto'`, `'240px'`.
 */
function readFlex(value, lenient) {
  const bad = (why) =>
    new StyleValueError(
      'flex',
      value,
      why,
      'a number — flex: 1 is flexGrow: 1, flexShrink: 1, flexBasis: 0 — ' +
        "'auto', 'none', or CSS's '<grow> <shrink> <basis>', like '1 1 0' " +
        "or '0 0 240px'",
    );
  if (typeof value === 'number') {
    if (!(Number.isFinite(value) && value >= 0)) {
      throw bad('a grow factor cannot be negative');
    }
    return { flexGrow: value, flexShrink: 1, flexBasis: 0 };
  }
  if (typeof value !== 'string') throw bad('it is not a number');
  const text = value.trim();
  if (Object.hasOwn(FLEX_KEYWORDS, text)) return { ...FLEX_KEYWORDS[text] };
  const list = pieces(text);
  if (list.length > 3)
    throw bad(`${list.length} values, where it takes three at most`);
  const factors = [];
  let basis;
  let basisAt = -1;
  for (let i = 0; i < list.length; i++) {
    const piece = list[i];
    if (lenient && mentionsToken(piece)) {
      factors.push(undefined);
      continue;
    }
    // a unitless zero is a factor unless both factors came before it, which
    // is the one place CSS reads it as the basis
    if (FACTOR.test(piece) && !(factors.length === 2 && basisAt === -1)) {
      const n = Number(piece);
      if (n < 0) throw bad('a factor cannot be negative');
      factors.push(n);
      continue;
    }
    if (basisAt !== -1) throw bad('it names two bases');
    // a word that is no length at all is a flex value nobody wrote — `'fill'`
    // — and is said of `flex`; a length in a unit the grammar does not read
    // is said of the basis, naming the unit
    if (piece !== 'auto' && !NUMBER_AND_UNIT.test(piece)) {
      throw bad(`"${piece}" is neither a factor nor a basis`);
    }
    basis = readLength('flex basis', piece, LENGTH_FORMS.get('flexBasis'));
    basisAt = i;
  }
  if (factors.length > 2) throw bad('it names three factors');
  // a basis between the two factors is not CSS's grammar
  if (basisAt === 1 && factors.length === 2)
    throw bad('the basis splits the factors');
  const [grow, shrink] = factors;
  return {
    flexGrow: grow ?? (lenient ? undefined : 1),
    flexShrink: shrink ?? (lenient && factors.length > 1 ? undefined : 1),
    // CSS: a basis left out of a shorthand that names a factor is 0
    flexBasis: basis ?? (factors.length > 0 ? 0 : undefined),
  };
}

// ---------------------------------------------------------------------------
// Whole-style checks: what no single value can be wrong about on its own.

/** Every block of a style a value can sit in: the style itself, and its
 *  state and query blocks, one level down. */
function* blocksOf(style) {
  yield style;
  for (const key of Object.keys(style)) {
    const c = key.charCodeAt(0);
    if ((c === 58 /* : */ || c === 64) /* @ */ && style[key]) yield style[key];
  }
}

/**
 * What development says about a style's borders taken together, or null: a
 * box has one `borderStyle`, so two shorthands naming different ones cannot
 * both be drawn.
 */
export function borderProblem(style) {
  for (const block of blocksOf(style)) {
    // one block is one box's style at one moment; two blocks are two
    // moments, which may draw the line two ways
    let styleKey = null;
    let lineStyle = null;
    for (const key of Object.keys(LINES)) {
      const value = block[key];
      if (typeof value !== 'string') continue;
      let parts;
      try {
        parts = readParts(key, value, true);
      } catch {
        continue; // its own check names it
      }
      if (parts.none || parts.style === undefined) continue;
      if (
        lineStyle !== null &&
        parts.style !== lineStyle &&
        block.borderStyle == null
      ) {
        return (
          `react-x11: ${styleKey} and ${key} name different line styles ` +
          `("${lineStyle}" and "${parts.style}"), and a box has one ` +
          'borderStyle — say which with borderStyle, or draw the side that ' +
          'differs as a box of its own'
        );
      }
      styleKey ??= key;
      lineStyle ??= parts.style;
    }
  }
  return null;
}
