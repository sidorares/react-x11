# Clipboard: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/clipboard.md](../docs/clipboard.md), the reference, and keep
their original headings so code comments that cite them still resolve.

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
> since nothing announces a copy. A [multi-flavour payload](../docs/clipboard.md#writing) is
> written whole when the bridge has `pasteboardWrite` (windowkit/appkit#119);
> an older bridge keeps the text and says once, in development, what it
> dropped.

## Two clipboards

Two consequences worth knowing, because neither matches a browser:

- **The data lives in this process.** Nothing is stored by the server, so
  when the app exits the clipboard goes with it — normal X behaviour, and
  the reason desktops run clipboard managers. Nothing negotiates with one
  yet.

### `PRIMARY` is X11-only

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

### Reading

The groups exist because the same payload arrives under different names
depending on who copied it, and exact-match filtering silently misses most
of the desktop:

| group     | matches                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| `'text'`  | `text/plain;charset=utf-8`, `UTF8_STRING`, `text/plain`, `STRING`, `TEXT`, `COMPOUND_TEXT` (in that order) |
| `'files'` | `text/uri-list`, `application/x-kde4-urilist`, `x-special/gnome-copied-files`                              |
| `'uris'`  | `text/uri-list`, `text/x-moz-url`, `_NETSCAPE_URL`                                                         |

This is the same table [drag and drop](../docs/drag-and-drop.md) uses, and
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

### Knowing when it changes

On the Cocoa backend nothing announces a copy, so `watch()` is a poll after
all: it asks the pasteboard's change count, which every write bumps, every
250 ms while anything is watching, and stops with the last unsubscribe. The
count is a published number on the bridge, under a microsecond to read, and
a change costs one look at what the pasteboard now holds, to say whether
`owner` is `0`. No window owns the pasteboard, so `owner` is `-1` when it
holds anything; `ev.changeCount` is the pasteboard's own count. Two copies
inside one poll are one change, and the app's own copies are changes too, as
they are on X11. It rejects on a bridge without `pasteboardChangeCount`.
