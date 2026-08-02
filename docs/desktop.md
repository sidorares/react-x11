# Desktop integration

What an app has to tell the desktop about itself, beyond drawing. Today that
is startup notification; it is on by default and there is nothing to call.

## Startup notification

When a launcher spawns an app it opens a **startup sequence** — that is what
the busy cursor is — and closes it when the app says it is up. An app that
never says so leaves the sequence running until the desktop gives up on it:
mutter's `STARTUP_TIMEOUT_MS` is 15 seconds, long after the window is on
screen and being clicked. The mutter source is blunt about what that looks
like, in a comment on the constant itself: people assume the launch failed
and start it again.

Two other things ride on the same handshake:

- **Focus.** `_NET_WM_USER_TIME` is the evidence focus-stealing prevention
  weighs when deciding whether a new window may come to the front. With
  none, a strict desktop opens the window behind whatever the user was
  doing — correctly, from its point of view, since nothing said a user asked
  for this.
- **Placement.** The sequence records which workspace the launch happened
  on. Without one the window goes wherever new windows go.

react-x11 does all of it with no configuration:

```jsx
const root = await createRoot(); // that is the whole of it
```

`DESKTOP_STARTUP_ID` is read from the environment and **removed from it**.
That is deliberate and it matters: the variable names one launch, so a child
process that inherits it would claim a sequence that is not its own and end
it early — the parent's cursor stops when the child starts. Every toolkit
that gets this wrong produces that same bug.

With no id in the environment — a terminal, CI, XQuartz — nothing is set and
nothing is sent.

### When is an app "started"?

The default is **the first frame that actually painted**.

GTK ends the sequence when the toplevel maps, and copying that here would be
subtly wrong. This renderer does not paint on map: `invalidate()` schedules
through the frame clock and the drawing lands in `flush()` a frame later. So
a mapped window is an empty rectangle, and stopping the busy cursor there is
compliant and dishonest — it says "ready" over a blank window.

A suspense fallback counts as painted, and should. If the first frame is a
spinner because the tree is waiting on data, that is exactly the right
moment to stop the _system's_ spinner: the app is up and is telling the user
what it is doing. There is no signal for "finished loading", and guessing at
one is how this ends back at fifteen seconds.

`completeOn` is there for apps the default does not suit:

```jsx
await createRoot({ startupNotification: { completeOn: 'map' } });
```

| `completeOn` |                                                         |
| ------------ | ------------------------------------------------------- |
| `'paint'`    | the first frame that drew (default)                     |
| `'map'`      | the first toplevel mapping — earlier, and what GTK does |
| `'manual'`   | nothing automatic; call `notifyStartupComplete()`       |

`'map'` suits an app whose first frame is expensive enough that it would
rather the cursor stopped before it. `'manual'` suits one that is not up
until it says so — restoring a session behind a splash, say:

```jsx
import { notifyStartupComplete } from 'react-x11';

await createRoot({ startupNotification: { completeOn: 'manual' } });
await restoreSession();
notifyStartupComplete(); // idempotent, and a no-op if there is no sequence
```

**A backstop ends the sequence regardless**, ten seconds after the window
maps, whichever mode is in force. An app that never paints, or that forgets
to call, cannot leave the cursor spinning — which would be this feature
reproducing the bug it exists to fix. Ten is chosen to beat mutter's fifteen
by a margin while being far longer than any honest first frame.

### Turning it off, and supplying an id

```jsx
await createRoot({ startupNotification: false });
await createRoot({ startupNotification: 'launcher/app/1-0_TIME9876' });
```

`false` is for an app that runs its own sequence, or an embedder that owns
the toplevel. Note that opting out leaves `DESKTOP_STARTUP_ID` in the
environment — if you are managing the sequence yourself, the id is yours to
read and yours to clear.

A string supplies the id for a launch where it did not arrive in the
environment. A D-Bus-activated app gets it in `platform_data` instead.

### `launchTimestamp()`

```jsx
import { launchTimestamp } from 'react-x11';

const when = launchTimestamp(); // number | null
```

The X server timestamp of the user action that launched the app, parsed from
the id's `_TIME` suffix. **`null` is a real answer**, not a failure: an app
started from a shell has no launch timestamp and never will.

It is the "when" that any later request to come forward is weighed against.
Do not substitute `0` for a missing one — EWMH gives zero its own meaning,
"do not focus this window when it maps".

### On macOS

quartz-wm implements none of this, so on XQuartz the messages go to a root
window nobody is listening at and `_NET_WM_USER_TIME` is ignored. Harmless,
and worth knowing before concluding from a Mac that the feature is broken.

### What is deliberately not here

- **The launcher half.** An app that spawns _another_ app should generate an
  id, send `new:`, put `DESKTOP_STARTUP_ID` in the child's environment and
  close the sequence itself. Same encoder, different persona.
- **Ongoing `_NET_WM_USER_TIME` maintenance.** Setting it once at launch is
  this. Keeping it current on every keypress is a separate design with a
  real cost — EWMH is explicit that storing a frequently-changing property
  on the toplevel wakes every client watching that window, which is what
  `_NET_WM_USER_TIME_WINDOW` exists to avoid.

### Security

The id is broadcast to the root window, so every client on the display sees
it. On X11 that is the pre-existing no-isolation story rather than a new
exposure — see [security.md](security.md) — but it is the reason the
messages carry the id the launcher gave us and nothing invented, and the
reason the variable's value is never logged.
