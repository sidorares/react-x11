// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useContext, useState } from 'react';
import { XK_RETURN } from './keys.js';

const h = React.createElement;

const DefaultTheme = {
  border: '#b2bec3',
  borderActive: '#2980b9',
  background: 'white',
  text: '#2d3436',
  dim: '#7f8c8d',
  hoverBackground: '#2980b9',
  hoverText: 'white',
  accent: '#2980b9',
  accentHover: '#1f6693',
  accentText: 'white',
  surfaceHover: '#f1f2f6',
  track: '#dfe6e9',
};

const ThemeContext = React.createContext(DefaultTheme);

/** Themes all widgets; partial palettes merge over the defaults. */
export const ThemeProvider = ThemeContext.Provider;

export const SelectThemeProvider = ThemeContext.Provider; // back-compat alias

export function useTheme() {
  const theme = useContext(ThemeContext);
  return theme === DefaultTheme ? theme : { ...DefaultTheme, ...theme };
}

/** Shared interactive-control plumbing: hover/focus state plus the box
 * props wiring them, click + Space/Enter activation. */
export function useControl(disabled, onActivate) {
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const props = disabled
    ? {}
    : {
        focusable: true,
        cursor: 'pointer',
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        onClick: () => onActivate?.(),
        onKeyDown: (ev) => {
          if (ev.codepoint === 32 || ev.keysym === XK_RETURN) onActivate?.();
        },
      };
  return { hover: hover && !disabled, focused: focused && !disabled, props };
}

/** String/number children become a <text>; elements pass through. */
export function labelContent(children, textProps) {
  return React.Children.map(children, (child) =>
    typeof child === 'string' || typeof child === 'number'
      ? h('text', textProps, child)
      : child,
  );
}
