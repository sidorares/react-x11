// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React from 'react';
import { labelContent, useControl, useTheme } from './theme.js';

const h = React.createElement;

/**
 * <Button onPress primary disabled …boxProps>label</Button> — the standard
 * push button the examples kept re-implementing: hover/focus feedback,
 * Space/Enter activation, pointer cursor.
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
  const { hover, props, style: controlStyle } = useControl(disabled, onPress);
  const background = disabled
    ? theme.surfaceHover
    : primary
      ? hover
        ? theme.accentHover
        : theme.accent
      : hover
        ? theme.surfaceHover
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
        // The border used to be tinted off React state, which lit it for a
        // press as well — and re-rendered the button and its label to do it.
        // As a state block it is a repaint of one node, and `:focus-visible`
        // is the difference between "you clicked here" and "your keyboard is
        // here", which is the only one of the two worth drawing.
        !disabled && {
          ':focus-visible': {
            borderColor: primary ? theme.accentHover : theme.borderActive,
          },
        },
        style,
      ],
    },
    labelContent(children ?? label, { color }),
  );
}
