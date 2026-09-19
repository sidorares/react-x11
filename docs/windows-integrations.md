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

## Not implemented

Ordered by what it costs an app today.

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

### Screen readers — nothing answers UIA

`announce()` and the a11y tree reach AT-SPI on Linux and nothing here.
`WM_GETOBJECT` is unhandled, so Narrator and NVDA see a bare window.
windows.md §"Accessibility: UI Automation" argues for AccessKit's Windows
adapter over a provider of our own, and the argument still holds: UIA's calls
are synchronous and frequent, and answering them from the live tree paces the
screen reader by the app's busiest moment.

This is the largest piece of work on the list and the one with the clearest
existing answer.

### `useDockMenu` is inert

The jump list is built (`useJumpList` above) but it is **not** what
`useDockMenu` means, and is deliberately not wired to it. A Dock-menu item
carries a callback; a jump-list task starts a _new process_ with arguments,
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

### Pointer and keyboard grabs

`grabPointer`/`grabKeyboard` accept and do nothing. `SetCapture` holds only
while a button is down, so a `<popup grab>` cannot be dismissed by a click
outside it the way it is on X11 — the replacement is watching activation, which
is not built.

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
