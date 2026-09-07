# Frame pacing: a budget over paint time, not a count of updates

_Design record, 2026-09-07. Written against master at 25d6869 (react-x11
2.8.3, ntk ^8.7.0, `@windowkit/appkit` ^0.6.0), for the `frameRate` prop
that shipped with it. The user-facing account is
[elements.md](../elements.md#framerate--pacing-the-frames-under-a-flood);
this is why it is shaped the way it is, where it sits, and what it
measured. The problem was found in `@react-x11/components`'s vt terminal
(sidorares/react-x11-components#69, "PRD: adaptive frame pacing"), whose
§6 lists what core would have to grow; this document is core's half of it,
made generic._

---

## 0. TL;DR

- A window fed off an input path — a terminal under `cat`, a chart on a
  socket, a simulation, a scene drawing as fast as it can — claims a repaint
  every time its data moves. The frame clock decides _when_ a frame may go
  out and says nothing about whether it is worth painting, so on a 120Hz
  panel such a window paints 120 times a second. Where a frame costs
  milliseconds of the JS thread (full-window CoreGraphics on macOS), the
  thread paints screens nobody sees and the producer gets what is left:
  measured on a streaming terminal, 60% of wall time in paint and a flood
  four times slower on macOS than under XQuartz on the same machine.
- The fix prices frames in **CPU time**, not in updates: a token bucket
  over paint time. Credit accrues at `budget` per millisecond of wall time
  up to a burst; a frame spends what it measurably cost; a claim that finds
  the bucket in debt waits for it to reach zero and no longer. Idle is
  immediate, cheap is unthrottled, one expensive frame among cheap ones is
  free, and a flood that ends is un-throttled on its next claim.
- It lives **above both frame clocks**, in `WindowNode._scheduleFrame` and
  `GlAreaNode.requestFrame`: a held claim delays the `requestAnimationFrame`
  request, and the clock — ntk's fence or vertical blank on X11, the display
  period on macOS — still gates the frame itself. Nothing changes what a
  frame paints.
- **Opt-in.** `'display'` — every frame the clock gives, after React's own
  batching — is the default; `'adaptive'` is what a streaming window asks
  for, on the `<window>` or `<glarea>`, for a root, or from
  `REACT_X11_FRAME_RATE`.
- Beside it, `Node.opaqueRect()`: an element that composites an opaque
  bitmap over its box says so, and a pass inside it skips the fills that
  were under it — the other fifth of the terminal's frame.

## 1. The problem, measured

The components PRD's numbers, on an M1 Pro with a 120Hz panel, a 1000×700
window at 2×, a 125×45 terminal grid and 300,000 distinct lines `cat`-ed
into its pty:

| variant                                       |  flood | paints/s | paint share |
| --------------------------------------------- | -----: | -------: | ----------: |
| Cocoa, defaults                               | 3.50 s |      110 |         60% |
| Cocoa, `cocoa: { frameInterval: 33.3 }`       | 1.08 s |       34 |         21% |
| X11 (XQuartz), defaults                       | 0.85 s |       35 |          7% |
| Cocoa, an element-owned pacer at a 25% budget | 0.95 s |       35 |         20% |

Three facts fall out of it. **Frame count is the lever**: both backends
run the clock at the display's period, but the X11 frame is _fenced_ — ntk
does not start the next until the server has consumed the last, and the
server takes ~28ms to composite a screenful of glyphs, so the terminal
paints 35 times a second by backpressure. The Cocoa backend has no
equivalent: its "server" is CoreGraphics on the JS thread and the frame is
due whenever the display is. **Per-frame cost is full-area memory passes,
not glyphs**: of a 6ms Cocoa frame, 2.0ms is the cell backgrounds, 1.7ms
the surface-to-window composite, 0.95ms the swapchain catch-up copy,
0.7ms two background fills under the opaque surface — and 0.26ms the
glyphs. **A fixed cap is the wrong tool**: `frameInterval: 33.3` recovers
most of the gap and costs every window on the root its 120Hz, including
the ones whose frames are cheap.

## 2. The rule

The PRD's rule was "defer a claim until `lastPaintEnd + cost × (1/budget −
1)`", from the last frame's cost. That is the right steady state and the
wrong transient: it holds the frame after a single expensive one — the one
relayout in a blit-scrolled list — for three times its cost, on a scroll
that should stay at 120Hz because everything else in it is a memmove and a
strip. The user's requirement was exactly that case: _budget CPU price,
not the number of updates; a scroll that is mostly blits stays at 120Hz
with rare repaints._

The token bucket is the same rule with a burst (`src/pacing.js`,
`FramePacer`):

```
credit  += budget × (now − lastAccrual), capped at burst
frame:   credit −= cost                        // what the flush measured
claim:   wait = credit ≥ 0 ? 0 : −credit / budget
         wait = min(wait, lastEnd + 1000/minFps − now)   // the floor
         wait = max(wait, lastStart + 1000/maxFps − now) // the ceiling
```

- With the bucket at zero, a frame of cost `c` leaves it at `−c(1 −
budget)` and the next claim waits `c(1/budget − 1)` — the PRD's rule, in
  steady state under a flood. Over a long stream the paint share converges
  on the budget exactly (`test/pacing.test.js`, "converges on the budget").
- The **burst** is what absorbs the rare expensive frame: a single frame up
  to the burst never earns a wait, and only a stream drains it. The burst
  is the floor's interval (50ms at `minFps: 20`), 50ms without a floor —
  one frame up to the longest wait the pacer may impose is always free.
- The debt is bounded by one frame's cost, so a flood that ends is
  un-throttled after that one wait. An average would have kept throttling
  the prompt that appears when the flood stops.
- Waits under a millisecond are not armed: a timer cannot keep them and a
  clock tick would swallow them. The debt carries to the next claim, so a
  run of sub-millisecond frames claimed back to back still pays once it is
  worth a timer, and a cheap frame after a flood lands on the tick it would
  have landed on anyway.

**Cost is the JS thread's time.** The flush — layout, the paint passes, the
requests or the CoreGraphics work — bracketed in `WindowNode.flush`, plus on
macOS the present that runs after it (`CocoaWindow.present` reports the
flip and its catch-up copy back to the node). Not the server's: on X11 the
fence already paces to that, and the pacer is deliberately inert where a
backend has backpressure of its own. The PRD's Q5 asked whether a core seam
reporting the whole flush's cost would make the rule exact on both
backends; the answer is that the thread's time _is_ the cost the rule is
about, because it is what the producer is starved of.

## 3. Where it lives, and what it composes with

The pacer is per frame source: one on each `WindowNode` (popups included)
and one on each `GlAreaNode`, whose frames run on a clock of their own.
`_scheduleFrame` asks it before requesting the window's callback; a claim
raised by the frame on itself — an animation stepping, a container query
settling, a promotion moving a node — is answered once the frame is over,
so the frame that raised it is the one priced.

- **The clocks.** A held claim delays the `requestAnimationFrame` request
  by the wait; the clock then gates the frame as it always did. On macOS a
  request between two pump ticks used to wait for the next tick to look at
  it, up to a pump interval on top of the wait; `CocoaApp._requestFrame`
  now arms the same one-shot a tick arms for a frame it just missed, at the
  moment the clock is due, so a paced claim lands at its wait rather than
  its wait rounded up to the pump. On X11 ntk's clock is untouched.
- **Discrete input.** A click or a key paints the window at once
  (`flushPendingFrames`, [events.md](../events.md)), held claims included —
  a held claim is damage like any other, and the early flush stands the
  wait down. The debt is paid then. Answering the input is never held.
- **Animations.** A transition's frames go through the same claims and are
  paced like any other; at the default nothing changes, and under
  `'adaptive'` cheap transition frames never wait. A layer promotion's
  animations run in the render server and schedule no frames at all.
- **Hidden and occluded windows** schedule no frames; the bucket refills
  while they wait, so the catch-up frame is immediate.
- **`cocoa: { frameInterval }`** is still the clock's own cap on macOS and
  applies to everything on the clock; `frameRate` is the policy above it,
  per window, on both backends. `maxFps` is the cap an app should write.

## 4. The API

`frameRate` on `<window>`, `<popup>` and `<glarea>`; `createRoot({
frameRate })` for a root's default; `REACT_X11_FRAME_RATE` over both. A
preset name, a number (a ceiling and nothing else), or `{ budget, minFps,
maxFps }` with the ones left out taken from `'display'`. A `<glarea>` takes
its window's policy unless it names one. Resolved in `src/pacing.js`
(`resolveFrameRate`, `resolveFramePolicy`), validated at the call that
passed the value — a bad root option fails at `createRoot`, a bad prop at
the window — with the choices in the error.

Decided, and why (the PRD's §11, answered for core):

- **The name** is `frameRate`: it is what an author thinks in, and the
  numeric form reads as a cap.
- **The environment overrides the prop**, as `REACT_X11_BACKEND` does: an
  A/B run and a field diagnosis must not need a code change in every app.
- **A number is a ceiling over the default**, not over `'adaptive'`. With
  `'display'` the default, `frameRate={30}` has to mean "never more than
  30" and nothing else; adaptive-and-capped is spelled with the numbers.
- **The default is `'display'`.** A UI answers its input as quickly as it
  can unless it says otherwise; the pacer is what a window that streams
  asks for. It costs the default path one property read per claim.
- **Several windows pace themselves.** Four floods at once can take four
  budgets; a shared budget is a process-level clock and is not built.

Observability: `REACT_X11_TRACE=requests` prints `waited=` on every frame
the pacer held ([debugging.md](../debugging.md)), the `frame` trace hook
carries it, and the pacer's counters — frames, held, coalesced, the last
cost and the last wait — are on the node for a bench to print.

## 5. The opaque-content hint

Of the terminal's 6ms frame, 0.7ms was two background fills under a
surface that covers every pixel of them, and on X11 the same fills are
composites the server ran for nothing. Core had no way to know.
`Node.opaqueRect()` is the element's word: the rect it writes opaque pixels
over on every paint, in whole pixels; a pass inside it is painted without
the clear, the window's background, and the backgrounds of the node and its
ancestors. Clipping ancestors shrink the cover to what reaches the surface,
a rounded one by its radius all round. The element claims its damage as a
rect inside the answer, because a node claim carries a pixel of slop that
lies outside it ([extending.md](../extending.md#an-element-that-covers-its-box)).
Pinned by `test/opaque-content.test.js`: the fills skipped are exactly
those, and a covered pass leaves the pixels a full repaint leaves.

## 6. What is not here, and why

Two of the PRD's four seams need the native bridge first, and the third
needs a design of its own. Each is filed rather than folklore:

- **`globalCompositeOperation` on the Cocoa context, with a memcpy for
  `'copy'`** (the 1.7ms surface-to-window composite). `@windowkit/appkit`
  0.6.0 has no blend-mode verb, and its one memcpy, `copySurfaceRegion`,
  refuses surfaces of unequal size — it is the swapchain's catch-up copy,
  not a blit. Both verbs are the bridge's to grow; the property is declared
  optional on `Context2D` in the meantime, so an element asks for it
  rather than assumes it.
- **Element-owned layer contents** (`presentSurface()` on a node over an
  IOSurface-backed `Surface`, so the terminal's surface _is_ its layer and
  the present and the swapchain copy disappear). The bridge has the
  primitives — `createSurfaceIOSurface`, `setLayerContentsIOSurface` — but
  a layer showing an IOSurface the element then draws into again tears; it
  needs a two-buffer chain of its own, a flip on present, and the promotion
  policy of `src/cocoa/promotion.js` extended to "this node presents a
  surface" with the same z-order rule. A design document first.
- **An adaptive tick-skip in the Cocoa clock.** Not needed: with the pacer
  above the clock the clock has no tick to skip — a window that is holding
  a claim has no callback queued.

## 7. Measured

`npm run bench:presenters -- --scenario=stream` is the flood in core's own
terms: a window-sized element that answers `opaqueRect()`, painting a
120×40 grid of cell fills, claimed every 2ms from a timer — the producer —
with `--frame-rate` choosing the policy. Read `cpu` and the paint share
against `claims/s`, which is how often the producer got the thread.

On the M1 Pro's 120Hz panel, a 900×700 window at 2× (the stream pane is
the window less a header), six seconds a cell, `--columns=surface`:

| `--frame-rate` |   fps | flush avg | paint share of wall | cpu | producer: claims/s |
| -------------- | ----: | --------: | ------------------: | --: | -----------------: |
| `display`      | 120.0 |    4.84ms |                 58% | 72% |                244 |
| `adaptive`     |  36.1 |    5.79ms |                 21% | 27% |                529 |
| `30`           |  29.7 |    6.47ms |                 19% | 24% |                539 |
| `throughput`   |   8.8 |   10.26ms |                  9% | 13% |                592 |

Read across a row. At the default the window paints every refresh and the
thread spends 58% of its time doing it; the producer, a 2ms timer that
would fire 500 times a second on an idle thread, fires 244 — the flood is
starving the thing that feeds it, which is the whole finding. Under
`'adaptive'` the pacer holds 330 of 341 claims (the first eleven are the
burst), paints 36 times a second, keeps paint at the budget — 21% where
the rule says 25%, the difference being the clock rounding each wait up to
the next tick — and the producer gets 529 of its 500-per-second, which is
to say all of it. The cap at 30 lands where it says. `'throughput'` is the
other end: 9% of the thread, one frame every 100ms. The per-frame cost
rises as frames get rarer (a cold cache, a core the OS clocks down between
frames), which is why the row is priced in share and not in milliseconds.

What the table does not show is as important: a scroll under `'adaptive'`
paints at 120Hz like the default, because its frames cost a fraction of a
millisecond (`test/frame-pacing.test.js`, "cheap frames never wait"), and
a click during the flood is answered on the click.
