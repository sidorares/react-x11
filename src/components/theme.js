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
import { EnvValue, registerFrameProvider } from '../frame/env.js';
import { DarkTheme, DefaultTheme, resolveTheme } from '../palette.js';

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
  // A provider that **names** a direction plants it as a style too, so the
  // node tree mirrors along with the widgets: `useTheme().direction` is what
  // a `<Slider>` reads, and the `direction` style property is what yoga
  // reads, and they have to be the same answer. Only when this provider named
  // it — every provider publishes a *complete* palette, so planting
  // `theme.direction` unconditionally would pin an inner provider's subtree
  // back to LTR inside a `<box style={{ direction: 'rtl' }}>`.
  const named = value?.direction ?? (wantsDark ? dark?.direction : undefined);
  const boxStyle = useMemo(() => {
    const base = named ? [FILL, { direction: named }] : [FILL];
    return style ? [...base, style] : base.length === 1 ? FILL : base;
  }, [style, named]);
  return h(
    ThemeContext.Provider,
    { value: theme },
    // The palette also crosses into any <Frame> below here (THEME_ENV_KEY):
    // it is the one ambient thing the *app* authors, so a pane that said
    // nothing about colour comes up in the app's palette rather than one
    // frame of default. With no provider at all nothing is published, and
    // the pane follows the desktop by itself — same answer, no bridge.
    h(
      EnvValue,
      { k: THEME_ENV_KEY, value: theme },
      planted(children, theme, boxStyle),
    ),
  );
}

/** What the theme is called on a frame's wire (docs/frame.md). */
export const THEME_ENV_KEY = 'react-x11:theme';

// The child half of the default theme bridge: recreate with the *real*
// provider, because the palette travels two routes — the context widgets
// read, and the `theme` prop planted on a node so `$token` styles resolve
// (#119) — and only ThemeProvider itself feeds both. The bridged value is
// the complete merged palette, so it wins every token; a pane's own inner
// ThemeProvider still overrides below it, which is the opt-out a pane that
// wants its own look already has.
registerFrameProvider(
  THEME_ENV_KEY,
  (value, children) => h(ThemeProvider, { value }, children),
  // directly around the pane's window: `planted` puts the palette on a
  // window among its direct children, and the window is where it must land
  { innermost: true },
);

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
 * Which way the widgets here read — `'ltr'` or `'rtl'`.
 *
 * **What a widget mirrors is not what a box mirrors.** Yoga mirrors the boxes
 * on its own from the `direction` style property, so most of the widget set
 * needs nothing from this: a `<Checkbox>` is a `row` with a gap and a
 * `<ProgressBar>` is two flex ratios, and both come out mirrored without a
 * line of code. This is for the decisions yoga cannot make — which way an
 * arrow key steps, which way a glyph points, which side a menu opens on.
 *
 * It comes from the palette because that is the channel a widget can read
 * during its own render, and because an app with a language menu is already
 * swapping a `<ThemeProvider>`. The provider plants the matching style
 * property as it goes, so the boxes and the widgets under it mirror together.
 *
 * The one case the two can part company is a bare `<box style={{ direction:
 * 'rtl' }}>` wrapped around widgets with no provider: the layout mirrors and
 * a widget's own arithmetic does not. Use a `<ThemeProvider>` to mirror a
 * region that contains widgets. Where a widget is measuring a **pointer**
 * against a laid-out box it reads `node.direction` instead — the coordinate
 * has to be interpreted in the direction the box was really laid out in, or a
 * drag runs backwards.
 */
export function useDirection() {
  return useTheme().direction === 'rtl' ? 'rtl' : 'ltr';
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
    // The click, and nothing else: Space and Enter are a click on anything
    // with an `onClick` now (`Node.defaultKeyDown`, issue #329), so the
    // hand-rolled key mapping that used to live here is gone — and with it
    // the reason a widget answered the keyboard while a hand-built control
    // beside it did not.
    //
    // the event travels: `ButtonProps.onPress` has always been declared as
    // taking one, and a handler that wants `ev.shiftKey` or `ev.detail` —
    // shift-click, double-click — has no other way to get it. From the
    // keyboard it is the synthesized click, carrying the key press's own
    // modifiers, so Shift+Enter still reads as a shift-click.
    onClick: (ev) => onActivate?.(ev),
  };
  const props = disabled
    ? // the node still has to *say* it is disabled: `:disabled` style
      // blocks, the focus rule and the AT-SPI ENABLED state all read the
      // prop off the node, not off the widget's closure
      { disabled: true }
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

