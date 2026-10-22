# Clipboard

```jsx
import { useClipboard } from 'react-x11';

function Editor({ value }) {
  const clipboard = useClipboard();
  return (
    <box
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === 'c') clipboard.writeText(value);
      }}
    />
  );
}
```

`<textinput>` and `<textarea>` already do all of this for you — Ctrl+C/X/V,
middle-click paste, select-to-own. This page is for everything else: a
canvas that copies an image, a list that pastes files, a document view with
its own Copy item.

> **On the Cocoa backend** the clipboard is `NSPasteboard.general`, and the
> difference from X11 is structural rather than cosmetic: X's model is
> _ownership of a selection_, negotiated per paste, and macOS's is a
> _pasteboard the system holds_. Everything below works there — writing,
> [reading](#reading) any type the pasteboard carries, `targets()` and
> [`watch()`](#knowing-when-it-changes) — with three differences, each
> described where it applies: [`PRIMARY`](#primary-is-x11-only) is X11-only
> rather than missing, since nothing on macOS is filled by selecting text;
> `targets()` names the pasteboard's types rather than an owner's atoms; and
> `watch()` asks the pasteboard's change count while something is watching,
> since nothing announces a copy. A [multi-flavour payload](#writing) is
> written whole when the bridge has `pasteboardWrite` (windowkit/appkit#119);
> an older bridge keeps the text and says once, in development, what it
> dropped.

## Two clipboards

X has no clipboard buffer. "Copy" means owning a **selection** — a named
thing the server tracks — and answering conversion requests from whoever
pastes. There are two in everyday use, and they are independent:

| selection   | filled by                                  | pasted with          |
| ----------- | ------------------------------------------ | -------------------- |
| `CLIPBOARD` | an explicit Copy or Cut                    | Ctrl+V, an Edit menu |
| `PRIMARY`   | _selecting text at all_, with no Copy step | middle click         |

Every call below takes `{ selection }` and defaults to `CLIPBOARD`. The
X11-native behaviour is to write `PRIMARY` whenever your selection changes,
which is what the built-in text controls do.

Two consequences worth knowing, because neither matches a browser:

- **The data lives in this process.** Nothing is stored by the server, so
  when the app exits the clipboard goes with it — normal X behaviour, and
  the reason desktops run clipboard managers. Nothing negotiates with one
  yet.
- **Someone else copying takes it away.** Ownership is exclusive; there is
  no "clipboard history" to fall back on.

### `PRIMARY` is X11-only

macOS has one pasteboard, and it is `CLIPBOARD`'s: nothing there is filled
by selecting text, and a middle click pastes nothing. So on the Cocoa
backend every selection but `CLIPBOARD` — `PRIMARY`, `SECONDARY`, a name of
your own — is one nobody can paste from:

- `write()` and `writeText()` resolve and leave the pasteboard alone;
- `read()` answers `null`, `readText()` rejects and `targets()` is `[]` —
  X's answers for a selection nobody owns;
- `clear()` leaves the pasteboard alone, and `watch()` never fires.

The **win32** backend answers every selection but `CLIPBOARD` the same way,
since Windows has no equivalent either (and writes only text there so far).
The **Wayland** backend is the other X-like one: it has `PRIMARY` too, over
the primary-selection protocol where the compositor offers it
(`src/wayland/clipboard.js`), so "X11-only" here means "not on macOS or
Windows".

That is what keeps selecting from being copying. A drag across a
`selectable` surface, a select-all, shift+arrows in a field: each takes
`PRIMARY` on X11, and on macOS none of them replaces what the user copied
somewhere else. Code written to the X11 convention needs no platform check.

`PRIMARY` is deliberately not kept inside the app instead. Its point is the
paste in _another_ application; all an in-process copy could keep is a
middle click that types into a text field, which no Mac text field does. An
app that wants select-to-copy on macOS anyway — a terminal emulator, say —
can write `CLIPBOARD` itself: a surface's `selectedText()` is the text, and
`onSelectionChange` says when it moved.

## `useClipboard()`

Returns the clipboard for the connection this tree renders onto. Stable, so
it is safe in a dependency array. Everything on it returns a promise.

### Writing

```js
await clipboard.writeText('hello');
await clipboard.write({
  'text/html': '<b>hello</b>',
  'text/plain': 'hello',
  'image/png': pngBytes,
});
```

`write()` takes a map of **type name to payload** — strings are encoded
UTF-8, `Buffer`s and typed arrays are served as they are. Offering several
flavours of the same thing is the point: a rich-text editor takes the HTML,
a terminal takes the plain text, and each asks for what it understands.
There is no size limit worth naming; large payloads transfer incrementally.

`clear()` gives the selection back, so nothing is served for it any more.

### Reading

```js
const text = await clipboard.read('text'); //  'hello'  | null
const files = await clipboard.readFiles(); //  [{ uri, path? }]
const png = await clipboard.read('image/png'); //  Uint8Array | null
const offered = await clipboard.targets(); //  ['text/html', …]
```

**`read(type)` is the one to reach for.** It accepts a concrete type name or
a **group**, resolves it against what the owner actually offers, and decodes
text-ish types to a string. It answers `null` when the owner has nothing of
that kind, because "is there an image on the clipboard?" is a question, not
an error.

The groups exist because the same payload arrives under different names
depending on who copied it, and exact-match filtering silently misses most
of the desktop:

| group     | matches                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| `'text'`  | `text/plain;charset=utf-8`, `UTF8_STRING`, `text/plain`, `STRING`, `TEXT`, `COMPOUND_TEXT` (in that order) |
| `'files'` | `text/uri-list`, `application/x-kde4-urilist`, `x-special/gnome-copied-files`                              |
| `'uris'`  | `text/uri-list`, `text/x-moz-url`, `_NETSCAPE_URL`                                                         |

This is the same table [drag and drop](drag-and-drop.md) uses, and
deliberately so: the flavours a file manager offers on a drop are the ones
it offers on a copy. Groups do not overlap — a Firefox link is
`text/x-moz-url`, which is in `uris`, not `text`.

On the Cocoa backend `targets()` lists the pasteboard's types in these
names: a type with a MIME type under that (`public.png` is `image/png`,
Finder's `public.file-url` is `text/uri-list`), text under both its X and
MIME names, and any other type under its own identifier. That last rule is
what lets an app honour a password manager: one that copies a secret puts
[`org.nspasteboard.ConcealedType`](http://nspasteboard.org) beside it, the
macOS convention for "keep this out of clipboard history", and a clipboard
history should skip any copy whose `targets()` include it (or
`org.nspasteboard.TransientType`). Files copied in Finder are one item each,
and `read('files')` reads them as one uri-list.

Text is read through the bridge's own text verb. Anything else is read from
the pasteboard's items: through `pasteboardItems`/`pasteboardItemData` on a
bridge that has them, and otherwise through `osascript -l JavaScript`, one
short-lived child of about 60 ms per `targets()` or `read()`. The type list
is kept against the pasteboard's change count, so asking again with nothing
copied in between costs nothing.

`readFiles()` is `read('files')` with the RFC 2483 parsing applied: CRLF
separators, `#` comment lines, percent-decoding. `path` is present only for
genuinely local `file:` URIs — a remote `file://otherhost/…` gets a `uri`
and no `path` rather than a path that does not exist here.

`readText()` is the plain-text shortcut and asks only for `UTF8_STRING` then
`STRING`. It **rejects** when there is no owner or the owner offers neither,
where `read('text')` returns `null` and walks the whole preference list. If
you are not sure which you want, use `read('text')`.

### Knowing when it changes

```js
useEffect(() => {
  let stop;
  clipboard
    .watch((ev) => setCanPaste(ev.owner !== 0))
    .then((fn) => (stop = fn));
  return () => stop?.();
}, [clipboard]);
```

The built-in edit menu on `<textinput>`/`<textarea>` already does this for
its Paste row — see [elements.md](elements.md#the-right-click-menu). This is
the same mechanism, for your own menus. If what you are building _is_ an edit
menu, open the standard one instead and the Paste row comes with it
([extending.md](extending.md#the-standard-edit-menu)).

`watch()` is a server-side subscription, not a poll — it costs nothing until
something changes. `owner === 0` means nothing is on the clipboard, which is
the case a Paste menu item wants. It rejects on a server without XFixes;
every X server since about 2004 has it.

On the Cocoa backend nothing announces a copy, so `watch()` is a poll after
all: it asks the pasteboard's change count, which every write bumps, every
250 ms while anything is watching, and stops with the last unsubscribe. The
count is a published number on the bridge, under a microsecond to read, and
a change costs one look at what the pasteboard now holds, to say whether
`owner` is `0`. No window owns the pasteboard, so `owner` is `-1` when it
holds anything; `ev.changeCount` is the pasteboard's own count. Two copies
inside one poll are one change, and the app's own copies are changes too, as
they are on X11. It rejects on a bridge without `pasteboardChangeCount`.

## Timestamps

X arbitrates between two clients copying at the same moment by **timestamp**,
and ICCCM is explicit that the right one is the event that caused the copy —
never "now". You do not have to pass one: react-x11 remembers the last input
event on the connection and uses it, so a copy from a Ctrl+C handler is
stamped with that keystroke. Pass `{ time }` if you have a better answer.

This is also why a `write()` can fail: if another client copied with a newer
timestamp, the server refuses ours, and the promise rejects rather than
pretending.

### Owning a selection of your own

The same rule governs every other selection — a system tray takes
`_NET_SYSTEM_TRAY_S<screen>`, a clipboard manager takes `CLIPBOARD_MANAGER`,
an input method takes `XIM_SERVERS` — and there the timestamp is yours to
supply. Both of the values worth supplying are exported:

```jsx
import { lastInputTime, serverTime, useApp } from 'react-x11';

const app = useApp();

// the user did something, and ICCCM wants that event's own time
const take = (wid, selection) =>
  app.X.SetSelectionOwner(wid, selection, lastInputTime(app));

// nothing did — a tray takes its selection when it starts
const claim = async (wid, selection) =>
  app.X.SetSelectionOwner(wid, selection, await serverTime(app));
```

`lastInputTime(app)` is free: it is the timestamp of the last input event
this connection saw, which is what react-x11 already stamps copies with, and
what EWMH calls `_NET_WM_USER_TIME`. It is `undefined` before any input has
arrived.

`serverTime(app)` is one round trip and always answers. Reach for it when
there is no user action to name — and **do not** write `lastInputTime(app) ??
0` instead. Zero is `CurrentTime`, which ICCCM 2.1 forbids for exactly the
reason above: the server accepts it, two clients racing for one selection
cannot be ordered by it, and the loser is never told it lost.

`serverTime` resolves `0` if the server has not answered within five seconds.
It never rejects and never hangs.

## Reaching ntk directly

`useClipboard()` is a thin layer over ntk's `app.clipboard` and adds only the
vocabulary, the timestamps and the React access. Anything it does not cover
is one step away:

```js
const app = useApp();
await app.clipboard.write(data, { selection: 'MY_SELECTION', time });
```

`app` is the whole ntk connection — `app.fonts`, `app.cursors`, `app.X` for
raw protocol. See ntk's own clipboard documentation for the ICCCM details.

## Limits

- **On the Cocoa backend `watch()` polls**, a quarter second behind a copy
  made elsewhere, and a read of anything but text spawns `osascript` until
  the bridge has `pasteboardItems`. `PRIMARY` is not a limit there but a
  platform difference: see [`PRIMARY` is X11-only](#primary-is-x11-only).
- **No clipboard-manager handoff** (`SAVE_TARGETS`), so the data really does
  vanish when the app exits.
- **`STRING` is latin-1 by definition**, so codepoints above U+00FF are lossy
  in that target. Modern requestors ask for `UTF8_STRING`, which is not — and
  a bare `writeText()` offers both.
- **No image decoding.** `read('image/png')` hands back the bytes; turning
  them into something drawable is yours.
