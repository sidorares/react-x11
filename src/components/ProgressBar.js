// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React from 'react';
import { useTheme } from './theme.js';

const h = React.createElement;

/**
 * <ProgressBar value/> — determinate progress, value in [0, 1].
 */
export function ProgressBar({
  value = 0,
  color,
  trackColor,
  height = 8,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const clamped = Math.min(1, Math.max(0, value));
  // The fill is expressed as flex ratios rather than a percentage width: a
  // percentage child resolves against the space available while the parent
  // is still being measured, so it fed back into the track's intrinsic
  // width and made whatever contained the bar grow — a dashboard card with
  // a fuller bar came out wider than one with an empty bar, and overflowed
  // the window. Two flexible boxes with a zero basis contribute nothing.
  return h(
    'box',
    {
      theme,
      role: 'progressbar',
      ...boxProps,
      style: [
        {
          height: height,
          borderRadius: height / 2,
          backgroundColor: trackColor ?? theme.track,
          overflow: 'hidden',
          flexDirection: 'row',
          minWidth: 0,
        },
        style,
      ],
    },
    h('box', {
      style: {
        flexGrow: clamped,
        flexShrink: 0,
        flexBasis: 0,
        borderRadius: height / 2,
        backgroundColor: color ?? theme.accent,
      },
    }),
    h('box', { style: { flexGrow: 1 - clamped, flexShrink: 0, flexBasis: 0 } }),
  );
}
