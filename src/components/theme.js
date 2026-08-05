// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.
//
// The palettes themselves are in `../palette.js`, one layer down: a `$token`
// in a style is resolved by walking the *node* tree, which knows nothing
// about React, and both routes have to agree on what "no theme was given"
// means.

import React, { useContext, useMemo, useState } from 'react';
import { useAppearanceWhen } from '../appearancehooks.js';
import { DarkTheme, DefaultTheme, resolveTheme } from '../palette.js';
import { XK_RETURN } from './keys.js';

const h = React.createElement;

export { DarkTheme, DefaultTheme, resolveTheme };

// `null` means **no provider above here**, which is different from "the
// default palette": with nothing said, the palette to use is the desktop's,
// and that is not a constant. `useTheme()` substitutes it, and subscribes so
// the widget re-renders when the desktop changes.
//
// A provider always publishes a complete palette, so nothing downstream ever
// has to merge again.
const ThemeContext = React.createContext(null);

// The provider's box fills its parent, which is what an app-level provider
// wants; `style` is there for the ones that wrap a single control.
const FILL = Object.freeze({ flexGrow: 1 });

/**
 * <ThemeProvider value={palette}> — the palette everything below reads, by
 * both routes at once. A partial palette merges over whatever is already in
 * force, exactly as a nested `theme` prop merges in the tree.
 *
 * There are two consumers and they are not the same mechanism: widgets read
 * React context through `useTheme()`, while a `$token` in a style resolves
 * against the nearest `theme` **prop** above the node — resolution walks the
 * node tree and knows nothing about React. So the provider feeds both: the
 * merged palette goes on the context *and* onto a real node in the tree.
 * Skip the second and `<ThemeProvider value={dark}>` over
 * `<box style={{ color: '$text' }}>` silently paints nothing (#119).
 *
 * ## What "already in force" means
 *
 * **The desktop's palette.** With no provider at all an app is dark on a dark
 * desktop, so a provider that names an accent and a corner radius keeps
 * following the desktop for everything it did not name — which is what an app
 * that wants to look like it belongs there wants, and what it would have had
 * to write `dark={…}` by hand for otherwise.
 *
 * `colorScheme` is the override, for an app that owns the choice rather than
 * the desktop — a preference in its own settings, or a design that only works
 * one way:
 *
 * ```jsx
 * <ThemeProvider value={brand} colorScheme="light">   // never follows
 * <ThemeProvider value={brand} colorScheme={settings.theme}>
 * ```
 *
 * `dark` is the other half: a palette layered on only when the scheme in
 * force is dark, for a design whose two schemes are not one recolour of the
 * other.
 *
 * ```jsx
 * <ThemeProvider value={light} dark={{ background: '#101418' }}>
 * ```
 *
 * The desktop's **accent** is deliberately not adopted on its own: an app in
 * dark mode did not ask for its buttons to change colour, and most portal
 * backends report no accent at all. Take it explicitly where you want it, and
 * keep a fallback:
 *
 * ```jsx
 * const { accent } = useSystemAppearance();
 * <ThemeProvider value={{ ...brand, accent: accent ?? brand.accent }}>
 * ```
 */
export function ThemeProvider({
  value,
  dark,
  colorScheme = 'system',
  style,
  children,
}) {
  const outer = useContext(ThemeContext);
  // **Pinning is the complete opt-out.** A provider that names its own scheme
  // subscribes to nothing, and the widgets under it read the provided palette
  // rather than the store — so an app that does not want react-x11 asking the
  // desktop anything says `colorScheme="light"` once at the top.
  const follows = colorScheme === 'system';
  const system = useAppearanceWhen(follows);
  const wantsDark =
    colorScheme === 'dark' || (follows && system.colorScheme === 'dark');
  const theme = useMemo(
    () =>
      // An outer provider is the base; with none, the base is the scheme's
      // own built-in palette. So `value` names what this app changes and
      // everything else keeps following the desktop.
      resolveTheme(
        dark && wantsDark ? { ...value, ...dark } : value,
        outer ?? (wantsDark ? DarkTheme : DefaultTheme),
      ),
    [outer, value, dark, wantsDark],
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
 * The palette in force here — already merged over any outer provider, and the
 * same object the provider planted in the tree, so `useTheme()` and a `$token`
 * always read one palette.
 *
 * **With no provider it is the desktop's**, and this re-renders when the
 * desktop changes, which is what makes a react-x11 app that says nothing
 * about colour go dark on a dark desktop. `node.theme` in `nodes.js` answers
 * the same question for the other route.
 *
 * Identity matters: widgets plant what this returns on their own root node,
 * and a fresh object every render would re-resolve every `$token` beneath it
 * and defeat the resolution cache. Both built-in palettes are module
 * constants, so the unprovided answer is stable too.
 */
export function useTheme() {
  const provided = useContext(ThemeContext);
  const system = useAppearanceWhen(provided == null);
  if (provided) return provided;
  return system.colorScheme === 'dark' ? DarkTheme : DefaultTheme;
}

/**
 * Shared interactive-control plumbing: hover/focus/press state plus the box
 * props wiring them, click + Space/Enter activation.
 *
 * `styled: true` says the widget expresses hover, focus and the press with
 * `:hover`, `:focus` and `:active` style blocks. Then none of it is React
 * state: no enter/leave handlers, no re-render on pointer move, and the
 * returned `hover`/`focused`/`pressed` stay false. **Prefer it.** The state
 * blocks are a repaint of one node where the React state is a re-render of
 * the widget and its label.
 *
 * The exception is a control whose pressed part is not the node the press
 * lands on. `:active` marks the press chain — the pressed node and its
 * ancestors — so a `<Checkbox>` pressed anywhere along its row cannot light
 * up its 16px well that way, the well being a sibling of the label rather
 * than an ancestor of it. There the press is React state, which costs one
 * render for a discrete event that in the ordinary case was about to
 * re-render anyway when the value changed.
 */
export function useControl(disabled, onActivate, { styled = false } = {}) {
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pressed, setPressed] = useState(false);
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
          // a press released off the control never sends it a mouseup, so
          // leaving is what ends the press — which is also what it means:
          // releasing out there activates nothing
          onMouseLeave: () => {
            setHover(false);
            setPressed(false);
          },
          onMouseDown: () => setPressed(true),
          onMouseUp: () => setPressed(false),
          onFocus: () => setFocused(true),
          onBlur: () => {
            setFocused(false);
            setPressed(false);
          },
        };
  return {
    hover: !styled && hover && !disabled,
    focused: !styled && focused && !disabled,
    pressed: !styled && pressed && !disabled,
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
