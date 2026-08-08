// A WHEN/THEN rule builder — the conditional editor every workflow tool
// grows eventually (expense policies, alert routing, form logic). It is the
// composition test the widget gallery is not: nothing here is a new control,
// it is `Select`, `<textinput>` and `<canvas>` arranged into a recursive tree
// that edits itself.
//
// The three things worth reading it for:
//
//   the rail   — the rounded bracket joining a list of rows is drawn per row
//                into a <canvas> that stretches to that row's height, so
//                nothing has to measure anything: the first row draws an
//                elbow down, the last one an elbow up, the rest a tick. The
//                gap between rows is a negative bottom margin on the rail,
//                which is what makes the line continuous across it.
//   recursion  — <NodeList> renders rules and groups, and a group is a
//                <NodeList>. One component owns the join, the bracket,
//                drag-to-reorder and the add buttons at every depth.
//   the drag    — dragging a row lifts it out of the flow to hang off the
//                pointer, and a dashed landing box takes the slot it would
//                drop into. No X11 drag-and-drop is involved: the row never
//                leaves the window, so this is pointer capture plus a
//                position and a placeholder.
//   the editor follows the field — an enum gets a Select, free text gets a
//                <textinput>, and "Any of" gets the token field, so changing
//                the field on the left changes what the right-hand side is.
//
// Drag a row by its handle to reorder it, click And/Or on the bracket to
// flip the join, and the trash on a row to remove it — a group that loses
// its last condition goes with it.
// Run with: npm run examples:rules  (needs an X server / DISPLAY)
import React, { useRef, useState } from 'react';
import {
  createRoot,
  createStyles,
  Select,
  ThemeProvider,
  useAnchor,
  useAnchorTracking,
  useTheme,
} from '../src/index.js';

// --- palette ---------------------------------------------------------------
//
// Two palettes, and the example says nothing about which is in force:
// `<ThemeProvider value={LIGHT} dark={DARK}>` layers the dark one on when the
// desktop is dark, so this follows the machine the way the widgets do.
//
// Four of the design's colours are the *standard* tokens — `text`, `dim`,
// `border`, `background` — because that is what they are, and naming them
// privately would mean a sheet whose ink and a `Select` whose ink were two
// different decisions that happened to agree. What stays private is what the
// design actually adds: the sheet under the rows, the bracket rail, the
// true/false chips, the drop target.
//
// Everything reads them as `$tokens` rather than as values, which is what
// lets the styles below stay hoisted at module level and still follow the
// desktop — resolution walks the node tree, not React (docs/styling.md).

const LIGHT = {
  // the standard four, which the built-in widgets read too
  background: '#ffffff',
  text: '#18181b',
  dim: '#71717a',
  border: '#e4e4e7',
  // this design's own
  page: '#ffffff',
  row: '#fafafa',
  rowLocked: '#f4f4f5',
  faint: '#a1a1aa',
  rail: '#d4d4d8',
  dropEdge: '#93c5fd',
  dropFill: '#eff6ff',
  trueBg: '#ecfdf3',
  trueText: '#067647',
  falseBg: '#fef3f2',
  falseText: '#b42318',
  // the widget palette: a monochrome accent, because every coloured thing in
  // this sheet means something and a blue button would be the odd one out
  hoverBackground: '#f4f4f5',
  hoverText: '#18181b',
  accent: '#18181b',
  accentHover: '#3f3f46',
  surfaceHover: '#f4f4f5',
  radius: 8,
  radiusSmall: 6,
  fontSize: 14,
  paddingX: 12,
  paddingY: 7,
};

// The same design in the dark scheme rather than a second one: same shapes,
// same roles, the greys walked the other way. Zinc, as the light palette is.
const DARK = {
  background: '#1f1f23',
  text: '#f4f4f5',
  dim: '#a1a1aa',
  border: '#3f3f46',
  page: '#18181b',
  row: '#232327',
  rowLocked: '#26262b',
  faint: '#71717a',
  rail: '#52525b',
  dropEdge: '#3b82f6',
  dropFill: '#1e293b',
  trueBg: '#0c2f1e',
  trueText: '#4ade80',
  falseBg: '#3a1416',
  falseText: '#fca5a5',
  hoverBackground: '#2a2a30',
  hoverText: '#f4f4f5',
  accent: '#f4f4f5',
  accentHover: '#d4d4d8',
  // the accent is the ink here, so what goes *on* it is the page
  accentText: '#18181b',
  surfaceHover: '#2a2a30',
};

/**
 * The palette for the two dropdowns that read as labels rather than as
 * choices — the locked trigger's status, and the branch selector. Only the
 * colours differ, so they are still real menus, just quiet ones.
 *
 * Derived from the palette in force rather than written out twice: it is the
 * same two substitutions in either scheme.
 */
const quietPalette = (theme) => ({
  text: theme.faint,
  background: theme.row,
});

// --- the vocabulary --------------------------------------------------------

const OPS = {
  eq: 'Equal to',
  neq: 'Not equal to',
  anyOf: 'Any of',
  noneOf: 'None of',
  gt: 'Greater than',
  lt: 'Less than',
};

/** Operators whose value is a set, and so want the token field. */
const MULTI = new Set(['anyOf', 'noneOf']);

