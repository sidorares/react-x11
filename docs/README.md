# react-x11 documentation

- [elements.md](elements.md) — the host elements: `<window>`, `<popup>`,
  `<box>`, `<scrollview>`, `<text>`, `<textinput>`, `<textarea>`, `<image>`, `<canvas>`,
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
- [events.md](events.md) — the synthetic event system: dispatch phases,
  event object shape, focus, cursors, default actions.
- [typescript.md](typescript.md) — the bundled types: one tsconfig option,
  why JSX comes from `react-x11/jsx-runtime` rather than an augmentation,
  and how the declarations are kept from drifting.
- [extending.md](extending.md) — `registerElement()` and the subpath
  exports: adding a host element from outside the package, the node
  contract, and the two definition fields that fail far from their cause.
- [testing.md](testing.md) — `react-x11/test`: render, query, drive and
  assert on real pixels, against a real X server in your test process. No
  display, no xvfb.
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
import { createRoot, render, unmountComponentAtNode, Select } from 'react-x11';
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

### `render(element, callback?, container?)`

Legacy entry point. Without `container` it connects first and returns a
promise. Mounts/updates are flushed synchronously
(`updateContainerSync` + `flushSyncWork`); painting happens a frame later
on ntk's frame clock.

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
