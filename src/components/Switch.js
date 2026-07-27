// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React from 'react';
import { useControl, useTheme } from './theme.js';

const h = React.createElement;

/**
 * <Switch checked onChange disabled/> — Checkbox semantics in a sliding
 * pill; the thumb sits at the end matching the state.
 */
export function Switch({
  checked = false,
  onChange,
  disabled = false,
  ...boxProps
}) {
  const theme = useTheme();
  const { focused, props } = useControl(disabled, () => onChange?.(!checked));
  return h(
    'box',
    {
      width: 36,
      height: 20,
      borderRadius: 10,
      padding: 2,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: checked ? 'flex-end' : 'flex-start',
      backgroundColor: disabled
        ? theme.track
        : checked
          ? theme.accent
          : focused
            ? theme.dim
            : theme.border,
      ...props,
      ...boxProps,
    },
    h('box', {
      width: 16,
      height: 16,
      borderRadius: 8,
      backgroundColor: theme.background,
    }),
  );
}
