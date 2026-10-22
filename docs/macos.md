# A native macOS backend

On macOS `createRoot()` renders through **Cocoa** by default: real
`NSWindow`s, Core Animation compositing, the system menu bar and native
control bezels, with no X server anywhere. The tree, components, styles and
hooks are the same; this page is what an app sees differently here, and what
it does not have yet. The design record — presenters, threads, the bridge
contract, measurements, the plan — is [design/macos.md](../design/macos.md).

## Choosing the backend

`createRoot({ backend })`:

- `'auto'` (the default) — Cocoa on macOS where the bridge is installed, X11
  through `$DISPLAY` (XQuartz) where it is not.
- `'cocoa'` — Cocoa, with the bridge **required**.
- `'x11'` — X11 through XQuartz, still the way to run X-only features
  (`<foreign>`, `examples/wm.jsx`) on a Mac.

`REACT_X11_BACKEND=x11` or `=cocoa` overrides both. `createRoot({ app })`
ignores `backend`: a connection already is one.

The bridge is **[`@windowkit/appkit`](https://www.npmjs.com/package/@windowkit/appkit)**,
an `optionalDependency` with N-API prebuilds for arm64 and x64, so it works
under Node and Bun. An install that skips optional dependencies has no
bridge, and `'auto'` falls back to X11. The range react-x11 asks for has
everything on this page; where an older bridge lacks a verb, the feature is
detected and degrades as described below.

## Root options and environment

`createRoot({ cocoa: { … } })`, ignored off macOS and when `app` is passed:

- `presenter` — `'surface'` (the default: one bitmap per window) or
  `'layers'` (one CALayer per drawn node, opt-in while it is measured).
  `REACT_X11_COCOA_PRESENTER` says the same.
- `promote` — [layer promotion](#layer-promotion-the-animated-few-on-their-own-layers-above-the-surface-presenter)
  of animated boxes; `false` keeps every animation on the frame clock.
  `REACT_X11_COCOA_PROMOTE=1`/`=0` says the same.
- `frameInterval` — ms between scheduled frames. By default each window
  paces itself on its own display (8.3 ms at 120 Hz, 16.7 at 60); a number
  applies to every window.
- `pumpInterval` — ms between AppKit event pumps (8) when the app's JS runs
  on the main thread: the floor under input latency there. A
  [worker](#js-on-a-worker-a-ui-thread-of-the-bridges-own) has no pump.
- `resizeWait` — ms AppKit may hold a live-resize tick for the app's frame at
  the new size, on a worker (50; `0` lets the edge move without waiting).
- `paneStretch` — when a `<Frame>` pane's last frame is stretched while its
  next one comes: `'behind'` (the default: once it is later than
  `resizeWait`), `'never'` or `'always'`. `REACT_X11_COCOA_PANE_STRETCH` says
  the same.
- `screenPoll` — ms between re-reads of the screen layout while a
  `useScreens()` subscriber is mounted (500; `0` for never).
- `appName` — what the Dock, ⌘-Tab and the app menu print for an unbundled
  process; a bundle's `Info.plist` wins.
- `activationPolicy` — `'regular'` (the default: a Dock tile and a ⌘-Tab
  entry), `'accessory'` (a menu-bar app: windows, no tile) or `'prohibited'`.
  On a worker, set it [at launch](#js-on-a-worker-a-ui-thread-of-the-bridges-own).
- `exitOnQuit` — end the process once a quit request (the Dock's Quit, ⌘Q, a
  logout) has closed the app (`true`); `false` is for an embedder that owns
  the process's lifetime.

Other variables: `REACT_X11_THREADED=0` (keep the JS on the main thread),
`APPKIT_ACTIVATION_POLICY` (the policy AppKit launches with),
`REACT_X11_CALAYERS_PATH` (where the bridge's addon is, for a
[compiled binary](#running-as-an-app-bundle)), and
[`REACT_X11_NO_STROKE_CHUNKING=1`](#stroking-a-path-with-many-subpaths) and
[`REACT_X11_NO_SHADOW_TILES=1`](#a-shadow-from-a-tile).

The `desktop` option defaults to `{ a11y: false, globalMenu: false }` here:
AT-SPI and the D-Bus menu export have nothing to register against on a Mac.
The menu bar is [the system's own](#menus-the-global-menu-finally-at-home)
regardless.

## Windowing semantics: what maps, what bends, what breaks

macOS has no separate window manager, so what one does is where the backends
part company. The per-prop list is
[elements.md](elements.md#on-the-cocoa-backend); in short:

- **Maps**: `<window>` is an `NSWindow` that places itself (`x`/`y` work),
  min/max sizes are its own, and its size is a whole number of points,
  rounded up. `resizable` and `decorations` are read once, at creation.
  `fullscreen`, `maximized`, `hidden` and `demands_attention` are the
  full-screen Space, the zoom, the Dock and the Dock bounce.
- **Better**: `transparent` and a window's `borderRadius` always work —
  every window composites, so `useSupports('transparency')` is always true.
- **Inert**: the `sticky`, `below`, `skip_taskbar` and `shaded` states;
  `appId`, `windowType`, `gravity` and the increment and aspect hints (bundle
  identity lives in `Info.plist`); `transientFor`, for now — a managed
  `<Dialog>` floats on its own window anyway. `onClientMessage` never fires.
- **`<popup>`** is a borderless panel at the popup level, placed by the same
  anchor math. `grab` bends: there are no pointer grabs, so a press in
  another of the app's windows reaches the popup as a press outside it,
  which dismisses it. `grabKeyboard` makes a key-capable window, as
  `NSPopover` does, which closes on `onBlur` ([elements.md](elements.md)).
- **`<glarea>`** is a CGL context rendering into IOSurfaces on a sublayer
  ([gl.md](gl.md)); **`<Frame>`** works through shared surfaces rather than
  reparenting ([frame.md](frame.md)).
- **Screens** (`useScreens`) map, but macOS sends a client no event for a
  display change, so the layout is re-read on a clock while watched
  ([system.md](system.md#on-macos-the-layout-is-asked-for-not-announced)).
  `app.scale` is the screen's `backingScaleFactor`, read once, at startup.
- **Not yet**: nested `<window>` elements throw.
- **Gone by design**: `<foreign>` and XEmbed, a window manager
  (`examples/wm.jsx`), `ssh -X`. A `<foreign>` reports one `onError` and
  draws an empty box; `useSupports('embedding')` is false.

**Inert means inert, not fatal, and silent**: a prop with no meaning here is
accepted and does nothing, so the same JSX runs on every backend and shared
application code stays branch-free.

## Desktop integrations: what an app does outside its own windows

Most of these are [filedialog.md](filedialog.md)'s ladder: the platform's
mechanism, a shell-out beneath it, and a typed "cannot do this here" at the
floor.

- **File open/save**: `NSOpenPanel`/`NSSavePanel`, a sheet on the window that
  asked ([filedialog.md](filedialog.md)).
- **Raise**: `activateWindow()` activates the app and orders the window front.
- **Deep links, documents, reopen**: Apple Events into
  `useAppOpen`/`useAppActivate`; Quit is the primary window's close request;
  single instance is the platform default
  ([uri-schemes.md](uri-schemes.md#on-macos)).
- **Drag and drop with other apps**: AppKit's dragging behind the same
  `dropAccept`/`onDrag*`/`dragData` props
  ([drag-and-drop.md](drag-and-drop.md#interoperating-with-other-applications)).
- **Clipboard**: `NSPasteboard.general` as `CLIPBOARD`; `watch()` polls.
  No `PRIMARY`: selecting copies nothing ([clipboard.md](clipboard.md)).
- **Tray**: `useTray()` over `NSStatusItem`, icon names as SF Symbols
  ([desktop.md](desktop.md#the-tray)).
- **Dock**: `setBadge`/`useBadge`, the `demands_attention` bounce,
  `useLauncherMenu`; the name and activation policy are the `cocoa` options
  ([desktop.md](desktop.md#the-launcher-a-badge-attention-and-the-dock-menu)).
- **Permissions**: `usePermission()`/`requestPermission()` over TCC, and
  `openPrivacySettings`
  ([permissions.md](permissions.md#what-each-kind-actually-does-on-macos)).
- **Notifications**: `notify()` over `UNUserNotificationCenter`, only in a
  **code-signed app bundle**; `osascript` banners otherwise
  ([notifications.md](notifications.md)).
- **Calendar**: `useDesktopCalendarEvents()` over EventKit
  ([desktop-calendar.md](desktop-calendar.md)).
- **Eyedropper**: `pickScreenColor()` over `NSColorSampler`; the system draws
  the loupe, so no Screen Recording grant is needed. A bridge older than 0.9
  has no rung, and `useEyedropper().supported` is false
  ([eyedropper.md](eyedropper.md)).
- **Idle time**: `useIdle()`, from the bridge or `ioreg`
  ([system.md](system.md#useidle-and-usekeepawake--is-anyone-there)).
- **Appearance**: dark or light, the accent, and the desktop's whole palette
  ([appearance.md](appearance.md#the-desktops-palette)).
- **Keep-awake**: no macOS rung — `useKeepAwake()` holds nothing here.
- **Accessibility**: none yet ([below](#not-supported-yet)).

## Text

Text goes through CoreText behind the same API: the same `<text>` measures,
wraps, elides, selects and hit-tests on both backends, with the platform's
metrics, which differ from X11's. Layout can wrap differently across
backends; compare structure and behaviour across them, not pixels.

- **Fonts are the system's.** The CSS generic families map to system faces
  (`sans-serif` is San Francisco), `opsz` is CoreText's own optical sizing,
  and `-apple-system` and `BlinkMacSystemFont` read as `system-ui`, so a font
  stack written for the web sets in SF. Labels and emoji measure as AppKit
  sets them.
- **OpenType features** (`fontVariantNumeric`, `fontFeatureSettings`) and
  `letterSpacing` work; `letterSpacing` turns optional ligatures off, as on
  X11. A bridge too old for one draws the plain face and says so once in
  development.
- **Lines break** at the same UAX#14 opportunities as on X11, so a `<text>`
  in a flex item shrinks to the same min-content width; one that elides
  (`textOverflow: 'ellipsis'`) floors at its `…`. An empty paragraph is one
  empty line, so an empty field's caret has a line's height.
- **Antialiasing is greyscale**, as macOS has drawn it since Mojave.
- **Glyph-level drawing** (`drawGlyphs`, `positioned`, a face's
  `glyphIdFor`/`advanceOf`/`shape`/`metrics`, `fallbackFor`) answers ntk's
  contract, so a renderer written against ntk's context runs unchanged.
  Three differences: `shape()` substitutes fallback faces, so an emoji in
  Menlo comes out as the emoji where ntk shapes `.notdef`; every op draws as
  `Over`; and a transform scales glyphs as well as their origins.
- **`coverage()`** is the signed-area fill X11 uses, so both give the same
  bytes for the same outlines; colour emoji come out as silhouettes. A bridge
  without the verb answers `null`.
- **No input method yet**: dead keys, Press-and-Hold accents and CJK input
  wait on `NSTextInputClient` ([events.md](events.md#input-methods) says what
  a dead key types meanwhile).

## Input and the run loop

- **Pointer**: top-left coordinates, `clickCount` as `detail`, and a
  trackpad's precise deltas as the wheel's `smooth` flag.
- **Hover belongs to the active window**: a background window gets no
  `:hover`, enter, leave or motion until it is active, the platform's
  convention ([events.md](events.md#when-the-response-is-painted)). A first
  click on a background window still acts, and the wheel still scrolls it.
- **Modifiers**: ⌘ is `metaKey`, ⌥ is `altKey`. ⌘ is the app's primary
  modifier (`app.primaryModifier` is `'Super'`), so the text controls answer
  ⌘Z/⌘C/⌘V, their edit menu prints ⌘C, and a chord written with `Control`
  means ⌘ ([events.md](events.md#primary-modifier)).
- **Keys** arrive as the same `XK_*` keysyms as on X11, and shortcuts keep
  their Latin letters under a non-Latin layout. The lock state is readable
  before the first key.
- **Frames** are paced per window on its own display. A window that is
  ordered out, miniaturized or entirely covered by another app's window
  paints nothing — its frames and `requestAnimationFrame` callbacks wait —
  and gets one catch-up frame when it is back. A window fed off a stream (a
  terminal under `cat`) paints every refresh unless it sets
  `frameRate: 'adaptive'`
  ([elements.md](elements.md#framerate--pacing-the-frames-under-a-flood)).

## JS on a worker: a UI thread of the bridge's own

AppKit owns the process main thread and runs its menus, drags, live resizes
and modal panels there. So on macOS react-x11 **moves the app's JS onto a
`worker_threads` Worker** by default, and the main thread sits in a real
`[NSApp run]`: the JS keeps running through every menu and resize, and input
reaches it as it happens rather than at the next pump. It needs a bridge with
`runMain()` (`@windowkit/appkit` 0.10).

`node app.js` and `bun app.jsx` move with nothing asked for, and so does
`tsx app.jsx` on Node 24 and later. The launcher moves the app before its
entry is loaded at all, which is cheaper:

```sh
node --import react-x11/cocoa-main app.js
bun --preload react-x11/cocoa-main app.jsx
```

The app **stays on the main thread**, with the pump, off macOS; with
`REACT_X11_THREADED=0` or `REACT_X11_BACKEND=x11`; in a REPL or under `-e`;
in a single executable (a Node SEA, `bun build --compile`); in a `<Frame>`
pane; under a test runner; when react-x11 is imported after the app started
running (an `import()` the entry awaits, or one from a timer); and on Node 20
and 22 under an ES module loader (`--import`, `--loader`, tsx). There a menu,
a drag, a live resize or a modal panel stops the JS while it is open. The
startup cost of each route and the matrix by Node version are in
[packaging.md](packaging.md#on-macos-the-app-moves-onto-a-worker).

**A menu-bar app sets its policy at launch.** On a worker AppKit is up before
the app's code runs, so `cocoa: { activationPolicy }` can only switch it
afterwards, when a Regular launch has already shown a Dock tile. Launch with
the variable, or put `LSUIElement` in the bundle's `Info.plist`; an app whose
option disagrees with its launch is told so in development.

```sh
APPKIT_ACTIVATION_POLICY=accessory node --import react-x11/cocoa-main app.js
```

### What changes for an app

- About **16 MB** of RSS for the worker's isolate, and **26–31 ms** before
  the worker runs its first line.
- The idle app stops waking 125 times a second: the pump is an 8 ms interval
  whether anything happens or not.
- Inside a Worker, `process.chdir()` throws, `process.on('SIGINT')` is never
  called (the launcher forwards signals: a signal is re-emitted on the
  worker's `process`, and one nobody listens for exits with 128 + n),
  `process.env` is a copy unless it is shared, and `process.stdin` forwards
  through the main thread the way stdout does.
- **What the entry imports ahead of react-x11 runs twice**: on the main
  thread, then on the worker. A module that does work as it loads — opens a
  port, writes a file, logs — does it twice. A call only a main thread may
  make — `process.chdir()`, `process.umask(mask)` — goes through the first
  time and throws the second, and the app stops with that error and a word
  on why. Make it on the main thread only (`isMainThread`, from
  `node:worker_threads`): what it changes is the process's, so the worker
  starts with it. One made after the import runs on the worker alone and
  throws there. Import react-x11 first in the entry, or set
  `REACT_X11_THREADED=0` to keep the whole app on the main thread.
- `process.exit()` and an uncaught error end the app as they would a process
  of its own: exit handlers run, and the error is printed with exit code 1.
- `--inspect` attaches to the main thread; the app is the worker target
  beside it.
- A single executable does not move, and runs on the pump
  ([packaging.md](packaging.md)).

Not done yet on a worker:

- A dropped image, or any binary type, reads as nothing: the drop carries its
  text and URL forms.
- The layer presenter's colour transitions start from the declared value.
- A transparent window's shadow is recomputed a frame interval after a flip,
  not once the flip has committed.
- A worker that cannot load the entry stops the app: under tsx before 4.21.1
  on Node 24 and later, or tsx on Node 20 and 22 under the launcher, it stops
  as it starts on `ERR_UNKNOWN_FILE_EXTENSION`. Update tsx, or set
  `REACT_X11_THREADED=0`.
- Under Bun, react-x11 required from a callback before the entry has
  finished — a `nextTick` or microtask a CommonJS entry queues, a timer while
  an ES module entry awaits at top level — reads as the entry's first run,
  and that code runs again on the worker.
- Not yet tried on the worker: `<glarea>`'s GL context and
  `react-x11/refresh`'s module hooks.

## Native controls

`Button`, `Checkbox`, `Radio`, `Switch`, `Slider` and `Select` wear
**AppKit's own bezels** here by default; interaction, focus, keyboard and
accessibility stay the shared implementation. A bezel is an image drawn
through the ordinary paint path, not an embedded `NSView`
([components.md](components.md#native-bezels)).

- `ThemeProvider`'s `controls`: `'auto'` (the default) takes bezels wherever
  the backend has them — Cocoa, and win32 while the desktop is light — and
  draws elsewhere; `'native'` asks outright, and on a backend without them
  warns once and draws; `'drawn'` is this library's rendering everywhere.
  `native={false}` on one control is the escape hatch.
- `useSupports('nativeControls')` says whether the backend has them.
- A native control is **two boxes**: the footprint `style` sizes, and the
  control at AppKit's metrics, centred in it. Role, handlers, focus ring and
  ref are on the control, so a press in the slack around it does nothing.
- A `<Button>` label **wraps** when its row is too narrow, and the control
  grows with it; past one line it is AppKit's flexible push button, whose
  default-button accent is flat. A bridge too old for that bezel keeps the
  push and says so once in development.
- Text controls stay drawn: a native `NSTextField` would fork the shared
  editing model.
- Drawn content sits beside the bezels through the desktop's palette
  ([appearance.md](appearance.md#the-desktops-palette)).

## Menus: the global menu, finally at home

**The menu bar is the system's, always.** A window's `menus` go to the macOS
menu bar as soon as they are installed, the drawn bar never renders, and
`onGlobalMenuChange(true)` reports it ([globalmenu.md](globalmenu.md)). Item
icon names are SF Symbols.

- An **application menu** goes in front of the app's, carrying Quit (⌘Q).
  Quit is a quit request: the primary window's close request, which
  `onCloseRequest` can intercept, then, with `exitOnQuit`, the end of the
  process. Nothing else is synthesized — no About, Hide, Edit or Window
  menu — so an app that wants them names them in `menus`.
- **Accelerators**: `Control` in a chord is ⌘, so `[['Control', 'S']]` is ⌘S;
  there is no separate `Primary` token. The menu bar answers the chords it
  can spell — one chord, one character key — and reserves them so no window
  binding fires them twice; the rest (F5, `plus`, a second alternative) are
  matched by the window ([events.md](events.md#the-macos-menu-bar)).
- Where native controls render, `<ContextMenu>`, a `<MenuBar>`'s dropdowns
  and a `<Select>`'s drawn list are **sized as NSMenu is**: 22pt rows, 5pt
  padding, 11pt separators, the 13pt menu font.
- **A `<Select>`'s list is the real NSMenu**, dropped from the trigger as a
  browser drops a `<select>`'s; `nativeMenu` chooses
  ([components.md](components.md)).
- The Dock menu and a tray item's menu take the same item vocabulary
  ([desktop.md](desktop.md)).

## Custom drawing on a layer tree

`<canvas onDraw>`, `<svg>` and a registered element's `paint(ctx)` run
unchanged, through a CoreGraphics context that speaks the whole dialect:
canvas2d plus `fillRects`, `drawGlyphs`, `positioned`, `layoutSubtree` and
`vw`/`vh`/`em`.

**Offscreen surfaces.** `react-x11/ntk`'s `Surface` is a CoreGraphics bitmap
here, in device pixels. Unlike ntk:

- A surface has **one context for its life**: `getContext('2d')` answers the
  same object every time, its `destroy()` is a no-op, and `render()` brackets
  its callback in `save`/`restore` from the identity.
- `format: 'a8'` **throws**: allocate `argb32` and tint through
  `fillStyle`/`globalAlpha`.
- `Picture`, `<image picture>` and `<image drawable>` are X server
  resources: they draw nothing here and warn once in development. An `Image`
  works.

**Context properties** that differ or matter here:

- **`globalCompositeOperation`** is canvas's whole set, including blend
  modes (`multiply` and the rest) that X11 lacks. An op applies inside what
  the draw covers, as on X11 and unlike a browser's `copy`. A bridge without
  the verb refuses all but `source-over`: assign, then read it back. A
  `drawGlyphs` call's `op` is ignored.
- **`'copy'` plus `drawImage(surface, x, y)`** at the surface's own size, a
  whole-pixel translate, no alpha, no shadow and at most a rectangular clip
  is a row memcpy, not a blend — the cheap way to present a surface every
  frame (a 125×45 terminal grid in 0.42 ms rather than 1.37). Anything else
  is drawn, with the same result.
- **`globalAlpha`** below 1 on a surface draw is cheap where
  `ctx.fadesSurfacesCheaply` is true.
- **`imageSmoothingEnabled`/`imageSmoothingQuality`** are honoured; a context
  starts at `'medium'`, not canvas's `'low'`. `'low'` makes a surface drawn
  tile by tile through a matrix far cheaper (784 tiles: 200 ms → 27 ms).
- **`filter`** applies the colour functions (`grayscale()`, `sepia()`,
  `saturate()`, `hue-rotate()`, `invert()`, `brightness()`, `contrast()`),
  `opacity()`, and `blur()` on drawn images only; `drop-shadow()` and `url()`
  do not stick. Read `filter` back to know.
- **`clip(rule)`** honours `'evenodd'`; **`roundRect`** takes canvas's radii,
  `{ x, y }` corners included; **`createPattern`** is not supported.

An element can hand parts of its drawing to the render server as `sprites()`
([extending.md](extending.md#parts-of-your-drawing-on-layers-of-their-own)).
One that composites its own surface over its box every frame — a terminal, a
chart on a socket — pays that composite and a copy behind it; a layer of the
element's own is [designed, not built](../design/architecture/element-layer-contents.md).

### Stroking a path with many subpaths

CoreGraphics strokes in time quadratic in a path's subpaths, so the context
splits a large stroke at subpath boundaries: a path of 4,000 rings strokes
in 113 ms rather than 986. Left whole: a hairline (1 device pixel or less)
and anything that composites — a translucent `strokeStyle`, `globalAlpha`
below 1, a shadow. The one visible difference: where two subpaths' strokes
overlap, the antialiased fringe reads a little lighter.
`ctx.strokeChunking = false` turns it off for one context,
`REACT_X11_NO_STROKE_CHUNKING=1` for the process. `fill` is never split.

### A shadow from a tile

On macOS and Windows the context draws the shadow of a rect, a `roundRect`,
a `fillRect` or an inset frame of two from a **tile** made once and
stretched, shared by every card with the same shadow — a page header's inset
shadow went from 130–380 ms to 4 ms.

- A tiled shadow is the canvas spec's gaussian (σ half the blur, three σ
  wide), as Chrome and X11 draw it. Other shapes, rotations and composite
  ops get CoreGraphics' own, which is a little narrower.
- `<box boxShadow>` draws on macOS and Windows.

`REACT_X11_NO_SHADOW_TILES=1`, or `ctx._shadowTiles = false` on one context,
puts every shadow back on CoreGraphics.

## Animations and transforms

`transition` and `animation` styles work as everywhere. Where a layer can
express the property — a plain `<box>`'s `backgroundColor`, `borderColor`,
`borderWidth`, `borderRadius` and `opacity` — the **render server runs the
animation**: no JS frames, and it keeps moving while the JS thread is blocked
(`examples/animation.jsx` blocks it for two seconds). Everything else — text
colour, layout properties, a node that paints as a raster — runs on the frame
clock exactly as on X11.

- **Timing** matches the frame clock's easings.
- **Interruption**: a length retargets smoothly from where it is; a colour
  restarts from the value on screen.
- **Not offloaded**: `boxShadow`. `transform` is not a style property on any
  backend yet.

On the default presenter the offload is
[layer promotion](#layer-promotion-the-animated-few-on-their-own-layers-above-the-surface-presenter).
`cocoa: { presenter: 'layers' }` gives every drawn node a CALayer instead; it
is opt-in while it is measured, and a pan there re-rasters the whole scene.

## Layer promotion: the animated few on their own layers above the surface presenter

The default presenter keeps one bitmap per window and gives the few nodes
that animate a CALayer of their own above it while they do. Hit testing never
moves: promotion changes pixels and nothing else. With no prop to set, a node
is promoted when it is

- a plain `<box>` with a transition or a loop on `backgroundColor`,
  `borderColor`, `borderWidth`, `borderRadius` or `opacity` — for as long as
  it has one and a second after; or
- a box out of the flow that no pointer lands on (`position: 'absolute'`,
  `pointerEvents: 'none'`) with a loop on an inset, which moves it and
  nothing else — `<ProgressBar indeterminate>`'s block costs no frames;
- and **only where nothing paints over it**: no later sibling's ink in its
  bounds, no ancestor's border or focus ring, no ancestor that fades. A
  clipping ancestor, round corners included, clips the layer. A node in a
  pane that scrolled in the last 250 ms waits until the pane stops.

A node that stops qualifying returns to the bitmap in the frame that finds
it, and its animation carries on on the frame clock from where it was. A
scrollbar thumb over promoted rows goes on a layer of its own.

It costs a frame to start, one to come back a second after the last
animation ends, and meanwhile a CALayer, plus for a node with children a
bitmap the size of their reach. `cocoa: { promote: false }` or
`REACT_X11_COCOA_PROMOTE=0` keeps every animation on the frame clock; `true`
or `=1` forces it on whatever the bridge (it is on by default where the
bridge reports sRGB colours, 0.5.1 and later).

**On a wide-gamut display** (a MacBook's built-in panel, a monitor with its
own profile) every window is colour-managed, as a browser manages a page, so
it looks less saturated than an unmanaged one. Opaque colours agree to the
pixel between bitmap and layer; translucent ones differ slightly, because
Core Animation blends in the display's space. `window.snapshot()` reads the
display's numbers and carries its profile, so a script comparing raw
snapshot pixels with CSS colours sees a shift.

Design notes and measurements:
[design/macos.md](../design/macos.md#layer-promotion-the-animated-few-on-their-own-layers-above-the-surface-presenter).

### Video on a layer

A [`<video>`](elements.md#video) goes on a layer of its own under the same
rule: nothing painted over it, no fade, no rounded clip that cannot hold it.

- **`<video frames>`**: lifted, each pushed frame goes straight to a surface
  the render server shows, at no cost to the window; declined, the element
  draws the newest frame into the window. The colours are `AVPlayerLayer`'s.
  Over a bridge without the video-surface verbs the frame is converted in
  JavaScript, and `app.videoFormats()` lists `BGRA` first.
- **`<video src>`** plays through `AVPlayer`: lifted, its player layer shows
  every frame at no cost to the window; covered, each new frame is copied
  into the window. Over a bridge without the player verbs
  `useSupports('mediaPlayback')` is false and `src` refuses, as on X11. In a
  `<Frame>` pane the host plays the video and sends the frames down.

## Running as an app bundle

AppKit names, icons and identifies an app by the **bundle its executable
lives in**. Run from the shell, the menu bar says "node", the Dock shows the
generic icon, the defaults domain (window frames, the tab bar) is shared with
every script that runtime ever ran, and the notification centre refuses the
app. `cocoa: { appName }` fixes the name alone; a bundle fixes all of it.
`examples/form/` is the example:

```sh
npm run examples:form:app   # builds examples/form/build/Guestbook.app and opens it
```

[`make-app.sh`](../examples/form/make-app.sh) makes the executable with
`bun build --compile` at `Contents/MacOS/Guestbook`: AppKit takes the main
bundle from the running executable's path, so it must be a real binary, not
a script.

- **The bridge's addon cannot be compiled in.** The bundle carries it as
  `Contents/Resources/calayers.node`, and the entry,
  [`main.js`](../examples/form/main.js), points `REACT_X11_CALAYERS_PATH` at
  it relative to `process.execPath` before importing the app, so the bundle
  can be moved.
- **`Info.plist`** carries the name, the identifier, the icon,
  `NSHighResolutionCapable` (without it AppKit renders at 1×) and
  `LSEnvironment` naming the Cocoa backend. `lsappinfo` then reports the
  process under the app's name and identifier.

**The tab bar under bun.** Unbundled, a `bun` app's windows live in the
`bun` defaults domain, and once anything turns the tab bar on there (View →
Show Tab Bar, a stray shortcut) every window the bridge opens wears a 28pt
tab bar and every popup lands that much off. Clear it, or run as a bundle:

```sh
defaults delete bun "NSWindowTabbingShoudShowTabBarKey-NSWindow-CALBackendDelegate-(null)-VT-FS"
```

### Distributing the bundle

`make-app.sh` builds a developer's bundle, which runs where it was built;
[packaging.md](packaging.md#tier-5--a-macos-app) has the recipes. What
differs on macOS:

- **Signing.** A downloaded app needs a Developer ID signature with the
  hardened runtime, then notarization. Sign inside-out, not with `--deep`:
  `calayers.node` first, without entitlements, then the app with Bun's five
  entitlements ([packaging.md](packaging.md#developer-id-or-the-app-store)).
  For a colleague, ad-hoc signing (`--sign -`) and
  `xattr -dr com.apple.quarantine` on their end are the short path.
- **The Mac App Store** requires App Sandbox, under which a
  `bun build --compile` binary does not start. A Node single executable in
  the same bundle shape does, so that is the store build; Bun is fine for
  Developer ID.
- **Architecture.** A compiled binary and the bridge's prebuild are each for
  one CPU; a universal bundle is two builds and `lipo`, for the executable
  and `calayers.node` alike.
- **Size.** About 70 MB with bun, nearly all of it the runtime; 142 MB as a
  Node single executable.

## Testing

`react-x11/test` drives the **X11 backend on every platform, macOS
included**; there is no `'cocoa'` backend for `renderX11()`. Test the tree,
queries and behaviour there, which are shared. Pixels are per-backend
(CoreText is not ntk's rasterizer), so native bezels, the `NSMenu` and
pasteboard flavours are checked by running on a Mac
([testing.md](testing.md)). A window's `snapshot()` resolves to its
composited pixels, in the display's colour profile.

## Not supported yet

- **VoiceOver**: no `NSAccessibility` bridge, and AT-SPI is off here, so a
  Cocoa app is not reachable by assistive technology yet. Write roles and
  labels anyway; the bridge will read them ([accessibility.md](accessibility.md)).
- **Input methods**: no `NSTextInputClient` — no marked text, Press-and-Hold
  accents or CJK input ([events.md](events.md#input-methods)).
- **Nested `<window>` elements** throw; a `<glarea>` is the only child
  surface.
- **`Surface` `format: 'a8'`** throws — allocate `argb32` and tint through
  `fillStyle`/`globalAlpha`.
- **`createPattern`**, and the X-only `Picture`, `<image picture>` and
  `<image drawable>`.
- **The eyedropper over a bridge older than 0.9**: `useEyedropper().supported`
  is false — leave the eyedropper button undrawn.
- **`useKeepAwake()`**: no macOS rung.
- **`transform`** as a style property (on any backend).
- **`transientFor`** and the `sticky`, `below`, `skip_taskbar` and `shaded`
  states: inert.
- **A `'cocoa'` backend for `react-x11/test`.**
- **Dropped images** while the app runs on a worker.
- **Never, by design**: `<foreign>` and XEmbed, a window manager
  (`examples/wm.jsx`), remoting over `ssh -X` — run the X11 backend through
  XQuartz for those.
