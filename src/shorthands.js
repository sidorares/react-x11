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
//   Two exceptions, both CSS's: a border or an outline with no width is
//   `medium`, 3px — a border with no width draws nothing here, where CSS
//   would draw one — and `none` is a width of 0, the way `border: none` and
//   `outline: none` are written to take one away.
import { cssColorStraight } from 'ntk/color';

import { parseLinearGradient, splitTop } from './decorations.js';

/** What a length property takes besides pixels. */
const PERCENT = 1;
const AUTO = 2;
/** CSS's `thin`, `medium` and `thick`: a line's width only. */
const WIDTH_WORDS = 4;
/** `fontSize`'s percentage, which is CSS's: of the size it inherits — the
 *  same thing `em` means there — and so a number, never a string. */
const OF_FONT = 8;

/**
 * Every style property that is a distance on the screen, and what each takes
 * besides pixels. The same set the display scale multiplies
 * (`SCALED_LENGTH_PROPS` in styles.js is these keys), because they are the
 * same question: which values are lengths.
 *
 * `'auto'` and the percentages are what yoga's own setters take, which is the
 * source of truth for the layout half. Of the paint half, a radius takes a
 * percentage too — of the box's shorter side, read where the corner is drawn
 * (`radiusOf` in styles.js), since a corner here is a circle and CSS's
 * elliptical one is not drawn — and the rest take lengths only. Border widths
 * refuse a percentage the way CSS's do; yoga's border setter coerced one to a
 * number.
 *
 * Every one of them takes the relative units as well (`RELATIVE`).
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
  ['borderRadius', PERCENT],
  ['outlineWidth', WIDTH_WORDS],
  ['outlineOffset', 0],
  ['fontSize', OF_FONT],
  ['letterSpacing', 0],
]);

const WIDTHS = { thin: 1, medium: 3, thick: 5 };
/** What a border or an outline with no width of its own is: CSS's `medium`. */
const MEDIUM = WIDTHS.medium;

