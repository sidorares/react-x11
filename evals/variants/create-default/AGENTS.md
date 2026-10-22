<!-- BEGIN:react-x11-agent-rules -->

# This is react-x11, not react-dom

This app is React drawing native desktop windows with react-x11
2.51.1. There is no DOM, no browser and no CSS. What you know about
React carries over: components, hooks, state, context, Suspense, error
boundaries. What you know about the DOM does not. Before writing UI, read the
docs installed with the package. They match the version this app runs and
are newer than your training data.

## Where to look

**Docs**, installed with the package (paths from this file's directory):
`node_modules/react-x11/docs/`

| page                                                | for                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `react-features.md`                                 | **read first**: where a DOM habit breaks (refs, measuring, portals, effects) |
| `elements.md`                                       | the host elements and their props                                            |
| `styling.md`                                        | the `style` prop: layout, paint, `:hover` blocks, theme tokens               |
| `components.md`                                     | `Button`, `Select`, `Dialog`, `MenuBar`, `Tabs`, `Table`, `SplitPane`, …     |
| `events.md`                                         | events, focus, keys, shortcuts                                               |
| `appearance.md`                                     | light and dark, the accent, reduced motion                                   |
| `globalmenu.md`                                     | where `MenuBar` goes on each platform                                        |
| `testing.md`                                        | `react-x11/test`: render headless, query, click, type, write a PNG           |
| `accessibility.md`                                  | roles, names, what a screen reader hears                                     |
| `filedialog.md`, `notifications.md`, `clipboard.md` | the desktop around the app                                                   |
| `drag-and-drop.md`, `system.md`, `packaging.md`     | more of it, and shipping the app                                             |
| `ecosystem/*.md`                                    | state, forms, routing, data fetching, i18n with libraries you know           |
| `README.md`                                         | the map of every page                                                        |

The same pages are online at
`https://sidorares.github.io/react-x11/docs/reference/<page>`.

**Types**: `node_modules/react-x11/src/index.d.ts` and
`node_modules/react-x11/src/types/*.d.ts` hold every element, style key, event
and widget with its props. Grep them for any prop you are not sure of.

**Examples** are not in the package. These are pinned to this version:
`https://github.com/sidorares/react-x11/tree/v2.51.1/examples`, raw files
at `https://raw.githubusercontent.com/sidorares/react-x11/v2.51.1/examples/<file>`.
`finder.jsx` and `settings.jsx` (sidebar and content), `tasks.jsx` (list and
input), `widgets.jsx` (every control), `dashboard.jsx`, `menu.jsx`,
`theming.jsx`. Read the closest one or two before writing a screen.

## Rules you will trip on

Most of these throw with a message that names the fix. Read the message
before guessing.

- **Host elements are lowercase and few**: `<window>`, `<popup>`, `<box>`,
  `<text>`, `<textinput>`, `<textarea>`, `<image>`, `<svg>`, `<canvas>`,
  `<video>`, `<glarea>`. No `<div>`, `<span>`, `<button>`, `<input>`.
- **Everything drawn is inside a `<window>`.** `<window>` takes its geometry as
  props, not style: `title`, `width`, `height`, `minWidth`, `minHeight`,
  `resizable`.
- **Raw strings and numbers go only inside `<text>`.** `<box>hi</box>` throws.
  A `<text>` inside a `<text>` is a styled span.
- **Style lives in `style`**, an object or an array (`[s.row, on && s.on]`,
  falsy entries skipped). `<box padding={8}>` throws. There is no
  `className`, no CSS file, no Tailwind, no styled-components.
- **State blocks paint only.** `':hover'`, `':active'`, `':focus'`,
  `':focus-visible'`, `':focus-within'` and `':disabled'` inside `style` may set
  colours, `background`, `opacity`, `outline`, `borderRadius`. Not padding,
  size or `border` (its width is layout).
- **Flexbox is React Native's direction with CSS's shrink**: `flexDirection`
  defaults to `'column'`, and children of a column stretch to its full width.
  A `Button` in a column becomes a slab: give it `alignSelf: 'flex-start'`, or
  put buttons in a `flexDirection: 'row'` box. `display: 'grid'` and `gap`
  work as in CSS.
- **A pane smaller than its content scrolls** only with
  `overflow: 'scroll'` (or `'hidden'`, or `minHeight: 0`). For 1000+ rows use
  `Table`, which is virtualized.
- **Colours are theme tokens**: `'$background'`, `'$surface'`, `'$text'`,
  `'$textMuted'`, `'$border'`, `'$accent'`, `'$accentText'`, `'$accentHover'`,
  `'$accentActive'`, `'$surfaceHover'`, `'$surfaceActive'`,
  `'$hoverBackground'`/`'$hoverText'` (a selected row), `'$danger'`,
  `'$success'`, `'$warning'`, `'$info'`, `'$link'`. They follow the desktop's
  light or dark scheme and its accent. A hard-coded grey is wrong in one of
  the two. `useTheme()` gives the resolved values, for `<canvas>` drawing.
- **Events**: `onClick`, `onMouseDown`/`Up`/`Move`/`Enter`/`Leave`, `onWheel`,
  `onContextMenu`, and `onKeyDown`/`onKeyUp` on an element that is
  `focusable`. `Button` takes **`onPress`**. Every input's `onChange` gets an
  event: read `ev.value`. Keys: compare `ev.keysym` with `XK_RETURN`,
  `XK_ESCAPE`, `XK_DOWN`, … from `'react-x11/keysyms'`.
- **Shortcuts**: `[['Control', 'S']]` is ⌘S on macOS and Ctrl+S elsewhere. Put
  them on `MenuBar` items (`shortcut`) or use `useAccelerator(chord, fn)`.
  Never bind Copy, Paste, Cut, Select All or Undo in a menu while a text field
  can have focus: the fields handle those already, and both would run.
- **Web UI libraries do not work** (MUI, Radix, shadcn, recharts, react-dom
  anything). Plain JavaScript libraries do: zustand, zod, date-fns, `fetch`.
- **No `localStorage`.** Persist with
  `createSettings({ appId, defaults })` from `react-x11`
  (`const [value, setValue] = settings.use('key')`) or with `node:fs`.
- **Paths are absolute**: `new URL('./data.json', import.meta.url)`. On macOS
  the app's JavaScript runs on a worker thread, where `process.chdir()` throws.

## Bigger components

Charts, a data table, a tree, tabs, markdown, a code editor, a rich text
editor, a calendar and date picker, a colour picker, a timeline, a reorderable
list, flow graphs, maps, formulas and a 3D scene are in
`@react-x11/components`. Install it, then import from its subpaths, not the
package root: `@react-x11/components/charts`, `/table`, `/tree`, `/tabs`,
`/markdown`, `/code-editor`, `/rich-text-editor`, `/calendar`,
`/color-picker`, `/timeline`, `/reorder`, `/flow`, `/maps`, `/formula`,
`/three`. Its `README.md` and `docs/components/<name>.md` are in
`node_modules/@react-x11/components/`, and each subpath has its own `.d.ts`.

## Commands

- `npm run start` runs the app once.
- `npm run dev` runs it with hot reload. It keeps running and is meant for a
  person at the keyboard; do not wait for it to exit.
- `npx react-x11 help` lists every `REACT_X11_*` variable.
  `REACT_X11_DEBUG_LAYOUT=1` outlines every laid-out box, for a layout that
  does not do what you expect.

## Check your work: run it and look at it

Passing tests are not the finish line. A clipped label, a stretched button or
a colour that is wrong in dark mode passes every test and is obvious in a
picture.

1. Render the app headless and write a picture of each scheme.
   `react-x11/test` runs a real X server inside the test process: no window
   opens, nothing to install but `pngjs` (`npm install -D pngjs`).

   ```jsx
   // test/App.test.jsx — run with: node --import tsx --test test/*.test.jsx
   import React from 'react';
   import { mkdirSync } from 'node:fs';
   import { afterEach, test } from 'node:test';
   import {
     cleanup,
     renderX11,
     screen,
     toPNG,
     userEvent,
   } from 'react-x11/test';
   import App from '../src/App.jsx';

   afterEach(cleanup);
   // a font file, so text measures the same every run; Linux finds one itself
   const fonts = {
     darwin: { 'sans-serif': '/System/Library/Fonts/Supplemental/Arial.ttf' },
     win32: { 'sans-serif': 'C:\\Windows\\Fonts\\segoeui.ttf' },
   }[process.platform];

   for (const colorScheme of ['light', 'dark']) {
     test(`renders in ${colorScheme}`, async () => {
       const { ctx, window: win } = await renderX11(<App />, {
         wrap: false, // App renders its own <window>
         fonts,
         colorScheme,
       });
       // drive it the way a person would, then assert on what shows
       // await userEvent.click(screen.getByRole('button', { name: 'Add' }));
       // screen.getByText('1 item');
       mkdirSync('shots', { recursive: true });
       const { width, height } = win; // the size the app's window came out
       await toPNG(ctx, `shots/${colorScheme}.png`, { width, height });
     });
   }
   ```

   Queries are Testing Library's: `getByText`, `getByRole(role, { name })`,
   `getByPlaceholder`, `findBy*`, `queryBy*`, and `userEvent.click`, `type`,
   `key`, `hover`. A `getBy*` that matches twice throws: add
   `{ exact: true }` or narrow with `within(node)`.

2. **Open both PNGs and look at them.** Fix what looks wrong: clipped or
   overlapping text, a cramped or empty window, rows that do not line up, a
   colour that ignores dark mode, a control with no hover or pressed state.
   Render again. Two or three passes is normal.
3. The headless render is the X11 backend: native control bezels, the macOS
   menu bar and SF Symbols do not appear in it, and bold may come out regular.
   Judge layout, spacing, colour and text from it. Then run `npm run start`
   for a few seconds to confirm the real app starts with nothing in its
   output.

## Design

Read [DESIGN.md](DESIGN.md) before writing UI. It says how this app should
look and how to get each piece out of react-x11.

<!-- END:react-x11-agent-rules -->

The block above comes from react-x11 2.51.1. Keep notes about this app
below it, so the block can be replaced with a newer version's.

## This app

<!-- What it is, who it is for, and the decisions an agent should keep to. -->
