// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React from 'react';
import { labelContent, useControl, useTheme } from './theme.js';

const h = React.createElement;

/**
 * <Button onPress primary disabled …boxProps>label</Button> — the standard
 * push button the examples kept re-implementing: hover/press/focus feedback,
 * Space/Enter activation, pointer cursor.
 *
 * `onPress` fires on the **release**, as a click does everywhere — so the
 * button darkens on the press instead, and keeps the darker fill for as long
 * as the button is held. Without that the whole of a slow click is a control
 * that has not answered: press, nothing, nothing, and then the action. The
 * press state is what makes an unhurried click feel immediate, and it costs
 * one node's repaint because it is a style block rather than React state.
 */
export function Button({
  children,
  label,
  onPress,
  primary = false,
  disabled = false,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const { props, style: controlStyle } = useControl(disabled, onPress, {
    styled: true,
  });
  const background = disabled
    ? theme.surfaceHover
    : primary
      ? theme.accent
      : theme.background;
  const color = disabled ? theme.dim : primary ? theme.accentText : theme.text;
  return h(
    'box',
    {
      theme,
      role: 'button',
      ...props,
      ...boxProps,
      style: [
        controlStyle,
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          paddingTop: theme.paddingY,
          paddingBottom: theme.paddingY,
          paddingLeft: theme.paddingX,
          paddingRight: theme.paddingX,
          borderRadius: theme.radius,
          borderWidth: theme.borderWidth,
          borderColor: disabled
            ? theme.border
            : primary
              ? theme.accent
              : theme.border,
          backgroundColor: background,
        },
        // All three as state blocks: a repaint of one node each, where React
        // state re-rendered the button and its label to change a colour.
        // `:focus-visible` rather than `:focus` is the difference between
        // "you clicked here" and "your keyboard is here", and only the
        // second is worth a ring.
        !disabled && {
          ':hover': {
            backgroundColor: primary ? theme.accentHover : theme.surfaceHover,
            borderColor: primary ? theme.accentHover : theme.border,
          },
          // the border follows the fill: a dark pressed face inside a
          // resting-coloured ring reads as a rendering bug, not a press
          ':active': {
            backgroundColor: primary ? theme.accentActive : theme.surfaceActive,
            borderColor: primary ? theme.accentActive : theme.dim,
          },
          ':focus-visible': {
            borderColor: primary ? theme.accentHover : theme.borderFocus,
          },
        },
        style,
      ],
    },
    labelContent(children ?? label, { color }),
  );
}
