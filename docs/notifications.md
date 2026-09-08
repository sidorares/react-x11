# Notifications

A banner outside the app's own windows — "export finished", "update ready" —
on whatever the machine has.

```jsx
import { useNotifier } from 'react-x11';

function Exporter() {
  const notifier = useNotifier();

  const run = async () => {
    const file = await exportReport();
    if (!notifier.available) return;
    await notifier.notify({
      summary: 'Export finished',
      body: file.name,
      actions: [{ key: 'open', label: 'Open' }],
      onAction: (key) => key === 'open' && reveal(file),
    });
  };
  return <Button label="Export" onPress={run} />;
}
```

An in-app toast is deliberately **not** this. That is layout, and it belongs
to whoever wants it; this page is about the desktop's own banners.

## The ladder

The [file dialog](filedialog.md)'s shape again, four rungs:

|     |                                     |                                                                                                                                                                                                      |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **the app's notification centre**   | The [cocoa backend](macos.md): `UNUserNotificationCenter`, the system's own banners, list and action buttons. Delivers only for a **code-signed app bundle** with a bundle id — see below.           |
| 2   | **`org.freedesktop.Notifications`** | The desktop's daemon over D-Bus: updating in place, the daemon's capabilities, and the two signals that say what the user did. What a Linux desktop should get.                                      |
| 3   | **`osascript`**                     | `display notification`, on a Mac with neither of the above — the X11 backend under XQuartz, or an unbundled cocoa app. Posted under Script Editor's identity; no actions, no update, no report back. |
| 4   | **`notify-send`**                   | libnotify's CLI, for a Linux box where the bus transport is missing (Node 20) but a daemon runs. The same limits, though a new enough one prints an id, which gives `update()` back.                 |

`notificationBackend()` reports which one this machine lands on without
posting anything. Where none answers, `notify()` rejects with a **typed**
`NoNotificationServiceError` — the signal to fall back to your own UI, not a
crash — and `useNotifier().available` is that branch as render state.

The top rung is never chosen by naming a backend: `notify()` asks the
connection the tree renders through whether it has a centre, and whether that
centre can deliver.

## `notify()` and the handle

```ts
const banner = await notify({
  summary,            // required — the one line every daemon shows
  body?, icon?, urgency?: 'low' | 'normal' | 'critical', timeout?,
  actions?: [{ key, label }], onAction?(key), onClose?(reason),
  subtitle?, silent?, category?, resident?, appName?, appId?, userInfo?,
  backend?, app?,
});

banner.id;                        // the daemon's id / the centre's identifier / null
banner.backend;                   // which rung
await banner.update({ body });    // in place, where the rung can
await banner.close();             // take it down, where the rung can
```

**The daemon's vocabulary is the API's.** `urgency` is
`low | normal | critical`, an action is `{ key, label }`, a click on the
banner itself is the action keyed `'default'`, and a banner that went away
reports `'expired' | 'dismissed' | 'closed' | 'unknown'` — the freedesktop
words, because it is a published protocol with many daemons and this is one
of many clients. The cocoa rung translates into them.

**Attribution is filled in for you.** On Linux the `desktop-entry` hint is
the `appId` [`registerApplication()`](uri-schemes.md) established, which is
what makes the banner show up under your app in the shell's own list of
them; `appId` overrides it. On macOS the bundle is the attribution, and there
is nothing to pass.

## What each rung cannot do

| rung          | update in place     | close   | actions           | what the user did    |
| ------------- | ------------------- | ------- | ----------------- | -------------------- |
| cocoa         | yes                 | yes     | yes               | action, dismissal    |
| dbus          | yes (`replaces_id`) | yes     | if the daemon can | action, close reason |
| `osascript`   | posts anew          | nothing | no                | nothing              |
| `notify-send` | with an id, yes     | nothing | no                | nothing              |

The shell-out rungs are the crude floor: they show a banner and know nothing
afterwards. `handle.backend` says which rung answered, so an app that cares
can say "open the app to see it" there rather than promise a button it
cannot deliver.

**Actions on the bus are gated by the daemon.** Whether it can show buttons
is one of its `GetCapabilities`, and an app that sends actions to a daemon
without `actions` has silently produced a notification nobody can act on —
so they are dropped with a development warning rather than sent blind.
Capabilities are read once per bus session.

**A refusal is not fallen through.** On the cocoa backend the first post asks
the system's authorization prompt, once per bundle. A user who declined the
app's notifications has said something, and `notify()` rejects with the
platform's error (`NotificationsDeniedError`) rather than posting through
`osascript` by a side door.

**A refusal is an answer; a prompt nobody saw is not.** The two look identical
from the call — the authorization request comes back refused either way — so
the rung reads the status again afterwards, because only a prompt moves it off
`notDetermined`. A bundle macOS has not registered (an ad-hoc signature in a
temp directory is the usual way to meet this) never gets the prompt, and
reporting that as a denial would tell the user they declined something they
were never shown. Nobody has turned anything off, so the ladder carries on to
`osascript`; only `backend: 'cocoa'` turns it into an error, and that one says
`notDetermined` rather than blaming the user.

Which is why an app that counts progress should ask before it decides. `examples/notify.jsx` (`npm run examples:notify`) is a download manager built around exactly that: it posts one banner and updates it in place where the rung can, and on `osascript` or `notify-send` stays quiet and posts once at the end, because posting per step there would be four banners for one download.

## The bundle, on macOS

`UNUserNotificationCenter` attributes every banner to an app bundle — a
`CFBundleIdentifier` Launch Services can see — and raises in a process that
is none, which is what a bare `node` is. The bridge probes it once and
reports `available: false`; `notify()` then takes the `osascript` rung, whose
banners are Script Editor's. To get the real thing, run as a bundle: the
executable in `Name.app/Contents/MacOS/`, an `Info.plist` that names it and
carries `CFBundleIdentifier`, and a signature
(`codesign --force --sign - Name.app` is enough locally). See
[packaging.md](packaging.md).

## `useNotifier()`

```ts
const { notify, available, backend } = useNotifier(defaults?);
```

`notify` is the bare function bound to the tree's connection; `available`
settles once the ladder has been probed (one bus round trip, or one read of
the centre) and is false where `notify()` would reject; `backend` is the rung.
Options given to the hook are defaults for every call; options given to a
call win.

## Running it where there is no daemon

| where                                           | rung                                               |
| ----------------------------------------------- | -------------------------------------------------- |
| macOS, the cocoa backend, as an app bundle      | the centre                                         |
| macOS, the cocoa backend, bare `node`           | `osascript`                                        |
| macOS + XQuartz                                 | `osascript` (a D-Bus daemon on a Mac is rare)      |
| GNOME / KDE / any desktop with a daemon         | `org.freedesktop.Notifications`                    |
| Node 20 on Linux, where npm skips `dbus-native` | `notify-send`                                      |
| ssh, `startx`, a container, CI                  | `NoNotificationServiceError` — draw your own toast |

The bus rung holds one session-bus reference while any banner is live and
releases it when the last one closes, so an app that closed its banners on
the way out is free to exit.