// `ops` doubles as the operator menu and as the reason a row has no operator
// dropdown at all: a field with one operator says all it has to say with the
// word "is" already between it and its value.
const FIELDS = [
  { value: 'seniority', label: 'Seniority', ops: ['eq', 'neq'] },
  {
    value: 'expenseType',
    label: 'Expense type',
    ops: ['anyOf', 'noneOf', 'eq'],
    options: [
      'Food & drink',
      'Travel',
      'Hotel',
      'Software',
      'Office supplies',
      'Training',
    ],
  },
  {
    value: 'merchant',
    label: 'Merchant',
    ops: ['eq'],
    options: ['Uber', 'Lyft', 'Amazon', 'Delta', 'Marriott'],
  },
  {
    value: 'currency',
    label: 'Currency',
    ops: ['eq', 'neq'],
    options: ['USD', 'EUR', 'GBP', 'AUD', 'JPY'],
  },
  { value: 'amount', label: 'Amount', ops: ['gt', 'lt', 'eq'] },
  { value: 'submittedBy', label: 'Submitted by', ops: ['eq', 'neq'] },
];

const ACTIONS = [
  { value: 'approve', label: 'Auto-approve' },
  {
    value: 'notify',
    label: 'Notify',
    targets: ['The contractor', 'The line manager', 'Finance', 'The submitter'],
  },
  {
    value: 'addTo',
    label: 'Add to',
    targets: ['Monthly expense report', 'Quarterly review', 'The audit log'],
  },
  {
    value: 'review',
    label: 'Assign manual review',
    preposition: 'to',
    targets: ['Line manager', 'Finance', 'The CFO'],
  },
  { value: 'receipt', label: 'Request a receipt' },
  {
    value: 'reject',
    label: 'Reject',
    preposition: 'with',
    targets: ['A policy link', 'A short note'],
  },
];

const STATUSES = ['Submitted', 'Drafted', 'Approved', 'Paid'];

const fieldOf = (value) => FIELDS.find((f) => f.value === value) ?? FIELDS[0];
const actionOf = (value) =>
  ACTIONS.find((a) => a.value === value) ?? ACTIONS[0];

// --- the model -------------------------------------------------------------

let nextId = 1;
const uid = () => `n${nextId++}`;

/** A rule whose operator and value are valid for `fieldValue`, keeping as
 *  much of `prev` as still makes sense after the field changed. */
function ruleFor(fieldValue, prev) {
  const field = fieldOf(fieldValue);
  const op = prev && field.ops.includes(prev.op) ? prev.op : field.ops[0];
  return {
    id: prev?.id ?? uid(),
    kind: 'rule',
    field: fieldValue,
    op,
    ...valueFor(field, op, prev),
  };
}

function valueFor(field, op, prev) {
  if (MULTI.has(op)) {
    // keep whatever of the old selection this field still offers, so
    // flipping "Any of" to "None of" does not clear it
    const kept = (prev?.values ?? []).filter((v) => field.options?.includes(v));
    return { values: kept };
  }
  if (field.options) {
    return {
      value: field.options.includes(prev?.value)
        ? prev.value
        : field.options[0],
    };
  }
  return { value: typeof prev?.value === 'string' ? prev.value : '' };
}

function actionRow(actionValue, prev) {
  const action = actionOf(actionValue);
  const target = action.targets
    ? action.targets.includes(prev?.target)
      ? prev.target
      : action.targets[0]
    : null;
  return { id: prev?.id ?? uid(), kind: 'action', action: actionValue, target };
}

const group = (nodes) => ({ id: uid(), kind: 'group', join: 'or', nodes });

const replaceAt = (list, i, item) => list.map((n, j) => (j === i ? item : n));
const removeAt = (list, i) => list.filter((_, j) => j !== i);

