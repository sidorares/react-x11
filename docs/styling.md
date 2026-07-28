# Styling

Style lives in one place: the `style` prop. A style property passed flat is
an error in development that names the fix, rather than the silent no-op an
unrecognised prop used to be.

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

## In components

Every component takes `style` and merges it after its own, so an override
wins by position instead of clobbering a computed value:
`style: [control.style, base, checked && on, style]`.

`useControl(disabled, onActivate, { styled: true })` stops holding hover and
focus in React state: no enter/leave handlers, no re-render on pointer move.
`Switch` is the worked example.

A component's own props are never style. `ProgressBar` takes `color`,
`Dialog` takes `width`/`height` — a dialog is a real popup window and needs
its geometry up front — and `ContextMenu` takes `fontSize` because it
measures labels with it. `Select` and `Slider` used to take `width` purely
to put it in their own box; that is `style={{ width }}` now.

## Decided

- **`':hover'`, not `_hover`.** The CSS spelling costs a pair of quotes and
  buys transfer from every other styling system.
- **Transitions come later.** They are what turns `:hover` from a
  nice-to-have into the reason to adopt this — and they are also the one
  item that puts an animation loop in the renderer, so they land as their
  own change rather than riding along with the namespace split. When they
  do, they close the "Switch animation" item in NEXT_STEPS §2, which is
  really a request for this feature.

## Elements that are not styled

The 3D scene elements and the declarative SVG children carry their own
vocabularies — `position`, `color` and `width` mean a transform, a material
and a radius there — so the style channel does not apply to them, the same
way it does not apply to an `<input type>` in the DOM. They report
`stylable === false` and their props are passed through untouched.

## Next

Theme tokens (`backgroundColor="panel"` resolved through `ThemeProvider`) and
window size queries — the X11 analogue of `@media`, and layout-capable, since
they are only re-evaluated during a layout pass that resize already triggers
— are the follow-ons after transitions.
