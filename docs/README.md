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
- [devtools.md](devtools.md) — React DevTools integration and other
  debugging aids.
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

### `await createRoot(container?)` → `{ app, render(element), unmount() }`

The modern entry point. Without a `container` it connects to the X server
named by `$DISPLAY` (the returned `app` is the [ntk](https://github.com/sidorares/ntk)
App — one X connection). Pass an existing ntk App (or a mock) to render
into it — that's how the hermetic tests drive the renderer against
node-x11's in-process X server:

```js
import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

const server = xserver.createServer({ width: 640, height: 480 });
const [serverEnd, clientEnd] = xserver.createStreamPair();
server.addClientStream(serverEnd);
const app = await createClient({ stream: clientEnd });
const root = await createRoot(app); // no $DISPLAY needed
```

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
