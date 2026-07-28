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
  const {
    hover,
    focused,
    props,
    style: controlStyle,
  } = useControl(disabled, onPress);
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
      ...props,
      ...boxProps,
      style: [
        controlStyle,
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 16,
          paddingRight: 16,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: disabled
            ? theme.border
            : focused
              ? primary
                ? theme.accentHover
                : theme.borderActive
              : primary
                ? theme.accent
                : theme.border,
          backgroundColor: background,
        },
        style,
      ],
    },
    labelContent(children ?? label, { color }),
  );
}
