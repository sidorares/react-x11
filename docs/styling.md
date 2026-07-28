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

## Theme tokens

A style value of `'$name'` resolves against the nearest `theme` prop above
the node. The sigil is what keeps it unambiguous: `'red'` is a CSS colour,
`'$red'` is a token.

```jsx
const s = createStyles({
  card: { backgroundColor: '$panel', padding: '$gutter' },
  title: { color: '$text', fontSize: 20 },
});

<window theme={palette} style={{ backgroundColor: '$bg' }}>
  <box style={s.card}>…</box>
</window>;
```

That is the point of tokens: the style is **hoisted** — declared once,
outside render, with no access to React context — and still follows the
theme. Without them a palette has to be threaded to every element that
paints (`style={[s.card, { backgroundColor: theme.panel }]}`).

Tokens are not colour-only; `padding: '$gutter'` resolves a number just as
well.

A `theme` prop anywhere scopes its subtree, and an inner one merges over the
outer, so a panel can restate a colour or two without repeating a palette.
Popups resolve through their place in the **tree**, not their window, so a
menu inherits the theme of the UI that opened it even though it is a
separate X window.

Changing the theme restyles the subtree in place. Nodes whose own props did
not change are still updated — which is why a theme change also drops the
memoised text layouts under it, or cached text would keep painting the old
colour.

An unknown token is an error naming what the theme does have. Resolution is
cached per (style object, theme object), so a hoisted style under one theme
keeps its identity across renders and the `===` fast path still applies.

Widgets plant their merged palette (`ThemeProvider` + the built-in defaults)
on their own root node, so `$tokens` work inside a widget subtree — and in a
style you pass one — even when the app only used `<ThemeProvider>`.

## Transitions

`transition` names how long a change takes. A number covers every animatable
property; an object picks them individually.

```jsx
<box
  style={{
    backgroundColor: theme.surface,
    transition: 120, // or { backgroundColor: 120, left: 200 }
    ':hover': { backgroundColor: theme.surfaceHover },
  }}
/>
```

Numbers lerp and colours lerp per channel through ntk's own CSS colour
parser, so anything the paint path accepts animates. A value with no
meaningful midpoint — an enum like `flexDirection`, a percentage, `auto` —
snaps instead, and `zIndex` is excluded on purpose: restacking every frame is
not an animation.

The easing is a fixed ease-out cubic. A transition starts from **what is on
screen**, not from the declared value, so interrupting one reverses from
where it got to rather than jumping to the end first.

The animation _is_ the repaint loop: the window keeps asking its frame clock
for frames while any transition is unfinished, and stops the frame the last
one lands. Nothing polls, and there is no per-widget
`requestAnimationFrame`.

Transitions may animate layout properties, unlike state blocks. That is not
an inconsistency: a pointer move must never reflow the tree, but an author
who writes `transition: { left: 200 }` has asked for animated layout and
pays a layout pass per frame for it. `Switch` is the worked example — the
thumb is absolutely positioned and slides on `left`, because
`justifyContent` would flip between the ends with nothing in between.

## Window size queries

`'@width >= 600'` and friends are the X11 analogue of `@media`: what a style
can usefully ask about here is the window it is laid out in, not the screen.

```jsx
const s = createStyles({
  bar: {
    flexDirection: 'column',
    gap: 4,
    '@width >= 600': { flexDirection: 'row', gap: 16 },
  },
});
```

`width` and `height`, with `>=`, `<=`, `>` or `<`. Blocks that match are
merged in declaration order, before state blocks — so a `:hover` inside the
wide layout still wins over the wide layout.

**A size query may set layout properties, unlike a state block.** That is
not an inconsistency: a pointer state must never reflow the tree, but a size
query is only ever re-evaluated inside a layout pass that a resize has
already required, so it costs nothing extra. Nodes that declare one are
registered with their window and re-resolved just before it lays out, and
only when the size actually changed.

A malformed query is an error rather than a key that silently never
matches.

## Decided

- **`':hover'`, not `_hover`.** The CSS spelling costs a pair of quotes and
  buys transfer from every other styling system.

## Elements that are not styled

The 3D scene elements and the declarative SVG children carry their own
vocabularies — `position`, `color` and `width` mean a transform, a material
and a radius there — so the style channel does not apply to them, the same
way it does not apply to an `<input type>` in the DOM. They report
`stylable === false` and their props are passed through untouched.

## Next

`opacity` (needs offscreen composition — see NEXT_STEPS §3), and per-node
container queries if the window-level ones prove too coarse.
