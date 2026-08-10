// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React from 'react';
import { changeEvent } from './change.js';
import { Icon } from './Icon.js';
import { labelContent, useControl, useTheme } from './theme.js';

const h = React.createElement;

/** The mark inside the 16px well. */
const MARK = 11;

/**
 * <Checkbox checked onChange disabled>label</Checkbox> — 16px check well +
 * label row; click or Space toggles. `onChange(ev)` gets a change event, the
 * same shape `<textinput>` fires: the next value is `ev.value`, and
 * `ev.target` carries `name`/`checked` for a form library.
 *
 * The tick only appears on the release, so the well takes a pressed fill on
 * the press to cover the gap. This is the case `useControl` keeps in React
 * state rather than a style block: the press lands anywhere along the row —
 * usually the label — and `:active` marks that node and its ancestors, which
 * the well is not. One render per press, for a control whose next act is to
 * re-render with a new `checked` anyway.
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
    hover,
    focused,
    pressed,
    props,
    style: controlStyle,
  } = useControl(disabled, () =>
    onChange?.(changeEvent('checkbox', name, !checked)),
  );
  const fill = disabled
    ? theme.dim
    : pressed
      ? theme.accentActive
      : hover
        ? theme.accentHover
        : theme.accent;
  // An empty well has no fill to step, so it shows the two states in two
  // different places: hovering firms the ring up, and pressing greys the
  // inside as well. Three looks, which is the point — a hover the press
  // cannot be told apart from says nothing about the press.
  const empty = {
    borderColor:
      pressed || hover ? theme.dim : focused ? theme.borderFocus : theme.border,
    backgroundColor: pressed ? theme.surfaceActive : theme.background,
  };
  return h(
    'box',
    {
      theme,
      role: 'checkbox',
      'aria-checked': checked,
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
          borderColor: checked ? fill : empty.borderColor,
          backgroundColor: checked ? fill : empty.backgroundColor,
          alignItems: 'center',
          justifyContent: 'center',
        },
      },
      checked &&
        h(Icon, { name: 'check', size: MARK, color: theme.accentText }),
    ),
    labelContent(children ?? label, {
      color: disabled ? theme.dim : theme.text,
    }),
  );
}
