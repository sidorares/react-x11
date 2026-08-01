// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useContext, useMemo, useState } from 'react';
import { XK_RETURN } from './keys.js';

const h = React.createElement;

/**
 * The palette every widget reads, and the shape of the controls with it.
 * A theme overrides what it cares about and inherits the rest, so the
 * defaults here are the look the widgets have always had.
 *
 * The shape tokens are what let a theme be more than a recolour: corner
 * radius, border weight, text size and the padding inside a control are
 * most of what separates one platform's buttons from another's.
 */
const DefaultTheme = {
  // colour
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
  // shape
  radius: 4,
  radiusSmall: 3,
  borderWidth: 1,
  fontSize: 14,
  paddingX: 16,
  paddingY: 8,
};

// Always a complete palette: the context default is the full DefaultTheme
// and `ThemeProvider` merges before it publishes, so nothing downstream has
// to merge again.
const ThemeContext = React.createContext(DefaultTheme);

// The provider's box fills its parent, which is what an app-level provider
// wants; `style` is there for the ones that wrap a single control.
const FILL = Object.freeze({ flexGrow: 1 });

/**
 * <ThemeProvider value={palette}> — the palette everything below reads, by
 * both routes at once. A partial palette merges over the defaults, and over
 * an outer provider, exactly as a nested `theme` prop merges in the tree.
 *
 * There are two consumers and they are not the same mechanism: widgets read
 * React context through `useTheme()`, while a `$token` in a style resolves
 * against the nearest `theme` **prop** above the node — resolution walks the
 * node tree and knows nothing about React. So the provider feeds both: the
 * merged palette goes on the context *and* onto a real node in the tree.
 * Skip the second and `<ThemeProvider value={dark}>` over
 * `<box style={{ color: '$text' }}>` silently paints nothing (#119).
 */
export function ThemeProvider({ value, style, children }) {
  const outer = useContext(ThemeContext);
  const theme = useMemo(
    () => (value ? { ...outer, ...value } : outer),
    [outer, value],
  );
  const boxStyle = useMemo(() => (style ? [FILL, style] : FILL), [style]);
  return h(
    ThemeContext.Provider,
    { value: theme },
    planted(children, theme, boxStyle),
  );
}

/**
 * The node that carries the palette into the tree. Normally a box — but a
 * `<window>` may only be a root child or nested in another window, never
 * inside a box, so a provider above one plants the prop on the windows
 * themselves instead of coming between them. An explicit `theme` on a child
 * still wins, since that is what it means everywhere else.
 */
function planted(children, theme, style) {
  const kids = React.Children.toArray(children);
  if (kids.some((k) => React.isValidElement(k) && k.type === 'window')) {
    return kids.map((k) =>
      React.isValidElement(k)
        ? React.cloneElement(k, { theme: k.props.theme ?? theme })
        : k,
    );
  }
  return h('box', { theme, style }, children);
}

/**
 * The palette in force here — already merged over the defaults and over any
 * outer provider, and the same object the provider planted in the tree, so
 * `useTheme()` and a `$token` always read one palette.
 *
 * Identity matters: widgets plant what this returns on their own root node,
 * and a fresh object every render would re-resolve every `$token` beneath it
 * and defeat the resolution cache.
 */
export function useTheme() {
  return useContext(ThemeContext);
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
    // the event travels: `ButtonProps.onPress` has always been declared as
    // taking one, and a handler that wants `ev.shiftKey` or `ev.detail` —
    // shift-click, double-click — has no other way to get it
    onClick: (ev) => onActivate?.(ev),
    onKeyDown: (ev) => {
      if (ev.codepoint === 32 || ev.keysym === XK_RETURN) onActivate?.(ev);
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
