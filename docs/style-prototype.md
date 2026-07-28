# The `style` channel — prototype

Status: **prototype on `feat/style-prop-prototype`**, not the shipped API.
Both channels work today so the suite and the sixteen unconverted components
keep running; `REACT_X11_STYLE_ONLY=1` turns on the end state, where a flat
style prop is an error.

## The rule

One namespace per kind of thing, and no name in both:

- **`style`** — everything CSS has a concept for: layout, paint, text,
  `cursor`, `overflow`, `zIndex`, `pointerEvents`.
- **props** — everything else: `title`, window geometry and size hints,
  `resizable`, `wmClass`, `windowType`, `grab`, `value`, `src`, `focusable`,
  `tabIndex`, `disabled`, handlers. The 3D elements keep flat property props
  (`position`, `material`) — those are object properties, not CSS.

`style` takes an object or a nested array, flattened left-to-right with
falsy entries skipped. That is what replaces the cascade: precedence is
written at the call site instead of resolved by specificity.

```jsx
<box style={[s.card, isWide && s.wide, { backgroundColor: theme.panel }]} />
```

## What it fixes on `<window>`

`width`/`height` on a `<window>` are the real X window's geometry — the user
can drag them, and `flush()` reads them back — so they must never reach the
root yoga node. That used to mean stripping them out of the style bag
(`_yogaProps`), and it forced the size hints to hide inside a `sizeHints`
object because `minWidth`/`maxWidth` were already taken by yoga.

With the split, both workarounds go:

```jsx
<window
  title="Editor"
  width={900}
  height={600}
  x={40}
  y={40} // the X window
  minWidth={400}
  minHeight={300}
  resizable // WM hints, flat, no nesting
  style={{ flexDirection: 'row', backgroundColor: '#1e1e1e' }} // the root box
/>
```

`WINDOW_HINT_PROPS` is mapped back to ntk's `sizeHints` shape in
`windowAttributes()`, and `style.backgroundColor` is forwarded as the window's
creation attribute — the ntk contract is unchanged, only the call site is.

## Inline pseudo-states

The thing inline CSS cannot do, and the reason people keep a stylesheet:

```jsx
<box
  style={{
    backgroundColor: theme.surface,
    ':hover': { backgroundColor: theme.surfaceHover },
    ':focus': { borderColor: theme.borderActive },
  }}
/>
```

`:hover`, `:focus`, `:active`, `:disabled`. These are **node states, not
selectors** — each is something the node itself already knows, so resolving
them needs no cascade, no specificity and no tree walk. The event manager
already tracks the hover path and the focused node; a state change now
recomputes one node's style and repaints. **No React render.**

Precedence is fixed and low-to-high: `:hover` → `:focus` → `:active` →
`:disabled`, merged per property, so a disabled control never looks hovered.
Because the hover _path_ is the ancestor chain, hovering a child lights up an
ancestor's `:hover` block, exactly like CSS.

**State blocks may only set paint properties** (`backgroundColor`,
`borderColor`, `borderRadius`, `zIndex`, `color`) — enforced at declaration
time by `createStyles`. A `:hover` that could set `padding` would reflow the
tree on pointer move: jitter, and the end of the "hover is a repaint" property
that makes this worth having. Anything that changes layout or what renders
stays in React state.

## `createStyles`

Identity is the point — a hoisted style object lets `applyProps` skip the
whole update with a `===` check, the same reason RN's `StyleSheet.create`
still exists now that its id registry is gone. It also validates keys, which
a bare object literal cannot: an unknown style property is an error at
declaration instead of a silent no-op.

## What this replaces in components

`useControl(disabled, onActivate, { styled: true })` stops holding hover and
focus in React state: no enter/leave handlers, no re-render on pointer move.
`Switch` is converted as the worked example. Compare the old forwarding —
`{...props, ...boxProps}`, where a caller's `backgroundColor` silently
clobbered the computed one — with `style: [base, checked && on, style]`,
where precedence is stated.

## Decided

- **`':hover'`, not `_hover`.** The CSS spelling costs a pair of quotes and
  buys transfer from every other styling system.
- **Transitions come later.** They are what turns `:hover` from a
  nice-to-have into the reason to adopt this — and they are also the one
  item that puts an animation loop in the renderer, so they land as their
  own change rather than riding along with the namespace split. When they
  do, they close the "Switch animation" item in NEXT_STEPS §2, which is
  really a request for this feature.

## Not done here

Converting the other fifteen components, the examples beyond `dashboard.jsx`,
the docs, and deleting the legacy branch in `Node._syncStyle`. Theme tokens
(`backgroundColor="panel"` resolved through `ThemeProvider`) and window size
queries — the X11 analogue of `@media`, and layout-capable, since they are
only re-evaluated during a layout pass that resize already triggers — are the
follow-ons after transitions.
