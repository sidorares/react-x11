# The machine around the app

Six hooks for the things an application has to read off the system rather than
work out for itself: the monitors, what the window manager did with the
window, whether anyone is at the desk, the state of the keyboard, how the
desktop wants an app to feel, and the language it was launched in.

```jsx
import {
  useScreens,
  useWindowState,
  useIdle,
  useKeepAwake,
  useKeyboardState,
  useDesktopSettings,
  useLocale,
} from 'react-x11';
```

They share a shape, and it is worth knowing before reading any one of them:

- **Nothing is asked of the server until a component asks.** Every one of
  these costs round trips or an event selection, and an app that never calls
  them pays for none of it.
- **Every one has an answer with no extension present.** X is a protocol with
  thirty years of optional pieces, and "this display cannot say" is a real
  state rather than an error. Each hook below names what it reports then, and
  which field tells that apart from a genuine "no".
- **The colours are somewhere else.** Light or dark, the accent and reduced
  motion are [system appearance](appearance.md), which has a ladder of its own.

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

Re-renders when a monitor is plugged in or unplugged, when the arrangement
changes, and when a panel appears, moves or auto-hides.

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

`'screen'` is the tier under both: one entry covering the whole display, for a
server with neither extension. `null` is a headless mock with no display at
all.

### `available` is an approximation, and the only one here

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

### Mirroring

Two outputs showing the same pixels share one CRTC and are reported as **one**
monitor, with both names in `outputs`. A laptop mirroring to a projector is one
screen to put a window on, and `screens.length === 2` there would be a wrong
answer an app would act on.

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

|              |                                                                    |
| ------------ | ------------------------------------------------------------------ |
| `focused`    | this window has the keyboard                                       |
| `visible`    | **the one to branch on** — not minimized, not fully covered        |
| `minimized`  | `_NET_WM_STATE_HIDDEN`: iconified, or shaded away                  |
| `maximized`  | both axes; one axis alone shows up in `states`                     |
| `fullscreen` | what the WM actually did, not what `<window fullscreen>` asked for |
| `obscured`   | fully covered — **always false under a compositor**                |
| `states`     | the raw `_NET_WM_STATE` names                                      |
| `desktop`    | the workspace index, or null                                       |

`<window states>` is what a window **asks for**; this is what it **got**. The
two part company routinely — a user hits a maximize hotkey, a tiling WM
declines a fullscreen request — and an app that mirrors the state in its own
UI has nowhere else to read it.

With no argument it reads the window the component is in, inferred the way
[`useTopLevelWindow()`](filedialog.md) infers it: exact for a one-window app,
and a documented guess for a tree with several. Pass a ref to be certain.

```jsx
const win = useRef(null);
const { fullscreen } = useWindowState(win);
return <window ref={win}>…</window>;
```

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

So `obscured` is a bare-WM optimisation, and `visible` — which folds in
`minimized`, the signal that _does_ survive compositing — is the field to
branch on. An animation paused on `visible` stops when the window is minimized
everywhere, and additionally when it is buried on a desktop with no compositor.

---

## `useIdle()` and `useKeepAwake()` — is anyone there

```jsx
const away = useIdle(5 * 60_000);
<Avatar status={away ? 'away' : 'online'} />;
```

Idleness is the **whole display's**, not this window's: it counts input on
every device, whichever application it went to. That is the right meaning for a
presence indicator, an auto-save, or a dashboard that stops refreshing when the
desk is empty — and the wrong one for "has the user ignored _my_ window", which
is `useWindowState().focused`.

Where the X server carries an `IDLETIME` counter — Xorg does — this costs **no
timer at all**: a SYNC alarm fires when the counter crosses `timeout` and
another when input pulls it back down, which is what every idle daemon on the
desktop is built on. On a server without one (XQuartz) it falls back to polling
MIT-SCREEN-SAVER, scheduled against the remaining time rather than on a tick.
On a display with neither it stays `false`.

`timeout` is a dependency, so hold it in a constant rather than building it
inline from state that moves.

### Keeping the screen on

```jsx
useKeepAwake(playing, 'Playing a video');
```

Held while the flag is true and the component is mounted, released on either —
including on an unmount mid-playback, which is the case that leaves a desktop
permanently un-blanking when this is done by hand.

Three rungs: the settings portal's `Inhibit`, the older
`org.freedesktop.ScreenSaver` service, and `ScreenSaverSuspend`, which is a
plain X request and needs no session bus at all. **All three inhibit screen
blanking only.** Nothing here stops a suspend — only the portal rung could, and
a seam that works on one desktop in three is worse than not offering it.

`reason` is shown by desktops that list what is holding the screen on, so it
reads best as a sentence about the app's state rather than the app's name,
which they already show.

Failure is silent by design: a machine with no portal, no screensaver service
and no MIT-SCREEN-SAVER cannot be asked, and a video player is not the place to
surface that. `keepAwake()` is the imperative twin, and resolves to the release.

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

