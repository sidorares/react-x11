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

Cancelling — Escape, or the desktop dialog's own cancel — resolves to `null`.
It is an ordinary outcome, not an exception, on both backends, so the whole
error path is one `if`. The same contract as the
[file dialogs](filedialog.md), on purpose.

## The ladder

|     |                |                                                                                                                                                                                                                                         |
| --- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **the portal** | `org.freedesktop.portal.Screenshot.PickColor` over D-Bus. The desktop draws its own magnifier and hands the colour back. GNOME and KDE ship it; it is also the only route that exists on Wayland.                                       |
| 2   | **X11**        | The classic route: grab the pointer with a crosshair, wait for the click, read the 1×1 under it, decode by the server's own pixel layout. Works under a bare WM, over ssh, on XQuartz — everywhere there is a display and nothing else. |

`screenColorBackend()` reports which rung this machine lands on without
grabbing anything; `useEyedropper().supported` is the same answer as render
state.

There is no third rung to draw, and that is the difference from the file
dialog's ladder: the thing being read — the whole screen — is precisely what
an application cannot draw itself. So the hook adds binding, not a fallback
of its own.

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
- **`supported` is almost always true on this toolkit.** A react-x11 tree
  has an X connection by definition, and the connection _is_ the fallback
  rung. It goes false when a forced `backend: 'portal'` finds no portal —
  and it is the seam that keeps the button honest on whatever platform comes
  later.

## The bare function

```js
import { pickScreenColor, screenColorBackend } from 'react-x11';

const hex = await pickScreenColor({ app });
```

Same options, same results. The one addition is `app`: the X11 rung needs a
connection to grab and read on, and a bare function has no tree to take one
from — pass the app `createRoot()` returned (or `useApp()` in a component,
or a `parentWindow` that points at a mounted node, which carries its
connection with it). Without a portal and without a connection it rejects
with `NoScreenColorError` — a **typed** rejection, so it reads as "hide the
button", not as a crash.

One pick per connection at a time: a second concurrent `pickScreenColor()`
on the same app is refused loudly, because a second grab from the same
client would silently _replace_ the first and one pick would settle with the
other's click. The hook's shared in-flight promise is the friendly version
of the same rule.

## What differs between the rungs

- **The portal draws a magnifier; the X11 rung deliberately does not.** On
  X11 it is grab, crosshair, click — and Escape cancels. The desktops whose
  users expect a loupe have a portal that draws one; a hand-rolled loupe on
  the bottom rung would be a screenshot of the screen re-rendered at 8×,
  permanently slightly wrong about scaling and colour management.
- **On the X11 rung the keyboard also picks.** Return, KP Enter or space
  samples the pixel under the pointer without a click — GTK's shape — and
  the keyboard is grabbed for the duration so Escape works wherever the
  focus happens to be.
- **What is sampled is what is on the screen.** The X11 rung reads the
  rendered pixel, so a colour under a translucent overlay is the blend, not
  the window's own value. What exactly the portal samples is the desktop's
  choice, not this API's — GNOME's and KDE's pickers read the composited
  screen too.
- **Both rungs answer `'#rrggbb'`.** The portal hands back `(ddd)` floats
  and X11 hands back server-layout words; every consumer wants a CSS colour
  it can paint with, so the conversion happens once, here. If something
  later needs the unrounded portal values, an option can widen the return —
  starting with channels would have made the common case do arithmetic.

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

| where                                              | rung                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| GNOME / KDE, or any portal with Screenshot ≥ 2     | portal                                                                                                             |
| XFCE (portal present, no Screenshot interface)     | X11                                                                                                                |
| ssh, `startx`, XQuartz, a container with a display | X11                                                                                                                |
| Node 20, where npm skips `dbus-native`             | X11                                                                                                                |
| Wayland, some day                                  | portal only — there is no root window to read, which is a further reason the ladder lives here and not in each app |

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
