# A native Windows backend

The `win32` backend draws a react-x11 app into real Win32 windows: one
DirectComposition surface per window, Direct2D for drawing, DirectWrite for
text. It is **the default on Windows**, and it needs the `@windowkit/win32`
native bridge; without the bridge, `'auto'` falls back to X11. The examples
run on it, except `wm` and `xeyes`, which are X11 window-manager demos.

[windows-integrations.md](windows-integrations.md) is the row-by-row status of
what an app can reach on Windows. Why the backend is built the way it is — the
threading model, the rendering internals, the plan and its open questions — is
the design record: [design/windows.md](../design/windows.md).

## Choosing a backend

`createRoot({ backend })`, or `REACT_X11_BACKEND` without touching code:

| asked                  | on Windows                                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'auto'` (the default) | `'win32'` when `@windowkit/win32` loads. Otherwise X11 through `DISPLAY`, with one console warning outside production, so a WSLg or Cygwin setup keeps working                                       |
| `'win32'`              | the bridge is required: if it cannot load, `createRoot()` rejects with an error that lists what it tried and how to install it                                                                       |
| `'x11'`                | an X server through `DISPLAY`. Also what `'auto'` picks when you pass `display` or `stream`. Windows has no `fc-match`, so tell ntk where the fonts are with `fontSource` or `REACT_X11_FONT_SOURCE` |

```jsx
const root = await createRoot(); // win32 on Windows, x11 if the bridge is missing
const root = await createRoot({ backend: 'win32' }); // the bridge or an error
```

Asking for `'win32'` on any other platform throws: the backend is
Windows-only.

## Installing the bridge

- `@windowkit/win32` is an `optionalDependency` of react-x11 with
  `os: ["win32"]`, so `npm install react-x11` on Windows installs it and
  every other platform skips it. If optional dependencies were omitted,
  install it yourself: `npm install @windowkit/win32`.
- Prebuilds ship for **x64 and ARM64**. Building from source needs Visual
  Studio with the "Desktop development with C++" workload.
- It is an N-API addon, so it loads under Bun (`bun.exe`) as well as Node.
- `REACT_X11_WIN32_PATH=<path>` loads the bridge from a path instead of the
  installed package: a checkout, or the file shipped beside a compiled
  executable (see [Packaging and identity](#packaging-and-identity)).
- An older bridge degrades feature by feature rather than failing: a missing
  verb answers "unsupported" (for example, `useWindowState()` sees `false`,
  and a `<glarea>`'s children are not drawn).
- Built and measured on Windows 11. Windows 10 is not a verified target.

## Threads and the event loop

The bridge runs every window on a UI thread of its own, and your JS stays on
Node's main thread. Windows' modal loops — a live resize, a native menu, a
drag (`DoDragDrop` does not return until the drop), a file dialog — run on
that UI thread, so **JS is never frozen by one**: timers fire, sockets read,
React commits and frames present while the user drags or a dialog is open.
This is the main behavioural difference from the Cocoa backend's pump mode.

Events reach JS as soon as they happen, without waiting for a timer tick, and
a handler's `setState` commits on the event that caused it.

## Rendering

- **Every window is composited by DWM**, so `transparent` always works and
  `useSupports('transparency')` is always true — there is no "if a compositor
  is running".
- **ClearType on opaque windows, grayscale on transparent ones.** Direct2D
  draws subpixel text only onto a surface whose alpha is ignored, so text in
  a `<window transparent>` or `<popup transparent>` is grayscale-antialiased.
- **Frames are paced by DWM's compositor clock**, at the refresh rate of the
  monitor under the window; `frameRate` works as on the other backends. An
  idle app polls nothing.
- Only damaged rectangles are repainted, and scrolling is a blit, as on X11
  and Cocoa.
- **Reading pixels back**: `window.snapshot()` works once the window has
  been composed. It rejects for a minimised or not-yet-composed window; draw
  into an offscreen surface and read that instead.
- `<video frames>` draws; `<video src>` does not —
  `useSupports('mediaPlayback')` is false here.
- Debugging: `REACT_X11_WIN32_DEBUG=1` reports every frame and what it drew
  into, the size each paragraph is shaped at, and drag and drop;
  `REACT_X11_WIN32_FULL_REPAINT=1` paints the whole window every frame, the
  control for a damage bug.

## Scale and DPI

- Windows are **per-monitor-v2 DPI aware** whatever `node.exe`'s manifest
  says, so nothing is bitmap-stretched and layout runs in device pixels.
- **Fractional scale is the normal case** (125%, 150%, 175%). Layout rounds
  to whole device pixels, so a one-logical-pixel hairline at 1.25× lands on
  one device pixel or two depending on where it falls
  ([scale.md](scale.md)).
- `useScale()` is the **primary monitor's** scale when the app starts, static
  for the life of the root as on every backend, and every window is laid out
  at it.
- `useScreens()` lists every monitor; its `available` is the monitor's exact
  work area.
- **Not yet: live per-window scale.** A window on, or dragged to, a monitor
  at another scale is not re-laid out at that scale: it stays sharp but is
  the wrong physical size there.

## Text: DirectWrite behind the engine contract

Text is DirectWrite end to end — font matching, fallback, shaping, bidi, line
breaking, hit testing — so it looks like the platform's text, the way the
Cocoa backend uses CoreText.

- **Generic families**: `sans-serif`, `system-ui` and `ui-sans-serif` →
  Segoe UI; `serif` → Times New Roman; `monospace` and `ui-monospace` →
  Consolas; `cursive` → Segoe Script.
- **Font stacks** resolve to the first family installed. A face filed under
  another family ("Arial Black", "Segoe UI Light") is found as GDI finds it,
  and Courier/Courier New, Times/Times New Roman and Arial/Helvetica stand in
  for each other.
- In laid-out text, characters the font lacks fall back to a system font,
  as DirectWrite layouts do. `app.fonts.fallbackFor()` answers `null` (not
  bound yet), so code drawing its own glyph runs gets no fallback face.
- `loadFont` and `openFont` load the app's own fonts, variable axes kept;
  `style.variations` sets axes.
- Measurements are rounded up to whole device pixels, and lines break at the
  same opportunities as on Cocoa, but metrics are DirectWrite's: expect a
  pixel or so of difference from the X11 backend's layouts.

## Input

### Pointer

- All five mouse buttons and the wheel. A drag that leaves the window keeps
  receiving motion while a button is held.
- A precision touchpad sends fractions of a notch; those arrive as wheel
  events with `smooth: true`.
- Motion and wheel are coalesced to one per frame, as on X11.
- Not yet: pen- and touch-specific events, touchpad inertia, pinch.

### Keyboard

- Key events carry the same X keysym vocabulary, `codepoint` and `key` as on
  every backend; the editing, navigation, function and keypad keys have their
  X keysyms.
- Dead keys compose in the layout, as the layout defines them; the backend
  never consumes the dead-key state behind your back.
- Tab and Return never insert a control character into a field.

### IME

Input methods work, through IMM32 — Chinese, Japanese and Korean composition
reach the same `onCompositionStart`/`Update`/`End` events a Wayland
text-input drives, so one handler serves both.

- The **preedit is drawn in the field**, laid out and styled with the rest of
  the text; Windows' floating composition window is suppressed. The
  **candidate list** is the input method's own and follows the caret.
- A commit arrives before the next preedit, and the active clause is the
  preedit cursor (`cursorBegin`/`cursorEnd`), as on Wayland.
- A `sensitive` field is not offered to the input method at all, so its text
  never reaches a word history — as Windows does for its own password boxes.
- **What IMM32 does not carry**: modern input methods are TSF text services
  reaching IMM32 windows through a compatibility layer, and that layer drops
  **voice typing** (Win+H inserts nothing), the shell's **handwriting**
  panel and **shape-writing** on the touch keyboard. A TSF text store, which
  would close those, is not built. Reconversion is not wired up either.
- `REACT_X11_TRACE_IME=1` prints a line per input-method event.

## Windowing semantics: what maps, what bends, what breaks

**Maps**:

- `title`, `width`, `height`, `x`, `y` and the natural size. `x`/`y` are
  virtual-screen coordinates, negative left of and above the primary monitor.
- `minWidth`/`minHeight`/`maxWidth`/`maxHeight` and `resizable` become the
  window's size limits.
- `fullscreen`, `alwaysOnTop`, maximise and minimise use Windows' own calls;
  full screen is a borderless monitor-sized window that remembers the frame
  it came from.
- `transparent` — always available ([Rendering](#rendering)).
- `appId` — the window's AppUserModelID
  ([Packaging and identity](#packaging-and-identity)).
- `<popup>` — no taskbar button, never takes activation, placed against the
  monitor's work area as everywhere.
- Drag and drop, both directions: `dropAccept`, `onDrag*` and `dragData`
  hold, and JS keeps running through the drag. Windows itself refuses a drop
  from Explorer into an elevated app.

**Bends**:

- `<popup grab>`: there is no pointer grab on Windows, so a press in another
  of the app's windows, or the app losing activation, closes the popup
  instead. The gap: a press on one of the app's own title bars or resize
  borders does not, so a menu stays open while its window is dragged.
- `states`: `shaded` and `sticky` have no Windows call and resolve false,
  which `useWindowState()` reports. `focused` can be refused by Windows'
  foreground rules, and then simply does not change.
- `embeddable` and `<foreign>`: see
  [Embedding](#embedding-frame-foreign-window-embeddable).
- The global menu: Windows has none; draw a `<MenuBar>`.

**Inert** — accepted and ignored, so shared code stays branch-free:

- `decorations={false}`, today. A titlebar drawn in the window and moved
  from `onMouseMove` loses snapping and the Snap Layouts flyout.
- `transientFor`, `windowType`.
- `grabKeyboard`: a popup gets keys only while it is the foreground window.
- `onClientMessage` never fires; there is no X.

**Breaks**, by design: window managers (`examples/wm.jsx`) — DWM owns every
frame — and `ssh -X` remoting, for which the X11 backend stays the answer
([remote.md](remote.md)).

## The desktop around the app

No D-Bus or portals here: each service has a Windows rung or an honest
floor. [windows-integrations.md](windows-integrations.md) has the measured
status of each; in short:

- **Work**: `useFileDialog()` (Windows' own dialog, owned by the window that
  asked), `useSystemAppearance()` (light/dark, accent, high contrast, reduced
  motion; the window frame follows dark mode), `useTray()`, `useProgress()`,
  `useBadge()`/`setBadge()` (drawn into the taskbar's overlay icon — pass one
  character for a dot), `setUrgent()`, `useIdle()`, `keepAwake()`,
  `useLocale()`.
- **Global shortcuts** (`useAccelerator()`): system-wide, no admin. A chord
  another app holds fails; Windows-key chords are reserved.
- **Notifications** (`notify()`, `useNotifier()`) are tray balloons, which
  the shell shows as toasts and keeps in the Action Center: plain text with a
  severity — no actions, click events, updates or custom icon, as the
  capabilities say.
- **Clipboard** (`useClipboard()`): text only — writing anything else
  rejects. No `PRIMARY`. `watch()` notices a change within about 400 ms.
- **Windows only**: `useJumpList()`, `useThumbnailToolbar()`,
  `useRecentDocument()`, reported as features of
  `useDesktopCapability('launcher')`.
- **Answer "no"**: `useLauncherMenu()` is inert (a jump-list task starts a new
  process — use `useJumpList()`); `useAppOpen()` and `useAppActivate()` never
  fire (no file associations, URL schemes or single instance yet);
  `useEyedropper()` reports `supported: false`; `usePermission()` answers
  `'unknown'`; `useDesktopCalendarEvents()` is `supported: false` unless the
  app is packaged.
- **Native control bezels** are the system's own while the desktop is light,
  and drawn in dark mode, because Windows' dark common controls are not
  public.

## Accessibility: UI Automation

Screen readers read the app through UI Automation. What an app writes —
`role`, `aria-*`, `announce()` — is read by the same code the Linux AT-SPI
bridge reads, so the two cannot disagree about what a node is.

- **Crosses**: roles, names, descriptions, states, bounding rectangles,
  focus and hit testing; the Invoke, Toggle, Value and RangeValue patterns;
  `announce()` as a UIA notification.
- The bridge answers from a copy of the tree the app pushes after commits, so
  a screen reader never waits on a busy JS thread. Pushes are paced as
  [accessibility.md](accessibility.md#how-often-the-bridge-speaks) describes.
- **Missing: text ranges.** A `<textinput>` exposes its value, so a screen
  reader reads the field and hears edits, but cannot move caret by caret or
  word by word inside it.
- `REACT_X11_TRACE_A11Y=1` prints a line per push and action.

## 3D: `<glarea>`

`<glarea>` draws through OpenGL on the **GPU vendor's driver**, and its frames
are composited with the rest of the window, the window's alpha included.

- The context is an OpenGL ES-profile one: GLSL ES shaders, and the
  WebGL 2-shaped `gl` (`gl.bindBuffer`, …) of the X11 direct backend.
  `@react-x11/components/three` runs on it. No `glPolicy` is needed: this
  backend is always direct.
- It needs the driver's `WGL_NV_DX_interop2`, which NVIDIA and AMD drivers
  have and some Intel configurations lack.
- **Without a vendor driver** — a virtual machine without GPU passthrough, a
  CI runner, a fresh install before Windows Update fetched the driver, some
  Remote Desktop sessions — Windows offers only the OpenGL 1.1 software
  rasterizer, which has no shaders. `<glarea>` then reports one `onError`
  naming the reason, and `useSupports('shaders')` is false. The ANGLE
  fallback that would cover these machines is not built.
- `useSupports('shaders')` is false for one tick and then true: the GL probe
  (about 120 ms) runs the first time something asks, not at startup.
- A `<glarea>`'s children are drawn on composited panes above the surface,
  translucency included (`useSupports('glOverlay')` is true). The surface
  takes no pointer input; the pointer reaches the tree.

Background: [design/windows-gl.md](../design/windows-gl.md).

## Embedding: `<Frame>`, `<foreign>`, `<window embeddable>`

The API is the same as everywhere; what answers it differs.

- **`<Frame src>` works.** The pane runs in its own process and draws into a
  composition surface the host shows; `props`, `fallback` and `restart()`
  behave as on every backend ([frame.md](frame.md)). The host is the pane's
  parent process; a pane started some other way names it with
  `createRoot({ win32: { paneHostPid } })`.
- **`<foreign>` refuses.** Windows' cross-process child windows attach the two
  programs' input queues, so a hung guest would hang the host.
  `useSupports('embedding')` is false, and a `<foreign>` reports one
  `onError`:

  ```
  react-x11: <foreign> needs a backend with cross-process window embedding,
  and this one has none — so nothing can be put in it. Ask
  useSupports('embedding') before rendering one.
  ```

  ```jsx
  const embedding = useSupports('embedding');
  return embedding ? <foreign onReady={spawnInto} /> : <text>X11 only</text>;
  ```

- **`<window embeddable>`** is created and not shown, as everywhere.
  `windowHandleOf(ref)` / `useWindowHandle(ref)` returns a **composition
  surface handle** already valid in the host process — not an HWND, because a
  composition target stops presenting once its window is made a child. Pass
  it to the host out of band, as an XID is passed on X11. The host must bind
  a composition surface to a visual of its own (another react-x11 app, WinUI
  3, a DirectComposition-based host); a plain Win32 or OLE document host
  cannot. The host is the parent process unless
  `createRoot({ win32: { paneHostPid } })` names another.
- OLE embedding (a pane inside a Word document) is not supported.

Background: [design/windows-embedding.md](../design/windows-embedding.md).

## Packaging and identity

- **`node app.js` works**, with two cosmetic problems. `node.exe` is a
  console program, so launched from a shortcut it opens a console window.
  And without an `appId`, the taskbar groups the app's windows with every
  other `node.exe` window under Node's icon, and pinning pins `node.exe`.
- **`<window appId>`** (or the class half of `wmClass`) sets the window's
  AppUserModelID, per window, before it is shown. The taskbar groups by it,
  pinning pins it, and the jump list belongs to it. A pinned tile relaunches
  the command line that started the process, named after the window's title,
  with the executable's icon.
- **A single executable** ([packaging.md](packaging.md) tier 3,
  `node --build-sea`) is a copy of `node.exe` with the app inside. After the
  build: a manifest of the app's own with `rcedit`, the GUI subsystem with
  `editbin /SUBSYSTEM:WINDOWS` so no console opens, then the signature.
  Windows 11 24H2 also has a manifest setting that detaches the console when
  launched from Explorer and keeps it in a terminal. Ship the bridge beside
  the executable and name it with `REACT_X11_WIN32_PATH`.
- **`bun build --compile`** has `--windows-hide-console` and icon and
  metadata flags, but no way to supply a manifest; `bun.exe`'s own manifest
  has no compatibility section, and what that changes for DPI and DWM is not
  yet verified.
- **Distribution**: Authenticode signing, which SmartScreen's reputation
  follows. MSIX package identity is what unlocks the calendar, the
  capability-status API and declared protocol activation.
- [packaging.md](packaging.md) has no Windows tier yet.

## Testing

- `react-x11/test` runs a tree against an in-process X server or the mock,
  on Windows as anywhere ([testing.md](testing.md)) — it exercises the X11
  backend, not this one.
- `window.snapshot()` reads a composed window back on a real Windows desktop
  (above).
- Test at **fractional scales** — 1.25 and 1.5, not only 1 and 2. Logical and
  device pixels part company there, and a test at scale 1 cannot tell which
  of the two a coordinate is in.
- GitHub-hosted Windows runners have an interactive desktop (1024×768) and no
  GPU driver, so `<glarea>` reports its error there; the rest of the backend
  on Direct3D's software device (WARP) is not yet verified on them.

## Not supported yet

- Live per-window scale: a window on a monitor at another scale is not
  re-laid out ([Scale and DPI](#scale-and-dpi)).
- UI Automation text ranges: no caret or word navigation inside a field.
- TSF: voice typing, handwriting and shape-writing; IME reconversion.
- `decorations={false}`, `transientFor`, and a drag-region API for drawn
  titlebars (snapping, Snap Layouts).
- Clipboard formats other than text: images, HTML, file lists.
- File associations, URL schemes, single instance (`useAppOpen`,
  `useAppActivate`); `useLauncherMenu`.
- Toasts with actions or click events (notifications are balloons).
- `useEyedropper()`; the calendar without package identity.
- `<glarea>` without a vendor OpenGL driver (ANGLE).
- `<video src>`.
- Compositor-side animation: transitions run on the frame clock, so a long
  JS block stalls them, unlike on Cocoa.
- Pen- and touch-specific input, touchpad inertia and pinch.
- `<foreign>`, OLE embedding, window managers and `ssh -X` — by design.
