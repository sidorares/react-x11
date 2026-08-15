# Security model

Read this before you decide what to put in a react-x11 window.

## X11 has no isolation between clients

Any program connected to an X display can read any other program's window
contents, grab the keyboard, and synthesize or record input. Not through a
bug — that is the 1987 design. X11 predates the idea that programs on one
machine might not trust each other, and the protocol's power was the point.

It is not theoretical, and it is not hard. node-x11 ships bindings for both
extensions that make it a five-line program on a shared display:

- **XTEST** (`x11/lib/ext/xtest.js`) — `FakeInput` synthesizes key presses
  and pointer events indistinguishable from real ones.
- **RECORD** (`x11/lib/ext/record.js`) — a keylogger, by design; it exists
  so that macro recorders can work.

Plus `GetImage` on another client's window, which needs no extension at all
and is what this project's own [framed screenshots](../AGENTS.md) use.

Two consequences, both practical:

1. **Do not run untrusted programs on a display you use.** A malicious npm
   postinstall script that reaches `$DISPLAY` owns your session — your
   browser's rendered pages, your password manager's window, your
   keystrokes.
2. **Do not treat a react-x11 window as a confidential surface.** If a
   secret must not be readable by other software on that display, it does
   not belong in an X11 window. This applies to every X11 toolkit equally;
   react-x11 has no way to change it and does not pretend to.

Under Wayland this is different — a Wayland client cannot read its
neighbours — but react-x11 running under Xwayland is inside the X11 sandbox
with every other X client, so it shares theirs and not the compositor's.

## `$XAUTHORITY` is a password

Access to an X display is a **bearer token**: the MIT-MAGIC-COOKIE-1 cookie
in `~/.Xauthority` (or wherever `$XAUTHORITY` points). node-x11 sends it on
connect (`x11/lib/auth.js`). Whoever holds the cookie has the display, with
everything in the section above.

So:

- **Never bake it into a container image.** `COPY . /app` with an
  `.Xauthority` in the build context ships your display credentials to
  whoever pulls the image.
- **Never log it, and never put it in a bug report.** Nor
  `xauth list` output, nor a strace of the connect handshake.
- **Do not mount `~/.Xauthority` into a container** you would not trust with
  your desktop. Mounting `/tmp/.X11-unix` has the same effect.
- Cookies are per-display and long-lived. Rotating one means
  `xauth remove` / `xauth generate`, not restarting the app.

`ssh -X` sidesteps all of this: it creates a **separate, per-session,
expiring** cookie on the remote side, which is worth far less if it leaks.
That is a security argument for `ssh -X` beyond the encryption.

## Prefer `ssh -X` over `ssh -Y`

`-X` runs the app as an untrusted client: it cannot read other windows,
cannot grab the keyboard, cannot record input. `-Y` turns those restrictions
off and hands the remote host your whole session.

**react-x11 should work under `-X`.** It draws into windows it created,
which is exactly what untrusted mode allows. **If it does not, that is a bug
worth filing** rather than a reason to switch to `-Y`. That is a deliberate
position: most toolkits' documentation says "use `-Y` if `-X` misbehaves",
which quietly trades the entire isolation model for a workaround.

The one thing untrusted mode costs you is a cookie that expires — see
[remote.md](remote.md#the-failure-that-looks-like-a-crash), because the
symptom looks like a crash rather than a permission problem.

## Never `xhost +`

`xhost +` disables access control for every host on the network. `xhost
+local:` does it for every user on the machine, including the ones you did
not have in mind. Both are common advice for "X11 in Docker" and both mean
"anything that can reach my display now owns my session".

The right tool is `xauth`: extract the cookie for one display and give it to
one consumer.

```sh
# hand a container the cookie for :0, and nothing else
xauth nextract - "$DISPLAY" | docker exec -i box xauth nmerge -
```

`ssh -X` is better still, because the cookie it hands over is not the one
that opens your desktop.

## What react-x11 does and does not do

**Does:**

- Sends the cookie ntk/node-x11 read from `$XAUTHORITY` — the standard
  handshake, nothing custom.
- Contains a throwing event handler rather than letting it take the process
  ([events.md](events.md#when-a-handler-throws)); a bad handler is a bug, not
  a way to wedge the app.
- Bounds what it draws to the damaged region, which is a performance
  property but also means less of your window crosses the wire per frame.

**Does not:**

- Defend against a hostile X server. The server you connect to sees
  everything you draw, everything you type into your own windows, and holds
  your clipboard. Connecting to an X display is trusting it completely —
  there is no protocol-level way to do otherwise, and no library can add
  one. `DISPLAY=evil.example:0` is equivalent to handing over the session.
- Sanitize content. `<svg>` renders the markup you give it through ntk's
  SvgView, and a document component renders the source you hand it —
  untrusted markup should be treated the way you would treat it in a
  browser. Anything that fetches a remote resource on a document's behalf
  is yours to police.
- Isolate one window from another within an app. Every node in a root shares
  one connection and one process; `trapFocus` is a focus policy, not a
  security boundary, and neither is a modal `Dialog`
  ([components.md](components.md#dialog)).
- Encrypt anything. That is `ssh`'s job.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
