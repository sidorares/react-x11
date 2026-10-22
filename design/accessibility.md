# Accessibility: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/accessibility.md](../docs/accessibility.md), the reference, and keep
their original headings so code comments that cite them still resolve.

The page's introduction, as it was before the reference was tightened:

> **This is the Linux bridge; the win32 backend has one of its own and Cocoa
> has none.** On **win32** the same tree is pushed to UI Automation instead
> (`src/win32/a11y.js`, [windows.md](../docs/windows.md#accessibility-ui-automation)),
> because UIA asks synchronously and is answered from a pushed copy rather
> than from the live tree. AT-SPI
> is a freedesktop protocol with nothing to register against on macOS, so on
> the **Cocoa** backend `createRoot()` leaves it off (`desktop: { a11y:
false }` by default there) and no `NSAccessibility` bridge has been built
> in its place — a Cocoa-backend app is not yet reachable by VoiceOver.
> Everything else on this page still earns its keep there: `role`, `aria-*`
> and `announce()` are properties of the shared node tree, keyboard
> traversal and the widgets' own semantics are shared code, and all of it is
> what an `NSAccessibility` bridge will read when it lands
> ([macos.md](../docs/macos.md), Phase 5). Write them now; nothing changes when it
> does.

## The props

Two deliberate absences. There is no `aria-disabled`: `disabled` is already
a host prop with real behaviour (it blocks focus and drives `:disabled`
style blocks), and a parallel prop that only _said_ disabled would let the
two disagree. And there is no `aria-labelledby`/`aria-describedby`: there
are no element ids to point them at — use `aria-label`, or lean on
name-from-contents.

## Text controls

### While a composition is open

A dead key or a half-typed Compose sequence puts text on the screen that is
in nobody's value yet ([events.md](../docs/events.md#composition)). The `Text`
interface answers with **what is drawn**, that preedit included, and its
offsets index that string — because every geometric answer beside it is
read off the layout of the same string, and a magnifier tracking character
3 has to land on the glyph a sighted user sees. `CaretOffset` is at the far
end of the composition, where the next keystroke of the sequence appears.

Which part of it is uncommitted is said twice, so a reader can act on
either:

- the preedit is its own **attribute run** — `underline: single`, the
  registered AT-SPI attribute for what is literally drawn, plus
  `composition: true`, which is this renderer's own because AT-SPI
  registers nothing for a preedit;
- its churn is **`:system`** text — `text-changed:insert:system` when the
  accent appears, `delete:system` when it changes or is abandoned. That is
  the suffix Gecko established for a change the user did not type, and it
  is what lets a reader stay quiet through a composition.

What the sequence **commits** is a plain `insert` of the finished
character: `é` is what the user typed, and it is spoken, once, as one
insertion — the same event an ordinary keystroke produces, which is also
why it is one undo step and not two.

Nothing here is announced through `announce()`. A live-region announcement
on top of the text-changed feed would have a screen reader say the accent
twice; an application that wants to narrate composition state can call
`announce()` itself from `onCompositionUpdate`.

## How often the bridge speaks

A bridge mirrors the tree for a platform that reads it on its own schedule,
and pushing the mirror on every commit is paid by everything that commits
often: a scroll, a pan, a value ticking. That was mostly paid for nobody.
An AT-SPI bus runs in most Linux sessions whether or not a screen reader
does, and a 100,000-row `<Table>` flung through it exported, diffed and
unexported every row that scrolled past: 31 frames a second against 38 with
the bridge off. On Windows the same push was 1.6 ms of every frame of a
graph pane's pan. So both bridges pace what they push (`src/a11ypace.js`),
the way browsers do. Chromium batches non-interactive accessibility updates
150 ms apart once a page has loaded, and bounds 500 ms apart, and serializes
focus and selection at once.

### With nobody listening

Pacing bounds what a push costs. It does not help when nobody hears the
push, which is the usual case: the bus runs whether or not a screen reader
does. Dragging a scrollbar thumb down a 100,000-row `<Table>` ran at 19
frames a second with the AT-SPI bridge on and 24 with it off, and nothing on
that desktop was listening. So the bridge asks the registry.

An AT registers the events it wants with the registry. The registry answers
`GetRegisteredEvents` and announces each new listener, and GTK 4 and
at-spi2-atk use that to hold back the events nobody asked for. Both still
send the cache's signals and `children-changed` regardless, because libatspi
listens for those in every client without registering. So an empty list is
not the whole answer. An AT that registered for nothing still has to call in
to read anything, and a call from anybody but the registry counts too.

## What is deliberately not there (yet)

- **Relations** (`aria-labelledby`, label-for) — needs an id registry;
  `aria-label` and name-from-contents cover the widgets.
- **The Selection interface** on containers — Orca reads per-item
  SELECTED states and selection is driven through actions and focus, so
  this is polish, not a gap in coverage.
- **The Table interface** — `Table` exposes honest `table`/`row`/`cell`
  roles with positions, but not the row/column navigation calls; note that
  virtualization means only rendered rows exist in the accessible tree,
  which is also all a sighted user can see.
- **Key-event forwarding** (`DeviceEventController.NotifyListenersSync`) —
  Orca's per-keystroke echo of _keys themselves_; typed characters already
  arrive through text-changed events.
- **Soft-wrap line granularity** in `<textarea>`, per above.
- **An input method** — dead keys and Compose are the whole composition
  story today, so a script that needs a candidate window (any CJK) cannot
  be typed at all, accessibly or otherwise. What an IME would report is
  already here: the preedit is a text run and its own `:system` feed, so
  the work left is the input method, not its accessibility.
