# File dialogs

Open a file, save a file, pick a folder — on whatever the machine has.

```jsx
import { useFileDialog } from 'react-x11';

function Toolbar() {
  const { openFile } = useFileDialog();

  return (
    <Button
      label="Open…"
      onPress={async () => {
        const files = await openFile({
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        });
        if (!files) return; // cancelled
        load(files[0]);
      }}
    />
  );
}
```

Cancelling resolves to `null`. It is an ordinary outcome, not an exception, on
every backend — so the whole error path for a file dialog is one `if`.

## The ladder

The rung is chosen for you, top to bottom:

|     |                         |                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **the native panel**    | `NSOpenPanel` / `NSSavePanel` on the [cocoa backend](macos.md) (`@windowkit/appkit` ≥ 0.5): a **sheet** on the window that asked, with every filter the OS type database knows. On the [win32 backend](windows.md), Windows' own open/save dialog, owned by the window that asked, takes the same rung (`fileDialogBackend()` reports `'cocoa'` for both). |
| 2   | **the portal**          | `org.freedesktop.portal.FileChooser` over D-Bus: the desktop's own GTK or KDE dialog, with the user's bookmarks and recent files.                                                                                                                                                                                                                          |
| 3   | **`osascript`**         | macOS on the X11 backend with no portal (every ordinary XQuartz install). `choose file` _is_ `NSOpenPanel`, in a third process.                                                                                                                                                                                                                            |
| 4   | **the built-in dialog** | A browser react-x11 draws itself. ssh, a bare `startx`, a container: everywhere there is a display and nothing else.                                                                                                                                                                                                                                       |

The top rung is chosen by the window the dialog belongs to, never by naming a
backend. `fileDialogBackend()` reports which rung this machine lands on,
without showing anything — for a diagnostics panel, or a menu that wants to
say so.

## `useFileDialog()`

```ts
const { openFile, saveFile, selectFolder } = useFileDialog(defaults?);

openFile(options?): Promise<string[] | null>;    // absolute paths
saveFile(options?): Promise<string | null>;      // one path, may not exist yet
selectFolder(options?): Promise<string[] | null>;
```

The hook is the surface to reach for: it has a tree to draw the built-in dialog
in, so it never runs out of rungs and never rejects for lack of a dialog.

| option                        |                                                   |
| ----------------------------- | ------------------------------------------------- |
| `title`                       | the dialog's title                                |
| `multiple`                    | several files at once; ignored when saving        |
| `filters`                     | `{ name, extensions?, mimeTypes? }[]`             |
| `defaultFolder`               | where it opens                                    |
| `defaultName` / `defaultPath` | what a save dialog starts on                      |
| `acceptLabel`                 | the confirm button's text — 'Import', 'Attach', … |
| `parentWindow`                | override the owner window; inferred otherwise     |
| `signal`                      | an `AbortSignal` that closes the dialog           |
| `backend`                     | force a rung; the seam for a kiosk, and for tests |

Options given to the hook are defaults for every call; options given to a call
win.

### The dialog parents itself

The dialog is `transientFor` the window the component is in (`parent_window`
for the portal), so the window manager stacks it above your window and keeps
it out of the task switcher. **You do not pass anything for that**:
`useFileDialog()` resolves the owner window through `useTopLevelWindow()` when
the dialog opens.

On the [native Wayland backend](wayland-backend.md) the portal is handed an
**xdg-foreign** export of the window (`wayland:<handle>`), which GNOME and KDE
both parent to. Where the compositor has no xdg-foreign the dialog opens
unparented.

The owner is inferred from the top-level windows this connection is rendering:

- **one top-level window** — that one; nearly every app.
- several, one focused — the focused one.
- several with nothing to separate them — the most recently opened, plus a
  development warning naming `parentWindow`.
