// Layout algorithms and positions from outside the renderer — the two seams
// docs/architecture/custom-layout.md is the design record for.
//
// A **layout** arranges a box's children. It is asked how big the box is for
// the room on offer, and then where each child goes in the room the box got.
// It runs inside the pass that lays the window out — each child is a yoga
// tree of its own, and the box is a measured leaf in its parent's — so what it
// decides is on screen in the frame that asked. Nothing React-side can get
// there: `onLayout` hears about a pass after it painted, and a
// `useLayoutEffect` runs before the pass it would need to read.
//
// A **position** is CSS's positioning scheme, opened up: a node laid out in
// flow and then moved, by an offset its scheme works out from what the pass
// produced, resizing nothing. `sticky` is exactly that, and is written here
// against the same context a registered position is handed — which is what
// keeps the seam honest: the built-in one is expressed with it, so the next
// one can be. The insets are the scheme's to read (thresholds, for sticky),
// never offsets.
//
// Both are looked up by name from a style property (`layout`, `position`),
// so a container query block can swap one in the frame its container crosses
// a threshold. Both are plain data, so this module needs nothing from
// src/nodes/ — the node side is there, next to the pass it runs in.

/** name -> definition, insertion-ordered: the order an error lists them in. */
const layouts = new Map();
const positions = new Map();

// The re-registration rule registry.js has for elements (issue #318): under
// an active hot-reload session a duplicate is the previous version of the
// same module, and replaces silently. registry.js owns the flag — it is the
// one the refresh loader flips — and forwards it here.
let hotReloadSession = false;

/** @internal — forwarded by registry.js's `markHotReloadSession`. */
export function markLayoutsHotReloadSession(active = true) {
  hotReloadSession = active;
}

const BUILTIN = Symbol('react-x11 built-in');

const NAME = /^[A-Za-z_][\w-]*$/;

function checkName(name, fn) {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new Error(
      `react-x11: ${fn}(${JSON.stringify(name)}) — a name is letters, ` +
        "digits, '_' and '-', not starting with a digit, the way a style " +
        "writes it: layout: 'masonry'.",
    );
  }
}

function checkDuplicate(table, name, fn, definition, key) {
  const existing = table.get(name);
  if (!existing || definition.override) return;
  // the same function arriving twice is one definition evaluated twice, and
  // never a conflict; under hot reload any duplicate is the module's own
  if (existing[key] === definition[key] || hotReloadSession) return;
  throw new Error(
    `react-x11: ${fn}("${name}") — "${name}" is already registered` +
      (existing.builtin ? ', and is built in' : '') +
      '. Pass { override: true } if replacing it is deliberate. (Under hot ' +
      'reload a module re-registering its own replaces it silently; this ' +
      'means two different definitions collided outside any reload.)',
  );
}

// --- options ------------------------------------------------------------------

/**
 * What an option may be. A `length` is written in logical pixels, like every
 * length in a style, and handed to the algorithm in device pixels — the unit
 * its constraints and its children's sizes are in — so an algorithm never
 * multiplies by the scale itself and never forgets to (docs/scale.md).
 */
const OPTION_TYPES = [
  'length',
  'number',
  'integer',
  'boolean',
  'string',
  'any',
];

const EMPTY_SCHEMA = Object.freeze({});

function fits(type, value) {
  if (Array.isArray(type)) return type.includes(value);
  switch (type) {
    case 'length':
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    default:
      return true;
  }
}

const describeType = (type) =>
  Array.isArray(type)
    ? `one of ${type.map((v) => JSON.stringify(v)).join(', ')}`
    : type === 'integer'
      ? 'an integer'
      : type === 'any'
        ? 'anything'
        : `a ${type}`;

function checkSchema(schema, what) {
  if (schema === undefined) return EMPTY_SCHEMA;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(
      `react-x11: ${what} — options are declared as an object, ` +
        "{ gap: { type: 'length', default: 8 } }.",
    );
  }
  for (const key of Object.keys(schema)) {
    if (key === 'name') {
      throw new Error(
        `react-x11: ${what} declares an option called "name" — that key is ` +
          'the style naming the algorithm, and cannot be an option too.',
      );
    }
    const spec = schema[key];
    const type = spec?.type;
    const ok = Array.isArray(type)
      ? type.length > 0
      : OPTION_TYPES.includes(type);
    if (!ok) {
      throw new Error(
        `react-x11: ${what} option "${key}" has type ${JSON.stringify(type)} ` +
          `— expected one of ${OPTION_TYPES.map((t) => `'${t}'`).join(', ')}, ` +
          'or an array of the values it may take.',
      );
    }
    if (spec.default != null && !fits(type, spec.default)) {
      throw new Error(
        `react-x11: ${what} option "${key}" defaults to ` +
          `${JSON.stringify(spec.default)}, which is not ${describeType(type)}.`,
      );
    }
  }
  return schema;
}

