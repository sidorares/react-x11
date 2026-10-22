# Headless components

A library that returns DOM prop bags — `useButton()` and the like — is
DOM-coupled with the rendering deferred, not headless in a sense that helps
here. The two packages below own state and collections, return plain values,
and never touch a ref. Headless UI and the Radix primitives render DOM hosts
and fail ([register](../ecosystem.md#what-does-not-work)); downshift's
`getInputProps()` works on a `<textinput>` ([forms](forms.md)).

For finished widgets react-x11 ships its own: `Button`, `Checkbox`,
`Radio`/`RadioGroup`, `Switch`, `ProgressBar`, `Select`, `Slider`, `Tooltip`,
`Dialog`, `MenuBar`/`ContextMenu`, `Tabs`, `Table`, `SplitPane` — see
[components](../components.md).

## react-stately {#react-stately}

**Out of the box.** react-stately@3.48.0.

The state-machine half of React Aria: `useListState`, `useTreeState`,
`useTableState`, `useSelectState`, `useToggleState`, `useSliderState`,
`useComboBoxState`, `useMenuTriggerState`, `useNumberFieldState` and about
thirty-five more, plus the `Item`/`Section` collection API. Each hook owns
selection, disabled-key traversal, expansion and typeahead-ready collections
— everything but rendering and event binding, which react-x11 supplies. No
hook references `document`, `window` or `getBoundingClientRect` at runtime,
and the dependencies (`@internationalized/*`, `@react-types/shared`,
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

- **Only `react-stately` is portable.** `react-aria` (hooks that produce DOM
  props and bind DOM events) and `react-aria-components` are not — do not
  follow Adobe's docs into `useListBox` or `useButton`.
- Since 3.48 the old `@react-stately/*` packages are bundled in, with
  per-hook subpath exports (`react-stately/useListState`) for lean imports.
- The collection API wants `<Item>`/`<Section>` elements, or `items` plus a
  render function — ceremonious for a three-entry menu.
- `useAsyncList` carries fetch-based loading state — fine under Node, the
  one hook with I/O opinions.
- Drag-and-drop hooks (`useDraggableCollectionState`) hold state, but
  everything that would _feed_ them events is DOM-side; write the event
  plumbing yourself.

## `@tanstack/react-table` {#tanstack-table}

**Out of the box.** @tanstack/react-table@9.1.2 (table-core 9.1.2,
react-store 0.11.1).

A headless table engine: column defs, row models, sorting, filtering,
grouping, pagination, column sizing, visibility and pinning, as pure state
plus derived row models. You map `getHeaderGroups()` and
`getRowModel().rows` to react-x11 elements.

v9's "adapters" are per framework, not per renderer: `@tanstack/react-table`
_is_ the React adapter, so there is nothing to write, and it never touches
`react-dom` or `document` at runtime (but see the react-dom and `flexRender`
bullets). `column.getToggleSortingHandler()` goes straight onto a header
`onClick`. Features and row models are registered up front through
`tableFeatures`, and the hook is `useTable`.

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

Sorting is uncontrolled here — the table's store holds it, and the header
click re-renders through the adapter's subscription. Pass
`state`/`onSortingChange` to control it, or a selector as `useTable`'s
second argument to subscribe a component to only some slices. Render into
the built-in `Table` component or raw `<box style={{ flexDirection: 'row' }}>`
rows.

- **`coreRowModel` is opt-in, and forgetting it fails silently.** Without
  `coreRowModel: createCoreRowModel()` in `tableFeatures`, headers render
  and `getRowModel().rows` is `[]`, with no error. The official examples get
  it from framework presets; register it yourself.
- **npm installs a `react-dom` you must not keep.** `@tanstack/react-store`
  declares a `react-dom` _peer_, which npm 7+ auto-installs. The shipped
  code never imports it (test 2 finds one `"button"`, in a doc comment, and
  the table works with `node_modules/react-dom` deleted), but a resident
  react-dom is the [silent-failures](../ecosystem.md#silent-failures)
  hazard. Install with `--legacy-peer-deps`, or delete it so
  `npm ls react-dom` stays empty.
- **`flexRender` returns a React element even for a plain string cell** (v8
  returned the string). Inside `<text>` it paints identically, but a test or
  a11y walk reading a `<text>` node's `children` prop sees an element
  object; read the rendered chunks. A `cell` that returns DOM elements
  throws the unknown-element error; return strings or react-x11 elements.
- Column _resizing_ helpers (`header.getResizeHandler`) expect DOM mouse or
  touch events with `clientX` and fall back to a `document`-listener drag
  loop (injectable as `_contextDocument`). Simpler: handle the drag off
  `onMouseDown`/`onMouseMove` (react-x11 events carry `x`/`y`) and call
  `table.setColumnSizing` (needs `columnSizingFeature` registered).
- `useTable` probes `typeof window` to pick `useLayoutEffect` and gets
  `useEffect` under Node — a harmless test-3 hit (timing, not a feature
  gate).
- For thousands of rows, pair it with a
  [virtualizer](layout.md#tanstack-virtual).
- State updates driven from outside a React event land one frame later than
  the call, as with any react-x11 update.
