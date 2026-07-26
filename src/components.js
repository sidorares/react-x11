// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.
import React, { useContext, useRef, useState } from 'react';

const h = React.createElement;

const ITEM_HEIGHT = 28;
const MAX_MENU_HEIGHT = 220;

const SelectTheme = {
  border: '#b2bec3',
  borderActive: '#2980b9',
  background: 'white',
  text: '#2d3436',
  dim: '#7f8c8d',
  hoverBackground: '#2980b9',
  hoverText: 'white',
};

const SelectThemeContext = React.createContext(SelectTheme);
export const SelectThemeProvider = SelectThemeContext.Provider;

function normalizeOption(option) {
  return typeof option === 'object' && option !== null
    ? option
    : { value: option, label: String(option) };
}

function Option({ option, selected, onPick }) {
  const theme = useContext(SelectThemeContext);
  const [hover, setHover] = useState(false);
  return h(
    'box',
    {
      height: ITEM_HEIGHT,
      justifyContent: 'center',
      paddingLeft: 10,
      cursor: 'pointer',
      backgroundColor: hover ? theme.hoverBackground : theme.background,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      onClick: () => onPick(option),
    },
    h(
      'text',
      {
        color: hover ? theme.hoverText : theme.text,
        fontWeight: selected ? 'bold' : 'normal',
      },
      option.label,
    ),
  );
}

/**
 * <Select value options onChange placeholder width …boxProps> — a dropdown
 * built on <popup>. The menu is a real override-redirect X11 window
 * anchored below the trigger (owner window position + trigger rect).
 * Closes on pick, Escape, toggling the trigger, or focus loss within the
 * owner window.
 */
export function Select({
  value,
  options = [],
  onChange,
  placeholder = 'Select…',
  width,
  ...boxProps
}) {
  const theme = useContext(SelectThemeContext);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const [focused, setFocused] = useState(false);
  const triggerRef = useRef(null);

  const normalized = options.map(normalizeOption);
  const current = normalized.find((o) => o.value === value);

  const close = () => setOpen(false);
  const toggle = () => {
    if (open) {
      close();
      return;
    }
    const node = triggerRef.current;
    if (!node) return;
    const win = node.root?.window;
    setAnchor({
      x: (win?.x ?? 0) + node.abs.x,
      y: (win?.y ?? 0) + node.abs.y + node.abs.height + 2,
      width: node.abs.width,
    });
    setOpen(true);
  };

  const pick = (option) => {
    close();
    if (option.value !== value) onChange?.(option.value);
  };

  const menuHeight = Math.min(
    normalized.length * ITEM_HEIGHT + 8,
    MAX_MENU_HEIGHT,
  );

  return h(
    'box',
    {
      ref: triggerRef,
      focusable: true,
      cursor: 'pointer',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      width,
      padding: 8,
      paddingLeft: 10,
      paddingRight: 10,
      borderWidth: 1,
      borderRadius: 4,
      borderColor: focused || open ? theme.borderActive : theme.border,
      backgroundColor: theme.background,
      onClick: toggle,
      onFocus: () => setFocused(true),
      onBlur: () => {
        setFocused(false);
        close();
      },
      onKeyDown: (ev) => {
        if (ev.keysym === 0xff1b /* Escape */) close();
        if (ev.codepoint === 32 || ev.keysym === 0xff0d) toggle();
      },
      ...boxProps,
    },
    h(
      'text',
      { color: current ? theme.text : theme.dim },
      current ? current.label : placeholder,
    ),
    h('box', { flexGrow: 1 }),
    h('canvas', {
      width: 10,
      height: 6,
      onDraw: (ctx, { width: w, height: hgt }) => {
        ctx.fillStyle = theme.dim;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(w, 0);
        ctx.lineTo(w / 2, hgt);
        ctx.closePath();
        ctx.fill();
      },
    }),
    open &&
      anchor &&
      h(
        'popup',
        {
          x: anchor.x,
          y: anchor.y,
          width: anchor.width,
          height: menuHeight + 2,
          backgroundColor: theme.background,
        },
        h(
          'box',
          {
            flexGrow: 1,
            borderWidth: 1,
            borderColor: theme.border,
            backgroundColor: theme.background,
          },
          h(
            'scrollview',
            { flexGrow: 1, padding: 4 },
            normalized.map((option) =>
              h(Option, {
                key: String(option.value),
                option,
                selected: option.value === value,
                onPick: pick,
              }),
            ),
          ),
        ),
      ),
  );
}
