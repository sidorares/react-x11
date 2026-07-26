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

**Ref**: the node, plus `scrollTo(y)` / `scrollBy(dy)` /
`scrollIntoView(node)` and `scrollY` / `contentHeight`.

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
PRIMARY (X11 conventions). Focusable by default; shows the text cursor.
`ev.preventDefault()` in your `onKeyDown`/`onMouseDown` suppresses the
built-in editing behavior.

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
<svg viewBox="0 0 24 24" width={40} height={40}>
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