function moveItem(list, from, to) {
  const next = list.slice();
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

// The rule in the screenshot this example was built from.
const INITIAL = {
  status: 'Submitted',
  when: {
    join: 'and',
    nodes: [
      ruleFor('seniority', { value: 'Manager' }),
      group([
        ruleFor('expenseType', {
          op: 'anyOf',
          values: ['Food & drink', 'Travel', 'Hotel'],
        }),
        ruleFor('merchant', { value: 'Uber' }),
        ruleFor('currency', { value: 'USD' }),
      ]),
    ],
  },
  then: {
    yes: {
      join: 'and',
      nodes: [
        actionRow('approve'),
        actionRow('notify', { target: 'The contractor' }),
        actionRow('addTo', { target: 'Monthly expense report' }),
      ],
    },
    no: {
      join: 'and',
      nodes: [actionRow('review', { target: 'Line manager' })],
    },
  },
};

// --- the bracket's geometry ------------------------------------------------

/** `r` along the line from `p` toward `q`, never past `q` itself. */
function along([x, y], [qx, qy], r) {
  const dx = qx - x;
  const dy = qy - y;
  const len = Math.hypot(dx, dy) || 1;
  const d = Math.min(r, len);
  return [x + (dx / len) * d, y + (dy / len) * d];
}

/**
 * `from` to `to` with a rounded corner at `at` — `ctx.arcTo`'s job, except
 * that ntk's arcTo picks the wrong sweep and draws the reflex arc, so every
 * corner comes out as a loop. A quadratic through the corner needs no sweep
 * to get wrong, and at these radii is indistinguishable from the circle.
 */
function elbow(ctx, from, at, to, r) {
  const p = along(at, from, r);
  const q = along(at, to, r);
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(p[0], p[1]);
  ctx.quadraticCurveTo(at[0], at[1], q[0], q[1]);
  ctx.lineTo(to[0], to[1]);
}

// --- icons -----------------------------------------------------------------

// [lucide](https://lucide.dev), drawn through `<svg>` — the elements are JSX
// here, so an icon is its paths and nothing else. What the site hands you
// around those paths is a browser's business and is dropped: `xmlns` and
// `class` mean nothing here, and `width`/`height` are the call site's to
// decide, through `style`.
//
// What is *not* dropped is the paint, and it goes on each element rather
// than on the `<svg>`: SVG says `fill` and `stroke` inherit, but ntk's
// SvgView resolves them per element, so an icon painted only at the root
// comes out as filled black silhouettes. `Icon` applies the shared lucide
// attributes to every child so each one below stays just geometry — and a
// child that wants its own paint still wins, since its props come last.
const LUCIDE = {
  fill: 'none',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

// `currentColor` and the colour in the *style*, rather than a stroke per
// shape: an SVG attribute takes a value, and a `$token` is only resolved in
// the style channel — which is also where a colour has to be for the
// renderer to cache the drawing as coverage and recolour it per node
// (docs/elements.md).
function Icon({ children, color = '$faint', size = 16, style }) {
  return (
    <svg
      viewBox="0 0 24 24"
      style={[{ width: size, height: size, flexShrink: 0, color }, style]}
    >
      {React.Children.map(children, (child) =>
        React.cloneElement(child, {
          ...LUCIDE,
          stroke: 'currentColor',
          ...child.props,
        }),
      )}
    </svg>
  );
}

/** lucide `grip-vertical` — the drag handle. */
const GripIcon = (props) => (
  <Icon {...props}>
    <circle cx={9} cy={5} r={1} />
    <circle cx={9} cy={12} r={1} />
    <circle cx={9} cy={19} r={1} />
    <circle cx={15} cy={5} r={1} />
    <circle cx={15} cy={12} r={1} />
    <circle cx={15} cy={19} r={1} />
  </Icon>
);

/** lucide `trash-2` — remove a row or a group. */
const TrashIcon = (props) => (
  <Icon {...props}>
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </Icon>
);

/** lucide `lock` — the trigger that is not a rule. */
const LockIcon = (props) => (
  <Icon {...props}>
    <rect width={18} height={11} x={3} y={11} rx={2} ry={2} />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </Icon>
);

/** lucide `x` — take a value off the token field. */
const CloseIcon = (props) => (
  <Icon {...props}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Icon>
);

/** lucide `check` — the branch pills. */
const CheckIcon = (props) => (
  <Icon {...props}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

/** lucide `git-branch` — Add rule. */
const BranchIcon = (props) => (
  <Icon {...props}>
    <path d="M15 6a9 9 0 0 0-9 9V3" />
    <circle cx={18} cy={6} r={3} />
    <circle cx={6} cy={18} r={3} />
  </Icon>
);

/** lucide `list-tree` — Add condition. */
const ListTreeIcon = (props) => (
  <Icon {...props}>
    <path d="M8 5h13" />
    <path d="M13 12h8" />
    <path d="M13 19h8" />
    <path d="M3 10a2 2 0 0 0 2 2h3" />
    <path d="M3 5v12a2 2 0 0 0 2 2h3" />
  </Icon>
);

/** lucide `folder` — Add group. */
const FolderIcon = (props) => (
  <Icon {...props}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </Icon>
);

// --- labels ----------------------------------------------------------------

/**
 * A `<text>` measured to its letters rather than to its font's line box, so
 * the padding around every label here is even above and below — see
 * `textBoxTrim` in docs/styling.md for why `lineHeight` cannot do this.
 *
 * It is a component only so the trim cannot be forgotten at a call site; the
 * whole of it is one style property.
 */
function Label({ style, children }) {
  return <text style={[s.trimmed, style]}>{children}</text>;
}

// --- shared pieces ---------------------------------------------------------

const GAP = 8; // between the rows of a list
const RAIL = 34; // the bracket column's width
const RAIL_X = 8.5; // the vertical line inside it, on a half pixel
const JOIN_W = 38; // the And/Or pill, wide enough for either word

const s = createStyles({
  window: { backgroundColor: '$page' },
  // the left padding is the bracket's gutter: a top-level list pulls itself
  // into it so its rows line up with the headers and the trigger above them
  page: { flexGrow: 1, padding: 28, paddingTop: 22, paddingLeft: 28 + RAIL },
  sheet: { gap: 10, maxWidth: 760, width: '100%' },

  // every label in the example is measured to its capitals, so a pill's
  // padding means the same above the letters as below them
  trimmed: { textBoxTrim: 'cap-alphabetic' },

  section: { fontSize: 13, color: '$text', paddingBottom: 2 },
  spacer: { flexGrow: 1 },
  divider: { height: 18 },

  // a list of rows, with the join pill floating over the middle of its rail
  list: { alignItems: 'stretch' },
  listGutter: { marginLeft: -RAIL },
  listItem: { flexDirection: 'row', alignItems: 'stretch' },
  listBody: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  rail: { width: RAIL, flexShrink: 0 },
  joinPill: {
    position: 'absolute',
    // centred on the rail's line rather than hung off the list's left edge.
    // A fixed width is what makes that possible: `left` places an edge, so
    // centring a content-sized box would need a margin of half a width
    // nobody has measured yet
    left: RAIL_X - JOIN_W / 2,
    width: JOIN_W,
    marginTop: -11,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '$border',
    borderRadius: 11,
    backgroundColor: '$background',
    cursor: 'pointer',
    ':hover': { borderColor: '$faint' },
  },
  joinText: { fontSize: 12, color: '$dim' },

  // the grey capsule a rule or an action lives in
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    paddingLeft: 10,
    paddingRight: 10,
    borderRadius: 10,
    backgroundColor: '$row',
    // carried by every row, painted on none of them: the lifted row turns it
    // on, and a border that only appears when held would make the row 2px
    // taller than the landing box standing in for it
    borderWidth: 1,
    borderColor: 'transparent',
  },
  // the row while it is held: off the page rather than in it, which without
  // a shadow to cast is said with the fill and an edge the flow rows lack
  rowLifted: { backgroundColor: '$background', borderColor: '$border' },
  // the wrapping half of a row. `flexBasis: 0` because yoga defaults
  // flexShrink to 0: with `auto`, this takes its content's max-content width
  // as its base, cannot shrink back, and the fields never wrap at all
  fields: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  tick: { width: 16, flexShrink: 0 },
  lifted: {
    position: 'absolute',
    left: RAIL,
    right: 0,
    zIndex: 10,
    // the handle inside still gets the moves: a captured pointer is routed
    // past hit testing, so nothing here needs to be hittable
    pointerEvents: 'none',
  },
  landing: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: '$dropEdge',
    borderRadius: 10,
    backgroundColor: '$dropFill',
  },
  rowLocked: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 8,
    paddingLeft: 12,
    paddingRight: 10,
    borderRadius: 10,
    backgroundColor: '$rowLocked',
  },
  word: { color: '$dim', fontSize: 14 },
  lockedWord: { color: '$dim', fontSize: 14 },

  handle: {
    width: 20,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    cursor: 'move',
  },
  iconButton: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    flexShrink: 0,
    cursor: 'pointer',
    ':hover': { backgroundColor: '$surfaceActive' },
  },

  // a value that is not a menu: free text, in a pill the same shape as one
  input: {
    minWidth: 96,
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 10,
    paddingRight: 10,
    fontSize: 14,
    color: '$text',
    borderWidth: 1,
    borderColor: '$border',
    borderRadius: 8,
    backgroundColor: '$background',
  },

  // the multi-value field, and the removable chips in it
  tokens: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 140,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    minHeight: 34,
    padding: 4,
    paddingLeft: 6,
    paddingRight: 6,
    borderWidth: 1,
    borderColor: '$border',
    borderRadius: 8,
    backgroundColor: '$background',
    cursor: 'pointer',
  },
  tokensOpen: { borderColor: '$faint' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 24,
    paddingLeft: 8,
    paddingRight: 2,
    borderWidth: 1,
    borderColor: '$border',
    borderRadius: 6,
    backgroundColor: '$background',
  },
  chipText: { fontSize: 13, color: '$text' },
  chipClose: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    cursor: 'pointer',
    ':hover': { backgroundColor: '$surfaceActive' },
  },
  placeholder: { fontSize: 13, color: '$faint', paddingLeft: 4 },

  menu: {
    flexGrow: 1,
    flexShrink: 1,
    borderWidth: 1,
    borderColor: '$border',
    borderRadius: 8,
    backgroundColor: '$background',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 28,
    paddingLeft: 6,
    paddingRight: 10,
    borderRadius: 6,
    cursor: 'pointer',
    ':hover': { backgroundColor: '$surfaceHover' },
  },
  menuText: { fontSize: 13, color: '$text' },

  // the group card, and the buttons under every list
  card: {
    padding: 14,
    paddingBottom: 10,
    borderWidth: 1,
    borderColor: '$border',
    borderRadius: 12,
    backgroundColor: '$background',
    gap: 10,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { fontSize: 12, color: '$faint' },

  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 },
  ghost: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 36,
    paddingLeft: 12,
    paddingRight: 14,
    borderWidth: 1,
    borderColor: '$border',
    borderRadius: 8,
    backgroundColor: '$background',
    cursor: 'pointer',
    ':hover': { backgroundColor: '$background', borderColor: '$faint' },
  },
  ghostText: { fontSize: 14, color: '$text' },

  // the two THEN branches
  branch: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    height: 24,
    paddingLeft: 8,
    paddingRight: 10,
    borderRadius: 6,
    marginBottom: 8,
  },
  branchText: { fontSize: 13 },
});

