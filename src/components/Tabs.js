// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useRef, useState } from 'react';
import { createStyles } from '../styles.js';
import { labelContent, useTheme } from './theme.js';
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

const INDICATOR = 2;

const s = createStyles({
  root: { flexGrow: 1, minHeight: 0 },
  strip: { flexShrink: 0, gap: 2 },
  tab: {
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 12,
    paddingRight: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    cursor: 'pointer',
    transition: { backgroundColor: 100 },
  },
  // the selected marker is a box rather than a border: borders are
  // all-edges here, and this has to sit on one side
  indicator: { position: 'absolute', transition: { backgroundColor: 100 } },
  panel: { flexGrow: 1, minHeight: 0, minWidth: 0 },
});

/**
 * <Tabs items value onChange orientation/> — one visible panel at a time,
 * switched by a strip of tabs.
 *
 *   <Tabs items={[{ id: 'a', label: 'A', content: <box/> }]} />
 *
 * Each item is `{ id, label, content, disabled }`. `content` may be a node,
 * or a function called only while that tab is selected — which is how to
 * avoid building a panel nobody is looking at.
 *
 * Controlled with `value` + `onChange`, uncontrolled otherwise. The strip is
 * a single tab stop: Left/Right (Up/Down when vertical) move and wrap,
 * Home/End jump to the ends, and disabled tabs are skipped. Arrows select as
 * they move, the way a desktop notebook behaves; pass `manual` to move focus
 * only and commit with Enter or Space, which is what you want when a panel
 * is expensive to build.
 */
export function Tabs({
  items = [],
  value,
  defaultValue,
  onChange,
  orientation = 'horizontal',
  manual = false,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const firstEnabled = items.find((item) => !item.disabled)?.id;
  const [uncontrolled, setUncontrolled] = useState(
    defaultValue ?? firstEnabled,
  );
  const [focusedId, setFocusedId] = useState(null);
  const selected = value ?? uncontrolled;
  const vertical = orientation === 'vertical';
  const tabRefs = useRef(new Map());

  const select = (id) => {
    if (id == null || id === selected) return;
    if (value === undefined) setUncontrolled(id);
    onChange?.(id);
  };

  /** The next enabled tab `delta` steps away, wrapping. */
  const step = (from, delta) => {
    const n = items.length;
    if (n === 0) return null;
    for (let i = 1; i <= n; i++) {
      const item = items[(((from + delta * i) % n) + n) % n];
      if (item && !item.disabled) return item;
    }
    return null;
  };

  const goTo = (item) => {
    if (!item) return;
    tabRefs.current.get(item.id)?.focus?.();
    if (!manual) select(item.id);
  };

  const onKeyDown = (ev) => {
    const back = vertical ? XK_UP : XK_LEFT;
    const forward = vertical ? XK_DOWN : XK_RIGHT;
    const current = items.findIndex(
      (item) => item.id === (focusedId ?? selected),
    );
    switch (ev.keysym) {
      case back:
        goTo(step(current === -1 ? 0 : current, -1));
        return;
      case forward:
        goTo(step(current === -1 ? 0 : current, 1));
        return;
      case XK_HOME:
        goTo(items.find((item) => !item.disabled));
        return;
      case XK_END:
        goTo([...items].reverse().find((item) => !item.disabled));
        return;
      default:
    }
    // in manual mode focus and selection differ, so commit what the focus
    // is on rather than what is already selected
    if (manual && (ev.keysym === XK_RETURN || ev.codepoint === 32)) {
      select(focusedId);
    }
  };

  const active = items.find((item) => item.id === selected);
  const content =
    typeof active?.content === 'function' ? active.content() : active?.content;

  const indicatorStyle = vertical
    ? { top: 0, bottom: 0, left: 0, width: INDICATOR }
    : { left: 0, right: 0, bottom: 0, height: INDICATOR };

  return h(
    'box',
    {
      theme,
      ...boxProps,
      style: [s.root, { flexDirection: vertical ? 'row' : 'column' }, style],
    },
    h(
      'box',
      {
        style: [s.strip, { flexDirection: vertical ? 'column' : 'row' }],
        onKeyDown,
      },
      items.map((item) =>
        h(
          'box',
          {
            key: item.id,
            ref: (node) => {
              if (node) tabRefs.current.set(item.id, node);
              else tabRefs.current.delete(item.id);
            },
            focusable: !item.disabled,
            tabIndex: item.id === selected ? 0 : -1,
            disabled: item.disabled,
            onFocus: () => setFocusedId(item.id),
            onClick: () => !item.disabled && select(item.id),
            style: [
              s.tab,
              {
                backgroundColor:
                  item.id === selected ? theme.surfaceHover : 'transparent',
              },
              // the panel only swaps on the release, so the press is what
              // says the tab heard the click — and it has to outrank the
              // selected tab's own fill, or pressing the selected tab is
              // the one press in the strip that does nothing visible
              !item.disabled && {
                ':hover': { backgroundColor: theme.surfaceHover },
                ':active': { backgroundColor: theme.surfaceActive },
              },
            ],
          },
          labelContent(item.label, {
            color: item.disabled
              ? theme.dim
              : item.id === selected
                ? theme.text
                : theme.dim,
          }),
          h('box', {
            style: [
              s.indicator,
              indicatorStyle,
              {
                backgroundColor:
                  item.id === selected
                    ? theme.accent
                    : item.id === focusedId
                      ? theme.borderFocus
                      : 'transparent',
              },
            ],
          }),
        ),
      ),
    ),
    h('box', { style: s.panel }, content ?? null),
  );
}
