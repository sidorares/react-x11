# Design

How this app should look and behave. People and coding agents both read it
before changing the UI.

The first section is this app's brief: fill it in. The rest is the house
style react-x11 2.51.1 starts every app with: the conventions of the
desktops the app runs on, and how to get each one out of react-x11. Change
any of it that this app does differently. Then the agent follows your rules
and not the defaults.

## This app

- **What it is**: _one line: what someone opens it to do._
- **Who uses it, and how often**: _all day, or once a week?_
- **Platforms**: macOS, Windows and Linux, each looking like itself. _Or
  name the one that matters most._
- **Layout**: _sidebar and content, three panes, content and inspector, or
  one compact window (see "Window anatomy")._
- **Density**: regular. _Compact for a data-heavy tool._
- **Colour**: the desktop's own, with the user's accent. No brand palette.
  _If there is a brand colour, name it and the one or two places it may
  appear._
- **Voice**: short and plain. Buttons are verbs ("Add Account", not "OK").

## Look like the desktop it runs on

A desktop app is quiet, dense, aligned and driven from the keyboard. It is
light or dark because the desktop is. People notice in a second when an app is
a web page in a window.

react-x11 gives you most of this already:

- The theme tokens are the desktop's palette, its light or dark scheme and its
  accent.
- The widgets wear AppKit's own bezels on macOS.
- `MenuBar` goes where the platform keeps menus.

Keep those defaults, and spend the effort on layout, copy and behaviour.

## Window anatomy

- **One main window** with a clear structure. Pick one of the standard
  layouts:
  - **Sidebar and content** (Mail, Files, Explorer): a list of places or
    collections on the left, 200–260 px wide, then the content. This is the
    default for anything with collections of things.
  - **Sidebar, list and detail**: three columns, with the middle list
    260–320 px wide.
  - **Content and inspector**: a 240–300 px panel on the right with the
    properties of the selection.
  - **One compact window** for a single-purpose utility: a timer, a
    converter. This needs no sidebar.
- **A toolbar** under the title bar: a 40–48 px row with the few most-used
  actions as icon buttons, and a search field at the trailing end.
- **Dialogs for short tasks**: a modal dialog for a three-field "New item…"
  form, and a popup anchored to what it edits for a small editor. Never take
  over the whole window for a short form.
- **Size**: 900×600 by default for a sidebar app, 720×480 for a simple one,
  about 360×480 for a utility. **Always set a minimum size** (about 600×400
  for a sidebar app), so the layout never collapses.

## Menus and shortcuts

People try a shortcut before they look for a button. Write shortcuts with
`Control`: it is ⌘ on macOS and Ctrl elsewhere. The standard menus, in order:

- **File**: New (Control+N), Open… (Control+O), Close Window (Control+W), Save
  (Control+S), Save As… (Control+Shift+S), Export…, Print… (Control+P)
- **Edit**: Undo, Redo, Cut, Copy, Paste, Delete, Select All, Find…
  (Control+F)
- **View**: Show or Hide Sidebar, view modes (Control+1, Control+2, …), Zoom
  In and Zoom Out
- _the app's own_: its own verbs (Item, Format, Playback, …), with shortcuts
  for the frequent ones
- **Help**: _App name_ Help

And the rules around them:

- **Where the menu shows**: on macOS `MenuBar` becomes the system menu bar.
  On Linux it goes to the desktop's panel where one hosts menus (KDE
  Plasma), and is drawn in the window everywhere else, Windows included.
- **Settings and Quit**: on macOS, react-x11 adds the app menu itself, with
  Quit (⌘Q) only. Put "Settings…" (Control+,) at the end of your first menu.
  On Windows and Linux, put Settings… in Edit or File, and Quit (Control+Q) at
  the end of File.
- An item that opens a window or asks for more ends in "…". An item that does
  not apply is disabled, not hidden. Every frequent action is in a menu, even
  when it also has a button.
- The text fields already handle Copy, Paste, Cut, Select All, Undo and Redo,
  with a right-click menu of their own. Do not put those shortcuts on menu
  items while a field can have focus: both would run.

## Type

- **Base size**: 13 on macOS, which is AppKit's body size, and 14 elsewhere,
  which is react-x11's default. Set it once at the root (see the recipes
  below). Never set `fontFamily`: the default is the system's UI face.
- **Scale**: base for body, controls and lists; base −2 in `'$textMuted'` for
  secondary text and captions; base +2 and +4, semibold (600), for titles; base
  +9 for a rare large title. Use at most three sizes on one screen.
  Hierarchy comes from weight and the muted colour, not from size jumps.
- A number that changes while you watch (a timer, a price, a count) uses
  `fontVariantNumeric: 'tabular-nums'`.
- A one-line label that can overflow: `textWrap: 'nowrap'` and
  `textOverflow: 'ellipsis'`.

