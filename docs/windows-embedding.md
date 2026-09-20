# Embedding on Windows: `<Frame>`, `<foreign>`, and being embedded

Three questions, one public API each, and they are **already written**. What
this page works out is which Windows mechanism sits under each, and what that
costs — not what to call any of it.

The rule the whole page is written against: **the API does not change.** An
app writes `<Frame src>`, `<foreign windowId>` and `<window embeddable>` and
asks `useSupports('embedding')`; which primitive answers is the backend's
business and nobody else's.

## Where this actually stands today

Measured, not assumed. A `<Frame>` rendered on Windows starts its pane, fails
at the embed, shuts the pane down and renders its `fallback` with this:

```
react-x11: <foreign> needs the X11 backend — this one has no cross-process
window embedding, so nothing can be put in it. Ask useSupports('embedding')
before rendering one.
```

So **the process half of `<Frame>` already works here, the display half says
plainly that it does not, and the failure is the documented one.** The pane
forks, loads its module, and is torn down cleanly; `canEmbed()`
(src/embedding.js) asks for `X.ReparentWindow` and `X.ChangeSaveSet`, the
win32 app has neither, `useSupports('embedding')` is false, and `<foreign>`
refuses with the message above, which `<Frame>` turns into its fallback.

That is a much better starting point than a silent gap, and it changes what is
worth doing first: there is nothing to make honest, only something to build.

The one wart: the pane process is **forked before the embed is attempted**, so
a backend that cannot show a pane still pays for starting and killing one.
Asking the same question before the fork is a small, separate fix.

## The two directions are different problems

|                       | who owns the pixels                        | what the other side must be       |
| --------------------- | ------------------------------------------ | --------------------------------- |
| `<Frame src>`         | a pane of **our own** app, another process | nothing — we start it             |
| `<foreign windowId>`  | **another application's** window           | a cooperating or ordinary app     |
| `<window embeddable>` | **us**, inside somebody else's UI          | a host that knows how to place us |

X11 answers all three with one primitive — reparenting, with XEmbed as the
handshake — which is why they look like one feature there. Windows has no
single primitive that covers them, so each needs deciding on its own.

## `<Frame>`: the surface path, and it is nearly built

The seam already exists and is tiny. A backend that composites panes from
shared memory declares itself with `app.createPaneHost(wnd)`, returning an
object with three methods (`src/cocoa/panehost.js` is the whole reference
implementation, 78 lines):

```js
setRect(rect); // where the pane goes, in the host's window
present(surfaceId); // the pane published a new buffer; show it
destroy();
```

Everything else — the fork, the props channel, the bridged theme, the crash
fallback, layout and hit testing — is backend-agnostic and already runs here.

On Cocoa `surfaceId` is an `IOSurface`. The Windows counterpart is a
**DirectComposition surface handle**, and the machinery around it is mostly in
place already:

- `WindowVisual(windowId)` (windows/src/bridge.h) hands back a window's root
  DComp visual, and `glcontext.cc` already parents a **child visual** into it
  for `<glarea>`. A pane host is the same move with different content.
- `BridgeD3DDevice()` is the shared D3D11 device.

What is missing is the cross-process buffer. Two candidates, and they are not
equally good:

**`DCompositionCreateSurfaceHandle`** — purpose-built for this. The pane
creates the handle, makes a composition swapchain against it
(`IDXGIFactory2::CreateSwapChainForCompositionSurfaceHandle`), and draws; the
host opens it with `IDCompositionDevice::CreateSurfaceFromHandle` and hands it
to a visual with `SetContent`. It is an NT handle, so it crosses processes
with `DuplicateHandle` like any other. This is the path Chromium uses for
out-of-process content, and the flip is the composition engine's rather than
ours — no explicit synchronisation to get wrong.

**A shared DXGI texture** — `IDXGIResource1::CreateSharedHandle` on the pane
side, `ID3D11Device1::OpenSharedResource1` on the host's. More general, and it
puts synchronisation back on us: a keyed mutex or a shared fence per frame,
which is a class of bug the first option does not have.

**Recommendation: the DComp surface handle.** It matches how the rest of this
backend already presents, it needs no fence protocol across the process
boundary, and `present(handle)` then means what `present(iosurfaceId)` means
on Cocoa — "this buffer is the current one" — which keeps the seam honest
rather than only similar.

