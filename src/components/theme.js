// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useContext, useMemo, useState } from 'react';
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

/**
 * The merged palette. Memoised on the context value because identity now
 * matters: it is planted on each widget's root node as the `theme` prop, and
 * a fresh object every render would re-resolve every `$token` beneath it and
 * defeat the resolution cache.
 */
export function useTheme() {
  const theme = useContext(ThemeContext);
  return useMemo(
    () => (theme === DefaultTheme ? theme : { ...DefaultTheme, ...theme }),
    [theme],
  );
}

/**
 * Shared interactive-control plumbing: hover/focus state plus the box
 * props wiring them, click + Space/Enter activation.
 *
 * `styled: true` says the widget expresses hover and focus with `:hover`
 * and `:focus` style blocks. Then none of it is React state: no enter/leave
 * handlers, no re-render on pointer move, and the returned `hover`/`focused`
 * stay false. Reach for the React state only when hover has to change
 * something a style block cannot — what renders, or the layout.
 */
export function useControl(disabled, onActivate, { styled = false } = {}) {
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const activation = {
    focusable: true,
    onClick: () => onActivate?.(),
    onKeyDown: (ev) => {
      if (ev.codepoint === 32 || ev.keysym === XK_RETURN) onActivate?.();
    },
  };
  const props = disabled
    ? {}
    : styled
      ? activation
      : {
          ...activation,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
        };
  return {
    hover: !styled && hover && !disabled,
    focused: !styled && focused && !disabled,
    props,
    // `cursor` is style, so it travels in the style channel — put it first
    // in the widget's style array and anything it declares still wins
    style: disabled ? undefined : POINTER,
  };
}

const POINTER = Object.freeze({ cursor: 'pointer' });

/** String/number children become a `<text>` with `style`; elements pass
 * through untouched. */
export function labelContent(children, style) {
  return React.Children.map(children, (child) =>
    typeof child === 'string' || typeof child === 'number'
      ? h('text', { style }, child)
      : child,
  );
}