/**
 * What every widget label is measured to: the capitals down to the last
 * baseline, rather than the font's line box.
 *
 * **A line box is not the letters.** It is ascent plus descent plus line
 * gap, and the space it leaves over a capital differs from the space under a
 * baseline by `(ascent - capHeight) - descent` — a property of the typeface,
 * not of the design. So a label centred in a row, or padded inside a button,
 * is only ever optically even by luck, and which way it is off changes with
 * the font: at 14px, SF NS leaves 3.7px above the cap against 2.9px below
 * the baseline and the label rides low, while Helvetica leaves 0.7 against
 * 3.2 and it rides high. Nothing in the widget can correct for that, because
 * the widget does not know the face it will be drawn in.
 *
 * Trimming makes the box *be* the letters, so the padding around a label is
 * the padding you asked for and centring centres what can be seen. It is
 * `textBoxTrim` in styling.md — CSS's `text-box-trim: trim-both` with
 * `text-box-edge: cap alphabetic` — and the palette's `paddingY` is sized
 * for the trimmed box.
 *
 * **Labels, not glyph marks.** A check, a submenu arrow or an icon drawn as
 * text is centred on its own middle rather than sitting on a baseline, and
 * cap-trimming its box moves it off centre. Those keep the full line box.
 */
export const capTrim = Object.freeze({ textBoxTrim: 'cap-alphabetic' });

/**
 * How tall a trimmed single-line label comes out at this size — the band the
 * space around a row has to be even about.
 *
 * From the size rather than from the face on purpose: a popup is **sized
 * before it is laid out** (a menu is an X window, and its width and height go
 * to the server with the map request), so the row height cannot wait for a
 * font to be matched. Cap height is 0.70–0.73em in every UI face measured —
 * Arial .717, Helvetica .717, SF NS .704, Verdana .727, DejaVu .729 — so this
 * lands within a pixel of the metrics for all of them, and the trim keeps the
 * label centred inside whatever it lands on.
 */
export const capBand = (fontSize) => Math.round(fontSize * 0.72);

/**
 * The focus ring, as style, for the one part of a widget that has to draw
 * its own — or `null`, to be spread away, when it does not.
 *
 * Every empty control says focus in its border (`borderFocus`), which is the
 * `:focus` tier styling.md asks for: a colour change welcome however focus
 * arrived. A **filled** one — a checked box, a selected radio — has spent
 * that border on the fill and has no colour left to spend, so it says the
 * same thing one ring further out instead.
 *
 * On the part, not the row. The row already draws core's ring, but that one
 * is the *keyboard* tier — `:focus-visible`, so it arrives on Tab and not on
 * a click — and it wraps the label with the well. This is the other tier,
 * and the two stack the same way the border colour and that ring already do.
 *
 * `undefined` for the width when off, never `0`: a node with no
 * `outlineWidth` of its own is one core can leave out of the widened damage
 * rects entirely (`_outlineExtent`, src/nodes.js), and `0` is the documented
 * way to opt *out* of a ring the node would otherwise get.
 */
export const focusRingStyle = (theme, on) =>
  on
    ? {
        outlineWidth: theme.focusRingWidth,
        outlineColor: theme.focusRing,
        outlineOffset: theme.focusRingOffset,
      }
    : null;

/**
 * The geometry of rows on a rounded sheet: how far a row sits inside the
 * sheet's edge, and how round its own corners are.
 *
 * **Concentric corners.** A rounded rect inside a rounded rect only looks
 * like one shape when the two curves share a centre, which happens exactly
 * when the inner radius is the outer radius less the gap between them. Any
 * other pairing leaves the pill's corner either tighter or wider than the
 * sheet's, and the eye reads the mismatch as a wobble along the corner even
 * where it cannot name it. So the inset and the pill's radius are not two
 * numbers a widget picks: given the sheet's radius, choosing one fixes the
 * other, and this returns the pair.
 *
 * The inset is the free choice — a pill has to be *seen* to be inset, and it
 * is also what the popup's own size was measured with — so the widget names
 * it and the radius follows. `radiusPopupItem` is the ceiling rather than the
 * value: a theme that wants rounder pills says so by rounding the sheet they
 * sit on, which is the only way the two can agree.
 */
export const rowRadius = (theme, border, inset) =>
  Math.max(
    0,
    Math.min(
      theme.radiusPopupItem ?? Infinity,
      (theme.radiusPopup ?? 0) - border - inset,
    ),
  );

/** String/number children become a `<text>` with `style`; elements pass
 * through untouched. Strings are labels, so they are trimmed to their
 * letters — see {@link capTrim}. */
export function labelContent(children, style) {
  return React.Children.map(children, (child) =>
    typeof child === 'string' || typeof child === 'number'
      ? h('text', { style: [capTrim, style] }, child)
      : child,
  );
}
