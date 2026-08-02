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
the same mechanism, for your own menus.

`watch()` is a server-side subscription, not a poll — it costs nothing until
something changes. `owner === 0` means nothing is on the clipboard, which is
the case a Paste menu item wants. It rejects on a server without XFixes;
every X server since about 2004 has it.

## Timestamps

X arbitrates between two clients copying at the same moment by **timestamp**,
and ICCCM is explicit that the right one is the event that caused the copy —
never "now". You do not have to pass one: react-x11 remembers the last input
event on the connection and uses it, so a copy from a Ctrl+C handler is
stamped with that keystroke. Pass `{ time }` if you have a better answer.

This is also why a `write()` can fail: if another client copied with a newer
timestamp, the server refuses ours, and the promise rejects rather than
pretending.

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

- **No clipboard-manager handoff** (`SAVE_TARGETS`), so the data really does
  vanish when the app exits.
- **`STRING` is latin-1 by definition**, so codepoints above U+00FF are lossy
  in that target. Modern requestors ask for `UTF8_STRING`, which is not — and
  a bare `writeText()` offers both.
- **No image decoding.** `read('image/png')` hands back the bytes; turning
  them into something drawable is yours.
