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
anything.

![react-devtools-x11](https://cloud.githubusercontent.com/assets/173025/24536323/6af97598-1625-11e7-88d4-74f429b7f470.gif)

## Elements

Only `<window>` and `<popup>` map to real X11 windows. Everything else is
laid out by yoga and drawn client-side into the window's double-buffered 2d
context — see [NEXT_STEPS.md](NEXT_STEPS.md) for why.

| element        | what it is                                                                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<window>`     | a real X11 window; the flex, paint and event root. Props: `title` (UTF-8 via ntk ≥ 3.1), `width`, `height`, `x`, `y`, `backgroundColor`, `onResize`, …                                                                 |
| `<popup>`      | an override-redirect window at screen coordinates — menus, tooltips, dropdowns. May appear anywhere in the JSX tree; anchor with `ev.nativeEvent.rootx/rooty`                                                          |
| `<box>`        | flex container. Layout props (`flexDirection`, `flexGrow`, `padding`, `gap`, `position`, …) plus `backgroundColor`, `borderWidth/Color/Radius`, `overflow`, `zIndex`                                                   |
| `<scrollview>` | clipped, wheel-scrollable viewport with a drawn scrollbar; `scrollTo`/`scrollBy` on the ref, `onScroll`                                                                                                                |
| `<text>`       | shaped, wrapped text (bidi, ligatures, fallback via ntk). Strings are only legal inside `<text>`; nested `<text>` elements are style spans. `fontSize`, `fontFamily`, `fontWeight`, `color`, `textAlign`, `lineHeight` |
| `<textinput>`  | single-line editable text: caret, selection, Ctrl+C/X/V (CLIPBOARD), middle-click paste + select-to-own (PRIMARY), controlled (`value`/`onChange`) or uncontrolled (`defaultValue`), `placeholder`, `onSubmit`         |
| `<image>`      | PNG/JPEG from `src`, natural-size aware                                                                                                                                                                                |
| `<canvas>`     | escape hatch: `onDraw={(ctx, {width, height}) => …}` with ntk's canvas-like 2d context (XRender-backed)                                                                                                                |

On top of the primitives the package exports widget **components** (plain
React, no reconciler support needed): `Select` — a dropdown built on
`<popup>` with keyboard support and a themable appearance
(`SelectThemeProvider`).

Events are synthetic with capture/bubble phases and hit testing over the
drawn tree: `onClick`, `onMouseDown/Up/Move`, `onMouseEnter/Leave`,
`onWheel` (default action scrolls the nearest `<scrollview>`),
`onKeyDown/Up`, plus `focusable`, `onFocus`/`onBlur` and Tab traversal.
Handlers always see current props (no stale closures). A `cursor` prop
(`"pointer"`, `"text"`, …) changes the pointer while a node is hovered, and
`borderStyle="dashed"` draws dashed borders (both need ntk ≥ 3.2.0;
silently inert/solid on older ntk). User handlers run before element
default actions — `ev.preventDefault()` in `onKeyDown` stops a
`<textinput>` from editing, like the DOM.

## Example

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

## Trying it out

Clone this repo and from its folder run

```sh
npm install
```

Running the examples needs an X server (a linux desktop, Xvfb, or XQuartz on
macOS) with `DISPLAY` set. `npm test` needs no X server at all: node-x11
ships an in-process pure-JS X server that the integration tests render into
and read pixels back from.

```sh
npm run examples:simple        # hello world (JSX via tsx)
npm run examples:simple-nojsx  # the same, plain node
npm run examples:xeyes         # canvas drawing + hooks
npm run examples:dashboard     # context theming, custom hooks, components
npm run examples:tasks         # useReducer, scrollview, keyboard interaction
npm run examples:menu          # right-click context menu via <popup>
npm run examples:form          # <textinput> + Select dropdowns
```

`REACT_X11_DEBUG_LAYOUT=1` outlines every laid-out node (color = tree
depth) — handy when a flexbox doesn't do what you expect.

## Developing

```sh
npm test          # headless: mock smoke tests + in-process X server pixels
npm run lint      # ESLint
npm run format    # Prettier
```

`REACT_X11_DEVTOOLS=1` connects to a running `react-devtools` instance.

See [AGENTS.md](AGENTS.md) for architecture notes and contributor/agent
guidance, and [NEXT_STEPS.md](NEXT_STEPS.md) for the roadmap.

# See also

https://github.com/chentsulin/awesome-react-renderer
