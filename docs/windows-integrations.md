# Desktop integration on Windows: what works, and what does not

What an app on the [win32 backend](windows.md) can reach today, what it
cannot, and which of the gaps have a route. Every row was measured on this
backend rather than inferred from the API's existence: "works" means a test
asserts it or it was driven and seen.

## Works

| what                     | the API                                                       | how                                                                                            |
| ------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| a window, composed       | `<window>`                                                    | DirectComposition surface per window, Direct2D verbs                                           |
| text and layout          | `<text>`, `app.fonts`                                         | DirectWrite: layout, line metrics, hit testing, carets                                         |
| glyph runs               | `ctx.drawGlyphs`, `face.glyphIdFor`/`advanceOf`               | `DrawGlyphRun` — what `<Terminal backend="vt">` positions its grid with                        |
| variable font axes       | `style.variations`                                            | `IDWriteTextLayout4::SetFontAxisValues`                                                        |
| app-supplied fonts       | `loadFont`, `openFont`                                        | a DirectWrite font set of the app's own, with the file's axes kept                             |
| OpenGL                   | `<glarea>`                                                    | WGL, and `WGL_NV_DX_interop2` to reach the composed surface                                    |
| keyboard                 | `onKeyDown`, focus                                            | `ToUnicodeEx` without consuming dead keys; X keysym vocabulary                                 |
| pointer                  | `onMouseDown`, wheel, capture                                 | all five buttons, `SetCapture` for drags leaving the window                                    |
| focus                    | `onFocus`/`onBlur`                                            | `WM_ACTIVATE`                                                                                  |
| window states            | `useWindowState`, `<window maximized fullscreen alwaysOnTop>` | `ShowWindow`, `SetWindowPos`, a remembered frame for fullscreen                                |
| screens and DPI          | `useScreens`, `useScale`                                      | per-monitor v2; no live per-window re-scale yet ([windows.md](windows.md#scale-and-dpi))       |
| light/dark and accent    | `useSystemAppearance`                                         | `UISettings` and the theme registry; the frame follows through `DWMWA_USE_IMMERSIVE_DARK_MODE` |
| native control bezels    | `<button>`, `<checkbox>`…                                     | the visual styles engine, on a light desktop; dark ones are drawn (Windows' are not public)    |
| file dialogs             | `useFileDialog`                                               | the Common Item Dialog, parented, modal on the UI thread                                       |
| clipboard                | `useClipboard`                                                | text only, and format enumeration                                                              |
| tray icon and menu       | `useTray`                                                     | `Shell_NotifyIcon`                                                                             |
| taskbar progress         | `useProgress`                                                 | `ITaskbarList3::SetProgressValue`                                                              |
| a badge on the icon      | `useBadge`, `setBadge`                                        | the count drawn into an overlay icon — Windows has no badge API                                |
| demanding attention      | `setUrgent`                                                   | `FlashWindowEx`                                                                                |
| global hotkeys           | `useAccelerator`                                              | `RegisterHotKey`                                                                               |
| notifications            | `notify`, `useNotifier`                                       | a tray balloon, which the shell shows as a toast                                               |
| idle time                | `useIdle`                                                     | `GetLastInputInfo`, polled on the same adaptive wait the X rung uses                           |
| keeping the screen awake | `keepAwake`, `useKeepAwake`                                   | `SetThreadExecutionState`, counted                                                             |
| reading a window back    | `window.snapshot()`                                           | `PrintWindow` with `PW_CLIENTONLY` and `PW_RENDERFULLCONTENT`                                  |
| locale                   | `systemLocale`, `useLocale`                                   | ICU's own resolution, which reads the OS on Windows — no backend code                          |
| drag and drop            | `useDropTarget`, `useDragSource`                              | `IDropTarget` and `DoDragDrop` over OLE, both directions                                       |
| a thumbnail toolbar      | `useThumbnailToolbar`                                         | `ITaskbarList3::ThumbBarAddButtons` — **Windows only**                                         |
| a jump list              | `useJumpList`                                                 | `ICustomDestinationList` — **Windows only**                                                    |
| recent documents         | `useRecentDocument`                                           | `SHAddToRecentDocs` — **Windows only**                                                         |
| input methods            | `onCompositionStart`/`Update`/`End`, `<textinput>`            | IMM32: the preedit is drawn in the field, the candidate list follows the caret                 |
| screen readers           | `role`, `aria-*`, `announce()`                                | a UI Automation provider over a pushed mirror of the tree                                      |
| window identity          | `<window appId>`                                              | the AppUserModelID on the window's property store — taskbar grouping, pinning, the jump list   |

## Built, with limits worth knowing

### Input methods — built on IMM32, with the gaps that layer has

CJK input works, through the same composition events a Wayland text-input
drives, so an application handles one composition and gets both. The preedit
is drawn **in the field** rather than in a floating box, and the candidate
list follows the caret.

What it does not carry is what IMM32 itself no longer carries. Modern input
methods — the new Microsoft Japanese and Chinese IMEs included — are TSF text
services reaching an IMM32 window through a compatibility layer, which does
not pass on **voice typing** (Win+H inserts nothing), the shell's
**handwriting** panel, or **shape-writing** on the touch keyboard. A TSF text
store would close those; it is not built. Reconversion (asking the IME to
re-open a committed word) is not wired up either, though IMM32 carries it.

### Screen readers — built, without text ranges

Screen readers are served by a UI Automation provider of this project's own,
answering from a copy of the tree the app pushes, so a screen reader is never
paced by the app's busiest moment. Roles, names, descriptions, states,
bounding rectangles, focus and the Invoke, Toggle, Value and RangeValue
patterns all cross; `announce()` goes out as a UIA notification. Everything an
app writes — `role`, `aria-label`, `aria-checked`, `aria-valuenow` — is read
by the same code the AT-SPI bridge reads, so the two backends cannot disagree
about what a node is.

**What is missing is `ITextProvider`.** A `<textinput>` exposes its value, so
a screen reader reads the field and hears edits, but caret-by-caret and
word-by-word navigation _inside_ it is not there.

## Not implemented

Ordered by what it costs an app today.

### `useLauncherMenu` is inert

The jump list is built (`useJumpList` above) but it is **not** what
`useLauncherMenu` means, and is deliberately not wired to it. A launcher-menu
item carries a callback; a jump-list task starts a _new process_ with
arguments, because the shell launches the program rather than calling into
the running one. Mapping one onto the other would quietly change what a click
does.

### Activation — file associations, URL schemes, second launches

`useAppOpen` and `useAppActivate` never fire on Windows: there are no file
associations, no URL schemes and no single-instance handoff yet, so a second
launch is a second process. [uri-schemes.md](uri-schemes.md) documents what
the other platforms do.

### Eyedropper — the pixel is read, the ladder has no rung

The bridge reads a screen pixel (`app.screenColorAt`, `app.pointerPosition`),
but `useEyedropper()` reports `supported: false` here until a rung draws the
loupe over it.

### Calendar — blocked, not missing

`useDesktopCalendarEvents` wants the Windows appointments API, which requires
package identity. Unpackaged, there is nothing to call, and the hook reports
`supported: false` rather than guessing.

### Permissions — nothing to ask

`usePermission` has no Windows meaning for an unpackaged app: the capability
API is for packaged apps, and everything else sits under one per-device
switch. The answer is `'unknown'` until something is attempted, and the
attempt's own error is the answer.

### Global menu — not a Windows concept

`useGlobalMenu` is a menu bar owned by the desktop. Windows has none; a
`<MenuBar>` drawn in the window is the whole story here, and that works.

### Keyboard grabs

`grabKeyboard` accepts and does nothing: there is no Windows mechanism for it.
A popup that asked for keys gets them only while it is the foreground window.

`grabPointer` is a different story — see below.

## Built, with limits worth knowing: `<popup grab>`

Windows has no pointer grab to give — `SetCapture` sends a window the mouse
only while a button is already down — so the dismissal is reproduced from two
signals, and `<Select>`, `<Menu>` and any `<popup grab>` close the way they do
everywhere else:

- a press delivered to **another window of this application** — a click in
  the owner behind the menu, in a second window, or in the menu a submenu came
  from;
- the application **losing activation** — a press in another application or
  on the desktop. A popup never takes activation itself, so opening one raises
  no blur.

**The gap**: a press on the _non-client_ area of one of our own windows — a
title bar, a resize border — is not reported, so a menu left open while the
user drags the window behind it stays open. X11's grab covers that and this
does not.

## What Windows has that nothing else does

Some Windows surfaces have no cross-platform API to fit into, so they have
APIs of their own, and **a backend installs a method, and its presence is the
capability**. They are reported as features of the launcher, beside the badge
and the progress bar:

```jsx
const launcher = useDesktopCapability('launcher');
launcher.backend; // 'taskbar' here, 'cocoa' on a Dock
launcher.features.thumbnailToolbar; // the buttons under the hover preview
launcher.features.tasks; // the jump list's Tasks category
launcher.features.recentDocuments; // the shell's Recent lists
```

They live there rather than in `useSupports()` because `useSupports` answers
for the **display** — transparency, shaders, embedding — and a taskbar button
is not a display property; and because a boolean cannot say _which_ launcher
answered. Every other backend answers false for the three, and the hooks do
nothing where the method is absent. `examples/taskbar.jsx` is the shape;
there is no `process.platform` in it.

- **Thumbnail toolbars** — `useThumbnailToolbar`: up to seven buttons under
  the taskbar thumbnail, play/pause/next for a media app.
- **Recent documents** — `useRecentDocument`.
- **A jump list** — `useJumpList` (see [`useLauncherMenu`](#uselaunchermenu-is-inert)).
- **Taskbar overlay as a status light**: `setBadge` takes a label, and an app
  that wants a dot rather than a number can pass one character.

Ideas not built yet are in the
[design notes](../design/windows-integrations.md#what-windows-has-that-nothing-else-does).