The point of the first row is that it is true of the **keyboard** rather than
of an event. A key event carries the modifier state at the moment it was
pressed, so an app can see that Caps Lock was on for a key it received — which
is no help at all in the case that matters, a password field that wants to warn
while it is merely focused and before anything has been typed.

The layout half is for a status-bar indicator, and for the other thing that
costs people real time: a password typed in the wrong script, which looks
identical to a wrong password. `layout` is a code rather than a description
(`'ru'`, not `'Russian'`) because that is what an indicator shows; uppercase it
for display.

Everything here needs **XKB**, which Xorg and XQuartz both have. Where it is
missing the locks read false and `layouts` is empty — so `layouts` is the field
to check when the difference between "off" and "not known" matters. Changes
arrive as `XkbStateNotify`, with no polling, even while another application has
the keyboard.

Which bit is which lock is worth writing down: Caps Lock is `LockMask`, fixed
by the core protocol, and **Num Lock is not fixed by anything** — it is wherever
the modifier map puts it, which is `Mod2` on every Linux and BSD desktop, on
XQuartz, and in every toolkit that hardcodes it. This takes the convention.

---

## `useDesktopSettings()` — how the desktop wants an app to feel

```jsx
const { doubleClickMs, dragThreshold } = useDesktopSettings();
```

|                       |                                                          |
| --------------------- | -------------------------------------------------------- |
| `caretBlink`          | **false means do not blink at all**                      |
| `caretBlinkMs`        | how long a caret stays in each state (530)               |
| `doubleClickMs`       | how long a second click has to arrive in (400)           |
| `doubleClickDistance` | and how far it may land from the first (4px)             |
| `dragThreshold`       | how far a press moves before it is a drag (4px)          |
| `animations`          | **false means reduce motion** — see below                |
| `source`              | `'xsettings'`, or null where no settings daemon answered |

**The built-in controls already follow these.** `<textinput>`'s caret, the click
counting behind `ev.detail`, and the drag threshold all read the same values, so
an app that uses the widget set gets this for nothing. The hook is for an app
drawing its own: a `<canvas>` with a text cursor in it, a custom gesture, a
diagram editor with its own drag. Reach for it so that one widget on the screen
does not feel unlike every other.

`animations` is the desktop's "reduce motion", from GTK's
`gtk-enable-animations`. **Looping animations already honour it** — a
[`style.animation`](styling.md#loops) never starts while it is false, so
`<ProgressBar indeterminate>` and anything else built on the loop primitive
comes to rest with nothing to do. Transitions are left alone: a 120ms fade
that ends is not the unbounded motion the setting exists for. Read the field
where the _resting_ look is a design decision your app has to make — a
spinner that does not spin should still say it is working, which is what
`<ProgressBar indeterminate>` does by filling its track instead.

`caretBlink` deserves the callout. A caret that ignores it is not a cosmetic
miss: a moving thing on screen is what some people cannot read past, which is
why the desktop offers the switch at all. **Draw the caret solid rather than not
at all** — that is what the built-in controls do.

[XSETTINGS](appearance.md#what-each-rung-can-actually-answer) is the only source; there is no portal
interface for any of this. On a desktop with no settings daemon — a bare
`startx`, most window managers, XQuartz — `source` is null and the numbers above
are this renderer's own defaults. They are deliberately not GTK's, which blinks
on a 1200ms cycle and drags at 8px: the point is to follow a desktop that
expressed a preference, not to change what happens on one that did not.

One seam worth knowing about. `createRoot()` starts XSETTINGS but does not
**await** it — five round trips on every app's startup path, to answer a
question that is not asked until the first interaction, is a bad trade. A field
focused on the very first frame therefore gets the built-in default and the
desktop's cadence from its next focus onward.

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

For text direction inside a component prefer `useDirection()` over
`useLocale().direction` — it also honours `<ThemeProvider direction>` and the
`direction` style property, which the locale knows nothing about. See
[styling](styling.md). The default theme is already seeded from the locale, so
an app started under `LANG=ar_EG.UTF-8` mirrors without being told to.

---

## What is not here

**Network status.** There is no X-level answer, so it is necessarily D-Bus or
netlink, and the honest version of the API would be a hint rather than a fact —
a failed request is always the better truth than a flag that says the link is
up. Not ruled out; not built.

**Battery, brightness, volume, media keys, notifications, a tray icon.** These
are D-Bus services a third party can wrap without anything from here.
Notifications and StatusNotifierItem are the two with a claim on core, because
they are desktop standards rather than one vendor's service — and the tray in
particular is cheap here, since its menu is [dbusmenu](globalmenu.md), which
this renderer already speaks.

**Session lifecycle** — "we are suspending, save now", and "I have unsaved work,
do not log out yet". The X-native answer (XSMP) is effectively dead and the live
one is logind. The shape worth having is probably not a system hook but a
`useBeforeQuit()` that unifies it with `<window onCloseRequest>`.

**Display scale.** On a HiDPI desktop every widget renders at half size, and
fixing it means a scale that multiplies layout, font sizes and the paint
transform together — a root concern rather than a hook. Tracked as
[#116](https://github.com/sidorares/react-x11/issues/116).
