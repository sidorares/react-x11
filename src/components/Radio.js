// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useContext, useEffect, useMemo, useRef } from 'react';
import { labelContent, useControl, useTheme } from './theme.js';
import { XK_DOWN, XK_LEFT, XK_RIGHT, XK_UP } from './keys.js';

const h = React.createElement;

const RadioGroupContext = React.createContext(null);

/**
 * <RadioGroup value onChange>…<Radio value=…>label</Radio>…</RadioGroup> —
 * exclusive choice. Arrow keys move the selection through the group in
 * mount order (wrapping); click or Space selects the focused radio.
 */
export function RadioGroup({ value, onChange, children, style, ...boxProps }) {
  const order = useRef([]).current;
  const ctx = useMemo(
    () => ({
      value,
      onChange,
      register: (v) => {
        order.push(v);
        return () => order.splice(order.indexOf(v), 1);
      },
      move: (delta) => {
        if (order.length === 0) return;
        const i = order.indexOf(value);
        const next = order[(i + delta + order.length) % order.length];
        if (next !== value) onChange?.(next);
      },
    }),
    [value, onChange, order],
  );
  return h(
    'box',
    { ...boxProps, style: [{ gap: 6 }, style] },
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
    focused,
    props,
    style: controlStyle,
  } = useControl(disabled, () => {
    if (!selected) group.onChange?.(value);
  });
  const onKeyDown = props.onKeyDown;
  if (onKeyDown) {
    props.onKeyDown = (ev) => {
      if (ev.keysym === XK_DOWN || ev.keysym === XK_RIGHT) group.move(1);
      else if (ev.keysym === XK_UP || ev.keysym === XK_LEFT) group.move(-1);
      else onKeyDown(ev);
    };
  }
  const fill = disabled ? theme.dim : theme.accent;
  return h(
    'box',
    {
      theme,
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
          borderWidth: 1,
          borderColor: selected
            ? fill
            : focused
              ? theme.borderActive
              : theme.border,
          backgroundColor: theme.background,
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
