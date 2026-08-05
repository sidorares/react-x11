// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useContext, useMemo, useState } from 'react';
import { useAppearanceWhen } from '../appearancehooks.js';
import { stepBeyond } from '../styles.js';
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
  borderFocus: '#2980b9',
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
  // The pressed step of each fill family: rest → …Hover → …Active. Every
  // family that has a hover needs one, because a press is the state a
  // control has to show *before* it has done anything — the activation
  // itself only happens on the release, and half a second can pass in
  // between.
  //
  // Written out here, but a theme almost never sets them: `resolveTheme`
  // takes the step the palette's own hover made and takes it again. So a
  // palette that names `accentHover` and stops there — which is every theme
  // in `examples/themes.js` and every recipe in docs/ecosystem/theming.md —
  // gets a press that matches it rather than one inherited from these.
  accentActive: '#154c6d',
  surfaceActive: '#e3e5ed',
  dimActive: '#4c5a57',
  // The keyboard focus ring. Read by the renderer, not by the widgets: any
  // focusable node under this palette draws it on `:focus-visible`, so a
  // plain `<box focusable>` an application writes is indicated too, and a
  // theme restyles every ring in the app from here.
  focusRing: '#2980b9',
  focusRingWidth: 2,
  focusRingOffset: 1,
  // shape
  radius: 4,
  radiusSmall: 3,
  borderWidth: 1,
  fontSize: 14,
  paddingX: 16,
  paddingY: 8,
};

// Which pressed token is derived from which pair, when the palette does not
// name it: the resting colour of the family and the hover it steps to.
const PRESSED_FROM = {
  accentActive: ['accent', 'accentHover'],
  surfaceActive: ['background', 'surfaceHover'],
  dimActive: ['border', 'dim'],
};

/**
 * Merge a partial palette, filling in the pressed step for any family whose
 * colours moved without it.
 *
 * The rule per token: an explicit value wins; otherwise, if this palette
 * touched either colour the step is measured between, it is re-derived; and
 * otherwise whatever was already in force stands. That last clause is what
 * keeps an inner `<ThemeProvider value={{ fontSize: 18 }}>` from throwing
 * away a pressed colour an outer one set by hand.
 *
 * The alternative was three more tokens every theme has to remember, and a
 * theme that forgets one does not fail loudly — it just stops answering
 * presses, in the one state a control has to show while nothing else can.
 */
export function resolveTheme(value, base = DefaultTheme) {
  if (!value) return base;
  const merged = { ...base, ...value };
  for (const [token, [rest, hover]] of Object.entries(PRESSED_FROM)) {
    if (value[token] != null) continue;
    if (value[rest] == null && value[hover] == null) continue;
    merged[token] = stepBeyond(merged[rest], merged[hover]);
  }
  return merged;
}

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
 *
 * ## Following the desktop
 *
 * ```jsx
 * <ThemeProvider value={light} dark={{ background: '#1e1e1e', text: '#eceff4' }}>
 * ```
 *
 * `dark` **layers over `value`**, so it names only what changes — shape
 * tokens, the accent, anything the design shares across both schemes stays
 * written once.
 *
 * Giving it is what opts an app in: with no `dark` palette nothing is probed,
 * no D-Bus connection is opened, and this behaves exactly as it always has.
 * `colorScheme` pins the choice — `'light'` or `'dark'` — where the app owns
 * it rather than the desktop, which is what a preference in the app's own
 * settings wants. `'system'` is the default and means follow.
 *
 * The desktop's **accent** is deliberately not adopted on its own: an app
 * that asked for dark mode did not ask for its buttons to change colour. Take
 * it explicitly where you want it, and keep a fallback, because most portal
 * backends do not implement it:
 *
 * ```jsx
 * const { accent } = useSystemAppearance();
 * <ThemeProvider value={{ ...light, accent: accent ?? light.accent }} dark={dark}>
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
  // Only an app with somewhere to switch *to* pays for finding out.
  const follows = Boolean(dark) && colorScheme === 'system';
  const system = useAppearanceWhen(follows);
  const wantsDark =
    colorScheme === 'dark' || (follows && system.colorScheme === 'dark');
  const theme = useMemo(() => {
    const base = resolveTheme(value, outer);
    return dark && wantsDark ? resolveTheme(dark, base) : base;
  }, [outer, value, dark, wantsDark]);
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
