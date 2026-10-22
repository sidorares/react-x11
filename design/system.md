# The machine around the app: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/system.md](../docs/system.md), the reference, and keep
their original headings so code comments that cite them still resolve.

Where a heading is also in the reference, what is here is the original text
of the paragraphs the reference tightened: the mechanism, history and
rationale behind the behaviour it describes.

## `useScreens()` — the monitors

### The names arrive after the geometry

`source` says which tier answered. The geometry resolves during `createRoot()`
from **Xinerama**, which is one round trip; the names, the primary flag and the
physical sizes take a **RandR** walk — `GetScreenResourcesCurrent`, then a
`GetOutputInfo` and a `GetCrtcInfo` per output, ten or more round trips on an
ordinary two-head desktop — and that deliberately does not hold startup up.

So a component can render once with `source: 'xinerama'` and null names, and
again a moment later with `source: 'randr'` and real ones. The rects do not
move between the two: Xinerama on any modern server _is_ RandR's emulation of
it, so what arrives late is added rather than corrected. Where a name is what
gets persisted — "reopen on the monitor I was on" — treat null as _not known
yet_ and keep the last one rather than writing it.

### `available` is an approximation on X11, and the only one here

`_NET_WORKAREA` — the desktop minus the docks and panels that reserved space —
is published **for the whole virtual desktop**, not per monitor. That is an
EWMH weakness rather than a choice made here. So it is applied as a _per-axis_
bound on top of the monitor rect: exact on one head, and on several it still
takes a top or bottom panel off the height without pretending to know which
head the panel is on.

A true per-monitor work area means reading `_NET_WM_STRUT_PARTIAL` off every
window on the screen and intersecting the reservations that land on each head
— a full window-tree walk, redone whenever any panel changes. If you need
that, `useApp().X` is the escape hatch.

### On Wayland

The same shape, from `wl_output` ([wayland-backend.md](../docs/wayland-backend.md)):
`name` is the compositor's connector name (`DP-1`, `eDP-1`) and arrives with
the geometry rather than after it; the rects are xdg_output's logical ones.
The protocol has no primary — the entry at the origin is flagged — and no
work area: `available` is each monitor's own rect, less what the compositor
told a window on it to fit in (`xdg_toplevel.configure_bounds`, the monitor
minus its panels), so it is exact per monitor, as on macOS, once a window has
appeared there. `scale` is the monitor's own, the fraction under fractional
scaling. `source` reads `'test'` on both native backends — the stamp of the
seam they publish through.

**On macOS it is exact.** `NSScreen.visibleFrame` is per screen already — that
display's own menu bar and Dock taken off — so each monitor carries its real
usable rect and no approximation runs. `workArea` there is still one rect,
because the field is one rect by definition; it is the primary screen's, and
on a multi-display Mac `screens[n].available` is the answer to prefer.
`primary` is the screen with the menu bar, `refreshRate` the panel's own rate,
and `name` is null — the bridge does not report one.

### On macOS the layout is asked for, not announced

Every other backend is told: RandR sends an event, a `wl_output` announces
itself. macOS has no such event for a client — the bridge keeps its
`NSScreen` copy current on the system's own notification and says nothing —
so react-x11 re-reads the layout instead, at the moments it matters:

- **before a placement**, which is where a stale rect would be visible — a
  popup flipped and clamped into a monitor that has moved, an auto-sized
  window capped by one that is gone;
- **when a window reports that it moved**, at most once a second, because a
  display arriving or leaving moves the windows that were on it;
- **on a clock while a `useScreens()` subscriber is mounted**, every
  `createRoot({ cocoa: { screenPoll } })` ms — 500 by default, `0` for
  never. An app that never calls `useScreens()` never polls.

So a component watching the layout sees a monitor plugged in about half a
second later than an X11 one does, and everything else sees it at the moment
it asks. `useApp().refreshScreens()` publishes the layout right now for an
app that knows before any of those.

### Mirroring

Two outputs showing the same pixels share one CRTC and are reported as **one**
monitor, with both names in `outputs`. A laptop mirroring to a projector is one
screen to put a window on, and `screens.length === 2` there would be a wrong
answer an app would act on.

## `useWindowState()` — what the window manager did

On the **Cocoa** backend the same rows come from AppKit, in the same
`_NET_WM_STATE` names (@windowkit/appkit 0.30.0): `fullscreen` is the title
bar's green button, or `<window fullscreen>`, `maximized` the zoom
(`maximized_vert` and `maximized_horz` together), `minimized` the Dock
(`hidden`), and `states` lists `focused` for the key window. `fullscreen`
turns as AppKit's transition **begins**, before the animation, so a toolbar an
app hides in full screen goes while the window grows rather than after it:

```jsx
const { fullscreen } = useWindowState();
return fullscreen ? <Page /> : [<Toolbar />, <Page />];
```

