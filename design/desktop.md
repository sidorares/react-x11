# Desktop integration: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/desktop.md](../docs/desktop.md), the reference, and keep
their original headings so code comments that cite them still resolve.

Where a section's heading is still in the reference, what is here is the
original text of the paragraphs the reference tightened: the mechanism,
history and rationale behind the behaviour it describes.

## Startup notification

When a launcher spawns an app it opens a **startup sequence** — that is what
the busy cursor is — and closes it when the app says it is up. An app that
never says so leaves the sequence running until the desktop gives up on it:
mutter's `STARTUP_TIMEOUT_MS` is 15 seconds, long after the window is on
screen and being clicked. The mutter source is blunt about what that looks
like, in a comment on the constant itself: people assume the launch failed
and start it again.

`DESKTOP_STARTUP_ID` is read from the environment and **removed from it**.
That is deliberate and it matters: the variable names one launch, so a child
process that inherits it would claim a sequence that is not its own and end
it early — the parent's cursor stops when the child starts. Every toolkit
that gets this wrong produces that same bug.

### When is an app "started"?

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

**A backstop ends the sequence regardless**, ten seconds after the window
maps, whichever mode is in force. An app that never paints, or that forgets
to call, cannot leave the cursor spinning — which would be this feature
reproducing the bug it exists to fix. Ten is chosen to beat mutter's fifteen
by a margin while being far longer than any honest first frame.

### What is deliberately not here

- **The launcher half.** An app that spawns _another_ app should generate an
  id, send `new:`, put `DESKTOP_STARTUP_ID` in the child's environment and
  close the sequence itself. Same encoder, different persona.
- **Ongoing `_NET_WM_USER_TIME` maintenance.** Setting it once at launch is
  this. Keeping it current on every keypress is a separate design with a
  real cost — EWMH is explicit that storing a frequently-changing property
  on the toplevel wakes every client watching that window, which is what
  `_NET_WM_USER_TIME_WINDOW` exists to avoid.

## The launcher: a badge, attention, and the Dock menu

### The badge

On Linux the count travels as one D-Bus signal, `LauncherEntry.Update`,
attributed to the app by `application://<appId>.desktop` — so it needs the
identity [`registerApplication({ appId })`](../docs/uri-schemes.md) establishes and
a `.desktop` file of that name, or the launcher has nothing to pin the
count to and `setBadge` resolves `false`. The entry stays on the bus while
a badge is shown and is released when it is cleared. A launcher that starts
after the badge was set will not see it until the next `setBadge`; the
protocol has no query.

### Attention

Nothing new to call: `<window states={['demands_attention']}>` is the
existing request, and on the cocoa backend it is
`NSApp.requestUserAttention` — the Dock icon bounces until the user
activates the app, and stops when the prop drops the state or the window
goes away. AppKit ignores the request while the app is already active, which
is the same outcome a window manager gives a focused window's urgency hint.
`fullscreen`, `maximized` and `hidden` are AppKit's full-screen Space, zoom
and miniaturize there (@windowkit/appkit 0.30.0), and the other `states`
names are inert on that backend.

### The Dock menu

`NSDockTile`'s menu on the cocoa backend; on Linux it is the launcher
protocol's **quicklist** — an object path to a `com.canonical.dbusmenu` tree,
which is the same menu protocol the tray and the global menu already speak.
ubuntu-dock/Dash-to-Dock, Plank and the Unity-heritage launchers render it.

> An earlier version of this page said the freedesktop counterpart was
> `Actions=` in the `.desktop` file, an install step rather than runtime code.
> That is a different feature wearing a similar hat: desktop actions are the
> right place for entries that must work **while the app is not running**, and
> the quicklist is the right place for a menu that follows the app's state.

## The tray

**A click's position on Linux** is a point whose unit the protocol never
names, and hosts differ. Plasma sends device pixels, and so does GNOME in its
physical layout, the default up to GNOME 49. GNOME's logical layout — the
default from 50, and on Fedora and Debian 13 before it — sends logical
pixels, as xfce4-panel, LXQt and Cinnamon do. So the point is read both
ways: a reading that lands on no monitor is dropped, then the one the pointer
is on is kept, and otherwise the numbers are taken as sent. What that cannot
tell apart is a device-pixel host under XWayland whose tray, read as logical
pixels, still lands on a monitor — in the top-left quarter of the screen, or
with another monitor beyond it — and there the point is `scale` times as far
from the screen's origin as the click was.

## Feature discovery

A backend **declares** its mechanism rather than having one inferred from it,
because backends install the same method names for the same rung on purpose —
that sharing is what makes `useTray` one hook — so there is nothing in the
methods to tell two of them apart. Branch on `features`; `backend` is for logs
and bug reports.

