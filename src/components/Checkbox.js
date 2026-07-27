// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React from 'react';
import { labelContent, useControl, useTheme } from './theme.js';

const h = React.createElement;

/**
 * <Checkbox checked onChange disabled>label</Checkbox> — 16px check well +
 * label row; click or Space toggles (onChange receives the next value).
 */
export function Checkbox({
  children,
  label,
  checked = false,
  onChange,
  disabled = false,
  ...boxProps
}) {
  const theme = useTheme();
  const { focused, props } = useControl(disabled, () => onChange?.(!checked));
  const fill = disabled ? theme.dim : theme.accent;
  return h(
    'box',
    {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      ...props,
      ...boxProps,
    },
    h(
      'box',
      {
        width: 16,
        height: 16,
        borderRadius: 3,
        borderWidth: 1,
        borderColor: checked
          ? fill
          : focused
            ? theme.borderActive
            : theme.border,
        backgroundColor: checked ? fill : theme.background,
        alignItems: 'center',
        justifyContent: 'center',
      },
      checked &&
        h('canvas', {
          width: 10,
          height: 8,
          onDraw: (ctx) => {
            ctx.strokeStyle = theme.accentText;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(1, 4);
            ctx.lineTo(3.5, 6.5);
            ctx.lineTo(9, 1);
            ctx.stroke();
          },
        }),
    ),
    labelContent(children ?? label, {
      color: disabled ? theme.dim : theme.text,
    }),
  );
}
