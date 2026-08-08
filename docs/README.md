# react-x11 documentation

- [elements.md](elements.md) — the host elements: `<window>`, `<popup>`,
  `<box>`, `<text>`, `<textinput>`, `<textarea>`, `<image>`, `<canvas>`,
  and the rich-content wrappers `<markdown>`, `<html>`, `<svg>`, `<tex>`,
  their props and refs.
- [styling.md](styling.md) — the `style` prop: layout and paint properties,
  `:hover`/`:focus`/`:active`/`:disabled` blocks, transitions, theme tokens,
  window size queries, `createStyles`.
- [components.md](components.md) — widget components built on the
  primitives: theming, the basic controls (`Button`, `Checkbox`,
  `Radio`/`RadioGroup`, `Switch`, `ProgressBar`), `Select`, `Slider`,
  `Tooltip`, `Dialog`, `MenuBar`/`ContextMenu`, `Tabs`, `Table`, `Tree`,
  `SplitPane`, `Canvas3D`, and the `useAnchor` popup placement hook.
- [globalmenu.md](globalmenu.md) — handing a window's menu bar to the
  desktop's panel where there is one, with no configuration: the dbusmenu
  item vocabulary `MenuBar` shares with it, why detection means "a panel is
  running" rather than "one could be started", the diff that decides between
  patching properties and invalidating a layout, and the menu host in
  `scripts/` for seeing it work without such a desktop.
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
  and drop, `watch()`, and why a copy carries a timestamp.
- [typescript.md](typescript.md) — the bundled types: one tsconfig option,
  why JSX comes from `react-x11/jsx-runtime` rather than an augmentation,
  and how the declarations are kept from drifting.
- [extending.md](extending.md) — `registerElement()` and the subpath
  exports: adding a host element from outside the package, the node
  contract, and the two definition fields that fail far from their cause.
- [testing.md](testing.md) — `react-x11/test`: render, query, drive and
  assert on real pixels, against a real X server in your test process. No
  display, no xvfb.
- [desktop.md](desktop.md) — what an app tells the desktop about itself
  beyond drawing. Startup notification: why the launcher's busy cursor spins
  for 15 seconds without it, when an app counts as "started", and the seams
  for saying otherwise.
- [dbus.md](dbus.md) — the bus every desktop-integration feature sits on:
  `useSessionBus()` / `useSystemBus()` with nothing to wrap, the imperative
  `sessionBus()` pair underneath, why one process is one connection and one
  identity, and why "there is no bus" is a first-class configuration rather
  than an error.
- [filedialog.md](filedialog.md) — open, save and pick a folder:
  `useFileDialog()`, the three-rung ladder (the desktop's own portal,
  `osascript` on macOS, a browser react-x11 draws itself), why cancelling is
  `null` rather than a throw, and the places the backends genuinely differ.
- [appearance.md](appearance.md) — light or dark, the accent colour,
  contrast and reduced motion: `useSystemAppearance()`, `<ThemeProvider dark>`
  for apps that only want to follow the desktop, why the answer is remembered
  on disk so the first frame is not a flash, and what each rung of the ladder
  can actually answer.
- [remote.md](remote.md) — the flagship case: running the app on one
  machine and drawing to a display on another. `ssh -X` vs `-Y`, what the
  protocol costs on a link, the other X servers, and why Xwayland works
  where native Wayland structurally cannot.
- [security.md](security.md) — the threat model, plainly: X11 has no
  isolation between clients, `$XAUTHORITY` is a password, and what
  react-x11 does and does not defend against.
- [packaging.md](packaging.md) — four ways to ship an app, with the two
  esbuild flags that are load-bearing and the one tier that does not work.
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

## Entry points

```js
import { createRoot, Select } from 'react-x11';
```

### `await createRoot(options?)` → `{ app, render(element), unmount() }`

The entry point. With no options it connects to the X server named by
`$DISPLAY`; the returned `app` is the [ntk](https://github.com/sidorares/ntk)
App, one X connection.

**Every root without `app` opens its own connection and owns it**, so two
roots are two independent trees, and `await root.unmount()` closes what it
opened — without which the socket stays up and the process does not exit.
A root given an `app` borrows it and never closes it: that connection
belongs to whoever made it.

| option                                                 |                                                         |
| ------------------------------------------------------ | ------------------------------------------------------- |
| `display`                                              | `':1'`, `'host:0.0'`, a socket path. Default `$DISPLAY` |
| `app`                                                  | render into a connection you already have               |
| `stream`                                               | an already-connected duplex stream                      |
| `fontSource`                                           | pluggable system-font lookup — ntk's docs/fonts.md      |
| `glxVisual`                                            | visual id for `getContext('opengl')`                    |
| `onXError`                                             | X protocol errors nothing claimed. Default warns        |
| `onUncaughtError` `onCaughtError` `onRecoverableError` | `(error, errorInfo)`; default logs the component stack  |
| `onDisconnect(reason, err)`                            | the connection ended — `'closed'` or `'error'`          |

`display`, `stream`, `fontSource`, `glxVisual` and `onXError` go straight
to ntk's `createClient`. Anything else it understands, build the client
yourself and pass it as `app` — which is also how the hermetic tests drive
the renderer against node-x11's in-process X server:

```js
import xserver from 'x11/lib/xserver/index.js';

const server = xserver.createServer({ width: 640, height: 480 });
const [serverEnd, clientEnd] = xserver.createStreamPair();
server.addClientStream(serverEnd);
const root = await createRoot({ stream: clientEnd }); // no $DISPLAY needed
```

`onUncaughtError` covers one channel React does not: a throw from an **event
handler**, which no error boundary can catch because the handler ran from an
X event rather than a render. See
[events.md](events.md#when-a-handler-throws).

`onDisconnect` fires when the connection ends without being asked to —
server exit, ssh drop, kill — and not for one this root closed. It invites
a reconnect loop, so: **a reconnect is not a reconnect.** Every window id,
pixmap, glyph set and font is invalidated with the connection. Tear the
root down and build a new one; nothing survives, and react-x11 promises
nothing more than telling you it happened.

`root.render(element, callback?)` flushes the mount or update synchronously
(`updateContainerSync` + `flushSyncWork`); painting happens a frame later on
ntk's frame clock.

## Environment variables

| variable                         | effect                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `DISPLAY`                        | X server to connect to (standard X11)                                                    |
| `REACT_X11_DEVTOOLS=1`           | connect to a running `react-devtools` (see devtools.md)                                  |
| `REACT_X11_DEVTOOLS_HOST`        | devtools host (default `localhost`)                                                      |
| `REACT_X11_DEVTOOLS_PORT`        | devtools port (default `8097`)                                                           |
| `REACT_X11_DEBUG_LAYOUT=1`       | outline every laid-out node, color-coded by tree depth                                   |
| `REACT_X11_CLICK_TO_COMPONENT=1` | Alt+Click opens the clicked element's source, using `cursor` (see click-to-component.md) |
| `REACT_X11_EDITOR`               | editor CLI for click-to-component — setting this alone also enables it                   |

- [glx.md](glx.md) — how the 3D scene works over indirect GLX: what the
  protocol encodes, why display lists are mandatory, and what can never work
