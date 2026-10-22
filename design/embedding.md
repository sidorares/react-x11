# Embedding other applications: `<foreign>`: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/embedding.md](../docs/embedding.md), the reference, and keep
their original headings so code comments that cite them still resolve.

When the other process is a module of **your own application**, don't wire
this up by hand: [`<Frame>`](../docs/frame.md) is `<foreign>` plus the process — the
fork, the props, the callbacks, the bridged theme, the crash fallback. This
page is the window half, and everything below about stacking, focus and
teardown holds for a `<Frame>` pane too. The pane's own root window opts in
with `<window embeddable>`: created **unmapped** — a window waiting to be
embedded is unmapped, that is what waiting looks like — and mapped by the
embedder once reparented. On X11 it is an XEmbed client for Tab: `FOCUS_IN`
with `FIRST` or `LAST` lands on its first or last stop, and Tab off an end of
its order sends `FOCUS_NEXT` or `FOCUS_PREV`, so Tab goes through a
react-x11 guest as it goes through any subtree of the host's.

The protocol underneath is [XEmbed](http://specifications.freedesktop.org/xembed/0.5/),
implemented in ntk (`XEmbedSocket`, ntk ≥ 7.4.0). This page is the React half:
what the element does, what it promises about a window it does not own, and
what it does with the keyboard.

## The window is not yours

Unmounting a `<foreign>` **reparents the client back to the root window and
drops it from the save set. It never destroys it.** A React tree changing
shape is not a reason for another application to lose its window, and the
first test in `test/foreign.test.js` is there to keep it that way.

What this costs is an ordering rule, and it is the one thing worth knowing
about the implementation: the reparent is issued **synchronously** during
teardown, because `WindowNode` destroys its own X window in the same turn and
`DestroyWindow` takes every inferior with it. The save set does not cover
that — X processes it when a _connection_ closes, not when a window is
destroyed.

### Letting go really means letting go

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

Everything else about focus is the ordinary focus manager:

| what happens                                 | what the client is told                                                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| the node takes focus by click or `focus()`   | `XEMBED_WINDOW_ACTIVATE`, then `XEMBED_FOCUS_IN` detail `CURRENT`                                                                            |
| Tab into it                                  | `FOCUS_IN` detail `FIRST` — focus your first widget                                                                                          |
| Shift+Tab into it                            | `FOCUS_IN` detail `LAST`                                                                                                                     |
| focus leaves, or the window deactivates      | `FOCUS_OUT`, then `WINDOW_DEACTIVATE`                                                                                                        |
| the client sends `XEMBED_REQUEST_FOCUS`      | the node is focused _through the focus manager_, so `:focus`, `:focus-within`, the previous node's `onBlur` and the AT-SPI bridge all see it |
| the client sends `FOCUS_NEXT` / `FOCUS_PREV` | focus moves to the next/previous react-x11 focusable — Tab crosses the boundary as if it were one application                                |

**Dead keys and Compose stay out of it.** react-x11's own composition
([events.md](../docs/events.md#composition)) does not run while a `<foreign>` holds
focus: the client is another program with an input method of its own, and an
accent composed on this side would swallow the `KeyPress` on its way there
and hand back a character with nowhere to put it. The raw key is forwarded
and the client composes it, which is also what makes `é` work in an embedded
terminal whatever the toolkit inside it is.

## Reparenting window managers

A `<foreign>` inside a toplevel that the window manager has reparented into a
frame is offset by that frame, and the root-relative coordinates in the
synthetic `ConfigureNotify` have to account for it. react-x11 tracks the
toplevel's screen origin from `ReparentNotify`/`ConfigureNotify` and asks the
server rather than trusting reported geometry — the same problem
`src/components/anchor.js` solves for popup placement.

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
