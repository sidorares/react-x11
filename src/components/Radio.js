// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useContext, useEffect, useMemo, useRef } from 'react';
import { changeEvent } from './change.js';
import { labelContent, useControl, useTheme } from './theme.js';
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
  const onKeyDown = props.onKeyDown;
  if (onKeyDown) {
    props.onKeyDown = (ev) => {
      if (ev.keysym === XK_DOWN || ev.keysym === XK_RIGHT) group.move(1);
      else if (ev.keysym === XK_UP || ev.keysym === XK_LEFT) group.move(-1);
      else onKeyDown(ev);
    };
  }
  // The dot only appears on the release, so the well answers the press
  // itself — see Checkbox, both for the three-look treatment and for why
  // this is React state rather than an `:active` block.
  const fill = disabled
    ? theme.dim
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
          borderColor: selected
            ? fill
            : pressed || hover
              ? theme.dim
              : focused
                ? theme.borderFocus
                : theme.border,
          backgroundColor: pressed ? theme.surfaceActive : theme.background,
          alignItems: 'center',
          justifyContent: 'center',
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
      color: disabled ? theme.dim : theme.text,
    }),
  );
}