/**
 * The value out of a change event.
 *
 * Every value widget hands its handler an *event* rather than a bare value,
 * so one signature covers the library — `ev.value` alongside `ev.name` and
 * `ev.target`. The rows here only ever want the value, so it is unwrapped
 * once, at the two places a widget reports into this file, rather than at
 * every handler that would otherwise have to remember.
 */
const valueOf = (ev) => (ev?.type === 'change' ? ev.value : ev);

/** The pill every dropdown in a row is: `Select`, shaped to match. */
function Pill({ quiet = false, style, onChange, ...props }) {
  const theme = useTheme();
  const select = (
    <Select
      {...props}
      onChange={(ev) => onChange?.(valueOf(ev))}
      style={[
        {
          flexShrink: 0,
          gap: 6,
          paddingTop: 6,
          paddingBottom: 6,
          paddingLeft: 10,
          paddingRight: 10,
        },
        style,
      ]}
    />
  );
  // the quiet palette is scoped to the one control, not to the tree — and
  // derived from the one in force rather than frozen, so it follows the
  // desktop like everything else
  return quiet ? (
    <ThemeProvider value={quietPalette(theme)}>{select}</ThemeProvider>
  ) : (
    select
  );
}

function GhostButton({ icon: Glyph, label, onPress }) {
  return (
    <box style={s.ghost} focusable onClick={onPress}>
      <Glyph size={18} />
      <Label style={s.ghostText}>{label}</Label>
    </box>
  );
}

