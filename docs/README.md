# react-x11 documentation

react-x11 has **two backends**: X11 (a Linux desktop, a forwarded display,
XQuartz) and Cocoa (a native Mac app, no X server anywhere). The same tree,
components, styles and hooks run on both, and `createRoot()` picks — Cocoa
on macOS where the bridge is installed, X11 otherwise. Every page below is
about both unless it says otherwise; where a backend changes the answer, it
is called out where the answer is. Two more backends are coming, toward
full cross-platform support — Windows ([windows.md](windows.md)) and
native Wayland ([wayland.md](wayland.md)) — and until they land, those two
pages are design documents and everything else describes the two that
ship.

- [macos.md](macos.md) — the Cocoa backend: what a retained layer tree
  changes about a renderer built for a drawing protocol, the two presenters
  (a bitmap surface per window, and a CALayer per node) and which one is the
  measured default, text through CoreText, input off an `NSApplication`
  pump driven by Node's loop, native controls, the menu bar, layer
  promotion, running as an app bundle, and what does not map — no window
  manager, no cross-process embedding. Also the design record for the parts
  still ahead.
- [elements.md](elements.md) — the host elements: `<window>`, `<popup>`,
  `<box>`, `<text>`, `<textinput>`, `<textarea>`, `<image>`, `<canvas>`,
  `<svg>`, `<foreign>`, their props and refs — including
  [selecting read-only text](elements.md#selecting-text) with `selectable`.
- [styling.md](styling.md) — the `style` prop: layout and paint properties,
  `:hover`/`:focus`/`:active`/`:disabled` blocks, transitions, theme tokens,
  window size and container queries, `createStyles`, and
  [a font file of your own](styling.md#a-font-file-of-your-own) —
  `openFont`/`loadFont`/`useFont`.
- [components.md](components.md) — widget components built on the
  primitives: theming, the basic controls (`Button`, `Checkbox`,
  `Radio`/`RadioGroup`, `Switch`, `ProgressBar`), `Select`, `Slider`,
  `Tooltip`, `Dialog`, `MenuBar`/`ContextMenu`, `Tabs`, `Table`,
  `SplitPane`, and the `useAnchor` popup placement hook.
- [globalmenu.md](globalmenu.md) — handing a window's menu bar to wherever
  the platform keeps menus, with no configuration: the macOS menu bar on the
  cocoa backend, the desktop's panel over `com.canonical.dbusmenu` where one
  is running, and the drawn bar everywhere else. The item vocabulary
  `MenuBar` shares with all three, why detection means "a panel is running"
  rather than "one could be started", the diff that decides between patching
  properties and invalidating a layout, why `Control` in a shortcut means ⌘
  on a Mac, and the menu host in `scripts/` for seeing the D-Bus path work
  on a desktop that has none.
- [events.md](events.md) — the synthetic event system: dispatch phases,
  event object shape, focus, cursors, default actions.
- [accessibility.md](accessibility.md) — screen readers see react-x11 apps:
  the built-in AT-SPI2 bridge, the standard `role`/`aria-*` props on every
  element, what the defaults already say, what each widget announces,
  `announce()`, driving controls from assistive technology, the no-bus
  compatibility ladder, and how to test all of it without a desktop. The
  design record behind it — no mirror tree, the event pipeline, what was
  rejected — is
  [architecture/accessibility.md](architecture/accessibility.md).
- [react-features.md](react-features.md) — what your React knowledge buys
  you here and where a DOM habit breaks: `useLayoutEffect` vs `useEffect`,
  measuring a node without `getBoundingClientRect()`, what a `ref` hands
  back, `<popup>` instead of `createPortal`, where to put an error boundary
  so the window survives, and which React APIs are simply not available.
- [drag-and-drop.md](drag-and-drop.md) — accepting drops and starting
  drags, over XDND and in-app: `dropAccept` matching, the payload
  (`e.files`, `e.getData`, live `e.items`), `dragData` and lazy payloads,
  the `useDropTarget`/`useDragSource` hooks, drag previews, what GTK and
  Firefox actually offer, and how to drive a drag in a test.
- [clipboard.md](clipboard.md) — copy and paste beyond the built-in text
  controls: `useClipboard()`, the CLIPBOARD/PRIMARY split, offering several
  flavours of one payload, the `text`/`files`/`uris` groups shared with drag
  and drop, `watch()`, and why a copy carries a timestamp. The one API where
  the backends are not at parity — text works on both, and the rest of that
  list is X11's.
- [typescript.md](typescript.md) — the bundled types: one tsconfig option,
  why JSX comes from `react-x11/jsx-runtime` rather than an augmentation,
  and how the declarations are kept from drifting.
- [extending.md](extending.md) — `registerElement()` and the subpath
  exports: adding a host element from outside the package, the node
  contract, the two definition fields that fail far from their cause, and
  the damage seam an element that draws a whole scene reads and claims.
- [gl.md](gl.md) — `<glarea>`, a GL surface in the layout, and the three
  ways underneath it: indirect GLX, the direct GPU backend, and CGL into a
  layer on Cocoa. `glPolicy`, what each can draw, `<shaderMaterial>` — GLSL
  with three.js's names — and `<effectComposer>` post-processing, both on
  the direct ones.
- [glx.md](glx.md) — how a 3D scene works over indirect GLX: what the
  protocol encodes, why display lists are mandatory, and what can never work.
- [embedding.md](embedding.md) — `<foreign>`: another application's window
  inside yours. XEmbed and the plain-reparent path most clients actually
  want, why unmount hands the window back rather than destroying it, and
  the rule that keeps an app's chords from being swallowed by the client.
  **X11 only** — cross-process window embedding does not exist on macOS.
- [frame.md](frame.md) — `<Frame>`: a pane of your own application in a
  process of its own, embedded and laid out like any other child. What the
  process boundary buys (parallelism, crash and leak isolation), what it
  does not (it is not a security boundary), and the two ways it is realized
  — a `<foreign>` window on X11, shared IOSurfaces on Cocoa.
- [testing.md](testing.md) — `react-x11/test`: render, query, drive and
  assert on real pixels, against a real X server in your test process. No
  display, no xvfb — and no Cocoa: the harness drives the **X11** backend.
- [desktop.md](desktop.md) — what an app tells the desktop about itself
  beyond drawing. Startup notification: why the launcher's busy cursor spins
  for 15 seconds without it, when an app counts as "started", and the seams
  for saying otherwise.
- [dbus.md](dbus.md) — the bus every desktop-integration feature sits on:
  `useSessionBus()` / `useSystemBus()` with nothing to wrap, the imperative
  `sessionBus()` pair underneath, why one process is one connection and one
  identity, and why "there is no bus" is a first-class configuration rather
  than an error.
- [uri-schemes.md](uri-schemes.md) — being the app a `myapp://…` link opens:
  `registerApplication()` and the two dispatch paths a real desktop uses (only
  one of which is D-Bus), why a second copy of the app has to forward and
  exit, `useAppOpen()`, and the timestamp without which the window does not
  actually come forward. Also: why a loopback port is the better answer for a
  login, and the `.desktop` half that is an install step rather than code.
- [filedialog.md](filedialog.md) — open, save and pick a folder:
  `useFileDialog()`, the four-rung ladder (a native panel on the cocoa
  backend, the desktop's own portal, `osascript` under XQuartz, a browser
  react-x11 draws itself), why cancelling is
  `null` rather than a throw, and the places the backends genuinely differ.
- [permissions.md](permissions.md) — may the app use the camera, the
  microphone, the screen, the accessibility APIs: `usePermission()`, the
  five-word status vocabulary (`'unknown'` is the machine's answer, not the
  permission's), the cocoa backend's TCC rung and the Settings-pane rung any
  Mac has, and why Linux answers `'unknown'` until the device portals land.
- [notifications.md](notifications.md) — a banner outside the app's own
  windows: `notify()` and `useNotifier()`, the four-rung ladder (the cocoa
  backend's notification centre, `org.freedesktop.Notifications`,
  `osascript`, `notify-send`), updating a banner in place, what the user
  did with it, and why the shell-out rungs cannot report back.
- [desktop-calendar.md](desktop-calendar.md) — the user's real events, with
  no credential and no OAuth: `useDesktopCalendarEvents()`, the three-rung
  ladder (EventKit through the bridge, EventKit through an `osascript` child,
  Evolution Data Server over the bus), why `end` is exclusive everywhere, and
  why `'denied'` and `'unavailable'` are different words.
- [eyedropper.md](eyedropper.md) — sample a colour from the screen:
  `useEyedropper()`/`pickScreenColor()`, the three-rung ladder (macOS's
  `NSColorSampler`, the portal's own picker, a crosshair grab on plain X11),
  the interface `version` property that gates the portal rung where
  `hasService()` cannot, and why the grab's whole lifecycle — including the
  `<popup grab>` it displaces — belongs to core.
- [appearance.md](appearance.md) — light or dark, the accent colour,
  contrast and reduced motion: `useSystemAppearance()`, `<ThemeProvider dark>`
  for apps that only want to follow the desktop, why the answer is remembered
  on disk so the first frame is not a flash, and what each rung of the ladder
  can actually answer.
- [scale.md](scale.md) — HiDPI: every length you write is a logical pixel,
  `createRoot({ scale: 'auto' })` resolves how many device pixels one is
  worth (environment → XSETTINGS/`Xft.dpi` → audited RandR millimetres →
  the resolution class), `useScale()`, per-monitor answers on
  `useScreens()`, and why a virtual machine's EDID needs the audit.
- [system.md](system.md) — the machine around the app: `useScreens()` for the
  monitor layout, `useWindowState()` for what the window manager actually did,
  `useIdle()`/`useKeepAwake()`, `useKeyboardState()` for Caps Lock and the live
  layout, `useDesktopSettings()` for the timings the built-in controls already
  follow, and `useLocale()`. Also what each one answers on a display with the
  extension missing, and why `obscured` is always false under a compositor.
- [remote.md](remote.md) — the flagship case: running the app on one
  machine and drawing to a display on another. `ssh -X` vs `-Y`, what the
  protocol costs on a link, the other X servers, and why Xwayland works
  where native Wayland structurally cannot.
- [wayland.md](wayland.md) — the research RFC for a native Wayland
  backend: a second target beside X11, not a migration. What the protocol
  actually changes, the fd transport (why the prototype is Bun-first), the
  rendering tiers from a pure-JS span compositor to GPU 2d over x11-dri,
  what maps and what is gone by design, and the phased plan.
- [windows.md](windows.md) — the research PRD for a native Windows
  backend, the next step toward full cross-platform support. Where Windows
  sits between the Wayland and macOS inversions (the client rasterizes, into
  retained composition surfaces that keep the damage model intact), a UI
  thread of the addon's own so that Windows' modal loops never freeze JS,
  Direct2D and DirectWrite behind the contracts the Cocoa backend already
  proved, why the bridge is our own mechanism-only addon rather than
  anything on npm, what maps and what is gone, the phased plan, and what to
  probe first on a Windows machine.
- [security.md](security.md) — the threat model, plainly: X11 has no
  isolation between clients, `$XAUTHORITY` is a password, and what
  react-x11 does and does not defend against.
- [packaging.md](packaging.md) — five ways to ship an app, the esbuild flags
  that are load-bearing, and the two macOS distribution tracks: Developer ID
  takes node or bun, the App Store's sandbox takes node only.
- [devtools.md](devtools.md) — React DevTools integration and other
  debugging aids.
- [debugging.md](debugging.md) — runtime diagnostics: protocol tracing
  (`REACT_X11_TRACE`, `startTrace()`), repaint flashing and full-repaint
  warnings (`REACT_X11_DEBUG_PAINT`), invalidation reasons.
- [click-to-component.md](click-to-component.md) — Alt+Click a rendered
  element to open its JSX source line in your editor.
- [ecosystem.md](ecosystem.md) — which npm packages work with react-x11 and
  which do not: the rule that decides it, a compatibility table across 12
  categories, and a register of the verbatim errors the incompatible ones
  produce. Per-category pages:
  [state](ecosystem/state.md), [data fetching](ecosystem/data-fetching.md),
  [forms](ecosystem/forms.md), [icons](ecosystem/icons.md),
  [theming](ecosystem/theming.md), [animation](ecosystem/animation.md),
  [headless components](ecosystem/headless.md),
  [layout](ecosystem/layout.md), [routing](ecosystem/routing.md),
  [i18n](ecosystem/i18n.md), [testing](ecosystem/testing.md),
  [dev tooling](ecosystem/dev-tooling.md).

## Design records

`architecture/` holds the documents behind the bigger pieces: measured,
written against a named commit, and kept as the record of _why_ rather than
the reference for _what_. Some describe what shipped; some are proposals
that have not been built, and say so at the top.

- [architecture/frame-pacing.md](architecture/frame-pacing.md) — the
  design record behind `frameRate`: why a window fed off an input path
  paints screens nobody sees, the token bucket over paint time that holds
  it to a budget, where it lives on both backends, and what it measured.
- [architecture/element-layer-contents.md](architecture/element-layer-contents.md)
  — the design record for the other half of a streaming element's frame on
  macOS: why an element with a retained surface pays a composite and the
  window swapchain's catch-up copy to move pixels it already has, what the
  platform does with an element-owned IOSurface (spiked in pixels), and the
  presentable `Surface` plus `presentedSurface()` policy that would remove
  both. Not built.
- [architecture/video.md](architecture/video.md) — the design record for
  video: why no X11 extension decodes anything and the one that did is
  dead, what a decoded frame costs through core `PutImage` and what Xv
  would change, the VideoToolbox and Core Animation ladder on macOS
  measured end to end, the YUV-surface trap that decides the Cocoa design
  on both playback and capture, what a webcam actually costs, and why a
  `<video>` element is one element with two very different insides. Not
  built.
- [architecture/animation.md](architecture/animation.md) — what the style
  vocabulary cannot say today (a fade, a move that does not reflow, a
  timeline that ends), who should interpolate it, and what offloading a
  transition to Core Animation costs and buys.
- [architecture/container-queries.md](architecture/container-queries.md) —
  why a container's size is an output of layout where a window's is an
  input, the resolve-after-a-pass loop that follows, and the oscillation it
  can produce. Implemented; [styling.md](styling.md#container-queries) is
  the reference.
- [architecture/custom-layout.md](architecture/custom-layout.md) — why an
  arrangement that depends on a layout output has to run inside the pass
  rather than in an effect, the two seams that do — a `layout` that arranges
  a box's children and a `position` that moves one node, with `sticky` now
  the built-in one — how a layout's children become yoga trees of their own,
  and what they cost. Implemented; [styling.md](styling.md#custom-layouts)
  is the reference.
- [architecture/grid-layout.md](architecture/grid-layout.md) — CSS Grid as
  a layout on that seam, written the way CSS writes it (`display: 'grid'`,
  `gridTemplateColumns`): why the style is flat, the spec's placement and
  track sizing and what is left out, how it is held to Chrome, and what it
  costs against flexbox — more than it should have, until the seam
  remembered what it asks a child. Implemented;
  [styling.md](styling.md#grid) is the reference.
- [architecture/drag-and-drop.md](architecture/drag-and-drop.md) — XDND on
  both sides: where the advertisement lives when every control is drawn into
  one window, what the drag-source half costs, and the API review that
  produced the one in [drag-and-drop.md](drag-and-drop.md).
- [architecture/accessibility.md](architecture/accessibility.md) — the
  AT-SPI2 bridge with no mirror tree: what it exposes, the event pipeline,
  and the alternatives that lost.
- [architecture/protocol-efficiency.md](architecture/protocol-efficiency.md)
  — a request-by-request audit of one hovered checkbox, across react-x11,
  ntk and node-x11, and the fixes it produced.
- [architecture/windowed-regions.md](architecture/windowed-regions.md) —
  when an X11 subwindow pays for itself and when it does not, measured
  against three servers. Research; nothing here is built.

## Entry points

```js
import { createRoot, Select } from 'react-x11';
```

### `await createRoot(options?)` → `{ app, render(element), unmount() }`

The entry point. With no options it opens a connection to whichever backend
this machine has: the **Cocoa** bridge on macOS, or the X server named by
`$DISPLAY`. On a Mac without `@windowkit/appkit` installed it falls back to
X11, once and out loud, so an XQuartz setup keeps working. The returned
`app` is that backend's app object — the [ntk](https://github.com/sidorares/ntk)
App and its one X connection on X11.

**Every root without `app` opens its own connection and owns it**, so two
roots are two independent trees, and `await root.unmount()` closes what it
opened — without which the socket stays up and the process does not exit.
A root given an `app` borrows it and never closes it: that connection
belongs to whoever made it.

One thing to know about `'auto'` before it surprises you: on macOS it
answers Cocoa, and **`$DISPLAY` in the environment does not change that.**
Naming an X endpoint _in code_ — `display` or `stream` — does, because an
ignored connection option would be worse than either answer; from the
environment, say `REACT_X11_BACKEND=x11`. See
[remote.md](remote.md) for the case this actually comes up in.

| option                                                 |                                                                                                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend`                                              | `'auto'` (default), `'x11'` or `'cocoa'`. Naming `'cocoa'` makes the bridge required rather than preferred                                           |
| `app`                                                  | render into a connection you already have — the option a backend choice is ignored for                                                               |
| `cocoa`                                                | that backend's knobs: `presenter`, `promote`, `frameInterval`, `pumpInterval`, `appName`, `activationPolicy`, `exitOnQuit` ([macos.md](macos.md))    |
| `scale`                                                | device pixels per logical pixel: `'auto'` (default) or a number ([scale.md](scale.md))                                                               |
| `frameRate`                                            | how windows pace frames under a flood: `'display'` (default) or `'adaptive'` ([elements.md](elements.md#framerate--pacing-the-frames-under-a-flood)) |
| `desktop`                                              | `false`, or `{ appearance, a11y, globalMenu }` — the three things that dial the session bus ([desktop.md](desktop.md))                               |
| `startupNotification`                                  | freedesktop startup notification, on by default; `false`, or the id ([desktop.md](desktop.md))                                                       |
| `compose`                                              | dead keys and Compose: the built-in table by default, `'system'`, `{ file }`/`{ sequences }`, or `false`                                             |
| `accelerators`                                         | which keysym a shortcut matches: `'latin'` (default), `'layout'`, or a table                                                                         |
| `restoreFocusOnReveal`                                 | whether a revealed subtree takes the keyboard back. Default `true`                                                                                   |
| `textStripBelow`                                       | the size under which `<text>` paints as a strip of ink rather than glyphs. Default 6; `0` never                                                      |
| `display`                                              | **X11.** `':1'`, `'host:0.0'`, a socket path. Default `$DISPLAY`. Naming one chooses the X11 backend                                                 |
| `stream`                                               | **X11.** an already-connected duplex stream — also a backend choice                                                                                  |
| `fontSource`                                           | **X11.** pluggable system-font lookup — ntk's docs/fonts.md                                                                                          |
| `glPolicy` `glxVisual`                                 | **X11.** which GL backend `<glarea>` draws through, and a visual for it ([gl.md](gl.md))                                                             |
| `onXError`                                             | **X11.** protocol errors nothing claimed. Default warns                                                                                              |
| `onUncaughtError` `onCaughtError` `onRecoverableError` | `(error, errorInfo)`; default logs the component stack                                                                                               |
| `onDisconnect(reason, err)`                            | **X11.** the connection ended — `'closed'` or `'error'`                                                                                              |

`display`, `stream`, `fontSource`, `glxVisual`, `glPolicy` and `onXError` go
straight to ntk's `createClient`. Anything else it understands, build the
client yourself and pass it as `app` — which is also how the hermetic tests
drive the renderer against node-x11's in-process X server:

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
server exit, ssh drop, kill — and not for one this root closed. It invites
a reconnect loop, so: **a reconnect is not a reconnect.** Every window id,
pixmap, glyph set and font is invalidated with the connection. Tear the
root down and build a new one; nothing survives, and react-x11 promises
nothing more than telling you it happened.

`root.render(element, callback?)` flushes the mount or update synchronously
(`updateContainerSync` + `flushSyncWork`); painting happens a frame later on
the window's frame clock.

## Environment variables

Every one of these has an option or a prop that says the same thing in code;
the variable exists for the cases where you cannot edit the call — someone
else's app, a `.desktop` launcher, an A/B run.

**Choosing a backend and a display**

| variable                     | effect                                                                 |
| ---------------------------- | ---------------------------------------------------------------------- |
| `DISPLAY`                    | X server to connect to (standard X11)                                  |
| `REACT_X11_BACKEND`          | `x11` or `cocoa`, overriding `backend` and the default                 |
| `REACT_X11_SCALE`            | device pixels per logical pixel; outranks even a pinned `scale` number |
| `REACT_X11_FRAME_RATE`       | `display` or `adaptive`, overriding `frameRate` and the props          |
| `REACT_X11_TEXT_STRIP_BELOW` | the `textStripBelow` size, for a process that cannot pass the option   |

**Turning desktop integration off**

| variable                      | effect                                                                |
| ----------------------------- | --------------------------------------------------------------------- |
| `REACT_X11_A11Y`              | set at all: log why the AT-SPI bridge did not start. `0` turns it off |
| `NO_AT_BRIDGE=1`              | the freedesktop spelling of the same off switch                       |
| `REACT_X11_NO_GLOBAL_MENU=1`  | `MenuBar` always draws its own bar                                    |
| `REACT_X11_NO_TRANSPARENCY=1` | pretend there is no compositor ([debugging.md](debugging.md))         |

**Development and diagnostics**

| variable                         | effect                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `REACT_X11_DEVTOOLS=1`           | connect to a running `react-devtools` (see devtools.md)                                           |
| `REACT_X11_DEVTOOLS_HOST`        | devtools host (default `localhost`)                                                               |
| `REACT_X11_DEVTOOLS_PORT`        | devtools port (default `8097`)                                                                    |
| `REACT_X11_DEBUG_LAYOUT=1`       | outline every laid-out node, color-coded by tree depth                                            |
| `REACT_X11_DEBUG_PAINT=1`        | stroke each frame's damage rects in a rotating colour; `=full` also warns on full-window repaints |
| `REACT_X11_TRACE`                | record the X11 protocol — see [debugging.md](debugging.md) for the grammar                        |
| `REACT_X11_CLICK_TO_COMPONENT=1` | Alt+Click opens the clicked element's source, using `cursor` (see click-to-component.md)          |
| `REACT_X11_EDITOR`               | editor CLI for click-to-component — setting this alone also enables it                            |
| `REACT_X11_STRICT_TOKENS=1`      | a `$token` the theme does not define is fatal instead of dropped                                  |

**The Cocoa backend**

| variable                    | effect                                                                         |
| --------------------------- | ------------------------------------------------------------------------------ |
| `REACT_X11_COCOA_PRESENTER` | `surface` (the measured default) or `layers`                                   |
| `REACT_X11_COCOA_PROMOTE`   | `1`/`0`, forcing layer promotion on or off                                     |
| `REACT_X11_CALAYERS_PATH`   | load the bridge from a checkout or an extracted tarball instead of the package |

There are a handful more that exist only to switch off one optimisation
while measuring it — `REACT_X11_NO_PAINT_CACHE`, `REACT_X11_NO_SCROLL_BLIT`,
`REACT_X11_NO_BOUNDS_CACHE`, `REACT_X11_NO_STROKE_CHUNKING`,
`REACT_X11_NO_APPEARANCE_CACHE`. They are development instruments, not API,
and they are documented where the thing they disable is.
