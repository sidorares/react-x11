# Remote display: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/remote.md](../docs/remote.md), the reference, and keep
their original headings so code comments that cite them still resolve.

Where a heading is also in the reference, what is here is the original text
of the paragraphs the reference tightened: the mechanism, history and
rationale behind the behaviour it describes.

## What it costs, measured

The honest comparison is with pixel streaming (VNC, RDP, a
`--remote-debugging` browser), because that is what people reach for
instead. The trade is bytes-per-frame against round-trips-per-interaction.

From `scripts/bench/baseline.json`, which measures against node-x11's
in-process server — so these are exact protocol costs, not estimates:

| scenario                           | requests | bytes out | replies | stalls |
| ---------------------------------- | -------- | --------- | ------- | ------ |
| mount: a window, 40 boxes + labels | 110      | 4.2 kB    | 32      | 0      |
| 50 filled rounded boxes            | 122      | 6.6 kB    | 7       | 0      |
| a paragraph of text                | 39       | 6.0 kB    | 7       | 0      |
| 10 wheel notches over 500 rows     | 224      | 11.2 kB   | 22      | 4      |
| 5 drag steps of a card of widgets  | 72       | 4.3 kB    | 11      | 0      |

**A whole window appears for about four kilobytes.** A single 1280×800 frame
of VNC, even well compressed, is tens to hundreds of kilobytes, and it is
sent again every time anything moves. Scrolling a 500-row table ten notches
costs 11 kB here because only the damaged strip is redrawn (the
[scroll-blit path](../AGENTS.md), issue #138); the same scroll under pixel
streaming is ten full frames. Dragging a card with a background of its own
is the same trade: each step copies the card where it went and draws the
strip it uncovered, so its widgets are not drawn again
([extending.md](../docs/extending.md#an-element-that-covers-its-box), issue #681) —
the five steps in the table would be 24 kB drawn.

What react-x11 pays instead is **latency sensitivity**. Bandwidth is not the
scarce resource on a link like this — round trips are. A request that waits
for a reply stalls the pipeline for a full RTT, so on a 60 ms link every
reply is 60 ms of nothing.

The last two columns are how that is watched, and the difference between
them is the whole point. `replies` counts requests that carry an answer;
`stalls` counts the ones whose reply arrived with **nothing pipelined behind
them** — the request was the last thing sent, so the connection really did
sit idle for a round trip. A pipelined reply costs a reply and no time: the
mount's 32 are almost all `InternAtom`, fired off together while the window
is built, and it stalls on none of them. (The bench's own `settle()` fences
are a fixed floor in that column, so read growth rather than the absolute
number.)

So the rule — "avoid round trips", rule 4 in
[AGENTS.md](../AGENTS.md#protocol-efficiency) — is really "avoid _blocking_
round trips", which is why atoms, geometry and glyph pages are cached rather
than re-asked, and why `stalls` is the column to watch on a slow link.
`npm run bench -- --hotspots` attributes them, request by request.

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

**Prefer `-X`.** react-x11 should work under it — it draws into windows it
created, which is what untrusted mode is for. If something does not, that is
a bug worth filing rather than a reason to reach for `-Y`. Most toolkits'
documentation says "use `-Y` if `-X` misbehaves"; that advice hands every
program on the remote host the ability to read your screen and log your
keystrokes.

## The other X servers

**Native Wayland: not remotely**, and the reason is not effort. Wayland has
no drawing protocol. A Wayland client allocates a buffer, renders pixels into
it _itself_, and hands the compositor a handle — there is nothing to send over
a wire, and no server-side rendering to ask for. The entire premise of this
page, that drawing crosses the connection, does not exist there. The Wayland
backend (`backend: 'wayland'`, [wayland-backend.md](../docs/wayland-backend.md)) is
therefore a different program under the same API — it rasterizes locally —
which is why it is opt-in only and never what `'auto'` picks: on Linux the
default stays X11, and with it everything on this page.

**XQuartz notes**, since it is the most common macOS path:

- Put `/opt/X11/bin` first on `PATH`. Font family resolution shells out to
  `fc-match`, and Homebrew's fontconfig — which is usually found first —
  ships no macOS system-font aliases, so `sans-serif` resolves to a CJK
  face. Issue [#86](https://github.com/sidorares/react-x11/issues/86).