function IconButton({ icon: Glyph, onPress }) {
  return (
    <box style={s.iconButton} focusable onClick={onPress}>
      <Glyph />
    </box>
  );
}

// --- the token field -------------------------------------------------------

/**
 * The value editor for "Any of" / "None of": the chosen options as chips
 * with a × each, and a `<popup>` of the rest to add from. The popup is a
 * real override-redirect window anchored under the field, the same way
 * `Select` does it — `useAnchor` is the shared placement.
 */
function TokenField({ options, values, onChange }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const measure = useAnchor(ref);

  const height = Math.min(options.length * 28 + 8, 232);
  const anchorOptions = () => ({ placement: 'bottom', height: height + 2 });
  const close = () => setOpen(false);
  const toggle = () => {
    if (open) return close();
    const rect = measure(anchorOptions());
    if (!rect) return;
    setAnchor(rect);
    setOpen(true);
  };

  // keeps the popup under the field for as long as it is open: a scrolled
  // ancestor, the field's own layout moving it (a neighbouring field
  // wrapping to a second line), or the owner window being nudged by the
  // window manager or a script would otherwise leave it hanging in place.
  // If the field itself scrolls out of view, the popup closes rather than
  // following it there.
  useAnchorTracking(ref, open, anchorOptions, setAnchor, close);

  const set = (next) => onChange(options.filter((o) => next.includes(o)));

  return (
    <box
      ref={ref}
      focusable
      onClick={toggle}
      style={[s.tokens, open && s.tokensOpen]}
    >
      {values.length === 0 && (
        <Label style={s.placeholder}>Choose values…</Label>
      )}
      {values.map((value) => (
        <box key={value} style={s.chip}>
          <Label style={s.chipText}>{value}</Label>
          <box
            style={s.chipClose}
            onClick={(ev) => {
              // the chip sits on the field, whose click opens the menu
              ev.stopPropagation();
              set(values.filter((v) => v !== value));
            }}
          >
            <CloseIcon size={14} />
          </box>
        </box>
      ))}

      {open && anchor && (
        <popup
          x={anchor.x}
          y={anchor.y}
          width={anchor.width}
          height={height + 2}
          grab
          onDismiss={() => setOpen(false)}
          // The window's background is the card's, so the corners the
          // rounding gives up are the only thing left over — and `@supports`
          // decides whether they can be given up at all: with no compositor
          // the window stays filled and the menu is a card on a white
          // rectangle, exactly as it was before.
          transparent
          style={{
            backgroundColor: '$background',
            '@supports transparency': { backgroundColor: 'transparent' },
          }}
        >
          <box style={s.menu}>
            <box style={{ overflow: 'scroll', flexGrow: 1, padding: 4 }}>
              {options.map((option) => {
                const on = values.includes(option);
                return (
                  <box
                    key={option}
                    style={s.menuItem}
                    onClick={() =>
                      set(
                        on
                          ? values.filter((v) => v !== option)
                          : [...values, option],
                      )
                    }
                  >
                    {/* the tick's slot is held whether or not it is on, so
                        the labels do not shuffle as values are picked */}
                    <box style={s.tick}>
                      {on && <CheckIcon color={'$text'} size={16} />}
                    </box>
                    <Label style={s.menuText}>{option}</Label>
                  </box>
                );
              })}
            </box>
          </box>
        </popup>
      )}
    </box>
  );
}

// --- the rail --------------------------------------------------------------

/**
 * One row's slice of the bracket down the left of a list. The canvas
 * stretches to the row it sits beside, so `height / 2` is that row's centre
 * and nothing needs measuring: `first` turns down out of it, `last` turns
 * up into it, the rest run through with a tick.
 *
 * `gapBelow` is the space to the next row. It is a negative bottom margin,
 * so the canvas covers the gap and the line stays unbroken across it — and
 * the row's centre is then `(height - gapBelow) / 2`.
 *
 * A list of one has nothing to join, and draws nothing — but still takes the
 * column, so rows do not step sideways when a second one arrives.
 *
 * `hidden` takes it out of the layout without taking it out of the tree. A
 * lifted row has no place on the bracket, but removing the element would
 * change the shape of its wrapper's children — and React would rebuild the
 * subtree, destroying the node that captured the pointer to start the drag.
 */
function Rail({ position, gapBelow, hidden = false, onElbow }) {
  return (
    <canvas
      style={[
        s.rail,
        gapBelow > 0 && { marginBottom: -gapBelow },
        hidden && { display: 'none' },
      ]}
      onDraw={(ctx, { width, height, node }) => {
        const cy = Math.round((height - gapBelow) / 2) + 0.5;
        onElbow?.(node.abs.y + cy);
        if (position === 'only') return;
        const r = 8;
        // a canvas paints with values, not tokens — `node.theme` is the
        // same palette a `$rail` in a style would have resolved against
        ctx.strokeStyle = node.theme?.rail ?? '#d4d4d8';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (position === 'first') {
          elbow(ctx, [width, cy], [RAIL_X, cy], [RAIL_X, height], r);
        } else if (position === 'last') {
          elbow(ctx, [RAIL_X, 0], [RAIL_X, cy], [width, cy], r);
        } else {
          ctx.moveTo(RAIL_X, 0);
          ctx.lineTo(RAIL_X, height);
          ctx.moveTo(RAIL_X, cy);
          ctx.lineTo(width, cy);
        }
        ctx.stroke();
      }}
    />
  );
}

