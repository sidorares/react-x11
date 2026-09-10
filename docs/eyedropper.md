# The eyedropper

Sample one pixel from the screen — any window, any application, the
wallpaper — and get a colour an app can paint with.

```jsx
import { useEyedropper } from 'react-x11';

function StrokePicker({ value, onChange }) {
  const eyedropper = useEyedropper();

  return (
    <Button
      label="Pick from screen"
      disabled={eyedropper.picking}
      onPress={async () => {
        const hex = await eyedropper.pick();
        if (hex) onChange(hex); // '#rrggbb'
      }}
    />
  );
}
```

Cancelling — Escape, the desktop dialog's own cancel, a dismissed macOS
sampler — resolves to `null`. It is an ordinary outcome, not an exception,
on every rung, so the whole error path is one `if`. The same contract as the
[file dialogs](filedialog.md), on purpose.

## The ladder

|     |                        |                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **the system sampler** | `NSColorSampler` on the [cocoa backend](macos.md), where the app the tree renders through carries `colorSampler` (`@windowkit/appkit` >= 0.9). macOS draws the loupe out of process, so the app needs no Screen Recording grant of its own and the user gets the magnifier every other Mac colour picker shows. |
| 2   | **the portal**         | `org.freedesktop.portal.Screenshot.PickColor` over D-Bus. The desktop draws its own magnifier and hands the colour back. GNOME and KDE ship it; it is also the only route that exists on Wayland.                                                                                                               |
| 3   | **X11**                | The classic route: grab the pointer with a crosshair, wait for the click, read the 1×1 under it, decode by the server's own pixel layout. Works under a bare WM, over ssh, on XQuartz — everywhere there is a display and nothing else.                                                                         |

`screenColorBackend()` reports which rung this machine lands on without
grabbing anything; `useEyedropper().supported` is the same answer as render
state.

The first two rungs are the same shape — ask the system, it draws the
picker, it hands back an sRGB triple — which is why the sampler goes on top
of the portal and not under the crosshair: where the OS will do this for us,
it does it better.

There is no rung to _draw_, and that is the difference from the file dialog's
ladder: the thing being read — the whole screen — is precisely what an
application cannot draw itself. So the hook adds binding, not a fallback of
its own — and the ladder can therefore run out. Where it does, the floor is
the typed rejection and `supported: false`, never a crash. A cocoa app on a
bridge **older than 0.9** is that place: its `app.X` is a stub, so there is
no pointer to grab and no root window to read either ([macos.md](macos.md)).
Both system rungs are gated on what they are built out of — one bridge verb,
three X requests — rather than on there being an app, so a picker there draws
no eyedropper button instead of one that throws on its first press.

### The version gate

`PickColor` arrived in **version 2** of the Screenshot interface, and the
portal being on the bus says nothing about that: `hasService()` sees the
service, not what its backends provide. XFCE's portal, for example, ships no
Screenshot interface at all — a machine where every FileChooser call works
and every PickColor would fail. So the probe reads the interface's own
`version` property, via `portalVersion()` (exported, since the next portal
feature will need the same question answered):

```js
import { portalVersion } from 'react-x11';

const v = await portalVersion('org.freedesktop.portal.Screenshot');
// 0 — not there at all; 1 — there, but before PickColor; 2+ — usable
```

Where the answer is below 2, the ladder falls through to the X11 rung
rather than calling a method the portal would refuse.

## `useEyedropper()`

```ts
const { pick, supported, picking } = useEyedropper(defaults?);

pick(options?): Promise<string | null>; // '#rrggbb', or null on cancel
supported: boolean; // screenColorBackend() !== null, resolved for you
picking: boolean;   // a pick is in flight — the button's pressed state
```

| option         |                                                           |
| -------------- | --------------------------------------------------------- |
| `parentWindow` | override the owner window; inferred otherwise             |
| `signal`       | an `AbortSignal` that ends the pick and releases the grab |
| `backend`      | force a rung; the seam for a kiosk, and for tests         |

Options given to the hook are defaults for every pick; options given to a
call win. The portal's dialog is parented to the window the component is in,
resolved when the pick starts — the `useFileDialog()` inference, with
`parentWindow` as the override for a tree with several top-level windows.

Two things the hook does beyond forwarding:

- **`picking` is the pressed state**, and it is honest: while it is true, a
  second `pick()` returns the promise already in flight rather than starting
  a second grab — so a double-clicked button cannot make the user click
  twice.
- **`supported` is almost always true on this toolkit.** An X11 tree has a
  connection by definition, and the connection _is_ the fallback rung; a
  cocoa tree has the system sampler. It goes false when a forced
  `backend: 'portal'` finds no portal, and on a cocoa app whose bridge
  predates the sampler — which is what keeps the button honest on whatever
  platform comes next.

## The bare function

```js
import { pickScreenColor, screenColorBackend } from 'react-x11';

const hex = await pickScreenColor({ app });
```

