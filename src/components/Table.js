// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useMemo, useRef, useState } from 'react';
import { createStyles } from '../styles.js';
import { capTrim, useTheme } from './theme.js';
import { Icon } from './Icon.js';
import {
  XK_DOWN,
  XK_END,
  XK_HOME,
  XK_LEFT,
  XK_PAGE_DOWN,
  XK_PAGE_UP,
  XK_RETURN,
  XK_RIGHT,
  XK_UP,
} from './keys.js';

const h = React.createElement;

const ROW_HEIGHT = 24;
// The band you can grab, and the line you can see — two different sizes on
// purpose. A separator wants to be a hairline; a resize handle wants to be
// wide enough to hit without aiming. Drawing the handle is what made every
// column boundary a 6px bar.
//
// The band is centred **on** the rule rather than sitting beside it: it is
// the boundary that is being moved, so a band lying to one side of the line
// lights up off-centre and reads as belonging to the column it covers.
// `HALF` either side, which is why the columns on both sides of a rule give
// up a little width to it.
const RULE = 1;
const HALF = 3;
const GRIP = HALF + RULE + HALF;
const MIN_COLUMN = 40;
// what one Left/Right on a focused handle is worth
const STEP = 16;
// rows kept either side of the viewport, so a fast scroll does not show a
// gap before the next frame catches up
const OVERSCAN = 4;
// What to build before the viewport has been measured. onViewport cannot
// arrive until layout has run, which is a frame after the first commit, so
// there is always one render that has to guess — and guessing "all of them"
// means ten thousand rows land in the tree for a frame.
const ASSUMED_ROWS = 40;

const s = createStyles({
  root: { flexGrow: 1, minHeight: 0, minWidth: 0 },
  headerClip: { flexShrink: 0, overflow: 'hidden' },
  headerRow: { flexDirection: 'row', flexShrink: 0 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ROW_HEIGHT,
    paddingLeft: 8,
    flexShrink: 0,
    cursor: 'pointer',
    transition: { backgroundColor: 80 },
  },
  headerLabel: { fontSize: 12, textWrap: 'nowrap' },
  grip: {
    flexShrink: 0,
    cursor: 'col-resize',
    alignSelf: 'stretch',
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    transition: { backgroundColor: 80 },
  },
  rule: { width: RULE, flexShrink: 0, alignSelf: 'stretch' },
  body: { flexGrow: 1, minHeight: 0, overflow: 'scroll' },
  rows: { flexDirection: 'column', flexShrink: 0 },
  row: {
    flexDirection: 'row',
    height: ROW_HEIGHT,
    flexShrink: 0,
    alignItems: 'center',
    cursor: 'pointer',
  },
  cell: {
    height: ROW_HEIGHT,
    justifyContent: 'center',
    paddingLeft: 8,
    flexShrink: 0,
    overflow: 'hidden',
  },
  // one line, always: a row is a fixed height, so a cell that wrapped
  // would be sliced rather than shown — `textWrap` in styling.md
  cellText: { fontSize: 12, textWrap: 'nowrap' },
  spacer: { flexShrink: 0 },
  // Only the gap: the glyph is square now, and `<Icon size>` sets the box.
  sortMark: { marginLeft: 4 },
});

/** The sort chevron, a step under the 12px header text it follows. */
const SORT_MARK = 10;

const value = (row, column) =>
  column.value ? column.value(row) : row[column.id];