function JoinPill({ join, onToggle, top }) {
  return (
    <box
      style={[s.joinPill, { top: top ?? '50%' }]}
      focusable
      onClick={onToggle}
    >
      <Label style={s.joinText}>{join === 'and' ? 'And' : 'Or'}</Label>
    </box>
  );
}

// Where the And/Or pill belongs is half way between the bracket's two
// elbows, and `top: 50%` is not that: the bracket runs from the first row's
// centre to the last row's centre, while the list box runs from the first
// row's *top* to the last row's *bottom*. The two midpoints coincide only
// when the end rows are the same height — a 61px rule bracketed against a
// 290px group puts the label 60px below the line it labels, the error being
// `(last - first) / 4`.
//
// Nothing at render time knows those heights; they are what the layout makes
// of the rows' content. Nor does an effect help: on mount every `abs` is
// still zero, and once the frame clock has laid the tree out nothing
// re-renders to look again. So each rail reports its elbow **as it draws** —
// paint is the one moment the geometry is both settled and observable. The
// report is idempotent, so the state converges after one extra frame and
// then stops, and a resize that reflows a row corrects itself the same way.

// --- rows ------------------------------------------------------------------

function RuleRow({ node, onChange }) {
  const field = fieldOf(node.field);
  const multi = MULTI.has(node.op);
  return (
    <>
      <Pill
        options={FIELDS}
        value={node.field}
        onChange={(next) => onChange(ruleFor(next, node))}
      />
      <Label style={s.word}>is</Label>

      {/* a field with one operator says it with "is" and nothing else */}
      {field.ops.length > 1 && (
        <Pill
          options={field.ops.map((op) => ({ value: op, label: OPS[op] }))}
          value={node.op}
          onChange={(op) =>
            onChange({ ...node, op, ...valueFor(field, op, node) })
          }
        />
      )}

      {multi ? (
        <TokenField
          options={field.options}
          values={node.values ?? []}
          onChange={(values) => onChange({ ...node, values })}
        />
      ) : field.options ? (
        <Pill
          options={field.options}
          value={node.value}
          onChange={(value) => onChange({ ...node, value })}
        />
      ) : (
        <textinput
          value={node.value ?? ''}
          placeholder="a value"
          onChange={(ev) => onChange({ ...node, value: valueOf(ev) })}
          style={s.input}
        />
      )}
      {!multi && <box style={s.spacer} />}
    </>
  );
}

function ActionRow({ node, onChange, branch, onBranch }) {
  const action = actionOf(node.action);
  return (
    <>
      {/* only the first row of a branch carries the selector, and changing
          it is what moves the row to the other branch */}
      {branch && (
        <Pill
          quiet
          options={[
            { value: 'yes', label: 'If true' },
            { value: 'no', label: 'If false' },
          ]}
          value={branch}
          onChange={onBranch}
        />
      )}
      <Pill
        options={ACTIONS}
        value={node.action}
        onChange={(next) => onChange(actionRow(next, node))}
      />
      {action.preposition && <Label style={s.word}>{action.preposition}</Label>}
      {action.targets && (
        <Pill
          options={action.targets}
          value={node.target}
          onChange={(target) => onChange({ ...node, target })}
        />
      )}
      <box style={s.spacer} />
    </>
  );
}

// --- the list --------------------------------------------------------------

/** How far the pointer travels before a press on a handle becomes a drag. */
const DRAG_SLOP = 3;

/** Which slot a pointer at `y` inserts into, given each row's band. */
function slotAt(bands, y) {
  for (let i = 0; i < bands.length; i++) {
    if (y < bands[i].top + bands[i].height / 2) return i;
  }
  return bands.length;
}

/**
 * A list of rules or actions, with its bracket, its join, drag-to-reorder
 * and the buttons that grow it. A group in the list is another one of
 * these, which is the whole of the nesting.
 *
 * A drag lifts the row out of the flow — `position: absolute`, so the rows
 * under it close up — and puts a dashed landing box in the slot it would
 * drop into. Three things make that cheap:
 *
 *   the lifted row keeps its key and its place in the child list, and only
 *   its wrapper's style changes, so nothing inside it remounts mid-drag;
 *
 *   the landing box is exactly the height the row had, so the list's total
 *   height never changes and nothing below it moves while you drag;
 *
 *   the slots are read from a snapshot taken when the press landed. Measuring
 *   live would feed the reflow the drag causes back into the answer that
 *   caused it, and the insert point would oscillate between two rows.
 */
