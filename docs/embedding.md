# Embedding other applications: `<foreign>`

Everything else react-x11 draws, it draws itself. `<foreign>` is the one
element that shows somebody else's pixels: another process's top-level X
window, reparented into yours and laid out like any other child.

```jsx
<foreign
  windowId={terminal.windowId}
  style={{ flexGrow: 1, backgroundColor: '#101014' }}
  onEmbedded={({ xembed }) => setMode(xembed ? 'xembed' : 'reparented')}
  onClientGone={() => respawn()}
/>
```

That is a terminal pane, a video surface, a docked tray icon and a
control-panel applet — four things an application cannot draw for itself and
has no business reimplementing.

The protocol underneath is [XEmbed](http://specifications.freedesktop.org/xembed/0.5/),
implemented in ntk (`XEmbedSocket`, ntk ≥ 7.4.0). This page is the React half:
what the element does, what it promises about a window it does not own, and
what it does with the keyboard.

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
reparenting. A missing property is not an error and not a fallback: it is the
ordinary case, and it is what makes a terminal pane work at all. `onEmbedded`
reports which happened:

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
shape is not a reason for another application to lose its window, and the
first test in `test/foreign.test.js` is there to keep it that way.

The same holds for `windowId` changing: the client that is leaving is handed
back before the new one is taken.

What this costs is an ordering rule, and it is the one thing worth knowing
about the implementation: the reparent is issued **synchronously** during
teardown, because `WindowNode` destroys its own X window in the same turn and
`DestroyWindow` takes every inferior with it. The save set does not cover
that — X processes it when a _connection_ closes, not when a window is
destroyed.

`onClientGone` fires when the client is destroyed by its own process, or
reparented away by someone else. Nothing further is sent to a dead id.

### Letting go really means letting go

A released client is a top-level window again, and **a running window manager
will manage it** — frame it, put it in the taskbar, place it wherever its
policy says. That is the right outcome for an unmount (`examples/foreign.jsx`
is built on it: detach the pane and the terminal is simply a terminal window
on the desktop), and it is a trap for one thing:

> **Do not hand a client from one `<foreign>` to another by unmounting the
> first and mounting the second with the same `windowId`.**

The window is parked at the root for the moment in between, which is long
enough to be offered to the window manager. The WM's `ReparentWindow` into a
frame of its own then arrives _after_ the second pane has taken the client,
undoes it, and the second pane reports `onClientGone` — for a client that is
alive and now framed on the desktop. It is a race with another process, so it
does not always happen, which is worse than if it always did.

Change `windowId` on **one** node instead. That path releases and re-embeds
in order and is tested; the client is only ever at the root while nothing
else wants it. (Re-embedding a window the WM has already framed also works —
the reparent pulls it out and the WM unmanages it — the hazard is only the
moment right after a release.)

## Layout and stacking

The rect comes from yoga like any other child, and every change moves the
client and sends it the synthetic ICCCM 4.1.5 `ConfigureNotify` — root-relative
coordinates, which is the question a client actually asks and which its own
`ConfigureNotify` (relative to the container it now sits in) cannot answer.

Two consequences of it being a real X window, both shared with
[`<glarea>`](elements.md#glarea):

- **Nothing drawn can overlap it.** A child X window is stacked above
  everything painted in its parent. An overlay — a HUD, a "reconnecting…"
  banner — belongs in a sibling `<popup>`. `<foreign>` takes no children and
  says so rather than laying out something that could never be seen.
- **Pointer events over it are the client's.** They never reach react-x11's
  hit testing, which is exactly right for a terminal or a video surface.

`backgroundColor` in the `style` is what shows in the rect before a client
arrives and after one leaves — it is the container window's background, painted
by the server. There is no separate prop for it, so the name is the one used
everywhere else.

## Focus, and who gets the keys

X gives the input focus to one window. XEmbed's answer is that the embedder
holds the real focus and gives the client a _logical_ one by message, and the
classic implementation of that is a **focus proxy**: an invisible InputOnly
window that takes the X focus and forwards keystrokes into the client with
`SendEvent`.

**react-x11 does not use a proxy**, and the reason matters if you are reading
the code expecting one:

- A proxy inside our own toplevel means the toplevel sees `FocusOut` the moment
  the client is focused. react-x11 reads that as the window losing focus —
  carets stop blinking, `<window onBlur>` fires — and the element would be told
  to blur the client it had just focused.
- A key that reaches a proxy has already gone past every handler in the React
  tree, so an application chord could never be checked first.

So the X focus stays on your window, and the rule is:

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

Everything else about focus is the ordinary focus manager:

| what happens                                 | what the client is told                                                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| the node takes focus by click or `focus()`   | `XEMBED_WINDOW_ACTIVATE`, then `XEMBED_FOCUS_IN` detail `CURRENT`                                                                            |
| Tab into it                                  | `FOCUS_IN` detail `FIRST` — focus your first widget                                                                                          |
| Shift+Tab into it                            | `FOCUS_IN` detail `LAST`                                                                                                                     |
| focus leaves, or the window deactivates      | `FOCUS_OUT`, then `WINDOW_DEACTIVATE`                                                                                                        |
| the client sends `XEMBED_REQUEST_FOCUS`      | the node is focused _through the focus manager_, so `:focus`, `:focus-within`, the previous node's `onBlur` and the AT-SPI bridge all see it |
| the client sends `FOCUS_NEXT` / `FOCUS_PREV` | focus moves to the next/previous react-x11 focusable — Tab crosses the boundary as if it were one application                                |

A `<foreign>` is focusable by default, like a `<textinput>`. `focusable={false}`
opts out, which is what a video surface wants.

Tab is _forwarded_ rather than acted on: an XEmbed client has a tab chain of its
own and says so with `FOCUS_NEXT` when it runs off the end of it. A client that
speaks no XEmbed — a terminal — keeps Tab for good, which is what a terminal is
for; click elsewhere to leave.

**Dead keys and Compose stay out of it.** react-x11's own composition
([events.md](events.md#composition)) does not run while a `<foreign>` holds
focus: the client is another program with an input method of its own, and an
accent composed on this side would swallow the `KeyPress` on its way there
and hand back a character with nowhere to put it. The raw key is forwarded
and the client composes it, which is also what makes `é` work in an embedded
terminal whatever the toolkit inside it is.

### The one gap

X delivers a key to the deepest descendant of the focus window that contains the
pointer. So while the pointer is _over_ the embedded client, the client receives
keys directly and no handler of yours runs — application chords do not work
there. They work everywhere else in the window, which is the trade a focus proxy
would make in the other direction.

## Reparenting window managers

A `<foreign>` inside a toplevel that the window manager has reparented into a
frame is offset by that frame, and the root-relative coordinates in the
synthetic `ConfigureNotify` have to account for it. react-x11 tracks the
toplevel's screen origin from `ReparentNotify`/`ConfigureNotify` and asks the
server rather than trusting reported geometry — the same problem
`src/components/anchor.js` solves for popup placement.

## Props

| prop             |                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `windowId`       | the X window to embed. Changing it hands the old client back first. Omit it to adopt whatever is put inside the node instead. |
| `onReady`        | `({ windowId })` — the node's own container id, offered before anything is embedded, to spawn a program into                  |
| `onEmbedded`     | `({ id, xembed, version })` — a client is in                                                                                  |
| `onClientGone`   | destroyed, or reparented away by someone else                                                                                 |
| `onRequestFocus` | the client asked for the focus (it is then given through the focus manager)                                                   |
| `onError`        | the embed failed — no such window, or it went away mid-handshake. Without a handler, a console warning.                       |
| `focusable`      | default `true`; takes part in the focus manager and the tab chain                                                             |
| `style`          | layout as usual; `backgroundColor` is what shows with no client in                                                            |

## Example

`examples/foreign.jsx` spawns a program into a pane and then lets go of it,
which is the whole element in one click: the pane disappears and the terminal
is still there, framed by the window manager, as if it had started on its own.

```sh
npm run examples:foreign            # xterm, if you have it
FOREIGN_CMD="mpv --wid=%WID% video.mp4" npm run examples:foreign
```

## What is not here yet

- **`<TrayHost>`** — owning the `_NET_SYSTEM_TRAY_S<screen>` manager selection
  and rendering a `<foreign>` per docked icon, which is what makes a react-x11
  panel a real desktop shell. The system tray is XEmbed's biggest surviving
  consumer.
- **The plug side** — a react-x11 root that renders _into_ someone else's
  socket, for shipping as a tray icon or a panel applet. Lower value and
  deliberately last: GTK4 removed `GtkPlug` and Qt dropped `QX11Embed*` after
  Qt4, so the population of hosts willing to embed us is shrinking while the
  population of clients we can host is not.

Both are tracked in [issue #269](https://github.com/sidorares/react-x11/issues/269).
