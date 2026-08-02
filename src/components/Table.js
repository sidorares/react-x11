// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useMemo, useRef, useState } from 'react';
import { createStyles } from '../styles.js';
import { useTheme } from './theme.js';
import {
  XK_DOWN,
  XK_END,
  XK_HOME,
  XK_PAGE_DOWN,
  XK_PAGE_UP,
  XK_RETURN,
  XK_UP,
} from './keys.js';

const h = React.createElement;

const ROW_HEIGHT = 24;
const GRIP = 6;
const MIN_COLUMN = 40;
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
  headerLabel: { fontSize: 12 },
  grip: {
    width: GRIP,
    flexShrink: 0,
    cursor: 'col-resize',
    alignSelf: 'stretch',
  },
  body: { flexGrow: 1, minHeight: 0 },
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
  cellText: { fontSize: 12 },
  spacer: { flexShrink: 0 },
  sortMark: { width: 8, height: 5, marginLeft: 4 },
});

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
 * feeds sorting and the default cell text; `render(row)` replaces the cell
 * entirely.
 *
 * **Rows must all be `rowHeight` tall** (24 by default). That is what lets
 * the table skip building the rows nobody can see: with ten thousand rows
 * it mounts the thirty or so in the viewport, and scrolling swaps them.
 * Everything above and below is one spacer box apiece, so the scrollbar
 * still measures the whole list.
 *
 * Sorting is uncontrolled unless you pass `sort`; the header reports
 * `onSortChange({ column, direction })` either way. Selection is
 * `selected` + `onSelect`, or uncontrolled with `defaultSelected`.
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

  const resizeProps = (column) => ({
    focusable: true,
    onMouseDown: (ev) => {
      drag.current = { id: column.id, from: ev.x, width: columnWidth(column) };
      ev.capturePointer();
    },
    onMouseMove: (ev) => {
      const d = drag.current;
      if (!d) return;
      const next = Math.max(MIN_COLUMN, d.width + (ev.x - d.from));
      if (next === widthsRef.current[d.id]) return;
      widthsRef.current = { ...widthsRef.current, [d.id]: next };
      setWidths(widthsRef.current);
      onColumnResize?.(d.id, next);
    },
    onMouseUp: () => {
      drag.current = null;
    },
  });

  const cell = (row, column) =>
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
        ? column.render(row)
        : h(
            'text',
            {
              style: [
                s.cellText,
                {
                  color: row.id === current ? theme.hoverText : theme.text,
                },
              ],
            },
            String(value(row, column) ?? ''),
          ),
    );

  return h(
    'box',
    {
      theme,
      // the *table* takes focus, not the row: a virtualized row is
      // unmounted as soon as it scrolls out, and focus would go with it
      focusable: true,
      ...boxProps,
      style: [s.root, style],
      onKeyDown,
    },
    // the header scrolls sideways with the body but never vertically, so it
    // lives outside the scrollview and is shifted by the body's scrollX
    h(
      'box',
      { style: [s.headerClip, { backgroundColor: theme.surfaceHover }] },
      h(
        'box',
        { style: [s.headerRow, { marginLeft: -scrollX, width: totalWidth }] },
        columns.map((column) =>
          h(
            'box',
            {
              key: column.id,
              style: [s.header, { width: columnWidth(column) }],
              focusable: true,
              onClick: () => toggleSort(column),
            },
            h(
              'text',
              { style: [s.headerLabel, { color: theme.text }] },
              column.label ?? column.id,
            ),
            activeSort?.column === column.id &&
              h('canvas', {
                style: s.sortMark,
                onDraw: (ctx, { width: w, height: hgt }) => {
                  ctx.fillStyle = theme.dim;
                  ctx.beginPath();
                  if (activeSort.direction === 'asc') {
                    ctx.moveTo(0, hgt);
                    ctx.lineTo(w, hgt);
                    ctx.lineTo(w / 2, 0);
                  } else {
                    ctx.moveTo(0, 0);
                    ctx.lineTo(w, 0);
                    ctx.lineTo(w / 2, hgt);
                  }
                  ctx.closePath();
                  ctx.fill();
                },
              }),
            h('box', { style: { flexGrow: 1 } }),
            h('box', {
              ...resizeProps(column),
              style: [s.grip, { backgroundColor: theme.border }],
            }),
          ),
        ),
      ),
    ),
    h(
      'scrollview',
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
        slice.map((row) =>
          h(
            'box',
            {
              key: row.id,
              style: [
                s.row,
                { height: rowHeight },
                {
                  backgroundColor:
                    row.id === current ? theme.hoverBackground : 'transparent',
                },
                // pressed even on the selected row: a re-press on the row
                // that is already current is the one click in the table
                // that would otherwise look ignored
                {
                  ':active': {
                    backgroundColor:
                      row.id === current
                        ? theme.accentActive
                        : theme.surfaceActive,
                  },
                },
                row.id !== current && {
                  ':hover': { backgroundColor: theme.surfaceHover },
                },
              ],
              onClick: () => pick(row),
            },
            columns.map((column) => cell(row, column)),
          ),
        ),
        last < sorted.length &&
          h('box', {
            style: [s.spacer, { height: (sorted.length - last) * rowHeight }],
          }),
      ),
    ),
  );
}