function NodeList({
  nodes,
  join,
  onJoin,
  onNodes,
  kind,
  branch,
  onBranch,
  gutter = false,
}) {
  const listRef = useRef(null);
  const rows = useRef([]);
  const elbows = useRef([]);
  const grab = useRef(null);
  const [drag, setDrag] = useState(null);
  const [joinTop, setJoinTop] = useState(null);
  const braced = nodes.length > 1;

  // see the note above Rail: the pill rides the bracket, and only paint
  // knows where the bracket's ends came to rest
  const reportElbow = (slot, y) => {
    if (elbows.current[slot] === y) return;
    elbows.current[slot] = y;
    const ys = elbows.current.filter((v) => typeof v === 'number');
    const list = listRef.current;
    if (ys.length < 2 || !list?.abs) return;
    const next = (ys[0] + ys[ys.length - 1]) / 2 - list.abs.y;
    setJoinTop((cur) =>
      cur != null && Math.abs(cur - next) < 0.5 ? cur : next,
    );
  };

  const startDrag = (index) => (ev) => {
    const row = rows.current[index];
    const list = listRef.current;
    if (!row?.abs || !list?.abs) return;
    ev.capturePointer(); // keep the moves coming once it leaves the handle
    grab.current = {
      index,
      target: index,
      armed: false,
      startY: ev.y,
      // where in the row it was picked up, so it hangs off the pointer
      // where it was grabbed rather than jumping its top under the cursor
      offsetY: ev.y - row.abs.y,
      listTop: list.abs.y,
      height: row.abs.height,
      bands: nodes.map((_, i) => ({
        top: rows.current[i]?.abs.y ?? 0,
        height: rows.current[i]?.abs.height ?? 0,
      })),
    };
  };

  const onDragMove = (ev) => {
    const g = grab.current;
    if (!g) return;
    // a press that never travels is a press: no lift, no landing box
    if (!g.armed && Math.abs(ev.y - g.startY) < DRAG_SLOP) return;
    g.armed = true;
    g.target = slotAt(g.bands, ev.y);
    setDrag({
      index: g.index,
      height: g.height,
      target: g.target,
      top: ev.y - g.offsetY - g.listTop,
    });
  };

  const endDrag = () => {
    const g = grab.current;
    grab.current = null;
    setDrag(null);
    if (!g?.armed) return;
    // the slot is an insert point, and dropping below itself closes the gap
    // the row leaves behind, so the index it lands on is one lower
    const to = g.target > g.index ? g.target - 1 : g.target;
    if (to !== g.index) onNodes(moveItem(nodes, g.index, to));
  };

  const update = (i, node) => onNodes(replaceAt(nodes, i, node));
  // a group is only a group while it holds something
  const remove = (i) => onNodes(removeAt(nodes, i));

  const renderNode = (node, i, lifted) =>
    node.kind === 'group' ? (
      <GroupCard
        node={node}
        onChange={(next) => update(i, next)}
        onRemove={() => remove(i)}
        onDrag={startDrag(i)}
        onDragMove={onDragMove}
        onDragEnd={endDrag}
      />
    ) : (
      // the handle and the trash are rails, not part of the sentence: the
      // row itself does not wrap, and only the fields between them do — or a
      // long enough rule wraps its trash onto a line of its own
      <box style={[s.row, lifted && s.rowLifted]}>
        <box
          style={s.handle}
          onMouseDown={startDrag(i)}
          onMouseMove={onDragMove}
          onMouseUp={endDrag}
        >
          <GripIcon />
        </box>
        <box style={s.fields}>
          {kind === 'action' ? (
            <ActionRow
              node={node}
              onChange={(next) => update(i, next)}
              branch={i === 0 ? branch : null}
              onBranch={onBranch}
            />
          ) : (
            <RuleRow node={node} onChange={(next) => update(i, next)} />
          )}
        </box>
        <IconButton icon={TrashIcon} onPress={() => remove(i)} />
      </box>
    );

  // the children in order, with the landing box spliced in at the slot the
  // drag would drop into. The lifted row stays where it is in the list.
  const entries = [];
  nodes.forEach((node, i) => {
    if (drag?.target === i) entries.push({ key: 'landing', landing: true });
    entries.push({ key: node.id, node, index: i, lifted: drag?.index === i });
  });
  if (drag?.target === nodes.length) {
    entries.push({ key: 'landing', landing: true });
  }

  // the bracket counts flow slots, and the lifted row is not in one — but
  // the landing box that replaced it is, so the count never changes
  const flowCount = entries.length - (drag ? 1 : 0);
  elbows.current.length = flowCount; // drop what a shorter list left behind
  let slot = 0;

  return (
    <box ref={listRef} style={[s.list, gutter && s.listGutter]}>
      {/* every wrapper renders the same two children, lifted or not — see
          Rail's `hidden`: change the shape and React rebuilds the subtree,
          taking the pointer capture that started the drag with it */}
      {entries.map((entry) => {
        const i = entry.lifted ? -1 : slot++;
        const last = !entry.lifted && i === flowCount - 1;
        return (
          <box
            key={entry.key}
            style={[
              s.listItem,
              entry.lifted
                ? [s.lifted, { top: drag.top }]
                : !last && { marginBottom: GAP },
            ]}
          >
            <Rail
              hidden={entry.lifted}
              // by flow slot, not by node — a lifted row is on no bracket,
              // and being `display: none` it never draws to report one
              onElbow={(y) => reportElbow(i, y)}
              gapBelow={last ? 0 : GAP}
              position={
                flowCount < 2
                  ? 'only'
                  : i === 0
                    ? 'first'
                    : last
                      ? 'last'
                      : 'mid'
              }
            />
            <box
              ref={
                entry.landing || entry.lifted
                  ? undefined
                  : (n) => {
                      rows.current[entry.index] = n;
                    }
              }
              style={s.listBody}
            >
              {entry.landing ? (
                <box style={[s.landing, { height: drag.height }]} />
              ) : (
                renderNode(entry.node, entry.index, entry.lifted)
              )}
            </box>
          </box>
        );
      })}

      {braced && (
        <JoinPill
          join={join}
          top={joinTop}
          onToggle={() => onJoin(join === 'and' ? 'or' : 'and')}
        />
      )}
    </box>
  );
}

