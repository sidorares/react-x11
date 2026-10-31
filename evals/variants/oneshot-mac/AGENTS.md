# One-shot: build a native macOS app with react-x11

You were started in this folder with an idea for a desktop app, live, in front
of an audience. Nobody will answer questions. Build it in one go, unattended,
and finish with something that **runs and looks good**.

## The mission

- **No questions back.** Where the idea is vague, pick the version that makes
  the best 30-second demo, and write the decision down. A small app that works
  and looks native beats a big one that crashes.
- **Build in this folder**: it is the app, already made with `react-x11 create`.
  Write only inside it.
  Do not touch the parent repo, do not `git commit`, do not install anything
  globally, do not edit files in the reference repos listed below.
- **Keep `NOTES.md`**: a few lines per decision (what you assumed, what you
  cut, what does not work and why). Short — it is read aloud.
- **Milestones, not a big bang.** Run `date` when you start. Have a first
  version that opens a window within ~10 minutes, the core feature working by
  ~25, then polish. Aim to be done within ~40 minutes; leave it runnable at
  every step so stopping early still demos.
- **Done** = `npm start` opens the app; `npm test` passes;
  `README.md` says what it is and how to run it; you have looked at a
  screenshot of it (see "Verify") and fixed what looked wrong.
- Read [DESIGN.md](DESIGN.md) before writing UI. It is how the app should look.

## The stack (no DOM, no browser)

- **react-x11** — a React renderer for desktop apps. On macOS it renders
  through **Cocoa**: real `NSWindow`s, Core Animation, the system menu bar,
  AppKit's own control bezels, native open/save panels. Layout is flexbox
  (yoga) plus CSS grid.
- **@react-x11/components** — the big components: charts, code editor, data
  table, tree, tabs, markdown, rich text editor, maps, flow graphs, formula
  (KaTeX), HTML document, calendar/date picker, colour picker, timeline,
  reorderable list, terminal, 3D scene.
- **There is no `<div>`, no CSS files, no className, no react-dom, no Electron,
  no webview, no Tailwind/MUI/recharts.** Web UI libraries do not work. Plain
  JS libraries (date-fns, zod, zustand, fetch) do.

## Setup (known-good, copy it)

`package.json`:

```json
{
  "name": "oneshot-app",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx app.jsx",
    "dev": "react-x11 dev app.jsx",
    "test": "REACT_X11_NO_AUTORUN=1 node --import tsx --test test/*.test.jsx"
  },
  "dependencies": {
    "@react-x11/components": "^0.26.0",
    "react": "^19.3.0",
    "react-x11": "^2.51.0"
  },
  "devDependencies": {
    "@babel/core": "^8.0.0",
    "@babel/plugin-transform-react-jsx": "^8.0.0",
    "hot-module-replacement": "^4.0.2",
    "pngjs": "^7.0.0",
    "react-refresh": "^0.19.0",
    "tsx": "^4.23.0"
  },
  "engines": { "node": ">=22.15" }
}
```

Then `npm install --prefer-offline --no-audit --no-fund`. Nothing compiles; the
Cocoa bridge (`@windowkit/appkit`) is a prebuilt optional dependency. The
babel/refresh devDependencies are only so `npm run dev` (hot reload) never
stops to ask to install them — **you** use `npm start`, not `dev`: `dev` is
interactive and keeps running.

- Write **`.jsx`** (not TypeScript — `react-x11 dev` does not take TS) and
  start every file with `import React from 'react';` (classic JSX works
  everywhere: tsx, bun, the hot-reload loader).
- Bun works too (`bun app.jsx`), but stick to Node + tsx unless it fails.
- `tsx` must be ≥ 4.21.1 (older ones break the macOS worker thread).

`app.jsx` — the entry. Keep this shape: it exports `App` (tests and the
hot-reload CLI import it), mounts only when run directly, and can snapshot
itself:

```jsx
import React from 'react';
import { createRoot } from 'react-x11';
import { App } from './src/App.jsx';

export default App;

if (!process.env.REACT_X11_NO_AUTORUN && !import.meta.hot) {
  const root = await createRoot({ cocoa: { appName: 'Your App Name' } });
  root.render(<App />, (wnd) => {
    const out = process.env.SNAPSHOT; // absolute .png path
    if (!out || typeof wnd?.snapshot !== 'function') return;
    setTimeout(async () => {
      await wnd.snapshot(out);
      process.exit(0);
    }, Number(process.env.SNAPSHOT_DELAY ?? 2500));
  });
}
```

