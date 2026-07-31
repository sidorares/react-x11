# Layout and positioning

Layout itself is yoga's job — see [styling](../styling.md). The two packages
here cover the parts yoga does not: placing a popup relative to a trigger
across screen edges, and rendering a long list without building a node per
row.

Both are the _core_ half of a library whose React wrapper is DOM-bound. That
is the recurring shape in this section of the ecosystem: the algorithm is
portable, the wrapper is not, and the core is published separately precisely
so that non-DOM hosts can use it.

## `@floating-ui/core` {#floating-ui}

**Adapter, ~35 lines (a platform object).** @floating-ui/core@1.8.0.

The positioning engine underneath Floating UI, published without any DOM
code. You hand `computePosition` a `platform` object — `getElementRects`,
`getDimensions`, `getClippingRect`, `isRTL` — and get back the full
middleware pipeline (`offset`, `flip`, `shift`, `size`, `arrow`,
`autoPlacement`, `hide`) with the placement vocabulary every web developer
already knows.

The seam is exactly where `anchorRect()` already works: a drawn node's
`node.abs` rect plus the owning window's screen origin gives the reference
rect in screen coordinates, `screenOf(node)` gives the clipping rect, and the
popup-to-be is just `{width, height}`. The result's `{x, y, placement}` drops
straight into `<popup x y>`.

```jsx
import { computePosition, offset, flip, shift } from '@floating-ui/core';

// The screen a node is on. Same three lines the built-in anchorRect uses;
// it is not exported from the package, so keep a copy.
function screenOf(node) {
  const app = node?.app;
  const screen = (app?.display ?? app?.X?.display)?.screen?.[0];
  return screen?.pixel_width ? screen : null;
}

// reference = a drawn node (post-layout); floating = the popup's {width, height}
function screenRectOf(node) {
  const win = node.root?.window;
  const origin = win?._screenOrigin ?? { x: win?.x ?? 0, y: win?.y ?? 0 };
  return {
    x: origin.x + node.abs.x,
    y: origin.y + node.abs.y,
    width: node.abs.width,
    height: node.abs.height,
  };
}

const platform = {
  getElementRects: ({ reference, floating }) => ({
    reference: screenRectOf(reference),
    floating: { x: 0, y: 0, width: floating.width, height: floating.height },
  }),
  getDimensions: (el) => el.abs ?? el, // node or plain {width, height}
  getClippingRect: ({ element }) => {
    const s = screenOf(element?.node ?? element);
    return s
      ? { x: 0, y: 0, width: s.pixel_width, height: s.pixel_height }
      : { x: 0, y: 0, width: Infinity, height: Infinity };
  },
  isElement: () => true,
  isRTL: () => false,
};

const { x, y, placement } = await computePosition(
  triggerNode, // from a ref on the trigger <box>
  { width: 200, height: 150, node: triggerNode },
  {
    placement: 'bottom-start',
    middleware: [offset(4), flip(), shift({ padding: 8 })],
    platform,
  },
);
// -> <popup x={x} y={y}> ; placement tells you which side won
```

What this buys over the built-in `anchorRect` is middleware composition
(`shift` with padding, `size` to clamp long menus, `arrow`) and alignment
fallback — `flip` with `crossAxis: 'alignment'` switches `bottom-start` to
`bottom-end` when that is what fits. `anchorRect`'s `placement`, `align` and
`offset` options map 1:1 onto `placement` plus the `offset()` middleware.

- `computePosition` is async — `await` it, even though this platform is fully
  synchronous.
- `getClippingRect` above is screen 0's full rect, the same single-monitor
  simplification `screenOf` has today. On a dual-head X display, popups clamp
  to the bounding box of both monitors.
- **`@floating-ui/dom` and `@floating-ui/react` are not usable** — they are
  the DOM platform and DOM interactions respectively. Only `core` and its
  `@floating-ui/utils` dependency belong in an X11 app.
- The safe-polygon hover logic in `anchor.js` has no equivalent in `core`;
  that lives in `@floating-ui/react`'s `useHover`, which is DOM-bound. Keep
  the built-in one.