const NUMBER_AND_UNIT = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i;
/** A string the funnel can hand on as it is: a percentage, or `'auto'`. */
const AS_WRITTEN = /^(?:[+-]?(?:\d+\.?\d*|\.\d+)%|auto)$/;
const FUNCTION = /^(calc|min|max|clamp)\(/i;

/**
 * What a relative length is relative to, as the bits a node records so that
 * it resolves the length again when that moves (nodes/styling.js):
 *
 * - `UNIT_EM` — a font size. `em` is this node's own, and on `fontSize`
 *   itself the one it inherits, as in CSS; it moves when an ancestor's size
 *   does, which the text cascade already walks (`_retext`).
 * - `UNIT_REM` — the palette's `fontSize`, which is the root font size an
 *   app here has: the size every label that names none is set in. It moves
 *   when the theme does (`_themeChanged`).
 * - `UNIT_VIEWPORT` — the window the node is in: the `<window>`, or the
 *   `<popup>`, the same one a `'@width >= 600'` block asks about, in the
 *   same logical pixels. It moves on a resize, through the same registry.
 */
export const UNIT_EM = 1;
export const UNIT_REM = 2;
export const UNIT_VIEWPORT = 4;

/** Each relative unit, as what one of it is in logical pixels. On a desktop
 *  the small, large and dynamic viewports are the one window. */
const RELATIVE = {
  em: (ctx, key) => (key === 'fontSize' ? ctx.parentEm : ctx.em),
  rem: (ctx) => ctx.rem,
  vw: (ctx) => ctx.viewport.width / 100,
  vh: (ctx) => ctx.viewport.height / 100,
  vmin: (ctx) => Math.min(ctx.viewport.width, ctx.viewport.height) / 100,
  vmax: (ctx) => Math.max(ctx.viewport.width, ctx.viewport.height) / 100,
};
for (const prefix of ['s', 'l', 'd']) {
  RELATIVE[`${prefix}vw`] = RELATIVE.vw;
  RELATIVE[`${prefix}vh`] = RELATIVE.vh;
  RELATIVE[`${prefix}vmin`] = RELATIVE.vmin;
  RELATIVE[`${prefix}vmax`] = RELATIVE.vmax;
}

/** The units CSS has that a length here does not read, each with the reason
 *  — so the error says which one it met, and why, rather than "invalid". */
const NOT_READ = {
  ex: "it needs the font's x-height, which nothing measures yet — 0.5em is the usual stand-in",
  ch: "it needs the font's 0 advance, which nothing measures yet — 0.5em is the usual stand-in",
  lh: 'a line height relative to itself is circular here — use em',
  rlh: 'a line height relative to itself is circular here — use rem',
};
for (const unit of ['cqw', 'cqh', 'cqi', 'cqb', 'cqmin', 'cqmax']) {
  NOT_READ[unit] =
    "a container's size is known only after a layout pass, and a length in " +
    'it would lay the tree out again on every frame the container moves — a ' +
    "percentage of the parent, or an '@container' block, says it without that";
}
const PRINT_UNITS = new Set(['pt', 'pc', 'in', 'cm', 'mm', 'q']);

/**
 * A context that resolves every relative unit to 1 and records nothing:
 * development's, which asks whether a value reads, not what it comes to.
 */
export const PROBE = Object.freeze({
  em: 16,
  parentEm: 16,
  rem: 16,
  viewport: Object.freeze({ width: 100, height: 100 }),
  deps: 0,
});

const isToken = (v) =>
  typeof v === 'string' && /^\$[A-Za-z_][A-Za-z0-9_-]*$/.test(v);
const mentionsToken = (v) => typeof v === 'string' && v.includes('$');
const isColor = (v) => typeof v === 'string' && cssColorStraight(v) !== null;

/** What a length property takes, said the way the errors say it. */
function expected(forms) {
  const words = ["a number of logical pixels, like 12 or '12px'"];
  if (forms & PERCENT) words.push("a percentage like '50%'");
  if (forms & OF_FONT)
    words.push("a percentage of the inherited size, like '120%'");
  if (forms & AUTO) words.push("'auto'");
  if (forms & WIDTH_WORDS) words.push("'thin', 'medium' or 'thick'");
  words.push('em, rem, vw or vh');
  return words.join(', or ');
}

/**
 * A value that does not read. The message says what was written, why it
 * does not read and what would; `in(where)` puts the place it was written
 * where every other style error has it — `invalid width "2ex" in <box
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
 * it does not read, the percentage this property does not take — and `key`'s
 * forms decide which those are.
 *
 * A relative unit — `em`, `rem`, `vw` and the rest — and `calc()`, `min()`,
 * `max()` and `clamp()` over them are resolved against `ctx`: the node's
 * font sizes and its window, in logical pixels, each read recording the
 * dependency on `ctx.deps`. Without one there is nothing to resolve against,
 * and a relative length is an error: a style reaches the layout through the
 * funnel, which always has its node, so one that arrives unresolved is a
 * path that skipped it. Development reads with `PROBE`.
 *
 * `value` is one value: a property that takes several goes through its
 * shorthand reader, which calls this per piece.
 */
export function readLength(
  key,
  value,
  forms = LENGTH_FORMS.get(key) ?? 0,
  ctx = null,
) {
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
  if (FUNCTION.test(text)) return readExpression(key, value, forms, ctx);
  const m = NUMBER_AND_UNIT.exec(text);
  if (!m) {
    const fn = /^([a-z-]+)\(/i.exec(text);
    if (fn) {
      throw invalid(
        key,
        value,
        `${fn[1]}() is not read — calc, min, max and clamp are`,
        forms,
      );
    }
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
    throw invalid(key, value, null, forms);
  }
  return unitValue(key, value, Number(m[1]), m[2].toLowerCase(), forms, ctx);
}

/** A number with its unit, resolved: the one place a unit means anything. */
function unitValue(key, value, n, unit, forms, ctx) {
  if (unit === '' || unit === 'px') return n;
  if (unit === '%') {
    if (forms & OF_FONT)
      return (n * relative('em', key, value, forms, ctx)) / 100;
    if (forms & PERCENT) return `${n}%`;
    throw invalid(key, value, `${key} does not take a percentage`, forms);
  }
  if (Object.hasOwn(RELATIVE, unit)) {
    return n * relative(unit, key, value, forms, ctx);
  }
  if (Object.hasOwn(NOT_READ, unit)) {
    throw invalid(key, value, `${unit} is not read — ${NOT_READ[unit]}`, forms);
  }
  if (PRINT_UNITS.has(unit)) {
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

/** What one of `unit` is, in logical pixels, here. */
function relative(unit, key, value, forms, ctx) {
  if (ctx === null) {
    throw invalid(
      key,
      value,
      `${unit} is resolved for the node it is written on, and this value ` +
        'reached the layout without being resolved',
      forms,
    );
  }
  const one = RELATIVE[unit](ctx, key);
  if (!Number.isFinite(one)) {
    throw invalid(
      key,
      value,
      `there is no ${unit} to resolve it against`,
      forms,
    );
  }
  return one;
}

// ---------------------------------------------------------------------------
// calc(), min(), max(), clamp().
//
// Resolved where the style is, to one number: every term that is a length
// here becomes logical pixels against the node's context, which is what lets
// `clamp(14px, 1rem + 0.5vw, 20px)` — fluid type — mean something without a
// layout pass. A percentage is the exception, because yoga takes one unit per
// value and what a percentage is of is decided inside the layout: an
// expression of percentages alone stays one (`calc(100% / 3)` is `'33.3…%'`),
// and one that mixes a percentage with a length is an error that says so,
// since `calc(100% - 16px)` cannot be handed to yoga as anything.

/** A value in an expression: a length in pixels, a percentage, or a bare
 *  number — which a length property reads as pixels, as everywhere here. */
const LEN = 1;
const PCT = 2;
const NUM = 3;

function tokenize(text) {
  const tokens = [];
  const re =
    /\s*(?:([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)|([a-z-]+)\(|([()+\-*/,]))/giy;
  let at = 0;
  while (at < text.length) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) {
      if (/^\s*$/.test(text.slice(at))) break;
      return null;
    }
    // a sign belongs to the number only where an operand is expected — after
    // an operator, an opening parenthesis or a comma, or at the start
    if (m[1] !== undefined && /^[+-]/.test(m[1])) {
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'value' || prev.op === ')')) {
        tokens.push({ type: 'op', op: m[1][0] });
        at = re.lastIndex - m[0].length + m[0].indexOf(m[1]) + 1;
        continue;
      }
    }
    if (m[1] !== undefined) {
      tokens.push({ type: 'value', n: Number(m[1]), unit: m[2].toLowerCase() });
    } else if (m[3] !== undefined) {
      tokens.push({ type: 'fn', name: m[3].toLowerCase() });
    } else {
      tokens.push({ type: 'op', op: m[4] });
    }
    at = re.lastIndex;
  }
  return tokens;
}

function readExpression(key, value, forms, ctx) {
  const bad = (why) => invalid(key, value, why, forms);
  const tokens = tokenize(value.trim());
  if (!tokens) throw bad('it is not an expression this reads');
  let i = 0;
  const peek = () => tokens[i];
  const take = (op) => {
    const t = tokens[i];
    if (!t || t.type !== 'op' || t.op !== op) {
      throw bad(`expected "${op}"${t ? '' : ' before the end'}`);
    }
    i++;
  };
  const mixed = () =>
    bad(
      'it mixes a percentage with a length, and yoga takes one unit per ' +
        'value — what a percentage is of is decided inside the layout. ' +
        "Pad a '100%' box rather than subtracting from it, or give the room " +
        'to flexGrow',
    );
  // a bare number is pixels where it meets a length, as everywhere here
  const unify = (a, b) => {
    if (a.kind === b.kind) return a.kind;
    if (a.kind === PCT || b.kind === PCT) throw mixed();
    return LEN;
  };
  const operand = (t) => {
    if (t.unit === '') return { kind: NUM, v: t.n };
    if (t.unit === '%' && !(forms & OF_FONT)) {
      if (!(forms & PERCENT)) {
        throw bad(`${key} does not take a percentage`);
      }
      return { kind: PCT, v: t.n };
    }
    return { kind: LEN, v: unitValue(key, value, t.n, t.unit, forms, ctx) };
  };
  const call = (name) => {
    const args = [sum()];
    while (peek()?.op === ',') {
      i++;
      args.push(sum());
    }
    take(')');
    if (name === 'calc') {
      if (args.length !== 1) throw bad('calc() takes one expression');
      return args[0];
    }
    if (name === 'clamp' && args.length !== 3) {
      throw bad('clamp() takes a minimum, a preferred value and a maximum');
    }
    if (args.length < 1) throw bad(`${name}() takes at least one value`);
    let kind = args[0].kind;
    for (const arg of args) kind = unify({ kind }, arg);
    const vs = args.map((a) => a.v);
    if (name === 'min') return { kind, v: Math.min(...vs) };
    if (name === 'max') return { kind, v: Math.max(...vs) };
    return { kind, v: Math.max(vs[0], Math.min(vs[1], vs[2])) };
  };
  const factor = () => {
    const t = tokens[i++];
    if (!t) throw bad('it ends where a value was expected');
    if (t.type === 'value') return operand(t);
    if (t.type === 'fn') {
      if (!['calc', 'min', 'max', 'clamp'].includes(t.name)) {
        throw bad(`${t.name}() is not read — calc, min, max and clamp are`);
      }
      return call(t.name);
    }
    if (t.op === '(') {
      const inner = sum();
      take(')');
      return inner;
    }
    throw bad(`"${t.op}" where a value was expected`);
  };
  const product = () => {
    let a = factor();
    while (peek()?.op === '*' || peek()?.op === '/') {
      const op = tokens[i++].op;
      const b = factor();
      if (op === '*') {
        if (a.kind !== NUM && b.kind !== NUM) {
          throw bad('one side of a multiplication has to be a plain number');
        }
        a = { kind: a.kind === NUM ? b.kind : a.kind, v: a.v * b.v };
      } else {
        if (b.kind !== NUM) throw bad('a division is by a plain number');
        if (b.v === 0) throw bad('it divides by zero');
        a = { kind: a.kind, v: a.v / b.v };
      }
    }
    return a;
  };
  const sum = () => {
    let a = product();
    while (peek()?.op === '+' || peek()?.op === '-') {
      const op = tokens[i++].op;
      const b = product();
      a = { kind: unify(a, b), v: op === '+' ? a.v + b.v : a.v - b.v };
    }
    return a;
  };
  const result = factor();
  if (i !== tokens.length) throw bad('there is more after the expression');
  if (!Number.isFinite(result.v)) throw bad('it does not come to a number');
  if (result.kind === PCT) return `${Math.round(result.v * 1e4) / 1e4}%`;
  return result.v;
}

// ---------------------------------------------------------------------------
// lineHeight: a multiple of the font's own line height, written any way CSS
// writes one.

const MULTIPLE = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?\s*$/i;

/**
 * A `lineHeight` as the multiple the text engines take, or undefined for
 * `'normal'` — the font's own. CSS's forms all come to one: `1.5`, `'1.5'`,
 * `'1.5em'` and `'150%'` are the multiple as written, and an absolute length
 * — `'24px'`, `'1.5rem'`, a `calc()` — is divided by the node's own font size
 * (`ctx.em`), the one size the multiple is applied to, which is what makes a
 * design's "16 on 24" the line it asks for.
 */
export function readLineHeight(value, ctx = null) {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= 0) return value;
    throw new StyleValueError(
      'lineHeight',
      value,
      'it is not a multiple',
      LINE_HEIGHT,
    );
  }
  if (typeof value !== 'string') {
    throw new StyleValueError('lineHeight', value, null, LINE_HEIGHT);
  }
  const text = value.trim();
  if (text === 'normal') return undefined;
  if (MULTIPLE.test(text)) return readLineHeight(Number(text), ctx);
  const m = NUMBER_AND_UNIT.exec(text);
  if (m && m[2].toLowerCase() === 'em')
    return readLineHeight(Number(m[1]), ctx);
  if (m && m[2] === '%') return readLineHeight(Number(m[1]) / 100, ctx);
  let px;
  try {
    px = readLength('lineHeight', value, 0, ctx);
  } catch (err) {
    throw err instanceof StyleValueError
      ? new StyleValueError('lineHeight', value, err.why, LINE_HEIGHT)
      : err;
  }
  if (ctx === null) {
    throw new StyleValueError(
      'lineHeight',
      value,
      'a line height in pixels is resolved against the font size of the ' +
        'node it is written on',
      LINE_HEIGHT,
    );
  }
  return readLineHeight(px / ctx.em, ctx);
}

