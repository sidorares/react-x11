// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React from 'react';
import { useAppOrNull } from '../appcontext.js';
import {
  ABS_FILL,
  Bezel,
  bezelNatural,
  pressWash,
  useNativeControls,
} from './native.js';
import { labelContent, useControl, useTheme } from './theme.js';

const h = React.createElement;

const VARIANTS = ['solid', 'outline', 'ghost'];
const SIZES = ['medium', 'small'];

/**
 * <Button onPress variant size primary disabled …boxProps>label</Button> —
 * the standard push button the examples kept re-implementing: hover/press/
 * focus feedback, Space/Enter activation, pointer cursor.
 *
 * Two axes rather than one list of looks. `variant` is how much chrome the
 * button carries — `solid` a fill, `outline` a border on nothing, `ghost`
 * neither, for the affordance that sits *inside* other content (a `✕` on a
 * chip, a jump arrow beside a value) and must not add a box to the row it
 * lives in. `primary` is whose colours it speaks in: the accent as the fill
 * when there is one, the accent as ink and border when there is not. The
 * axes compose, so a dialog footer's secondary action is `variant="outline"`
 * next to a `primary` solid, and a toolbar's loudest icon is
 * `primary variant="ghost"` — one component, one set of states.
 *
 * `size="small"` is the compact metric a toolbar or an inline row wants:
 * half the control padding, everything else in proportion. In the component
 * rather than in a `style` because the padding is derived from the palette —
 * a theme that moves `paddingY` moves both sizes together, where a hand-made
 * `{ height: 22 }` would be left behind.
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
  variant = 'solid',
  size = 'medium',
  disabled = false,
  native,
  style,
  ...boxProps
}) {
  // Before the hook on purpose, as `<Icon name>` does it: an unknown value
  // never renders, so the message lands on the call site — where TypeScript
  // is not there to catch the typo, silence would be an outline button.
  if (!VARIANTS.includes(variant)) {
    throw new Error(
      `<Button variant="${variant}">: one of ${VARIANTS.join(', ')}`,
    );
  }
  if (!SIZES.includes(size)) {
    throw new Error(`<Button size="${size}">: one of ${SIZES.join(', ')}`);
  }
  const theme = useTheme();
  const app = useAppOrNull();
  const nativeControls = useNativeControls(native);
  const { props, style: controlStyle } = useControl(disabled, onPress, {
    styled: true,
  });
  const solid = variant === 'solid';
  const ghost = variant === 'ghost';
  const small = size === 'small';

  // Only the solid variant has a native counterpart: outline and ghost are
  // deliberately chrome-less designs AppKit has no bezel for, so they keep
  // the drawn rendering under every policy.
  if (nativeControls && solid) {
    const controlSize = small ? 'small' : 'regular';
    const nat = bezelNatural(app, 'push', controlSize);
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
            gap: small ? 6 : 8,
            // AppKit's metrics, not the palette's: a native bezel is
            // designed at its own height, and stretching it is what this
            // mode exists to avoid. Width still follows the label.
            height: nat.height,
            paddingLeft: small ? 10 : 14,
            paddingRight: small ? 10 : 14,
            color: disabled
              ? theme.textMuted
              : primary
                ? theme.accentText
                : theme.text,
          },
          style,
        ],
      },
      h(Bezel, {
        kind: 'push',
        controlSize,
        enabled: !disabled,
        // the Return-key accent fill is AppKit's own "default button"
        isDefault: primary && !disabled,
        style: ABS_FILL,
      }),
      labelContent(children ?? label),
      // The press answer. Last child on purpose: `:active` marks the
      // pressed node and its ancestors, and the topmost child is what the
      // press lands on. No hover tint — AppKit buttons have none.
      h('box', {
        style: [
          ABS_FILL,
          { borderRadius: small ? 5 : 6 },
          !disabled && { ':active': { backgroundColor: pressWash(theme) } },
        ],
      }),
    );
  }
  const background = !solid
    ? // `transparent` rather than the ground's colour: an outline or ghost
      // button sits on whatever it sits on — a toolbar, a card, a table row —
      // and naming a fill would give it a box on any ground but one
      'transparent'
    : disabled
      ? theme.surfaceHover
      : primary
        ? theme.accent
        : theme.surface;
  const color = disabled
    ? theme.textMuted
    : primary
      ? solid
        ? theme.accentText
        : theme.accent
      : theme.text;
  // A ghost button keeps the border *width* and loses only the colour, so
  // every variant is the same sum and a mixed row lines up — a field padded
  // with `$paddingY` is exactly this tall too (docs/styling.md).
  const borderColor = ghost
    ? 'transparent'
    : disabled || !primary
      ? theme.border
      : theme.accent;
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
          gap: small ? 6 : 8,
          paddingTop: small ? Math.round(theme.paddingY / 2) : theme.paddingY,
          paddingBottom: small
            ? Math.round(theme.paddingY / 2)
            : theme.paddingY,
          paddingLeft: small ? Math.round(theme.paddingX / 2) : theme.paddingX,
          paddingRight: small ? Math.round(theme.paddingX / 2) : theme.paddingX,
          borderRadius: small ? theme.radiusSmall : theme.radius,
          borderWidth: theme.borderWidth,
          borderColor,
          backgroundColor: background,
          // The label ink goes on the box, not on the label: `color` is
          // inherited (docs/styling.md), so an element child — an <Icon>,
          // a <text> — takes the same answer a string child always got,
          // and an icon+label button dims as one thing when disabled.
          color,
        },
        // All three as state blocks: a repaint of one node each, where React
        // state re-rendered the button and its label to change a colour.
        // `:focus-visible` rather than `:focus` is the difference between
        // "you clicked here" and "your keyboard is here", and only the
        // second is worth a ring.
        !disabled &&
          (solid
            ? {
                ':hover': {
                  backgroundColor: primary
                    ? theme.accentHover
                    : theme.surfaceHover,
                  borderColor: primary ? theme.accentHover : theme.border,
                },
                // the border follows the fill: a dark pressed face inside a
                // resting-coloured ring reads as a rendering bug, not a press
                ':active': {
                  backgroundColor: primary
                    ? theme.accentActive
                    : theme.surfaceActive,
                  borderColor: primary ? theme.accentActive : theme.textMuted,
                },
                ':focus-visible': {
                  borderColor: primary ? theme.accentHover : theme.borderFocus,
                },
              }
            : {
                // Outline and ghost answer the pointer with the neutral wash
                // whichever colours they speak in: the surface steps are the
                // hover-and-press ramp for anything without an accent fill,
                // and the background paints under the border band, so a ghost
                // button's wash covers the full box.
                ':hover': { backgroundColor: theme.surfaceHover },
                ':active': {
                  backgroundColor: theme.surfaceActive,
                  ...(ghost
                    ? null
                    : {
                        borderColor: primary
                          ? theme.accentActive
                          : theme.textMuted,
                      }),
                },
                // …which on a ghost button makes the border appear, and that
                // is right: the keyboard has no hover, so the ring is how a
                // chrome-less control says "your keyboard is here".
                ':focus-visible': { borderColor: theme.borderFocus },
              }),
        style,
      ],
    },
    labelContent(children ?? label),
  );
}