/**
 * The options a style wrote, against the schema that declared them: every
 * declared one present (its default when left out), lengths in device
 * pixels. A value of the wrong type takes the default and is described in
 * `problem`, for the caller to report the way a bad `$token` is reported —
 * one style property is not worth the whole GUI.
 */
export function resolveOptions(schema, raw, scale, where) {
  const options = {};
  let problem = null;
  for (const key of Object.keys(schema)) {
    const spec = schema[key];
    let value = raw?.[key];
    if (value == null) value = spec.default;
    else if (!fits(spec.type, value)) {
      problem ??=
        `react-x11: ${where} — option "${key}" is ${JSON.stringify(value)}, ` +
        `where it takes ${describeType(spec.type)}`;
      value = spec.default;
    }
    if (spec.type === 'length' && typeof value === 'number') value *= scale;
    options[key] = value;
  }
  if (raw) {
    for (const key of Object.keys(raw)) {
      if (key === 'name' || Object.hasOwn(schema, key)) continue;
      const names = Object.keys(schema).map((n) => `"${n}"`);
      problem ??=
        `react-x11: ${where} — unknown option "${key}" (` +
        (names.length ? `it takes ${names.join(', ')}` : 'it takes none') +
        ')';
    }
  }
  return { options, problem };
}

// --- what a style asks for ----------------------------------------------------

/**
 * A `layout` or `position` value, read: the name, the definition it names
 * (null when nothing by that name is registered) and the options written
 * beside it. A string is a name with nothing else to say.
 */
function request(value, table) {
  if (value == null || value === false) return null;
  const raw = typeof value === 'object' ? value : null;
  const name = raw ? raw.name : value;
  return { name, def: table.get(name) ?? null, raw };
}

/** The layout a resolved style asks its node to arrange its children with. */
export const layoutOf = (style) => request(style.layout, layouts);

/** CSS's own positions, which yoga lays out — and the one CSS has that this
 *  renderer does not (`fixed`), kept out of the registry so it cannot come
 *  to mean something else. `sticky` is the built-in placed one. */
const CSS_POSITIONS = ['static', 'relative', 'absolute', 'fixed', 'sticky'];

/**
 * Whether a style's `position` is placed after layout rather than by it —
 * `sticky`, or anything registered. The cheap test the style funnel and the
 * paint order run on every node.
 */
export const isPlaced = (style) => {
  const p = style.position;
  return p != null && p !== 'static' && p !== 'relative' && p !== 'absolute';
};

/** The placed position a resolved style asks for, or null for one yoga
 *  lays out by itself. */
export function positionOf(style) {
  if (!isPlaced(style)) return null;
  if (style.position === 'sticky') return STICKY_REQUEST;
  return request(style.position, positions);
}

const quoted = (names) => names.map((n) => JSON.stringify(n)).join(', ');

export function unknownLayoutMessage(name) {
  return (
    `react-x11: layout ${JSON.stringify(name)} is not registered ` +
    `(registered: ${quoted([...layouts.keys()])}) — registerLayout() from ` +
    'react-x11/host, before the tree that uses it renders. See ' +
    'docs/extending.md, "A layout algorithm of your own"'
  );
}

export function unknownPositionMessage(name) {
  if (name === 'fixed') {
    return (
      "react-x11: position: 'fixed' is not supported — a <popup> is a " +
      "window of its own, above this one; or position: 'absolute' inside a " +
      'box that fills the window'
    );
  }
  const known = [...positions.keys()];
  return (
    `react-x11: position ${JSON.stringify(name)} is neither CSS's ` +
    "('static', 'relative', 'absolute', 'sticky') nor registered" +
    (known.length ? ` (registered: ${quoted(known)})` : '') +
    ' — registerPosition() from react-x11/host, before the tree that uses ' +
    'it renders. See docs/extending.md, "A position of your own"'
  );
}

// --- registration -------------------------------------------------------------

/**
 * Teach react-x11 a layout algorithm, for any box to use with
 * `style={{ layout: name }}` (docs/extending.md, "A layout algorithm of your
 * own").
 *
 * `layout(children, constraints, options, info)` answers two questions with
 * one function: how big the box's content is for `constraints` — asked
 * several times per pass, at sizes nothing is drawn at — and, when both
 * modes are `'exactly'`, where each child goes, as one rect per child. It
 * must be a pure function of its arguments.
 */