The one real question a spike has to answer: the pane process must create DComp
objects, which means a **D3D device of its own**. Two devices, one adapter; the
handle is shared, the devices are not. Cheap to verify and it decides whether
the pane can keep the bridge unchanged or needs a device-only mode.

## `<foreign>`: child HWNDs, and why it is the least attractive of the three

`SetParent` across processes works, and it is the closest thing Windows has to
reparenting. It is also the one the platform warns about, and the warning is
real: parenting across a process boundary attaches the two threads' input
queues, so a hung child hangs the parent's input — docs/windows.md already
says this of `<foreign>` and it is the reason to be slow here.

It is worth noting what the X11 version is used for (docs/embedding.md): a
terminal pane, a video surface, a docked tray icon, a control-panel applet.
On Windows the first two are better served by other things — a terminal is a
pseudoconsole this app can render itself, and video is a swapchain — and the
last two do not exist as embeddable objects at all.

**Recommendation: leave `<foreign>` refusing on Windows.** It already refuses
honestly, `useSupports('embedding')` already says so, and a `SetParent`
implementation would buy a narrow set of cases at the cost of handing any
embedded program the ability to freeze the host. Revisit if a concrete need
turns up; do not build it speculatively.

## `<window embeddable>`: being the guest

This is the one the API is most ready for and the one with the most choices
under it. The prop already means exactly the right thing — "created, not
shown; somebody else will place me" — and core already honours it on every
backend by not mapping the window.

**As a child HWND.** We create the window `WS_CHILD`-capable, do not show it,
and publish its HWND; the host calls `SetParent` and sizes it. This is the
literal XEmbed analogue and is what OLE in-place activation renders into
underneath. Same input-queue caveat as above, but reversed and much more
acceptable: _we_ are the guest, the host chose to embed us, and a guest that
hangs its host is a guest the host can kill.

**As an OLE embedding, for actual documents.** "Embed into a Windows document"
in the literal sense — a pane inside a Word or Outlook document — is OLE
Compound Documents: register a CLSID, implement `IOleObject`,
`IOleInPlaceObject`, `IViewObject2` and `IDataObject`, and in-place activation
gives us a child HWND in the host's document, which is the previous paragraph
with a large COM preamble in front of it.

It is a real answer to a real question, and it is a lot: a registered local
server, apartment discipline, and a storage format for the "not currently
activated" state (a document has to show _something_ when the object is not
running — a metafile or a bitmap, which `window.snapshot()` can already
produce). Worth its own decision, not worth folding into this one.

**Recommendation: build the child-HWND form, and expose the handle.** It is
small, it serves every host that can give us a parent — including another
react-x11 app, a WinUI host, an Electron `BrowserWindow`, a game editor — and
it is the layer OLE would be built on if it is ever wanted. The API is already
`<window embeddable>`; what is new is a way to _get_ the handle, which is the
same question X11 answers with a window id.

## What must not change

- `<Frame src>` stays one element that works on every backend, with the same
  `props`, `fallback` and `restart()`.
- `useSupports('embedding')` stays the question an app asks before rendering
  `<foreign>`, and stays false here until something answers it.
- `<window embeddable>` keeps meaning "created, not shown" everywhere.
- Nothing grows a Windows-only name. A DComp surface handle is what
  `present()` carries here, the way an IOSurface id is what it carries on
  macOS — the seam names neither (AGENTS.md, "Vocabulary").

## Order of work

1. **Spike the two-device question** — a pane process creating its own D3D11
   device and a DComp surface handle the host can open. A day, and it decides
   everything after it.
2. **`Win32PaneHost`**, against the existing three-method seam, with
   `examples/frame.jsx` as the acceptance test: the ticker keeps ticking while
   the fractal pane grinds.
3. **Do not fork a pane that cannot be shown.** `<Frame>` asks about embedding
   only after starting the process; asking first costs one branch and saves a
   spawn on any backend that answers no. Independent of the rest, and worth
   doing whether or not (2) happens.
4. **Publish an embeddable window's HWND**, and a host-side way to place one —
   the guest direction, which needs no new element.
5. OLE, if a document embedding is actually wanted, on top of (4).

Step 2 is what makes `<Frame src>` mean the same thing on three backends.
Everything after it is new ground.
