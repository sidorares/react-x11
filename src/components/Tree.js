// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useMemo, useRef, useState } from 'react';
import { createStyles } from '../styles.js';
import { labelContent, useDirection, useTheme } from './theme.js';
import { Icon } from './Icon.js';
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
// The chevron inside the twisty's hit box, which stays 12px whatever the
// glyph does — the box is what a file browser lets you click to peek into a
// folder without selecting it, and it should not shrink with the ink.
const TWISTY_SIZE = 10;
const ROW_HEIGHT = 22;

const s = createStyles({
  root: { flexGrow: 1, minHeight: 0, overflow: 'scroll' },
  row: {
    height: ROW_HEIGHT,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingEnd: 8,
    cursor: 'pointer',
    transition: { backgroundColor: 80 },
  },
  twisty: {
    width: TWISTY,
    height: TWISTY,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  const rtl = useDirection() === 'rtl';
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
    // Deeper is the direction the indent grows in, which is the direction the
    // text runs — so it is Left that opens a branch in a mirrored tree, and
    // the two arrows swap wholesale rather than the tree growing a second
    // pair of cases
    const deeper = rtl ? XK_LEFT : XK_RIGHT;
    const shallower = rtl ? XK_RIGHT : XK_LEFT;
    switch (ev.keysym) {
      case XK_UP:
        goTo(step(-1));
        return;
      case XK_DOWN:
        goTo(step(1));
        return;
      case deeper:
        // open it, then walk into it — one key does both, in order
        if (row?.branch && !openRef.current.has(row.item.id)) {
          toggle(row.item.id, true);
        } else if (row?.branch) goTo(step(1));
        return;
      case shallower:
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
      // the tree's own answer to these keys, so the row's click default
      // action must not also run: a row's click *moves the selection*,
      // which is a different thing from opening what is already selected
      ev.preventDefault();
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
    'box',
    {
      theme,
      role: 'tree',
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
          role: 'treeitem',
          'aria-level': depth + 1,
          'aria-selected': item.id === current,
          'aria-expanded': branch ? openSet.has(item.id) : undefined,
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
            // the indent is what says "inside", so it is measured from the
            // edge the row's label begins at
            { paddingStart: 4 + depth * INDENT },
            {
              backgroundColor:
                item.id === current ? theme.hoverBackground : 'transparent',
              // The row's ink, said once. `color` inherits, so the label and
              // the twisty both take it — a twisty that had to be handed the
              // colour separately used to be the thing that stayed grey
              // inside a highlighted row.
              color: item.disabled
                ? theme.textMuted
                : item.id === current
                  ? theme.hoverText
                  : theme.text,
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
            h(Icon, {
              name: openSet.has(item.id)
                ? 'chevronDown'
                : rtl
                  ? 'chevronLeft'
                  : 'chevronRight',
              size: TWISTY_SIZE,
              // dimmer than the label on an unselected row, and the row's own
              // ink once it is selected — where "the row's own ink" is what
              // inheritance gives it, with nothing said here
              style: item.id === current ? null : { color: theme.textMuted },
            }),
        ),
        labelContent(item.label),
      ),
    ),
  );
}
