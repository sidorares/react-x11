# The machine around the app

Hooks for what an application reads off the system rather than working out
itself: the monitors, what the window manager did with the window, whether
anyone is at the desk, the state of the keyboard, how the desktop wants an app
to feel, and the language it was launched in — and a store for what the app
remembers itself, between launches.

```jsx
import {
  useScreens,
  useWindowState,
  useIdle,
  useKeepAwake,
  useKeyboardState,
  useDesktopSettings,
  createSettings,
  useLocale,
} from 'react-x11';
```

They share a shape:

- **Nothing is asked of the server until a component asks.** An app that
  never calls them pays for none of it.
- **Every one has an answer with no extension present.** "This display cannot
  say" is a real state rather than an error. Each hook below names what it
  reports then, and which field tells that apart from a genuine "no".
- **The colours are somewhere else.** Light or dark, the accent and reduced
  motion are [system appearance](appearance.md).

---

## `useScreens()` — the monitors

```jsx
const { screens, primary, workArea, virtual, source } = useScreens();

<Select
  value={monitor}
  onChange={setMonitor}
  options={screens.map((s) => ({
    value: s.name,
    label: `${s.name} — ${s.width}×${s.height}`,
  }))}
/>;
```

Each entry in `screens`:

|                          |                                                                |
| ------------------------ | -------------------------------------------------------------- |
| `name`                   | `'HDMI-1'`, `'eDP-1'` — **null** where the server has no RandR |
| `x` `y` `width` `height` | the rect in virtual-screen coordinates                         |
| `available`              | that rect minus the panels                                     |
| `primary`                | the desktop's main monitor                                     |
| `widthMM` `heightMM`     | physical size, or null                                         |
| `refreshRate`            | Hz to two decimals (`59.99`), or null                          |
| `rotation`               | `0`, `90`, `180` or `270`                                      |
| `outputs`                | every output on this monitor — two names means it is mirrored  |
| `scale`                  | this monitor's device pixels per logical pixel                 |

Re-renders when a monitor is plugged in or unplugged, when the arrangement
changes, and when a panel appears, moves or auto-hides.

The rects are in **logical pixels**, like every other length an app touches,
and `scale` is the per-monitor answer the display-scale ladder arrived at — a
retina lid and an office monitor genuinely differ. The root's own scale is the
primary monitor's; see [scale.md](scale.md).

### The names arrive after the geometry

`source` says which tier answered. The geometry resolves during `createRoot()`
from **Xinerama**; the names, the primary flag and the physical sizes come
from **RandR** a moment later, without holding startup up. So a component can
render once with `source: 'xinerama'` and null names, and again with
`source: 'randr'` and real ones. The rects do not move between the two: what
arrives late is added, not corrected. Where a name is persisted — "reopen on
the monitor I was on" — treat null as _not known yet_ and keep the last one
rather than writing it.

`'screen'` is the tier under both: one entry covering the whole display, for a
server with neither extension. `null` is a headless mock with no display at
all.

### `available` is an approximation on X11, and the only one here

`_NET_WORKAREA` — the desktop minus the panels that reserved space — is
published for the **whole virtual desktop**, not per monitor. So it is applied
as a per-axis bound on each monitor's rect: exact on one head; on several, a
top or bottom panel comes off the height without knowing which head it is on.
For a true per-monitor work area, read `_NET_WM_STRUT_PARTIAL` off every
window yourself through `useApp().X`.

### On Wayland

The same shape, from `wl_output` ([wayland-backend.md](wayland-backend.md)):
`name` is the compositor's connector name (`DP-1`, `eDP-1`) and arrives with
the geometry rather than after it; the rects are xdg_output's logical ones.
There is no primary — the entry at the origin is flagged — and no work area:
`available` is each monitor's own rect less the bounds the compositor gave a
window on it, so it is exact per monitor once a window has appeared there.
`scale` is the monitor's own, a fraction under fractional scaling. `source`
reads `'test'` on both native backends.

**On macOS it is exact.** Each monitor's `available` is its `visibleFrame` —
that display's own menu bar and Dock taken off. `workArea` is one rect by
definition, the primary screen's; on a multi-display Mac prefer
`screens[n].available`. `primary` is the screen with the menu bar,
`refreshRate` the panel's own rate, and `name` is null.

