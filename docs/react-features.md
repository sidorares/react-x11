# React features

You already know React. This page is about the parts where that knowledge
transfers unchanged, the parts where it transfers with a caveat, and the
four places where a habit from the DOM will quietly not work.

The short version: **everything in React core behaves exactly as documented.**
Hooks, context, error boundaries, `<Suspense>`, `lazy`, `use`, transitions,
`<Profiler>`, `<StrictMode>` — all of it. react-x11 is a normal React 19
renderer, and where React's behaviour does not depend on the DOM, it is the
same behaviour.

Everything on this page is also a panel you can drive by hand:

```sh
npm run examples:react-features
```

[`examples/react-features.jsx`](../examples/react-features.jsx) is priority,
`<Suspense>`, `useOptimistic`, `<Activity>` and the two error-boundary
placements, with the counters that show which of them React threw away.

What differs is anything the DOM used to define for you:

- **Paint timing.** A commit does not put pixels on screen. Frames go out on
  a clock, so "before paint" is a real, observable boundary.
- **Measuring.** There is no `getBoundingClientRect()` that forces layout.
  Layout has already happened, or it has not.
- **Hiding.** `<Suspense>` and `<Activity>` hide a `<box>` cheaply, but
  hiding a `<window>` genuinely unmaps it, and the window manager notices.
- **Portal containers.** There is no document to portal into.

## At a glance

