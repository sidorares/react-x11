// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React from 'react';
import { changeEvent } from './change.js';
import { labelContent, useControl, useTheme } from './theme.js';

const h = React.createElement;

/**
 * <Checkbox checked onChange disabled>label</Checkbox> — 16px check well +
 * label row; click or Space toggles. `onChange(next, ev)`: the next value
 * first, then a form-library-shaped change event carrying `name`.
 */
export function Checkbox({
  children,
  label,
  checked = false,
  onChange,
  name,
  disabled = false,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const {
    focused,
    props,
    style: controlStyle,
  } = useControl(disabled, () =>
    onChange?.(!checked, changeEvent('checkbox', name, !checked)),
  );
  const fill = disabled ? theme.dim : theme.accent;
  return h(
    'box',
    {
      theme,
      role: 'checkbox',
      ...props,
      ...boxProps,
      style: [
        controlStyle,
        { flexDirection: 'row', alignItems: 'center', gap: 8 },
        style,
      ],
    },
    h(
      'box',
      {
        style: {
          width: 16,
          height: 16,
          borderRadius: theme.radiusSmall,
          borderWidth: theme.borderWidth,
          borderColor: checked
            ? fill
            : focused
              ? theme.borderActive
              : theme.border,
          backgroundColor: checked ? fill : theme.background,
          alignItems: 'center',
          justifyContent: 'center',
        },
      },
      checked &&
        h('canvas', {
          onDraw: (ctx) => {
            ctx.strokeStyle = theme.accentText;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(1, 4);
            ctx.lineTo(3.5, 6.5);
            ctx.lineTo(9, 1);
            ctx.stroke();
          },
          style: { width: 10, height: 8 },
        }),
    ),
    labelContent(children ?? label, {
      color: disabled ? theme.dim : theme.text,
    }),
  );
}
