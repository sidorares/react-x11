# Elements

Only `<window>`, `<popup>` and `<glarea>` are backed by real X11 windows,
created top-down in React's commit phase so every `CreateWindow` names its
actual parent. Everything else is a retained lightweight node — one
[yoga-layout](https://www.yogalayout.dev/) node each — painted into the
owning window's double-buffered 2d context on ntk's frame clock.

## `style` and props

Everything CSS has a concept for goes in **`style`**; everything else is a
prop. No name means both, which is why `<window width>` is unambiguously the
real window's geometry. See [styling.md](styling.md) for arrays, state
blocks and `createStyles`.

```jsx
<box style={{ flexDirection: 'row', gap: 8 }} onClick={pick}>
  <text style={{ fontSize: 14, color: '#2d3436' }}>hello</text>
</box>
```

## Layout properties (all drawn elements + windows)

Numbers are pixels, strings like `'50%'` / `'auto'` pass through to yoga.

- **Size**: `width`, `height`, `minWidth`, `minHeight`, `maxWidth`,
  `maxHeight`, `aspectRatio`. `<image>` keeps its aspect ratio when only one
  of `width`/`height` is given
- **Flex**: `flexDirection` (`row`, `column`, `row-reverse`,
  `column-reverse`), `justifyContent` (`flex-start`, `center`, `flex-end`,
  `space-between`, `space-around`, `space-evenly`), `alignItems`,
  `alignSelf`, `alignContent`, `flexWrap`, `flexGrow`, `flexShrink`,
  `flexBasis`, `gap`, `rowGap`, `columnGap`
- **Position**: `position` (`relative`, `absolute`, `static`), `top`,
  `right`, `bottom`, `left`
- **Spacing**: `margin`, `marginTop/Right/Bottom/Left`, `padding`,
  `paddingTop/Right/Bottom/Left`
- **Visibility**: `display` (`flex`, `none`), `overflow` (`visible`,
  `hidden`, `scroll`)

**yoga defaults `flexShrink` to 0, where CSS defaults it to 1.** An item
whose base size comes from its content therefore refuses to shrink, and
content wider than the space available pushes the row past its container
instead of being squeezed into it. Write `flex: 1` in full —
`{ flexGrow: 1, flexBasis: 0, minWidth: 0 }` — for anything that should take
the space that is left rather than the space its content wants.
`<scrollview>` applies exactly that to itself by default.

## Paint properties

- `backgroundColor` — any CSS color string (`'#2980b9'`,
  `'rgba(0,0,0,.5)'`, `'red'`)
- `borderWidth`, `borderColor`, `borderRadius`, `borderStyle`
  (`'solid'` default, `'dashed'`)
- `zIndex` — paint/hit order among siblings (stable sort)
- `transition` — `120`, or `{ backgroundColor: 120, left: 200 }`: how long a
  change to that property takes ([styling.md](styling.md#transitions))
- any value may be a **theme token**: `'$panel'` resolves against the nearest
  `theme` prop above the node ([styling.md](styling.md#theme-tokens))
- `'@width >= 600'` blocks restyle for the window's size, layout included
  ([styling.md](styling.md#window-size-queries))
- `opacity` is not implemented yet (see NEXT_STEPS.md)

`cursor` (`'pointer'`, `'text'`, `'wait'`, `'move'`, `'crosshair'`, resize
arrows, … — the ntk cursor name map) and `pointerEvents: 'none'` are style
too: CSS has both, and React Native has been moving `pointerEvents` the same
way.

## Interaction props

`focusable`, `tabIndex` (sequential focus order; `-1` is focusable but not
tabbable), `autoFocus`, `trapFocus` (own a focus scope — Tab and presses
stay inside it, focus is restored when it unmounts), `disabled` (never
focusable, and the trigger for a `:disabled` style block), and the event
handlers listed in [events.md](events.md).

---

## `<window>`

A real X11 window; the flex, paint and event root for its subtree.

| prop                        |                                                                      |
| --------------------------- | -------------------------------------------------------------------- |
| `title`                     | window title (UTF-8, via `WM_NAME` + `_NET_WM_NAME`)                 |
| `width`, `height`, `x`, `y` | window geometry (window state, not yoga style — the user may resize) |
| `backgroundColor`           | full-window clear color (default white)                              |
| `onResize(ev)`              | ConfigureNotify — the tree reflows automatically                     |
| `onExpose(ev)`              | after a repaint was required                                         |
| `onCloseRequest(ev)`        | WM close button (opts into `WM_DELETE_WINDOW`)                       |
| `theme`                     | palette that `$token` style values resolve against, for this subtree |

Windows may be nested inside other windows (real X11 child windows).
**Ref**: the live ntk `Window` — `getContext('2d')`,
`requestAnimationFrame`, `setCursor`, the whole ntk API.

### Stacking

Nested `<window>`s stack the way drawn siblings paint: the later sibling
sits on top, and `zIndex` wins over document order. Reordering them in JSX
restacks the real windows — one `ConfigureWindow` pass per commit, and
nothing at all when mount order already agrees.

```jsx
<window>
  <window key="back" /> {/* bottom */}
  <window key="front" /> {/* on top */}
  <window key="always" zIndex={1} /> {/* above both, wherever it sits here */}
</window>
```

Top-level windows are the window manager's to stack — it redirects the
request — so their order in the tree carries no stacking meaning. Use
`alwaysOnTop` (below) for those.

### Window manager hints

Properties the window manager reads (ntk ≥ 3.5.0). All work at mount and
update; unchanged values are not re-sent. The size hints are flat props like
the geometry they constrain — with style in its own channel the yoga names
are free, so no `sizeHints` object is needed.

| prop          |                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `resizable`   | `false` pins min and max size to the current size                                                                                         |
| size hints    | `minWidth`, `minHeight`, `maxWidth`, `maxHeight`, `widthInc`, `heightInc`, `baseWidth`, `baseHeight`, `minAspect`, `maxAspect`, `gravity` |
| `wmClass`     | `'instance'`, `['instance', 'Class']` or `{instance, class}`                                                                              |
| `windowType`  | `'dialog'`, `'utility'`, `'tooltip'`… or an array of fallbacks                                                                            |
| `alwaysOnTop` | keep above normal windows                                                                                                                 |

```jsx
<window width={400} height={300} resizable={false} windowType="dialog" />
<window width={400} height={300} minWidth={320} minHeight={200} />
```

On a `<window>` these names are the window's, not yoga's: `width`/`height`
are the real geometry the user can drag, and `minWidth`/`maxHeight` are what
the WM enforces. A window's _contents_ are laid out by its `style`.

`alwaysOnTop` uses EWMH `_NET_WM_STATE_ABOVE`, falling back to Apple-WM
window levels on XQuartz, where quartz-wm does not support that state.

## `<popup>`

An override-redirect top-level window at **screen coordinates** — the
window manager ignores it (no decorations, no focus stealing): menus,
tooltips, dropdowns. May appear anywhere in the JSX tree (its position in
the tree does not affect its position on screen); it is its own paint and
event root. Anchor with `ev.nativeEvent.rootx/rooty` (pointer in screen
coordinates) or a ref's `abs` rect plus the owner window's `x`/`y`.
Same props as `<window>`; conditional rendering controls its lifetime.

| prop        |                                                                             |
| ----------- | --------------------------------------------------------------------------- |
| `grab`      | hold a pointer grab while the popup is up — how menus behave on X (below)   |
| `onDismiss` | a press landed outside the popup: close it                                  |
| `trapFocus` | own a focus scope: a modal (see [events.md](events.md#focus-scopes-modals)) |

A popup never receives the X input focus, but nodes inside it can hold the
**owner window's** focus and receive keys — with `trapFocus` and `autoFocus`
that is a modal dialog. See
[Focus inside a `<popup>`](events.md#focus-inside-a-popup).

**`grab` is what makes a menu dismissable.** Without it, a press that lands
anywhere else — another application, the root window, or even this app's own
**window frame**, which belongs to the window manager — never reaches the
client, so the menu stays open behind whatever was clicked. With the grab,
that press is redirected to the popup instead, arrives outside its bounds,
and `onDismiss` fires. The client's own windows still receive their own
presses (X owner-events), so submenus and the owner window keep working
normally, and only the root popup of a menu needs the grab. Needs
ntk ≥ 3.7.0; on older ntk the popup behaves as it did before.

`Select`, `ContextMenu` and `MenuBar` already do this.

Defaults to `windowType="dropdown_menu"`; pass `windowType` to override
(`"tooltip"`, `"popup_menu"`, …). The hint is **additive** — override-
redirect is what keeps the WM from moving or decorating the popup, and
stays on. The EWMH spec asks for the type hint on override-redirect
windows too, so compositing managers can give menus and tooltips
consistent shadows and animations.

## `<box>`

The flex container. All layout + paint + interaction props above.
**Ref**: the retained node — `abs` (`{x, y, width, height}` within the
window, valid after layout).

## `<scrollview>`

A clipped viewport over its (overflowing) children, on **both axes**. Wheel
events scroll it by default; a scrollbar thumb is drawn on each axis that
overflows, and the thumb can be dragged.

The bar belongs to the scroller, not to the content painted under it — the
same rule a browser applies — so a press on the thumb never reaches the row
behind it. Dragging keeps the grip where it was taken, so the thumb does not
jump to the pointer, and a press on the track pages towards it, like
PageUp/PageDown. `<textarea>` behaves the same way, and there a bar press
never moves the caret.

With `flexGrow` and no explicit size it defaults to **`flex-basis: 0`** —
what CSS's `flex: 1` means — so it takes the space left over instead of
being sized by its content. Without that, a header/scrollview/footer window
grows past its own bounds as rows are added and the footer is pushed out of
view. `flexShrink` defaults to `1` and `minHeight`/`minWidth` to `0` for the
same reason. Pass any of them explicitly to opt out.

| prop                |                                                                                  |
| ------------------- | -------------------------------------------------------------------------------- |
| `onScroll(ev)`      | `{scrollX, scrollY, contentWidth, contentHeight, viewportWidth, viewportHeight}` |
| `onViewport(ev)`    | `{width, height, contentWidth, contentHeight}` whenever they change              |
| `scrollbar={false}` | hide the drawn scrollbars                                                        |
| `scrollbarColor`    | thumb color                                                                      |

**Ref**: the node, plus `scrollTo` / `scrollBy` / `scrollIntoView(node)` and
`scrollX` / `scrollY` / `contentWidth` / `contentHeight`.

`scrollTo(y)` takes a number for the vertical axis, as it always has;
`scrollTo({x, y})` moves either, leaving alone whichever you omit.
`scrollBy` matches. `scrollIntoView(node)` scrolls the minimum amount on
both axes.

Horizontal content comes from children that will not shrink — a row of
fixed-width cells, say. The extent is measured **through the subtree**, the
way `scrollWidth` is in a browser: a row that stretches to the viewport
while its own cells overflow it still reports something to scroll. Anything
that clips its own children ends that measurement, since their overflow
belongs to them.

X sends buttons 6 and 7 for a horizontal wheel; **Shift + vertical wheel**
scrolls sideways too, for mice and touchpads that have none. When both bars
show, each stops short of the other's corner.

`onViewport` fires from **layout**, not from scrolling, so it arrives for a
list nobody has scrolled yet. That is what a virtualized list needs before
it can decide how many rows are worth building: layout runs on the frame
clock, after the commit that mounted the node, so an effect cannot read the
size off the ref. `Table` is built on it.

`scrollIntoView(node)` scrolls the minimum amount that makes a descendant
node fully visible, and is safe to call from an effect right after that
node mounts: the request is resolved on the next layout pass, when the
node actually has geometry.

## `<text>`

Shaped, wrapped text through ntk's text stack (bidi, ligatures, kerning,
font fallback). Strings/numbers are only legal inside `<text>`; nested
`<text>` elements are **style spans** — the paragraph is laid out as one
run list so wrapping spans the whole content.

| prop                                                |                                                        |
| --------------------------------------------------- | ------------------------------------------------------ |
| `color`                                             | text color (inherited by spans)                        |
| `fontSize`, `fontFamily`, `fontWeight`, `fontStyle` | ntk font style (fontconfig lookup + fallback)          |
| `textAlign`                                         | `left`, `right`, `center`, `start`, `end` (bidi-aware) |
| `lineHeight`                                        | multiplier over the natural font line height           |

## `<textinput>`

![textinput](img/textinput.png)

Single-line editable text. Caret and selection geometry come from ntk's
`TextLayout.caretPosition`/`indexAt` (ntk ≥ 3.3.0), so positions are exact
across kerning, shaping boundaries and trailing whitespace.

| prop                              |                                            |
| --------------------------------- | ------------------------------------------ |
| `value` + `onChange(text)`        | controlled mode (display follows the prop) |
| `defaultValue`                    | uncontrolled mode                          |
| `onSubmit(text, ev)`              | Enter                                      |
| `placeholder`, `placeholderColor` | shown when empty                           |
| `maxLength`                       | code-point limit                           |
| `selectionColor`, `caretColor`    | selection/caret paint                      |
| text style props                  | as `<text>`                                |

Interactions: click/drag selection, double-click word select, triple-click
select all, Backspace/Delete, arrows (+Shift extends), Home/End, Ctrl+A,
Ctrl+C/X/V on CLIPBOARD, middle-click paste from PRIMARY, selections own
PRIMARY (X11 conventions), **Ctrl+Z / Ctrl+Shift+Z** (Ctrl+Y too) to undo
and redo, and a **right-click menu**. Focusable by default; shows the text
cursor. `ev.preventDefault()` in your `onKeyDown`/`onMouseDown` suppresses
the built-in editing behavior.

### The right-click menu

![the built-in edit menu](img/textinput-menu.png)

Right-clicking gives Undo / Redo / Cut / Copy / Paste / Select All with no
wiring, the way a browser gives `<input>` one — each row live only when it
would do something, and every row running the same code the keyboard
shortcut does. Right-clicking **inside** a selection keeps it (the menu is
about to act on it); outside one, the caret moves there first.

Arrows walk the rows, skipping the disabled ones, Enter chooses, Escape or
a press anywhere outside closes. The selection stays visibly highlighted
while the menu is up, even though the popup holds the keyboard.

To replace it with your own, set `contextMenu={false}` and render a
`ContextMenu` — `onContextMenu` still fires. To suppress it for one event,
call `ev.preventDefault()` in an `onContextMenu` handler.

**Ref**: the node, plus `value`, `undo()` / `redo()` and `canUndo` /
`canRedo` — enough for a toolbar button beside the field.

### Undo

Consecutive typing coalesces into one undo step, so Ctrl+Z takes back a
word rather than a keystroke; a run of Backspaces coalesces the same way.
A run ends at whitespace, at anything that moves the caret (arrows,
Home/End, a click, focus leaving the field), and around edits that are
their own step whatever surrounds them: a paste, a cut, a replaced
selection, Ctrl+Backspace, and a `<textarea>` newline. Undo restores the
selection and puts the caret back where the undone edit started.

Undo is a stack of snapshots of the states the control has shown, capped
at 200. A **controlled** `value` reports the restored text through
`onChange` and waits for the prop to come back, exactly as typing does —
so a parent that filters or rejects a value gets the same say over an undo
that it has over an edit. A value changed from outside (a form reset)
becomes its own entry, and undoing steps back through it.

## `<textarea>`

Multi-line editable text on the same editing core as `<textinput>`:
word-wraps at the content width, Enter inserts a newline (Ctrl+Enter fires
`onSubmit`), Up/Down move between visual lines keeping a goal column,
Home/End go to the start/end of the visual (wrapped) line, selection spans
lines, and the view scrolls vertically to follow the caret (mouse wheel
scrolls too).

| prop            |                                                   |
| --------------- | ------------------------------------------------- |
| `rows`          | preferred height in text lines (default 3)        |
| everything else | as `<textinput>` (`onSubmit` fires on Ctrl+Enter) |

## `<image>`

| prop  |                                     |
| ----- | ----------------------------------- |
| `src` | file path (PNG/JPEG, decoded in JS) |

Sized by style, or measured from the natural size (aspect-preserving
shrink-to-width) when `width`/`height` are not both given.

## `<canvas>`

The escape hatch: a retained node whose content you paint.

```jsx
<canvas
  style={{ flexGrow: 1 }}
  onDraw={(ctx, { width, height, node }) => {
    ctx.fillStyle = 'tomato';
    ctx.fillRect(0, 0, width / 2, height);
  }}
/>
```

`ctx` is ntk's canvas-like 2d context (paths, transforms, gradients incl.
conical, `setLineDash`, round caps/joins, images, text — XRender-backed),
translated to the node's origin and clipped to its bounds. `onDraw` runs on
every repaint of the window.

---

## `<glarea>`

An OpenGL surface in the layout — the only drawn element that owns a real X
window, because GLX needs a drawable created for a GL-capable visual and
cannot share the XRender pipeline the rest of the tree paints through
(NEXT_STEPS §4). Needs ntk ≥ 3.6.0 and a server with **indirect GLX**
enabled (`+iglx` / `AllowIndirectGLX` — off by default on many).

```jsx
<glarea
  style={{ flexGrow: 1 }}
  clearColor="#0b1021"
  frameLoop="always"
  onCreated={(gl) => gl.Enable(gl.DEPTH_TEST)}
  onDraw={(gl, { width, height }) => {
    gl.MatrixMode(gl.PROJECTION);
    gl.LoadIdentity();
    gl.Frustum(-1, 1, -height / width, height / width, 2, 20);
    // ... immediate-mode or display-list drawing
  }}
/>
```

- `onDraw(gl, { width, height, node })` — draw one frame. The viewport is
  set and the buffers are cleared before it, `SwapBuffers` follows it.
- `onCreated(gl, info)` — runs once, when the context is current: one-time
  GL state, texture uploads, display-list compilation.
- `clearColor` — CSS colour or `[r, g, b, a]` floats (default black).
- `frameLoop` — `'demand'` (default) redraws on prop, size and expose
  changes only; `'always'` renders continuously on ntk's frame clock.
- `glx` — a visual spec for ntk's `chooseGLXConfig`, e.g.
  `{ DEPTH_SIZE: 24 }`. One query per app, shared by every `<glarea>`.
- `onError(err)` — no GL surface (no GLX, no matching visual). Without a
  handler the failure is a console warning.

`gl` is ntk's indirect-GLX context: fixed-function OpenGL 1.4 (immediate
mode, matrices, lighting, textures, display lists) — no shaders, no vertex
arrays, since the GLX protocol does not encode them. **Geometry belongs in
display lists**: every immediate-mode vertex is a command on the wire, so a
mesh re-sent per frame costs kilobytes per frame, while a compiled list
costs one `CallList`.

Layout treats it as a leaf: it is sized and positioned like any other node,
and its X window follows that rect. The window is stacked above everything
drawn in the parent, so 2D content cannot overlap it — a HUD needs a
sibling `<popup>`. Pointer events over the surface go to its own window;
`<glarea>` does not take part in the parent's hit testing yet.

`onDraw` is the raw escape hatch; for a scene, put 3D elements inside
(below) and let the renderer drive the GL. See `examples/gl.jsx` for the
raw form, `examples/three.jsx` for the declarative one.

---

## 3D scene: `<mesh>`, `<group>`, geometries, materials

Inside a `<glarea>` (or the [`Canvas3D`](components.md#canvas3d) component
that wraps it) the children are **scene** elements, not drawn ones — a
separate tree with no yoga and no 2D painting, using react-three-fiber's
names wherever the concept survives the translation to fixed-function GL.

```jsx
<Canvas3D style={{ flexGrow: 1 }} camera={{ position: [0, 2, 6], fov: 45 }}>
  <group rotation={[0, angle, 0]}>
    <mesh position={[-1.6, 0, 0]} rotation={[0.5, 0.4, 0]} scale={1.2}>
      <boxGeometry args={[1.4, 1.4, 1.4]} />
      <meshBasicMaterial color="#2980b9" />
    </mesh>
  </group>
</Canvas3D>
```

| element                 | notes                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `<group>`               | transform only; nests children                                                                                   |
| `<mesh>`                | one geometry child + one material child                                                                          |
| `<boxGeometry>`         | `args={[width, height, depth, widthSeg, heightSeg, depthSeg]}`                                                   |
| `<planeGeometry>`       | `args={[width, height, widthSeg, heightSeg]}`                                                                    |
| `<sphereGeometry>`      | `args={[radius, widthSeg, heightSeg]}`                                                                           |
| `<cylinderGeometry>`    | `args={[radiusTop, radiusBottom, height, radialSeg, heightSeg, openEnded]}`                                      |
| `<torusGeometry>`       | `args={[radius, tube, radialSeg, tubularSeg]}`                                                                   |
| `<bufferGeometry>`      | `position` / `normal` / `uv` / `index` arrays; normals are derived from the triangles when omitted               |
| `<meshBasicMaterial>`   | unlit flat colour: `color`, `map`, `wireframe`, `opacity`, `transparent`, `side` (`front` \| `back` \| `double`) |
| `<meshLambertMaterial>` | diffuse shading; the same props plus `emissive`                                                                  |
| `<meshPhongMaterial>`   | + `specular`, `shininess` (default 30)                                                                           |
| `<ambientLight>`        | `color`, `intensity` — costs no light unit                                                                       |
| `<directionalLight>`    | `position` is the direction the light comes from                                                                 |
| `<pointLight>`          | `position`, plus `distance`/`decay` for attenuation                                                              |
| `<spotLight>`           | + `angle` in radians, `penumbra`, `target`                                                                       |

Transforms are `position`, `rotation` (XYZ euler radians) and `scale`, each
a `[x, y, z]` tuple (or one number for a uniform scale), plus `visible`.

**Geometry lives on the server.** GLX encodes no vertex arrays, so vertices
can only travel as immediate-mode commands — a 1 000-triangle mesh re-sent
every frame is ~96 KB per frame. Each geometry is therefore compiled into a
**display list** once, and a frame is matrices + material state + one
`CallList` per mesh, whatever the triangle count. Changing a transform or a
material re-sends neither; changing a geometry's `args` recompiles just
that list. `test/scene3d.test.js` asserts exactly this on the encoded
command stream.

### Textures

`map` on any material takes an ntk `Image` — or anything with
`{ width, height, data }` in RGBA byte order:

```jsx
import { Image, loadImage } from 'ntk';

const texture = await loadImage('crate.png');

<mesh>
  <boxGeometry args={[1, 1, 1]} />
  <meshPhongMaterial map={texture} color="#ffffff" />
</mesh>;
```

The pixels are uploaded once, on first use, and only rebound afterwards —
the same rule as geometry, since a texture is kilobytes that must not cross
the wire twice. The upload goes through `RenderLarge`, so it is one chunked
request rather than a stream of commands. Texture coordinates come from the
geometry (the primitives all generate them); the texture is applied in
`GL_MODULATE`, so the material `color` tints it and lighting still applies.
Filtering is linear and wrapping repeats.

### Pointer events on meshes

`<mesh>` and `<group>` take `onClick`, `onPointerDown`, `onPointerUp`,
`onPointerMove`, `onPointerOver` and `onPointerOut`, plus a `cursor` prop
applied while the pointer is over them. `<glarea>`/`<Canvas3D>` takes
`onPointerMissed` for clicks that hit nothing.

```jsx
<mesh
  cursor="pointer"
  onPointerOver={() => setHovered(true)}
  onPointerOut={() => setHovered(false)}
  onClick={(ev) => console.log('hit at', ev.point, 'distance', ev.distance)}
>
```

The event carries `object` (the mesh that was hit), `point` (world
coordinates), `distance`, `face`, `uv`, the pixel `x`/`y`, `nativeEvent`,
and `stopPropagation()` — events bubble from the mesh up through its
`<group>` ancestors. Only the nearest hit is dispatched.

**Picking is client-side raycasting**, not GPU picking: a ray through the
clicked pixel is intersected with the same CPU-side geometry the display
lists were compiled from, using the world matrices of the last frame drawn.
Reading pixels back would be a round trip per event, and on XQuartz GL
output is not readable through `GetImage` at all. Only meshes that — or
whose ancestors — have handlers are tested, and the surface asks the X
server for pointer events only when the scene has at least one handler.

**Lighting is the fixed-function pipeline**: per-vertex Gouraud shading and
**8 light units** in total — more than eight non-ambient lights warns and
uses the first eight. `<ambientLight>` costs no unit; its colour rides on
the first light's ambient term. A lit material in a scene with no lights
falls back to flat colour rather than rendering black. Light positions are
world space, so a light inside a rotating `<group>` moves with it.

Not implemented, and failing with an error naming the reason:
`<shaderMaterial>` (the protocol encodes no shaders), `<instancedMesh>`,
`<points>`, `<line>`, post-processing — and no shadows, which need
framebuffer objects. Camera elements are the one r3f concept still missing
— the `camera` prop covers it for now. See [glx-plan.md](glx-plan.md).

---

## Rich content

Thin wrappers over ntk's document widgets in standalone mode. The widget's
own layout feeds a yoga measure function: given the width the flexbox
offers, the element reports the document's content height — so rich content
participates in flex layout and scrolls naturally inside a `<scrollview>`.
Spacing comes from the box model (`padding` prop), not a widget page margin.

Async content (a ` ```mermaid ` fence, an `<img>`) reflows when it
arrives via ntk's `onInvalidate` widget hook (ntk ≥ 3.4.0 — the declared
dependency).

`<markdown>`, `<html>` and `<tex>` take their content as a **string
child** (the react-markdown convention) or a `source` prop; the child
wins when both are present. Use a template-literal expression — JSX
collapses newlines in literal text:

```jsx
<markdown onLink={open}>{`
# Hi

Some *markdown*.
`}</markdown>
```

### `<markdown>`

ntk `MarkdownView`: headings, emphasis, lists, quotes, tables,
syntax-highlighted code fences, `math`/`latex` fences (KaTeX), `mermaid`
fences (flowchart/sequence, async).

| prop               |                                                                                 |
| ------------------ | ------------------------------------------------------------------------------- |
| children           | markdown text (string), or use `source`                                         |
| `source`           | markdown text                                                                   |
| `onLink(href, ev)` | a rendered link was clicked                                                     |
| `theme`            | MarkdownView theme overrides (`{size, color, family, linkColor, codeTheme, …}`) |

### `<html>`

ntk `HtmlView`: its own CSS cascade (document `<style>`s plus the
`stylesheet` prop), block/flex layout, images.

| prop                           |                                               |
| ------------------------------ | --------------------------------------------- |
| children                       | HTML markup (string), or use `source`         |
| `source`                       | HTML document or fragment                     |
| `stylesheet`                   | extra author CSS (string or array)            |
| `baseUrl`                      | resolve relative image `src` against this     |
| `loadResource(url, {element})` | custom resource loader (or `null` to disable) |
| `onLink(href, ev, element)`    | a link was clicked                            |
| `theme`                        | base look (`{family, size, color}`)           |

### `<svg>`

ntk `SvgView` (static SVG via Path2D — paths, shapes, gradients,
transforms, basic text). Sized like `<image>`: natural `viewBox` size,
aspect-preserving shrink-to-width, or explicit `width`/`height` (the
drawing scales to the content box).

Content is **JSX children, like SVG in React DOM** — SVG elements are
declarative children with camelCase props (`strokeWidth`, `fillRule`;
native-camelCase attributes like `viewBox` stay as-is), re-rendered on
any prop change:

```jsx
<svg viewBox="0 0 24 24" style={{ width: 40, height: 40 }}>
  <circle cx={12} cy={12} r={10} fill={active ? '#2980b9' : '#ccc'} />
  <path d="M8 12l3 3 5-6" stroke="white" strokeWidth={2} fill="none" />
</svg>
```

A `source` markup string is also accepted (children win when both are
present). Supported elements/attributes are SvgView's (unsupported tags
are skipped); per-child event handlers are not dispatched — put handlers
on the `<svg>` element itself.

| prop      |                                   |
| --------- | --------------------------------- |
| children  | declarative SVG elements          |
| `source`  | SVG markup string                 |
| `viewBox` | coordinate system (children form) |

### `<tex>`

A KaTeX formula via ntk `layoutTex` — an intrinsically-sized box (no
wrapping), drawn as server-side glyphs/rects.

| prop          |                                         |
| ------------- | --------------------------------------- |
| children      | TeX source (string), or use `source`    |
| `source`      | TeX source                              |
| `size`        | base font size (the formula em), px     |
| `color`       | ink color (default `#222222`)           |
| `displayMode` | KaTeX display mode (default `false`)    |
| `katex`       | extra KaTeX options (macros, strict, …) |
