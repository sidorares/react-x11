// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useContext, useEffect, useMemo, useRef } from 'react';
import { changeEvent } from './change.js';
import { focusRingStyle, labelContent, useControl, useTheme } from './theme.js';
import { XK_DOWN, XK_LEFT, XK_RIGHT, XK_UP } from './keys.js';

const h = React.createElement;

const RadioGroupContext = React.createContext(null);

/**
 * <RadioGroup value onChange name>…<Radio value=…>label</Radio>…</RadioGroup>
 * — exclusive choice. Arrow keys move the selection through the group in
 * mount order (wrapping); click or Space selects the focused radio.
 * `name` lives on the group, not the radios, the way it does in HTML: it is
 * the group that is one form field. `onChange(ev)`, with the chosen value
 * on `ev.value`.
 */
export function RadioGroup({
  value,
  onChange,
  name,
  children,
  style,
  ...boxProps
}) {
  const order = useRef([]).current;
  const ctx = useMemo(() => {
    const emit = (next) => onChange?.(changeEvent('radio', name, next));
    return {
      value,
      emit,
      register: (v) => {
        order.push(v);
        return () => order.splice(order.indexOf(v), 1);
      },
      move: (delta) => {
        if (order.length === 0) return;
        const i = order.indexOf(value);
        const next = order[(i + delta + order.length) % order.length];
        if (next !== value) emit(next);
      },
    };
  }, [value, onChange, name, order]);
  return h(
    'box',
    { role: 'radiogroup', ...boxProps, style: [{ gap: 6 }, style] },
    h(RadioGroupContext.Provider, { value: ctx }, children),
  );
}

export function Radio({ value, children, label, disabled = false }) {
  const theme = useTheme();
  const group = useContext(RadioGroupContext);
  if (!group) {
    throw new Error('react-x11: <Radio> must be inside a <RadioGroup>');
  }
  useEffect(() => group.register(value), [group, value]);
  const selected = group.value === value;
  const {
    hover,
    focused,
    pressed,
    props,
    style: controlStyle,
  } = useControl(disabled, () => {
    if (!selected) group.emit(value);
  });
  // The arrows are the group's, and they are all this handler is for: Space
  // and Enter are the click core makes of them on anything with an `onClick`
  // (issue #329), which for a radio is `useControl`'s. A disabled radio takes
  // no keys and gets no handler — it has no `onClick` either.
  if (!disabled) {
    props.onKeyDown = (ev) => {
      if (ev.keysym === XK_DOWN || ev.keysym === XK_RIGHT) group.move(1);
      else if (ev.keysym === XK_UP || ev.keysym === XK_LEFT) group.move(-1);
    };
  }
  // The dot only appears on the release, so the well answers the press
  // itself — see Checkbox, both for the three-look treatment and for why
  // this is React state rather than an `:active` block.
  const fill = disabled
    ? theme.textMuted
    : pressed
      ? theme.accentActive
      : hover
        ? theme.accentHover
        : theme.accent;
  return h(
    'box',
    {
      theme,
      role: 'radio',
      'aria-checked': selected,
      ...props,
      style: [
        controlStyle,
        { flexDirection: 'row', alignItems: 'center', gap: 8 },
      ],
    },
    h(
      'box',
      {
        style: {
          width: 16,
          height: 16,
          borderRadius: 8,
          borderWidth: theme.borderWidth,
          // Focus on the border, hover and press on the inside — the two
          // channels Checkbox splits them into, and for the same reason: a
          // click leaves the pointer on the control, so a focus colour hover
          // can overwrite is one the pointer user never gets to see.
          //
          // A *selected* radio has spent its border on the fill, and the
          // branch below it was unreachable — the one radio in a group that
          // can be clicked without changing anything was also the only one
          // with nothing to show for it. It gets the ring instead.
          borderColor: selected
            ? fill
            : focused
              ? theme.borderFocus
              : pressed || hover
                ? theme.textMuted
                : theme.border,
          backgroundColor: pressed
            ? theme.surfaceActive
            : hover
              ? theme.surfaceHover
              : theme.surface,
          alignItems: 'center',
          justifyContent: 'center',
          ...focusRingStyle(theme, selected && focused),
        },
      },
      selected &&
        h('box', {
          style: {
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: fill,
          },
        }),
    ),
    labelContent(children ?? label, {
      color: disabled ? theme.textMuted : theme.text,
    }),
  );
}
