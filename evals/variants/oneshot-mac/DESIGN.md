# Designing a Mac app that looks like one

The audience uses Macs all day. They notice in a second when something is a web
page in a window. Aim for "this could ship in the App Store": quiet, dense,
aligned, keyboard-friendly, and correct in dark mode. Part 1 is the Mac
convention; part 2 is how to get each piece out of react-x11; part 3 is what
to avoid.

## Part 1 — the conventions (Apple HIG, condensed)

### Window anatomy

- **One main window** with a clear structure. The three standard layouts:
  - **Sidebar + content** (Mail, Notes, Music, Finder): a source list on the
    left, 200–260 pt wide, then the content. The default for anything with
    "collections" of things.
  - **Sidebar + list + detail** (Mail, Notes): three columns; the middle list
    ~260–320 pt.
  - **Content + inspector** (Pages, Keynote, Xcode): a 240–300 pt panel on the
    right with properties of the selection.
  - A single-purpose utility (timer, calculator, converter) is one compact
    window with no sidebar — and that is fine.
- **Toolbar** under the title: a 38–52 pt strip holding the few most-used
  actions, a search field at the trailing end, the title/segmented view
  switcher in the middle if there is one. Icon buttons, not text buttons.
- **Sheets/popovers** for short tasks: a modal sheet for "New item…" forms,
  a popover for a small editor anchored to what it edits. Never a full-window
  takeover for a 3-field form.
- **Default size** big enough to show the content without scrolling the
  chrome: 900×600 for a sidebar app, 720×480 for a simple one, ~360×480 for a
  utility. **Always set a minimum size** (~ 600×400 for sidebar apps) so the
  layout never collapses.

### The menu bar

Every Mac app has one, and users try shortcuts before they look for buttons.

| Menu        | Items (shortcut)                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------- |
| *App name*  | About, Settings… (⌘,), Hide (⌘H), Quit (⌘Q)                                                       |
| File        | New (⌘N), Open… (⌘O), Close Window (⌘W), Save (⌘S), Save As… (⇧⌘S), Export…, Print… (⌘P)          |
| Edit        | Undo (⌘Z), Redo (⇧⌘Z), Cut/Copy/Paste (⌘X/⌘C/⌘V), Delete, Select All (⌘A), Find… (⌘F)              |
| View        | Show/Hide Sidebar (⌃⌘S), view modes (⌘1, ⌘2, …), Zoom In/Out (⌘+/⌘−), Enter Full Screen (⌃⌘F)      |
| *App menus* | the app's own verbs (Item, Format, Playback, …), each with shortcuts for the frequent ones        |
| Window      | Minimize (⌘M), Zoom                                                                                |
| Help        | *App* Help                                                                                         |

Rules: an item that opens a window or asks for more input ends in "…";
disabled (not hidden) when it does not apply; title case; every frequent
action has a shortcut and appears in a menu even if it also has a button.

### Typography

SF Pro is the system font (`sans-serif`/`system-ui` resolves to it).

| Role                     | Size / weight      |
| ------------------------ | ------------------ |
| Body, controls, lists    | 13 regular         |
| Emphasised body / headline | 13 semibold (600) |
| Secondary / subheadline  | 11–12 regular, secondary colour |
| Caption, sidebar section | 10–11, secondary colour (section headers may be semibold) |
| Title 3 / Title 2        | 15 / 17 semibold   |
| Title 1                  | 22 regular/semibold |
| Large title (rare)       | 26 bold            |

At most three sizes on a screen. Hierarchy comes from weight and the
secondary colour, not from size jumps. Numbers that change use tabular figures.

### Colour

- Use **semantic** colours: window background, control background (raised
  surfaces, lists), label (primary ink), secondary label, separator, accent,
  selected-content background (a selected row), red/green/orange/blue for
  status. Never hard-code grey: it will be wrong in dark mode.
- **The accent is the user's**, not yours. Use it for the primary button, the
  selection, focus, toggles, links. A brand colour only where it means the
  brand (an illustration, a chart series).
- Colour is a **highlight**, not the ground: 90% of the window is neutral.
  Big saturated panels are a web look.
- **Light and dark** both have to look intended. Shadows nearly vanish in
  dark; separation comes from slightly lighter surfaces instead.

### Spacing and sizes

- 4/8 pt grid. **20 pt** window margins, **8 pt** between related controls,
  **16–20 pt** between groups, 6–12 pt padding inside rows.
- Regular controls are ~22 pt tall (push buttons, popups, text fields);
  list rows 24–28 pt (sidebar rows ~28); toolbar items 28 pt.
- Corner radius: 5–6 pt for controls, 8–10 for panels/cards, 10–12 for
  popovers and sheets. Keep it consistent.
- Separators are 1 px hairlines in the separator colour, not borders
  around every box.
- Align everything to a few vertical lines. Labels in forms right-aligned
  against a column of fields (Settings style), or stacked above in narrow
  panes.

### Interaction

- **Every input gets an answer on the event that started it**: hover tint,
  a distinct pressed state on mouse-down, then the action on release.
