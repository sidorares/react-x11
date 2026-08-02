// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useMemo, useRef, useState } from 'react';
import { createStyles } from '../styles.js';
import { labelContent, useTheme } from './theme.js';
import { typeAheadChar, useTypeAhead } from './typeahead.js';
import {
  XK_DOWN,
  XK_END,
  XK_HOME,
  XK_LEFT,
  XK_RETURN,
  XK_RIGHT,
  XK_UP,
} from './keys.js';

const h = React.createElement;

const INDENT = 14;
const TWISTY = 12;
const ROW_HEIGHT = 22;

const s = createStyles({
  root: { flexGrow: 1, minHeight: 0 },
  row: {
    height: ROW_HEIGHT,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingRight: 8,
    cursor: 'pointer',
    transition: { backgroundColor: 80 },
  },
  twisty: {
    width: TWISTY,
    height: TWISTY,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { width: 7, height: 7 },
});

/** Rows the tree can show right now: the roots, plus the children of every
 * expanded branch, in the order they are drawn. Depth comes with them so a
 * row only has to indent itself. */
function visibleRows(items, expanded, depth = 0, out = [], parent = null) {
  for (const item of items) {
    const branch = Array.isArray(item.children);
    out.push({ item, depth, parent, branch });
    if (branch && expanded.has(item.id)) {
      visibleRows(item.children, expanded, depth + 1, out, item);
    }
  }
  return out;
}

/**
 * <Tree items expanded selected/> — a disclosure tree: file browsers,
 * outline panes, property inspectors.
 *
 *   <Tree items={[{ id: 'src', label: 'src', children: [...] }]} />
 *
 * Each item is `{ id, label, children, disabled }`. An item with a
 * `children` array is a branch, even when the array is empty — that is how
 * an unexpanded directory shows a twisty before its contents are known.
 * Load lazily by handing back `children: []` and filling it in from
 * `onExpandedChange`.
 *
 * Expansion and selection are each controlled (`expanded` + `onExpandedChange`,
 * `selected` + `onSelect`) or uncontrolled (`defaultExpanded`,
 * `defaultSelected`).
 *
 * The tree is a single tab stop. Up/Down walk the rows that are visible,
 * Right expands a branch and then steps into it, Left collapses and then
 * steps out to the parent, Home/End jump to the ends, Enter and Space
 * activate, and typing letters jumps to a matching row — the same
 * type-ahead `Select` and the menus use.
 */
export function Tree({
  items = [],
  expanded,
  defaultExpanded = [],
  onExpandedChange,
  selected,
  defaultSelected,
  onSelect,
  onActivate,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const [ownExpanded, setOwnExpanded] = useState(
    () => new Set(defaultExpanded),
  );
  const [ownSelected, setOwnSelected] = useState(defaultSelected);
  const typeAhead = useTypeAhead();
  const scroller = useRef(null);
  const rowRefs = useRef(new Map());

  const openSet = useMemo(
    () => (expanded ? new Set(expanded) : ownExpanded),
    [expanded, ownExpanded],
  );
  const current = selected ?? ownSelected;
  const rows = useMemo(() => visibleRows(items, openSet), [items, openSet]);

  // Held-down or fast keys arrive in a burst, and every handler in that
  // burst sees the render they started from — so what is open and what is
  // selected are mirrored here and updated the moment they change, or three
  // Downs in a row all step off the same starting point.
  const openRef = useRef(openSet);
  openRef.current = openSet;
  const currentRef = useRef(current);
  currentRef.current = current;

  const setExpanded = (next) => {
    openRef.current = next;
    if (expanded === undefined) setOwnExpanded(next);
    onExpandedChange?.([...next]);
  };

  const toggle = (id, open) => {
    const next = new Set(openRef.current);
    if (open ?? !next.has(id)) next.add(id);
    else next.delete(id);
    setExpanded(next);
  };

  const goTo = (row) => {
    if (!row) return;
    const id = row.item.id;
    currentRef.current = id;
    if (selected === undefined) setOwnSelected(id);
    onSelect?.(id, row.item);
    const node = rowRefs.current.get(id);
    node?.focus?.();
    if (node) scroller.current?.scrollIntoView?.(node);
  };

  const onKeyDown = (ev) => {
    // recomputed per keystroke rather than taken from the render, for the
    // same reason
    const rows = visibleRows(items, openRef.current);
    const index = rows.findIndex((r) => r.item.id === currentRef.current);
    const step = (delta) => {
      for (let i = index + delta; i >= 0 && i < rows.length; i += delta) {
        if (!rows[i].item.disabled) return rows[i];
      }
      return null;
    };
    const row = rows[index];
    switch (ev.keysym) {
      case XK_UP:
        goTo(step(-1));
        return;
      case XK_DOWN:
        goTo(step(1));
        return;
      case XK_RIGHT:
        // open it, then walk into it — one key does both, in order
        if (row?.branch && !openRef.current.has(row.item.id)) {
          toggle(row.item.id, true);
        } else if (row?.branch) goTo(step(1));
        return;
      case XK_LEFT:
        if (row?.branch && openRef.current.has(row.item.id)) {
          toggle(row.item.id, false);
        } else if (row?.parent) {
          goTo(rows.find((r) => r.item.id === row.parent.id));
        }
        return;
      case XK_HOME:
        goTo(rows.find((r) => !r.item.disabled));
        return;
      case XK_END:
        goTo([...rows].reverse().find((r) => !r.item.disabled));
        return;
      default:
    }
    if (ev.keysym === XK_RETURN || ev.codepoint === 32) {
      if (row?.branch) toggle(row.item.id);
      if (row) onActivate?.(row.item.id, row.item);
      return;
    }
    const char = typeAheadChar(ev);
    if (!char) return;
    const found = typeAhead(
      char,
      rows,
      index,
      (r) => r.item.label,
      (r) => !r.item.disabled,
    );
    if (found >= 0) goTo(rows[found]);
  };

  return h(
    'scrollview',
    {
      theme,
      ref: scroller,
      ...boxProps,
      style: [s.root, style],
      onKeyDown,
    },
    rows.map(({ item, depth, branch }) =>
      h(
        'box',
        {
          key: item.id,
          ref: (node) => {
            if (node) rowRefs.current.set(item.id, node);
            else rowRefs.current.delete(item.id);
          },
          focusable: !item.disabled,
          tabIndex: item.id === current ? 0 : -1,
          disabled: item.disabled,
          onClick: () => !item.disabled && goTo({ item, depth, branch }),
          style: [
            s.row,
            { paddingLeft: 4 + depth * INDENT },
            {
              backgroundColor:
                item.id === current ? theme.hoverBackground : 'transparent',
            },
            !item.disabled && {
              ':hover': {
                backgroundColor:
                  item.id === current
                    ? theme.hoverBackground
                    : theme.surfaceHover,
              },
              // the selection only moves on the release, and `:active` marks
              // the whole press chain, so a press on the label or the twisty
              // still darkens the row it is in
              ':active': {
                backgroundColor:
                  item.id === current
                    ? theme.accentActive
                    : theme.surfaceActive,
              },
            },
          ],
        },
        h(
          'box',
          {
            style: s.twisty,
            // the twisty is its own hit target: clicking it opens the
            // branch without moving the selection, the way a file browser
            // lets you peek inside a folder you have not chosen
            onClick: branch
              ? (ev) => {
                  ev.stopPropagation();
                  toggle(item.id);
                }
              : undefined,
          },
          branch &&
            h('canvas', {
              style: s.glyph,
              onDraw: (ctx, { width: w, height: hgt }) => {
                ctx.fillStyle =
                  item.id === current ? theme.hoverText : theme.dim;
                ctx.beginPath();
                if (openSet.has(item.id)) {
                  ctx.moveTo(0, 0);
                  ctx.lineTo(w, 0);
                  ctx.lineTo(w / 2, hgt);
                } else {
                  ctx.moveTo(0, 0);
                  ctx.lineTo(w, hgt / 2);
                  ctx.lineTo(0, hgt);
                }
                ctx.closePath();
                ctx.fill();
              },
            }),
        ),
        labelContent(item.label, {
          color: item.disabled
            ? theme.dim
            : item.id === current
              ? theme.hoverText
              : theme.text,
        }),
      ),
    ),
  );
}
