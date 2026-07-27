// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from './theme.js';
import {
  DEFAULT_LABEL_SIZE,
  measureLabel,
  movingToward,
  SAFE_HOVER_DELAY,
  screenPoint,
  useAnchor,
} from './anchor.js';

const h = React.createElement;

const TOOLTIP_PADDING_X = 8;

const TOOLTIP_PADDING_Y = 4;

/**
 * <Tooltip label placement delay>…</Tooltip> — a hover hint in a `<popup>`,
 * so it can extend past the owner window's bounds.
 *
 * Wraps its children in a row box that carries the hover handlers and the
 * anchor ref. Shows after `delay` ms of hover, hides immediately on leave
 * (and on mousedown — a tooltip lingering over a menu you just opened is
 * the classic annoyance). `placement` flips automatically near a screen
 * edge, via the same `useAnchor` math `Select` uses.
 *
 * The popup is sized from the measured label, since a `<popup>` is a real
 * X window and needs its size up front rather than after layout.
 */
export function Tooltip({
  label,
  children,
  placement = 'top',
  delay = 500,
  fontSize = DEFAULT_LABEL_SIZE,
  ...boxProps
}) {
  const theme = useTheme();
  const ref = useRef(null);
  const measureAnchor = useAnchor(ref);
  const [rect, setRect] = useState(null);
  const timer = useRef(null);

  const cancel = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const hide = () => {
    cancel();
    setRect(null);
  };

  // safe-polygon hover (docs/components.md): leaving the trigger *toward*
  // the tooltip keeps it up, so a tooltip with content in it can be
  // reached instead of vanishing the moment the pointer moves
  const apex = useRef(null);
  const hideSoon = () => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      setRect(null);
    }, SAFE_HOVER_DELAY);
  };
  const onMouseMove = (ev) => {
    apex.current = screenPoint(ev) ?? apex.current;
  };
  const onMouseLeave = (ev) => {
    if (rect && movingToward(screenPoint(ev), apex.current, rect)) hideSoon();
    else hide();
  };

  // a pending timer must not outlive the component
  useEffect(() => cancel, []);

  const show = () => {
    const node = ref.current;
    if (!node || !label) return;
    const text = measureLabel(node, label, { size: fontSize });
    const width = Math.ceil(text.width) + TOOLTIP_PADDING_X * 2 + 2;
    const height = Math.ceil(text.height) + TOOLTIP_PADDING_Y * 2 + 2;
    const next = measureAnchor({ placement, align: 'center', width, height });
    if (next) setRect(next);
  };

  const onMouseEnter = () => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      show();
    }, delay);
  };

  return h(
    'box',
    {
      ref,
      flexDirection: 'row',
      alignItems: 'center',
      onMouseEnter,
      onMouseMove,
      onMouseLeave,
      onMouseDown: hide,
      ...boxProps,
    },
    children,
    rect &&
      h(
        'popup',
        {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          windowType: 'tooltip',
          backgroundColor: theme.text,
        },
        h(
          'box',
          {
            // the pointer reaching the tooltip keeps it up; leaving it
            // dismisses, as if the trigger had been left
            onMouseEnter: cancel,
            onMouseLeave: hide,
            flexGrow: 1,
            borderWidth: 1,
            borderColor: theme.text,
            borderRadius: 3,
            backgroundColor: theme.text,
            justifyContent: 'center',
            paddingLeft: TOOLTIP_PADDING_X,
            paddingRight: TOOLTIP_PADDING_X,
          },
          h('text', { color: theme.background, fontSize }, label),
        ),
      ),
  );
}

// --- menus ------------------------------------------------------------------
