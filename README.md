# react-x11

[![CI](https://github.com/sidorares/react-x11/actions/workflows/ci.yml/badge.svg)](https://github.com/sidorares/react-x11/actions/workflows/ci.yml)

React custom rendering where side effects are communication with an [X11
server](https://www.x.org/wiki/Documentation/): react-like ergonomics on top
of [ntk](https://github.com/sidorares/ntk). Build small GUI programs for the
X Window environment (a linux desktop, or macOS +
[XQuartz](https://www.xquartz.org/)) with your React / React Native
experience — flexbox layout, components, hooks, synthetic events.

Everything is JavaScript all the way down: ntk /
[node-x11](https://github.com/sidorares/node-x11) implement the X11 protocol
in pure JS (think xlib rewritten in node.js), layout is
[yoga-layout](https://www.npmjs.com/package/yoga-layout), text shaping is
[fontkit](https://github.com/foliojs/fontkit). `npm install` never compiles
anything — and `npm test` doesn't even need an X server (node-x11 ships an
in-process pure-JS X server that the tests render into and read pixels back
from; every screenshot below was rendered that way too, by driving the real
examples through the real event pipeline).

| `examples/dashboard.jsx` — context theming, hooks | `examples/tasks.jsx` — useReducer, textinput, scrollview |
| ------------------------------------------------- | -------------------------------------------------------- |
| ![dashboard](docs/img/dashboard.png)              | ![tasks](docs/img/tasks.png)                             |

| `examples/form.jsx` — textinput + Select | the open Select menu (a real `<popup>` window) |
| ---------------------------------------- | ---------------------------------------------- |
| ![form](docs/img/form.png)               | ![select menu](docs/img/select-menu.png)       |

## Quick start

```sh
npm install react-x11 react
```

```jsx
import React, { useState } from 'react';
import { createRoot } from 'react-x11';

function Counter() {
  const [n, setN] = useState(0);
  return (
    <window width={240} height={120} title="counter" backgroundColor="#f4f4f4">
      <box flexGrow={1} alignItems="center" justifyContent="center" gap={10}>
        <text fontSize={24}>{String(n)}</text>
        <box
          backgroundColor="#2980b9"
          borderRadius={6}
          padding={8}
          cursor="pointer"
          onClick={() => setN(n + 1)}
        >
          <text color="white">+1</text>
        </box>
      </box>
    </window>
  );
}

const root = await createRoot(); // connects via $DISPLAY
root.render(<Counter />);
```

Run it with `tsx` or any JSX-capable loader — or skip JSX entirely with
`React.createElement` (see
[`examples/simple-nojsx.js`](examples/simple-nojsx.js), plain node, no build
step).

## Elements

Only `<window>` and `<popup>` map to real X11 windows. Everything else is
laid out by yoga and drawn client-side into the window's double-buffered 2d
context — see [NEXT_STEPS.md](NEXT_STEPS.md) for the architecture rationale
and [docs/](docs/README.md) for the full API reference.

| element        | what it is                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `<window>`     | a real X11 window; the flex, paint and event root                                                                    |
| `<popup>`      | an override-redirect window at screen coordinates — menus, tooltips, dropdowns                                       |
| `<box>`        | flex container: layout props → yoga, plus backgrounds, borders (solid/dashed, radius), overflow clipping, zIndex     |
| `<scrollview>` | clipped, wheel-scrollable viewport with a drawn scrollbar                                                            |
| `<text>`       | shaped, wrapped text (bidi, ligatures, font fallback); nested `<text>` elements are style spans                      |
| `<textinput>`  | single-line editor: caret/selection via ntk's TextLayout caret API, clipboard (CLIPBOARD + X11 PRIMARY), word select |
| `<image>`      | PNG/JPEG from `src`, natural-size aware                                                                              |
| `<canvas>`     | escape hatch: `onDraw={(ctx, {width, height}) => …}` with ntk's canvas-like 2d context (XRender-backed)              |
| `<markdown>`   | ntk MarkdownView: headings, tables, highlighted fences, math, mermaid; `onLink`                                      |
| `<html>`       | ntk HtmlView: CSS cascade, block/flex layout, images; `onLink`                                                       |
| `<svg>`        | static SVG through ntk SvgView, sized like `<image>`                                                                 |
| `<tex>`        | a KaTeX formula (ntk `layoutTex`), intrinsically sized                                                               |

Widget **components** (plain React on top of the primitives): `Select` — a
dropdown built on `<popup>`, themable via `SelectThemeProvider`.

Events are synthetic with capture/bubble phases and hit testing over the
drawn tree: `onClick` (with DOM-style `detail` click counting),
`onMouseDown/Up/Move`, `onMouseEnter/Leave`, `onWheel`, `onKeyDown/Up`,
`focusable` + `onFocus`/`onBlur` + Tab traversal, and a `cursor` prop.
User handlers run before element default actions and can
`ev.preventDefault()` — stopping a `<textinput>` from editing or a
`<scrollview>` from scrolling, like the DOM.

## Examples

All need an X server (`DISPLAY` set; XQuartz on macOS, Xvfb for automation):

```sh
npm run examples:simple        # hello world (JSX via tsx)
npm run examples:simple-nojsx  # the same, plain node — no build step
npm run examples:xeyes         # canvas drawing + hooks
npm run examples:dashboard     # context theming, custom hooks, components
npm run examples:tasks         # useReducer, textinput, scrollview
npm run examples:menu          # right-click context menu via <popup>
npm run examples:form          # <textinput> + Select dropdowns
```

## React DevTools

```sh
npx react-devtools                                # 1. start the standalone UI
REACT_X11_DEVTOOLS=1 npm run examples:dashboard   # 2. run any example with the bridge on
```

The component tree, props and hook state show up live in the DevTools
window; selecting a component inspects it, and hovering an element in the
tree tints its rect in the X11 window (highlight-on-hover).
`REACT_X11_DEVTOOLS_HOST` / `REACT_X11_DEVTOOLS_PORT` override the default
`localhost:8097`. See [docs/devtools.md](docs/devtools.md).

Two more debugging aids:

- `REACT_X11_DEBUG_LAYOUT=1` outlines every laid-out node (color = tree
  depth) — handy when a flexbox doesn't do what you expect.
- refs give you the retained node (`abs` rect, `scrollTo`, …) for drawn
  elements, or the live [ntk](https://github.com/sidorares/ntk) window for
  `<window>`/`<popup>` — the whole ntk API is a ref away.

## Developing

```sh
npm test             # hermetic: mock smoke tests + in-process X server pixels
npm run lint         # ESLint
npm run format       # Prettier
npm run screenshots  # regenerate docs/img/*.png headlessly (no X server)
```

See [AGENTS.md](AGENTS.md) for architecture notes and contributor/agent
guidance, [docs/](docs/README.md) for API documentation, and
[NEXT_STEPS.md](NEXT_STEPS.md) for the roadmap.

# See also

https://github.com/chentsulin/awesome-react-renderer
