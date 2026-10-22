# Remote display

A react-x11 app **draws over the wire**. It does not render pixels and ship
them; it sends X11 drawing requests — rectangles, glyph runs, composites —
and the X server on the far end turns them into pixels. So running the app
somewhere else is not a feature bolted on top: it is what the protocol is,
and the program does not know the difference.

```sh
ssh -X buildbox
npm start          # the window opens on your desktop
```

Nothing in the app changes. No VNC, no browser, no streaming daemon, no port
to forward, no second copy of the UI.

**This is the X11 backend**, and it is the reason X11 stays the flagship
target: the Cocoa, win32 and Wayland backends have no wire at all, so
nothing on this page applies to them. That matters in one case — **an app
running on a Mac or on Windows and drawing somewhere else**. `$DISPLAY` in
the environment does not choose the backend there; `backend: 'auto'` sees
darwin and picks Cocoa, or win32 and picks the win32 backend, and the window
opens on the local machine. Say which you want:

```sh
REACT_X11_BACKEND=x11 DISPLAY=thin-client:0 npm start
```

`createRoot({ display: … })` or `createRoot({ stream: … })` also settle it —
naming an X endpoint in code _is_ choosing X11, because an ignored
connection option would be worse than either answer. An app running on Linux
and drawing to a Mac's XQuartz is not affected: both ends are X11 already.

## What it costs, measured

Bandwidth is small: **a whole window appears for about four kilobytes** of
requests, and scrolling a 500-row table ten notches costs 11 kB, because
only the damaged strip is redrawn — where a single frame of pixel streaming
(VNC, RDP) is tens to hundreds of kilobytes, sent again whenever anything
moves.

What react-x11 pays instead is **latency**. A request that waits for a
reply with nothing pipelined behind it stalls the connection for a full
round trip, so on a 60 ms link every such reply is 60 ms of nothing. That is
why atoms, geometry and glyph pages are cached rather than re-asked, and
why the column to watch on a slow link is `stalls`, not `replies`:
`npm run bench -- --hotspots` attributes them, request by request.

Rules of thumb, reasoned from the request and reply counts rather than
measured over a shaped link:

- **Under ~20 ms RTT** (a LAN, a nearby VPS): indistinguishable from local.
- **20–80 ms** (a continent away): typing and scrolling stay responsive;
  window mapping and font setup have a visible beat.
- **Above ~150 ms** or on a lossy link: X11's chattiness starts to show, and
  a pixel-streaming protocol designed for high latency will feel better.
  This is X11's limit, not react-x11's.