const LINE_HEIGHT =
  "a multiple of the font's own line height — 1.5, '150%', '1.5em' — a " +
  "length like '24px' or '1.5rem', or 'normal'";

/** Whether the funnel has to read a `lineHeight` rather than hand it on. */
const lineHeightNeedsReading = (value) =>
  typeof value === 'string' && !MULTIPLE.test(value);

/**
 * `readLength`, or the value as written where it would throw: the funnel's
 * reading. A layout property's applier reads it again and refuses it, which
 * is what reports it — thrown at a commit, dropped and said in a frame
 * (`applyLayoutStyle`) — and a paint property's reader passes over what is
 * not a number, as it always has.
 */
function lengthOrAsWritten(key, value, ctx) {
  try {
    return readLength(key, value, undefined, ctx);
  } catch {
    return value;
  }
}

/** Whether the funnel has to read a length value rather than hand it on: a
 *  percentage goes on as it is, except on `fontSize`, where it is the
 *  inherited size's and comes to a number. */
const needsReading = (key, value) =>
  typeof value === 'string' &&
  (!AS_WRITTEN.test(value) || LENGTH_FORMS.get(key) & OF_FONT) &&
  value !== 'auto';

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
    } else if (key === 'lineHeight') {
      if (lineHeightNeedsReading(value)) return true;
    } else if (LENGTH_FORMS.has(key) && needsReading(key, value)) return true;
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
export function expandStyle(style, ctx = null) {
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
    if (LENGTH_FORMS.has(key) && needsReading(key, value)) {
      out[key] = lengthOrAsWritten(key, value, ctx);
      continue;
    }
    if (key === 'lineHeight' && lineHeightNeedsReading(value)) {
      // one that does not read goes on as written, and the text inherits
      // past it, as it always did with a value it could not use
      try {
        out[key] = readLineHeight(value, ctx);
      } catch {
        out[key] = value;
      }
      continue;
    }
    out[key] = value;
  }
  if (found === null) return out;
  for (const key of SHORTHAND_ORDER) {
    if (!found.has(key)) continue;
    let longhands;
    try {
      longhands = expandShorthand(key, style[key], ctx);
    } catch {
      continue;
    }
    for (const longhand of Object.keys(longhands)) {
      const value = longhands[longhand];
      if (value !== undefined && out[longhand] == null) out[longhand] = value;
    }
  }
  return out;
}