export function registerLayout(name, definition) {
  checkName(name, 'registerLayout');
  if (!definition || typeof definition.layout !== 'function') {
    throw new Error(
      `react-x11: registerLayout("${name}") needs a layout(children, ` +
        'constraints, options, info) function that returns { width, height, ' +
        'children }.',
    );
  }
  checkDuplicate(layouts, name, 'registerLayout', definition, 'layout');
  layouts.set(
    name,
    Object.freeze({
      name,
      layout: definition.layout,
      options: checkSchema(definition.options, `layout "${name}"`),
      childOptions: checkSchema(
        definition.childOptions,
        `layout "${name}"'s childOptions`,
      ),
      builtin: definition[BUILTIN] === true,
    }),
  );
}

/** Undo a registration; true if there was one. The built-in layouts stay. */
export function unregisterLayout(name) {
  if (layouts.get(name)?.builtin) return false;
  return layouts.delete(name);
}

/** Registered layout names, the built-in ones first. */
export function registeredLayouts() {
  return [...layouts.keys()];
}

/** The definition registered under `name`, or undefined. */
export function layoutDefinition(name) {
  return layouts.get(name);
}

/**
 * Teach react-x11 a positioning scheme, for any node to use with
 * `style={{ position: name }}` (docs/extending.md, "A position of your own").
 *
 * The node is laid out in flow, as `relative` is, and then
 * `place(node, context)` runs — after every layout pass, the pass a scroll
 * runs included — returning how far to move it from where layout put it,
 * `{ x, y }` in device pixels, or null to leave it there. It may not resize
 * anything, which is what makes it safe to run that often.
 */
export function registerPosition(name, definition) {
  checkName(name, 'registerPosition');
  if (CSS_POSITIONS.includes(name)) {
    throw new Error(
      `react-x11: registerPosition("${name}") — "${name}" is one of CSS's ` +
        'own positions, and not a name a registered one can take.',
    );
  }
  if (!definition || typeof definition.place !== 'function') {
    throw new Error(
      `react-x11: registerPosition("${name}") needs a place(node, context) ` +
        'function that returns the offset { x, y } to move the node by, or ' +
        'null to leave it where layout put it.',
    );
  }
  checkDuplicate(positions, name, 'registerPosition', definition, 'place');
  positions.set(
    name,
    Object.freeze({
      name,
      place: definition.place,
      options: checkSchema(definition.options, `position "${name}"`),
    }),
  );
}

/** Undo a registration; true if there was one. */
export function unregisterPosition(name) {
  return positions.delete(name);
}

/** Registered position names, in registration order. */
export function registeredPositions() {
  return [...positions.keys()];
}

// --- what an algorithm returns ------------------------------------------------

const isExtent = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

const describe = (v) =>
  v === undefined
    ? 'undefined'
    : typeof v === 'object' && v !== null
      ? JSON.stringify(v)
      : String(v);

/**
 * Check what a layout answered, so a mistake is named where it was made —
 * left to itself a `NaN` spreads through every ancestor's rect, and a
 * missing rect puts a child at the window origin with nothing saying why.
 * The rects are only required of the final call, the one that places.
 */
export function checkLayoutResult(result, count, final, name) {
  if (result === null || typeof result !== 'object') {
    throw new TypeError(
      `layout "${name}" returned ${describe(result)} — it must return ` +
        '{ width, height, children }',
    );
  }
  if (!isExtent(result.width) || !isExtent(result.height)) {
    throw new TypeError(
      `layout "${name}" returned { width: ${describe(result.width)}, ` +
        `height: ${describe(result.height)} } — both have to be finite ` +
        'numbers, 0 or more',
    );
  }
  if (!final) return result;
  const rects = result.children;
  if (!Array.isArray(rects) || rects.length !== count) {
    throw new TypeError(
      `layout "${name}" has to return one rect per child when it places ` +
        `(${count} children), and returned ` +
        (Array.isArray(rects) ? `${rects.length}` : describe(rects)),
    );
  }
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (
      !r ||
      !Number.isFinite(r.x) ||
      !Number.isFinite(r.y) ||
      (r.width != null && !isExtent(r.width)) ||
      (r.height != null && !isExtent(r.height))
    ) {
      throw new TypeError(
        `layout "${name}" placed child ${i} at ${describe(r)} — a rect is ` +
          '{ x, y } with an optional width and height, all finite',
      );
    }
  }
  return result;
}

// --- position: 'sticky' -------------------------------------------------------

