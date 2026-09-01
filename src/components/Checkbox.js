// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React from 'react';
import { useAppOrNull } from '../appcontext.js';
import { changeEvent } from './change.js';
import { Icon } from './Icon.js';
import { Bezel, bezelNatural, useNativeControls } from './native.js';
import { focusRingStyle, labelContent, useControl, useTheme } from './theme.js';

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
  native,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const app = useAppOrNull();
  const nativeControls = useNativeControls(native);
  const {
    hover,
    focused,
    pressed,
    props,
    style: controlStyle,
  } = useControl(disabled, () =>
    onChange?.(changeEvent('checkbox', name, !checked)),
  );

  // Native mode swaps only the well: AppKit's checkbox bezel at its natural
  // size, driven by the same React press state the drawn well uses — the
  // pressed bezel is a re-keyed image, so the press still lands on the
  // press frame. Focus keeps the shared ring (the one focus look the whole
  // app has), and hover has no tint because AppKit checkboxes have none.
  if (nativeControls) {
    const nat = bezelNatural(app, 'checkbox');
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
      h(Bezel, {
        kind: 'checkbox',
        state: checked ? 1 : 0,
        pressed,
        enabled: !disabled,
        style: {
          width: nat.width,
          height: nat.height,
          ...focusRingStyle(theme, focused),
        },
      }),
      labelContent(children ?? label, {
        color: disabled ? theme.textMuted : theme.text,
      }),
    );
  }
  const fill = disabled
    ? theme.textMuted
    : pressed
      ? theme.accentActive
      : hover
        ? theme.accentHover
        : theme.accent;
  // An empty well has no fill to step, so it shows its states in two
  // different places: focus is a *colour* on the border, hover and press are
  // a *step* of the inside. Three looks, which is the point — a hover the
  // press cannot be told apart from says nothing about the press — and four
  // with focus, because the two channels compose instead of overwriting.
  //
  // They used to share the border, where hover won, and that made the focus
  // colour unreachable by the gesture that focuses by pointer: a click ends
  // with the pointer sitting on the control it just focused, so the well was
  // hover-grey for as long as the user was looking at it and only turned
  // blue once they moved the mouse away.
  const empty = {
    borderColor: focused
      ? theme.borderFocus
      : pressed || hover
        ? theme.textMuted
        : theme.border,
    backgroundColor: pressed
      ? theme.surfaceActive
      : hover
        ? theme.surfaceHover
        : theme.surface,
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
          // a checked well is filled with the accent, so the border tier
          // above has nothing left to say — see {@link focusRingStyle}
          ...focusRingStyle(theme, checked && focused),
        },
      },
      checked &&
        h(Icon, { name: 'check', size: MARK, color: theme.accentText }),
    ),
    labelContent(children ?? label, {
      color: disabled ? theme.textMuted : theme.text,
    }),
  );
}