`appName` is what the menu bar and ⌘-Tab show (otherwise "node"). On macOS
the JS runs on a worker thread: `process.chdir()` throws there — use absolute
paths (`new URL('./data.json', import.meta.url)`). `process.exit()` ends the
app from anywhere.

A minimal `src/App.jsx` shape (one `<window>` at the root, `MenuBar` inside it):

```jsx
import React, { useState } from 'react';
import { Button, MenuBar, ThemeProvider } from 'react-x11';

export function App() {
  const [count, setCount] = useState(0);
  const menus = [
    { label: 'File', items: [
      { label: 'New', shortcut: [['Control', 'N']], onSelect: () => setCount(0) },
    ] },
  ];
  return (
    <ThemeProvider value={{ fontSize: 13 }}>
      <window title="Counter" width={720} height={480} minWidth={480} minHeight={320}>
        <MenuBar menus={menus} />
        <box style={{ flexGrow: 1, padding: 20, gap: 12 }}>
          <text style={{ fontSize: 22, fontWeight: 'bold' }}>{String(count)}</text>
          <Button primary style={{ alignSelf: 'flex-start' }}
            onPress={() => setCount((c) => c + 1)}>Add one</Button>
        </box>
      </window>
    </ThemeProvider>
  );
}
```

## Rules you will trip on (they throw, or silently do nothing)

- **Host elements**: `<window>`, `<popup>`, `<box>`, `<text>`, `<textinput>`,
  `<textarea>`, `<image>`, `<svg>`, `<canvas>`, `<video>`, `<glarea>`
  (`<foreign>` is X11-only). Lowercase. Nothing else exists.
- **Raw strings and numbers only inside `<text>`.** `<box>hi</box>` throws.
  Nested `<text>` inside `<text>` is a styled span.
- **Style lives in `style`, never flat props.** `<box padding={8}>` throws.
  `style` takes an object or an array (`[s.row, active && s.on]`, falsy
  skipped). `createStyles({...})` validates a style sheet up front.
  Props are the rest: `title`, `width`/`height` on `<window>`, `value`,
  `onClick`, `focusable`, `disabled`…
- **`<window>` geometry is props, not style**: `width`, `height`, `minWidth`,
  `minHeight`, `resizable`, `title`. A `<window>` cannot be inside a `<box>`
  (throws). Everything drawn must be under a `<window>`.
- **`:hover`, `:active`, `:focus`, `:focus-visible`, `:focus-within`,
  `:disabled` blocks inside `style` may only set paint properties**
  (`backgroundColor`, `borderColor`, `color`, `opacity`, `outline*`,
  `borderRadius`, `zIndex`). No padding/size in a state block.
- **Flexbox defaults are React Native's direction** (`flexDirection: 'column'`)
  **with CSS's shrink**: `flexShrink: 1`, and every item has a min-content
  floor, so text never squashes to nothing. A pane that must be smaller than
  its content (a scroller) needs `overflow: 'scroll'` (or `'hidden'`, or
  `minHeight: 0`). **Children of a column stretch to its full width** — a
  `Button` in a column becomes a 700px slab; give it `alignSelf:
  'flex-start'` or put buttons in a `flexDirection: 'row'` box.
  `flex: 1` = grow from zero. `display: 'grid'` with
  `gridTemplateColumns: 'auto 1fr'` etc. works like CSS. `gap` works.
- **Scrolling**: `<box style={{ overflow: 'scroll', flexGrow: 1 }}>`.
  Long lists of 1000+ rows: use `Table`/`Tree` from components (virtualized).
- **Text**: `fontSize`, `fontWeight`, `color`, `textAlign`, `lineHeight`,
  `letterSpacing`, `textWrap: 'nowrap'` + `textOverflow: 'ellipsis'` for
  one-line labels, `fontVariantNumeric: 'tabular-nums'` for numbers that
  change while you watch (timers, counters, prices).
- **Paint**: `backgroundColor`, `border: '1px solid $border'`, `borderRadius`,
  `boxShadow`, `backgroundImage: 'linear-gradient(...)'`, `opacity`,
  `transition: 150` (or `{ backgroundColor: 150 }`), `cursor: 'pointer'`.
- **Colours come from theme tokens**: `'$background'`, `'$surface'`,
  `'$text'`, `'$textMuted'`, `'$border'`, `'$accent'`, `'$accentText'`,
  `'$hoverBackground'`/`'$hoverText'` (selected row), `'$surfaceHover'`,
  `'$danger'`, `'$success'`, `'$warning'`, `'$info'`. On macOS these ARE the
  system's colours and follow light/dark and the user's accent. Hard-coded
  greys break dark mode.