- **Keyboard**: Tab moves focus, Space/Return activate, arrows move through
  lists and grids, Return confirms a sheet, Escape cancels it, ⌘F focuses
  search, Delete removes the selection. Focus rings are visible on keyboard
  focus.
- **Selection** is a filled row in the selected-content colour with white
  text; one click selects, double-click (or Return) opens.
- **Right-click** shows a context menu with the item's verbs.
- **Empty states**: a short centred line in the secondary colour ("No
  Notes"), an optional one-line explanation, and at most one button. Never a
  blank pane, never a giant illustration.
- **Undo** anything destructive, or confirm it in a sheet with a red button
  named for the action ("Delete 3 Items"), Cancel as the default.

### Icons

SF Symbols style: simple, monoline, sized and weighted like the text beside
them, drawn in the text colour (or the accent when selected/active). Icons
label things in sidebars and toolbars; they do not decorate paragraphs.
No emoji as UI icons.

### Motion

Subtle and fast: 120–200 ms ease for hover, selection and disclosure; nothing
bounces; nothing animates on a timer that the user did not start. When the
user asked for **Reduce Motion**, cross-fade or cut instead.

### Accessibility

Every control has a name a screen reader can say (icon-only buttons need a
label). Text contrast at least 4.5:1. Nothing is reachable by mouse only.
Don't encode state in colour alone (add an icon or a word).

## Part 2 — the same thing in react-x11

| Convention | How (verified against react-x11 2.50 / components 0.25) |
| --- | --- |
| Window, size, min size | `<window title="…" width={900} height={600} minWidth={600} minHeight={400}>`. `minWidth`/`minHeight` become the NSWindow's own limits. `resizable` and `decorations` are read once at creation. |
| App name in menu bar / ⌘-Tab | `createRoot({ cocoa: { appName: 'Notes' } })`. |
| Menu bar | `<MenuBar menus={[…]} />` inside the window: on macOS it **becomes the system menu bar** and draws nothing in the window. Items: `{ label, onSelect, shortcut: [['Control','N']], enabled, type: 'separator', items: [...], toggleType: 'checkmark', toggleState: 0|1 }`. `Control` is **⌘** on macOS; `['Control','Shift','S']` is ⇧⌘S; `['Control','Alt','S']` is ⌥⌘S. |
| App menu | Synthesized, with **Quit (⌘Q) only**, titled with `appName`; you cannot add About/Settings to it yet. Put "Settings…" at the end of your first menu (or under a "Window"/"Help" menu) — say so in NOTES.md. |
| Edit menu | `<textinput>`/`<textarea>` already do ⌘X/⌘C/⌘V/⌘A/⌘Z/⇧⌘Z and have a right-click edit menu. **Do not** put those chords on menu items while a field can have focus — both would run. An Edit menu with app-level items (Delete, Find… ⌘F, Duplicate ⌘D) is fine. |
| Shortcut not in a menu | `useAccelerator([['Control','K']], fn)`. |
| Sidebar | A `<box>` of fixed `width` (200–240), `backgroundColor: '$surfaceHover'`, `borderEndWidth: 1, borderColor: '$border'`, `padding: 8, gap: 2`. Rows: `flexDirection: 'row', alignItems: 'center', gap: 8, paddingInline: 8, height: 28, borderRadius: 6`, hover `':hover': { backgroundColor: '$surfaceActive' }`, selected `backgroundColor: '$hoverBackground'` with text `color: '$hoverText'`. Section headers: `fontSize: 11, fontWeight: 600, color: '$textMuted'`. See `examples/finder.jsx`, `examples/settings.jsx`. |
| Resizable split | `SplitPane` (`direction`, `defaultSize`, `min`, `minSecond`) from `react-x11`. |
| Toolbar | There is no native unified toolbar or transparent title bar. Draw a row under the title bar: `height: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingInline: 12, borderBottomWidth: 1, borderColor: '$border'`, holding `Button variant="ghost" size="small"` icon buttons, a `<textinput placeholder="Search">` at the end. |
| Buttons | `Button` — on macOS they wear **AppKit's real bezels** by default (`ThemeProvider value={{ controls: 'drawn' }}` opts out). `primary` = the default (accent) button; one per view. `variant="outline"` for secondary in a footer; `variant="ghost" size="small"` for toolbar/inline icon buttons. `onPress`. Native bezels keep their own height; `style` sizes the slot. |
| Other controls | `Checkbox`, `Switch`, `RadioGroup`/`Radio`, `Slider`, `Select` (its menu is a real NSMenu), `ProgressBar` (`indeterminate`), `Tooltip label="…"`, `<textinput placeholder>`, `<textarea>`. All `onChange(ev)` → `ev.value`. |
| Segmented view switcher / tabs | `Tabs, TabsList, TabsTrigger, TabsContent` from `@react-x11/components/tabs`. |
| Sheet / modal | `Dialog` (`open`, `title`, `onClose`, `actions={<>…buttons…</>}`) — a real modal window that traps focus, Escape closes. (A true attached sheet is not available.) |
| Popover / menu | `ContextMenu items={…}` around a node (a native NSMenu on macOS); `<popup anchor={{ to: ref, placement: 'bottom' }}>` for a custom popover (see `docs/elements.md` "`anchor`"). |
| Lists / tables / trees | `Table` (`@react-x11/components/table`: `rows`, `columns: [{ id, label, flex|width, value, align }]`, `onActivate`), `Tree` (`…/tree`). Hand-rolled rows for short lists. |
| Type scale | `<ThemeProvider value={{ fontSize: 13 }}>` at the root (the built-in default is 14, which reads large on a Mac). Then `fontSize: 11 / 13 / 15 / 17 / 22`, `fontWeight: 600` for headings, `color: '$textMuted'` for secondary text, `fontVariantNumeric: 'tabular-nums'` for live numbers. Don't set `fontFamily` — the default is SF. |
| Colours | Tokens only: `$background` (window), `$surface` (lists, cards, fields), `$surfaceHover`, `$surfaceActive`, `$text`, `$textMuted`, `$border`, `$accent`/`$accentText`, `$accentHover`, `$hoverBackground`/`$hoverText` (selected row), `$danger`, `$success`, `$warning`, `$info`, `$link`. On macOS these are read from AppKit and follow light/dark and the user's accent live. A tinted alert: `tint(theme.danger, 0.12)` from `react-x11/style` as background, `$danger` as ink. |
| Light/dark, accent, reduce motion | Automatic for tokens. Read values with `useSystemAppearance()` → `{ colorScheme, accent, reducedMotion, … }`; `useTheme()` gives the resolved palette as an object (for `<canvas>` drawing or charts). |
| Hover / press | Widgets do it. For your own clickable `<box>`: `cursor: 'pointer'`, `':hover': { backgroundColor: '$surfaceHover' }`, `':active': { backgroundColor: '$surfaceActive' }`, `transition: 120`. State blocks may set paint properties only. |
| Focus & keyboard | `focusable` (+ `tabIndex`) on custom interactive boxes; the focus ring is drawn automatically on keyboard focus. `onKeyDown` with `ev.keysym === XK_DOWN` etc. from `react-x11/keysyms`. `autoFocus` on the first field of a dialog. |
| Icons | Nouns: SF Symbols, `<image src={{ symbol: 'tray.full' }} />` — sized from the inherited `fontSize`, tinted by `color`, `weight`/`scale` keys available. Affordances: `<Icon name="chevronRight|chevronDown|check|close|plus|moreVertical|eye|eyeOff|dash|dot" />` from `react-x11`. Icon-only button: `<Button variant="ghost" size="small" aria-label="Add"><Icon name="plus" /></Button>`. |
| Motion | `transition: 150` or `{ backgroundColor: 150, left: 200 }`; `transition: reducedMotion ? 0 : 150`. |
| Empty state | A centred column: `<image src={{ symbol: 'note.text' }} style={{ fontSize: 32, color: '$textMuted' }} />`, a 15 semibold line, a 13 `$textMuted` line, one `Button`. |
| Accessibility | Widgets announce themselves. Add `aria-label` on icon-only buttons and on custom controls (`role="button"`, `role="listitem"`, `aria-selected`). |
| Files, notifications, persistence | `useFileDialog()` → `openFile/saveFile` (native panels, resolve to paths or `null`); `const n = useNotifier(); if (n.available) n.notify({ summary, body })` — an unbundled `node` process may have no notification permission, so never make it load-bearing; `createSettings({ appId: 'com.example.x', defaults })` to remember state. |
| Charts | `@react-x11/components/charts`, series colours `'$accent'`, `'$info'`, `'$success'`; ≥ 200 px tall; a `ChartTooltip`. |

## Part 3 — what makes it look like a website (avoid)

- **Hero headers**: a 40 pt title with a tagline at the top of the window. A
  Mac window's title is in the title bar; content starts with content.
- **Card soup**: every item in a rounded, shadowed, padded card on a grey
  page. Use lists with separators or selection; reserve cards for genuinely
  visual items (a gallery, a dashboard tile).
- **Centred landing pages**: content in a narrow centred column with empty
  sides. Fill the window; align to the leading edge.
- **Hamburger menus, bottom tab bars, floating action buttons**: phone/web
  patterns. Use the menu bar, a sidebar, a toolbar.
- **Big full-width buttons** (the column-stretch trap) and buttons that are
  links. Buttons are compact and sit in a trailing row or a toolbar.
- **Gradients, glows, neon accents, emoji icons, giant drop shadows,
  everything rounded to 16+ pt**.
- **Custom colour palettes that ignore dark mode** or override the accent.
- **Fake data that looks fake** ("Lorem ipsum", "Item 1, Item 2"). Seed with
  10–30 plausible, varied, real-sounding records — it is the cheapest polish
  there is.
- **Placeholder features**: a button that does nothing. Cut it, or disable it
  and note why.
- **Modal alerts for success** ("Saved!"). Show state in place; reserve
  dialogs for decisions.

A final check before you call it done: squint at the screenshot. Is there one
obvious primary area, consistent left edges, consistent row heights, one
accent-coloured thing per region, and nothing clipped? If it looks like a
settings pane from macOS rather than a landing page, you are there.
