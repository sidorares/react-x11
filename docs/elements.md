# Elements

Only `<window>` and `<popup>` are backed by real X11 windows, created
top-down in React's commit phase so every `CreateWindow` names its actual
parent. Everything else is a retained lightweight node — one
[yoga-layout](https://www.yogalayout.dev/) node each — painted into the
owning window's double-buffered 2d context on ntk's frame clock.

## Layout props (all drawn elements + windows)

Flat, ink-style props; numbers are pixels, strings like `'50%'` / `'auto'`
pass through to yoga.

- **Size**: `width`, `height`, `minWidth`, `minHeight`, `maxWidth`,
  `maxHeight`, `aspectRatio`
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

## Paint props

- `backgroundColor` — any CSS color string (`'#2980b9'`,
  `'rgba(0,0,0,.5)'`, `'red'`)
- `borderWidth`, `borderColor`, `borderRadius`, `borderStyle`
  (`'solid'` default, `'dashed'`)
- `zIndex` — paint/hit order among siblings (stable sort)
- `opacity` is not implemented yet (see NEXT_STEPS.md)

## Interaction props

`cursor` (`'pointer'`, `'text'`, `'wait'`, `'move'`, `'crosshair'`,
resize arrows, … — the ntk cursor name map), `focusable`,
`pointerEvents: 'none'`, and the event handlers listed in
[events.md](events.md).

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

Windows may be nested inside other windows (real X11 child windows).
**Ref**: the live ntk `Window` — `getContext('2d')`,
`requestAnimationFrame`, `setCursor`, the whole ntk API.

## `<popup>`

An override-redirect top-level window at **screen coordinates** — the
window manager ignores it (no decorations, no focus stealing): menus,
tooltips, dropdowns. May appear anywhere in the JSX tree (its position in
the tree does not affect its position on screen); it is its own paint and
event root. Anchor with `ev.nativeEvent.rootx/rooty` (pointer in screen
coordinates) or a ref's `abs` rect plus the owner window's `x`/`y`.
Same props as `<window>`; conditional rendering controls its lifetime.

## `<box>`

The flex container. All layout + paint + interaction props above.
**Ref**: the retained node — `abs` (`{x, y, width, height}` within the
window, valid after layout).

## `<scrollview>`

A clipped viewport over its (overflowing) children. Wheel events scroll it
by default; a scrollbar thumb is drawn when content overflows.

| prop                                                 |                          |
| ---------------------------------------------------- | ------------------------ |
| `onScroll({scrollY, contentHeight, viewportHeight})` | after scrolling          |
| `scrollbar={false}`                                  | hide the drawn scrollbar |
| `scrollbarColor`                                     | thumb color              |

**Ref**: the node, plus `scrollTo(y)` / `scrollBy(dy)` and `scrollY` /
`contentHeight`.

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
PRIMARY (X11 conventions). Focusable by default; shows the text cursor.
`ev.preventDefault()` in your `onKeyDown`/`onMouseDown` suppresses the
built-in editing behavior.

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
  flexGrow={1}
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
