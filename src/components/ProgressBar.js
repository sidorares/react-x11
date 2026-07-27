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
  ...boxProps
}) {
  const theme = useTheme();
  const clamped = Math.min(1, Math.max(0, value));
  return h(
    'box',
    {
      height,
      borderRadius: height / 2,
      backgroundColor: trackColor ?? theme.track,
      overflow: 'hidden',
      flexDirection: 'row',
      ...boxProps,
    },
    h('box', {
      width: `${clamped * 100}%`,
      borderRadius: height / 2,
      backgroundColor: color ?? theme.accent,
    }),
  );
}
