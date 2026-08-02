# Remote display

This is the case the architecture is categorically better at, and the one
nothing else on the page has told you about.

A react-x11 app **draws over the wire**. It does not render pixels and ship
them; it sends X11 drawing requests — rectangles, glyph runs, composites —
and the X server on the far end turns them into pixels. So "running the app
somewhere else" is not a feature bolted on top. It is what the protocol is,
and the program does not know the difference.

```sh
ssh -X buildbox
npm start          # the window opens on your desktop
```

Nothing in the app changes. No VNC, no browser, no streaming daemon, no port
to forward, no second copy of the UI.

## What it costs, measured

The honest comparison is with pixel streaming (VNC, RDP, a
`--remote-debugging` browser), because that is what people reach for
instead. The trade is bytes-per-frame against round-trips-per-interaction.

From `scripts/bench/baseline.json`, which measures against node-x11's
in-process server — so these are exact protocol costs, not estimates:

| scenario                           | requests | bytes out | replies |
| ---------------------------------- | -------- | --------- | ------- |
| mount: a window, 40 boxes + labels | 89       | 3.7 kB    | 4       |
| 50 filled rounded boxes            | 175      | 15 kB     | 1       |
| a paragraph of text                | 32       | 5.9 kB    | 1       |
| 10 wheel notches over 500 rows     | 437      | 17.7 kB   | 22      |

**A whole window appears for under four kilobytes.** A single 1280×800 frame
of VNC, even well compressed, is tens to hundreds of kilobytes, and it is
sent again every time anything moves. Scrolling a 500-row table ten notches
costs 17 kB here because only the damaged strip is redrawn (the
[scroll-blit path](../AGENTS.md), issue #138); the same scroll under pixel
streaming is ten full frames.

What react-x11 pays instead is **latency sensitivity**. Bandwidth is not the
scarce resource on a link like this — round trips are. A request that waits
for a reply stalls the pipeline for a full RTT, so on a 60 ms link every
reply is 60 ms of nothing. That is why "avoid round trips" is rule 4 in
[AGENTS.md](../AGENTS.md#protocol-efficiency), why atoms, geometry and glyph
pages are cached rather than re-asked, and why the `replies` column above is
the one to watch: the mount costs 4, and a whole scroll gesture costs 22.

Rules of thumb, from the shape of the protocol rather than from a benchmark
we have not run:

- **Under ~20 ms RTT** (a LAN, a nearby VPS): indistinguishable from local.
- **20–80 ms** (a continent away): typing and scrolling stay responsive;
  window mapping and font setup have a visible beat.
- **Above ~150 ms** or on a lossy link: X11's chattiness starts to show, and
  a pixel-streaming protocol designed for high latency will feel better.
  This is not a react-x11 limitation, it is X11's, and it is the honest place
  to say so.

`unverified:` those bands are reasoning from the request/reply counts above,
not measurements over a shaped link. Measuring them properly means `tc
netem` between two hosts; if you do it, the numbers belong in this table.

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
a bug worth filing rather than a reason to reach for `-Y`. Most toolkits'
documentation says "use `-Y` if `-X` misbehaves"; that advice hands every
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

**Native Wayland: no**, and the reason is not effort. Wayland has no drawing
protocol. A Wayland client allocates a buffer, renders pixels into it
_itself_, and hands the compositor a handle — there is nothing to send over a
wire, and no server-side rendering to ask for. The entire premise of this
renderer, that drawing crosses the connection, does not exist there. A
Wayland port would not be a port; it would be a different program that
rasterizes locally, and at that point the interesting property is gone.

**XQuartz notes**, since it is the most common macOS path:

- The window manager is quartz-wm, which has the thinnest EWMH support in
  the stack. It does not advertise `_NET_WM_STATE_ABOVE`, so `alwaysOnTop`
  falls back to Apple-WM window levels ([elements.md](elements.md)).
- Put `/opt/X11/bin` first on `PATH`. Font family resolution shells out to
  `fc-match`, and Homebrew's fontconfig — which is usually found first —
  ships no macOS system-font aliases, so `sans-serif` resolves to a CJK
  face. Issue [#86](https://github.com/sidorares/react-x11/issues/86).

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
