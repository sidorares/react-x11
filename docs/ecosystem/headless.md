# Headless components

"Headless" is a promise that gets broken a lot. A library that returns DOM
prop bags — `getInputProps()`, `useButton()` — is not headless in any sense
that helps here; it is DOM-coupled with the rendering deferred. The two
packages below are the real thing: they own state and collections, return
plain values, and never touch a ref.

Everything else that markets itself as headless is in the
[negative-results register](../ecosystem.md#what-does-not-work) — Headless
UI, the Radix primitives and downshift all fail, the last one silently until
the first keystroke.

For finished widgets, react-x11 ships its own: `Button`, `Checkbox`,
`Radio`/`RadioGroup`, `Switch`, `ProgressBar`, `Select`, `Slider`, `Tooltip`,
`Dialog`, `MenuBar`/`ContextMenu`, `Tabs`, `Table`, `SplitPane`. See
[components](../components.md).

## react-stately {#react-stately}

**Out of the box.** react-stately@3.48.0.

The state-machine half of React Aria: `useListState`, `useTreeState`,
`useTableState`, `useSelectState`, `useToggleState`, `useSliderState`,
`useComboBoxState`, `useMenuTriggerState`, `useNumberFieldState` and about
thirty-five more, plus the `Item`/`Section` collection API. Each hook owns
selection, disabled-key traversal, expansion and typeahead-ready collections
— everything a widget needs _except_ rendering and event binding, which is
exactly the part react-x11 supplies.

There is no seam to bridge: the hooks take props, return state, and never
touch a ref. A scan of the shipped `dist/` finds no runtime reference to
`document`, `window` or `getBoundingClientRect` in any hook, and its
dependencies (`@internationalized/*`, `@react-types/shared`,
`use-sync-external-store`) are DOM-free.

```jsx
import React from 'react';
import { useListState, Item } from 'react-stately';

function Picker() {
  const state = useListState({
    children: [
      <Item key="alpha">Alpha</Item>,
      <Item key="beta">Beta</Item>,
      <Item key="gamma">Gamma</Item>,
    ],
    selectionMode: 'multiple',
  });
  const mgr = state.selectionManager;
  return (
    <box
      style={{ flexDirection: 'column' }}
      focusable
      onKeyDown={(ev) => {
        if (ev.key === 'ArrowDown')
          mgr.setFocusedKey(
            state.collection.getKeyAfter(mgr.focusedKey) ?? mgr.focusedKey,
          );
        if (ev.codepoint === 32) mgr.toggleSelection(mgr.focusedKey);
      }}
    >
      {[...state.collection].map((item) => (
        <box
          key={item.key}
          style={{ height: 20, justifyContent: 'center' }}
          onClick={() => mgr.toggleSelection(item.key)}
        >
          <text>
            {(mgr.isSelected(item.key) ? '* ' : '  ') + item.rendered}
          </text>
        </box>
      ))}
    </box>
  );
}
```

- **Only `react-stately` is portable.** `react-aria` (the hooks that produce
  DOM props and bind DOM events) and `react-aria-components` are not — do not
  follow Adobe's docs into `useListBox` or `useButton`, which return DOM prop
  bags.
- As of 3.48 the package is consolidated: the old `@react-stately/*` packages
  are bundled in, with per-hook subpath exports
  (`react-stately/useListState`) for lean imports.
- The collection API wants `<Item>`/`<Section>` elements, or an `items` plus
  render-function pair. It is a compile target of its own, slightly
  ceremonious for a three-entry menu.
- `useAsyncList` pulls in fetch-based loading state — fine under Node, but it
  is the one hook with I/O opinions.
- Drag-and-drop hooks (`useDraggableCollectionState`) hold state fine, but
  everything that would _feed_ them events is DOM-side. Expect to write the
  event plumbing.

## `@tanstack/react-table` {#tanstack-table}

**Out of the box.** @tanstack/react-table@9.1.2 (table-core 9.1.2,
react-store 0.11.1).

A headless table engine: column defs, row models, sorting, filtering,
grouping, pagination, column sizing, visibility and pinning — as pure state
plus derived row models. It renders nothing; you map `getHeaderGroups()` and
`getRowModel().rows` to whatever the host renderer draws.

v9 talks about "adapters", and the word means the framework, not the
renderer: `@tanstack/react-table` _is_ the React adapter, wiring the
framework-agnostic core's store to React's subscription model. react-x11 is
React, so that adapter is already ours and there is nothing renderer-shaped
to write. It still never touches `react-dom` or `document` at runtime —
though v9 moves two of this page's checks, see the react-dom and `flexRender`
bullets below. `column.getToggleSortingHandler()` still goes straight onto a
header `onClick`.

v9's API is modular where v8's was monolithic: features and row models are
registered up front through `tableFeatures`, and the hook is `useTable`.

```jsx
import React from 'react';
import {
  useTable,
  tableFeatures,
  rowSortingFeature,
  createCoreRowModel,
  createSortedRowModel,
  createColumnHelper,
  flexRender,
} from '@tanstack/react-table';

// Registered once, outside the component. A feature that is not listed here
// does not exist: its state slice, its column methods, its row model.
const features = tableFeatures({
  rowSortingFeature,
  coreRowModel: createCoreRowModel(),
  sortedRowModel: createSortedRowModel(),
});

const col = createColumnHelper();
const columns = [
  col.accessor('name', { header: 'Name' }),
  col.accessor('port', { header: 'Port', cell: (i) => `:${i.getValue()}` }),
];

function Servers({ data }) {
  const table = useTable({ features, columns, data });
  return (
    <box style={{ flexDirection: 'column' }}>
      {table.getHeaderGroups().map((hg) => (
        <box key={hg.id} style={{ flexDirection: 'row', height: 20 }}>
          {hg.headers.map((h) => (
            <box
              key={h.id}
              style={{ width: 120 }}
              onClick={h.column.getToggleSortingHandler()}
            >
              <text>
                {flexRender(h.column.columnDef.header, h.getContext())}
              </text>
            </box>
          ))}
        </box>
      ))}
      {table.getRowModel().rows.map((row) => (
        <box key={row.id} style={{ flexDirection: 'row', height: 20 }}>
          {row.getAllCells().map((cell) => (
            <text key={cell.id} style={{ width: 120 }}>
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </text>
          ))}
        </box>
      ))}
    </box>
  );
}
```

Sorting is uncontrolled here — the table's own store holds it, and the
header click re-renders through the adapter's subscription. Pass
`state`/`onSortingChange` as before to control it, or a selector as
`useTable`'s second argument to subscribe a component to only some slices.

The natural pairing is inside the existing `Table` component, or raw
`<box style={{ flexDirection: 'row' }}>` rows: TanStack owns the data logic,
react-x11 owns painting.

- **`coreRowModel` is opt-in, and forgetting it fails silently.** Without
  `coreRowModel: createCoreRowModel()` in `tableFeatures`, the table
  constructs, headers render, and `getRowModel().rows` is `[]` — no error.
  The official examples lean on framework presets that include it; register
  it yourself.
- **npm installs a `react-dom` you must not keep.** `@tanstack/react-store`
  declares a `react-dom` _peer_ dependency, which npm 7+ auto-installs. The
  shipped code never imports it — grep test 2 on all four `@tanstack`
  packages finds one `"button"` in a doc comment, and this section was
  verified with `node_modules/react-dom` deleted — but a resident react-dom
  is exactly the [silent-failures](../ecosystem.md#silent-failures) hazard.
  Install with `--legacy-peer-deps`, or delete it and let `npm ls react-dom`
  stay empty.
- **`flexRender` now returns a React element even for a plain string cell**
  (v8 returned the string itself). Inside `<text>` that is fine — the string
  arrives as a text chunk and paints identically — but a test or a11y walk
  that reads a `<text>` node's `children` prop now sees an element object.
  Read the rendered chunks, not the prop. A column def whose `cell` returns
  DOM elements still throws the renderer's unknown-element error; return
  strings or react-x11 elements.
- Column _resizing_ helpers (`header.getResizeHandler`) still expect DOM
  mouse or touch events with `clientX`, and now fall back to a
  `document`-listener drag loop (injectable as `_contextDocument`). Simpler
  to ignore the helper: write your own drag handling off
  `onMouseDown`/`onMouseMove` — react-x11 events carry `x`/`y` — and call
  `table.setColumnSizing` (needs `columnSizingFeature` registered).
- `useTable` probes `typeof window` to pick `useLayoutEffect`; under Node it
  gets the `useEffect` branch. That is a grep-test-3 hit of the harmless
  kind — timing, not a feature gate — and the sorted re-render above runs
  through it.
- For thousands of rows, pair it with a virtualizer — see
  [layout](layout.md#tanstack-virtual). TanStack Table will happily hand you
  10,000 row objects and let the renderer drown.
- State updates driven from outside a React event land one frame later than
  the call, the same as any react-x11 update.