|                                                                            |                                                                            |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `useState`, `useReducer`, `useContext`, `useMemo`, `useCallback`, `useRef` | unchanged                                                                  |
| `useImperativeHandle`, `forwardRef`, `ref` as a prop, ref cleanup          | unchanged                                                                  |
| `use(promise)`, `use(context)`, `React.lazy`                               | unchanged                                                                  |
| `useOptimistic`, `useActionState`, `<Profiler>`, custom hooks              | unchanged                                                                  |
| `useSyncExternalStore`                                                     | unchanged, and the best way to bridge non-React code                       |
| `useTransition`, `startTransition`, `useDeferredValue`                     | work, and really do stay responsive                                        |
| `useLayoutEffect` vs `useEffect`                                           | the difference is real — one paint versus two                              |
| `<Suspense>`                                                               | works; read [Suspense and Activity](#suspense-and-activity) for `<window>` |
| `<Activity>`                                                               | works for drawn nodes; known bug around a toplevel `<window>`              |
| Error boundaries                                                           | work — but **where you put one** decides if the window survives            |
| `<StrictMode>`                                                             | safe to use; effects are not double-invoked on the first mount             |
| `useId`                                                                    | works; there is very little here to use it for                             |
| `createPortal`                                                             | use [`<popup>`](elements.md) instead — see [Portals](#portals)             |
| `flushSync`                                                                | not exported; you almost certainly do not need it                          |
| `useFormStatus`                                                            | not wired up                                                               |
| React Server Components                                                    | not available                                                              |
| anything imported from `react-dom`                                         | not available — see [Not available](#not-available)                        |

## Effects, and the paint boundary

Put an effect that **changes what the user sees** in `useLayoutEffect`. Put
everything else in `useEffect`. That is the same rule as the DOM, and here
it has a directly observable consequence:

| you call `setState` from | what the user sees                                      |
| ------------------------ | ------------------------------------------------------- |
| `useLayoutEffect`        | one frame, with the corrected value                     |
| `useEffect`              | one frame with the old value, then a frame with the new |

So an adjustment made in `useEffect` flickers. This is not a timing race you
can get lucky with — updates from a layout effect are folded into the frame
being prepared, and updates from a passive effect are not.

The same boundary is why an event handler feels instant: react-x11 lands the
React update caused by a click or a keystroke **before** the frame goes out,
so the response and the default action paint together rather than a frame
apart.

```jsx
// good — the corrected size is in the first frame the user sees
useLayoutEffect(() => {
  if (tooTall) setRows(fits);
}, [tooTall, fits]);
```

## Measuring a node

**There is no forced synchronous layout.** Nothing you can call will make
layout run so you can read the result. This is the DOM habit most likely to
break on the way over, because in a browser `getBoundingClientRect()` both
reads _and_ triggers.

A node's `abs` rect (and `getClientRects()`) reports what the **last** layout
produced. On the very first render of a node, that is nothing yet.

What to do instead:

- **Let the element tell you.** `<box onViewport>` fires when the
  viewport or content size changes, with `width`/`height`/`contentWidth`/
  `contentHeight`. `<window onResize>` fires when the window is resized.
  These are the supported way to react to a size.
- **Read `abs` from a ref in a handler or a later effect**, not during the
  render that created the node.
- **Take a getter, not a value.** `useWindowId(ref)` and `useAnchor()` return
  getters for exactly this reason — a value captured during render would be
  `null` on the render where you needed it.

```jsx
const [cols, setCols] = useState(1);

<box
  style={{ overflow: 'scroll' }}
  onViewport={({ width }) => setCols(Math.max(1, (width / 200) | 0))}
>
  {items.map(…)}
</box>;
```

If you are porting a component that measures itself and adjusts, this is the
part to rewrite. See [elements.md](elements.md) for `onViewport` and
`onResize`, and [components.md](components.md) for `useAnchor`.

## What a ref gives you

Two different kinds of object, depending on the element:

- **`<window>` and `<popup>`** hand back the live **ntk window** — the
  object with `getContext('2d')`, and what
  [`windowIdOf()`](elements.md) resolves to an XID.
- **every other element** hands back its **node**: `focus()`, `blur()`,
  `focused`, `hitTest()`, `containsPoint()`, `getClientRects()`, and `abs`
  for its position and size. `<textinput>`/`<textarea>` additionally match
  the DOM closely enough that libraries like react-hook-form drive them
  through a ref.

A window ref is `null` until that window exists, and refs attach after the
commit — so read them in effects and handlers, never during render.

For `<canvas>`, note that the **node is not a drawing surface**. There is no
`getContext()` on it; you draw in `onDraw`, which the renderer calls with a
context whenever the canvas needs repainting:

```jsx
<canvas onDraw={(ctx, { width, height }) => { …}} />
```

To make it repaint, change something React can see — a prop, state, or the
`cacheKey`. That is the supported path, and it is usually what you want.
There is an imperative escape hatch for element authors in
[extending.md](extending.md), but note that it lives on the **owning
window**, not on the drawn node, despite what the bundled types currently
say (see [Known gaps](#known-gaps)).

## Transitions, and what stays responsive

`useTransition`, `startTransition` and `useDeferredValue` all work, and they
really do keep the UI responsive — React will interrupt a transition render
to handle an incoming click or keystroke.

What is worth knowing is that **transitions are the mechanism that does
this**. An ordinary `setState` — from a handler, a timer, a socket callback —
renders in one uninterruptible pass, however much work it is. If a render is
big enough to drop a frame, wrapping it in `startTransition` (or deferring
its input with `useDeferredValue`) is not a micro-optimisation, it is the
difference between a responsive window and a frozen one.

```jsx
const [pending, startTransition] = useTransition();

// typing stays instant; the expensive list catches up
const onChange = (e) => {
  setQuery(e.value);
  startTransition(() => setResults(search(e.value)));
};
```

Two smaller notes:

- `root.render()` is **synchronous** — the tree is committed before the call
  returns. Wrapping it in `startTransition` does nothing.
- A `startTransition` inside a click handler is still a transition. It does
  not inherit the handler's urgency.

react-x11 already classifies X11 input for you: presses, releases, keys,
focus changes, window close and drops are urgent; pointer motion and
drag-over are not, which is what keeps a motion burst from flooding the
renderer. You do not have to do anything to get this.

The Priority panel of the [react-features
example](../examples/react-features.jsx) is this paragraph with a slider on
it: a thousand-cell field that takes ~25ms to rebuild, on a switch. Off, the
thumb crawls; on, thirty slider updates produce one or two field rebuilds and
the thumb stays under the pointer. Two things there are worth copying, and
both are one-line mistakes in the other direction: the expensive subtree is
`memo`ised (or the urgent render rebuilds it anyway, and deferring buys
nothing), and no prop that changes on every update — not even a "stale"
border — is passed into it.

### Bridging non-React code

`useSyncExternalStore` is the right tool for anything that lives outside
React — a timer, a D-Bus signal, a socket, an ntk event. It is also faster
here than a hand-rolled `setState` bridge: a store notification is applied
urgently and lands in the next microtask, where the equivalent `setState`
waits a turn longer.

Every mainstream store (zustand, jotai, valtio, redux, XState) works with no
adapter for this reason. The [window-manager
example](../examples/wm.jsx) is the worked case: the WM core is a plain
store, and the UI subscribes to it.

## Suspense and Activity

`<Suspense>` works. The one thing to plan for is layout: a hidden subtree
gives up its space entirely, so the fallback lays out as if the real content
were not there. **Size your fallback deliberately**, or the window collapses
to the fallback and jumps back on reveal.

```jsx
<Suspense fallback={<box style={{ height: 240 }} />}>
  <Report />
</Suspense>
```

If a `<window>` is inside the boundary, hiding it **unmaps the real window**.
The window manager treats the reveal as a new window: it may re-place it,
restack it, or apply its own geometry, and anything the user did to it can be
lost. Prefer suspending _inside_ a window over suspending the window itself.

`React.lazy` works. If you ship a single-file bundle, note that dynamic
`import()` gets inlined — you keep lazy _evaluation_ but get no code
splitting; see [packaging.md](packaging.md).

`<Activity>` works for drawn content. Around a toplevel `<window>` it
currently has a bug — see [Known gaps](#known-gaps).

**Testing Suspense**: a promise that settles outside `act()` is not always
picked up by an `await act()`, because React throttles the commit when a
fallback was shown very recently. Use `waitFor` from `react-x11/test` —
see [testing.md](testing.md).

## Portals

**Use `<popup>`.** It is what you want in almost every case where the DOM
would reach for `createPortal`: a `<popup>` is written as an ordinary child
in your JSX — so it sees context, state and props exactly where you wrote it
— but it is a real top-level X window, so it escapes its parent's clipping
and can extend past the window edge.

```jsx
<box>
  <Button
    onClick={(e) => setAt({ x: e.nativeEvent.rootx, y: e.nativeEvent.rooty })}
  >
    Options…
  </Button>
  {at && (
    <popup
      x={at.x}
      y={at.y}
      width={180}
      height={120}
      grab
      onDismiss={() => setAt(null)}
    >
      <Menu />
    </popup>
  )}
</box>
```

Its position in the JSX has no effect on where it appears — you place it in
screen coordinates, and `useAnchor()` does that math for you when you are
anchoring to another node.

`Dialog`, `Tooltip`, `ContextMenu`, `MenuBar` and `Select` are all built this
way — see [components.md](components.md).

There is no `createPortal` export. The reconciler's own is reachable through
the `Renderer` escape hatch, but it is not a supported surface: the container
has to be an X connection or an X window rather than a node, and only
`<window>`/`<popup>` can be the portal's immediate child. If you find
yourself wanting it, you almost certainly want a second `<window>` or a
`<popup>`.

## Where to put an error boundary

Boundaries work exactly as documented. The X11-specific decision is
**placement**, and it decides whether the user's window survives:

```jsx
// good — the window and everything the WM knows about it survives
<window title="Editor">
  <ErrorBoundary fallback={<text>Something broke</text>}>
    <Document />
  </ErrorBoundary>
</window>

// the window itself is destroyed and recreated on a throw
<ErrorBoundary fallback={<window title="Editor">…</window>}>
  <window title="Editor">
    <Document />
  </window>
</ErrorBoundary>
```

A recreated window is a **new** window: its position, size, stacking,
maximized state and anything else the user or the window manager did to it
are gone. Put the boundary inside the window unless you genuinely want the
window replaced.

An **uncaught** error unmounts the whole tree, which here means every window
disappears while the process stays alive. `createRoot` takes
`onUncaughtError`, `onCaughtError` and `onRecoverableError` so you can decide
what that should mean for your app — the default logs and sets a failing exit
code. See [events.md](events.md).

One thing React does not cover: **a throw inside an event handler never
reaches a boundary.** (That is true in React DOM too.) react-x11 routes those
to `onUncaughtError` instead, so they are at least reportable rather than
silent.

## Smaller notes

**`useId`** works, but there is little use for it: no element takes an `id`,
there is no hydration, and labels are associated structurally (`<Checkbox
label>`, `<Radio>children</Radio>`). If you want a window's real identity,
that is `useWindowId()`. Avoid putting an `id` prop on `<window>` — unknown
props there are forwarded to the underlying window as creation attributes.

**`<StrictMode>`** is safe. A discarded render costs no X11 traffic, so
double-rendering never produces double windows. Be aware that effects are
**not** double-invoked on the initial mount, so it will not catch a missing
cleanup at mount the way it does in React DOM.

**`memo` / `useMemo`** save CPU, not bandwidth. Rebuilding a `style` object
or array every render is free — styles are compared by value, so an
identical style produces no layout work, no repaint and no frame. Passing
`style={[base, active && on]}` inline is the documented idiom, not a leak.
See [styling.md](styling.md).

**Keys** matter more for `<window>` children than for drawn ones. Reordering
`<box>` children is cheap. Reordering sibling `<window>`s restacks real
windows, and a missing key destroys and recreates them — with the same loss
of window-manager state described above. To keep a window on top, use
`alwaysOnTop` rather than ordering.

**DevTools** works — set `REACT_X11_DEVTOOLS=1` and the component tree,
props and highlight-on-hover all behave normally, with the highlight drawn
into the real window. The Profiler **Timeline** tab is unavailable; the
commit list and flamegraph work. See [devtools.md](devtools.md).

**Fast Refresh** works without a bundler. Keep anything whose identity must
survive a reload — contexts, stores — in a module you are not editing. See
the [hot-reload example](../examples/tasks-hot.jsx).

## Not available

**`react-dom`.** It is not a dependency, so `ReactDOM.createPortal`,
`flushSync`, `findDOMNode`, `hydrateRoot` and `unstable_batchedUpdates` are
not part of react-x11.

The trap is not the import error — it is that `react-dom` is a required peer
of some libraries, so it can end up installed anyway. Then the import
resolves, and `flushSync()` runs your callback **without flushing anything**,
because it is talking to a renderer you are not using. If a library depends
on synchronous flushing, check `npm ls react-dom`. The
[ecosystem register](ecosystem.md) records which packages hit this.

**Server Components** are not available: there is no Flight client wired up.

**`useFormStatus`** is not wired up. `useOptimistic` and `useActionState` are
unaffected and work normally.

## Known gaps

Open bugs where a React feature does not yet mean here what it should:

- [#201](https://github.com/sidorares/react-x11/issues/201) — `<Activity
mode="hidden">` around a toplevel `<window>` leaves the window **visible**
  when a window manager is running.
- [#202](https://github.com/sidorares/react-x11/issues/202) — hiding a
  subtree with `<Suspense>` or `<Activity>` does not move focus out of it, so
  a focused control keeps receiving keystrokes while invisible.
- The bundled types declare `invalidate()` on every node; at runtime only the
  owning `<window>` has it. Reach it as `ref.current.root` — or better, drive
  repaints through props and `cacheKey`.