`obscured` and `desktop` keep their initial values there — a Space is not a
numbered workspace — and on a bridge older than 0.30.0 only `focused` moves.

The first render answers `focused: true, visible: true` rather than waiting for
a round trip. A window opens focused and on screen far more often than not, and
a title bar that renders dimmed on frame one and un-dims on frame two is a
flash on every launch.

### `obscured` and the compositor

**A composited window is never obscured.** The compositor redirects it to an
offscreen pixmap, so the server considers it entirely visible whatever is
stacked on top, and `VisibilityNotify` says so. One is running on every stock
GNOME and KDE session. That is X working as designed and there is no protocol
answer to it.

### `presenting`, and the Wayland frame clock

A Wayland compositor will not tell you a surface is covered either — but it
stops sending it **frame callbacks**, and on that backend a frame callback is
the only thing that paces the frame loop. So a window nobody is showing draws
once and then stops, while React above it goes on re-rendering into a tree
that reaches no screen. That is the compositor being right (painting into a
surface nobody sees is work for nothing) and it used to be invisible: no
error, no warning, and nothing an app could ask.

It is a signal to **stop work** on, not a frame-accurate one: two seconds of
silence is what makes it certain, so nothing that has to be exact should read
it. On X11, macOS and the headless mock it is `true` and stays there — their
frame clocks do not depend on a compositor's goodwill, and `obscured` is the
question to ask there instead. The backend also says it once on stderr in
development, because "the app is alive and has drawn once" is otherwise an
unguessable state; see
[wayland-backend.md](../docs/wayland-backend.md#a-surface-the-compositor-stops-showing-stops-drawing).

## `useIdle()` and `useKeepAwake()` — is anyone there

Where the X server carries an `IDLETIME` counter — Xorg does — this costs **no
timer at all**: a SYNC alarm fires when the counter crosses `timeout` and
another when input pulls it back down, which is what every idle daemon on the
desktop is built on. On a server without one (XQuartz) it falls back to polling
MIT-SCREEN-SAVER, scheduled against the remaining time rather than on a tick —
and on win32, `GetLastInputInfo` on the same schedule, which answers for the
whole session the way the X counter does. On macOS it is the same schedule
over the session's idle time: the `@windowkit/appkit` bridge's `lastInputMs()`
(CoreGraphics' count, a call) where it has one, and otherwise `ioreg`'s
`HIDIdleTime` — a short-lived child process per check, which is one per
`timeout` while the user is there and one every quarter of it, at most every
half minute, while they are away.
On an X display with neither extension it stays `false`.

### Keeping the screen on

Four rungs. On [win32](../docs/windows-integrations.md), `SetThreadExecutionState`
with `ES_CONTINUOUS`, which is what makes it a state rather than a one-shot
nudge, and which is counted here so that one caller finishing does not speak
for another. Elsewhere: the settings portal's `Inhibit`, the older
`org.freedesktop.ScreenSaver` service, and `ScreenSaverSuspend`, which is a
plain X request and needs no session bus at all. **The three freedesktop
rungs inhibit screen blanking only.** Nothing there stops a suspend — only
the portal rung could, and a seam that works on one desktop in three is worse
than not offering it. The Windows rung asks for both the display and the
system, which is the same call either way.

`reason` is shown by desktops that list what is holding the screen on, so it
reads best as a sentence about the app's state rather than the app's name,
which they already show. Windows takes no string with the call —
`powercfg /requests` names the process — so there it is dropped rather than
put somewhere the system will not show it.

## `useKeyboardState()` — the locks and the layout

Everything here needs **XKB**, which Xorg and XQuartz both have. Where it is
missing the locks read false and `layouts` is empty — so `layouts` is the field
to check when the difference between "off" and "not known" matters. Changes
arrive as `XkbStateNotify`, with no polling, even while another application has
the keyboard.

The [native Wayland backend](../docs/wayland-backend.md) answers the same fields from
its seat: the locks and the group from `wl_keyboard.modifiers`, the layout
codes from the keymap the compositor sent. One difference is the protocol's
rather than this library's — a compositor tells only the focused client, so a
lock toggled while another app has the keyboard is seen when focus returns.
For a password field, the case this hook exists for, the window is focused
already.

Which bit is which lock is worth writing down: Caps Lock is `LockMask`, fixed
by the core protocol, and **Num Lock is not fixed by anything** — it is wherever
the modifier map puts it, which is `Mod2` on every Linux and BSD desktop, on
XQuartz, and in every toolkit that hardcodes it. This takes the convention.

## `useDesktopSettings()` — how the desktop wants an app to feel

[XSETTINGS](../docs/appearance.md#what-each-rung-can-actually-answer) is the only source on X11; there is no
standard portal interface for any of this. On the
[native Wayland backend](../docs/wayland-backend.md), which has no XSETTINGS to read,
they come off the settings portal's GNOME namespaces instead —
`org.gnome.desktop.interface` (`cursor-blink`, `cursor-blink-time`,
`enable-animations`) and `org.gnome.desktop.peripherals.mouse`
(`double-click`, `drag-threshold`), the same GSettings keys gsd-xsettings
translates for X11 — with `source: 'portal'`, live, and only while
`createRoot({ desktop })` leaves `appearance` on. A portal that does not pass
those through (KDE's, a bare compositor's) leaves the defaults. On the macOS backend the one of these the
system publishes is read from it: **Reduce motion** (System Settings ›
Accessibility › Display) arrives as `animations: false` with
`source: 'macos'`, live — flipping the switch stops a spinner that is already
going round — and the other fields keep the defaults there, since macOS has
no equivalent to hand over. On a desktop with no settings daemon — a bare
`startx`, most window managers, XQuartz — `source` is null and the numbers above
are this renderer's own defaults. They are deliberately not GTK's, which blinks
on a 1200ms cycle and drags at 8px: the point is to follow a desktop that
expressed a preference, not to change what happens on one that did not.

One seam worth knowing about. `createRoot()` starts XSETTINGS but does not
**await** it — five round trips on every app's startup path, to answer a
question that is not asked until the first interaction, is a bad trade. A field
focused on the very first frame therefore gets the built-in default and the
desktop's cadence from its next focus onward.

## `useLocale()` — the language and its conventions

**`LC_ALL` / `LC_MESSAGES` / `LANG` win over `Intl`'s own answer.** node resolves
`Intl.DateTimeFormat().resolvedOptions().locale` through ICU, and ICU answers
what it has compiled in — a small-ICU build reports `en-US` for every
environment there is. The POSIX variables are what the person who launched the
app actually said. `C` and `POSIX` are not locales but the _absence_ of one, so
they fall through to ICU rather than becoming a tag.

**This does not change while the app runs**, and there is deliberately no
subscription behind it: a process's environment is fixed at exec and ICU's
resolution with it, so a desktop that switches language announces it for the
_next_ login and nothing this process can observe has moved.

## What is not here

**Network status.** There is no X-level answer, so it is necessarily D-Bus or
netlink, and the honest version of the API would be a hint rather than a fact —
a failed request is always the better truth than a flag that says the link is
up. Not ruled out; not built.

**Battery, brightness, volume, media keys.** These are D-Bus services a third
party can wrap without anything from here. Two things once on this list — the
two desktop standards with a claim on core — are now built: **notifications**
([notifications.md](../docs/notifications.md)), and the **tray**, whose menu is
[dbusmenu](../docs/globalmenu.md) this renderer already speaks — on the cocoa backend
[`useTray()`](../docs/desktop.md) over `NSStatusItem`
([#463](https://github.com/sidorares/react-x11/issues/463)), and on a
freedesktop session over `org.kde.StatusNotifierItem`
([#353](https://github.com/sidorares/react-x11/issues/353)) — D-Bus only, so
the same rung serves X11, XWayland and Wayland — and on win32 over
`Shell_NotifyIcon`.

**The user's calendar.** Their real events, from the accounts the desktop
already holds — EventKit on macOS, Evolution Data Server on a freedesktop
session — are [desktop-calendar.md](../docs/desktop-calendar.md):
`useDesktopCalendarEvents()`, keyed the way a calendar grid asks. It is not a
system _setting_, which is why it is its own page rather than a hook here,
but it is the same kind of thing as the rest of this one: something the
desktop knows that an app would otherwise ask the user to type in again.

**A launcher badge, and permission prompts.** Both are built, and neither is
a system hook: an unread count on the icon (freedesktop
`com.canonical.Unity.LauncherEntry`, one D-Bus signal; macOS
`dockTile.badgeLabel`; a taskbar overlay icon on Windows) is `useBadge()` in
[desktop.md](../docs/desktop.md#the-badge), and camera/mic/location authorization is
`usePermission()` in [permissions.md](../docs/permissions.md) — macOS TCC today, with
the freedesktop device portals still
[#466](https://github.com/sidorares/react-x11/issues/466)'s remaining half. Attention (the taskbar urgency / Dock
bounce) is `states: ['demands_attention']`
([desktop.md](../docs/desktop.md#attention)).

**Session lifecycle** — "we are suspending, save now", and "I have unsaved work,
do not log out yet". The X-native answer (XSMP) is effectively dead and the live
one is logind. The shape worth having is probably not a system hook but a
`useBeforeQuit()` that unifies it with `<window onCloseRequest>`. On the cocoa
backend the second half already lands there: a quit request from the Dock,
⌘Q or a logout is routed to the primary window's `onCloseRequest`
([uri-schemes.md](../docs/uri-schemes.md), "On macOS").
