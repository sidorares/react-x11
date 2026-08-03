# React features

Everything that lives in React core works here unchanged, because
`src/Reconciler.js` is an ordinary mutation renderer: `supportsMutation:
true`, no persistence, no hydration. That is the configuration React's
context, error, effect and Suspense machinery expects, so hooks, error
boundaries, `<Suspense>`, `lazy`, `use`, transitions and `<Profiler>` all
behave the way the React docs say they do.

What changes is anything whose meaning was defined by the DOM. There are
four of those, and they are the whole of this page:

- **Paint timing.** A commit does not paint. Pixels arrive on ntk's frame
  clock, which is a timer _and_ an X fence.
- **Measurement.** There is no forced synchronous layout — no
  `getBoundingClientRect()` that flushes layout on demand.
- **Hiding.** `display: none` on a `<box>` is a Yoga flag; on a `<window>`
  it is a real `UnmapWindow` on the wire.
- **Containers.** A portal container is an X connection or an X window, not
  a node.

## At a glance

|                                                                            |                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `useState`, `useReducer`, `useContext`, `useMemo`, `useCallback`, `useRef` | work, unchanged                                                 |
| `useSyncExternalStore`                                                     | works, and is the preferred bridge — see below                  |
| `useTransition`, `startTransition`, `useDeferredValue`                     | work, and genuinely time-slice                                  |
| `useOptimistic`, `useActionState`                                          | work (pure core; no host involvement)                           |
| `useLayoutEffect` vs `useEffect`                                           | the distinction is real and matters                             |
| `useImperativeHandle`, `forwardRef`, ref-as-a-prop, ref cleanup            | work                                                            |
| `<Suspense>`, `React.lazy`, `use(promise)`, `use(context)`                 | work                                                            |
| `<Activity>`                                                               | works, with a known bug for toplevel `<window>`                 |
| Error boundaries                                                           | work; **placement relative to `<window>` matters**              |
| `<StrictMode>`                                                             | safe; effect double-invocation is suppressed at mount           |
| `<Profiler>`                                                               | works                                                           |
| `useId`                                                                    | works, but there is almost nothing here to use it for           |
| `createPortal`                                                             | reachable via `Renderer`, with real constraints                 |
| `flushSync`                                                                | no export; `Renderer.flushSyncFromReconciler` is the equivalent |
| `useFormStatus`                                                            | not wired                                                       |
| Server Components                                                          | not attempted                                                   |
| anything from `react-dom`                                                  | not available — see [Absent](#absent)                           |

## Effects, and what "before paint" means

On the paths that matter, effect ordering is a hard guarantee rather than a
race. `root.render()` goes through `updateContainerSync`, which hard-codes
the sync lane, and every discrete X11 event runs at `DiscreteEventPriority`,
which _is_ the sync lane. On a sync-lane commit React flushes passive
effects synchronously inside the commit itself, so nothing can interleave
between the mutation phase and `useEffect`.

The distinction that survives is about which lane your `setState` lands on:

|                                   | lane              | flushed by `flushSyncWork()` | result                                                       |
| --------------------------------- | ----------------- | ---------------------------- | ------------------------------------------------------------ |
| `setState` from `useLayoutEffect` | Sync              | yes                          | folds into the same frame — **one paint**                    |
| `setState` from `useEffect`       | Default (floored) | no                           | the intermediate state paints, then a second commit repaints |

So the DOM rule holds: **measure-and-adjust belongs in `useLayoutEffect`**,
and doing it in `useEffect` produces a visible flash. `src/priority.js`
explains the flush that makes this work — a discrete handler that has
returned has not yet seen React's half of its own response, so the
dispatcher lands the commit before ntk blits.

`commitMount` runs before refs attach, which is why `<popup>` realization,
`autoFocus`, `trapFocus` and drop-target registration all happen there: the
node has to be in the tree, and the window has to exist, before anything
can be handed out.

## Measurement — the one that does not transfer

There is no forced synchronous layout. Yoga layout runs on the frame clock
(a 16 ms timer _and_ an X fence — see `src/frames.js`), not on demand, so a
node's `abs` rect is not necessarily meaningful during the commit that
created it. `getClientRects()` reads what the last layout produced; it does
not cause one.

The consequences are visible throughout the library, and they are the
idiom to copy:

- `useWindowId()` and `useAnchor()` return **getters**, not values — refs
  attach after the commit that created the window, so a value read during
  render would be `null` on exactly the render that matters.
- `Table` ships an `ASSUMED_ROWS` constant, with the comment that there is
  always one render that has to guess.
- The replacement for measure-in-effect is a **post-layout callback**:
  `<scrollview onViewport>` (fired from `absolutize`, deduped, with
  `scrollWidth`/`scrollHeight` semantics) and `<window onResize>`.

If you are porting DOM code, this is the pattern that will not survive
translation. Reach for `onViewport` rather than a `useLayoutEffect` that
measures.

## Refs on host nodes

`getPublicInstance` hands out two unrelated kinds of object:

- **`<window>` and `<popup>`** → the live **ntk window** (`<popup>` too:
  `PopupNode extends WindowNode`, and `commitMount` realizes it before refs
  attach). If the window is not realized or has been destroyed, the ref
  holds the `WindowNode` instead — so "a window ref is always an ntk window"
  is not an invariant you can lean on.
- **everything else** → the retained react-x11 `Node`, the same object the
  paint walk, hit test and Yoga layout use: `focus()`, `blur()`, `focused`,
  `contains()`, `hitTest()`, `getClientRects()`, `paintOrder()`,
  `containsPoint()`.

From an ntk window you can get back to the node through
`window._reactX11Node`, which `realize()` stamps.

Two edges worth knowing. `invalidate()` is defined only on `WindowNode`, so
from a drawn node you reach it through `.root`. And a `<canvas>` ref has
**no `getContext()`** — drawing is a paint-phase _pull_, so the imperative
idiom is to mutate a ref and then ask the renderer to pull:

```js
canvasRef.current.root.invalidate(false, canvasRef.current, 'style-state');
```

The built-in text-input edit menu does exactly this: it keeps its hovered
row in a plain mutable object and repaints with `invalidate`, with no React
render involved.

## Concurrency

Transitions and `useDeferredValue` genuinely time-slice — the Scheduler
yields in Node just as it does in a browser. But the set of lanes that gets
the interruptible work loop is narrower than you might assume:

- **Sync, InputContinuous and Default all take the synchronous work loop**,
  with no yield check. So an ordinary `setState` — from a click, from a
  timer, from a socket callback — renders in one uninterruptible pass.
- **Time slicing happens only** on transition lanes, retry lanes (an
  ordinary Suspense retry slices, with no transition involved), the deferred
  lane, and the idle lane.

Three more things that surprise people:

1. **`root.render()` is always synchronous.** It calls
   `updateContainerSync` and then flushes, so the tree is committed before
   the call returns. Wrapping it in `startTransition` does nothing — the
   sync lane is baked in.
2. **Transitions override the event-priority mapping, not the other way
   round.** `startTransition` inside a mousedown handler takes a transition
   lane; the `DiscreteEventPriority` the dispatcher just installed is never
   consulted.
3. **React 19 unifies the top three lanes.** Sync, InputContinuous and
   Default are selected together, so a hover update and a resize update
   render in the _same_ pass, at the higher priority. A slow resize is
   promoted by a concurrent hover rather than starved by it.

`src/events.js` maps X11 events onto React's priorities: presses, releases,
keys, focus/blur, popup dismiss, WM close and XDND drop are **discrete**;
motion, mouse-out and drag-over are **continuous**. Only genuinely discrete
work is flushed synchronously — a continuous-priority update is scheduled,
not flushed, which is what makes a motion burst coalesce.

There is no `flushSync` export. The equivalent is
`Renderer.flushSyncFromReconciler(fn)`, and note it **commits without
painting**: same-turn pixels are what `flushSyncWork()` plus
`flushPendingFrames()` produce, which is what the event dispatcher does.

### `useSyncExternalStore`

Preferred over a hand-rolled `setState` bridge, and not only for tearing.
A store notification is dispatched on the sync lane regardless of what
priority is installed, and with `supportsMicrotasks` the render and its host
commit land in the **next microtask**. The same `setState` from the same
call site waits for the next macrotask.

That makes it the right way to bring anything outside React — an ntk timer,
a D-Bus signal, a socket — into the tree. `examples/wm.jsx` is the worked
example: the window-manager core is a plain store and the UI subscribes to
it.

## Suspense, lazy, Activity

`<Suspense>` works. `hideInstance` sets Yoga `DISPLAY_NONE`, so the hidden
primary tree **vacates its layout box entirely** and the fallback lays out
as if it were not there. Size fallbacks deliberately, or the content box
collapses to the fallback and jumps back on reveal.

Three things have no DOM analogue:

- **A hidden `<window>` is really unmapped.** `WindowNode.setHidden`
  overrides without calling `super`: it sends `UnmapWindow`/`MapWindow` and
  never touches Yoga. So the window manager gets a fresh map request on
  reveal — re-placement, restacking, WM-decided geometry — and, because
  Yoga is untouched, the window still occupies its parent's layout box while
  invisible.
- **Only the topmost host instance of each hidden branch is hidden.**
  Descendants keep `hidden === false` and collapse purely because an
  ancestor is `DISPLAY_NONE`. Code that reads `node.hidden` on a node other
  than a branch root sees `false` inside a hidden subtree.
- **Focus is not released.** See [Known gaps](#known-gaps).

`React.lazy` works. Under the single-file bundling path a statically
resolvable `import()` is inlined by esbuild: you keep deferred _evaluation_,
but there is no code splitting and no bytes saved. See
[packaging.md](packaging.md).

`<Activity>` works — children render once, refs do not attach, effects do
not run — with one bug for toplevel windows, below.

Testing note: a promise that settles _outside_ `act()` is not necessarily
picked up by an `await act()`. React throttles a retry-lane commit behind a
real `setTimeout` when a fallback was shown recently, and that timer is this
renderer's plain `setTimeout`. Use `waitFor` from `react-x11/test`.

## Portals, and why `<popup>` is usually the answer

There is no `createPortal` export. It is reachable as
`Renderer.createPortal`, since `src/index.js` re-exports the reconciler, and
it works with two real constraints:

- The portal's immediate host child must be **`<window>` or `<popup>`** —
  the only nodes with `realize()`. A `<box>` throws.
- The container must be an **ntk App** (giving a new top-level window) or a
  **live ntk window** from a `<window>` ref (giving a nested child X
  window). A react-x11 node is not a container.

Portaling into a window ref has a quiet trap: the whole portaled subtree
inherits that window as its `app`, so `app.fonts` and `app.clipboard` are
missing — `<text>` inside it measures nothing and renders nothing, without
an error.

For almost every case where the DOM would reach for a portal, **`<popup>`
is the tool**. It is an ordinary fiber child wherever you write it in JSX,
but its X window is created against the screen root, so it escapes its
parent's clip without leaving the React tree. Which means the DOM's "a
portal still sees context" rule holds here without portals being involved:
a provider around a menu trigger is read by the popup's contents.

`Dialog`, `Tooltip`, `ContextMenu`, `MenuBar` and `Select` are all built
this way — see [components.md](components.md).

## Error boundaries

`getDerivedStateFromError` and `componentDidCatch` work unchanged; nothing
in the host config sits on the capture path. The callback order is
`getDerivedStateFromError` → the root's `onCaughtError` → `componentDidCatch`,
so `onCaughtError` cannot observe state the boundary just set.

The X11-specific decision is **where you put the boundary**:

| boundary               | on a throw                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **inside** `<window>`  | contents are swapped; the X window survives with the same id, position, stacking and `_NET_WM_STATE`                 |
| **outside** `<window>` | the subtree is deleted, so the X window is **destroyed**; a fallback rendering `<window>` again gets a brand-new one |

A remount is not an update. Anything the window manager or the user did to
that window — moved it, maximized it, tabbed it — is gone. Put the boundary
inside the window unless you actually want the window replaced.

An **uncaught** error unmounts the whole tree, which here means every
toplevel `<window>` is destroyed: a live process with an open socket and no
windows. That is why the default handler sets `process.exitCode = 1`. The
root is not poisoned — rendering into it again works — but any ntk window
held from a ref is now a destroyed id.

A throw from an **event handler** never reaches a boundary. It has no React
frame on the stack, and the reconciler does not export the entry point that
would let a renderer inject one. (React DOM does not route handler throws to
boundaries either — this is not a react-x11 limitation so much as a place
where `onUncaughtError` is _extended_ to cover a channel React leaves
alone.) See [events.md](events.md) and `src/errors.js`.

## Smaller notes

**`useId`** works, but there is nearly nothing to use it for: no host
element takes an `id`, there is no hydration, and association is structural
(`<Checkbox label>`, `<Radio>`). The identifier this renderer actually has
is the XID — see `useWindowId()`. Note that an unknown prop on `<window>`
is forwarded to ntk as a creation attribute, so an `id` there is not inert.

**`<StrictMode>`** is safe: `createInstance` performs no X11 calls, so a
discarded render costs no protocol traffic and double-rendering never
doubles windows. Be aware that effect double-invocation is **suppressed on
the mount commit**, because `render()` wraps every tree in a context
provider and React's DEV double-invoke walk stops at a newly-placed
non-strict fiber.

**`memo` / `useMemo`** save CPU, not protocol bytes. There is no
`diffProperties` layer: every re-rendered host element gets `commitUpdate`
→ `applyProps` on plain reference inequality of the props object. The waste
is absorbed one level down by `_paintChanged`, which compares paint-relevant
style **by value**, so a style object React rebuilt with the same contents
produces no Yoga writes, no damage and no frame. Passing a fresh style array
every render is the documented idiom, not a leak.

**Keys** cost different things for different elements. Reordering `<box>`
children issues **zero** X11 requests (a Yoga reparent plus a bounded
repaint). Reordering `<window>` children costs one restack pass of `n-1`
`ConfigureWindow` requests — O(n), not O(moved) — coalesced into a single
pass by `flushWindowRestacks` in `resetAfterCommit`. Reordering _toplevel_
windows emits nothing at all; use `alwaysOnTop`. Missing keys therefore
widen a repaint for drawn nodes but destroy real server resources for
windows.

**DevTools** works behind `REACT_X11_DEVTOOLS`, and highlight-on-hover
tints the real rect in the X11 window. The Profiler **Timeline** is not
available (the reconciler no longer exposes the hook it needs); the commit
list and flamegraph work, in a development build. See
[devtools.md](devtools.md).

**Fast Refresh** works with no bundler, through Node's module hooks — see
`examples/hmr-register.mjs`. Keep anything whose identity must survive a
reload (contexts, stores) in a module you do not edit.

## Absent

`react-dom` is neither a dependency nor a peer dependency, so
`ReactDOM.createPortal`, `flushSync`, `findDOMNode`, `hydrateRoot` and
`unstable_batchedUpdates` are not reachable through react-x11.

The failure mode to watch for is not the import error. `react-dom` is a
required peer of some libraries, so a default install can pull it in, the
import resolves, and `react-dom@19`'s `flushSync()` called outside any
react-dom root runs the callback without throwing — silently not doing the
synchronous flush the library depends on. Run `npm ls react-dom` before
trusting a passing import. See [ecosystem.md](ecosystem.md).

Server Components are not attempted. Nothing structurally rules them out —
the reconciler has no knowledge of RSC either way — but there is no Flight
client wired up and no transport for one.

`useFormStatus` is not wired: the host transition context is a stub.
`useOptimistic` and `useActionState` are unaffected, since they are pure
core.

## Known gaps

Tracked bugs where a React feature does not yet mean here what it should:

- [#201](https://github.com/sidorares/react-x11/issues/201) — `<Activity
mode="hidden">` (and an initial-mount `<Suspense>`) around a toplevel
  `<window>` leaves it **mapped and visible** when a window manager is
  present, because the redirected `MapWindow` outlives the `UnmapWindow`
  that follows it.
- [#202](https://github.com/sidorares/react-x11/issues/202) — hiding a
  subtree does not release focus, so keys keep landing on a control the user
  cannot see.