Same options, same results. The one addition is `app`: the X11 rung needs a
connection to grab and read on and the cocoa rung needs the app whose
sampler to show, and a bare function has no tree to take one from — pass the
app `createRoot()` returned (or `useApp()` in a component, or a
`parentWindow` that points at a mounted node, which carries its app with
it). With no app named, the connections the renderer is currently drawing
through are asked, the way `openFile()` finds its native panel. Where no
rung answers it rejects with `NoScreenColorError` — a **typed** rejection,
so it reads as "hide the button", not as a crash.

One pick per connection at a time **on the X11 rung**: a second concurrent
`pickScreenColor()` on the same app is refused loudly, because a second grab
from the same client would silently _replace_ the first and one pick would
settle with the other's click. The hook's shared in-flight promise is the
friendly version of the same rule. The system sampler needs no such refusal:
`NSColorSampler` "begins or attaches to an existing color sampling session",
so a second pick joins the loupe that is up and both callers get the same
colour.

## What differs between the rungs

- **The system rungs draw a magnifier; the X11 rung deliberately does not.**
  On X11 it is grab, crosshair, click — and Escape cancels. The desktops
  whose users expect a loupe have a portal or an `NSColorSampler` that draws
  one; a hand-rolled loupe on the bottom rung would be a screenshot of the
  screen re-rendered at 8×, permanently slightly wrong about scaling and
  colour management.
- **Only the system rungs need no permission.** Both the portal and
  `NSColorSampler` run the picker in another process and hand back a
  colour, so nothing here asks for a screen-capture grant — on macOS that
  is the difference between a dropper button and a TCC prompt for Screen
  Recording.
- **On the X11 rung the keyboard also picks.** Return, KP Enter or space
  samples the pixel under the pointer without a click — GTK's shape — and
  the keyboard is grabbed for the duration so Escape works wherever the
  focus happens to be.
- **What is sampled is what is on the screen.** The X11 rung reads the
  rendered pixel, so a colour under a translucent overlay is the blend, not
  the window's own value. What exactly the portal samples is the desktop's
  choice, not this API's — GNOME's and KDE's pickers read the composited
  screen too.
- **`signal` means less on the cocoa rung.** AppKit offers no way to dismiss
  a sampler from code — the session ends when the user picks or presses
  Escape — so an abort there ends the wait and nothing else: the loupe stays
  up, and the colour it eventually reports is dropped. Until then that
  pending sample holds the process's event loop open, the way pending I/O
  does. The portal's request is Closed and the X11 grab is released, which
  is what an abort has to guarantee where something _is_ held.
- **Every rung answers `'#rrggbb'`.** The portal and the sampler hand back
  sRGB floats and X11 hands back server-layout words; every consumer wants a
  CSS colour it can paint with, so the conversion happens once, here — the
  same function for the two float rungs. If something later needs the
  unrounded values, an option can widen the return — starting with channels
  would have made the common case do arithmetic.

## The grab, and what it displaces

The X11 rung holds a **server pointer grab** while it waits. That is the
dangerous part of the feature — an application that leaks a grab leaves a
desktop that has stopped answering clicks — and it is why the grab's whole
lifecycle belongs to core rather than to apps:

- Every way out — click, Escape, abort, error — releases the grab before the
  promise settles. The `signal` option releases it too; that is guaranteed
  here, not delegated to the caller.
- A `<popup grab>` that was open when the pick started — an open `Select`,
  a menu, the colour panel the eyedropper button itself sits in — had its
  grab silently replaced by the pick's (same client, so X raises no error
  and tells no one). When the pick ends, core hands that popup its grab
  back, so dismiss-on-outside-click still works afterwards.
- A grab released out from under a pick — this client's own popup teardown
  calls `UngrabPointer`, which releases whatever the client's active grab is
  — is detected (the server announces it with a `LeaveNotify` of mode
  `Ungrab` on the grab window) and taken back, rather than leaving a pick
  that never resolves while the app answers clicks as if nothing were
  happening.

## Running it anywhere

| where                                                | rung                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| macOS, the cocoa backend, `@windowkit/appkit` >= 0.9 | cocoa — `NSColorSampler` ([macos.md](macos.md))                                                                    |
| macOS, the cocoa backend, an older bridge            | none — `supported` is false, `pickScreenColor()` rejects typed                                                     |
| GNOME / KDE, or any portal with Screenshot ≥ 2       | portal                                                                                                             |
| XFCE (portal present, no Screenshot interface)       | X11                                                                                                                |
| ssh, `startx`, XQuartz, a container with a display   | X11                                                                                                                |
| Node 20, where npm skips `dbus-native`               | X11                                                                                                                |
| Wayland, some day                                    | portal only — there is no root window to read, which is a further reason the ladder lives here and not in each app |

## Building a colour picker on it

The eyedropper is the one part of a colour picker that cannot be composed
out of public elements, which is why it lives in core and the picker panel
does not. A `<ColorPicker>` in `@react-x11/components` consumes it as a
function prop:

```jsx
<ColorPicker eyedropper={pickScreenColor} value={fill} onChange={setFill} />
```

and once that component exists, this function is its default and no app
changes.