### On macOS the layout is asked for, not announced

macOS sends a client no event when the displays change, so react-x11 re-reads
the layout at the moments it matters:

- **before a placement** — a popup flipped and clamped into a monitor, an
  auto-sized window capped by one;
- **when a window reports that it moved**, at most once a second, because a
  display arriving or leaving moves the windows that were on it;
- **on a clock while a `useScreens()` subscriber is mounted**, every
  `createRoot({ cocoa: { screenPoll } })` ms — 500 by default, `0` for
  never. An app that never calls `useScreens()` never polls.

So a component watching the layout sees a monitor plugged in about half a
second later than an X11 one does, and everything else sees it at the moment
it asks. `useApp().refreshScreens()` publishes the layout right now.

### Mirroring

Two outputs showing the same pixels are reported as **one** monitor, with both
names in `outputs`. A laptop mirroring to a projector is one screen to put a
window on.

---

## `useWindowState()` — what the window manager did

```jsx
const { focused, visible, fullscreen } = useWindowState();

// a title bar that dims when the window is not the active one
<text style={{ color: focused ? theme.text : theme.textMuted }}>{title}</text>;

// and work that is pointless while nobody can see it
useEffect(() => {
  if (!visible) return;
  const id = setInterval(poll, 1000);
  return () => clearInterval(id);
}, [visible]);
```

|              |                                                                        |
| ------------ | ---------------------------------------------------------------------- |
| `focused`    | this window has the keyboard                                           |
| `visible`    | **the one to branch on** — not minimized, not covered, still drawing   |
| `minimized`  | `_NET_WM_STATE_HIDDEN`: iconified, or shaded away                      |
| `maximized`  | both axes; one axis alone shows up in `states`                         |
| `fullscreen` | what the WM actually did, not what `<window fullscreen>` asked for     |
| `obscured`   | fully covered — **always false under a compositor**                    |
| `presenting` | the display is still scheduling frames — Wayland; true everywhere else |
| `states`     | the raw `_NET_WM_STATE` names                                          |
| `desktop`    | the workspace index, or null                                           |

`<window states>` is what a window **asks for**; this is what it **got**. They
part company routinely — a user hits a maximize hotkey, a tiling WM declines a
fullscreen request — and an app that mirrors the state in its own UI has
nowhere else to read it.

On the **Cocoa** backend the same rows come from AppKit, in the same
`_NET_WM_STATE` names: `fullscreen` is the title bar's green button or
`<window fullscreen>`, `maximized` the zoom (`maximized_vert` and
`maximized_horz` together), `minimized` the Dock (`hidden`), and `states`
lists `focused` for the key window. `fullscreen` turns as AppKit's transition
**begins**, so a toolbar an app hides in full screen goes while the window
grows rather than after it:

```jsx
const { fullscreen } = useWindowState();
return fullscreen ? <Page /> : [<Toolbar />, <Page />];
```

`obscured` and `desktop` keep their initial values there — a Space is not a
numbered workspace.

With no argument it reads the window the component is in, inferred the way
[`useTopLevelWindow()`](filedialog.md) infers it: exact for a one-window app,
and a documented guess for a tree with several. Pass a ref to be certain.

```jsx
const win = useRef(null);
const { fullscreen } = useWindowState(win);
return <window ref={win}>…</window>;
```

The first render answers `focused: true, visible: true` rather than waiting
for a round trip, so a title bar does not render dimmed on frame one and
un-dim on frame two.

### `obscured` and the compositor

**A composited window is never obscured.** The compositor redirects it to an
offscreen pixmap, so the server considers it entirely visible whatever is
stacked on top — and every stock GNOME and KDE session runs one. So `obscured`
is a bare-WM optimisation, and `visible`, which folds in `minimized` (that
_does_ survive compositing), is the field to branch on. An animation paused on
`visible` stops when the window is minimized everywhere, and additionally when
it is buried on a desktop with no compositor.

### `presenting`, and the Wayland frame clock

A Wayland compositor stops sending **frame callbacks** to a surface it is not
showing, and on that backend frame callbacks pace the frame loop. So a window
nobody is showing draws once and then stops, while React above it goes on
re-rendering into a tree that reaches no screen.

