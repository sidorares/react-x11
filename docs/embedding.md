# Embedding other applications: `<foreign>`

> **X11 only.** macOS offers no primitive for taking another application's
> window into your own. On the Cocoa backend `<foreign>` lays out as an empty
> box, never calls `onReady`, and calls `onError` once;
> `useSupports('embedding')` is false there, so a component can ask before
> rendering one. [`<Frame>`](frame.md) does work there: it embeds a pane of
> _your own_ application through shared surfaces instead of reparenting.

`<foreign>` is the one element that shows somebody else's pixels: another
process's top-level X window, reparented into yours and laid out like any
other child — a terminal pane, a video surface, a docked tray icon, a
control-panel applet.

```jsx
<foreign
  windowId={terminal.windowId}
  style={{ flexGrow: 1, backgroundColor: '#101014' }}
  onEmbedded={({ xembed }) => setMode(xembed ? 'xembed' : 'reparented')}
  onClientGone={() => respawn()}
/>
```

For a module of **your own application**, use [`<Frame>`](frame.md):
`<foreign>` plus the process — the fork, the props, the callbacks, the bridged
theme, the crash fallback. Everything below about stacking, focus and teardown
holds for a `<Frame>` pane too. The pane's root window opts in with
`<window embeddable>`: created **unmapped**, which is what waiting to be
embedded looks like, and mapped by the embedder once reparented. On X11 it
speaks XEmbed's Tab, so Tab goes through a react-x11 guest as through any
subtree of the host's.

**Being the guest yourself** — a react-x11 app embedded in somebody else's UI
— is that same prop plus `windowHandleOf(ref)` (or `useWindowHandle(ref)`):
the number you hand the host, out of band, the way `xterm -into` is handed
one. On X11 it is the window's XID, which the host reparents. On Windows it is
a composition surface handle the host binds to a visual of its own, because a
window there stops presenting the moment it becomes a child
([design notes](../design/windows-embedding.md)). `null` means this backend
has no way to be a guest — the capability, not a failure.