function GroupCard({
  node,
  onChange,
  onRemove,
  onDrag,
  onDragMove,
  onDragEnd,
}) {
  const count = node.nodes.length;
  return (
    <box style={s.card}>
      <box style={s.cardHead}>
        <box
          style={s.handle}
          onMouseDown={onDrag}
          onMouseMove={onDragMove}
          onMouseUp={onDragEnd}
        >
          <GripIcon />
        </box>
        <Label style={s.cardTitle}>
          Group · {String(count)} condition{count === 1 ? '' : 's'}
        </Label>
        <box style={s.spacer} />
        <IconButton icon={TrashIcon} onPress={onRemove} />
      </box>

      <NodeList
        nodes={node.nodes}
        join={node.join}
        onJoin={(join) => onChange({ ...node, join })}
        // the group goes with its last condition — an empty one has no
        // meaning and nothing to click
        onNodes={(nodes) =>
          nodes.length ? onChange({ ...node, nodes }) : onRemove()
        }
      />

      <box style={s.buttons}>
        <GhostButton
          icon={ListTreeIcon}
          label="Add condition"
          onPress={() =>
            onChange({ ...node, nodes: [...node.nodes, ruleFor('amount')] })
          }
        />
      </box>
    </box>
  );
}

// --- the sections ----------------------------------------------------------

function ListButtons({ onNodes, nodes, kind }) {
  return (
    <box style={s.buttons}>
      <GhostButton
        icon={BranchIcon}
        label="Add rule"
        onPress={() =>
          onNodes([
            ...nodes,
            kind === 'action' ? actionRow('notify') : ruleFor('amount'),
          ])
        }
      />
      <GhostButton
        icon={FolderIcon}
        label="Add group"
        onPress={() =>
          onNodes([...nodes, group([ruleFor('merchant'), ruleFor('amount')])])
        }
      />
    </box>
  );
}

function Branch({ tone, label }) {
  const colors =
    tone === 'yes'
      ? { backgroundColor: '$trueBg', color: '$trueText' }
      : { backgroundColor: '$falseBg', color: '$falseText' };
  return (
    <box style={[s.branch, { backgroundColor: colors.backgroundColor }]}>
      <CheckIcon color={colors.color} size={14} />
      <Label style={[s.branchText, { color: colors.color }]}>{label}</Label>
    </box>
  );
}

/** The builder itself, without a window round it. */
export function RulesPanel() {
  const [rule, setRule] = useState(INITIAL);
  const { when, then } = rule;

  const setWhen = (next) =>
    setRule((r) => ({ ...r, when: { ...r.when, ...next } }));
  const setBranch = (which, next) =>
    setRule((r) => ({
      ...r,
      then: { ...r.then, [which]: { ...r.then[which], ...next } },
    }));

  /** The branch selector on a branch's first row moves that row across. */
  const moveRow = (which) => (to) => {
    if (to === which) return;
    setRule((r) => {
      const [head, ...rest] = r.then[which].nodes;
      if (!head) return r;
      return {
        ...r,
        then: {
          ...r.then,
          [which]: { ...r.then[which], nodes: rest },
          [to]: { ...r.then[to], nodes: [...r.then[to].nodes, head] },
        },
      };
    });
  };

  // The palette wraps the panel rather than the window, so the panel still
  // looks like itself wherever it is dropped — `App` puts a second provider
  // above the window, which is the only way the *window's* own background
  // can read a token this palette defines.
  return (
    <ThemeProvider value={LIGHT} dark={DARK}>
      <box style={[s.page, { overflow: 'scroll' }]}>
        <box style={s.sheet}>
          <Label style={s.section}>WHEN</Label>

          {/* the trigger: not a rule, so it has no handle, no trash and no
              place on the bracket — only its status is editable */}
          <box style={s.rowLocked}>
            <LockIcon />
            <Label style={s.lockedWord}>Expense status is</Label>
            <Pill
              quiet
              options={STATUSES}
              value={rule.status}
              onChange={(status) => setRule((r) => ({ ...r, status }))}
            />
            <box style={s.spacer} />
          </box>
          <box style={{ height: GAP }} />

          <NodeList
            gutter
            nodes={when.nodes}
            join={when.join}
            onJoin={(join) => setWhen({ join })}
            onNodes={(nodes) => setWhen({ nodes })}
          />
          <ListButtons
            nodes={when.nodes}
            onNodes={(nodes) => setWhen({ nodes })}
          />

          <box style={s.divider} />
          <Label style={s.section}>THEN</Label>

          <Branch tone="yes" label="If true" />
          <NodeList
            gutter
            kind="action"
            nodes={then.yes.nodes}
            join={then.yes.join}
            branch="yes"
            onBranch={moveRow('yes')}
            onJoin={(join) => setBranch('yes', { join })}
            onNodes={(nodes) => setBranch('yes', { nodes })}
          />

          <box style={{ height: 6 }} />
          <Branch tone="no" label="If false" />
          <NodeList
            gutter
            kind="action"
            nodes={then.no.nodes}
            join={then.no.join}
            branch="no"
            onBranch={moveRow('no')}
            onJoin={(join) => setBranch('no', { join })}
            onNodes={(nodes) => setBranch('no', { nodes })}
          />

          {/* one pair for the whole THEN, under the last branch, which is
              what it appends to */}
          <ListButtons
            kind="action"
            nodes={then.no.nodes}
            onNodes={(nodes) => setBranch('no', { nodes })}
          />
        </box>
      </box>
    </ThemeProvider>
  );
}

function App() {
  // A provider above a `<window>` renders no box — it plants the palette on
  // the window itself (a window may not sit inside a box), which is what
  // lets the window's own `backgroundColor: '$page'` resolve.
  return (
    <ThemeProvider value={LIGHT} dark={DARK}>
      <window
        title="rules"
        width={880}
        height={820}
        minWidth={560}
        minHeight={360}
        style={s.window}
      >
        <RulesPanel />
      </window>
    </ThemeProvider>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