## `@tanstack/virtual-core` {#tanstack-virtual}

**Adapter, ~40 lines.** @tanstack/virtual-core@3.17.7.

The virtualization engine behind `useVirtualizer`: given a count, an
`estimateSize`, the viewport rect and the scroll offset, it computes which
items are visible (`getVirtualItems()`), the total scrollable size
(`getTotalSize()`), and offsets for `scrollToIndex`. All DOM touchpoints are
constructor options, which is what makes this work.

**Do not import `@tanstack/react-virtual`.** Its first line is
`import { flushSync } from "react-dom"`. Without react-dom installed it fails
to resolve; _with_ react-dom installed it silently flushes into the wrong
reconciler — see the
[silent-failures table](../ecosystem.md#silent-failures). Everything the
React wrapper adds is the hook below.

Three seams wire to `<scrollview>`:

- `observeElementRect` → `<scrollview onViewport>`, which fires from layout
  with `{width, height, contentWidth, contentHeight}` — including before any
  scroll, which is what a list needs on mount;
- `observeElementOffset` → `<scrollview onScroll>` (`scrollY`);
- `scrollToFn` → `ref.scrollTo(offset)`.

One non-obvious requirement: `getScrollElement()` must return something with
`scrollHeight`/`clientHeight`, because virtual-core duck-types Element vs
Window with `'scrollHeight' in el`. A getter shim over the scrollview node's
`contentHeight`/`abs.height` satisfies it.

```jsx
import React from 'react';
import { Virtualizer } from '@tanstack/virtual-core';

function useX11Virtualizer({ count, estimateSize, overscan = 2 }) {
  const ref = React.useRef(null);
  const obs = React.useRef({});
  const [, rerender] = React.useReducer((n) => n + 1, 0);
  const [element] = React.useState(() => ({
    // element-shaped view of the node
    get scrollHeight() {
      return ref.current?.contentHeight ?? 0;
    },
    get clientHeight() {
      return ref.current?.abs.height ?? 0;
    },
    get scrollWidth() {
      return ref.current?.contentWidth ?? 0;
    },
    get clientWidth() {
      return ref.current?.abs.width ?? 0;
    },
  }));
  const [v] = React.useState(
    () =>
      new Virtualizer({
        count,
        estimateSize,
        overscan,
        getScrollElement: () => (ref.current ? element : null),
        observeElementRect: (_i, cb) => {
          obs.current.rect = cb;
        },
        observeElementOffset: (_i, cb) => {
          obs.current.offset = cb;
          cb(0, false);
        },
        scrollToFn: (offset) => ref.current?.scrollTo(offset),
        onChange: () => rerender(),
      }),
  );
  v.setOptions({ ...v.options, count, onChange: () => rerender() });
  React.useEffect(() => v._didMount(), []);
  React.useEffect(() => v._willUpdate());
  return {
    virtualizer: v,
    scrollviewProps: {
      ref,
      onViewport: (r) => obs.current.rect?.(r),
      onScroll: (s) => obs.current.offset?.(s.scrollY, true),
    },
  };
}
```

```jsx
function BigList() {
  const { virtualizer, scrollviewProps } = useX11Virtualizer({
    count: 10000,
    estimateSize: () => 24,
  });
  return (
    <scrollview {...scrollviewProps} style={{ flexGrow: 1 }}>
      <box style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <text
            key={item.key}
            style={{ position: 'absolute', top: item.start, height: item.size }}
          >
            {`row ${item.index}`}
          </text>
        ))}
      </box>
    </scrollview>
  );
}
```

- **First paint shows zero rows.** Layout runs on the frame clock after the
  mount commit, `onViewport` reports a tick later, and the list fills in on
  the next frame. Fine interactively; tests must tick a few times.
- `estimateSize` is the only measurement. Dynamic per-item measurement
  (`measureElement`) is built on `ResizeObserver` and
  `getBoundingClientRect`. For variable-height rows, pass exact sizes:
  `estimateSize: (i) => heights[i]`.
- `_didMount`/`_willUpdate` are underscored but are the documented pattern
  for custom framework adapters — the official React, Vue and Svelte adapters
  call exactly these.