The protocol underneath is
[XEmbed](http://specifications.freedesktop.org/xembed/0.5/). Design notes:
[design/embedding.md](../design/embedding.md).

## Two ways in

**You have a window id.** Pass it as `windowId`. The client is added to the
save set, reparented into the node's own X window, sized to the node's rect
and told where it is.

**You are about to start the program.** Then there is no id yet — a program
like `xterm -into WID` or `mpv --wid=WID` has to be _given_ a window before it
makes one. Leave `windowId` out, and the node adopts whatever turns up inside
it; `onReady` hands you the id to spawn into:

```jsx
<foreign
  style={{ flexGrow: 1 }}
  onReady={({ windowId }) => spawn('xterm', ['-into', String(windowId)])}
  onClientGone={() => close(paneId)}
/>
```

`onReady` fires as soon as the node has an X window, which is before anything
is in it — that is the point.

## Most clients do not speak XEmbed

`xterm -into`, `mpv --wid`, VLC and Wine set no `_XEMBED_INFO` and want plain
reparenting. That is the ordinary case, not an error or a fallback, and it is
what makes a terminal pane work at all. `onEmbedded` reports which happened:

```jsx
onEmbedded={({ id, xembed, version }) => { … }}
```

`xembed: false` means plain reparenting — the client was mapped immediately
and no `_XEMBED` messages will pass. `xembed: true` means the client answered,
`version` is the protocol version both sides settled on, and from then on the
client is mapped and unmapped as its own `XEMBED_MAPPED` bit asks.

## The window is not yours

Unmounting a `<foreign>` **reparents the client back to the root window and
drops it from the save set. It never destroys it.** A React tree changing
shape is not a reason for another application to lose its window.

The same holds for `windowId` changing: the client that is leaving is handed
back before the new one is taken.

`onClientGone` fires when the client is destroyed by its own process, or
reparented away by someone else. Nothing further is sent to a dead id.

### Letting go really means letting go

A released client is a top-level window again, and **a running window manager
will manage it** — frame it, put it in the taskbar, place it wherever its
policy says. That is right for an unmount (`examples/foreign.jsx` is built on
it: detach the pane and the terminal is simply a terminal window on the
desktop), and a trap for one thing:

> **Do not hand a client from one `<foreign>` to another by unmounting the
> first and mounting the second with the same `windowId`.**

In between, the window is parked at the root long enough to be offered to the
window manager, whose reparent into a frame can arrive _after_ the second pane
has taken the client and undo it; the second pane then reports `onClientGone`
for a client that is alive and framed on the desktop. It is a race with
another process, so it does not always happen.

Change `windowId` on **one** node instead: that path releases and re-embeds in
order. Re-embedding a window the WM has already framed also works — the
hazard is only the moment right after a release.

## Layout and stacking

The rect comes from yoga like any other child, and every change moves the
client and tells it its root-relative position (the synthetic ICCCM
`ConfigureNotify`).

Two consequences of it being a real X window, both shared with
[`<glarea>`](elements.md#glarea):

- **Nothing drawn can overlap it.** A child X window is stacked above
  everything painted in its parent. An overlay — a HUD, a "reconnecting…"
  banner — belongs in a sibling `<popup>`. `<foreign>` takes no children and
  says so rather than laying out something that could never be seen.
- **Pointer events over it are the client's.** They never reach react-x11's
  hit testing, which is exactly right for a terminal or a video surface.

`backgroundColor` in the `style` is what shows in the rect before a client
arrives and after one leaves — the container window's background, painted by
the server. There is no separate prop for it.

## Focus, and who gets the keys

X gives the input focus to one window. react-x11 keeps the X focus on your
window and gives the client a _logical_ focus by XEmbed message — no focus
proxy, which would make your window read the client's focus as its own blur
and let keys past every handler in the React tree. So the rule is:

> While a `<foreign>` holds focus, the application's handlers see every key
> first. Anything they do not consume is forwarded to the client.

`preventDefault()` is how they consume it — the same word, and the same
ordering, that lets a `<textinput>` keep Tab as an indent key:

```jsx
<window
  onKeyDown={(ev) => {
    if (ev.ctrlKey && ev.keysym === XK_t) {
      ev.preventDefault(); // the app's chord; the terminal never sees it
      newTab();
    }
  }}
>
  <foreign windowId={id} style={{ flexGrow: 1 }} />
</window>
```

**A menu accelerator is not a handler**, and this is the one place that shows.
[Accelerators](events.md#accelerators) run _after_ the focused element's own
default action, and `<foreign>`'s is to forward the key and consume it — so
while an embedded terminal has focus its Ctrl+C is the terminal's, not the
Edit menu's, which is what a user of that terminal expects. An application
chord that must win everywhere goes in an `onKeyDown` like the one above,
which is checked before either.

Everything else about focus is the ordinary focus manager. Clicking or
`focus()`-ing the node activates the client and focuses it; Tab and Shift+Tab
into it focus its first or last widget; focus leaving, or the window
deactivating, unfocuses and deactivates it. A client asking for the focus
(`onRequestFocus`) is focused _through the focus manager_, so `:focus`,
`:focus-within`, the previous node's `onBlur` and the AT-SPI bridge all see
it. The XEmbed message behind each step is in the
[design notes](../design/embedding.md#focus-and-who-gets-the-keys).

A `<foreign>` is focusable by default, like a `<textinput>`. `focusable={false}`
opts out, which is what a video surface wants.

Tab is _forwarded_ rather than acted on. An XEmbed client has a tab chain of
its own, and running off either end of it moves focus to the next or previous
react-x11 focusable — Tab crosses the boundary as if it were one application.
A client that speaks no XEmbed — a terminal — keeps Tab for good, which is
what a terminal is for; click elsewhere to leave.

**Dead keys and Compose stay out of it.** react-x11's own composition
([events.md](events.md#composition)) does not run while a `<foreign>` holds
focus: the client has an input method of its own, and an accent composed on
this side would swallow the key on its way there. The raw key is forwarded and
the client composes it, which is what makes `é` work in an embedded terminal
whatever the toolkit inside it is.

### The one gap

X delivers a key to the deepest descendant of the focus window that contains the
pointer. So while the pointer is _over_ the embedded client, the client receives
keys directly and no handler of yours runs — application chords do not work
there. They work everywhere else in the window, which is the trade a focus proxy
would make in the other direction.

## Reparenting window managers

A `<foreign>` inside a toplevel that the window manager has reparented into a
frame is offset by that frame. react-x11 tracks the toplevel's screen origin
and tells the client its true root-relative position; nothing is needed from
the app.

## Props

| prop             |                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `windowId`       | the X window to embed; a change hands the old client back first. Omit to adopt whatever is put inside the node |
| `onReady`        | `({ windowId })` — the node's own container id, before anything is embedded, to spawn a program into           |
| `onEmbedded`     | `({ id, xembed, version })` — a client is in                                                                   |
| `onClientGone`   | destroyed, or reparented away by someone else                                                                  |
| `onRequestFocus` | the client asked for the focus (then given through the focus manager)                                          |
| `onError`        | the embed failed — no such window, or it went away mid-handshake; without a handler, a console warning         |
| `focusable`      | default `true`; takes part in the focus manager and the tab chain                                              |
| `style`          | layout as usual; `backgroundColor` shows with no client in                                                     |

## Example

`examples/foreign.jsx` spawns a program into a pane and then lets go of it,
which is the whole element in one click: the pane disappears and the terminal
is still there, framed by the window manager, as if it had started on its own.

```sh
npm run examples:foreign            # xterm, if you have it
FOREIGN_CMD="mpv --wid=%WID% video.mp4" npm run examples:foreign
```

## What is not here yet

- **`<TrayHost>`** — hosting other applications' tray icons (owning the
  system tray selection, a `<foreign>` per docked icon).
- **The plug side** — a react-x11 root that renders _into_ someone else's
  XEmbed socket, as a tray icon or a panel applet.