- **none at all** — the root-level `<popup>` that took the keyboard (a
  menu-bar app's popover,
  [elements.md](elements.md#a-popover-under-a-tray-item)).

`parentWindow` is the **override for multi-window apps**, and takes a
`<window>` ref, an XID, or anything `windowIdOf()` accepts:

```jsx
const win = useRef(null);
const { openFile } = useFileDialog({ parentWindow: win });
return <window ref={win}>…</window>;
```

`useTopLevelWindow()` is exported for anything else that needs the owner
window. It returns a **ref-like object** — the window is not realized on the
first render, so a value read then would be `null` on the render that matters —
which drops into `parentWindow`, `transientFor`, or `windowIdOf()`.

**The portal never embeds the dialog.** It is a top-level window in another
process; the file list never appears inside your window.

Design notes: [design/filedialog.md](../design/filedialog.md).

## The imperative functions

```ts
import { openFile, saveFile, selectFolder } from 'react-x11';
```

Same options, same results — but they can only reach the native panel, the
portal and `osascript`, because a function has nowhere to draw. Where there is
none of those they reject with `NoFileDialogError`, which is a **typed**
rejection: the signal to show your own UI, not a crash.

Reach for these from host-side code and event-loop glue that has no component
to hang off. In a component, use the hook.

## What differs between the rungs

- **MIME-type filters do not reach `osascript`.** `extensions` translate
  exactly to every rung; `mimeTypes` reach the portal and the native panel
  (the cocoa backend maps `image/png` to `public.png` through the OS type
  database) and are dropped by `osascript`, where a wrong UTI guess would hide
  the user's file. Give `extensions` where you can.
- **`osascript` ignores `parentWindow`; the native panel is a sheet on it.**
  The `osascript` panel appears over the app but is not attached to it;
  application modality holds only because your code is awaiting the promise.
  On the cocoa backend the panel is a **sheet**, and the app keeps running
  while it is up. With no window at all — a bare `openFile()` with nothing in
  `parentWindow` and no tree to infer one from — the native panel is
  app-modal and **blocks the process**, timers included, until it is
  dismissed. `useFileDialog()` always names the window, so it never lands
  there.
- **The built-in dialog has never seen the user's bookmarks.** It offers the
  filesystem, a filter, hidden files, and a path you can type into — not a
  re-creation of GTK's chooser.
- **`multiple` in the built-in dialog is a tick column**, not ctrl-click.

In the built-in dialog a double click opens a directory or picks a file, Enter
does the same to the selected row, `Up` goes to the parent, and Escape cancels.

## Running it where there is no bus

| where                                                  | rung                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| macOS, the **cocoa backend**                           | the native panel                                                                                                  |
| GNOME / KDE / any desktop with xdg-desktop-portal      | portal                                                                                                            |
| macOS + XQuartz, app running **on the Mac**            | `osascript`                                                                                                       |
| macOS + XQuartz, app running on a **remote Linux box** | built-in — `osascript` would run on the wrong machine, and the paths it returned would not exist where the app is |
| ssh, `startx`, a container, CI                         | built-in                                                                                                          |
| Node 20, where npm skips `dbus-native`                 | built-in on Linux, `osascript` on a Mac                                                                           |

The `osascript` rung is reached by _not_ finding a portal, so it also covers a
Mac that has a session bus for other reasons. A portal shim on a Mac wins on
the X11 backend; on the cocoa backend the native panel is above it either way.

## The portal machinery, if you need it directly

`portalRequest()` is exported for building other portals on. It calls a portal
method that shows UI and resolves with its `Request.Response`:

```js
const { response, results } = await portalRequest(busRef, {
  iface: 'org.freedesktop.portal.FileChooser',
  member: 'OpenFile',
  parentWindow: 'x11:1a00007',
  title: 'Open',
  options: { multiple: true },
});
```

It subscribes to the response before calling, so the answer cannot be lost;
an abort sends `Request.Close()` and settles the promise locally (the portal
emits no `Response` for it); and only the initial call has a deadline — the
answer has none, because a dialog can legitimately be open for an hour.

The default argument shape, `(s parent_window, s title, a{sv} options)`, is
FileChooser's alone. Any other Request-shaped portal states its leading
arguments as `signature` and `args` together; the
[eyedropper](eyedropper.md)'s `PickColor`, which has no title:

```js
await portalRequest(busRef, {
  iface: 'org.freedesktop.portal.Screenshot',
  member: 'PickColor',
  signature: 'sa{sv}',
  args: [parentWindow],
});
```

The signature must end in `a{sv}` (the options dict carries `handle_token`); a
method without one does not answer through a `Request` and wants a plain
`bus.invoke` instead.

`hasService(name)` answers whether a service is reachable — owned now **or
activatable on demand**. (`NameHasOwner` alone is the wrong question: the
portal is D-Bus-activatable and often has no owner until first use.)

`portalVersion(iface)` answers whether the portal's backends provide one
_interface_, and at what version — `0` when it is not there at all. Gate on
this rather than on the service: desktops provide some portals and not others
(XFCE has FileChooser and no Screenshot).

See [dbus.md](dbus.md) for the connection these sit on.

## Seeing it

- `npm run examples:menu` — a File menu whose Open/Save entries are real, with
  the rung this machine landed on shown in the window.
  Force the bottom rung anywhere with `backend: 'builtin'`, which is also how the
  tests exercise it.