### Degrading well

2. **Never disable a feature permanently on a `false`.** A panel restarts, an
   extension is enabled, a daemon is installed. The hooks re-probe on
   `NameOwnerChanged` and nothing is cached — an app that latched the first
   answer would outlive every one of those fixes.

## Turning the desktop off

Each is the right default: an app that follows the desktop looks like it
belongs there, one a screen reader can read is one more person can use, and a
menu in the panel is what the panel is for. But sooner or later an embedder
owns the thing we assumed was ours, and until
[#417](https://github.com/sidorares/react-x11/issues/417) the only way out was
an **environment variable** — `NO_AT_BRIDGE=1`,
`REACT_X11_NO_GLOBAL_MENU=1`, or unsetting `DBUS_SESSION_BUS_ADDRESS`. That is
a seam an app cannot reach for itself: the environment is inherited, so
setting one before `createRoot()` sets it for every child process too, and the
D-Bus one takes the portals and the app's own exported services down with the
follower.

With all three off, **nothing dials the session bus at startup** — no
connection, no subprocess, no portal probe. That is the shape an embedder
wants, and a kiosk, and a test that needs the same answer on every machine.

Turning `appearance` off means the app draws in its own palette rather than
the desktop's: `useSystemAppearance()` reports `'no-preference'` with
`source: null`, and the remembered answer on disk is not read either — an
opted-out app that started in whatever colours the machine was in last time
would be the opposite of what the switch is for.

**Off is process-wide, and it latches.** There is one desktop, one D-Bus
identity and one AT-SPI bridge per process, so the policy cannot honestly be
per-root: a second root turning back on what the first turned off would be a
bug rather than a feature. Nothing turns an integration back on, and a
feature already started stays started — pass this on the first root.

## Not blocking the first frame on the bus

Worth knowing because it is invisible when it works, and was worth ~150 ms
when it did not.

On macOS the session bus address is not in the environment; D-Bus advertises
it through **launchd**, and finding it means running `launchctl getenv`.
`dbus-native`'s entry point is synchronous, so it has to do that with
`spawnSync` — 120–150 ms of _blocked event loop_ on a cold page cache, landing
in front of the X handshake, the layout engine's WebAssembly and the first
paint, all so the accessibility bridge could find out there was nothing to
connect to.

Every dial now goes through one asynchronous, once-per-process lookup instead,
and hands `dbus-native` a resolved `unix:path=…`. The same wall clock is
spent, none of it on the loop: the handshake and the layout engine run
straight through it. There is nothing to configure — it is the same address,
found the same way, off the critical path.

Linux is unaffected: `$DBUS_SESSION_BUS_ADDRESS` or `$XDG_RUNTIME_DIR/bus`
answers without a subprocess, and always did.

## Password fields and password managers

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
  a user cannot write an auto-type rule for; `appId` is worth setting too,
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
([clipboard.md](../docs/clipboard.md)); `PasswordInput` takes Ctrl+V and
Shift+Insert, and strips control characters so a manager's trailing newline
does not end up inside the secret.

`PasswordInput` also never takes the **PRIMARY** selection, which a
`<textinput>` does on every selection: PRIMARY is pasted by a middle click in
any window on the display, and a secret does not belong in a selection that
can be spent by accident.

### 3. Fetching it yourself — the Secret Service

When the app has an account of its own to unlock, the seam is not a field at
all: the **Secret Service** D-Bus API, `org.freedesktop.secrets`, which
gnome-keyring, KWallet and KeePassXC all implement, and which `libsecret`
speaks for C applications. react-x11 has no wrapper for it and does not need
one — `useSessionBus()` reaches it directly ([dbus.md](../docs/dbus.md)) — and the
shape is: search by attributes, unlock the collection if it is locked, read
the secret back. An app that does this shows no password field on most
launches, which is a better outcome than any field can offer.

### 4. Reading the field — AT-SPI, which does not mark it yet

The accessibility bus is the only channel through which an outside program
can see a field's _contents and role_ rather than guess at a window title:
AT-SPI2 gives a password entry the role `password text`, which is how a
screen reader knows to announce "bullet" instead of the character. Some
automation leans on the same tree. react-x11 does publish one
([accessibility.md](../docs/accessibility.md)), but `PasswordInput` is a plain
`role="textbox"` in it and nothing maps a node to `password text`
(`src/a11y.js` declares the role and no node takes it), so this seam is still
closed — worth opening as a role in the shared model rather than as a
password-shaped hole beside it.
