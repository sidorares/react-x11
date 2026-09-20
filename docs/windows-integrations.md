# Desktop integration on Windows: what works, and what does not

[windows.md](windows.md) is the design: what the backend is for and how it is
built. This is the status — what an app running on `@windowkit/win32` can
actually reach today, what it cannot, and which of the gaps have a route.

Everything below was measured on this backend rather than inferred from the
API's existence. "Works" means a test asserts it or it was driven and seen.

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
| screens and DPI          | `useScreens`, `useScale`                                      | per-monitor v2; `WM_DPICHANGED`                                                                |
| light/dark and accent    | `useSystemAppearance`                                         | `UISettings` and the theme registry; the frame follows through `DWMWA_USE_IMMERSIVE_DARK_MODE` |
| native control bezels    | `<button>`, `<checkbox>`…                                     | the visual styles engine, where its dark variants are real — measured, not assumed             |
| file dialogs             | `useFileDialog`                                               | the Common Item Dialog, parented, modal on the UI thread                                       |
| clipboard                | `useClipboard`                                                | text and format enumeration                                                                    |
| tray icon and menu       | `useTray`                                                     | `Shell_NotifyIcon`                                                                             |
| taskbar progress         | `useProgress`                                                 | `ITaskbarList3::SetProgressValue`                                                              |
| a badge on the icon      | `useBadge`, `setBadge`                                        | the count drawn into an overlay icon — Windows has no badge API                                |
| demanding attention      | `setUrgent`                                                   | `FlashWindowEx`                                                                                |
| global hotkeys           | `useAccelerator`                                              | `RegisterHotKey`                                                                               |
| notifications            | `notify`, `useNotifier`                                       | a tray balloon, which the shell shows as a toast                                               |
| idle time                | `useIdle`                                                     | `GetLastInputInfo`, polled on the same adaptive wait the X rung uses                           |
| keeping the screen awake | `keepAwake`, `useKeepAwake`                                   | `SetThreadExecutionState`, counted                                                             |
| sampling a screen colour | `useEyedropper`                                               | the screen read through GDI, with a drawn loupe                                                |
| reading a window back    | `window.snapshot()`                                           | `PrintWindow` with `PW_CLIENTONLY                                                              | PW_RENDERFULLCONTENT` |
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

CJK input works: `WM_IME_*` reaches `src/win32/ime.js`, which drives the same
composition events a Wayland text-input drives, so an application handles one
composition and gets both. The preedit is drawn **in the field** rather than
in a floating box, and the candidate list follows the caret.

What it does not carry is what IMM32 itself no longer carries. Windows has
stopped loading IMM32 input methods, so every modern one — the new Microsoft
Japanese and Chinese IMEs included — is a TSF text service reaching an IMM32
window through a compatibility layer, and that layer does not pass on **voice
typing** (Win+H inserts nothing), the shell's **handwriting** panel, or
**shape-writing** on the touch keyboard. A TSF text store is what closes
those; windows.md §"IME" has the design and why it is the harder rung.

Reconversion (asking the IME to re-open a committed word) is not wired up
either, though IMM32 carries it.

### Screen readers — built, without text ranges

`WM_GETOBJECT` is answered by a UI Automation provider of this project's own
(`windows/src/uia.cc`), served from a mirror `src/win32/a11y.js` pushes. Roles,
names, descriptions, states, bounding rectangles, focus and the Invoke, Toggle,
Value and RangeValue patterns all cross; `announce()` goes out as a UIA
notification. Everything an app writes — `role`, `aria-label`, `aria-checked`,
`aria-valuenow` — is read from `src/a11y.js`, the same pure functions the
AT-SPI bridge reads, so the two backends cannot disagree about what a node is.

The mirror is the deliberate part. UIA's calls are synchronous and frequent —
one focus change is dozens of property reads — so answering them from the live
tree would pace the screen reader by the app's busiest moment. windows.md
§"Accessibility: UI Automation" has the argument; it named AccessKit as the
reuse candidate for the same shape, and a provider of our own was built
instead so the release pipeline does not grow a Rust toolchain for both
architectures.

**What is missing is `ITextProvider`.** A `<textinput>` exposes its value, so a
screen reader reads the field and hears edits, but caret-by-caret and
word-by-word navigation _inside_ it is not there. That is the next piece.

## Not implemented

Ordered by what it costs an app today.

### `useLauncherMenu` is inert

The jump list is built (`useJumpList` above) but it is **not** what
`useLauncherMenu` means, and is deliberately not wired to it. A launcher-menu
item carries a callback; a jump-list task starts a _new process_ with arguments,
because the shell launches the program rather than calling into the running
one. Mapping one onto the other would quietly change what a click does.

They become the same feature once a second launch can hand its arguments to
the first, which is the activation work below.

### Activation — file associations, URL schemes, second launches

`useAppOpen` and `useAppActivate` fire on macOS and through the freedesktop
transport on Linux. On Windows an app has to register its associations under
`HKCU\Software\Classes`, declare an AppUserModelID, and make the second launch
hand its arguments to the first and exit — a named mutex and a `WM_COPYDATA`,
or `ISingleInstanceApp`. [uri-schemes.md](uri-schemes.md) documents what the
other platforms do.

