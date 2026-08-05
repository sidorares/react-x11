# File dialogs

Open a file, save a file, pick a folder — on whatever the machine has.

```jsx
import { useFileDialog } from 'react-x11';

function Toolbar({ windowRef }) {
  const { openFile } = useFileDialog({ parentWindow: windowRef });

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

There is no single answer to "show a file dialog" on a machine running X11, so
this is a ladder and the rung is chosen for you:

|     |                         |                                                                                                                                                                |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **the portal**          | `org.freedesktop.portal.FileChooser` over D-Bus. The desktop's own dialog, drawn by GTK or KDE in another process, with the user's bookmarks and recent files. |
| 2   | **`osascript`**         | macOS with no portal — which is every XQuartz install that has not gone out of its way. `choose file` _is_ `NSOpenPanel`.                                      |
| 3   | **the built-in dialog** | A browser react-x11 draws itself. ssh, a bare `startx`, a container: everywhere there is a display and nothing else.                                           |

`fileDialogBackend()` reports which one this machine lands on, without showing
anything — useful for a diagnostics panel, and for a menu that wants to say so.

**The ladder is the design, not a fallback chain bolted on.** react-x11's
flagship case is an app running on one machine and drawing to another, and a
file dialog that only worked on a full GNOME session would be useless to
exactly the person the renderer exists for.

## `useFileDialog()`

```ts
const { openFile, saveFile, selectFolder } = useFileDialog(defaults?);

openFile(options?): Promise<string[] | null>;    // absolute paths
saveFile(options?): Promise<string | null>;      // one path, may not exist yet
selectFolder(options?): Promise<string[] | null>;
```

The hook is the surface to reach for, because it is the only one with a tree to
draw in — so it never runs out of rungs and never rejects for lack of a dialog.

| option                        |                                                   |
| ----------------------------- | ------------------------------------------------- |
| `title`                       | the dialog's title                                |
| `multiple`                    | several files at once; ignored when saving        |
| `filters`                     | `{ name, extensions?, mimeTypes? }[]`             |
| `defaultFolder`               | where it opens                                    |
| `defaultName` / `defaultPath` | what a save dialog starts on                      |
| `acceptLabel`                 | the confirm button's text — 'Import', 'Attach', … |
| `parentWindow`                | a `<window>` ref or XID — see below               |
| `signal`                      | an `AbortSignal` that closes the dialog           |
| `backend`                     | force a rung; the seam for a kiosk, and for tests |

Options given to the hook are defaults for every call; options given to a call
win.

### `parentWindow` is worth the one line

```jsx
const win = useRef(null);
const { openFile } = useFileDialog({ parentWindow: win });
return <window ref={win}>…</window>;
```

It becomes `transientFor` on the built-in dialog and `parent_window` on the
portal, which is what makes the window manager treat the dialog as belonging to
your window — stacked above it, and not a second entry in the task switcher.
Without it the dialog floats: legal, and it looks careless.

**The portal never embeds the dialog.** It is a top-level window in another
process, and logical parenting is all there is. There is no version of this
where the file list appears inside your window.

## The imperative functions

```ts
import { openFile, saveFile, selectFolder } from 'react-x11';
```

Same options, same results — but they can only reach the portal and
`osascript`, because a function has nowhere to draw. Where there is neither
they reject with `NoFileDialogError`, which is a **typed** rejection: the
signal to show your own UI, not a crash.

Reach for these from host-side code and event-loop glue that has no component
to hang off. In a component, use the hook.

## What differs between the rungs

Most of the API is the same everywhere. These are the places it genuinely is
not, stated here rather than discovered:

- **MIME-type filters do not reach macOS.** `extensions` translate exactly to
  all three; `mimeTypes` reach the portal and are dropped by `osascript`,
  because AppleScript's `of type` wants extensions or UTIs and guessing a UTI
  wrong hides the user's file with no way to get at it. Give `extensions` where
  you can.
- **macOS ignores `parentWindow` entirely.** XQuartz windows are `NSWindow`s
  owned by X11.app, and macOS has no cross-process transient-for —
  `addChildWindow` is same-process only. The panel appears over the app but is
  not attached to it. Application modality still works, because your code is
  awaiting the promise.
- **The built-in dialog has never seen the user's bookmarks.** It offers the
  filesystem, a filter, hidden files, and a path you can type into. It is
  deliberately not a re-creation of GTK's chooser.
- **`multiple` in the built-in dialog is a tick column**, not ctrl-click.

## Running it where there is no bus

The interesting configurations, and what each one does:

| where                                                  | rung                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| GNOME / KDE / any desktop with xdg-desktop-portal      | portal                                                                                                            |
| macOS + XQuartz, app running **on the Mac**            | `osascript`                                                                                                       |
| macOS + XQuartz, app running on a **remote Linux box** | built-in — `osascript` would run on the wrong machine, and the paths it returned would not exist where the app is |
| ssh, `startx`, a container, CI                         | built-in                                                                                                          |
| Node 20, where npm skips `dbus-native`                 | built-in on Linux, `osascript` on a Mac                                                                           |

The macOS rung is reached by _not_ finding a portal, so it also covers a Mac
that has a session bus for other reasons. If you do run a portal shim on a Mac
(see [issue #111](https://github.com/sidorares/react-x11/issues/111)), it wins,
which is what you asked for by running it.

## The portal machinery, if you need it directly

`portalRequest()` is exported for building other portals on. Every portal
method that shows UI returns an object path immediately and answers later with
a `Request.Response` signal — and the path is predictable **by design**, so the
client subscribes _before_ it calls and cannot lose the answer:

```js
const { response, results } = await portalRequest(busRef, {
  iface: 'org.freedesktop.portal.Settings',
  member: 'ReadAll',
  parentWindow: 'x11:1a00007',
  options: {},
});
```

It owns the three things every portal caller otherwise re-solves: subscribing
first, `Request.Close()` on abort (which emits **no** `Response`, so the
promise has to be settled locally), and no timeout on the answer — a dialog can
legitimately be open for an hour, and only the initial call is deadlined.

`hasService(name)` answers whether a service is reachable — owned now **or
activatable on demand**. `NameHasOwner` alone is the wrong question:
`org.freedesktop.portal.Desktop` is D-Bus-activatable, so on a healthy desktop
where no app has touched a portal yet it has no owner, and a feature gated on
that takes the fallback path forever.

See [dbus.md](dbus.md) for the connection these sit on.

## Seeing it

- `npm run examples:menu` — a File menu whose Open/Save entries are real, with
  the rung this machine landed on shown in the window.
- `npm run examples:richtext` — "open a .md…" loads a real file into the
  `<markdown>` element.

Force the bottom rung anywhere with `backend: 'builtin'`, which is also how the
tests exercise it.
