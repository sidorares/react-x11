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

`:hover`, `:focus`, `:active`, `:disabled`, `:drag-over`, `:dragging`.
These are **node states, not selectors** — each is something the node itself
already knows, so resolving them needs no cascade, no specificity and no
tree walk. The event manager already tracks the hover path and the focused
node; a state change now recomputes one node's style and repaints. **No
React render.**

Precedence is fixed and low-to-high: `:hover` → `:focus` → `:active` →
`:disabled`, merged per property, so a disabled control never looks hovered.
Because the hover _path_ is the ancestor chain, hovering a child lights up an
ancestor's `:hover` block, exactly like CSS.

The last two belong to drag and drop. `:drag-over` follows the pointer
during a drag on exactly the same ancestor-path rule as `:hover` — and,
like `:hover`, it says where the pointer is, not whether the node would
accept the drop; `useDropTarget`'s `isAccepted` is the one that answers
that. `:dragging` is set on the source node for the duration of a drag.
See [drag-and-drop.md](drag-and-drop.md).

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

## `flattenStyle`

`flattenStyle(style)` collapses whatever the `style` prop accepts — an
object, an array, nested arrays, holes — into one plain object, which is what
the reconciler itself does before applying props. Two details are worth
knowing if you call it: a lone object is returned **as-is**, not copied, so
`===` still identifies a hoisted style; and a state block merges with one
already collected rather than replacing it, so
`[{ ':hover': { color } }, { ':hover': { backgroundColor } }]` keeps both.

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

A style value of `'$name'` resolves against the nearest theme above the node
— `<ThemeProvider value={palette}>`, or a `theme` prop on any element. The
sigil is what keeps it unambiguous: `'red'` is a CSS colour, `'$red'` is a
token.

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

An unknown token is an error naming what the theme does have, and a token
with **no** theme above it at all warns in dev — that one is otherwise
silent, since the whole style is stripped rather than one value failing.
Resolution is cached per (style object, theme object), so a hoisted style
under one theme keeps its identity across renders and the `===` fast path
still applies.

Resolution walks the node tree, not React context, so a palette has to reach
the tree to be seen. `<ThemeProvider>` puts it in both places — the context
widgets read with `useTheme()`, and a `theme` prop on a node — which is what
makes provider and token one mechanism rather than two
([components.md](components.md#theming)). Widgets plant their own merged
palette on their root node as well, so `$tokens` work inside a widget
subtree — and in a style you pass one — with no provider anywhere.

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
