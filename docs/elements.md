# Elements

Only `<window>`, `<popup>`, `<glarea>` and `<foreign>` are backed by real
X11 windows, created top-down in React's commit phase so every
`CreateWindow` names its actual parent — and, for `<foreign>`, so that no
`ReparentWindow` is ever issued from a render React might discard.
Everything else is a retained lightweight node — one
[yoga-layout](https://www.yogalayout.dev/) node each — painted into the
owning window's double-buffered 2d context on ntk's frame clock.

## `style` and props

Everything CSS has a concept for goes in **`style`**; everything else is a
prop. No name means both, which is why `<window width>` is unambiguously the
real window's geometry. See [styling.md](styling.md) for arrays, state
blocks and `createStyles`.

```jsx
<box style={{ flexDirection: 'row', gap: 8 }} onClick={pick}>
  <text style={{ fontSize: 14, color: '#2d3436' }}>hello</text>
</box>
```

## Layout properties (all drawn elements + windows)

Numbers are pixels, strings like `'50%'` / `'auto'` pass through to yoga.

- **Size**: `width`, `height`, `minWidth`, `minHeight`, `maxWidth`,
  `maxHeight`, `aspectRatio`. `<image>` and `<svg>` keep their aspect ratio
  when only one of `width`/`height` is given
- **Flex**: `flexDirection` (`row`, `column`, `row-reverse`,
  `column-reverse`), `justifyContent` (`flex-start`, `center`, `flex-end`,
  `space-between`, `space-around`, `space-evenly`), `alignItems`,
  `alignSelf`, `alignContent`, `flexWrap`, `flex`, `flexGrow`, `flexShrink`,
  `flexBasis`, `gap`, `rowGap`, `columnGap`
- **Position**: `position` (`relative`, `absolute`, `static`), `top`,
  `right`, `bottom`, `left`
- **Spacing**: `margin`, `marginTop/Right/Bottom/Left`, `padding`,
  `paddingTop/Right/Bottom/Left`
- **Visibility**: `display` (`flex`, `none`), `overflow` (`visible`,
  `hidden`, `scroll`)

### Everything shrinks, nothing shrinks to nothing

`flexShrink` is `1`, as in CSS: an item hands back the space it has spare
when the row it is in runs short, rather than pushing the row past its
container. And **it never gives up what is inside it** — every item carries a
floor of its own min-content size, which is CSS's automatic minimum size
(`min-width: auto` on a flex item) written out by the renderer, since yoga
implements the shrinking half and not the floor half. A row of chips squeezes
until it wraps; a label squeezes to its longest word; a `height: 40` row
stays 40 tall.

Three ways a style says otherwise:

| write                             | to mean                                   |
| --------------------------------- | ----------------------------------------- |
| `flexShrink: 0`                   | never give up any space at all            |
| `minWidth: 0` / `minHeight: 0`    | this may shrink past its content, to zero |
| `overflow: 'hidden'` / `'scroll'` | the same, and clip what no longer fits    |

The last two are CSS's own rule — `min-*: auto` computes to `0` on anything
whose overflow is not `visible` — and they are what makes a scroll pane
possible: a viewport is a box that is _allowed_ to be smaller than what is
inside it. A `<box overflow="scroll">` gets `minWidth: 0` and `minHeight: 0`
for free.

One deliberate difference from CSS: **a size that was named is kept**. CSS
floors an item at `min(the size it was given, its content)`, so an empty
`height: 40` box squashes to nothing in a column too short for it; that is
survivable on the web because a `<div>` is a _block_ container and its
children are not flex items at all, and it is not survivable here, where
every box lays its children out with flex. Say `minHeight: 0` to get CSS's
answer for one.

The measurement costs the tree an extra layout pass per axis, on frames that
change the layout — a scroll, which moves no box, keeps the single pass it
always had.

### `flex`, the shorthand

`flex: 1` is `{ flexGrow: 1, flexShrink: 1, flexBasis: 0 }` — "take this
share of what is left, from a base size of nothing" — which is what makes it
the right thing for a pane that should fill its window rather than its
content. `flex: 'auto'` grows and shrinks from the content's own size, and
`flex: 'none'` does neither. A longhand written beside it wins, so
`{ flex: 1, flexBasis: 'auto' }` reads the way it does in CSS.

## Paint properties

- `backgroundColor` — any CSS color string (`'#2980b9'`,
  `'rgba(0,0,0,.5)'`, `'red'`)
- `borderWidth`, `borderColor`, `borderRadius`, `borderStyle`
  (`'solid'` default, `'dashed'`)
- per-side borders: `borderTopWidth`/`Right`/`Bottom`/`Left` override
  `borderWidth` the way `paddingLeft` overrides `padding`, and
  `borderTopColor`/… fall back to `borderColor`. A blockquote's bar is
  `borderLeftWidth: 3` on the quote box, not a 3px sibling; a table rule is
  `borderBottomWidth: 1` on the row. `borderRadius` requires uniform
  borders — a non-uniform border paints square
  ([styling.md](styling.md#per-side-borders))
- `zIndex` — paint/hit order among siblings (stable sort)
- `outlineWidth`, `outlineColor`, `outlineOffset` — the focus ring, painted
  outside the border box and invisible to yoga, so it never moves what it
  surrounds. A focusable node draws one on `:focus-visible` without being
  asked; `outlineWidth: 0` opts out
  ([styling.md](styling.md#the-focus-ring))
- `transition` — `120`, or `{ backgroundColor: 120, left: 200 }`: how long a
  change to that property takes ([styling.md](styling.md#transitions))
- any value may be a **theme token**: `'$panel'` resolves against the nearest
  `theme` prop above the node ([styling.md](styling.md#theme-tokens))
- `'@width >= 600'` blocks restyle for the window's size, layout included
  ([styling.md](styling.md#window-size-queries))
- `opacity` is not implemented yet (see NEXT_STEPS.md)

`cursor` (`'pointer'`, `'text'`, `'wait'`, `'move'`, `'crosshair'`, resize
arrows, … — the ntk cursor name map) and `pointerEvents: 'none'` are style
too: CSS has both, and React Native has been moving `pointerEvents` the same
way. So is `hitSlop`:

```jsx
<box style={{ height: 16, hitSlop: { top: 4, bottom: 4 } }} /> // 24px target
```

`hitSlop: 4` grows every side, the object form only the sides it names. It
is **hit testing and nothing else** — not paint, not yoga — which is what
lets a 16px control answer over the 24px WCAG 2.2 SC 2.5.8 wants without a
taller control misaligning the row it sits in. The slop may overlap a
sibling's box; hit testing runs front to back over paint order, so the
sibling on top keeps its own pixels either way.

## Interaction props

`focusable`, `tabIndex` (sequential focus order; `-1` is focusable but not
tabbable), `autoFocus`, `trapFocus` (own a focus scope — Tab and presses
stay inside it, focus is restored when it unmounts), `disabled` (never
focusable, and the trigger for a `:disabled` style block), and the event
handlers listed in [events.md](events.md).

Every element also takes `role` and the `aria-*` props — the web's
accessibility vocabulary, read by the built-in AT-SPI bridge so screen
readers see the tree. They are inert where no assistive technology is
listening, and the defaults already say something sensible for every
element: [accessibility.md](accessibility.md).

Drag and drop is two more prop families on the same elements —
`dropAccept` + `onDrop` to accept a drop, `draggable` + `dragData` to start
a drag — and works with other X11 applications as well as inside the app.
Their presence is what registers the node, so there is nothing else to
mount: [drag-and-drop.md](drag-and-drop.md).

`selectable` makes an element a **selection surface**: text inside it can be
dragged over, copied and handed to the PRIMARY selection. See
[Selecting text](#selecting-text) below.

---

## `<window>`

A real X11 window; the flex, paint and event root for its subtree.

| prop                        |                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`                     | window title (UTF-8, via `WM_NAME` + `_NET_WM_NAME`)                                                                                                                                                    |
| `width`, `height`, `x`, `y` | window geometry (window state, not yoga style — the user may resize). A size is pixels or `'auto'`, and leaving it out means `'auto'` (below)                                                           |
| `backgroundColor`           | full-window clear color (default white)                                                                                                                                                                 |
| `onResize(ev)`              | ConfigureNotify — the tree reflows automatically. Fires for **moves** too (see below)                                                                                                                   |
| `onExpose(ev)`              | after a repaint was required                                                                                                                                                                            |
| `onCloseRequest(ev)`        | WM close button — replaces the default answer (see below); `WM_DELETE_WINDOW` is advertised either way                                                                                                  |
| `states`                    | EWMH `_NET_WM_STATE` — controlled, see below                                                                                                                                                            |
| `fullscreen`, `alwaysOnTop` | boolean sugar for two of those states                                                                                                                                                                   |
| `decorations`               | `false` asks the WM for no titlebar or border                                                                                                                                                           |
| `transparent`               | 32-bit ARGB visual — rounded, translucent windows (below)                                                                                                                                               |
| `transientFor`              | ICCCM `WM_TRANSIENT_FOR` — the window this one belongs to (below)                                                                                                                                       |
| `onStatesChange(states)`    | what the window manager actually did                                                                                                                                                                    |
| `onClientMessage(ev)`       | a ClientMessage addressed to this window — EWMH, XEmbed, the tray (below)                                                                                                                               |
| `theme`                     | palette that `$token` style values resolve against, for this subtree                                                                                                                                    |
| `embeddable`                | created but never self-mapped: the window waits for an embedder ([`<foreign>`](embedding.md) on the other side), which maps it after the reparent. What a [`<Frame>`](frame.md) pane's root window sets |

Windows may be nested inside other windows (real X11 child windows).
**Ref**: the live ntk `Window` — `getContext('2d')`,
`requestAnimationFrame`, `setCursor`, the whole ntk API.

### Natural size

A window with no `width`/`height` is **sized from its content and capped at
the screen**. `'auto'` says the same thing out loud, and the two axes are
independent:

```jsx
<window title="prefs" />                               {/* natural, both ways */}
<window width={600} height="auto" />                   {/* height follows the content */}
<window width="auto" maxWidth={720} minHeight={200} /> {/* auto within your own bounds */}
```

This is CSS's `width: auto`, read the way CSS reads it for a box whose
containing block is the viewport but which is not in flow — a float, an
abspos, an inline-block: **shrink-to-fit**. A top-level window has no
container to stretch into, and stretching into the screen is what
`fullscreen` means.

The size is worked out **before `CreateWindow`**, so the window is created
the right size rather than resized into it after mapping. Nothing is ever on
screen at the wrong size, and there is no jump to watch for.

**How it is measured**, which is worth knowing because the second step is
where the surprises are:

1. The tree is laid out with no available width, so nothing wraps and the
   root reports its **max-content** width.
2. That is clamped into `[minWidth, min(maxWidth, the screen)]` — the same
   size-hint props the window manager enforces also bound the auto size,
   exactly as `min-width`/`max-width` bound `width: auto` in CSS. Where the
   two disagree, `minWidth` wins, which is CSS's order too.
3. The tree is laid out **again at that width**, and the height comes from
   there. A paragraph that had to wrap is taller than step 1 said.

Where this parts company with CSS: shrink-to-fit is
`min(max(min-content, available), max-content)`, and that `max(…)` means a
CSS box never shrinks below its min-content size even when it overflows. A
window cannot be wider than the screen, so the cap wins and the content is
cut instead.

**The cap** is the usable area of the monitor the window will open on:
Xinerama's per-monitor rects — so a window on a two-head desktop is bounded
by one screen and not by both — with `_NET_WORKAREA` taken off it per axis,
so a panel is not space to grow into. Both are read once while `createRoot()`
connects. On a server with neither, the cap is the screen; with no display to
ask at all — the headless mock — there is no cap. The window manager's frame
is _not_ modelled, so a window that reaches the cap is a titlebar taller than
the work area and the WM will trim it.

**Afterwards, auto keeps up with the content until something else sets the
size.** Add a row and the window grows; the moment the user drags an edge, or
a window manager answers with a size of its own, the window is theirs and
stops re-fitting. Setting `width` to a number is the app doing the same
thing, and setting it back to `'auto'` hands it back.

### A floor the content decides

`minWidth`/`minHeight` also take `'auto'`: **the smallest size the content
can be drawn at**, measured from the tree and handed to the window manager,
which is what stops the user dragging the window below it.

```jsx
<window minWidth="auto" minHeight="auto">   {/* never smaller than my content */}
<window width={900} minWidth="auto" />      {/* my opening size, the content's floor */}
```

This is what Qt and GTK both do, and in both it is the default rather than
something you ask for: a Qt layout's `minimumSize()` becomes the window's
via `QLayout::SetDefaultConstraint`, and GTK writes the widget tree's
minimum into the WM geometry hints. Here it is opt-in, because a renderer
whose layout is CSS has no floor unless one is asked for — CSS lets content
overflow.

**How the floor is measured**: the tree is laid out with _no room at all_,
and the floor is how far it still reached. What each node contributes is
whatever its own style lets it shrink to, which makes the interesting part
what _doesn't_ count:

| the node                          | contributes      |
| --------------------------------- | ---------------- |
| a box that named a size           | that size        |
| a wrapping row                    | its widest item  |
| text                              | its longest word |
| `overflow: 'scroll'` / `'hidden'` | nothing          |
| a `minWidth: 0` of its own        | nothing          |
| a `minWidth: 240` of its own      | 240              |

A registered element contributes whatever its `measureContent` answers when
asked for the smallest size it can be drawn at — see
[extending.md](extending.md#a-size-of-your-own).

This is the same measurement every node's own floor comes from (above), read
at the top of the tree — so the escape hatch is the same one, and it is the
one CSS, Qt and GTK all spell: `min-width: 0`, `QScrollArea`,
`min-content-width`. A node that named a floor of its own is taken at its
word and its contents stop counting, so a window around a scrolling pane is
floored by everything _except_ that pane.

`maxWidth`/`maxHeight` take `'auto'` as well, and it means the other half of
the pair: **the size the content wanted** — the natural size above, not the
floor. `'auto'` reads as "ask the content", and the content's answer to _how
big_ is not its answer to _how small_. On a tree where nothing can shrink
the two are the same number, which is what makes `minWidth="auto"
maxWidth="auto"` the fixed-size dialog — the same thing `resizable={false}`
says more briefly.

Three things worth knowing:

- **A floor is a request.** mutter, kwin and xfwm enforce it at the drag; a
  tiling window manager may size the window however it likes. It stops the
  user, it does not relieve the app of clipping gracefully — and the
  renderer will not fight a window manager that ignores it.
- **`minHeight="auto"` is measured for the width the window has**, and
  re-sent as that changes. A minimum height is a height _for a width_ — a
  paragraph is tallest at its narrowest — and `WM_NORMAL_HINTS` holds two
  independent numbers with no way to say so. (GTK answers the same question
  at its minimum _width_, which is a taller floor than a wide window needs.)
- **The floor outlives the size.** An `'auto'` size stops tracking once the
  user takes the window over; an `'auto'` bound does not, because stopping
  them going too far is the whole job. It is measured on every frame that
  lays out — one extra layout pass per axis asked for — and written only on
  the frames it actually moves.

Three things worth knowing before reaching for it:

- A scroll container reports its **content** height, not a viewport height,
  so an auto window around a long list opens as tall as the screen. Give the
  window a `height`, or the scrolling box a `maxHeight`, if the scrolling is
  meant to happen inside a smaller window.
- The natural size is measured with **no available width**, where nothing
  wraps and nothing is short of room to shrink into, so an auto width is the
  **unwrapped** row. That makes the width font-dependent: the same window is
  wider under a wide UI face than under a narrow one.
- Measuring costs an extra layout pass per frame that lays out, for as long
  as the window is still tracking. A window with both sizes given pays
  nothing.

### `onResize` fires for moves

`onResize` is X's `ConfigureNotify`, which reports _any_ geometry change:
under a window manager that moves windows opaquely, dragging one by its
title bar delivers one per pointer step, all the same size. The renderer
already discriminates — a move costs no layout and no repaint — but a
handler of your own has to, or it does its work per step of a drag. The
event says which it was:

```jsx
<window
  onResize={(ev) => {
    if (ev.resized) refit(ev.width, ev.height);
    if (ev.moved) rememberPosition(ev.x, ev.y);
  }}
/>
```

`ev.previous` carries the geometry these are measured against. Note that
`ev.x`/`ev.y` are frame-relative once a reparenting window manager has
framed the window, so they are not screen coordinates — the renderer
resolves the real origin itself for popup anchoring.

### Stacking

Nested `<window>`s stack the way drawn siblings paint: the later sibling
sits on top, and `zIndex` wins over document order. Reordering them in JSX
restacks the real windows — one `ConfigureWindow` pass per commit, and
nothing at all when mount order already agrees.

```jsx
<window>
  <window key="back" /> {/* bottom */}
  <window key="front" /> {/* on top */}
  <window key="always" zIndex={1} /> {/* above both, wherever it sits here */}
</window>
```

Top-level windows are the window manager's to stack — it redirects the
request — so their order in the tree carries no stacking meaning. Use
`alwaysOnTop` (below) for those.

### Window manager hints

Properties the window manager reads (ntk ≥ 3.5.0). All work at mount and
update; unchanged values are not re-sent. The size hints are flat props like
the geometry they constrain — with style in its own channel the yoga names
are free, so no `sizeHints` object is needed.

| prop          |                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `resizable`   | `false` pins min and max size to the current size                                                                                         |
| size hints    | `minWidth`, `minHeight`, `maxWidth`, `maxHeight`, `widthInc`, `heightInc`, `baseWidth`, `baseHeight`, `minAspect`, `maxAspect`, `gravity` |
| `wmClass`     | `'instance'`, `['instance', 'Class']` or `{instance, class}`                                                                              |
| `windowType`  | `'dialog'`, `'utility'`, `'tooltip'`… or an array of fallbacks                                                                            |
| `decorations` | `false` asks for no titlebar or border                                                                                                    |

```jsx
<window width={400} height={300} resizable={false} windowType="dialog" />
<window width={400} height={300} minWidth={320} minHeight={200} />
<window width={400} height={300} minWidth="auto" /> {/* measured — see above */}
```

The four bounds also take `'auto'`, which asks the content instead of naming
a number: [a floor the content decides](#a-floor-the-content-decides).

On a `<window>` these names are the window's, not yoga's: `width`/`height`
are the real geometry the user can drag, and `minWidth`/`maxHeight` are what
the WM enforces. A window's _contents_ are laid out by its `style`. The size
hints do double duty on an auto-sized window, where they also bound the
natural size (above) — so `resizable={false}` pins the window at whatever its
content measured, which is the fixed-size dialog:

```jsx
<window resizable={false} windowType="dialog" />
```

### `transientFor` — a window that belongs to another

Without it, every secondary top-level window an app opens is, to the window
manager, an unrelated second application: its own taskbar and alt-tab entry,
placed wherever new windows go, stacked independently, and it does not
minimise with the window it belongs to.

```jsx
const main = useRef(null);

<window ref={main} title="editor">…</window>
<window transientFor={main} windowType="dialog" title="Preferences">…</window>
```

Takes a ref to a `<window>`/`<popup>`, a ref to **any drawn node** (resolved
to the window that owns it — so an out-of-flow `<box>` inside the owner is a
perfectly good handle), a raw XID, `'root'` for "transient for this client's
whole window group", or `null` to clear.

Measured against quartz-wm — the thinnest EWMH implementation in the stack,
so this is a floor rather than a best case:

| the client sets       | the WM allows                                                 | the WM adds to `_NET_WM_STATE` |
| --------------------- | ------------------------------------------------------------- | ------------------------------ |
| nothing               | close, minimize, move, resize, maximize horz/vert, fullscreen | —                              |
| `transientFor`        | close, minimize, move, resize                                 | skip_taskbar, skip_pager       |
| `windowType="dialog"` | close, minimize, move, resize                                 | skip_taskbar, skip_pager       |

Rows two and three matching is the EWMH rule working as specified: a managed
window with `WM_TRANSIENT_FOR` and no `_NET_WM_WINDOW_TYPE` **is** a dialog.
The converse does not hold — a `dialog` type with no owner is a dialog
belonging to nobody, with nothing to stack above or iconify with — so set
both, which is what real toolkits do. A fuller window manager also restacks
the transient above its owner and iconifies it alongside; quartz-wm does
neither, and both are policy rather than spec.

**It is inert on an override-redirect window**, which is every `<popup>` by
default: the WM never manages those, so nothing reads the property. ICCCM
4.1.2.6 draws exactly that distinction — `WM_TRANSIENT_FOR` for windows the
WM manages, override-redirect plus a pointer grab for menus. ntk warns if
you ask it to write the property on one.

Resolution happens in the **commit phase**, not at element creation: a React
ref is not something ntk should be asked to understand. Refs attach in the
layout phase, after every mutation, so on the commit that mounts two sibling
`<window>`s the second realizes while the first one's ref is still null —
that owner is retried on the frame the mount schedules rather than dropped.

`windowIdOf(refOrInstance)` is the same resolution, exported: it returns the
XID a ref points at, or null. It is also what an xdg-desktop-portal
`parent_window` handle needs — `` `x11:${id.toString(16)}` ``, lowercase hex
with **no** `0x` prefix. Both shipping portal backends happen to tolerate a
prefix, which is exactly why it is easy to get wrong and never notice; Qt's
parser returns 0 on failure with no error path, so the symptom would be a
silently unparented, non-modal dialog. `useWindowId(ref)` is the hook form
and returns a getter, like `useAnchor`.

`decorations={false}` writes `_MOTIF_WM_HINTS` — honoured by Mutter, KWin,
Xfwm, Openbox and i3. A window manager that ignores it simply decorates the
window; there is no way to force the matter.

### Closing a window

Every window the window manager manages advertises `WM_DELETE_WINDOW` in
`WM_PROTOCOLS`, whether or not you pass `onCloseRequest`. That property is
what lets the WM _ask_ a window to close; a client without it can only be
shot, so the close button becomes `XKillClient` — the connection dies
mid-frame, effects never clean up, and IceWM asks the user to confirm the
kill first. Advertising it is not an opt-in feature, it is the difference
between closing and crashing, so react-x11 does it for you.

Windows the WM does not frame never advertise it, because nothing would read
it: a child `<window>` (a region inside another window) and an
override-redirect `<popup>`. A [managed `<popup>`](#a-managed-popup-is-a-dialog)
is a real dialog and does.

What a close request _does_ is the part you can change:

|                     |                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no `onCloseRequest` | the **primary window** unmounts the tree and closes the connection — effects clean up and the process ends on a drained loop. Any other window refuses, and warns in dev. |
| `onCloseRequest`    | nothing happens except your handler: `setOpen(false)` for a dialog, a "save your work?" prompt, `root.unmount()` for a quit of your own.                                  |

The primary window is inferred, not declared: the first top-level `<window>`
that is not `transientFor` another and has no `windowType` of its own. A
one-window app — nearly every app — is unambiguous, and a lone window is the
app whatever type it declares.

The refusal for secondary windows is deliberate. A `{open && <window/>}` was
opened by a `setOpen(true)` somewhere, and closing it behind React's back
would leave a window the app still believes is open and can never reopen. So
a dialog wants a handler:

```jsx
{
  showSettings && (
    <window
      title="Settings"
      transientFor={main}
      onCloseRequest={() => setShowSettings(false)}
    />
  );
}
```

### Window state

`states` is EWMH `_NET_WM_STATE`: `modal`, `sticky`, `maximized` (or
`maximized_vert`/`maximized_horz` individually), `shaded`, `skip_taskbar`,
`skip_pager`, `hidden`, `fullscreen`, `above`, `below`, `demands_attention`,
`focused`. `fullscreen` and `alwaysOnTop` are boolean sugar for the two
everyone reaches for — `fullscreen` and `above` — and they union with
`states` rather than competing with it.

```jsx
<window
  states={['skip_taskbar']}
  fullscreen={isFullscreen}
  onStatesChange={(states) => setFullscreen(states.includes('fullscreen'))}
/>
```

**These are controlled props, and the reason is not React convention.** On X
the window manager changes state behind the app's back constantly: the user
hits maximize, a global hotkey leaves fullscreen, a tiling WM has its own
opinion. react-x11 therefore diffs `states` against the _previous props_,
never against what the window currently has — so a prop is re-sent only when
the app changes its mind, and a WM that disagreed is not fought on the next
commit. `onStatesChange` is the other half: it reports what the WM actually
did, and subscribing to it is what makes react-x11 watch the property, so a
window without a handler costs nothing.

States are applied **before the window is mapped**, which is what EWMH 7.7
requires and the only way to open already fullscreen instead of flashing at
the normal size first.

`alwaysOnTop` falls back to Apple-WM window levels on XQuartz, where
quartz-wm does not support `_NET_WM_STATE_ABOVE`.

### `onClientMessage` — speaking a protocol of your own

Nearly every convention layered over X11 is carried by ClientMessage: EWMH's
requests to the window manager, XEmbed, the system tray, and whatever two
copies of one application agree between themselves. `onClientMessage` is
every one of them that was addressed to this window.

```jsx
<window
  onClientMessage={(ev) => {
    if (ev.messageType !== '_NET_SYSTEM_TRAY_OPCODE') return;
    if (ev.data[1] === SYSTEM_TRAY_REQUEST_DOCK) dock(ev.data[2]);
  }}
/>
```

`ev.messageType` is the atom's **name**, which is the point: without it a
handler has to intern its atoms first and compare numbers, and cannot say
anything at all until those round trips have landed. `ev.atom` is the id it
came in as, `ev.format` is 8, 16 or 32, and `ev.data` is the payload at that
width — 5 values at 32, 10 at 16, 20 at 8.

Nothing has to be armed. A ClientMessage reaches its window's owner whatever
event mask that window selected, so a `<window>` without the prop pays
nothing and one with it needs no other setup.

Three things worth knowing:

- **Messages arrive in the order they were sent.** The chunked protocols
  depend on it — `_NET_SYSTEM_TRAY_BEGIN_MESSAGE` and the
  `_NET_SYSTEM_TRAY_MESSAGE_DATA` pieces after it reassemble by arrival order
  and nothing else. Naming a type this connection has never seen costs one
  `GetAtomName`, and everything behind it waits rather than overtaking it.
  `messageType` is therefore `null` only for an atom the **server** does not
  know, which is a broken sender.
- **It is scoped to the window the message names**, not to the connection —
  that is the whole difference from `useApp().X.on('event')`, which sees
  every event for every window and outlives the element. A message aimed at
  another window, including the EWMH ones sent to the root, does not arrive
  here; a window manager wants the raw stream for those
  (`examples/wm-core.js`).
- **`preventDefault()` stops react-x11 acting on the message itself**, which
  today means XDND — for a window answering the drag protocol on its own
  terms. It does not cover the WM close button; `onCloseRequest` is that
  seam.

Sending is `useApp().X.SendClientMessage(destination, aboutWindow, atom,
format, data, eventMask)`, or ntk's `window.sendClientMessage(name, data)`
which interns the atom for you. Note the two window arguments: EWMH messages
about a window are delivered to the **root**, and messages to another
application's window pass an event mask of `0`.

Selections are the other half of most of these protocols, and taking one
needs a timestamp rather than `CurrentTime`:
[`lastInputTime` and `serverTime`](clipboard.md#owning-a-selection-of-your-own).

### Kiosk

There is no `kiosk` prop, because it is not one thing — it is a window with
no decoration, no taskbar entry, nothing above it, and no pointer:

```jsx
<window
  fullscreen
  decorations={false}
  states={['above', 'skip_taskbar', 'skip_pager']}
  style={{ cursor: 'none', flexGrow: 1 }}
/>
```

`cursor: 'none'` hides the pointer outright (ntk ≥ 4.2.0). It is not the
same as leaving `cursor` unset, which inherits whatever the root window's
cursor is — see [styling.md](styling.md).

### `transparent` — rounded corners and translucency

`transparent` creates the window on a 32-bit ARGB visual, so it has a real
alpha channel: what the tree does not paint stays empty, and a compositor
blends it against whatever is behind. That is what makes rounded corners
possible, and it is the main reason to reach for it:

```jsx
<popup
  transparent
  grab
  style={{ backgroundColor: 'rgba(24, 24, 30, 0.86)', borderRadius: 14 }}
>
  …
</popup>
```

Two props do the work together. `transparent` gives the window somewhere to
put transparency; `borderRadius` in the window's own `style` rounds the
background painted into it, and the corners it gives up are the corners the
desktop then shows through. The edge is **antialiased**, because it is alpha
rather than the Shape extension's 1-bit mask — no `XShapeCombineMask`, no
jagged diagonal.

`backgroundColor` may be translucent, and leaving it unset gives a window
that is empty except for what the tree paints.

`borderRadius` on a window is meaningful **only** with `transparent`. On an
opaque window it is ignored: giving up the corners there would only expose
the server's white, which is worse than square.

### When transparency is not available

Transparency needs two things, and either can be missing: a **depth-32
TrueColor visual** (XQuartz has none), and a **running compositor** (Mutter,
KWin, picom, …) to blend the alpha channel. Without a compositor the X
server shows the raw pixels, and a corner you painted away is not
transparent — it is **black**.

react-x11 never lets that happen. When transparency would not actually be
seen, the window is filled edge to edge and `borderRadius` on it is ignored:
you get the square opaque popup, not a black-cornered one. A translucent
`backgroundColor` is flattened rather than composited onto the last frame.
Nothing is required of the application for that floor to hold.

What the application _does_ control is the design on the other side of it,
through the `'@supports transparency'` style block:

```jsx
<popup
  transparent
  style={{
    backgroundColor: '#1c1c22', // square and opaque, works everywhere
    '@supports transparency': {
      backgroundColor: 'rgba(24, 24, 30, 0.86)',
      borderRadius: 14,
    },
  }}
/>
```

See [Capability queries](styling.md#capability-queries). The block is
answered per window and re-resolved live, so a compositor being switched on
mid-session turns the popup rounded without a remount — which is why
`transparent` still takes the 32-bit visual when nothing is compositing yet.
A visual is a `CreateWindow` field and cannot be changed afterwards; what
the window paints can.

For decisions that are not styling, `useSupports('transparency')` answers
the same question about the display, and can be asked before any window
exists:

```jsx
const canBlend = useSupports('transparency');
const margin = canBlend ? 26 : 0; // room for a client-drawn shadow
```

To **look at the fallback** on a display that composites perfectly well,
run with `REACT_X11_NO_TRANSPARENCY=1`: `transparent` is ignored, the window
is created on the ordinary visual, and both the style block and
`useSupports` answer false. Otherwise the only way to see the design you
wrote for XQuartz is to stop the compositor, which takes the rest of your
desktop with it. See [debugging.md](debugging.md).

Toggling the `transparent` prop itself on a mounted window does nothing
until it remounts (change its `key`) — again because the visual is fixed at
creation. Requires **ntk ≥ 6.6.0**.

Two things a transparent window does **not** change. Input still hits the
full rectangle — the corners are invisible, not click-through; use the Shape
extension's input region through the ntk ref if that matters. And child
`<window>`s are composited by the X server, not the compositor, so nesting a
transparent window inside another window blends against nothing.

## `<popup>`

An override-redirect top-level window at **screen coordinates** — the
window manager ignores it (no decorations, no focus stealing): menus,
tooltips, dropdowns. May appear anywhere in the JSX tree (its position in
the tree does not affect its position on screen); it is its own paint and
event root. Give it an `anchor` and it places itself against a node
([below](#anchor--a-popup-that-places-itself)); `x`/`y` are there for the
placements that are nobody's node — `ev.nativeEvent.rootx/rooty`, the
pointer in screen coordinates. Same props as `<window>` — **including
[natural size](#natural-size)**, which is what a menu sized by its own rows
is — and conditional rendering controls its lifetime.

| prop               |                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `anchor`           | place against a node, or a rect inside one, at whatever size the content turns out to be (below)               |
| `grab`             | hold a pointer grab while the popup is up — how menus behave on X (below)                                      |
| `transparent`      | 32-bit ARGB visual: rounded corners and translucency ([above](#transparent--rounded-corners-and-translucency)) |
| `onDismiss`        | a press landed outside the popup: close it                                                                     |
| `trapFocus`        | own a focus scope: a modal (see [events.md](events.md#focus-scopes-modals))                                    |
| `overrideRedirect` | `false` makes it a WM-managed window instead — a real dialog (below)                                           |
| `dragPreview`      | this popup is a drag preview following the pointer, never a drop target — [drag-and-drop.md](drag-and-drop.md) |

### `anchor` — a popup that places itself

```jsx
function Completions({ editorRef, caret, matches, onPick }) {
  if (!matches.length) return null;
  return (
    <popup
      anchor={{ to: editorRef, at: caret, placement: 'bottom' }}
      maxHeight={220}
    >
      <box
        style={{ overflow: 'scroll', padding: 4, backgroundColor: '$surface' }}
      >
        {matches.map((m) => (
          <box key={m.label} onClick={() => onPick(m)} style={{ padding: 6 }}>
            <text>{m.label}</text>
          </box>
        ))}
      </box>
    </popup>
  );
}
```

That is the whole completion list: **at the caret**, as wide as its widest
label, no taller than 220 and scrolling past that, flipped above the line
when it is near the bottom of the screen. Nothing in it measures a font,
states a size, or names a position — `caret` is a rect the editor already
knows, in its own coordinates.

`anchor` takes [`anchorRect`'s options](components.md#useanchorref--anchorrectnode-options)
— `placement`, `align`, `offset`, `alignOffset`, `alignTo`, `at` — plus `to`,
the node (or a ref to one) it hangs off. `x`/`y` are ignored while it is set.

**Why the popup and not the application.** A `<popup>` with no `width` is
sized from its content like any other window, and that size is settled
_inside_ `realize()` — after the content is measured, before `CreateWindow`.
Which side the popup flips to and how far it is pulled back from a screen
edge are both functions of that size, so the earliest anyone can work out the
position is the moment after the measurement — which is already too late for
React to have passed one in. Doing it here keeps the rule the natural size
established: the window is **born** the right size in the right place, rather
than mapped somewhere provisional and corrected a frame later.

Afterwards it keeps up with everything that can move either half — the
anchor's own layout, an ancestor of it scrolling, the owner window being
dragged by the window manager, its own content growing a row.

`at` is a rect **inside** the node, in the node's own coordinates:

```js
const caret = { x: caretX, y: lineTop, width: 1, height: lineHeight };
```

Everything reads it — the side that flips, the edge that aligns, the gap
`offset` leaves — so a popup at a caret behaves like one hung off a small
widget that happens to be there. `width`/`height` may be left out, and
`{x, y}` alone is a point.

A popup whose anchor is a ref that has not attached yet — one written
_above_ its own trigger in the JSX — waits for it rather than opening in the
corner of the screen. That is one frame, and it is the same rule as the one
below: an anchored popup is on screen only while there is something for it
to point at.

**When the anchor scrolls out of view the popup unmaps** and comes back,
where it belongs — and holding its `grab` again, since X drops a pointer
grab whose window stops being viewable — when the anchor does. A popup is a real X window rather
than an element its ancestors clip, so a caret that has scrolled out of the
editor leaves a list floating over a document it no longer points into —
and there is no position that fixes that. Whether it should _close_ instead
is React state and therefore the application's: do the placement yourself
with [`useAnchorTracking`](components.md#useanchorref--anchorrectnode-options)
and its `onOutOfView`.

A popup never receives the X input focus, but nodes inside it can hold the
**owner window's** focus and receive keys — with `trapFocus` and `autoFocus`
that is a modal dialog. See
[Focus inside a `<popup>`](events.md#focus-inside-a-popup).

**`grab` is what makes a menu dismissable.** Without it, a press that lands
anywhere else — another application, the root window, or even this app's own
**window frame**, which belongs to the window manager — never reaches the
client, so the menu stays open behind whatever was clicked. With the grab,
that press is redirected to the popup instead, arrives outside its bounds,
and `onDismiss` fires. The client's own windows still receive their own
presses (X owner-events), so submenus and the owner window keep working
normally, and only the root popup of a menu needs the grab. Needs
ntk ≥ 3.7.0; on older ntk the popup behaves as it did before.

`Select`, `ContextMenu` and `MenuBar` already do this.

### A managed `<popup>` is a dialog

`overrideRedirect` defaults to `true` and is what makes a menu a menu.
Passing `false` gives up all of that on purpose and hands the window to the
window manager: it is reparented into a frame, so it has a titlebar, can be
moved, and has a WM close button (`onCloseRequest`). Together with
`transientFor` that is a real dialog — above its owner, out of the taskbar
and alt-tab list, minimising with the owner.

```jsx
<popup overrideRedirect={false} transientFor={anchor} windowType="dialog"
       title="Preferences" trapFocus>
```

Turn `grab` off with it. A client-side pointer grab over a window the WM is
trying to let the user drag swallows the press that would start the drag.
That also means a press outside no longer dismisses it — which is correct: a
real dialog does not close because you clicked elsewhere.

The [`Dialog`](components.md#dialog) component does exactly this, and takes
`managed={false}` to go back to the override-redirect shape.

Defaults to `windowType="popup_menu"` — the least-wrong answer for a popup
that declares nothing; pass `windowType` to say what yours is
(`"tooltip"`, `"dropdown_menu"`, …). The built-in widgets do:
`Select`'s and `DatePicker`'s sheets are `dropdown_menu`, `Tooltip` is
`tooltip`. The hint is **additive** — override-
redirect is what keeps the WM from moving or decorating the popup, and
stays on. The EWMH spec asks for the type hint on override-redirect
windows too, so compositing managers can give menus and tooltips
consistent shadows and animations.

## `<box>`

The flex container. All layout + paint + interaction props above.
**Ref**: the retained node — `abs` (`{x, y, width, height}` within the
window, valid after layout).

With `overflow: 'scroll'` it is also the **scroll container** — see below.

## Scrolling: `overflow: 'scroll'` {#scrolling}

There is no scrolling _element_. A `<box>` — or a `<window>` — whose style
says `overflow: 'scroll'` becomes a clipped viewport over its own
overflowing children, on **both axes**:

```jsx
<box style={{ overflow: 'scroll', flexGrow: 1 }}>{rows}</box>
```

Wheel events scroll it by default; a scrollbar thumb is drawn on each axis
that overflows, and the thumb can be dragged. `overflow: 'hidden'` still
means what it always did — clip and do not scroll.

Because the switch is a style and not an element, a pane can start and stop
scrolling without remounting, which is what makes `overflow={dense ?
'scroll' : 'visible'}` cheap: the node, its children and their state all
survive the change. When a box stops being a scroll container its offset
resets to 0, as it does in CSS.

**It is also a tab stop, and answers the keyboard**, whenever it has
somewhere to scroll — which is what lets a pane of unfocusable content (a
log, a long `<text>`, a rendered document) be read without a pointer at all:

| key                 |                                      |
| ------------------- | ------------------------------------ |
| arrows              | one wheel notch (48px) on that axis  |
| PageUp / PageDown   | a viewport, keeping a sliver of it   |
| Space / Shift+Space | the same, for the hand already there |
| Home / End          | the top and the bottom               |

One that fits its content is not a tab stop, answers no keys and takes no
wheel: it is a box with a clip, and stopping on it would be a stop that does
nothing. **The wheel chains past it** to the next scroll container out — the
same thing a browser does — so declaring a pane scrollable never steals a
gesture the window would have answered. The keys are a default action, so an
`onKeyDown` of your own runs first and `preventDefault()` cancels them.

A pane that also has an `onClick` keeps Space for paging: paging is the
pane's own default action and runs ahead of the keyboard activation Space
would otherwise be, so such a pane pages with Space and activates with Enter
([events.md](events.md#space-and-enter-are-a-click)). A focusable row _inside_
a pane takes both keys and pages with neither — a default action runs on the
focused node, and that is the row.

The bar belongs to the scroller, not to the content painted under it — the
same rule a browser applies — so a press on the thumb never reaches the row
behind it. Dragging keeps the grip where it was taken, so the thumb does not
jump to the pointer, and a press on the track pages towards it, like
PageUp/PageDown. `<textarea>` behaves the same way, and there a bar press
never moves the caret.

### The layout defaults it brings

`overflow: 'scroll'` folds three CSS idioms into the resolved style, so a
scroll container does not have to restate them:

| default                        | when                                     |
| ------------------------------ | ---------------------------------------- |
| `flexBasis: 0`                 | `flexGrow > 0` and no `width` / `height` |
| `minWidth: 0` / `minHeight: 0` | always                                   |

`min-*: 0` is the CSS spec's own rule — `min-*: auto` computes to `0` on a
flex item whose overflow is not `visible` — and it is what lets a viewport be
smaller than what is inside it, which is what scrolling is. The zero basis is
half of what `flex: 1` means. Without them a header/scroll/footer window
grows past its own bounds as rows are added and the footer is pushed out of
view. Set either yourself to opt out; an explicit value always wins.

### Props

| prop                |                                                                                  |
| ------------------- | -------------------------------------------------------------------------------- |
| `onScroll(ev)`      | `{scrollX, scrollY, contentWidth, contentHeight, viewportWidth, viewportHeight}` |
| `onViewport(ev)`    | `{width, height, contentWidth, contentHeight}` whenever they change              |
| `scrollbar={false}` | hide the drawn scrollbars                                                        |
| `scrollbarColor`    | thumb color                                                                      |

**Ref**: the node, plus `scrollTo` / `scrollBy` / `scrollIntoView(node)` and
`scrollX` / `scrollY` / `contentWidth` / `contentHeight`. In TypeScript,
`useRef<ScrollableNode>(null)` types those in; `DrawnNode` still works for a
box you do not scroll.

`scrollTo(y)` takes a number for the vertical axis; `scrollTo({x, y})` moves
either, leaving alone whichever you omit. `scrollBy` matches.
`scrollIntoView(node)` scrolls the minimum amount on both axes.
`canScroll(dx, dy)` answers whether there is room to move on the axis a delta
names — what the wheel asks each node on its way out, and the one method an
element of your own implements to be asked it too
([extending.md](extending.md#scrolling-content-you-painted)).

Horizontal content comes from children that will not shrink — a row of
fixed-width cells, say. The extent is measured **through the subtree**, the
way `scrollWidth` is in a browser: a row that stretches to the viewport
while its own cells overflow it still reports something to scroll. Anything
that clips its own children ends that measurement, since their overflow
belongs to them.

A device with a horizontal axis scrolls sideways with it; **Shift + vertical
wheel** does too, for the mice and touchpads that have none. When both bars
show, each stops short of the other's corner.

The distance is the device's, not a constant: where the server has XI2 a
touchpad's scroll arrives as the fraction of a notch it measured, so a pane
moves by a few pixels rather than by 48 at a time. A wheel notch is still 48
pixels, and so is an arrow key ([events.md](events.md#wheel)).

`onViewport` fires from **layout**, not from scrolling, so it arrives for a
list nobody has scrolled yet. That is what a virtualized list needs before
it can decide how many rows are worth building: layout runs on the frame
clock, after the commit that mounted the node, so an effect cannot read the
size off the ref. `Table` is built on it.

`scrollIntoView(node)` scrolls the minimum amount that makes a descendant
node fully visible, and is safe to call from an effect right after that
node mounts: the request is resolved on the next layout pass, when the
node actually has geometry.

### On a `<window>`

`<window style={{ overflow: 'scroll' }}>` scrolls the window's own content,
with no inner pane at all — the same wheel, keys and bars. The window stays
a `frame` to a screen reader whatever its overflow says. Its ref is still
ntk's `Window`, so reach the scroll API through a ref on a box inside it, or
through the node in `onViewport`.

## `<text>`

Shaped, wrapped text through ntk's text stack (bidi, ligatures, kerning,
font fallback). Strings/numbers are only legal inside `<text>`; nested
`<text>` elements are **style spans** — the paragraph is laid out as one
run list so wrapping spans the whole content.

| prop                                                |                                                        |
| --------------------------------------------------- | ------------------------------------------------------ |
| `color`                                             | text color — inherited (see below)                     |
| `fontSize`, `fontFamily`, `fontWeight`, `fontStyle` | ntk font style (fontconfig lookup + fallback)          |
| `fontVariationSettings`                             | a variable font's axes — see below                     |
| `textRendering`                                     | which glyph path to draw with — see below              |
| `textAlign`                                         | `left`, `right`, `center`, `start`, `end` (bidi-aware) |
| `lineHeight`                                        | multiplier over the natural font line height           |
| `textWrap`                                          | `wrap` (default) or `nowrap`                           |
| `maxLines`                                          | how many lines are kept — unlimited by default         |
| `textOverflow`                                      | `clip` (default) or `ellipsis`, for what was cut       |

The first four rows and `fontVariationSettings` and `textRendering`
**inherit** — from a nested span's point of view that has always been true,
and it is equally true across a `<box>`, so a caption block is written once
around the labels in it
([styling.md](styling.md#inheritance-the-ink-the-face-and-the-size)).
The rest do not: they shape the box the lines flow in, which belongs to the
`<text>` that owns it.

`maxLines` and `textOverflow` are how a label says it did not fit —
`{ textWrap: 'nowrap', textOverflow: 'ellipsis' }` is one line ending in a
`…` at the pixel the box ends at, and an ellipsis with no `maxLines` means
one line. The cut is a fact about the pixels only: the accessible name, the
caret indices and `textContent()` are all still the whole string. See
[styling.md](styling.md#keeping-text-on-one-line-and-saying-when-it-did-not-fit).

A face the app supplies itself — one it ships, or one the user picked in a
dialog — is opened with `loadFont`/`useFont`, which hand back the family
name to put in `fontFamily`
([styling.md](styling.md#a-font-file-of-your-own)).

`start` and `end` are resolved against the box's own **direction**, not
against the first strong character in the string — the box says which way it
reads and the paragraph is laid out at that base level, so `"(12) files"` in
an RTL panel punctuates as an RTL sentence and a `<text>` with no strong
characters at all still lands on the right side.
See [styling.md](styling.md#direction-and-the-logical-edges).

### Variable fonts

_ntk ≥ 7.1.0._

A variable font is one file with a continuous design space, and
`fontWeight` already drives its `wght` axis — so a family with one variable
file behaves like a family with nine faces, and like nine hundred, since
the weights between the named instances are the point of an axis:

```jsx
<text style={{ fontFamily: 'Inter', fontWeight: 460 }}>
  Serious by default.
</text>
```

`fontVariationSettings` is for the other axes, by OpenType tag:

```jsx
<text style={{ fontVariationSettings: { wdth: 87.5, slnt: -8 } }}>
  condensed
</text>
```

It inherits into spans like any other text style prop, and a span may
override it. Axes the font does not have are ignored and values are clamped
to each axis's range, so it is safe to set without checking the face first.
It is compared **by value**, so the object literal above is fine — a fresh
one with the same numbers on the next render costs nothing.

ntk instantiates on demand and rasterizes only the glyphs actually drawn,
at the size drawn; both its caches are bounded. What it does not do is
quantize for you, so a slider bound straight to an axis with `step={1}`
really will ask for hundreds of distinct faces as it is dragged — step the
control, not the font. See ntk's `docs/fonts.md` for the whole picture,
including why a variable `.woff2` cannot be instantiated and you want the
`.ttf`.

### `textRendering`

_ntk ≥ 7.2.0._ CSS's property, picking which glyph path draws the text.

| value                |                                                           |
| -------------------- | --------------------------------------------------------- |
| `auto` (default)     | ntk decides from the size — right for UI text             |
| `geometricPrecision` | glyph origins exactly where shaping asked; nothing cached |
| `optimizeSpeed`      | ntk's cached glyph bitmaps, at any size                   |
| `optimizeLegibility` | accepted, means `auto` — there is no hinting to turn on   |

```jsx
<text style={{ fontSize: 96, textRendering: 'geometricPrecision' }}>
  Serious by default.
</text>
```

**Why display text wants it.** On the cached path a glyph's advance is baked
into the server-side glyphset as a whole number, because a cached bitmap can
only land on a whole pixel. Animate a variable font's `wght` and the true
advances move by hundredths of a pixel — hundredths that accumulate along
the line until one glyph crosses a rounding boundary and jumps a whole pixel
on its own while its neighbours stand still. `geometricPrecision` puts every
glyph where shaping asked, so the line slides instead of stepping.

It inherits into spans and a span may override it, so a headline and the
body text under it can take different paths in one paragraph.

**It never reflows.** Only draw-time rounding differs; ntk's layout measures
byte-identically for every value, down to per-run offsets. Changing it drops
the cached layout — the value rides on the spans inside it — and repaints,
without marking anything dirty for yoga. So it is safe to flip on a state
change without the tree moving.

The cost is real: the precise path rasterizes outlines on every draw and
caches nothing. That is the right trade for text being animated and the
wrong one for a paragraph that never changes, which is why `auto` is the
default rather than the other way round.

## Selecting text

_Issue #259._ A label is not selectable, the way `Gtk.Label` is not: a
desktop application is full of text that is chrome rather than content, and
a stray drag lighting up a button's caption is noise. Text becomes
selectable when an element says so.

```jsx
<box selectable style={{ padding: 12 }}>
  <text style={{ fontSize: 20, fontWeight: 'bold' }}>Release notes</text>
  <text>Everything below this heading can be dragged over and copied.</text>
</box>
```

That one prop is the whole feature. The element becomes a **surface**: a
drag inside it selects across every piece of text under it, a double click
takes a word, a triple click takes a block, Ctrl+A takes the surface and
Ctrl+C copies it. Releasing the button hands the text to **PRIMARY**, so a
middle click in a terminal pastes it — which is what selecting text means
on X11 ([clipboard.md](clipboard.md)).

### What is in a surface

Everything under it that can answer for its own text, in document order.
`<text>` can; so can any element that implements the accessors in
[extending.md](extending.md#answering-for-your-own-text) — a terminal, a log
view, a code editor written outside this package are all selected across by
the same drag, with no registration call.

What is **not** in it:

- anything under a `selectable={false}`, which is CSS's `user-select: none`.
  A list's bullets, a table's chrome, a button's caption inside a document;
- `<textinput>` and `<textarea>`, and any element that says
  `hasOwnSelection` — they keep their own selection, and a press in one is
  theirs;
- `<svg>`, and any registered element that draws its own text, which draw
  their text through an ntk widget that exposes no character geometry to us.

### What a copy assembles

The separators come from the **layout**, not from the markup: core cannot
know that one `<text>` is a table cell and another is a paragraph, and
asking every application to say so would be a second authoring model for
something the screen already shows. Two pieces of text sharing a band of
pixels are joined with a **tab**; one that starts below the last is joined
with a **newline**. For a table laid out as rows of cells that is exactly
"cells with tabs, rows with newlines", and for ordinary prose it is one
paragraph per line.

```jsx
// copies as "name\tsize\nnotes\t4 kB"
<box selectable>
  <box style={{ flexDirection: 'row' }}>
    <text style={{ width: 120 }}>name</text>
    <text>size</text>
  </box>
  <box style={{ flexDirection: 'row' }}>
    <text style={{ width: 120 }}>notes</text>
    <text>4 kB</text>
  </box>
</box>
```

A list marker excluded with `selectable={false}` is absent from the copied
text as well as from the highlight, which is the point of excluding it.

### The props

| prop                    |                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `selectable`            | `true` starts a surface; `false` opts a subtree out of the one above it                   |
| `selectionColor`        | the highlight behind selected text (default: a tint of the theme's accent)                |
| `onSelectionChange(ev)` | `ev.text` is what a copy would put on the clipboard, `ev.isCollapsed` whether it is empty |

And on the surface's node, through a ref: `selectAll()`, `clearSelection()`,
`selectedText()`, `setSelection(anchor, focus)` — each end
`{ node, index }`, indices in code points — and `textSelection`, a snapshot of
`{ isCollapsed, text, ranges }`.

### One selection, and where the keys go

**Only one selection is visible in an application at a time.** Selecting in
a document collapses the highlight in the field beside it, and selecting in
a field clears the document — the two never both claim to be showing the
selection, which is a rule core holds rather than one every surface has to
keep. That is also what makes PRIMARY honest: there is one selection on the
display, so there is one here.

A surface is a **focus target**, because Ctrl+A and Ctrl+C are keystrokes
and a keystroke has to arrive somewhere. That puts it in the Tab cycle;
`tabIndex={-1}` takes it back out while leaving it focusable by a press —
which is the right choice for a document inside a larger UI, and the wrong
one for a reader whose window is the document.

The pointer shows an I-beam over a surface, the way it does over a field.
`style={{ cursor: … }}` overrides it as usual.

The selection is reported to assistive technology as it moves: a `<text>`
already exposed AT-SPI's text interface, and the range a reader has dragged
across now travels through it ([accessibility.md](accessibility.md#text-controls)).

### The geometry underneath

The selection is built out of four accessors that every drawn node answers,
and they are public in their own right — a caret rect is what an
autocomplete popup anchors to (`<popup anchor={{ to, at }}>`), and a hit
test is how an app turns a click into a character offset:

```js
const node = paragraphRef.current;
node.textContent(); // 'Everything below this heading…'
node.textIndexAt(ev.x, ev.y); // 14 — window coordinates in, a code point out
node.textCaretRect(14); // { x, y, width: 0, height }
node.textRangeRects(4, 14); // the bands a highlight over [4, 14) fills
```

Indices are **code points**, not UTF-16 units, so an emoji is one position.
Rectangles are in the owning window's coordinates — the same space as
`abs`, `contentBox()` and a mouse event's `x`/`y`. `textRangeRects` returns
one band per line _and_ one per direction run inside a line: a range that
crosses from Latin into Arabic covers two separate stretches of pixels, and
a single rectangle drawn between two caret positions would paint over text
nobody selected.

---

## `<textinput>`

![textinput](img/textinput.png)

Single-line editable text. Caret and selection geometry come from ntk's
`TextLayout.caretPosition`/`indexAt` (ntk ≥ 3.3.0), so positions are exact
across kerning, shaping boundaries and trailing whitespace.

| prop                              |                                            |
| --------------------------------- | ------------------------------------------ |
| `value` + `onChange(ev)`          | controlled mode (display follows the prop) |
| `defaultValue`                    | uncontrolled mode                          |
| `onSubmit(ev)`                    | Enter                                      |
| `name`                            | field name, echoed on the event            |
| `placeholder`, `placeholderColor` | shown when empty                           |
| `maxLength`                       | code-point limit                           |
| `selectionColor`, `caretColor`    | selection/caret paint                      |
| text style props                  | as `<text>`                                |

The text style props include `textAlign`, and the field is laid out at its
box's **direction** the way a `<text>` is: the value, the placeholder and the
caret sit at the base direction's start edge — the right-hand one under
`direction: 'rtl'` — and the value is shaped at that base level rather than
at its own first strong character, which is what makes `"(1) 12:30 — نص"`
punctuate the same way in a field and in the paragraph beside it. Clicking,
the caret, the selection bands and the horizontal scroll are read from one
placement, so they mirror together. See
[styling.md](styling.md#inside-an-editable-field).

### The change event

`onChange` and `onSubmit` get a synthetic event, the same shape every other
handler in the library gets, rather than a bare string:

```jsx
<textinput
  name="email"
  value={email}
  onChange={(ev) => setEmail(ev.target.value)}
/>
```

| on the event                        |                                                     |
| ----------------------------------- | --------------------------------------------------- |
| `ev.value`, `ev.target.value`       | the text **after** the edit                         |
| `ev.name`, `ev.target.name`         | the `name` prop                                     |
| `ev.type`                           | `'change'` or `'submit'`                            |
| `ev.target`, `ev.currentTarget`     | the node (they are the same — this does not bubble) |
| `ev.nativeEvent`                    | the X key event, or **null** — see below            |
| `preventDefault`, `stopPropagation` | present for uniformity; nothing reads them          |

Two details worth knowing:

- **`ev.target.value` is the new value even in controlled mode**, where
  `props.value` is still the old string until the parent re-renders. That is
  what makes `e.target.value` mean here what it means in the DOM, and it is
  why react-hook-form and formik work — see
  [docs/ecosystem/forms.md](ecosystem/forms.md). It is true _while the
  handler runs_: `ev.target` is the live node, so a handler that stashes the
  event and reads `ev.target.value` later sees whatever the control holds
  then. `ev.value` is a snapshot and always safe.
- **`ev.nativeEvent` can be null.** A keystroke carries the X key event that
  produced it, but an edit can also come from a paste resolving, an undo, or
  a value the parent pushed back — none of which has an X event behind it.
  Guard it. (Not academic: downshift reads
  `event.nativeEvent.preventDownshiftDefault` unguarded, so a null there is a
  TypeError rather than a no-op.)

The node behind `ev.target` is writable, too. `node.value = ''` sets the text
without firing `onChange`, the way assigning to a DOM input's `value` does —
that is how react-hook-form's `register()` resets a field through its ref.

Interactions: click/drag selection, double-click word select, triple-click
select all, **dead keys and Compose**
([events.md](events.md#composition)), Backspace/Delete, arrows (+Shift extends), Home/End, Ctrl+A,
Ctrl+C/X/V on CLIPBOARD, middle-click paste from PRIMARY, selections own
PRIMARY (X11 conventions, select-all included), **Ctrl+Z / Ctrl+Shift+Z** (Ctrl+Y too) to undo
and redo, and a **right-click menu**. Focusable by default; shows the text
cursor. `ev.preventDefault()` in your `onKeyDown`/`onMouseDown` suppresses
the built-in editing behavior. To copy or paste from anywhere else — a
canvas, a list, your own menu item — see [clipboard.md](clipboard.md).

### The right-click menu

![the built-in edit menu](img/textinput-menu.png)

Right-clicking gives Undo / Redo / Cut / Copy / Paste / Select All with no
wiring, the way a browser gives `<input>` one — each row live only when it
would do something, and every row running the same code the keyboard
shortcut does. Right-clicking **inside** a selection keeps it (the menu is
about to act on it); outside one, the caret moves there first.

**Paste** is greyed when nothing owns the CLIPBOARD selection. The field
subscribes to selection changes the first time its menu opens rather than
asking on the way in — asking would mean a round trip against whatever
foreign client owns the clipboard, and a wait if that client is wedged, at
exactly the moment a menu should already be on screen. So the very first
menu of a session still shows Paste enabled; every one after it knows. On
a server without XFixes it stays enabled, which is where it started.

Arrows walk the rows, skipping the disabled ones, Enter chooses, Escape or
a press anywhere outside closes. The selection stays visibly highlighted
while the menu is up, even though the popup holds the keyboard.

To replace it with your own, set `contextMenu={false}` and render a
`ContextMenu` — `onContextMenu` still fires. To suppress it for one event,
call `ev.preventDefault()` in an `onContextMenu` handler.

The menu is not the field's private property: `openEditMenu(node, at,
actions)` opens this one for anything that edits or selects text — a code
editor, a rendered document with a selection — and `<textinput>`'s own menu
is a caller of it, which is what keeps the two the same menu. See
[extending.md](extending.md#the-standard-edit-menu).

### `sensitive`

`<textinput sensitive>` is a field whose text **never reaches a selection**.
Ctrl+C and the copy half of Ctrl+X do nothing, the menu offers neither Cut
nor Copy — absent rows rather than greyed ones, because a greyed Copy over a
password reads as a bug in the application — and selecting text does not take
PRIMARY, so a middle click in another window cannot spend it. Everything else
is untouched: the caret, the selection itself, the arrows, undo, and pasting
_in_.

The line it draws is between what is on screen and what is on the clipboard.
The first stops being visible when the field is hidden or the window closes;
the second is readable by every client on the display until something else
takes the selection, and a clipboard manager will have written it down.
`PasswordInput` sets it on the input it shows while the secret is revealed —
see [components.md](components.md#passwordinput).

**Ref**: the node, plus `value`, `undo()` / `redo()` and `canUndo` /
`canRedo` — enough for a toolbar button beside the field.

### Undo

Consecutive typing coalesces into one undo step, so Ctrl+Z takes back a
word rather than a keystroke; a run of Backspaces coalesces the same way.
A run ends at whitespace, at anything that moves the caret (arrows,
Home/End, a click, focus leaving the field), and around edits that are
their own step whatever surrounds them: a paste, a cut, a replaced
selection, Ctrl+Backspace, and a `<textarea>` newline. Undo restores the
selection and puts the caret back where the undone edit started.

A composed character is one entry, not one per keystroke: the accent a dead
key is holding is not in the value until it commits, so Ctrl+Z after
`dead_acute` `e` steps over `é` rather than into it.

Undo is a stack of snapshots of the states the control has shown, capped
at 200. A **controlled** `value` reports the restored text through
`onChange` and waits for the prop to come back, exactly as typing does —
so a parent that filters or rejects a value gets the same say over an undo
that it has over an edit. A value changed from outside (a form reset)
becomes its own entry, and undoing steps back through it.

## `<textarea>`

Multi-line editable text on the same editing core as `<textinput>`:
word-wraps at the content width, Enter inserts a newline (Ctrl+Enter fires
`onSubmit`), Up/Down move between visual lines keeping a goal column,
Home/End go to the start/end of the visual (wrapped) line, selection spans
lines, and the view scrolls vertically to follow the caret (mouse wheel
scrolls too).

The wheel reaches it through the same chain a `<box overflow="scroll">` is
in, so a field whose text fits passes the gesture out to the pane or the
window behind it rather than swallowing it.

| prop            |                                                   |
| --------------- | ------------------------------------------------- |
| `rows`          | preferred height in text lines (default 3)        |
| everything else | as `<textinput>` (`onSubmit` fires on Ctrl+Enter) |

## `<image>`

| prop       |                                                                                        |
| ---------- | -------------------------------------------------------------------------------------- |
| `src`      | client-side pixels, in any of the four forms below                                     |
| `picture`  | `{ id, width, height }` — an existing server-side Picture, composited as-is            |
| `drawable` | `{ id, width, height, depth? }` — an existing Pixmap/Window, composited as-is          |
| `cacheKey` | the source's identity, when `src` is re-derived per render                             |
| `alt`      | the accessible name — what a screen reader says ([accessibility.md](accessibility.md)) |

One source per element — `src`, `picture` and `drawable` are mutually
exclusive, and passing two throws.

Sized by style — `style={{ width, height }}`, never flat props, since both
are style names. With only one of the two set the other follows the natural
aspect ratio; with neither, the image measures at its natural size, shrunk
to the width on offer. For the server-side sources the "natural size" is the
`width`/`height` stated in the descriptor.

```jsx
<image src={photo} style={{ height: 64 }} /> // width follows the aspect ratio
```

### `src` — pixels the client has

```jsx
<image src="./logo.png" />                     // file path or file URL
<image src={pngBuffer} />                      // encoded PNG/JPEG bytes
<image src={{ width, height, data }} />        // raw straight RGBA
<image src={ntkImage} />                       // an ntk Image (or Surface)
```

A file path (or `new URL('./logo.png', import.meta.url)`) is read and
decoded asynchronously; the element measures 0×0 until the decode lands,
then reflows. The three in-memory forms are synchronous — pixels that
arrived from a socket, a decoder, or a `getImageData` readback go on screen
without touching the filesystem. Raw `data` is `width × height × 4` bytes of
straight (non-premultiplied) RGBA — exactly what `getImageData` hands back —
and the object is treated as immutable content: hand over a new object when
the pixels change, or the renderer cannot tell.

Decoded pixels are uploaded to the server once and composited from there on
every repaint (ntk's `Image` caches its upload per connection), so the cost
of an image is one `PutImage` at first paint, not one per frame.

An ntk `Image` is used as-is and never destroyed by the element — identity
is yours, which is also the sharing idiom: one `Image` shown by many
`<image>`s is one decode and one upload, however many places composite it.

### `cacheKey` — when the buffer is new but the picture is not

A component that re-derives its bytes per render — decoding a protocol
stream, slicing a capture — hands `<image>` a structurally new `src` every
time, and without help that is a fresh decode and a fresh upload each
render. `cacheKey` is the `<canvas cacheKey>` contract applied to sources:
an unchanged key vouches that the new buffer is the same picture, so nothing
is re-decoded or re-uploaded — and two `<image>`s with one key share one
decoded copy, freed when the last of them unmounts.

```jsx
<image src={frame.rgba} cacheKey={`frame:${frame.serial}`} />
```

The key must name the content: a key that stays the same while the pixels
change shows the old pixels. Development warns when two sizes collide under
one key, which is the cheap symptom of that mistake. The key is not
consulted for an ntk `Image` (the object is its own identity), and is
refused with `picture`/`drawable` (there is nothing client-side to cache).

### `picture` / `drawable` — pixels the server already has

When the content is already a server-side Picture or Drawable — a pixmap the
app rendered offscreen, `NameWindowPixmap` from Composite, a cached tile —
showing it must not mean reading it back and uploading it again. These
composite straight from the existing resource: one `RenderComposite` into
the window, no `PutImage`, no round trip.

```jsx
<image picture={{ id: pic, width: 64, height: 64 }} />
<image drawable={{ id: pixmap, width: 128, height: 96, depth: 32 }} />
```

The caller states the size because asking the server for it would be a round
trip, which these props exist to avoid. The descriptor is compared by value,
so an object literal rebuilt every render costs nothing. Scaling (a box
styled to a different size than the source) is server-side, through the
picture transform with bilinear filtering — note that drawing a `picture`
scaled sets that picture's transform and filter for the composite and resets
them to identity/nearest after, the same bracket ntk puts around its own
uploads; a picture that must keep a transform of its own should be
composited 1:1.

`drawable` wraps the pixmap or window in a Picture the element creates and
owns (freed on unmount; the drawable stays yours). `depth` picks the format
it is composited through: 24 — the screen's default depth, what a window
pixmap from Composite is — is the default, 32 is argb, and 8 composites as
ink through its alpha, which is what previewing a mask looks like. A
`picture` needs no depth: its format was fixed when it was created.

Both descriptors also accept the richer objects that already carry these
fields — an ntk `Pixmap` is `{ id, width, height, depth }` and goes straight
in as `drawable`.

## `<canvas>`

The escape hatch: a retained node whose content you paint.

```jsx
<canvas
  style={{ flexGrow: 1 }}
  onDraw={(ctx, { width, height, node }) => {
    ctx.fillStyle = 'tomato';
    ctx.fillRect(0, 0, width / 2, height);
  }}
/>
```

`ctx` is ntk's canvas-like 2d context (paths, transforms, gradients incl.
conical, `setLineDash`, round caps/joins, images, text — XRender-backed),
translated to the node's origin and clipped to its bounds. `onDraw` runs on
every repaint of the window.

A drawing made of many small rectangles in one colour — a sparkline, a heat
map, row striping, terminal cells — has a batch primitive, and the
difference is a whole frame's worth of requests:

```jsx
ctx.fillStyle = theme.accent;
ctx.fillRects(bars); // [[x, y, w, h], …] or one flat [x, y, w, h, x, …]
```

`fillRects` is `fillRect` per rectangle — the same fill style, alpha,
composite op and clip — sent as a single `Render.FillRectangles` where the
loop would have sent one composite each.

### Raw pixels — the one call that is not translated

Everything on the context honours "you are at the node's origin" — except
the raw-pixel pair. `putImageData` and `getImageData` ignore the current
transform _and_ the clip (the HTML canvas rule, kept by ntk), so their
coordinates are the drawable's own: `ctx.putImageData(data, 0, 0)` lands at
the **window** corner, not in the node, and nothing errors on the way.
`onDraw`'s second argument carries the node's origin for exactly this case:

```jsx
<canvas
  onDraw={(ctx, { width, height, x, y }) => {
    ctx.putImageData({ width, height, data: rgba }, x, y); // in the node
  }}
  style={{ width, height }}
/>
```

`x`/`y` are wherever the drawing is going — in a live paint the node's place
in the window, under a [`cacheKey`](#cachekey--draw-it-once) the origin of
the cache surface — so offsetting by them is correct in both. In
development, a `putImageData` whose pixels land outside the node's box
warns, once, naming this rule.

Better, for pixels that survive more than one frame: upload through an
`Image` source (ntk's, re-exported — see [the subpath
exports](extending.md#the-subpath-exports)) and draw it.
`drawImage` goes through the transform and the clip like everything else — a
half-scrolled-out canvas stays cut at the viewport, which no raw write is —
and the image caches its server-side pixmap instead of re-uploading the
bytes on every repaint:

```jsx
import { Image } from 'react-x11/ntk';

const img = new Image({ width, height, data: rgba }); // keep it memoized
<canvas onDraw={(ctx) => ctx.drawImage(img, 0, 0, width, height)} />;
```

### `cacheKey` — draw it once

A drawing that does not change between frames does not have to be redrawn
between frames. Give the canvas a `cacheKey` and its content is rendered once
and composited on later repaints; two canvases with the same key share the one
rendered copy.

```jsx
<canvas cacheKey={`spark:${series.id}:${w}x${h}`} onDraw={drawSparkline} />
```

Opt-in, and the reason matters: `onDraw` is an opaque closure. Nothing in the
renderer can know what it reads — a prop, a ref, a clock — and its identity
changes on every render unless you memoize it, so it is not a key either. Only
you know, so you say.

**The key must name every input the drawing reads.** One that leaves something
out shows stale pixels, which is the hardest kind of bug to see. Develop with
`REACT_X11_PAINT_CACHE=verify`, which turns exactly that mistake into a loud
complaint — see [Runtime diagnostics](debugging.md#the-paint-cache--react_x11_no_paint_cache-react_x11_paint_cacheverify).
Leave `cacheKey` unset for anything animated, or driven by state outside the
props.

`<svg>` does this automatically: its content is fully described by
their props, so the renderer can build the key itself.

### `mono` — one colour, and the colour out of the key

`mono` is a promise about the drawing: **everything it paints is one colour,
and it is not the drawing's to choose.** `onDraw` then names no colour at all
— `fillStyle` and `strokeStyle` arrive preset from the node's resolved
`color`, which is its own if it named one and otherwise the ink it inherits
([styling.md](styling.md#inheritance-the-ink-the-face-and-the-size)), so a
mark inside a dimmed or hovered row follows it with nothing said:

```jsx
const chevron = (ctx, { width: w, height: h }) => {
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(w * 0.25, h * 0.375);
  ctx.lineTo(w * 0.5, h * 0.65);
  ctx.lineTo(w * 0.75, h * 0.375);
  ctx.stroke(); // no strokeStyle: the ink is style.color
};

<canvas
  mono
  cacheKey="chevron"
  onDraw={chevron}
  style={{
    width: 12,
    height: 12,
    color: '$textMuted',
    ':disabled': { color: '$border' },
  }}
/>;
```

The promise is what lets one drawing serve every state a control puts it in:
`:hover`, `:disabled` and a theme flip all reach the same `onDraw`, and none of
them is the drawing's business.

**What it buys at the cache.** With a `cacheKey`, a `mono` drawing is kept as
**coverage** rather than as pixels, with the colour applied at composite time —
so the colour leaves the key and one rendered copy serves every ink. That is
the trick the glyph cache runs on text, and the one `<svg>` gets for a
`fill="currentColor"` document; a closure cannot be scanned the way a document
can, so here you say it. Without `mono`, each colour of the same shape is a
separate rasterization and a separate pixmap.

Needs **ntk ≥ 7.3.3**, which `package.json` carries: earlier versions
composite coverage as empty under a clip they cannot express as a rectangle
([sidorares/ntk#243](https://github.com/sidorares/ntk/issues/243)), and a
widget sits inside clips like that routinely.

`mono` works without `cacheKey` (the ink is preset either way), but the two
together are the point. The [system icon set](components.md#system-icons) is
twelve of these.

---

## `<glarea>`

An OpenGL surface in the layout — the only drawn element that owns a real X
window, because GLX needs a drawable created for a GL-capable visual and
cannot share the XRender pipeline the rest of the tree paints through
(NEXT_STEPS §4). Needs ntk ≥ 3.6.0 and a server with **indirect GLX**
enabled (`+iglx` / `AllowIndirectGLX` — off by default on many).

```jsx
<glarea
  style={{ flexGrow: 1 }}
  clearColor="#0b1021"
  frameLoop="always"
  onCreated={(gl) => gl.Enable(gl.DEPTH_TEST)}
  onDraw={(gl, { width, height }) => {
    gl.MatrixMode(gl.PROJECTION);
    gl.LoadIdentity();
    gl.Frustum(-1, 1, -height / width, height / width, 2, 20);
    // ... immediate-mode or display-list drawing
  }}
/>
```

- `onDraw(gl, { width, height, node })` — draw one frame. The viewport is
  set and the buffers are cleared before it, `SwapBuffers` follows it.
- `onCreated(gl, info)` — runs once, when the context is current: one-time
  GL state, texture uploads, display-list compilation.
- `clearColor` — CSS colour or `[r, g, b, a]` floats (default black).
- `frameLoop` — `'demand'` (default) redraws on prop, size and expose
  changes only; `'always'` renders continuously on ntk's frame clock.
- `glx` — a visual spec for ntk's `chooseGLXConfig`, e.g.
  `{ DEPTH_SIZE: 24 }`. One query per app, shared by every `<glarea>`.
- `onError(err)` — no GL surface (no GLX, no matching visual). Without a
  handler the failure is a console warning.

`gl` is ntk's indirect-GLX context: fixed-function OpenGL 1.4 (immediate
mode, matrices, lighting, textures, display lists) — no shaders, no vertex
arrays, since the GLX protocol does not encode them. **Geometry belongs in
display lists**: every immediate-mode vertex is a command on the wire, so a
mesh re-sent per frame costs kilobytes per frame, while a compiled list
costs one `CallList`.

Layout treats it as a leaf: it is sized and positioned like any other node,
and its X window follows that rect. The window is stacked above everything
drawn in the parent, so 2D content cannot overlap it — a HUD needs a
sibling `<popup>`. Pointer events over the surface go to its own window;
`<glarea>` does not take part in the parent's hit testing yet.

`onDraw` is the raw escape hatch; for a scene, put 3D elements inside
(below) and let the renderer drive the GL. See `examples/viewer3d.jsx` for
the raw form, and `@react-x11/components/three` for a scene graph.

---

## `<foreign>`

Another process's top-level X window, laid out as an element — a terminal
pane, a video surface, a docked tray icon. The second element that owns a
real X window without painting into its parent, and the only one that makes
a react-x11 app a _host_ rather than a drawer of its own pixels. Needs ntk
≥ 7.4.0.

```jsx
<foreign
  windowId={terminal.windowId}
  style={{ flexGrow: 1, backgroundColor: '#101014' }}
  onEmbedded={({ xembed }) => setMode(xembed ? 'xembed' : 'reparented')}
  onClientGone={() => respawn()}
/>
```

- `windowId` — the window to embed. Changing it hands the old client back
  before the new one is taken. **Omit it** to adopt whatever is put inside
  this node instead, which is what `xterm -into WID` and `mpv --wid=WID`
  need.
- `onReady({ windowId })` — this node's own container id, offered before
  anything is embedded, so a program can be spawned into it.
- `onEmbedded({ id, xembed, version })` — a client is in. `xembed: false`
  is a client that set no `_XEMBED_INFO` and got plain reparenting, which
  is the common case rather than the fallback.
- `onClientGone()` — destroyed, or reparented away by someone else.
- `onRequestFocus()` — the client asked for the focus. It is then given
  through the focus manager, so the rest of the tree observes it normally.
- `onError(err)` — the embed failed. Without a handler, a console warning.
- `focusable` — default `true`, like `<textinput>`.
- `backgroundColor` in the `style` is what shows in the rect with no client
  in it: the container window's background, painted by the server.

**Unmount reparents the client back to the root and drops it from the save
set. It never destroys it** — a React tree changing shape is not a reason
for another application to lose its window.

Layout treats it as a leaf, and its X window follows that rect; every change
also sends the client the synthetic ICCCM 4.1.5 `ConfigureNotify` with
root-relative coordinates. Stacking is `<glarea>`'s: the child window sits
above everything drawn in the parent, so 2D content cannot overlap it — an
overlay belongs in a sibling `<popup>` — and pointer events over it are the
client's. `<foreign>` takes no children.

Keyboard focus is where this element has a rule of its own: **while a
`<foreign>` holds focus, the application's handlers see every key first and
anything they do not consume with `preventDefault()` is forwarded to the
client.** That, the XEmbed focus messages, the tab chain crossing the
boundary and the one case the rule cannot cover are all in
[embedding.md](embedding.md).

---

## 3D scene: `<mesh>`, `<group>`, geometries, materials

Moved to [`@react-x11/components/three`](ecosystem.md), which is a scene
graph with its own reconciler over the `<glarea>` above — and, unlike the
version that lived here, one that renders on **both** GL backends from the
same JSX. Core keeps the surface and `onDraw`; see [gl.md](gl.md).

## Vector drawings

`<svg>` is a drawing, laid out like an `<image>`: it reports an intrinsic
size and scales into the content box it is given.

Documents used to live here too — `<markdown>`, `<html>` and `<tex>`, thin
wrappers over ntk's document widgets. They were removed in react-x11 2.0:
each rendered a whole document as one opaque drawing, which foreclosed the
two things a document most needs — text selection across blocks, and
re-rendering only the block that changed while content streams in. Their
successors are components in
[`@react-x11/components`](https://github.com/sidorares/react-x11-components),
composed from public host elements rather than wrapping a widget:
`<Markdown>` (GFM, selectable, streaming-friendly) and `<Formula>` (KaTeX,
selectable), with `<RichText>` and `<CodeBlock>` underneath them.

### `<svg>`

ntk `SvgView` (static SVG via Path2D — paths, shapes, gradients,
transforms, basic text). Sized like `<image>`, and by the same style
properties: natural `viewBox` size, aspect-preserving when the style sets
only one of `style={{ width, height }}`, and scaled into the content box
when it sets both.

Content is **JSX children, like SVG in React DOM** — SVG elements are
declarative children with camelCase props (`strokeWidth`, `fillRule`;
native-camelCase attributes like `viewBox` stay as-is), re-rendered on
any prop change:

```jsx
<svg viewBox="0 0 24 24" style={{ width: 40, height: 40 }}>
  <circle cx={12} cy={12} r={10} fill={active ? '#2980b9' : '#ccc'} />
  <path d="M8 12l3 3 5-6" stroke="white" strokeWidth={2} fill="none" />
</svg>
```

A `source` markup string is also accepted (children win when both are
present). Supported elements/attributes are SvgView's (unsupported tags
are skipped); per-child event handlers are not dispatched — put handlers
on the `<svg>` element itself.

| prop      |                                   |
| --------- | --------------------------------- |
| children  | declarative SVG elements          |
| `source`  | SVG markup string                 |
| `viewBox` | coordinate system (children form) |

**`currentColor` and recolouring.** `fill="currentColor"` and
`stroke="currentColor"` resolve the way the word does in CSS: the node's own
`color` if it named one, otherwise the ink it inherits, and under that the
palette's `text`
([styling.md](styling.md#inheritance-the-ink-the-face-and-the-size)). So one
drawing serves every state the UI puts it in, and an unstyled one is
readable on a dark desktop rather than black on it:

```jsx
<svg
  source={icons.gauge}
  style={{
    width: 20,
    height: 20,
    color: '$fg',
    ':hover': { color: '$accent' },
  }}
/>
```

A drawing whose paint is entirely `currentColor` — or entirely one colour — is
cached as coverage rather than as pixels, so recolouring it is a composite and
not a re-render, and every colour of it shares one rendered copy. Drawings with
two colours or a gradient bake their colours in, which is right: those colours
belong to the drawing rather than to the UI. Nothing to configure either way.
`REACT_X11_DEBUG_PAINT_CACHE=1` shows what is being kept.
