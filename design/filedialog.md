# File dialogs: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/filedialog.md](../docs/filedialog.md), the reference, and keep
their original headings so code comments that cite them still resolve.

## The ladder

The top rung is never chosen by naming a backend: the dialog asks the window
it belongs to which connection it is on, and an app that can show native
panels says so. That is what keeps the ladder one ladder as backends join it.

**The ladder is the design, not a fallback chain bolted on.** react-x11's
flagship case is an app running on one machine and drawing to another, and a
file dialog that only worked on a full GNOME session would be useless to
exactly the person the renderer exists for.

## `useFileDialog()`

### The dialog parents itself

Why inference rather than a lookup: a hook has no position in the host tree.
React context cannot come from a host element, the host context
`getChildHostContext` builds reaches `createInstance` and not components, and a
`<window>` has no XID until the commit phase. So it answers from what the
renderer does know — the top-level windows this connection is rendering:

- **one top-level window is exact.** The component is in it, because there is
  nowhere else to be. That is nearly every app.
- several, one focused: that one. You clicked in it a moment ago, which is why
  a dialog is opening.
- several with nothing to separate them: the most recently opened, plus a
  development warning naming `parentWindow` as the way to be exact.
- **none at all: the root-level `<popup>` that took the keyboard.** A menu-bar
  app is a tray item and the popover a click on it opens, and nothing else
  ([elements.md](../docs/elements.md#a-popover-under-a-tray-item)) — so the popup is
  the top of that tree, and answering nothing left every hook that reads this
  one with no owner to belong to.

## What differs between the rungs

- **MIME-type filters do not reach `osascript`.** `extensions` translate
  exactly to every rung; `mimeTypes` reach the portal and the native panel
  (the cocoa backend asks the OS's own type database, so `image/png` is
  `public.png` there) and are dropped by `osascript`, because AppleScript's
  `of type` wants extensions or UTIs and guessing a UTI wrong hides the user's
  file with no way to get at it. Give `extensions` where you can.
- **`osascript` ignores `parentWindow`; the native panel is a sheet on it.**
  XQuartz windows are `NSWindow`s owned by X11.app, macOS has no cross-process
  transient-for, and `osascript` is a third process besides: its panel
  appears over the app but is not attached to it, and application modality
  works only because your code is awaiting the promise. On the cocoa backend
  the panel is a **sheet** on that window, and the app keeps running while it
  is up. With no window at all — a bare `openFile()` with nothing in
  `parentWindow` and no tree to infer one from — the native panel is
  app-modal and **blocks the process**, timers included, until it is
  dismissed. `useFileDialog()` always names the window, so it never lands
  there.

In the built-in dialog a double click opens a directory or picks a file, Enter
does the same to the selected row, `Up` goes to the parent, and Escape cancels
— and a selected directory is drawn in the selection's own text colour rather
than the accent it wears at rest, since the selected row is filled with that
accent in both schemes.

## Running it where there is no bus

The `osascript` rung is reached by _not_ finding a portal, so it also covers a
Mac that has a session bus for other reasons. If you do run a portal shim on a
Mac (see [issue #111](https://github.com/sidorares/react-x11/issues/111)), it
wins on the X11 backend, which is what you asked for by running it; on the
cocoa backend the native panel is above it either way.

## The portal machinery, if you need it directly

`portalRequest()` is exported for building other portals on. Every portal
method that shows UI returns an object path immediately and answers later with
a `Request.Response` signal — and the path is predictable **by design**, so the
client subscribes _before_ it calls and cannot lose the answer:

It owns the three things every portal caller otherwise re-solves: subscribing
first, `Request.Close()` on abort (which emits **no** `Response`, so the
promise has to be settled locally), and no timeout on the answer — a dialog can
legitimately be open for an hour, and only the initial call is deadlined.

`hasService(name)` answers whether a service is reachable — owned now **or
activatable on demand**. `NameHasOwner` alone is the wrong question:
`org.freedesktop.portal.Desktop` is D-Bus-activatable, so on a healthy desktop
where no app has touched a portal yet it has no owner, and a feature gated on
that takes the fallback path forever.

`portalVersion(iface)` answers the question `hasService()` cannot: whether the
portal's backends provide one _interface_, and at what version — `0` when it
is not there at all. Capability lives in the interface's own `version`
property, and gating on the service alone breaks exactly on the desktops that
provide some portals and not others (XFCE has FileChooser and no Screenshot).
