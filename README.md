# react-x11

[![CI](https://github.com/sidorares/react-x11/actions/workflows/ci.yml/badge.svg)](https://github.com/sidorares/react-x11/actions/workflows/ci.yml)

**[Documentation](https://sidorares.github.io/react-x11/)** ·
**[Playground](https://sidorares.github.io/react-x11/playground)** — edit
react-x11 and watch it render, in your browser, against a JavaScript X server
running on the page.

A React renderer whose host environment is an [X11
server](https://www.x.org/wiki/Documentation/). React's job in a renderer is
to compute what changed; the renderer's job is to turn that into side effects
on some host — in react-dom those are DOM mutations, here they are **X11
protocol requests** written to a socket. There is no DOM, no HTML and no
browser engine underneath: this is not Electron with a different skin, and
`<div>` is not an element that exists. Build GUI programs for the X Window
environment (a linux desktop, or macOS +
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

### The wire carries drawing, not pixels

react-x11 does not rasterize a frame on the client and ship the buffer
across. React reconciles the component tree, the renderer turns that diff
into **drawing operations** — rounded rectangles, composited gradients, clip
regions, runs of glyph indices — and the X server executes them. The server
owns the pixels; the client never had them.

That is what X's RENDER extension is for. Text is shaped once and its glyphs
uploaded once, so drawing a line afterwards names them by index, about a byte
per glyph; gradients, scaling, alpha compositing and clipping are single
server-side requests rather than loops over a pixel array; nothing is read
back. An update costs what the _drawing_ costs, not what the window's area
costs. Going full-screen on a 4K panel does not multiply your bandwidth,
because you were not sending pixels at 1080p either — which is why this
stays comfortable on a display forwarded over ssh. Mounting a window with
forty rows and their labels is 86 requests and 3.6 KB on the wire.

Because that is the design it is measured rather than assumed: `npm run
bench` reports requests, bytes, replies, RENDER composites and the pixel area
those composites touch, against a checked-in baseline.

### Where this fits

X11 is the wire protocol, which means the display can be somewhere the
program is not, and the program can be somewhere a browser engine cannot go.
That is the shape of the problem this is good at:

- **the display is elsewhere** — a headless server over `ssh -X`, a
  container pointed at the host, a thin client, an X terminal, a
  deliberately dumb workstation. A whole window appears for under four
  kilobytes, because what crosses the link is drawing rather than pixels
  ([docs/remote.md](docs/remote.md));
- **the machine cannot afford a browser engine** — a kiosk, an appliance, an
  instrument panel, an ARM board with 512 MB, a locked-down box where
  installing must not compile anything and root is not on offer;
- **you want the UI in the same process as the rest of your program** —
  `fs`, `serialport`, `pg` and your components in one heap, one event loop,
  no IPC bridge and no second bundler;
- **you want GUI tests that run in CI with no display server** — `npm test`
  here renders real pixels through the real protocol into node-x11's
  in-process X server, on a machine with no `$DISPLAY`, on macOS. That
  harness is published as `react-x11/test`
  ([docs/testing.md](docs/testing.md)).

And the shape it is not good at, so you can stop here rather than in week
three:

- **three platforms.** X11 only. macOS means XQuartz — a separate install, a
  non-native look and no menu bar integration. Windows is out; if you need
  Windows, use Electron or Tauri.
- **native Wayland.** There is no Wayland backend and there is not going to
  be one; that would be a different renderer, not a flag. Ordinary
  application windows work fine on a Wayland desktop through Xwayland, which
  is not going away — but the desktop-shell half of X11 (panel struts,
  global key grabs, screen capture, and the window-manager example below)
  needs a real X session.
- **reusing web components.** There is no DOM. Your MUI, your Tailwind and
  your `recharts` do not come with you; the state, data-fetching, validation
  and math libraries mostly do. [docs/ecosystem.md](docs/ecosystem.md) says
  which is which, and what the failure looks like when it is the wrong one.
- **rendering HTML.** There is no HTML element and no webview. Rich
  documents are markdown, through `<Markdown>` in
  [`@react-x11/components`](https://github.com/sidorares/react-x11-components).
- **text entry outside Latin.** See [Known issues](#known-issues).

| `examples/dashboard.jsx` — context theming, hooks | `examples/tasks.jsx` — useReducer, textinput, scrolling |
| ------------------------------------------------- | ------------------------------------------------------- |
| ![dashboard](docs/img/dashboard.png)              | ![tasks](docs/img/tasks.png)                            |

| `examples/form.jsx` — textinput + Select | the open Select menu (a real `<popup>` window) |
| ---------------------------------------- | ---------------------------------------------- |
| ![form](docs/img/form.png)               | ![select menu](docs/img/select-menu.png)       |

`examples/three.jsx` — a react-three-fiber-shaped scene over **indirect
GLX**: `<mesh>`, geometries, materials, lights and a texture, drawn by
sending the GL protocol over the X connection. No native bindings, no GPU
driver bindings — the same "JavaScript all the way down" story as the rest.

![3D over indirect GLX](docs/img/three.png)

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
    <window
      width={240}
      height={120}
      title="counter"
      style={{ backgroundColor: '#f4f4f4' }}
    >
      <box
        style={{
          flexGrow: 1,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
        }}
      >
        <text style={{ fontSize: 24 }}>{String(n)}</text>
        <box
          style={{
            backgroundColor: '#2980b9',
            borderRadius: 6,
            padding: 8,
            cursor: 'pointer',
            ':hover': { backgroundColor: '#1f6693' },
          }}
          onClick={() => setN(n + 1)}
        >
          <text style={{ color: 'white' }}>+1</text>
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

Only `<window>`, `<popup>` and `<glarea>` map to real X11 windows.
Everything else is laid out by yoga and drawn client-side into the window's
double-buffered 2d context — see [NEXT_STEPS.md](NEXT_STEPS.md) for the architecture rationale
and [docs/](docs/README.md) for the full API reference.

| element       | what it is                                                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<window>`    | a real X11 window; the flex, paint and event root                                                                                                                                                  |
| `<popup>`     | an override-redirect window at screen coordinates — menus, tooltips, dropdowns                                                                                                                     |
| `<box>`       | flex container: layout props → yoga, plus backgrounds, borders (solid/dashed, radius), overflow clipping, zIndex. `overflow: 'scroll'` makes it a wheel-scrollable viewport with a drawn scrollbar |
| `<text>`      | shaped, wrapped text (bidi, ligatures, font fallback); nested `<text>` elements are style spans                                                                                                    |
| `<textinput>` | single-line editor: caret/selection via ntk's TextLayout caret API, clipboard (CLIPBOARD + X11 PRIMARY), word select, undo/redo, right-click menu                                                  |
| `<image>`     | PNG/JPEG from `src`, natural-size aware                                                                                                                                                            |
| `<canvas>`    | escape hatch: `onDraw={(ctx, {width, height}) => …}` with ntk's canvas-like 2d context (XRender-backed)                                                                                            |
| `<svg>`       | static SVG through ntk SvgView, sized like `<image>`                                                                                                                                               |
| `<glarea>`    | an OpenGL surface over indirect GLX; the 3D scene below lives inside it                                                                                                                            |

Widget **components** (plain React on top of the primitives, themable via
`ThemeProvider`): `Button`, `Checkbox`, `Radio`/`RadioGroup`, `Switch`,
`Slider`, `ProgressBar`, `Select`, `Tooltip`, `MenuBar`/`ContextMenu`,
`Calendar`/`DatePicker` — one date or a range, with days blockable and a
seam for drawing into the cells — `PasswordInput`, whose mask is a scribble
that moves on every keystroke rather than a countable row of bullets —
`Dialog` — a modal built on
`<popup trapFocus>`, which traps Tab and restores focus when it closes —
plus the two containers an application window is built from: `Tabs`, `Tree`
and `SplitPane`. See
[docs/components.md](docs/components.md).

**The menu bar goes where the desktop keeps menus.** On Plasma, on a panel
running `vala-panel-appmenu`, or under one of the GNOME extensions that add a
menu bar, `<MenuBar menus={…}/>` hands its menu to the panel over
`com.canonical.dbusmenu` and stops drawing one; everywhere else it draws the
bar itself. No configuration, and the same line of JSX either way — the item
descriptors are dbusmenu's own vocabulary, so the array that draws the menu is
the array that serialises. `npm run globalmenu:host` is a panel in a terminal,
for seeing it work on a desktop that has none. See
[docs/globalmenu.md](docs/globalmenu.md).

**`myapp://` links open the app that is already running.**
`registerApplication({ appId, schemes })` before `createRoot()` owns the app's
name on the bus, exports `org.freedesktop.Application`, and — on the half of
all desktops where `xdg-open` ignores D-Bus activation and spawns a second copy
with the URI in `argv` — forwards it to the first copy and tells that copy to
exit. `useAppOpen()` receives the link, buffered and replayed if it arrived
before the tree mounted, and `activateWindow()` brings the window forward with
the launch's own timestamp, without which a window manager declines and the
taskbar entry just blinks. The OAuth redirect this is for has an easier answer
that needs none of it, and the page says so first. See
[docs/uri-schemes.md](docs/uri-schemes.md).

**Drag and drop** works with the rest of the desktop: `<box dropAccept={['files']}
onDrop={…}>` takes a file dragged out of Nautilus, and `<box draggable dragData={…}>`
can be dropped into a file manager or an editor. Drags that stay inside the
app never touch the wire and hand their payload over by reference, so a
reorderable list and a cross-application file drop are the same two props.
See [docs/drag-and-drop.md](docs/drag-and-drop.md).

### 3D

Inside a `<glarea>` (or the `Canvas3D` component) the children are scene
elements with react-three-fiber's names:

```jsx
<Canvas3D style={{ flexGrow: 1 }} camera={{ position: [0, 2, 6], fov: 45 }}>
  <ambientLight intensity={0.35} />
  <pointLight position={[5, 6, 6]} />
  <mesh rotation={[0.5, 0.4, 0]} onClick={() => pick()}>
    <boxGeometry args={[1.4, 1.4, 1.4]} />
    <meshPhongMaterial color="#2980b9" shininess={60} />
  </mesh>
</Canvas3D>
```

`<mesh>`, `<group>`, box/plane/sphere/cylinder/torus geometries,
`<bufferGeometry>`, basic/Lambert/Phong materials with textures, four light
types, and pointer events resolved by client-side raycasting. Each geometry
is compiled into a **server-side display list** once, so a frame costs
matrices plus one `CallList` per mesh whatever the triangle count. What the
protocol cannot do — shaders, instancing, post-processing, shadows — throws
with the reason rather than half-working. See
[docs/elements.md](docs/elements.md#3d-scene-mesh-group-geometries-materials)
and [docs/glx.md](docs/glx.md).

Events are synthetic with capture/bubble phases and hit testing over the
drawn tree: `onClick` (with DOM-style `detail` click counting),
`onMouseDown/Up/Move`, `onMouseEnter/Leave`, `onWheel`, `onKeyDown/Up`,
`focusable` + `onFocus`/`onBlur` + Tab traversal, and a `cursor` prop.
User handlers run before element default actions and can
`ev.preventDefault()` — stopping a `<textinput>` from editing or a
a scroll container from scrolling, like the DOM.

## Examples

All need an X server — but "an X server" is a broader thing than it sounds:
your Linux desktop, XQuartz on macOS, `Xvfb` for automation, `Xephyr` for a
disposable screen, a VNC server, or your own display reached over `ssh -X`
from wherever the program actually runs — see
[docs/remote.md](docs/remote.md), which is the case this architecture is
categorically better at.
[`examples/README.md`](examples/README.md) describes each one and how to
explore them:

```sh
npm run examples:simple        # hello world (JSX via tsx)
npm run examples:app           # the showcase: Tabs + SplitPane hosting the rest
npm run examples:theming       # three themes x light/dark, and a size query
npm run examples:simple-nojsx  # the same, plain node — no build step
npm run examples:xeyes         # canvas drawing + hooks
npm run examples:dashboard     # context theming, custom hooks, components
npm run examples:tasks         # useReducer, textinput, scrolling
npm run examples:menu          # right-click context menu via <popup>
npm run examples:transparent   # rounded translucent <popup transparent>
npm run examples:form          # <textinput> + Select dropdowns
npm run examples:datepicker    # Calendar/DatePicker: ranges, blocked days, events
npm run examples:password      # PasswordInput: the scribble mask, and a custom one
npm run examples:gl            # raw GL in a <glarea> (display-list cube)
npm run examples:three         # <Canvas3D> scene: meshes, lights, textures
npm run examples:wm            # a reparenting window manager (see below)
```

The two GL examples additionally need a server with **indirect GLX**
enabled (`+iglx` / `AllowIndirectGLX` — off by default on many).

### Window manager

`examples:wm` is a real reparenting window manager: it takes over the root
window, puts every application's window inside a frame it draws, and moves,
resizes, focuses and closes them. The frames are ordinary react-x11
`<window>`s — the titlebar, the buttons and the eight resize handles are
components with `onMouseDown` handlers, and the application is a foreign X
window reparented inside.

Only one window manager may own a display, so run it against a nested
server rather than the one managing your desktop:

```sh
Xephyr :10 -screen 1200x800 &
DISPLAY=:10 npm run examples:wm
DISPLAY=:10 xterm &                    # give it something to manage
```

To have it manage your real session instead — including replacing
`quartz-wm` on macOS, which XQuartz has a hook for — see
[`examples/README.md`](examples/README.md#the-window-manager).

### Hot reloading

```sh
npm run examples:tasks:hot     # then edit examples/tasks.jsx while it runs
```

Runs the tasks example under the supported hot-reload entry point,
`react-x11/refresh` (`node --import react-x11/refresh/register`, Node ≥
22.15), with React **Fast Refresh**: saving `examples/tasks.jsx` updates
the edited components in place. The X11 connection, the mounted window,
and component state — the task list, even half-typed text in the input —
survive the reload (a component whose hook signature changed remounts
alone). Any app adopts it the same way — no accept handlers, no loader
files to copy; see
[docs/ecosystem/dev-tooling.md](docs/ecosystem/dev-tooling.md#react-refresh).

## React DevTools

```sh
npx react-devtools                                # 1. start the standalone UI
REACT_X11_DEVTOOLS=1 npm run examples:dashboard   # 2. run any example with the bridge on
```

The component tree, props and hook state show up live in the DevTools
window, and editing any of them re-renders the app. Hovering an element in
the tree tints its rect in the X11 window; the toolbar's crosshair picks an
element by clicking it in the app; "highlight updates when components
render" outlines the rects that just re-rendered; the style editor edits a
selected element's style live; and the Profiler can restart the app to
record its mount. `REACT_X11_DEVTOOLS_HOST` / `REACT_X11_DEVTOOLS_PORT`
override the default `localhost:8097`. See
[docs/devtools.md](docs/devtools.md).

Two more debugging aids:

- `REACT_X11_DEBUG_LAYOUT=1` outlines every laid-out node (color = tree
  depth) — handy when a flexbox doesn't do what you expect.
- refs give you the retained node (`abs` rect, `scrollTo`, …) for drawn
  elements, or the live [ntk](https://github.com/sidorares/ntk) window for
  `<window>`/`<popup>` — the whole ntk API is a ref away.

## Click to component

```sh
REACT_X11_EDITOR=code npm run examples:tasks
```

Alt+Click any rendered element (Option+Click on macOS/XQuartz) to open the
JSX line that created it in your editor. `REACT_X11_EDITOR` picks the CLI
and enables the feature in one go; `REACT_X11_CLICK_TO_COMPONENT=1` does
the same with the default editor
(`cursor`). See [docs/click-to-component.md](docs/click-to-component.md).

## TypeScript

Types ship with the package — no `@types/react-x11` to install. Point JSX at
react-x11 and the X11 elements type-check:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react-x11",
  },
}
```

```tsx
import { createRoot, createStyles, Button } from 'react-x11';
import type { MouseEvent } from 'react-x11';

const s = createStyles({
  root: { flexGrow: 1, padding: 12, gap: 8 },
  //          ^ flexDirection: 'sideways' would not compile,
  //            and neither would a layout property inside ':hover'
});

<window title="hi" width={320} height={200} style={s.root}>
  <box onClick={(ev: MouseEvent) => console.log(ev.detail)}>
    <text style={{ fontSize: 18 }}>hello</text>
  </box>
  <Button primary onPress={() => {}}>
    ok
  </Button>
</window>;
```

`jsxImportSource` is what makes `<div>` an error rather than something that
compiles and then throws at runtime: react-x11 owns the JSX namespace
instead of adding to React's, which it could not do anyway — `text`,
`image`, `canvas`, `html` and `svg` are all DOM element names too, with
incompatible props.

Style props, element props, event objects, ref types and every widget are
typed; `style` accepts the same nested arrays with falsy entries the runtime
does. See [docs/typescript.md](docs/typescript.md).

## Developing

```sh
npm test             # hermetic: mock smoke tests + in-process X server pixels
npm run typecheck    # tsc over the declarations and the type tests
npm run lint         # ESLint
npm run format       # Prettier
npm run screenshots  # regenerate docs/img/*.png headlessly (no X server)
npm run docs:dev     # the documentation site (npm install in website/ first)
```

`docs/img/three.png` is the exception: the headless path has no GL, so the
3D shot is captured by hand from `npm run examples:three` on a real server
with indirect GLX.

See [AGENTS.md](AGENTS.md) for architecture notes and contributor/agent
guidance, [docs/](docs/README.md) for API documentation, and
[NEXT_STEPS.md](NEXT_STEPS.md) for the roadmap.

The [documentation site](https://sidorares.github.io/react-x11/) lives in
[`website/`](website/) and renders `docs/` rather than repeating it — edit
`docs/` and the site follows. Its playground bundles this repo's `src/` for
the browser, so `npm run docs:test` fails when a demo stops matching the API.

## Known issues

Two that are worth knowing before you hit them, both predating the current
release and both tracked:

- **`sans-serif` can resolve to a CJK font on macOS**
  ([#86](https://github.com/sidorares/react-x11/issues/86)). Font families
  are resolved by shelling out to `fc-match`, which follows `PATH`;
  Homebrew's fontconfig ships no macOS system-font aliases and answers
  Hiragino Sans. Latin looks fine, Cyrillic comes out on full-width
  advances. Put `/opt/X11/bin` first on `PATH` until this is fixed.
- **AltGr levels do not work, and there is no input method.** `@` on a
  German layout, `€`, `ł`, `ã` on US-International: the core keyboard map
  cannot say whether the third and fourth keysyms on a key are a second
  layout or a third and fourth level, so they are read as a layout and left
  alone. Dead keys, Compose and layout switching all work
  ([docs/events.md](docs/events.md)); what is absent is an ibus/fcitx/XIM
  backend, so CJK is not partially working — it is structurally absent.

## Security

X11 has no isolation between clients: any program on a display can read any
other program's window contents, grab the keyboard, and synthesize or record
input. That is the 1987 design, not a gap in this library, and it cuts both
ways — do not run untrusted programs on a display you use, and do not treat
a react-x11 window as a confidential surface. Your `$XAUTHORITY` cookie is a
bearer token; treat it like a password.

`ssh -X` runs your app as an untrusted client and restricts most of the
above; `ssh -Y` turns the restrictions off. **Prefer `-X` — react-x11 should
work under it, and if it does not, that is a bug worth filing.**

The full threat model, including what react-x11 does and does not defend
against, is [docs/security.md](docs/security.md). To report something,
[SECURITY.md](SECURITY.md).

## See also

- [awesome-react-renderer](https://github.com/chentsulin/awesome-react-renderer)
  — the catalogue of React renderers, which is how most people find things
  like this.
- [ntk](https://github.com/sidorares/ntk) — the toolkit underneath: windows,
  the XRender-backed 2d context, the text stack, the frame clock.
- [node-x11](https://github.com/sidorares/node-x11) — the X11 protocol in
  JavaScript, including the in-process X server the tests and the playground
  run against.
