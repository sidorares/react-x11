# Desktop integration

What an app has to tell the desktop about itself, beyond drawing. Today that
is startup notification, which is on by default and has nothing to call, and
what a password field has to do to be reachable by the desktop's password
managers.

The menu bar is the other half of this and has a page of its own —
[globalmenu.md](globalmenu.md) — because on a desktop that shows application
menus in its panel, `MenuBar` hands the menu over and stops drawing. Same
default shape as startup notification: on with no configuration, and one
switch to turn it off.

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

## Password fields and password managers

There is **no password-field protocol on the Linux desktop.** No toolkit
publishes "this is a password field, fill it", and no manager asks. What
exists instead are four seams, none of which a widget can opt into by
declaring itself — they are things an application either supports or does
not. `PasswordInput` supports the two that reach a field, and this is what
they turn out to be.

### 1. Typing — XTEST auto-type, and the keymap race

The mechanism nearly every desktop manager uses is **auto-type**: KeePassXC
matches the focused window's **title** against its entries, then synthesises
the keystrokes. Its X11 backend is the whole of the story — `SendKeyEvent()`
sends `XTestFakeKeyEvent()`, and for a character the current layout cannot
type, `RemapKeycode()` writes the keysym into a spare keycode with
`XkbSetMap()` first, `XSync`ing before it types.

For us that is good news and one hazard:

- **A faked key is an ordinary key.** XTEST events are delivered by the
  server through the normal event path, so `PasswordInput` — and every other
  focusable node — cannot tell auto-type from a person, and nothing has to be
  done to support it. An auto-type sequence of `{USERNAME}{TAB}{PASSWORD}
{ENTER}` walks a react-x11 form because Tab moves focus and Enter reaches
  `onSubmit`.
- **The window needs a title worth matching.** Auto-type's default matching is
  on the window title, so `<window title="…">` is the integration surface.
  A window titled after the document with nothing identifying the app is one
  a user cannot write an auto-type rule for; `wmClass` is worth setting too,
  since a manager that grew a smarter matcher would read that.
- **The keymap race is real.** ntk refetches the mapping when the server sends
  `MappingNotify`, which is what makes a remapped keycode decode correctly —
  but the refetch is a round trip, and a manager that remaps, syncs and types
  immediately can land its key before the reply does. The window is small and
  only affects characters outside the user's layout, but a password of ASCII
  is not the case that fails. Nothing here can close it; the fix belongs where
  the map lives.

### 2. Pasting — the clipboard, and the hint that keeps it out of history

The other path every manager offers is copy-to-clipboard, usually with a
countdown before it clears. That is ordinary `CLIPBOARD` interop
([clipboard.md](clipboard.md)); `PasswordInput` takes Ctrl+V and
Shift+Insert, and strips control characters so a manager's trailing newline
does not end up inside the secret.

If your app ever puts a secret **on** the clipboard — this widget never does
— offer `x-kde-passwordManagerHint` with the value `secret` beside the text.
Klipper drops such an offer from its history, KDE Connect refuses to forward
it, and `wl-clipboard` marks the state sensitive. It is a convention rather
than a specification, and it is the only thing standing between a copied
password and a clipboard manager's on-disk history:

```js
clipboard.write({ UTF8_STRING: secret, 'x-kde-passwordManagerHint': 'secret' });
```

`PasswordInput` also never takes the **PRIMARY** selection, which a
`<textinput>` does on every selection: PRIMARY is pasted by a middle click in
any window on the display, and a secret does not belong in a selection that
can be spent by accident.

### 3. Fetching it yourself — the Secret Service

When the app has an account of its own to unlock, the seam is not a field at
all: the **Secret Service** D-Bus API, `org.freedesktop.secrets`, which
gnome-keyring, KWallet and KeePassXC all implement, and which `libsecret`
speaks for C applications. react-x11 has no wrapper for it and does not need
one — `useSessionBus()` reaches it directly ([dbus.md](dbus.md)) — and the
shape is: search by attributes, unlock the collection if it is locked, read
the secret back. An app that does this shows no password field on most
launches, which is a better outcome than any field can offer.

Inside a sandbox that name is not there. Flatpak's answer is
`org.freedesktop.portal.Secret`, whose `RetrieveSecret` hands the app a
per-application master secret down a pipe; libsecret switches to it
automatically and encrypts a local store with it.

### 4. Reading the field — AT-SPI, which we do not implement

The accessibility bus is the only channel through which an outside program
can see a field's _contents and role_ rather than guess at a window title:
AT-SPI2 gives a password entry the role `password text`, which is how a
screen reader knows to announce "bullet" instead of the character. Some
automation leans on the same tree. react-x11 has no accessibility tree yet
(NEXT_STEPS §11.3) — `role` is a prop the testing queries read and nothing
else — so this seam is closed here for now, and worth reopening as one piece
with the rest of AT-SPI rather than as a password-shaped hole in it.

### What a field can still do wrong

None of the above stops the field itself from leaking. What `PasswordInput`
does about that, and what it cannot:

- the masked value is **never laid out or drawn** — no glyphs of the secret
  reach ntk's shaping cache or the X server, and the mask's width is measured
  from one reference character;
- there is **no copy, no selection, no undo history**;
- the value is still a JavaScript string, and strings are immutable. It
  cannot be zeroed, it lives until the garbage collector takes it, and every
  intermediate value typed on the way lives alongside it. A design that needs
  more than that needs the secret to never enter this process.