/**
 * A sticky inset as a distance in device pixels, or null for an edge that
 * does not stick. Numbers arrive already scaled (styles.js,
 * `scaleResolvedStyle`); a percentage is of `size`, the pane's scrollport
 * along that axis, which is CSS's rule for a sticky inset. `'auto'` and
 * anything else leave the edge free, as `auto` does in CSS.
 */
function stickyInset(value, size) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.endsWith('%')) {
    const percent = Number.parseFloat(value);
    return Number.isFinite(percent) ? (percent / 100) * size : null;
  }
  return null;
}

/**
 * CSS's sticky offset, per axis. An edge with an inset may not cross the
 * pane's matching edge moved in by that inset, so the node is pushed back
 * inside — but never so far that its margin box leaves its parent's content
 * box, which is what carries a section's header off with the section. Where
 * both edges of an axis stick, the top and left pushes are applied last and
 * win, as in Blink.
 *
 * The pane's edges are its scrollport, inside the border and over the
 * padding: the band the content scrolls through. With no pane above, the
 * node stays where layout put it — `overflow: 'hidden'` clips without being
 * one, which is CSS's `clip` rather than its `hidden`.
 */
function placeSticky(node, { laidOut, pane, container, margin, direction }) {
  if (!pane) return null;
  const style = node.style;
  const port = pane.scrollport;
  const portWidth = port.right - port.left;
  const portHeight = port.bottom - port.top;
  // yoga's precedence, which the inset appliers use too: the logical edge
  // wins over the physical one it lands on
  const rtl = direction === 'rtl';
  const leftInset = rtl
    ? (style.end ?? style.left)
    : (style.start ?? style.left);
  const rightInset = rtl
    ? (style.start ?? style.right)
    : (style.end ?? style.right);
  const top = stickyInset(style.top, portHeight);
  const bottom = stickyInset(style.bottom, portHeight);
  const left = stickyInset(leftInset, portWidth);
  const right = stickyInset(rightInset, portWidth);
  if (top === null && bottom === null && left === null && right === null) {
    return null;
  }
  // the margin box has to stay inside the container
  const box = {
    left: container.left + margin.left,
    top: container.top + margin.top,
    right: container.right - margin.right,
    bottom: container.bottom - margin.bottom,
  };
  const { x: atX, y: atY, width, height } = laidOut;
  let x = 0;
  let y = 0;
  if (right !== null) {
    const push = Math.min(0, port.right - right - (atX + width));
    x += Math.max(push, Math.min(0, box.left - atX));
  }
  if (left !== null) {
    const push = Math.max(0, port.left + left - atX);
    x += Math.min(push, Math.max(0, box.right - (atX + width)));
  }
  if (bottom !== null) {
    const push = Math.min(0, port.bottom - bottom - (atY + height));
    y += Math.max(push, Math.min(0, box.top - atY));
  }
  if (top !== null) {
    const push = Math.max(0, port.top + top - atY);
    y += Math.min(push, Math.max(0, box.bottom - (atY + height)));
  }
  return { x, y };
}

const STICKY = Object.freeze({
  name: 'sticky',
  place: placeSticky,
  options: EMPTY_SCHEMA,
});
const STICKY_REQUEST = Object.freeze({
  name: 'sticky',
  def: STICKY,
  raw: null,
});

// --- the built-in layouts -----------------------------------------------------

/**
 * `masonry`: columns, each child dropped into whichever is shortest so far —
 * the layout a photo wall or a board of notes of different heights wants,
 * and one flexbox cannot write: a wrapping row lines its items up in rows,
 * and a wrapping column needs a height to wrap at.
 *
 * The number of columns is `columns`, or as many `columnWidth`-wide columns
 * as the width fits; they share the width equally. Gaps come from the box's
 * own `columnGap` / `rowGap` / `gap`, the properties a flex box spaces its
 * children with. A child's `layoutItem: { span }` lays it across that many
 * columns. Heights are the children's own at the column width.
 */