`presenting` is that state, published. It goes false after a couple of
seconds of silence with a repaint waiting, and true again on the very next
frame callback, which the compositor sends the moment the surface is shown
again. It folds into `visible`, so an animation already paused on `visible`
pauses here too:

```jsx
const { visible, presenting } = useWindowState();

// nothing this draws would reach the screen; stop simulating as well
useEffect(() => {
  if (!visible) return;
  const id = setInterval(step, 16);
  return () => clearInterval(id);
}, [visible]);

// and the reason, where a status line would rather say it than go blank
const status = presenting ? 'live' : 'paused — this window is not on screen';
```

It is a signal to **stop work** on, not a frame-accurate one: nothing that has
to be exact should read it. On X11, macOS and the headless mock it is `true`
and stays there; `obscured` is the question to ask there instead. The Wayland
backend also says it once on stderr in development; see
[wayland-backend.md](wayland-backend.md#a-surface-the-compositor-stops-showing-stops-drawing).

---

## `useIdle()` and `useKeepAwake()` — is anyone there

```jsx
const away = useIdle(5 * 60_000);
<Avatar status={away ? 'away' : 'online'} />;
```

Idleness is the **whole display's**, not this window's: it counts input on
every device, whichever application it went to. That is the right meaning for
a presence indicator, an auto-save, or a dashboard that stops refreshing when
the desk is empty — and the wrong one for "has the user ignored _my_ window",
which is `useWindowState().focused`.

- **Xorg**, with an `IDLETIME` counter: SYNC alarms fire when the counter
  crosses `timeout` and when input pulls it back — **no timer at all**.
- **XQuartz**, with none: MIT-SCREEN-SAVER, polled on a schedule against the
  remaining time rather than on a tick.
- **Windows**: `GetLastInputInfo`, the whole session's, on the same schedule.
- **macOS**: the session's idle time, on the same schedule — the bridge's
  `lastInputMs()`, or else `ioreg`'s `HIDIdleTime`, a child process per check
  (one per `timeout` while the user is there; one every quarter of it, at most
  every half minute, while away).
- **An X display with neither extension**: always `false`.

Nothing is armed until a component subscribes, and the alarm or the poll
stops when the last subscriber to that `timeout` unmounts. `timeout` is a
dependency, so hold it in a constant rather than building it inline from state
that moves.

### Keeping the screen on

```jsx
useKeepAwake(playing, 'Playing a video');
```

Held while the flag is true and the component is mounted, released on either —
including an unmount mid-playback, the case that leaves a desktop permanently
un-blanking when this is done by hand.

- **Windows**: `SetThreadExecutionState` with `ES_CONTINUOUS`
  ([windows-integrations.md](windows-integrations.md)) — the display **and**
  the system; counted, so one caller finishing does not release another's.
- **Elsewhere**: the first that answers of the desktop portal's `Inhibit`,
  `org.freedesktop.ScreenSaver`, and `ScreenSaverSuspend` (a plain X request,
  no session bus). These inhibit **screen blanking only** — nothing stops a
  suspend.

`reason` is shown by desktops that list what is holding the screen on, so
write it as a sentence about the app's state rather than the app's name, which
they already show. Windows takes no string — `powercfg /requests` names the
process — so there it is dropped.

Failure is silent by design: a machine with no portal, no screensaver service
and no MIT-SCREEN-SAVER cannot be asked. `keepAwake()` is the imperative twin,
and resolves to the release.

---

## `useKeyboardState()` — the locks and the layout

```jsx
const { capsLock, layout } = useKeyboardState();

<PasswordInput value={password} onChange={setPassword} />;
{
  capsLock && <text style={{ color: theme.warning }}>Caps Lock is on</text>;
}
```

|                      |                                            |
| -------------------- | ------------------------------------------ |
| `capsLock` `numLock` | on or off, **now**                         |
| `group`              | the active XKB group, `0`–`3`              |
| `layout`             | that group's layout code, `'ru'` — or null |
| `layouts`            | every configured layout, `['us', 'ru']`    |

The locks are true of the **keyboard**, not of an event: a key event carries
the modifier state at the moment it was pressed, which is no help to a
password field that wants to warn while merely focused, before anything has
been typed.

The layout is for a status-bar indicator, and for a password typed in the
wrong script, which looks identical to a wrong password. `layout` is a code
(`'ru'`, not `'Russian'`) because that is what an indicator shows; uppercase it
for display.

Everything here needs **XKB**, which Xorg and XQuartz both have. Where it is
missing the locks read false and `layouts` is empty — so `layouts` is the
field to check when "off" and "not known" differ. Changes arrive with no
polling, even while another application has the keyboard.

The [native Wayland backend](wayland-backend.md) answers the same fields from
its seat. A compositor tells only the focused client, so a lock toggled while
another app has the keyboard is seen when focus returns — for a password
field, the window is focused already.

Caps Lock is `LockMask`; Num Lock is taken to be `Mod2`, where every Linux and
BSD desktop and XQuartz put it.

---

## `useDesktopSettings()` — how the desktop wants an app to feel

```jsx
const { doubleClickMs, dragThreshold } = useDesktopSettings();
```

|                       |                                                                      |
| --------------------- | -------------------------------------------------------------------- |
| `caretBlink`          | **false means do not blink at all**                                  |
| `caretBlinkMs`        | how long a caret stays in each state (530)                           |
| `doubleClickMs`       | how long a second click has to arrive in (400)                       |
| `doubleClickDistance` | and how far it may land from the first (4px)                         |
| `dragThreshold`       | how far a press moves before it is a drag (4px)                      |
| `animations`          | **false means reduce motion** — see below                            |
| `source`              | `'xsettings'`, `'portal'`, `'macos'`, or null where nothing answered |

**The built-in controls already follow these.** `<textinput>`'s caret, the
click counting behind `ev.detail`, and the drag threshold all read the same
values. The hook is for an app drawing its own: a `<canvas>` with a text
cursor in it, a custom gesture, a diagram editor with its own drag.

`animations` is the desktop's "reduce motion" — GTK's
`gtk-enable-animations` on X11. **Looping animations already
honour it** — a [`style.animation`](styling.md#loops) never starts while it is
false, so `<ProgressBar indeterminate>` and anything else built on the loop
primitive comes to rest. Transitions are left alone: a 120ms fade that ends is
not the unbounded motion the setting exists for. Read the field where the
_resting_ look is your decision — a spinner that does not spin should still
say it is working, which `<ProgressBar indeterminate>` does by filling its
track instead.

`caretBlink` is not cosmetic: a moving thing on screen is what some people
cannot read past. **Draw the caret solid rather than not at all** — that is
what the built-in controls do.

Where the values come from:

- **X11** (`'xsettings'`): [XSETTINGS](appearance.md#what-each-rung-can-actually-answer),
  the only source; there is no standard portal interface for any of this.
- **[Native Wayland](wayland-backend.md)** (`'portal'`): the settings portal's
  GNOME keys — `org.gnome.desktop.interface` (`cursor-blink`,
  `cursor-blink-time`, `enable-animations`) and
  `org.gnome.desktop.peripherals.mouse` (`double-click`, `drag-threshold`) —
  live, while `createRoot({ desktop })` leaves `appearance` on. A portal that
  does not pass them through (KDE's, a bare compositor's) leaves the defaults.
- **macOS** (`'macos'`): **Reduce motion** only (System Settings ›
  Accessibility › Display), as `animations: false`, live — flipping it stops
  a spinner already going round. The other fields keep the defaults.
- **No settings daemon** — a bare `startx`, most window managers, XQuartz
  (`null`): this renderer's own defaults above, deliberately not GTK's 1200ms
  blink and 8px drag.

`createRoot()` starts XSETTINGS but does not wait for it, so a field focused
on the very first frame gets the built-in default, and the desktop's cadence
from its next focus onward.

---

## `createSettings()` — what the app remembers

The desktop's settings are read above; an app's own — the volume it was left
at, the theme it was switched to — are kept here, in one JSON file per app in
the per-user directory for it:

```jsx
import { createSettings } from 'react-x11';

const settings = createSettings({
  appId: 'com.example.hush',
  defaults: { noiseType: 'brown', volume: 0.5, dark: false },
});

function Volume() {
  const [volume, setVolume] = settings.use('volume');
  return <Slider value={volume} onChange={setVolume} />;
}
```

`settings.use(key)` is a `useState` every component shares: every component
using the key, in any window, sees one value, and setting it from one moves
them all. It takes an updater function too, and `settings.use(key, fallback)`
covers a key with no default.

| platform  | file                                                     |
| --------- | -------------------------------------------------------- |
| macOS     | `~/Library/Application Support/<appId>/settings.json`    |
| elsewhere | `$XDG_CONFIG_HOME/<appId>/settings.json` (`~/.config/…`) |

The `appId` is a reverse-DNS name no other app uses, the shape
[`registerApplication`](uri-schemes.md) takes; the store registers nothing
with it. Creating the store twice with the same id — in a module a hot reload
evaluates again, or in two call sites — is one store with one set of values.

**It is read synchronously, the first time a value is asked for**, so the
first render already has what was saved rather than the defaults and then a
jump. It is written asynchronously:

- **coalesced** — a quarter second after the last change, and at least once a
  second while changes keep coming, so a drag on a slider is a few writes and
  not one per pointer move;
- **atomically** — into a temporary file renamed over the old one, so a crash
  mid-write leaves the file as it was;
- **on exit** — whatever is still unsaved when the process exits is written
  on the way out, including a change whose write was in flight.
  `await settings.flush()` writes it now.

Outside React, `settings.get(key)`, `settings.set(key, value)`,
`settings.reset(key)` — the default again — and `settings.subscribe(listener)`
are the same store. A value is whatever JSON can keep; one it cannot, a
function or a `BigInt`, is a `TypeError` at `set`. A file that is not JSON is
reported once and the defaults stand; the next change replaces it.

Two copies of the app running at once share the file, and the last write
wins: nothing watches for another process changing it.

---

## `useLocale()` — the language and its conventions

```jsx
const { locale, weekStartsOn } = useLocale();

// a date grid — `@react-x11/components`' <Calendar> takes both
<Calendar locale={locale} weekStartsOn={weekStartsOn} />;
<text>{new Intl.NumberFormat(locale).format(total)}</text>;
```

|                |                                                             |
| -------------- | ----------------------------------------------------------- |
| `locale`       | a BCP-47 tag: `'en-GB'`, `'ru-RU'`                          |
| `direction`    | `'ltr'` or `'rtl'`                                          |
| `weekStartsOn` | `0` Sunday … `6` Saturday, from CLDR                        |
| `timeZone`     | `'Europe/London'`, or null                                  |
| `source`       | `'env'` when `LANG` and friends said, `'intl'` when ICU did |

**`LC_ALL` / `LC_MESSAGES` / `LANG` win over `Intl`'s own answer**, which is
whatever ICU has compiled in — a small-ICU build of node reports `en-US`
everywhere. `C` and `POSIX` are the _absence_ of a locale, so they fall
through to ICU rather than becoming a tag.

**This does not change while the app runs**, and there is no subscription
behind it: the environment is fixed at exec, so a desktop that switches
language does so for the _next_ login.

For text direction inside a component prefer `useDirection()` over
`useLocale().direction` — it also honours `<ThemeProvider direction>` and the
`direction` style property, which the locale knows nothing about. See
[styling](styling.md). The default theme is already seeded from the locale, so
an app started under `LANG=ar_EG.UTF-8` mirrors without being told to.

---

## What is not here

- **Network status** — not built: there is no X-level answer, and a failed
  request is a better truth than a flag that says the link is up.
- **Battery, brightness, volume, media keys** — D-Bus services a third party
  can wrap without anything from here ([dbus.md](dbus.md)).
- **Elsewhere:** notifications ([notifications.md](notifications.md)); the
  tray, [`useTray()`](desktop.md#the-tray); a launcher badge,
  [`useBadge()`](desktop.md#the-badge); attention — the taskbar urgency or
  Dock bounce — `states: ['demands_attention']`
  ([desktop.md](desktop.md#attention)); the user's calendar,
  `useDesktopCalendarEvents()` ([desktop-calendar.md](desktop-calendar.md));
  camera/mic/location authorization, `usePermission()`
  ([permissions.md](permissions.md)) — macOS TCC today, not yet the
  freedesktop device portals.
- **Session lifecycle** — "we are suspending, save now", "I have unsaved work,
  do not log out yet" — not built. On the cocoa backend a quit request from
  the Dock, ⌘Q or a logout already reaches the primary window's
  `onCloseRequest` ([uri-schemes.md](uri-schemes.md), "On macOS").

Why, and what was considered:
[design/system.md](../design/system.md#what-is-not-here).