/**
 * One shorthand's longhands, or a throw naming what did not read. A
 * longhand the value left out is absent from the result.
 *
 * `lenient` is development's reading of a value whose `$token`s have not
 * resolved yet: a token stands for one value of whatever kind the slot
 * wants, and nothing is returned for it.
 */
export function expandShorthand(key, value, ctx = null, lenient = false) {
  if (value == null || value === '') return {};
  if (EDGE_LISTS[key]) return readEdges(key, value, ctx, lenient);
  if (PAIRS[key]) return readPair(key, value, ctx, lenient);
  if (LINES[key]) return readLine(key, value, ctx, lenient);
  switch (key) {
    case 'outline':
      return readOutline(value, ctx, lenient);
    case 'background':
      return readBackground(value, lenient);
    case 'flex':
      return readFlex(value, ctx, lenient);
    default:
      throw new Error(`react-x11: ${key} is not a shorthand`);
  }
}

/** Development's check of a shorthand as written: the same reading as the
 *  funnel's, tokens standing in for whatever they will resolve to. */
export function checkShorthand(key, value) {
  expandShorthand(key, value, PROBE, true);
}

/** Whether `key` is read by `checkShorthand` for this value — every
 *  shorthand, and a several-value longhand written with several. */
export const isShorthandValue = (key, value) =>
  SHORTHAND_PROPS.has(key) || (SEVERAL_FORM.has(key) && isSeveral(value));

