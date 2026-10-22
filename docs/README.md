# react-x11 documentation

react-x11 renders one React tree to four backends: **X11** (a Linux desktop,
a forwarded display, XQuartz), **Cocoa** (a native Mac app, no X server
anywhere), **win32**, and an opt-in native **Wayland** backend. The same
tree, components, styles and hooks run on all of them, and `createRoot()`
picks — Cocoa on macOS and win32 on Windows where their bridges are
installed, X11 otherwise. Every page below is about every backend unless it
says otherwise; where a backend changes the answer, it is called out where
the answer is.

- [macos.md](macos.md) — the Cocoa backend: choosing it, its options,
  windowing, text, input, native controls, the menu bar, app bundles, and
  what does not map (no window manager, no cross-process embedding).
- [elements.md](elements.md) — the host elements (`<window>`, `<popup>`,
  `<box>`, `<text>`, `<textinput>`, `<textarea>`, `<image>`, `<canvas>`,
  `<svg>`, `<foreign>`), their props and refs — including
  [selecting read-only text](elements.md#selecting-text) with `selectable`.
- [styling.md](styling.md) — the `style` prop: layout and paint properties,
  state blocks, transitions, theme tokens, container queries, `createStyles`,
  and [a font file of your own](styling.md#a-font-file-of-your-own).
- [components.md](components.md) — the widgets (`Button`, `Checkbox`,
  `Radio`, `Switch`, `ProgressBar`, `Select`, `Slider`, `Tooltip`, `Dialog`,
  `MenuBar`/`ContextMenu`, `Tabs`, `Table`, `SplitPane`), theming, and the
  `useAnchor` popup placement hook.
- [globalmenu.md](globalmenu.md) — a `MenuBar` handed to wherever the
  platform keeps menus: the macOS menu bar, a desktop panel over
  `com.canonical.dbusmenu`, or the drawn bar.
- [events.md](events.md) — the synthetic event system: dispatch phases,
  event objects, focus, cursors, default actions.
- [accessibility.md](accessibility.md) — screen readers: the AT-SPI2 bridge,
  `role`/`aria-*` on every element, what the widgets announce, `announce()`,
  and testing it all without a desktop.
- [react-features.md](react-features.md) — where React knowledge carries
  over and where a DOM habit breaks: effects, measuring a node, refs,
  `<popup>` instead of `createPortal`, error boundaries, missing APIs.
- [drag-and-drop.md](drag-and-drop.md) — accepting drops and starting drags,
  in-app and with other applications: `dropAccept`, payloads,
  `useDropTarget`/`useDragSource`, previews, and driving a drag in a test.
- [clipboard.md](clipboard.md) — `useClipboard()`: CLIPBOARD and PRIMARY,
  several flavours of one payload, the `text`/`files`/`uris` groups,
  `watch()`, and the macOS pasteboard.
- [typescript.md](typescript.md) — the bundled types: one tsconfig option,
  and JSX from `react-x11/jsx-runtime`.
- [extending.md](extending.md) — `registerElement()` and the subpath
  exports: a host element from outside the package, the node contract, and
  the damage seam for an element that draws a whole scene.
- [gl.md](gl.md) — `<glarea>`, a GL surface in the layout: `glPolicy`, the
  backends underneath, `<shaderMaterial>` and `<effectComposer>`.
- [embedding.md](embedding.md) — `<foreign>`: another application's window
  inside yours, over XEmbed or a plain reparent. **X11 only.**
- [frame.md](frame.md) — `<Frame>`: a pane of your own app in a process of
  its own; what the process boundary buys, and that it is not a security
  boundary.
- [testing.md](testing.md) — `react-x11/test`: render, query, drive and
  assert on real pixels against an in-process X server. No display, and
  always the **X11** backend.
- [desktop.md](desktop.md) — what an app tells the desktop beyond drawing:
  startup notification, the launcher badge and Dock menu, the tray, feature
  discovery, and turning it all off.
- [dbus.md](dbus.md) — the session and system bus: `useSessionBus()` /
  `useSystemBus()`, `sessionBus()`, and "no bus" as a normal configuration.
- [uri-schemes.md](uri-schemes.md) — being the app a `myapp://…` link
  opens: `registerApplication()`, `useAppOpen()`, single-instance
  forwarding, and the `.desktop` half.
- [filedialog.md](filedialog.md) — `useFileDialog()`: open, save and pick a
  folder, through a native panel, the desktop portal, `osascript` or a drawn
  browser; cancelling is `null`.
- [permissions.md](permissions.md) — `usePermission()` for the camera, the
  microphone, the screen and the accessibility APIs, and its five-word
  status vocabulary.
- [notifications.md](notifications.md) — `notify()` and `useNotifier()`:
  banners through the best available rung, updated in place, and what the
  user did with them.
- [desktop-calendar.md](desktop-calendar.md) — `useDesktopCalendarEvents()`:
  the user's real events, with no credential, via EventKit or Evolution
  Data Server.
- [eyedropper.md](eyedropper.md) — `useEyedropper()`/`pickScreenColor()`:
  sample a colour from the screen.
- [appearance.md](appearance.md) — light or dark, accent, contrast, reduced
  motion: `useSystemAppearance()` and `<ThemeProvider dark>`.
- [scale.md](scale.md) — HiDPI: logical pixels, `createRoot({ scale: 'auto'
})`, `useScale()`, and per-monitor answers.
- [system.md](system.md) — the machine around the app: `useScreens()`,
  `useWindowState()`, `useIdle()`/`useKeepAwake()`, `useKeyboardState()`,
  `useDesktopSettings()`, `useLocale()`.
- [remote.md](remote.md) — running on one machine and drawing to a display
  on another: `ssh -X` vs `-Y`, what the protocol costs on a link, the other
  X servers.
- [wayland-backend.md](wayland-backend.md) — the opt-in native Wayland
  backend: what runs, and what is still open.
- [windows.md](windows.md) — the win32 backend: choosing it, installing the
  bridge, what maps and what does not.
- [windows-integrations.md](windows-integrations.md) — what an app on
  Windows can reach today, and the gaps.
- [security.md](security.md) — the threat model: X11 has no isolation
  between clients, `$XAUTHORITY` is a password, and what react-x11 does and
  does not defend against.
- [packaging.md](packaging.md) — five ways to ship an app, the load-bearing
  esbuild flags, and macOS signing for Developer ID and the App Store.
- [devtools.md](devtools.md) — React DevTools integration and other
  debugging aids.
- [debugging.md](debugging.md) — runtime diagnostics: `REACT_X11_TRACE` and
  `startTrace()`, `REACT_X11_DEBUG_PAINT`, invalidation reasons, and the
  switches that turn one optimisation off.
- [click-to-component.md](click-to-component.md) — Alt+Click a rendered
  element to open its JSX source line in your editor.
- [ecosystem.md](ecosystem.md) — which npm packages work with react-x11 and
  which do not, and why. Per category:
  [state](ecosystem/state.md), [data fetching](ecosystem/data-fetching.md),
  [forms](ecosystem/forms.md), [icons](ecosystem/icons.md),
  [theming](ecosystem/theming.md), [animation](ecosystem/animation.md),
  [headless components](ecosystem/headless.md),
  [layout](ecosystem/layout.md), [routing](ecosystem/routing.md),
  [i18n](ecosystem/i18n.md), [testing](ecosystem/testing.md),
  [dev tooling](ecosystem/dev-tooling.md).

Contributors: the design records behind these pages — history, rejected
alternatives, measurements, plans — are in
[design/README.md](../design/README.md), which does not ship.

## Entry points

```js
import { createRoot, Select } from 'react-x11';
```

### `await createRoot(options?)` → `{ app, render(element), unmount() }`

The entry point. With no options it opens a connection to whichever backend
this machine has: the **Cocoa** bridge on macOS, the **win32** bridge on
Windows, or the X server named by `$DISPLAY`. Without the bridge installed
it falls back to X11, once and out loud, so an XQuartz, WSLg or Cygwin
setup keeps working. The returned `app` is that backend's app object — the
[ntk](https://github.com/sidorares/ntk) App and its one X connection on
X11.

**Every root without `app` opens its own connection and owns it**, so two
roots are two independent trees, and `await root.unmount()` closes what it
opened — without which the socket stays up and the process does not exit.
A root given an `app` borrows it and never closes it: that connection
belongs to whoever made it.

On macOS `'auto'` answers Cocoa, and **`$DISPLAY` in the environment does
not change that.** Naming an X endpoint _in code_ — `display` or `stream` —
does; from the environment, say `REACT_X11_BACKEND=x11`
([remote.md](remote.md)).

| option                                                 |                                                                                                                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend`                                              | `'auto'` (default), `'x11'`, `'cocoa'`, `'win32'` or `'wayland'` (opt-in; `'auto'` never picks it). Naming a bridge backend makes the bridge required rather than preferred |
| `app`                                                  | render into a connection you already have — the option a backend choice is ignored for                                                                                      |
| `cocoa`                                                | that backend's knobs: `presenter`, `promote`, `frameInterval`, `pumpInterval`, `appName`, `activationPolicy`, `exitOnQuit` ([macos.md](macos.md))                           |
| `scale`                                                | device pixels per logical pixel: `'auto'` (default) or a number ([scale.md](scale.md))                                                                                      |
| `frameRate`                                            | how windows pace frames under a flood: `'display'` (default) or `'adaptive'` ([elements.md](elements.md#framerate--pacing-the-frames-under-a-flood))                        |
| `desktop`                                              | `false`, or `{ appearance, a11y, globalMenu }` — the three things that dial the session bus ([desktop.md](desktop.md))                                                      |
| `startupNotification`                                  | freedesktop startup notification, on by default; `false`, or the id ([desktop.md](desktop.md))                                                                              |
| `compose`                                              | dead keys and Compose: the built-in table by default, `'system'`, `{ file }`/`{ sequences }`, or `false`                                                                    |
| `accelerators`                                         | which keysym a shortcut matches: `'latin'` (default), `'layout'`, or a table                                                                                                |
| `restoreFocusOnReveal`                                 | whether a revealed subtree takes the keyboard back. Default `true`                                                                                                          |
| `textStripBelow`                                       | the size under which `<text>` paints as a strip of ink rather than glyphs. Default 6; `0` never                                                                             |
| `display`                                              | **X11.** `':1'`, `'host:0.0'`, a socket path. Default `$DISPLAY`. Naming one chooses the X11 backend                                                                        |
| `stream`                                               | **X11.** an already-connected duplex stream — also a backend choice                                                                                                         |
| `fontSource`                                           | **X11.** pluggable system-font lookup — ntk's docs/fonts.md                                                                                                                 |
| `glPolicy` `glxVisual`                                 | **X11.** which GL backend `<glarea>` draws through, and a visual for it ([gl.md](gl.md))                                                                                    |
| `onXError`                                             | **X11.** protocol errors nothing claimed. Default warns                                                                                                                     |
| `onUncaughtError` `onCaughtError` `onRecoverableError` | `(error, errorInfo)`; default logs the component stack                                                                                                                      |
| `onDisconnect(reason, err)`                            | **X11.** the connection ended — `'closed'` or `'error'`                                                                                                                     |

`display`, `stream`, `fontSource`, `glxVisual`, `glPolicy` and `onXError` go
straight to ntk's `createClient`. For anything else it understands, build
the client yourself and pass it as `app`. A `stream` reaches a server that
is not on `$DISPLAY` — node-x11's in-process one, for instance:

```js
import xserver from 'x11/lib/xserver/index.js';

const server = xserver.createServer({ width: 640, height: 480 });
const [serverEnd, clientEnd] = xserver.createStreamPair();
server.addClientStream(serverEnd);
const root = await createRoot({ stream: clientEnd }); // no $DISPLAY needed
```

`onUncaughtError` covers one channel React does not: a throw from an **event
handler**, which no error boundary can catch because the handler ran from an
input event rather than a render. See
[events.md](events.md#when-a-handler-throws).

`onDisconnect` fires when an X connection ends without being asked to —
server exit, ssh drop, kill — and not for one this root closed. **A
reconnect is not a reconnect:** every window id, pixmap, glyph set and font
is invalidated with the connection, so tear the root down and build a new
one.

`root.render(element, callback?)` flushes the mount or update
synchronously (`updateContainerSync` + `flushSyncWork`); painting happens a
frame later on the window's frame clock.

## Environment variables

Every one of these has an option or a prop that says the same thing in code;
the variable is for when you cannot edit the call — someone else's app, a
`.desktop` launcher, an A/B run. `npx react-x11 help` prints every one the
renderer reads, the diagnostic switches included.

**Choosing a backend and a display**

| variable                     | effect                                                                     |
| ---------------------------- | -------------------------------------------------------------------------- |
| `DISPLAY`                    | X server to connect to (standard X11)                                      |
| `REACT_X11_BACKEND`          | `x11`, `cocoa`, `win32` or `wayland`, overriding `backend` and the default |
| `REACT_X11_GL_DEVICE`        | Wayland: the DRM node to render on, where `glPolicy.devicePath` is unset   |
| `REACT_X11_SCALE`            | device pixels per logical pixel; outranks even a pinned `scale` number     |
| `REACT_X11_FRAME_RATE`       | `display` or `adaptive`, overriding `frameRate` and the props              |
| `REACT_X11_TEXT_STRIP_BELOW` | the `textStripBelow` size, for a process that cannot pass the option       |

**Turning desktop integration off**

| variable                      | effect                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `REACT_X11_A11Y`              | set at all: log why the AT-SPI bridge did not start. `0` turns it off                    |
| `NO_AT_BRIDGE=1`              | the freedesktop spelling of the same off switch                                          |
| `REACT_X11_NO_GLOBAL_MENU=1`  | `MenuBar` always draws its own bar                                                       |
| `REACT_X11_NO_TRANSPARENCY=1` | pretend there is no compositor ([debugging.md](debugging.md#react_x11_no_transparency1)) |

**Development and diagnostics**

| variable                         | effect                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `REACT_X11_DEVTOOLS=1`           | connect to a running `react-devtools` (see devtools.md); on by default under `react-x11 dev`, `=0` turns it off                                  |
| `REACT_X11_DEVTOOLS_HOST`        | devtools host (default `localhost`)                                                                                                              |
| `REACT_X11_DEVTOOLS_PORT`        | devtools port (default `8097`)                                                                                                                   |
| `REACT_X11_DEBUG_LAYOUT=1`       | outline every laid-out node, color-coded by tree depth                                                                                           |
| `REACT_X11_DEBUG_PAINT=1`        | stroke each frame's damage rects in a rotating colour; `=full` also warns on full-window repaints                                                |
| `REACT_X11_TRACE`                | record the X11 protocol — see [debugging.md](debugging.md) for the grammar                                                                       |
| `REACT_X11_CLICK_TO_COMPONENT=1` | Alt+Click opens the clicked element's source, using `cursor` (see click-to-component.md); on by default under `react-x11 dev`, `=0` turns it off |
| `REACT_X11_EDITOR`               | editor CLI for click-to-component — setting this alone also enables it                                                                           |
| `REACT_X11_STRICT_TOKENS=1`      | a `$token` the theme does not define is fatal instead of dropped                                                                                 |

**The Cocoa backend**

| variable                       | effect                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `REACT_X11_COCOA_PRESENTER`    | `surface` (the measured default) or `layers`                                                                                                     |
| `REACT_X11_COCOA_PROMOTE`      | `1`/`0`, forcing layer promotion on or off                                                                                                       |
| `REACT_X11_COCOA_PANE_STRETCH` | `behind` (default), `never` or `always`: when a `<Frame>` pane's last frame is stretched while a resize waits on the next ([frame.md](frame.md)) |
| `REACT_X11_CALAYERS_PATH`      | load the bridge from a checkout or an extracted tarball instead of the package                                                                   |

A handful more exist only to switch off one optimisation while measuring it
— `REACT_X11_NO_PAINT_CACHE`, `REACT_X11_NO_SCROLL_BLIT`,
`REACT_X11_NO_PANE_SHAPE`, `REACT_X11_NO_BOUNDS_CACHE`,
`REACT_X11_NO_STROKE_CHUNKING`, `REACT_X11_NO_SCOPED_FLOORS`,
`REACT_X11_NO_UNREAD_WIDTHS`, `REACT_X11_NO_REFIT_HOLD`,
`REACT_X11_NO_APPEARANCE_CACHE`. They are development instruments, not API,
documented in [debugging.md](debugging.md) or where the thing they disable
is.
