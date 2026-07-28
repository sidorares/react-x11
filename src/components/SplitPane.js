// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useRef, useState } from 'react';
import { createStyles } from '../styles.js';
import { useTheme } from './theme.js';
import { XK_DOWN, XK_END, XK_HOME, XK_LEFT, XK_RIGHT, XK_UP } from './keys.js';

const h = React.createElement;

const DIVIDER = 6;
const KEY_STEP = 16;

const s = createStyles({
  root: { flexGrow: 1, minHeight: 0, minWidth: 0 },
  pane: { minHeight: 0, minWidth: 0 },
  grow: { flexGrow: 1, minHeight: 0, minWidth: 0 },
  divider: {
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    transition: { backgroundColor: 100 },
  },
  // the grab handle is a hairline; the *target* is the whole divider
  grip: { borderRadius: 1 },
});

/**
 * <SplitPane> — two panes with a divider you can drag.
 *
 *   <SplitPane direction="row" defaultSize={220}>
 *     <Sidebar />
 *     <Editor />
 *   </SplitPane>
 *
 * `size` is the first pane's width (or height, when `direction="column"`)
 * in pixels: controlled with `size` + `onResize`, uncontrolled with
 * `defaultSize`. The second pane takes what is left, so only one number is
 * ever stored and a window resize cannot leave a gap.
 *
 * `min` and `minSecond` keep either pane from collapsing; the drag clamps
 * against the container's laid-out size, so it stays honest when the window
 * changes underneath it.
 *
 * The divider is focusable: arrows move it by 16px, Home/End drive it to
 * either limit. Dragging captures the pointer, so it keeps tracking after
 * the pointer leaves the six pixels it started on.
 */
export function SplitPane({
  direction = 'row',
  size,
  defaultSize = 200,
  min = 40,
  minSecond = 40,
  onResize,
  children,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const [first, second] = React.Children.toArray(children);
  const [uncontrolled, setUncontrolled] = useState(defaultSize);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef(null);
  const grab = useRef(0);
  const vertical = direction === 'column';
  const current = size ?? uncontrolled;

  // the live size and drag flag, mirrored in refs: a press and the moves
  // that follow can all land before React re-renders, and a handler closing
  // over the last rendered value would drop everything after the first
  const sizeRef = useRef(current);
  sizeRef.current = current;
  const draggingRef = useRef(false);

  /** Clamp against the container as laid out right now. */
  const commit = (next) => {
    const box = rootRef.current?.abs;
    const total = (vertical ? box?.height : box?.width) ?? 0;
    const room = Math.max(min, total - DIVIDER - minSecond);
    const clamped = Math.min(Math.max(min, next), total > 0 ? room : next);
    if (clamped === sizeRef.current) return;
    sizeRef.current = clamped;
    if (size === undefined) setUncontrolled(clamped);
    onResize?.(clamped);
  };

  const dividerProps = {
    focusable: true,
    onMouseDown: (ev) => {
      const box = rootRef.current?.abs;
      // where in the divider it was taken, so it does not jump on press
      grab.current = (vertical ? ev.y - box.y : ev.x - box.x) - sizeRef.current;
      ev.capturePointer();
      draggingRef.current = true;
      setDragging(true);
    },
    onMouseMove: (ev) => {
      if (!draggingRef.current) return;
      const box = rootRef.current?.abs;
      if (!box) return;
      commit((vertical ? ev.y - box.y : ev.x - box.x) - grab.current);
    },
    onMouseUp: () => {
      draggingRef.current = false;
      setDragging(false);
    },
    onKeyDown: (ev) => {
      const back = vertical ? XK_UP : XK_LEFT;
      const forward = vertical ? XK_DOWN : XK_RIGHT;
      switch (ev.keysym) {
        case back:
          commit(sizeRef.current - KEY_STEP);
          return;
        case forward:
          commit(sizeRef.current + KEY_STEP);
          return;
        case XK_HOME:
          commit(min);
          return;
        case XK_END:
          commit(Number.MAX_SAFE_INTEGER);
          return;
        default:
      }
    },
  };

  return h(
    'box',
    {
      theme,
      ref: rootRef,
      ...boxProps,
      style: [s.root, { flexDirection: vertical ? 'column' : 'row' }, style],
    },
    h(
      'box',
      {
        style: [
          s.pane,
          vertical
            ? { height: current, flexShrink: 0 }
            : { width: current, flexShrink: 0 },
        ],
      },
      first ?? null,
    ),
    h(
      'box',
      {
        ...dividerProps,
        style: [
          s.divider,
          vertical
            ? { height: DIVIDER, cursor: 'row-resize' }
            : { width: DIVIDER, cursor: 'col-resize' },
          { backgroundColor: dragging ? theme.surfaceHover : 'transparent' },
          { ':hover': { backgroundColor: theme.surfaceHover } },
        ],
      },
      h('box', {
        style: [
          s.grip,
          vertical
            ? { height: 2, alignSelf: 'stretch' }
            : { width: 2, alignSelf: 'stretch' },
          { backgroundColor: theme.border },
        ],
      }),
    ),
    h('box', { style: s.grow }, second ?? null),
  );
}