The per-scenario numbers are in the
[design notes](../design/remote.md#what-it-costs-measured).

## `ssh -X` and `ssh -Y`

`-X` runs your app as an **untrusted** X client. `-Y` runs it trusted, which
turns the restrictions off. They are not "the one that works" and "the one
that does not":

|                                    | `-X` (untrusted) | `-Y` (trusted) |
| ---------------------------------- | ---------------- | -------------- |
| read other windows' pixels         | no               | yes            |
| grab the keyboard, record input    | no               | yes            |
| take the clipboard from other apps | restricted       | yes            |
| your app's own windows             | fine             | fine           |

**Prefer `-X`.** react-x11 should work under it — it draws into windows it
created, which is what untrusted mode is for. If something does not, that is
a bug worth filing rather than a reason to reach for `-Y`, which hands every
program on the remote host the ability to read your screen and log your
keystrokes.

### The failure that looks like a crash

An untrusted `-X` cookie **expires**. OpenSSH's `ForwardX11Timeout` defaults
to 20 minutes; after that the connection is refused and your app dies
mid-session with a connection reset — no warning, no message that mentions
X11, and it happens long enough after startup that nobody connects the two.

```sh
# in ~/.ssh/config
Host buildbox
  ForwardX11 yes
  ForwardX11Trusted no
  ForwardX11Timeout 8h        # or 0 for no expiry
```

If a long-running app dies after roughly twenty minutes and
`onDisconnect(reason)` reports `'error'`, this is the first thing to check.
react-x11 tells you it happened, and nothing more —
[a reconnect is not a reconnect](README.md):
every window id, pixmap, glyph set and font died with the connection.

## `DISPLAY=host:0` — and why not

The other way to reach a remote display is to point `DISPLAY` straight at it
and open port 6000. Do not:

- The connection is **plaintext**. Every keystroke, every glyph you draw and
  the authentication cookie itself cross the network in the clear.
- Making it work usually means `xhost +`, which turns off access control for
  _everyone_, or `xhost +host`, which trusts every user on that host.
- Most X servers ship with TCP listening disabled now, so it takes
  deliberate work to open the hole.

`ssh -X` gives you the same thing, encrypted, authenticated per-session, and
with no listening port. Use it. If you genuinely need a raw display
connection — a lab network, a kiosk — carry the cookie explicitly with
`xauth` and never with `xhost` (see [security.md](security.md)).

## The other X servers

"An X server" is broader than "a Linux desktop":

| where                         | what runs                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux desktop                 | X.Org, or **Xwayland** — see below                                                                                                           |
| macOS                         | [XQuartz](https://www.xquartz.org). `ssh -X` from Terminal starts it for you                                                                 |
| Windows                       | VcXsrv, Xming, or an X server inside WSLg                                                                                                    |
| headless CI                   | `Xvfb :99 -screen 0 1280x800x24`                                                                                                             |
| a disposable screen           | `Xephyr :10 -screen 1200x800` — a window on your desktop that _is_ a display. What the [window-manager example](../examples/README.md) needs |
| a session you can reattach to | `Xvnc` / TigerVNC, or **Xpra**, which is X11-native and can detach and reattach a running app                                                |
| no display at all             | node-x11's in-process server — [testing.md](testing.md)                                                                                      |

**Xwayland: yes.** On a Wayland desktop, X11 clients run under Xwayland, and
react-x11 is an ordinary X11 client there. Everything in this documentation
applies. Some window-manager interactions are thinner (Xwayland brokers what
the compositor is willing to expose), and `WM_TRANSIENT_FOR` and the
`_NET_WM_STATE` work are among the things that survive the trip — see
[elements.md](elements.md#transientfor--a-window-that-belongs-to-another).

**Native Wayland: not remotely.** Wayland has no drawing protocol: a client
renders pixels into a buffer itself and hands the compositor a handle, so
there is no drawing to send over a wire. The
[Wayland backend](wayland-backend.md) rasterizes locally, which is why it is
opt-in and never what `'auto'` picks: on Linux the default stays X11, and
with it everything on this page.

**XQuartz notes**, since it is the most common macOS path:

- The window manager is quartz-wm, which has the thinnest EWMH support in
  the stack. It does not advertise `_NET_WM_STATE_ABOVE`, so `alwaysOnTop`
  falls back to Apple-WM window levels ([elements.md](elements.md)).
- Put `/opt/X11/bin` first on `PATH`. Font family resolution shells out to
  `fc-match`, and Homebrew's fontconfig — which is usually found first —
  ships no macOS system-font aliases, so `sans-serif` resolves to a CJK
  face.

## Making it feel better

Everything the renderer does to be cheap locally pays double here, because
each saved request is a saved trip across the link:

- Keep repaints **bounded**. `REACT_X11_DEBUG_PAINT=full` warns, with a
  reason and a stack, on any silent full-window repaint —
  [debugging.md](debugging.md). A full repaint is the difference between
  4 kB and 40 on every frame.
- `REACT_X11_TRACE=summary` prints the request and byte counts for a live
  app, so you can see what a given interaction actually costs on the wire
  before blaming the link.
- `ssh -C` compresses. X11 traffic is highly compressible — repeated
  drawing requests, text, glyph data — and on a slow link it is usually
  worth it.
- Prefer one long-lived connection to many short ones: connection setup is
  several round trips of its own, plus the font and atom warm-up.
- **Drags across applications are round-trip heavy**, because finding the
  foreign window under the pointer means asking the server, per pointer
  position. Dragging _within_ the app costs nothing extra — it never
  touches the wire — and a drop target that answers with `e.freeze()` stops
  the source asking while the pointer stays inside it. See
  [drag-and-drop.md](drag-and-drop.md).