function compare(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

/**
 * <Table columns rows/> — a grid with a header that stays put, resizable
 * columns, and only the rows in view actually built.
 *
 *   <Table
 *     columns={[{ id: 'name', label: 'Name', width: 220 }]}
 *     rows={[{ id: 1, name: 'index.js' }]}
 *   />
 *
 * Columns are `{ id, label, width, align, value, render }`. `value(row)`
 * feeds sorting and the default cell text; `render(row, { selected, column })`
 * replaces the cell entirely — and gets told whether it is on the selected
 * row, because that row is a filled bar and a colour chosen against the
 * resting background is unreadable on it.
 *
 * **Rows must all be `rowHeight` tall** (24 by default). That is what lets
 * the table skip building the rows nobody can see: with ten thousand rows
 * it mounts the thirty or so in the viewport, and scrolling swaps them.
 * Everything above and below is one spacer box apiece, so the scrollbar
 * still measures the whole list.
 *
 * Sorting is uncontrolled unless you pass `sort`; the header reports
 * `onSortChange({ column, direction })` either way. Selection is
 * `selected` + `onSelect`, or uncontrolled with `defaultSelected`, and
 * `onActivate(id, row)` is the *open* gesture on top of it — a double click
 * or Enter.
 */
export function Table({
  columns = [],
  rows = [],
  rowHeight = ROW_HEIGHT,
  sort,
  defaultSort,
  onSortChange,
  selected,
  defaultSelected,
  onSelect,
  onActivate,
  onColumnResize,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const [ownSort, setOwnSort] = useState(defaultSort ?? null);
  const [ownSelected, setOwnSelected] = useState(defaultSelected);
  const [widths, setWidths] = useState(() =>
    Object.fromEntries(columns.map((c) => [c.id, c.width ?? 120])),
  );
  const [scrollX, setScrollX] = useState(0);
  const [view, setView] = useState({ top: 0, height: 0 });

  const body = useRef(null);
  const widthsRef = useRef(widths);
  widthsRef.current = widths;
  const drag = useRef(null);

  const activeSort = sort === undefined ? ownSort : sort;
  const current = selected ?? ownSelected;

  const sorted = useMemo(() => {
    if (!activeSort) return rows;
    const column = columns.find((c) => c.id === activeSort.column);
    if (!column) return rows;
    const sign = activeSort.direction === 'desc' ? -1 : 1;
    return [...rows].sort(
      (a, b) => sign * compare(value(a, column), value(b, column)),
    );
  }, [rows, columns, activeSort]);

  const currentRef = useRef(current);
  currentRef.current = current;

  const columnWidth = (c) => widths[c.id] ?? c.width ?? 120;
  const totalWidth = columns.reduce((n, c) => n + columnWidth(c), 0);

  // the slice worth building: what is on screen, plus a little either side
  const first = Math.max(0, Math.floor(view.top / rowHeight) - OVERSCAN);
  const visibleCount =
    view.height > 0
      ? Math.ceil(view.height / rowHeight) + OVERSCAN * 2
      : ASSUMED_ROWS;
  const last = Math.min(sorted.length, first + visibleCount);
  const slice = sorted.slice(first, last);

  const toggleSort = (column) => {
    const next =
      activeSort?.column === column.id && activeSort.direction === 'asc'
        ? { column: column.id, direction: 'desc' }
        : { column: column.id, direction: 'asc' };
    if (sort === undefined) setOwnSort(next);
    onSortChange?.(next);
  };

  const pick = (row) => {
    if (!row) return;
    currentRef.current = row.id;
    if (selected === undefined) setOwnSelected(row.id);
    onSelect?.(row.id, row);
    // keep the selection on screen without building the rows in between
    const index = sorted.findIndex((r) => r.id === row.id);
    const top = index * rowHeight;
    const node = body.current;
    if (!node) return;
    if (top < node.scrollY) node.scrollTo({ y: top });
    else if (top + rowHeight > node.scrollY + node.abs.height) {
      node.scrollTo({ y: top + rowHeight - node.abs.height });
    }
  };

  const step = (delta) => {
    const index = sorted.findIndex((r) => r.id === currentRef.current);
    const next = Math.min(
      Math.max(0, (index === -1 ? -1 : index) + delta),
      sorted.length - 1,
    );
    return sorted[next];
  };

  const onKeyDown = (ev) => {
    const page = Math.max(1, Math.floor(view.height / rowHeight) - 1);
    switch (ev.keysym) {
      case XK_UP:
        pick(step(-1));
        return;
      case XK_DOWN:
        pick(step(1));
        return;
      case XK_PAGE_UP:
        pick(step(-page));
        return;
      case XK_PAGE_DOWN:
        pick(step(page));
        return;
      case XK_HOME:
        pick(sorted[0]);
        return;
      case XK_END:
        pick(sorted[sorted.length - 1]);
        return;
      case XK_RETURN: {
        const row = sorted.find((r) => r.id === currentRef.current);
        if (row) onActivate?.(row.id, row);
        return;
      }
      default:
    }
  };

  const resize = (id, width) => {
    const next = Math.max(MIN_COLUMN, width);
    if (next === widthsRef.current[id]) return;
    widthsRef.current = { ...widthsRef.current, [id]: next };
    setWidths(widthsRef.current);
    onColumnResize?.(id, next);
  };

  const resizeProps = (column) => ({
    focusable: true,
    onMouseDown: (ev) => {
      drag.current = { id: column.id, from: ev.x, width: columnWidth(column) };
      ev.capturePointer();
    },
    onMouseMove: (ev) => {
      const d = drag.current;
      if (!d) return;
      resize(d.id, d.width + (ev.x - d.from));
    },
    onMouseUp: () => {
      drag.current = null;
    },
    // The handle takes focus on the press, so it is in the tab order whether
    // or not it answers a key — and a focus stop that does nothing is worse
    // than no stop at all. Left/Right, the same pair `SplitPane`'s divider
    // takes; the table's own keys are Up/Down and never collide.
    onKeyDown: (ev) => {
      if (ev.keysym === XK_LEFT) resize(column.id, columnWidth(column) - STEP);
      else if (ev.keysym === XK_RIGHT)
        resize(column.id, columnWidth(column) + STEP);
    },
  });

  const cell = (row, column, isSelected) =>
    h(
      'box',
      {
        key: column.id,
        style: [
          s.cell,
          { width: columnWidth(column) },
          column.align === 'right' && {
            alignItems: 'flex-end',
            paddingRight: 8,
          },
        ],
      },
      column.render
        ? // A cell that draws itself still has to know it is on the selected
          // row: the selection is a filled bar, and a `render` that picked a
          // colour for the resting background — a directory in the accent,
          // a warning in red — paints it onto that bar unreadably otherwise.
          column.render(row, { selected: isSelected, column })
        : h(
            'text',
            {
              style: [
                capTrim,
                s.cellText,
                { color: isSelected ? theme.hoverText : theme.text },
              ],
            },
            String(value(row, column) ?? ''),
          ),
    );

  return h(
    'box',
    {
      theme,
      // The grid role, with the honest caveat that virtualization keeps
      // only the rendered rows in the accessible tree — the same rows a
      // sighted user can see. `aria-label` via boxProps names the table.
      role: 'table',
      // the *table* takes focus, not the row: a virtualized row is
      // unmounted as soon as it scrolls out, and focus would go with it
      focusable: true,
      ...boxProps,
      style: [s.root, style],
      onKeyDown,
    },
    // the header scrolls sideways with the body but never vertically, so it
    // lives outside the scrolling pane and is shifted by the body's scrollX
    h(
      'box',
      { style: [s.headerClip, { backgroundColor: theme.surfaceHover }] },
      h(
        'box',
        { style: [s.headerRow, { marginLeft: -scrollX, width: totalWidth }] },
        columns.map((column, index) =>
          // The header cell and the grab band are **siblings**, not a cell
          // with a handle inside it. A click fires on the nearest common
          // ancestor of press and release, so a grip nested in the header
          // made every resize end in a sort: press the handle, release
          // anywhere over the header, and the click lands on the header. As
          // siblings the release cannot reach it — the pointer is captured by
          // the grip for the whole drag, and even without the capture the
          // common ancestor is the row rather than either header.
          //
          // A band centred on the rule takes `HALF` from the column to its
          // left as well, so every header but the first is inset by that
          // much; the last band has no column to its right and is the half
          // that fits.
          h(
            React.Fragment,
            { key: column.id },
            h(
              'box',
              {
                role: 'columnheader',
                style: [
                  s.header,
                  {
                    width: Math.max(
                      0,
                      columnWidth(column) - HALF - RULE - (index ? HALF : 0),
                    ),
                  },
                ],
                focusable: true,
                onClick: () => toggleSort(column),
              },
              h(
                'text',
                { style: [capTrim, s.headerLabel, { color: theme.text }] },
                column.label ?? column.id,
              ),
              activeSort?.column === column.id &&
                h(Icon, {
                  name:
                    activeSort.direction === 'asc'
                      ? 'chevronUp'
                      : 'chevronDown',
                  size: SORT_MARK,
                  color: theme.dim,
                  style: s.sortMark,
                }),
              h('box', { style: { flexGrow: 1 } }),
            ),
            // The band is invisible until the pointer is on it, and answers
            // the press itself — a captured press keeps `:active` for the
            // whole drag, wherever the pointer wanders, so the handle stays
            // lit while the column follows it. The rule is its child, so the
            // lit band is symmetric about the line it moves.
            h(
              'box',
              {
                ...resizeProps(column),
                role: 'separator',
                'aria-orientation': 'vertical',
                'aria-label': `Resize ${column.label || column.id}`,
                'aria-valuenow': columnWidth(column),
                'aria-valuemin': MIN_COLUMN,
                style: [
                  s.grip,
                  {
                    width: index === columns.length - 1 ? HALF + RULE : GRIP,
                    justifyContent:
                      index === columns.length - 1 ? 'flex-end' : 'center',
                  },
                  { backgroundColor: 'transparent' },
                  { ':hover': { backgroundColor: theme.track } },
                  { ':active': { backgroundColor: theme.accent } },
                ],
              },
              h('box', { style: [s.rule, { backgroundColor: theme.border }] }),
            ),
          ),
        ),
      ),
    ),
    h(
      'box',
      {
        ref: body,
        style: s.body,
        onScroll: (ev) => {
          setScrollX(ev.scrollX);
          setView((v) =>
            v.top === ev.scrollY ? v : { ...v, top: ev.scrollY },
          );
        },
        // layout, not scrolling, is what first tells a list how much of it
        // is worth building
        onViewport: (v) =>
          setView((prev) =>
            prev.height === v.height ? prev : { ...prev, height: v.height },
          ),
      },
      h(
        'box',
        { style: [s.rows, { width: totalWidth }] },
        first > 0 &&
          h('box', { style: [s.spacer, { height: first * rowHeight }] }),
        slice.map((row, sliceIndex) => {
          const isSelected = row.id === current;
          return h(
            'box',
            {
              key: row.id,
              role: 'row',
              'aria-selected': isSelected,
              'aria-posinset': first + sliceIndex + 1,
              'aria-setsize': sorted.length,
              style: [
                s.row,
                { height: rowHeight },
                {
                  backgroundColor: isSelected
                    ? theme.hoverBackground
                    : 'transparent',
                },
                // pressed even on the selected row: a re-press on the row
                // that is already current is the one click in the table
                // that would otherwise look ignored
                {
                  ':active': {
                    backgroundColor: isSelected
                      ? theme.accentActive
                      : theme.surfaceActive,
                  },
                },
                !isSelected && {
                  ':hover': { backgroundColor: theme.surfaceHover },
                },
              ],
              // Select on the first click, open on the second — the gesture
              // every file list has. `detail` is the click count the renderer
              // already counts for text selection, so a double click here is
              // exactly the one a `<textinput>` calls a word select.
              onClick: (ev) => {
                pick(row);
                if (ev.detail === 2) onActivate?.(row.id, row);
              },
            },
            columns.map((column) => cell(row, column, isSelected)),
          );
        }),
        last < sorted.length &&
          h('box', {
            style: [s.spacer, { height: (sorted.length - last) * rowHeight }],
          }),
      ),
    ),
  );
}
