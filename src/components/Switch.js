// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React from 'react';
import { createStyles } from '../styles.js';
import { useControl, useTheme } from './theme.js';

const h = React.createElement;

const s = createStyles({
  track: {
    width: 36,
    height: 20,
    borderRadius: 10,
    padding: 2,
    flexDirection: 'row',
    alignItems: 'center',
  },
  thumb: { width: 16, height: 16, borderRadius: 8 },
  on: { justifyContent: 'flex-end' },
  off: { justifyContent: 'flex-start' },
});

/**
 * <Switch checked onChange disabled style/> — Checkbox semantics in a
 * sliding pill; the thumb sits at the end matching the state.
 *
 * The hover and focus tints are `:hover`/`:focus` blocks rather than React
 * state: the renderer already knows which node the pointer is over and
 * which one has focus, so lighting the track up is a repaint of one node
 * instead of a re-render of this component and everything under it.
 */
export function Switch({
  checked = false,
  onChange,
  disabled = false,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const control = useControl(disabled, () => onChange?.(!checked), {
    styled: true,
  });
  return h(
    'box',
    {
      ...control.props,
      ...boxProps,
      style: [
        s.track,
        checked ? s.on : s.off,
        {
          backgroundColor: disabled
            ? theme.track
            : checked
              ? theme.accent
              : theme.border,
        },
        !disabled && {
          ':hover': {
            backgroundColor: checked ? theme.accentHover : theme.dim,
          },
          ':focus': { borderColor: theme.borderActive },
        },
        style,
      ],
    },
    h('box', { style: [s.thumb, { backgroundColor: theme.background }] }),
  );
}