### Calendar — blocked, not missing

`useDesktopCalendarEvents` wants the Windows appointments API, which requires
package identity. Unpackaged, there is nothing to call, and the hook reports
`supported: false` rather than guessing.

### Permissions — nothing to ask

`usePermission` has no Windows meaning for an unpackaged app: the capability
API is for packaged apps, and everything else sits under one per-device switch.
The honest answer is `'unknown'` until something is attempted and the attempt's
own error is the answer.

### Global menu — not a Windows concept

`useGlobalMenu` is a menu bar owned by the desktop. Windows has none; a
`<MenuBar>` drawn in the window is the whole story here, and that works.

### Keyboard grabs

`grabKeyboard` accepts and does nothing: there is no Windows mechanism for it,
and nothing in the tree reads its result. A popup that asked for keys gets them
only while it is the foreground window.

`grabPointer` is a different story — see below.

## Built, with limits worth knowing: `<popup grab>`

A menu closing when you click beside it is what the pointer grab is _for_, and
Windows has no grab to give: `SetCapture` sends a window the mouse only while a
button is already down, so a press that starts elsewhere never arrives. The
effect is reproduced from two signals instead, and `<Select>`, `<Menu>` and any
`<popup grab>` dismiss the way they do everywhere else:

- a press delivered to **another window of this application** — a click in the
  owner behind the menu, in a second window, or in the menu a submenu came
  from;
- the application **losing activation** — a press in another application or on
  the desktop. A popup is `WS_EX_NOACTIVATE`, so it never takes activation
  itself and opening one raises no blur.

Both end in the same made-up outside press the Wayland backend sends for
`xdg_popup.popup_done`, so all three backends answer a dismissal through one
path (`_dismissOutside` in src/events.js).

**The gap**: a press on the _non-client_ area of one of our own windows — a
title bar, a resize border. The bridge does not report those, so a menu left
open while the user drags the window behind it stays open. X11's grab covers
that and this does not.

## What Windows has that nothing else does

Things with no cross-platform API to fit into. Three of them now have one of
their own, and the rule that makes that safe is worth stating once: **a backend
installs a method, and its presence is the capability**. They are reported as
features of the launcher, beside the badge and the progress bar:

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
answered, which is the whole reason capabilities carry a `backend` and a
feature map. Every other backend answers false for the three without knowing
Windows exists, and the hooks do nothing where the method is absent.
`examples/taskbar.jsx` is the shape; there is no `process.platform` in it.

- ~~**Thumbnail toolbars.**~~ Built: `useThumbnailToolbar`. Up to seven buttons
  under the taskbar thumbnail — play/pause/next for a media app. The Dock has
  nothing like it; the closest sibling is the macOS Touch Bar, which is gone.
- **A custom taskbar thumbnail and peek.** `DWM_THUMBNAIL_PROPERTIES` and
  `WM_DWMSENDICONICTHUMBNAIL` let an app answer the hover preview with
  something other than a shrunken window — a document's first page, a chart.
- **Tabbed thumbnails.** One taskbar entry per document with
  `ITaskbarList4::SetTabProperties`, which is how browsers put tabs on the
  taskbar.
- ~~**Recent documents.**~~ Built: `useRecentDocument`.
- **Explorer verbs.** "Open with", a context-menu handler, a preview handler,
  a thumbnail provider. All of these are COM servers registered per file type,
  and on Windows 11 a context-menu handler must be a packaged app extension —
  which puts them behind packaging along with the calendar.
- **Protocol activation.** `myapp://` as a first-class launch, which is the
  activation work above seen from the other side.
- **Taskbar overlay as a status light.** Already reachable: `setBadge` takes a
  label, and an app that wants a dot rather than a number can pass one
  character.

## What would fit this library and exists nowhere yet

Not Windows-specific — gaps in the cross-platform surface that Windows happens
to be able to answer.

- **A print dialog and a print surface.** No backend has one. Windows has
  `PrintDlgEx` and the XPS document API; macOS has `NSPrintOperation`;
  freedesktop has the portal. A `<Print>` surface that takes the same verb
  table the screen does is a natural fit for a renderer that already draws
  through one.
- **A colour chooser.** `useEyedropper` samples a pixel; nothing offers the
  system's colour picker. `IColorPickerDialog` (WinUI), `NSColorPanel` and the
  portal all exist.
- **A font chooser.** `IDWriteFontSet` plus the Common Item Dialog's
  chooser, `NSFontPanel`, the portal's.
- **Session lifecycle.** `WM_QUERYENDSESSION` and `WM_ENDSESSION` on Windows,
  `NSApplicationDelegate` on macOS, the session manager on Linux — an app that
  wants to save before logout has no hook on any backend.
- **Power and battery.** `GetSystemPowerStatus`, `IOPowerSources`, UPower.
  A `useBattery` would be one hook over three.
