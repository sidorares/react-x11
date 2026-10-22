# Desktop integration

What an app tells the desktop about itself, beyond drawing: startup
notification (on by default, nothing to call); the launcher's view of the app
— a badge, a progress bar, a bounce for attention, the Dock's menu; the tray;
what a password field needs to be reachable by password managers; and the one
switch that turns off everything here that talks over D-Bus.

The menu bar has its own page, [globalmenu.md](globalmenu.md). The other
direction — the desktop handing the app a `myapp://…` link, and single
instance — is [uri-schemes.md](uri-schemes.md); its `ctx.timestamp` is the
same `_TIME` suffix [`launchTimestamp()`](#launchtimestamp) parses here.

## Startup notification

A launcher that spawns an app opens a **startup sequence** — the busy cursor —
and closes it when the app says it is up. An app that never says so leaves the
cursor spinning until the desktop gives up (15 seconds on mutter), long after
its window is on screen, and users take that for a failed launch. The same
handshake carries **focus** — `_NET_WM_USER_TIME`, without which a strict
desktop opens the new window behind whatever the user was doing — and
**placement**, the workspace the launch happened on. react-x11 does all of it
with no configuration:

```jsx
const root = await createRoot(); // that is the whole of it
```

`DESKTOP_STARTUP_ID` is read from the environment and **removed from it**: the
variable names one launch, and a child process that inherited it would claim
the parent's sequence and end it early. With no id in the environment — a
terminal, CI, XQuartz — nothing is set and nothing is sent.

### When is an app "started"?

The default is **the first frame that actually painted**. A window maps a
frame before it draws, so ending the sequence on map (what GTK does) would say
"ready" over a blank window. A suspense fallback counts as painted: the app is
up and telling the user what it is doing, and there is no signal for "finished
loading".

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
maps, whichever mode is in force, so an app that never paints or forgets to
call cannot leave the cursor spinning.

### Turning it off, and supplying an id

```jsx
await createRoot({ startupNotification: false });
await createRoot({ startupNotification: 'launcher/app/1-0_TIME9876' });
```

`false` is for an app that runs its own sequence, or an embedder that owns
the toplevel. Opting out leaves `DESKTOP_STARTUP_ID` in the environment — if
you manage the sequence yourself, the id is yours to read and to clear.

A string supplies the id for a launch where it did not arrive in the
environment. A D-Bus-activated app gets it in `platform_data` instead.

### `launchTimestamp()`

```jsx
import { launchTimestamp } from 'react-x11';

const when = launchTimestamp(); // number | null
```

The X server timestamp of the user action that launched the app, parsed from
the id's `_TIME` suffix — the "when" any later request to come forward is
weighed against. **`null` is a real answer**, not a failure: an app started
from a shell has no launch timestamp. Do not substitute `0` for a missing one;
EWMH reads zero as "do not focus this window when it maps".

### On macOS

XQuartz's quartz-wm implements none of this: the messages go to a root window
nobody listens at and `_NET_WM_USER_TIME` is ignored. Harmless, and not a sign
the feature is broken.

### What is deliberately not here

- **The launcher half** — an app that spawns _another_ app manages that
  child's sequence itself.
- **Ongoing `_NET_WM_USER_TIME` maintenance** — it is set once, at launch, not
  kept current on every keypress.

### Security

The id is broadcast to the root window, so every client on the display sees
it — X11's usual lack of isolation ([security.md](security.md)). The messages
carry only the id the launcher gave, and its value is never logged.

## The launcher: a badge, attention, and the Dock menu

The marks the user reads on the app's icon without opening it. Each exists on
a backend only where that backend has a mechanism for it:

|                       | Linux (`launcherentry`)                                                          | macOS (`cocoa`)                                      | Windows (`taskbar`)                                             |
| --------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| a **badge**           | `com.canonical.Unity.LauncherEntry`                                              | `NSDockTile.badgeLabel`                              | an overlay icon with the label drawn into it                    |
| badge **text**        | — the protocol carries a count and nothing else                                  | any label                                            | up to three glyphs; longer clamps to `99+`, ~16px on screen     |
| **progress**          | `useProgress(0…1)` — a bar across the tile                                       | — `NSDockTile` has none                              | `ITaskbarList3::SetProgressValue`, across the taskbar button    |
| **attention**         | `states={['demands_attention']}`, or `setUrgent()` for the launcher entry itself | the same prop: the Dock icon bounces until activated | `FlashWindowEx`                                                 |
| the **launcher menu** | `useLauncherMenu(items)` — the launcher protocol's quicklist                     | `useLauncherMenu(items)`                             | — the jump list instead (below)                                 |
| **tasks**             | — `Actions=` in the `.desktop` file, not driven from here                        | —                                                    | `useJumpList(tasks)` — the jump list's Tasks category           |
| a **hover toolbar**   | —                                                                                | —                                                    | `useThumbnailToolbar(buttons)` — up to seven, under the preview |
| **recent documents**  | —                                                                                | — the platform has one; this backend does not use it | `useRecentDocument(path)` — the shell's Recent lists            |

On Linux, KDE, elementary and Cairo-Dock show the badge; GNOME needs an
extension. On Windows the taskbar button's menu is the jump list, whose entries
start a _new_ process, so it is `features.tasks` and `useJumpList` rather than
`useLauncherMenu` ([windows-integrations.md](windows-integrations.md)).

### The badge

```jsx
import { setBadge, useBadge } from 'react-x11';

useBadge(unread); // a count: 3 shows "3", 0 clears
await setBadge(null); // the imperative twin, for code with no component
```

A badge is a **count**, the one shape both desktops show. A string (`'•'`,
`'!'`) shows on macOS, where the tile takes any label, and as a count of
nothing on Linux, whose protocol has no text — pass one only where the Mac is
the audience. `0`, `null` and `''` all clear it. `useBadge` clears on unmount;
`setBadge` resolves to whether a launcher was told and never rejects for
anything about the machine.

On Linux the launcher pins the count to the app's `.desktop` file, so it needs
the identity [`registerApplication({ appId })`](uri-schemes.md) establishes
and a `.desktop` file of that name; without them `setBadge` resolves `false`.
A launcher that starts after the badge was set does not see it until the next
`setBadge`.

### Progress

```jsx
import { useProgress, setProgress } from 'react-x11';

useProgress(downloaded / total); // 0…1; null or undefined clears it
await setProgress(null); // the imperative twin
```

A bar drawn across the app's icon, for a download, an export, a long build.
Out-of-range values are clamped rather than refused, so a total that briefly
went to zero does not throw.

**Not on macOS:** `NSDockTile` has no progress bar; an app that wants one
there draws it into a custom tile view itself. Branch on
`useDesktopCapability('launcher').features.progress`.

### Attention

Nothing new to call: `<window states={['demands_attention']}>`. On the cocoa
backend it is `NSApp.requestUserAttention` — the Dock icon bounces until the
user activates the app, and stops when the prop drops the state or the window
goes away. AppKit ignores the request while the app is already active, as a
window manager ignores a focused window's urgency hint. There, `fullscreen`,
`maximized` and `hidden` are AppKit's full-screen Space, zoom and miniaturize,
and the other `states` names are inert.

### The Dock menu

```jsx
useLauncherMenu([
  { label: 'New Window', onSelect: openWindow },
  { type: 'separator' },
  {
    label: 'Recent',
    items: recent.map((r) => ({ label: r.name, onSelect: () => open(r) })),
  },
]);
```

The same `items` vocabulary as `MenuBar` and `ContextMenu` ([menuitem
names](globalmenu.md)), so the window's, the panel's, the tray's and the
Dock's menus are one authoring model. Installed while the component is
mounted, replaced when `items` changes, taken down on unmount.

On the cocoa backend it is `NSDockTile`'s menu; on Linux, the launcher
protocol's **quicklist**, which ubuntu-dock/Dash-to-Dock, Plank and the
Unity-heritage launchers render. Entries that must work **while the app is not
running** belong in `Actions=` in the `.desktop` file instead; the quicklist
is for a menu that follows the app's state. Like the badge, it needs
[`registerApplication({ appId })`](uri-schemes.md) and a `.desktop` file of
that name.

### The app's presence

Two things the Dock and the ⌘-Tab switcher show that a bare `node` process
gets wrong, as root options on the cocoa backend:

```js
await createRoot({
  cocoa: {
    appName: 'Notes', // what the Dock, ⌘-Tab and the app menu print (was "node")
    activationPolicy: 'regular', // 'accessory' for a menu-bar app: no tile, no ⌘-Tab entry
  },
});
```

`activationPolicy` is a root option rather than a hook because it is fixed
before the app finishes launching — an agent app that switched afterwards
would already have flashed its Dock icon. `appName` renames LaunchServices'
record of an unbundled process; a bundle's `Info.plist` wins.

## The tray

```jsx
import { useTray } from 'react-x11';

const { available, backend, features, error } = useTray({
  icon: 'mail-unread', // a themed icon name (an SF Symbol on macOS), or PNG bytes
  tooltip: 'Notifications',
  menu: [
    { label: 'Open', onSelect: open },
    { type: 'separator' },
    { label: 'Quit', onSelect: quit },
  ],
});
```

An icon in the system tray for as long as the component is mounted. With
`menu` a click opens it — the same `items` vocabulary as `MenuBar` and the
Dock menu. Without one, `onClick` gets the button, where the click was and,
where the backend knows it, the item's screen rect — all in logical screen
pixels, the unit a `<popup>`'s `x`/`y` are in, and what a popover under the
item anchors to ([elements.md](elements.md#a-popover-under-a-tray-item)).
`title` shows text beside the icon or alone; `visible`, `tooltip`, `attention`
and the rest follow their values while mounted, and the item is removed on
unmount. `null` means no item. Several trays coexist: each is its own item.

|                 | Linux (`statusnotifier`)                | macOS (`cocoa`)              | Windows (`shellnotifyicon`) |
| --------------- | --------------------------------------- | ---------------------------- | --------------------------- |
| mechanism       | `org.kde.StatusNotifierItem` over D-Bus | `NSStatusItem`               | `Shell_NotifyIcon`          |
| menu            | `com.canonical.dbusmenu`                | `NSMenu`                     | a tracked popup menu        |
| icon by name    | the desktop's icon theme                | SF Symbols                   | — no icon theme to name     |
| icon by bytes   | ARGB32 pixmap                           | a template image             | an `HICON` from RGBA        |
| title           | text beside the icon                    | text beside the icon         | — an icon and a tooltip     |
| attention       | `Status = NeedsAttention`               | —                            | —                           |
| click rect      | —                                       | the item's frame             | —                           |
| click modifiers | —                                       | shift/control/option/command | —                           |
| scroll          | `Scroll(delta, orientation)`            | —                            | —                           |

**On Linux** it is D-Bus only, so it works identically under X11, XWayland and
Wayland. It needs something _hosting_ a tray: KDE Plasma and most panels do
out of the box; GNOME needs an AppIndicator extension. A stock GNOME session
with no extension has no tray, `available` is `false`, and nothing is logged —
that is a configuration, not a fault.

**A click's position on Linux** is in a unit the protocol never names: Plasma
and GNOME's physical layout send device pixels; GNOME's logical layout (the
default from GNOME 50), xfce4-panel, LXQt and Cinnamon send logical ones. The
point is read both ways: a reading on no monitor is dropped, then the one the
pointer is on wins, else the numbers are taken as sent. One case is misread —
a device-pixel host under XWayland whose tray, read as logical pixels, still
lands on a monitor (the top-left quarter of the screen, or with another
monitor beyond it): there the point is `scale` times as far from the screen's
origin as the click was.

**On the cocoa backend** it is `NSStatusItem`, the menu-bar extra. A menu-bar
app that wants no Dock tile pairs it with
`createRoot({ cocoa: { activationPolicy: 'accessory' } })` above. A PNG icon
is drawn as a **template** — its shape in the bar's ink, following light and
dark like a symbol; `template: false` keeps its colours. The menu is rebuilt
only when its items change, so a title that ticks every second leaves it
alone, whether `menu` is memoized or written inline.

### What the hook hands back

`available` **settles**: finding a freedesktop tray takes a bus round trip, so
it is `false` on the first frame and `true` a tick later if a host is there —
render the fallback first and upgrade. It follows the host for the life of the
item, so a panel that exits flips it back.

**`settled` says whether `available` is an answer yet.** For an app whose
whole UI is its tray item, the fallback _is_ a window, and rendering it first
flashes a window up and away on every start on a desktop that has a tray. So
wait for the answer instead:

```jsx
const tray = useTray({ icon: 'waveform', onClick: open });
if (!tray.settled) return null; // a bus round trip, not a timeout
if (!tray.available) return <window title="Hush">{controls}</window>;
return popover;
```

It is `true` on the first frame on macOS, where the status item is made there
and then, and for `useTray(null)`; on the freedesktop tray it turns `true` once
the host has taken or refused the item, and stays so.

`features` is the same vocabulary [feature discovery](#feature-discovery)
uses, for the rung that answered. Read it instead of testing the platform:

```jsx
// Right: ask about the thing you need.
{
  features.clickModifiers && <ShiftClickHint />;
}
```

`error` separates **"this desktop has no tray"** (`error` null) from **"there
is a tray and it refused me"** (the reason is there) — only the second has a
fix.

## Feature discovery

Everything on this page is a _ladder_, and which rung a machine lands on
changes what the app may do. `available` alone is not enough: a notification
daemon with `actions` gives a banner with buttons that call back, and
`notify-send` gives one-way text — an app that posts reply buttons on the
second gets a banner with no buttons, silently. So the unit of discovery is a
**feature set**, not a flag:

```jsx
import { useDesktopCapability } from 'react-x11';

const notifications = useDesktopCapability('notifications');

if (notifications.features.actions) return <ReplyFromBanner />;
if (notifications.available) return <BannerThenOpenApp />;
return <InAppToastOnly />;
```

`{ available, backend, features, settled }`. `backend` names the
**mechanism** — `'dbus'`, `'cocoa'`, `'statusnotifier'`, `'launcherentry'`,
`'notify-send'`, `'osascript'`, `'win32'`, `'shellnotifyicon'`, `'taskbar'` —
never the platform. Branch on `features`; `backend` is for logs and bug
reports.

`settled` is `false` until the first probe answers and `true` from then on, so
an app can hold its fallback back rather than flash it; it is `true` on the
first frame for the answers that need nothing asked, the tray and the Dock tile
on macOS.

Capability names are `'notifications'`, `'tray'` and `'launcher'`.
`desktopCapability(name)` is the imperative twin for code with no component.

### Which one to ask

A hook that _does_ the thing already knows whether it worked, and that
measurement beats any prediction:

- **`useTray(options)`** — "did my icon get taken?" It tried; it knows.
- **`useDesktopCapability('tray')`** — "would one be taken if I asked?" This
  is what a settings screen needs: a "Show tray icon" checkbox has to render
  correctly _without_ putting an icon in the tray to find out.

Prefer the feature hook wherever the feature is actually mounted. Both read
the same probe, so they cannot disagree.

### Degrading well

1. **Render the fallback first.** Every desktop answer takes a round trip, so
   the first frame has none. Upgrading a fallback is invisible; downgrading a
   feature the user already reached for is not.
2. **Never disable a feature permanently on a `false`.** A panel restarts, an
   extension is enabled, a daemon is installed. The hooks re-probe when a
   service appears on the bus and nothing is cached — an app that latched the
   first answer would outlive every one of those fixes.
3. **A missing desktop service is not an error.** No bus, no tray host, no
   notification daemon and no launcher are all ordinary states of a healthy
   machine. Nothing is logged and nothing throws. `error` is for a service
   that answered and then refused.

### All of it, in one app

`examples/desktop.jsx` (`npm run examples:desktop`) is a backup agent that
uses every hook on this page at once — the tray icon with its attention state
and overlay, the badge, the progress bar, the quicklist, the urgency flag, and
a banner whose buttons are offered only where the daemon has `actions` — and
whose second pane renders `useDesktopCapability()` for each of `CAPABILITIES`
beside the live answers. Read it to see what an app will get on a machine you
do not have. The feature-sized examples are `badge.jsx` (the launcher),
`tray.jsx` (the tray) and `notify.jsx` (the notification).

## Turning the desktop off

Three things react-x11 turns on for you reach the **session bus**:

|              |                                                                         |                                      |
| ------------ | ----------------------------------------------------------------------- | ------------------------------------ |
| `appearance` | following the desktop's light/dark, accent, contrast and reduced motion | [appearance.md](appearance.md)       |
| `a11y`       | the AT-SPI bridge — whether a screen reader can see the app             | [accessibility.md](accessibility.md) |
| `globalMenu` | a `MenuBar` handing its menu to the panel instead of drawing it         | [globalmenu.md](globalmenu.md)       |

Each is the right default, but an embedder, a kiosk or a test may own the
thing they assume is theirs:

```jsx
await createRoot({ desktop: false }); // none of the three
await createRoot({ desktop: { appearance: false } }); // just that one
```

With all three off, **nothing dials the session bus at startup** — no
connection, no subprocess, no portal probe.

Prefer this to the environment variables that do the same — `NO_AT_BRIDGE=1`,
`REACT_X11_NO_GLOBAL_MENU=1`, or unsetting `DBUS_SESSION_BUS_ADDRESS`: the
environment is inherited, so they reach every child process too, and the
D-Bus one also takes down the portals and the app's own exported services.

Turning `appearance` off means the app draws in its own palette:
`useSystemAppearance()` reports `'no-preference'` with `source: null`, and the
answer remembered on disk is not read either.

**Off is process-wide, and it latches.** There is one D-Bus identity and one
AT-SPI bridge per process, so the policy is not per-root: nothing turns an
integration back on, and a feature already started stays started — pass this
on the first root.

## Not blocking the first frame on the bus

On macOS the session bus address comes from launchd rather than the
environment; react-x11 looks it up once, asynchronously, so it costs the event
loop and the first frame nothing. There is nothing to configure. On Linux
`$DBUS_SESSION_BUS_ADDRESS` or `$XDG_RUNTIME_DIR/bus` answers directly.
Design notes: [design/desktop.md](../design/desktop.md#not-blocking-the-first-frame-on-the-bus).

## Password fields and password managers

There is **no password-field protocol on the Linux desktop**: no toolkit
publishes "this is a password field, fill it", and no manager asks. There are
four seams instead, which an application either supports or does not.
`PasswordInput` supports the two that reach a field.
How the managers do it: [design/desktop.md](../design/desktop.md#password-fields-and-password-managers).

### 1. Typing — XTEST auto-type, and the keymap race

Most desktop managers **auto-type**: KeePassXC matches the focused window's
**title** against its entries and synthesises the keystrokes over XTEST.

- **A faked key is an ordinary key.** `PasswordInput` — and every other
  focusable node — cannot tell auto-type from a person, and nothing has to be
  done to support it. A sequence of `{USERNAME}{TAB}{PASSWORD}{ENTER}` walks a
  react-x11 form because Tab moves focus and Enter reaches `onSubmit`.
- **The window needs a title worth matching.** `<window title="…">` is the
  integration surface: a window titled after the document with nothing
  identifying the app is one a user cannot write an auto-type rule for. Set
  `appId` too, for managers that match on it.
- **Characters outside the user's layout can race.** A manager types them by
  remapping a spare keycode first; one that types immediately after remapping
  can land the key before react-x11 has refetched the keymap. ASCII passwords
  on an ASCII layout are not affected, and nothing on this side can close it.

### 2. Pasting — the clipboard, and the hint that keeps it out of history

Copy-to-clipboard is ordinary `CLIPBOARD` interop ([clipboard.md](clipboard.md)):
`PasswordInput` takes Ctrl+V and Shift+Insert, and strips control characters
so a manager's trailing newline does not end up inside the secret.

If your app ever puts a secret **on** the clipboard — this widget never does
— offer `x-kde-passwordManagerHint` with the value `secret` beside the text.
Klipper drops such an offer from its history, KDE Connect refuses to forward
it, and `wl-clipboard` marks it sensitive. It is a convention rather than a
specification, and the only thing between a copied password and a clipboard
manager's on-disk history:

```js
clipboard.write({ UTF8_STRING: secret, 'x-kde-passwordManagerHint': 'secret' });
```

`PasswordInput` never takes the **PRIMARY** selection, which a `<textinput>`
does on every selection: PRIMARY is pasted by a middle click in any window on
the display.

### 3. Fetching it yourself — the Secret Service

An app with an account of its own to unlock needs no field at all: the
**Secret Service** D-Bus API, `org.freedesktop.secrets` (gnome-keyring,
KWallet, KeePassXC), is reachable through `useSessionBus()`
([dbus.md](dbus.md)) — search by attributes, unlock the collection if locked,
read the secret back. react-x11 has no wrapper for it. Inside a Flatpak
sandbox that name is absent; `org.freedesktop.portal.Secret`'s
`RetrieveSecret` hands the app a per-application master secret instead, which
libsecret uses automatically to encrypt a local store.

### 4. Reading the field — AT-SPI, which does not mark it yet

AT-SPI2 gives a password entry the role `password text`, which is how a screen
reader knows to announce "bullet" and how some automation finds the field.
react-x11 publishes an accessibility tree ([accessibility.md](accessibility.md)),
but `PasswordInput` is a plain `role="textbox"` in it, so this seam is still
closed.

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
