# Notifications: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/notifications.md](../docs/notifications.md), the reference, and keep
their original headings so code comments that cite them still resolve.

## The ladder

The top rung is never chosen by naming a backend: `notify()` asks the
connection the tree renders through whether it has a centre, and whether that
centre can deliver.

## `notify()` and the handle

**The daemon's vocabulary is the API's.** `urgency` is
`low | normal | critical`, an action is `{ key, label }`, a click on the
banner itself is the action keyed `'default'`, and a banner that went away
reports `'expired' | 'dismissed' | 'closed' | 'unknown'` — the freedesktop
words, because it is a published protocol with many daemons and this is one
of many clients. The cocoa rung translates into them.

## What each rung cannot do

`win32` sits with the shell-out rungs on everything but where it is shown:
a `Shell_NotifyIcon` balloon is a real toast in a real action centre, and
also a fire-and-forget one. Buttons, replies and a lifetime the app controls
want the Windows App SDK's notification manager, which will not show anything
at all until the system knows an AppUserModelID for the process — a
Start-menu shortcut carrying one, or a registry registration. That is a
packaging question ([windows.md](../docs/windows.md) §"Packaging and identity"), and
a balloon is what can be shown without asking the user to install anything.

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
[packaging.md](../docs/packaging.md).