## Colour

- **Semantic tokens only**: `'$background'` for the window, `'$surface'` for
  lists, fields and raised areas, `'$text'`, `'$textMuted'`, `'$border'` for
  separators, `'$accent'`, `'$hoverBackground'` and `'$hoverText'` for a
  selected row, and `'$danger'`, `'$success'`, `'$warning'`, `'$info'` for
  status. A hard-coded grey is wrong in light or in dark.
- **The accent is the user's**, not yours. Use it for the primary button, the
  selection, focus and toggles.
- **Colour highlights; it is not the ground.** Most of a window is neutral.
  Big saturated panels are a web look.
- **Light and dark both look intended.** Shadows almost vanish in dark, so
  separation comes from a slightly lighter surface instead.

## Spacing and sizes

- A 4 and 8 px grid: 20 px window margins (16 compact), 8 px between related
  controls, 16–20 px between groups, 6–12 px of padding inside a row.
- Let the widgets size themselves: they follow the platform. Rows you draw
  yourself: 28 px on macOS, 32–36 px elsewhere.
- Corners match the widgets'. `useTheme().radius` is their radius.
- Separators are 1 px lines in `'$border'`, not borders around every box.
- Align everything to a few vertical lines. Form labels are either
  right-aligned against a column of fields or stacked above them in a narrow
  pane.

## Interaction

- **Every input gets an answer on the event that started it**: a hover tint,
  a distinct pressed state on mouse down, then the action on release.
- **Keyboard**: Tab moves focus, Space and Return activate, arrows move
  through lists and grids, Return confirms a dialog, Escape cancels it,
  Control+F focuses search, Delete removes the selection. The focus ring
  shows on keyboard focus.
- **Selection**: one click selects (a filled row in `'$hoverBackground'`),
  and a double click or Return opens.
- **Right click** shows a context menu with the item's verbs.
- **Dialog buttons** are named for what they do ("Delete 3 Items", not
  "Yes"). On macOS and GNOME, Cancel comes first and the action is last, at
  the trailing edge. On Windows and KDE the action comes first, then Cancel.
- **Destructive actions** can be undone, or are confirmed in a dialog whose
  button says what it deletes.
- **Empty states**: a short centred line in `'$textMuted'` ("No Notes"), an
  optional one-line explanation, and at most one button. Never a blank pane.
- **Success is shown in place**, not in a "Saved!" dialog. Dialogs are for
  decisions.

## Icons

- Icons label places and actions in sidebars and toolbars. They do not
  decorate paragraphs. Never use emoji as UI icons.
- Use the platform's own icons, which are monoline, sized like the text and
  drawn in its colour: `<image src={{ symbol }} />` draws an SF Symbol on
  macOS (`'folder'`) and an icon from the freedesktop theme on Linux
  (`'folder-symbolic'`). A name the desktop lacks draws nothing, and Windows
  has no icon theme to draw from. So an icon is never the only label, and an
  app that needs icons everywhere ships its own.
- Affordances (chevrons, check, close, plus, more) come from `<Icon name>`,
  which is the same everywhere.

## Motion and accessibility

- Motion is subtle and fast: 120–200 ms for hover, selection and disclosure.
  Nothing bounces, and nothing animates on a timer the user did not start.
  With reduced motion on, cut or cross-fade instead.
- Every control has a name a screen reader can say: an icon-only button needs
  an `aria-label`. Text contrast is at least 4.5:1. Nothing is reachable by
  mouse only. State is never shown by colour alone: add an icon or a word.

## The same, in react-x11

- **Window size and minimum**: `<window title="…" width={900} height={600}
minWidth={600} minHeight={400}>`
- **The app's name on macOS**: `createRoot({ cocoa: { appName: 'Notes' } })`:
  what the menu bar and ⌘-Tab show. Without it they say "node".
- **Base type size**: `<ThemeProvider value={{ fontSize: process.platform ===
'darwin' ? 13 : 14 }}>` around the app.
- **Menu bar**: `<MenuBar menus={[{ label: 'File', items: [...] }]} />` inside
  the window. Item: `{ label, onSelect, shortcut: [['Control', 'N']], enabled,
items }`, or `{ type: 'separator' }`. A check item: `toggleType:
'checkmark', toggleState: 0 or 1`.
- **A shortcut with no menu item**: `useAccelerator([['Control', 'K']],
handler)`
- **Sidebar**: a `<box>` with `width: 220`, `backgroundColor: '$surface'`,
  `borderEndWidth: 1`, `borderColor: '$border'`, `padding: 8`, `gap: 2`. Rows:
  `flexDirection: 'row'`, `alignItems: 'center'`, `gap: 8`, `paddingInline:
8`, `borderRadius: 6`, `':hover': { backgroundColor: '$surfaceHover' }`, and
  when selected `backgroundColor: '$hoverBackground'` with text in
  `'$hoverText'`. Section headers: base −2, `fontWeight: 600`, `'$textMuted'`.
  See `examples/finder.jsx` and `settings.jsx`.
