---
title: What react-x11 is
sidebar_position: 1
slug: /intro
---

# What react-x11 is

react-x11 is a **React renderer whose host environment is an X11 server**.

There is no DOM and no HTML anywhere in it, and no browser engine underneath
it — this is not Electron with a different skin. React's job in a renderer is
to compute what changed; the renderer's job is to turn that into side effects
on some host. In react-dom those side effects are DOM mutations. Here they
are **X11 protocol requests** — `CreateWindow`, `MapWindow`,
`ConfigureWindow`, `RenderCompositeGlyphs` — written to a socket. `<box>` is
not a `<div>` with different paint; it is a retained layout node the renderer
draws with, and `<div>` is not an element that exists.

```jsx
import React, { useState } from 'react';
import { createRoot } from 'react-x11';

function Counter() {
  const [n, setN] = useState(0);
  return (
    <window width={240} height={120} title="counter">
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

That is a real X11 client. It opens a window on a Linux desktop, on macOS
under [XQuartz](https://www.xquartz.org/), or on a display forwarded over
ssh. You can also
[run it right now in this browser](/playground) — the playground boots a
pure-JavaScript X server on the page and connects to it.

## Everything is JavaScript

`npm install` never compiles anything, and there is no native bridge to a
toolkit:

| layer                                                 | what it does                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| **react-x11**                                         | React primitives, layout, painting policy — decides _how often_ anything is drawn |
| [**ntk**](https://sidorares.github.io/ntk/)           | a canvas-like 2d context, text layout, widgets — owns _how_ drawing is encoded    |
| [**node-x11**](https://sidorares.github.io/node-x11/) | the X11 protocol itself, in pure JS — think xlib rewritten in node                |

Layout is [yoga-layout](https://www.yogalayout.dev/) (WASM), text shaping is
[fontkit](https://github.com/foliojs/fontkit), and drawing goes through the
X **RENDER** extension — so composition, gradients and glyph drawing happen
_in the X server_, and a line of text costs about a byte per glyph on the
wire.

## The wire carries drawing, not pixels

Every renderer has to decide what to send. react-x11 does not rasterize a
frame on the client and ship the buffer across: React reconciles the
component tree, the renderer turns that diff into **drawing operations** —
filled and rounded rectangles, composited gradients, clip regions, runs of
glyph indices — and the X server executes them. The server owns the pixels;
the client never had them.

That is what X's RENDER extension is for, and using it well is most of what
this layer does:

- **Glyphs are uploaded once.** Text is shaped by fontkit, the glyph images
  go into a server-side glyph set, and every subsequent draw names them by
  index — roughly a byte per glyph, whatever the point size.
- **Gradients, scaling, alpha compositing and clipping are server-side
  operations**, single requests rather than loops over a pixel array.
- **The client does not read pixels back.** A request that waits for a reply
  stalls the pipeline, so what the server already told us — atoms, geometry,
  glyph pages — is cached instead of asked for again.

The consequence is that an update's cost tracks the _drawing it implies_,
not the window's area. Repaints are coalesced onto ntk's frame clock and
bounded to the region that changed — a short list of rectangles, so two
changes at opposite corners of the window do not drag everything between them
along — and any subtree that does not reach into that region is skipped
before a single request goes out. A layout change is still a full repaint,
because a node that moved leaves stale pixels where it used to be; even then a
whole-window repaint of a real UI is a few dozen batched operations, not a
framebuffer, which is why a react-x11 program stays comfortable on a display
forwarded over ssh, where shipping frames would not be.

Because that is the design, it is also measured rather than assumed:
`npm run bench` reports requests, bytes, replies, RENDER composites and
**the pixel area those composites touch**, against a checked-in baseline. The
last metric exists because the others hide the most common regression — a
change that adds almost nothing to the wire while multiplying the server's
work.

## What maps to a real X window

Almost nothing, on purpose. Only `<window>`, `<popup>` and `<glarea>` are
real X11 windows. Everything else is a retained lightweight node — one yoga
node each — painted into the owning window's double-buffered 2d context on
ntk's frame clock, with synthetic events dispatched by front-to-back hit
testing.

That is what makes a thousand-row table cheap: a thousand X windows would be
a thousand server-side resources and a thousand expose events, while a
thousand drawn nodes are a layout pass and one repaint.

X windows are also created **top-down in the commit phase**, never in the
render phase — React may discard a render pass, and a discarded pass must not
have opened windows on your screen.

## The feature set

- **[Elements](/docs/reference/elements)** — `<window>`, `<popup>`, `<box>`,
  `<text>`, `<textinput>`, `<textarea>`, `<image>`, `<canvas>`, plus
  rich-content wrappers `<markdown>`, `<html>`, `<svg>` and `<tex>` around
  ntk's document widgets. Any `<box>` or `<window>` scrolls with
  `overflow: 'scroll'`.
- **[Widget components](/docs/reference/components)** — `Button`,
  `Checkbox`, `Radio`, `Switch`, `Slider`, `ProgressBar`, `Select`,
  `Tooltip`, `Dialog`, `MenuBar`/`ContextMenu`, `Tabs`, `SplitPane`
  and a virtualized `Table`. Plain React over the primitives — no reconciler
  support, nothing you could not have written yourself.
- **Flexbox layout** — the same yoga engine React Native lays out with, so
  `flexDirection`, `gap`, `padding` and friends behave the way you expect.
- **[Inline styles with pseudo-states](/docs/reference/styling)** —
  `:hover`, `:focus`, `:active`, `:disabled` in the `style` object. They
  resolve in the renderer as a repaint of one node, with **no React render**,
  because each is something the node already knows about itself.
- **[Window size queries](/docs/reference/styling#window-size-queries)** —
  `'@width >= 600'`, the X11 analogue of `@media`: a style asks about the
  window it is laid out in, not the screen.
- **Theme tokens and transitions** — `backgroundColor: '$panel'` resolves
  against the nearest `theme` above the node, so a hoisted style can still
  follow the theme; `transition: 120` lerps numbers and colours on the
  window's frame clock.
- **[Synthetic events](/docs/reference/events)** — capture and bubble
  phases, `onClick` with DOM-style `detail` click counting, hover
  enter/leave, wheel, keyboard, focus and Tab traversal, `preventDefault()`
  over element default actions, pointer capture, a `cursor` style property.
- **[A subset of react-three-fiber](/docs/reference/elements#3d-scene-mesh-group-geometries-materials)**
  — `<mesh>`, `<group>`, box/plane/sphere/cylinder/torus geometries,
  materials with textures, four light types and raycast pointer events,
  drawn over **indirect GLX**: the GL protocol goes over the same X
  connection. No GPU bindings, no native module.
- **[Hot reloading](/docs/getting-started#hot-reloading)** — React Fast Refresh under
  ESM loader hooks. Edit a component while the program runs and it updates
  in place: the X connection, the window and component state all survive.
- **[React DevTools](/docs/reference/devtools)** — the standard standalone
  app. Component tree, props and hooks, and hovering a component in the tree
  tints its rect in the X11 window.
- **[TypeScript](/docs/reference/typescript)** — declarations ship with the
  package. Set `jsxImportSource: "react-x11"` and the X11 elements type
  check — which is also what makes `<div>` a compile error rather than a
  runtime throw.
- **[Click to component](/docs/reference/click-to-component)** — Alt+Click a
  rendered element to open the JSX line that created it in your editor.

## Things that are unusual about it

- **Your tests do not need an X server.** node-x11 ships a pure-JS X server;
  react-x11's own test suite renders into it and reads pixels back. So does
  every screenshot in these docs, and so does this site's playground.
- **A `ref` is an escape hatch to the layer below.** For drawn elements you
  get the retained node (its absolute rect, `scrollTo`, …); for `<window>`
  and `<popup>` you get the live ntk window, and the whole ntk API with it.
- **It can be the window manager.** The repo's `examples/wm.jsx` is a real
  reparenting WM whose frames — titlebar, buttons, eight resize handles —
  are react-x11 components, with foreign X windows reparented inside them.
- **Protocol cost is a design concern.** `npm run bench` measures requests,
  bytes, replies, RENDER composites and the pixel area those composites
  touch, against a checked-in baseline.

## Where to go next

- **[Getting started](/docs/getting-started)** — install it and run something.
- **[Playground](/playground)** — edit react-x11 and watch it render, with
  no X server at all.
- **[API reference](/docs/reference)** — elements, styling, components,
  events, types.