- **Events**: `onClick`, `onMouseDown/Up/Move/Enter/Leave`, `onWheel`,
  `onKeyDown/Up` (needs `focusable`), `onContextMenu`. `<textinput>`'s
  `onChange(ev)` gives `ev.value`; `onSubmit` fires on Return. Every widget's
  `onChange` is an event too: `ev.value`. `Button` uses **`onPress`**.
  Keys: compare `ev.keysym` with `XK_RETURN`, `XK_ESCAPE`, `XK_UP`, `XK_DOWN`
  … from `'react-x11/keysyms'`.
- **Shortcuts**: `[['Control', 'S']]` means **⌘S** on macOS. Put them on
  `MenuBar` items (`shortcut`) or `useAccelerator([['Control','K']], fn)`.
  Never bind ⌘C/⌘V/⌘X/⌘A/⌘Z in a menu while a text field could be focused —
  fields handle those themselves and both would run.
- **Animation/timers**: `transition` for state changes; `setInterval` +
  state for clocks is fine. Respect `useSystemAppearance().reducedMotion`.
- **Data**: no `localStorage`. Persist with `createSettings({ appId, defaults })`
  from `react-x11` (`const [v, setV] = settings.use('key')`) or `node:fs`.
  `fetch` works (Node's). Prefer bundled sample data over network.

## What to reach for (check the names before using them)

**Core (`import { … } from 'react-x11'`)**: `createRoot`, `ThemeProvider`,
`useTheme`, `Button` (`primary`, `variant: 'solid'|'outline'|'ghost'`,
`size: 'small'`), `Checkbox`, `Switch`, `Radio`/`RadioGroup`, `Slider`,
`ProgressBar`, `Select` (`options`, `value`, `onChange`), `Tooltip`
(`label`), `Dialog` (`open`, `title`, `onClose`, `actions`), `MenuBar`,
`ContextMenu`, `SplitPane` (`direction`, `defaultSize`, `min`), `Icon`
(affordances only: `chevronRight|Left|Down|Up`, `check`, `dash`, `dot`,
`close`, `plus`, `moreVertical`, `eye`, `eyeOff`), `PasswordInput`.
Desktop: `useSystemAppearance`, `useFileDialog` (`openFile`, `saveFile`),
`useNotifier` (`notify({ summary, body })`, check `available`), `useAccelerator`, `createSettings`, `useWindowState`, `useTray`,
`useBadge`. SF Symbols for nouns: `<image src={{ symbol: 'folder' }} />`
(sized and coloured like the text around it).

**Components** — import from the **subpath**, not the barrel (core also exports
`Tabs`/`Table`; prefer these):

| import from `@react-x11/components/…`         | for                                  |
| --------------------------------------------- | ------------------------------------ |
| `charts` (`ChartContainer`, `LineChart`, `BarChart`, `AreaChart`, `ScatterChart`, `*Series`, `XAxis`, `YAxis`, `CartesianGrid`, `ChartTooltip`, `ChartLegend`) | charts, shadcn-shaped; give them ≥ 200px height |
| `table` (`Table`: `rows`, `columns`)           | sortable virtualized data table       |
| `tree` (`Tree`)                                | outline / file tree                   |
| `tabs` (`Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`) | tab strips              |
| `markdown` (`Markdown source=…`)               | rendered markdown                     |
| `code` / `code-editor` (`Code`, `CodeEditor`, `javascript()`, `sql()`) | code view / editor |
| `rich-text-editor` (`RichTextEditor`)          | WYSIWYG notes                          |
| `calendar` (`Calendar`, `DatePicker`), `color-picker` (`ColorPicker`, `ColorField`) | pickers |
| `timeline`, `reorder` (`ReorderList`), `flow` (`Flow`), `formula` (`Formula`), `html` (`Html`), `maps` (`Map`, needs network tiles), `three` (`Canvas`), `terminal` (`Terminal`, vt backend on macOS) | the rest |

Not on macOS: `MediaPlayer` and `TrayHost` (X11 embedding). For video use
core's `<video src="/abs/file.mp4" autoPlay />`.

## Where to look things up — read before writing code

You have what anyone who ran `npm install` has, and the public docs. No
checkout of either library: read the installed packages, and fetch the docs
sites. Read 2–3 examples close to your idea **before** writing your first
component, and grep the installed `.d.ts` for every prop you are unsure of —
it is the version you actually run.

- **Installed packages (ground truth)**, after `npm install`:
  - `node_modules/react-x11/README.md` — the overview, elements, 3D, hot
    reload, TypeScript; `node_modules/react-x11/src/index.d.ts` and
    `src/types/{elements,components,style,events}.d.ts` — every element,
    style key, event and built-in widget with its props.
  - `node_modules/@react-x11/components/README.md` — every component with
    a short example; `node_modules/@react-x11/components/dist/<name>/index.d.ts`
    — its props. The source ships too (`src/<name>/`), for when a type is not
    enough.
- **Core docs**, one page per topic:
  `https://sidorares.github.io/react-x11/docs/reference/<topic>` —
  `elements`, `styling`, `components` (the built-in widgets), `events`,
  `appearance`, `globalmenu`, `testing`, `system`, `filedialog`,
  `notifications`, `macos` (long). Start from
  `https://sidorares.github.io/react-x11/docs/getting-started`.
- **Component docs**:
  `https://sidorares.github.io/react-x11-components/docs/reference/components/<name>`
  — `charts`, `table`, `tree`, `tabs`, `markdown`, `code-editor`,
  `rich-text-editor`, `calendar`, `color-picker`, `timeline`, `reorder`,
  `flow`, `formula`, `html`, `maps`, `three`, `terminal`.
- **Core examples** (not in the npm package; on GitHub, fetch the raw files):
  `https://raw.githubusercontent.com/sidorares/react-x11/master/examples/<file>` —
  `finder.jsx` and `settings.jsx` (sidebar + content, Mac-like), `tasks.jsx`
  (list + input), `widgets.jsx` (every control), `dashboard.jsx`,
  `monitor.jsx` (big live list), `schedule.jsx` (sticky grid), `timer.jsx`,
  `menu.jsx`, `theming.jsx`; `README.md` is the tour.

## Verify — run it and LOOK at it

Green tests are not done. Every visual bug in this project's history passed
its tests and was obvious in a screenshot.

1. **Smoke test** `test/app.test.jsx` with `react-x11/test` (headless,
   in-process X server, no window opens):

   ```jsx
   import React from 'react';
   import { mkdirSync } from 'node:fs';
   import { test, afterEach } from 'node:test';
   import { renderX11, cleanup, screen, userEvent, toPNG } from 'react-x11/test';
   import App from '../app.jsx';

   afterEach(cleanup);
   const fonts = { 'sans-serif': '/System/Library/Fonts/Supplemental/Arial.ttf' };

   test('renders and responds', async () => {
     const { ctx } = await renderX11(<App />, { wrap: false, fonts });
     await userEvent.click(screen.getByRole('button', { name: 'Add one' }));
     screen.getByText('1', { exact: true });
     mkdirSync(new URL('../shots/', import.meta.url), { recursive: true });
     const file = new URL('../shots/headless.png', import.meta.url).pathname;
     await toPNG(ctx, file, { width: 720, height: 480 }); // the window's size
   });
   ```

   Queries: `getByText`, `getByRole(role, { name })`, `getByPlaceholder`,
   `findBy*`, `queryBy*`. `userEvent.click/type/key/hover/wheel`. Add
   `colorScheme: 'dark'` to a second render to check dark mode. A `getBy*`
   that matches twice throws — use `{ exact: true }` or `within(node)`.
   This path is the X11 backend: no native bezels, `MenuBar` draws inside the
   window, SF Symbol images draw nothing, and bold may come out regular (only
   the one font file is mapped) — all expected. Layout, spacing, colours and
   text are what to judge from it.
2. **Native screenshot** (opens a real window for ~3 s, then exits):

   ```bash
   mkdir -p shots && (caffeinate -u -t 6 &) && \
     SNAPSHOT="$PWD/shots/native.png" npm start
   ```

   Then **open the PNG with your Read tool and look at it** (2x scale, title
   bar included). A file under ~5 KB or fully transparent means the screen is
   asleep/locked — rely on the headless PNG and say so in NOTES.md. Skip this
   step if the environment variable `ONESHOT_NO_WINDOWS` is set.
3. Fix what looks wrong: clipped or overlapping text, a cramped or empty
   window, misaligned rows, a hard-coded colour that ignores dark mode, a
   control with no hover/press feedback. Re-shoot. Two or three passes.
4. Run `npm start` once more without `SNAPSHOT` in the background for ~5 s to
   confirm it stays up with no errors in the output, then stop it. With
   `ONESHOT_NO_WINDOWS` set, skip this too: `npm test` passing is the check.

Errors are written to be read: an unknown element lists the valid ones, a flat
style prop shows the fix. Read the message before guessing.

## Finish

`README.md`: one paragraph on what it does, `npm install && npm start`,
the shortcuts, and what is faked (sample data, etc.). `NOTES.md`: the
decisions. Leave the app in a state where `npm start` works.