- **Resizable split**: `<SplitPane direction="row" defaultSize={240}
min={180}>` with two children.
- **Toolbar**: a row under the title bar: `flexDirection: 'row'`, `alignItems:
'center'`, `gap: 8`, `height: 44`, `paddingInline: 12`, `borderBottomWidth:
1`, `borderColor: '$border'`. Icon buttons in it, then `<textinput
placeholder="Search" />` last.
- **Buttons**: `<Button onPress={…}>`. `primary` is the default action, one
  per view. `variant="outline"` for a secondary one, `variant="ghost"
size="small"` for toolbar and inline icon buttons. Never size a `Button`
  yourself: `style` sizes its slot.
- **Other controls**: `Checkbox`, `Switch`, `RadioGroup` and `Radio`,
  `Slider`, `Select` (`options`, `value`), `ProgressBar`, `Tooltip label="…"`,
  `<textinput placeholder>`, `<textarea>`. Every `onChange(ev)` gives
  `ev.value`.
- **Tabs**: `<Tabs items={[{ id, label, content }]} />`
- **Modal dialog**: `<Dialog open title="…" onClose={…}
actions={<>…buttons…</>}>`: a real window that keeps focus. Escape and the
  close button call `onClose`. `autoFocus` on its first field.
- **Context menu and popover**: `<ContextMenu items={[…]}>` around the node it
  belongs to. `<popup anchor={{ to: ref, placement: 'bottom' }}>` for a custom
  popover.
- **Lists, tables, trees**: `Table` (`columns: [{ id, label, width, value,
align }]`, `rows`, `onActivate`) for sortable, virtualized data. `Tree` from
  `@react-x11/components/tree`. Draw short lists yourself.
- **Hover and press on your own box**: `cursor: 'pointer'`, `':hover': {
backgroundColor: '$surfaceHover' }`, `':active': { backgroundColor:
'$surfaceActive' }`, `transition: 120`.
- **Focus and keys**: `focusable` (and `tabIndex`) on a custom control, and
  the focus ring comes with it. `onKeyDown={(ev) => ev.keysym === XK_DOWN &&
…}` with keysyms from `react-x11/keysyms`. `role` and `aria-label` so a
  screen reader can name it.
- **Light, dark, reduced motion**: tokens follow the desktop.
  `useSystemAppearance()` gives `{ colorScheme, accent, reducedMotion, … }`,
  and `transition: reducedMotion ? 0 : 150` respects it.
- **A tinted alert**: `backgroundColor: tint(theme.danger, 0.12)` with `tint`
  from `react-x11/style` and `theme` from `useTheme()`, and `'$danger'` for
  its text.
- **Files, notifications, settings**: `useFileDialog()` gives `openFile()` and
  `saveFile()`, which resolve to paths or `null`. `useNotifier()` gives
  `notify({ summary, body })`: check `available` first and never depend on it.
  `createSettings({ appId, defaults })` remembers state.
- **Charts**: `@react-x11/components/charts`, at least 200 px tall, with
  series in `'$accent'`, `'$info'`, `'$success'`, and a tooltip.

## What makes it look like a website (avoid)

- **A hero header**: a big title and tagline at the top of the window. The
  window's title is in the title bar, and content starts with content.
- **Card soup**: every item in a rounded, shadowed, padded card on a grey
  page. Use lists with separators and selection. Keep cards for things that
  are visual: a gallery, a dashboard tile.
- **A centred landing page**: content in a narrow column with empty sides.
  Fill the window and align to the leading edge.
- **Phone and web patterns**: hamburger menus, bottom tab bars, floating
  action buttons. Use the menu bar, a sidebar, a toolbar.
- **Wide buttons**: the column-stretch trap, and buttons styled as links.
  Buttons are compact and sit in a row at the trailing edge or in a toolbar.
- **Gradients, glows, neon, emoji icons, big shadows**, and everything
  rounded to 16 px or more.
- **A palette of your own that ignores dark mode**, or replaces the user's
  accent.
- **Sample data that looks fake**: "Lorem ipsum", "Item 1, Item 2". Seed 10–30
  plausible, varied records. It is the cheapest polish there is.
- **Buttons that do nothing.** Cut them, or disable them and say why.

## Before calling it done

Look at a picture of every screen, in light and in dark. Is there one
obvious primary area? Do the leading edges line up, and are the row heights
consistent? Is there one accent-coloured thing per region, and is nothing
clipped? If it looks like part of the operating system rather than a
landing page, it is done.
