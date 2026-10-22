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
on every rung, so the whole error path is one `if`, as with the
[file dialogs](filedialog.md).

## The ladder

|     |                        |                                                                                                                                                                                                                              |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **the system sampler** | `NSColorSampler` on the [cocoa backend](macos.md) (`@windowkit/appkit` >= 0.9). macOS draws the loupe out of process, so the app needs no Screen Recording grant and the user gets the usual Mac magnifier.                  |
| 2   | **the portal**         | `org.freedesktop.portal.Screenshot.PickColor` over D-Bus. The desktop draws its own magnifier and hands the colour back. GNOME and KDE ship it; it is also GNOME's only route on Wayland.                                    |
| 3   | **the Wayland picker** | On the [Wayland backend](wayland-backend.md) where the compositor offers screen capture and layer-shell but no portal (wlroots: sway, labwc, …): the output is frozen into a capture overlay and the click is taken on that. |
| 4   | **X11**                | Grab the pointer with a crosshair, wait for the click, read the pixel under it. Works under a bare WM, over ssh, on XQuartz — everywhere there is a display and nothing else.                                                |

`screenColorBackend()` reports which rung this machine lands on without
grabbing anything; `useEyedropper().supported` is the same answer as render
state.

There is no rung that react-x11 draws itself — the screen is exactly what an
app cannot draw — so the ladder can run out. Where it does, `supported` is
`false` and a pick rejects with a typed error, never a crash. A cocoa app on a
bridge **older than 0.9** is that place ([macos.md](macos.md)): hide the
button there.

### The version gate

`PickColor` arrived in **version 2** of the Screenshot interface, and a portal
on the bus may not have it (XFCE's ships no Screenshot interface at all). The
probe reads the interface's own `version` with `portalVersion()`, which is
exported:

```js
import { portalVersion } from 'react-x11';

const v = await portalVersion('org.freedesktop.portal.Screenshot');
// 0 — not there at all; 1 — there, but before PickColor; 2+ — usable
```

Below 2, the ladder falls through to the X11 rung.

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
resolved when the pick starts — the
[`useFileDialog()` inference](filedialog.md#the-dialog-parents-itself), with
`parentWindow` as the override for a tree with several top-level windows.

- **`picking` is the pressed state.** While it is true, a second `pick()`
  returns the promise already in flight rather than starting a second grab,
  so a double-clicked button cannot make the user click twice.
- **`supported` is almost always true.** An X11 tree's connection _is_ the
  fallback rung, and a cocoa tree has the system sampler. It goes false when a
  forced `backend: 'portal'` finds no portal, and on a cocoa app whose bridge
  predates the sampler.

## The bare function

```js
import { pickScreenColor, screenColorBackend } from 'react-x11';

const hex = await pickScreenColor({ app });
```

Same options, same results. The one addition is `app`, because a bare function
has no tree to take a connection from: pass the app `createRoot()` returned
(or `useApp()` in a component, or a `parentWindow` that points at a mounted
node). With no app named, the connections the renderer is currently drawing
through are asked. Where no rung answers it rejects with `NoScreenColorError`
— a **typed** rejection, so it reads as "hide the button", not as a crash.

One pick per connection at a time **on the X11 rung**: a second concurrent
`pickScreenColor()` on the same app is refused loudly (two grabs from one
client would steal each other's click). The hook's shared in-flight promise is
the friendly version of the same rule. On the system sampler a second pick
joins the loupe that is up, and both callers get the same colour.

## What differs between the rungs

- **The system rungs draw a magnifier; the X11 rung does not.** On X11 it is
  grab, crosshair, click — and Escape cancels.
- **Only the system rungs need no permission.** The portal and
  `NSColorSampler` run the picker in another process, so nothing asks for a
  screen-capture grant (on macOS, no TCC prompt for Screen Recording).
- **On the X11 rung the keyboard also picks.** Return, KP Enter or space
  samples the pixel under the pointer without a click, and the keyboard is
  grabbed for the duration so Escape works wherever the focus is.
- **What is sampled is what is on the screen.** The X11 rung reads the
  rendered pixel, so a colour under a translucent overlay is the blend, not
  the window's own value. The portal's pickers (GNOME's, KDE's) read the
  composited screen too.
- **`signal` means less on the cocoa rung.** AppKit cannot dismiss a sampler
  from code, so an abort there ends the wait and nothing else: the loupe stays
  up until the user picks or presses Escape, its colour is dropped, and until
  then the pending sample holds the process's event loop open. On the portal
  and X11 rungs an abort closes the request or releases the grab.
- **Every rung answers `'#rrggbb'`**, converted from the portal's and
  sampler's sRGB floats or X11's server-layout pixel.

## The grab, and what it displaces

The X11 rung holds a **server pointer grab** while it waits, and core owns its
whole lifecycle:

- Every way out — click, Escape, abort, error — releases the grab before the
  promise settles.
- A `<popup grab>` that was open when the pick started (an open `Select`, a
  menu, the colour panel the button sits in) gets its grab back when the pick
  ends, so dismiss-on-outside-click still works afterwards.
- If this client's own popup teardown releases the grab mid-pick, the pick
  takes it back rather than hanging.

Design notes: [design/eyedropper.md](../design/eyedropper.md).

## Running it anywhere

| where                                                | rung                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| macOS, the cocoa backend, `@windowkit/appkit` >= 0.9 | cocoa — `NSColorSampler` ([macos.md](macos.md))                                              |
| macOS, the cocoa backend, an older bridge            | none — `supported` is false, `pickScreenColor()` rejects typed                               |
| GNOME / KDE, or any portal with Screenshot ≥ 2       | portal                                                                                       |
| XFCE (portal present, no Screenshot interface)       | X11                                                                                          |
| ssh, `startx`, XQuartz, a container with a display   | X11                                                                                          |
| Node 20, where npm skips `dbus-native`               | X11                                                                                          |
| the Wayland backend, a portal with Screenshot ≥ 2    | portal                                                                                       |
| the Wayland backend on wlroots (sway, labwc, …)      | wayland — the backend's own picker; there is no root window to read, so no X11 rung under it |