/** One piece of an edge list or a pair: a length of the longhand's kind, or
 *  for `borderColor`, a colour. */
function readPiece(shorthand, longhand, piece, ctx, lenient) {
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
    return readLength(longhand, piece, undefined, ctx);
  } catch (err) {
    // In the funnel the piece goes on as written — one a `$token` resolved
    // to — for the longhand's own reader to refuse, which is what reports
    // it; in development it is named after the property that was written.
    if (!lenient) return piece;
    throw err instanceof StyleValueError ? err.as(shorthand) : err;
  }
}

function readEdges(key, value, ctx, lenient) {
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
    readPiece(key, sides[i] ?? sides[0], piece, ctx, lenient),
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

function readPair(key, value, ctx, lenient) {
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
  const a = readPiece(key, first, list[0], ctx, lenient);
  const b = list.length > 1 ? readPiece(key, second, list[1], ctx, lenient) : a;
  return { [first]: a, [second]: b };
}

/**
 * A line — `border`, a side, an `outline` — as its width, its style and its
 * colour, each at most once and in any order: `'1px solid $border'`,
 * `'dashed red 2px'`, `'none'`. A number is the width.
 */
function readParts(key, value, ctx, lenient) {
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
    parts.width = readLength(`${key} width`, value, WIDTH_WORDS, ctx);
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
    if (
      Object.hasOwn(WIDTHS, word) ||
      NUMBER_AND_UNIT.test(piece) ||
      FUNCTION.test(piece)
    ) {
      if (parts.width !== undefined) throw bad('it names two widths');
      parts.width = readLength(`${key} width`, piece, WIDTH_WORDS, ctx);
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

function readLine(key, value, ctx, lenient) {
  const [widthKey, colorKey] = LINES[key];
  const parts = readParts(key, value, ctx, lenient);
  if (parts.none) return { [widthKey]: 0 };
  return {
    [widthKey]: parts.width ?? MEDIUM,
    [colorKey]: parts.color,
    borderStyle: parts.style,
  };
}

function readOutline(value, ctx, lenient) {
  const parts = readParts('outline', value, ctx, lenient);
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
function readFlex(value, ctx, lenient) {
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
    if (
      piece !== 'auto' &&
      !NUMBER_AND_UNIT.test(piece) &&
      !FUNCTION.test(piece)
    ) {
      throw bad(`"${piece}" is neither a factor nor a basis`);
    }
    basis = readLength('flex basis', piece, LENGTH_FORMS.get('flexBasis'), ctx);
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

const BORDER_COLOR_KEYS = [
  'borderColor',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
  'borderStartColor',
  'borderEndColor',
];

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
 * What development says about a style's borders taken together, or null:
 *
 * - a border that names no colour anywhere in the style paints nothing here —
 *   there is no `currentColor` yet, and a box's `borderColor` has no default;
 * - a box has one `borderStyle`, so two shorthands naming different ones
 *   cannot both be drawn.
 */
export function borderProblem(style) {
  let colorless = null;
  let hasColor = false;
  for (const block of blocksOf(style)) {
    for (const key of BORDER_COLOR_KEYS) {
      if (block[key] != null && block[key] !== '') hasColor = true;
    }
    // one block is one box's style at one moment; two blocks are two
    // moments, which may draw the line two ways
    let styleKey = null;
    let lineStyle = null;
    for (const key of Object.keys(LINES)) {
      const value = block[key];
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      let parts;
      try {
        parts = readParts(key, value, PROBE, true);
      } catch {
        continue; // its own check names it
      }
      if (parts.none) continue;
      if (parts.color !== undefined || mentionsToken(value)) hasColor = true;
      else if (parts.width !== 0) colorless ??= [key, value];
      if (parts.style === undefined) continue;
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
  if (colorless && !hasColor) {
    const [key, value] = colorless;
    return (
      `react-x11: ${key} ${JSON.stringify(value)} names no colour, and would ` +
      "paint nothing — there is no currentColor here yet, and a border's " +
      `colour has no default. Name one: ${key}: '${
        typeof value === 'number' ? `${value}px` : value
      } $border'`
    );
  }
  return null;
}