function masonry(children, c, { columns, columnWidth }, { style }) {
  const colGap = style.columnGap ?? style.gap ?? 0;
  const rowGap = style.rowGap ?? style.gap ?? 0;
  let cols;
  let colW;
  if (c.widthMode === 'unconstrained') {
    cols = Math.max(1, columns ?? 1);
    colW = columnWidth;
  } else {
    cols =
      columns != null
        ? Math.max(1, columns)
        : Math.max(1, Math.floor((c.width + colGap) / (columnWidth + colGap)));
    colW = Math.max(0, (c.width - colGap * (cols - 1)) / cols);
    if (c.widthMode === 'at-most') {
      // The question the content floors ask (`at-most 0`): a column is never
      // narrower than the widest thing it has to hold.
      for (const child of children) {
        colW = Math.max(colW, child.intrinsicSizes().minContentWidth);
      }
    }
  }
  const tops = new Array(cols).fill(0);
  const rects = [];
  for (const child of children) {
    const span = Math.min(cols, Math.max(1, child.options.span ?? 1));
    // the run of `span` columns whose tallest is shortest, leftmost on a tie
    let best = 0;
    let bestTop = Infinity;
    for (let j = 0; j + span <= cols; j++) {
      let top = 0;
      for (let k = j; k < j + span; k++) top = Math.max(top, tops[k]);
      if (top < bestTop) {
        bestTop = top;
        best = j;
      }
    }
    const width = colW * span + colGap * (span - 1);
    const { height } = child.measure({ width });
    rects.push({ x: best * (colW + colGap), y: bestTop, width });
    for (let k = best; k < best + span; k++) {
      tops[k] = bestTop + height + rowGap;
    }
  }
  const height = rects.length ? Math.max(...tops) - rowGap : 0;
  return {
    width:
      c.widthMode === 'exactly' ? c.width : cols * colW + colGap * (cols - 1),
    height: c.heightMode === 'exactly' ? c.height : Math.max(0, height),
    children: rects,
  };
}

/**
 * `equal-row`: a row whose children are all as wide as the widest of them —
 * a dialog's buttons, a segmented control. Flexbox can make siblings equal
 * only by dividing a width it was given (`flex: 1`); a row that takes its
 * size from its content, which is what a row of buttons at the end of a
 * dialog is, has no width to divide.
 *
 * Squeezed below that, the cells shrink together, down to the widest
 * child's min-content width and no further. Spacing and alignment are the
 * box's own `columnGap`/`gap`, `justifyContent` and `alignItems`, which mean
 * what they mean on a flex row: `alignItems` defaults to `'stretch'`, so the
 * buttons are one height too.
 */
function equalRow(children, c, _options, { style }) {
  const gap = style.columnGap ?? style.gap ?? 0;
  const n = children.length;
  if (n === 0) {
    return {
      width: c.widthMode === 'exactly' ? c.width : 0,
      height: c.heightMode === 'exactly' ? c.height : 0,
      children: [],
    };
  }
  const gaps = gap * (n - 1);
  let cell = 0;
  for (const child of children) {
    cell = Math.max(cell, child.intrinsicSizes().maxContentWidth);
  }
  if (c.widthMode !== 'unconstrained') {
    const fit = (c.width - gaps) / n;
    if (fit < cell) {
      let floor = 0;
      for (const child of children) {
        floor = Math.max(floor, child.intrinsicSizes().minContentWidth);
      }
      cell = Math.max(fit, floor);
    }
  }
  const heights = children.map(
    (child) => child.measure({ width: cell }).height,
  );
  const used = cell * n + gaps;
  const width = c.widthMode === 'exactly' ? c.width : used;
  const height =
    c.heightMode === 'exactly' ? c.height : Math.max(0, ...heights);
  const free = Math.max(0, width - used);
  let start = 0;
  let step = cell + gap;
  switch (style.justifyContent) {
    case 'center':
      start = free / 2;
      break;
    case 'flex-end':
      start = free;
      break;
    case 'space-between':
      if (n > 1) step += free / (n - 1);
      break;
    case 'space-around':
      start = free / (2 * n);
      step += free / n;
      break;
    case 'space-evenly':
      start = free / (n + 1);
      step += free / (n + 1);
      break;
    default:
      break;
  }
  const align = style.alignItems ?? 'stretch';
  const rects = children.map((_, i) => {
    const x = start + i * step;
    if (align === 'stretch') return { x, y: 0, width: cell, height };
    const h = heights[i];
    const y =
      align === 'center'
        ? (height - h) / 2
        : align === 'flex-end'
          ? height - h
          : 0;
    return { x, y, width: cell };
  });
  return { width, height, children: rects };
}

registerLayout('masonry', {
  [BUILTIN]: true,
  options: {
    // a fixed number of columns; left out, as many as `columnWidth` fits
    columns: { type: 'integer' },
    // the narrowest a column may be when the count is left to the width
    columnWidth: { type: 'length', default: 240 },
  },
  childOptions: {
    // how many columns this child is laid across
    span: { type: 'integer', default: 1 },
  },
  layout: masonry,
});

registerLayout('equal-row', { [BUILTIN]: true, layout: equalRow });
