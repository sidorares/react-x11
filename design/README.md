# react-x11 design records

Contributor-only. This directory holds the record of _why_: implementation
history, rejected alternatives, presenter and pipeline internals,
measurements, plans and open questions. [docs/](../docs/README.md) is the
reference for _what_ — the pages app developers and their coding agents read.

Nothing here ships in the npm package (`files` takes `docs/`, not
`design/`) or appears on the website. A doc page links here only where a
reader would otherwise miss something; code comments cite these files by
path and section (`design/macos.md §"Layer promotion"`).

Two kinds of file live here:

- **`design/<page>.md`** — the design notes split out of `docs/<page>.md`,
  with the original headings, so a section keeps its name when it moves.
- **`design/architecture/`** and the backend RFCs — whole documents behind
  the bigger pieces, each written against a named commit.

## Backends

- [macos.md](macos.md) — the Cocoa backend's full design record: the RFC it
  began as, the two presenters and which one is the measured default, text
  through CoreText, input and the run loop, JS on a worker, native controls,
  custom drawing on a layer tree, layer promotion, the bridge contract and
  the split between bridge and renderer, every "Measured:" section, the plan
  and the open questions. [docs/macos.md](../docs/macos.md) is what an app
  sees.
- [windows.md](windows.md) — the win32 backend's full design record: the
  brief cross-checked, why the bridge is our own, threads and the event
  loop, rendering on DirectComposition and Direct2D, DirectWrite, input and
  IME, UI Automation, the plan, what to probe first and the sources.
  [docs/windows.md](../docs/windows.md) is what an app sees, and
  [windows-integrations.md](windows-integrations.md) holds the notes behind
  the status page.
- [windows-gl.md](windows-gl.md) — 3D on Windows: what `opengl32.dll` gives
  with and without a vendor driver, measured, and the ANGLE rung below it.
- [windows-embedding.md](windows-embedding.md) — `<Frame>`, `<foreign>` and
  `<window embeddable>` on Windows: which mechanism sits under each, and
  what it costs.
- [wayland.md](wayland.md) — the research RFC the native Wayland backend was
  built from; [wayland-backend.md](wayland-backend.md) holds what was
  measured and the design where it is not the obvious one.
- [glx.md](glx.md) — 3D over indirect GLX: what the protocol encodes, why
  display lists are mandatory, and the scope it keeps.

## Notes behind the reference pages

Each file below holds what was moved out of the `docs/` page of the same
name — history, mechanism, measurements, rejected alternatives — under the
heading it had there.

[accessibility.md](accessibility.md), [appearance.md](appearance.md),
[click-to-component.md](click-to-component.md),
[clipboard.md](clipboard.md), [components.md](components.md),
[dbus.md](dbus.md), [debugging.md](debugging.md),
[desktop-calendar.md](desktop-calendar.md), [desktop.md](desktop.md),
[devtools.md](devtools.md), [drag-and-drop.md](drag-and-drop.md),
[ecosystem.md](ecosystem.md), [elements.md](elements.md),
[embedding.md](embedding.md), [events.md](events.md),
[extending.md](extending.md), [eyedropper.md](eyedropper.md),
[filedialog.md](filedialog.md), [frame.md](frame.md), [gl.md](gl.md),
[globalmenu.md](globalmenu.md), [notifications.md](notifications.md),
[packaging.md](packaging.md), [permissions.md](permissions.md),
[react-features.md](react-features.md), [remote.md](remote.md),
[scale.md](scale.md), [styling.md](styling.md), [system.md](system.md),
[testing.md](testing.md), [typescript.md](typescript.md),
[uri-schemes.md](uri-schemes.md),
[ecosystem/dev-tooling.md](ecosystem/dev-tooling.md),
[ecosystem/forms.md](ecosystem/forms.md).

## Architecture records

`architecture/` holds the documents behind the bigger pieces: measured,
written against a named commit, and kept as the record of _why_ rather than
the reference for _what_. Some describe what shipped; some are proposals
that have not been built, and say so at the top.

- [architecture/frame-pacing.md](architecture/frame-pacing.md) — the
  design record behind `frameRate`: why a window fed off an input path
  paints screens nobody sees, the token bucket over paint time that holds
  it to a budget, where it lives on both backends, and what it measured.
- [architecture/element-layer-contents.md](architecture/element-layer-contents.md)
  — the design record for the other half of a streaming element's frame on
  macOS: why an element with a retained surface pays a composite and the
  window swapchain's catch-up copy to move pixels it already has, what the
  platform does with an element-owned IOSurface (spiked in pixels), and the
  presentable `Surface` plus `presentedSurface()` policy that would remove
  both. Not built.
- [architecture/video.md](architecture/video.md) — the design record for
  video, reviewed against the four backends: why no X11 extension decodes
  anything and the one that did is dead, what a decoded frame costs through
  core `PutImage` and what Xv would change, the VideoToolbox and Core
  Animation ladder on macOS measured end to end, the YUV surface that is
  blank through `render(in:)` and drawn on screen (probed, and it reverses
  the first version's Cocoa design), what a frame sink costs through a
  plain layer, the Media Foundation plan for Windows with the probes it
  owes, a `<video>` element with two sources — `frames` everywhere, `src`
  where the platform has a player — on the sprite seam, and how `<Html>`
  and `<MediaPlayer>` consume it. Not built.
- [architecture/animation.md](architecture/animation.md) — what the style
  vocabulary cannot say today (a fade, a move that does not reflow, a
  timeline that ends), who should interpolate it, and what offloading a
  transition to Core Animation costs and buys.
- [architecture/container-queries.md](architecture/container-queries.md) —
  why a container's size is an output of layout where a window's is an
  input, the resolve-after-a-pass loop that follows, and the oscillation it
  can produce. Implemented; [styling.md](../docs/styling.md#container-queries) is
  the reference.
- [architecture/custom-layout.md](architecture/custom-layout.md) — why an
  arrangement that depends on a layout output has to run inside the pass
  rather than in an effect, the two seams that do — a `layout` that arranges
  a box's children and a `position` that moves one node, with `sticky` now
  the built-in one — how a layout's children become yoga trees of their own,
  and what they cost. Implemented; [styling.md](../docs/styling.md#custom-layouts)
  is the reference.
- [architecture/grid-layout.md](architecture/grid-layout.md) — CSS Grid as
  a layout on that seam, written the way CSS writes it (`display: 'grid'`,
  `gridTemplateColumns`): why the style is flat, the spec's placement and
  track sizing and what is left out, how it is held to Chrome, and what it
  costs against flexbox — more than it should have, until the seam
  remembered what it asks a child. Implemented;
  [styling.md](../docs/styling.md#grid) is the reference.
- [architecture/drag-and-drop.md](architecture/drag-and-drop.md) — XDND on
  both sides: where the advertisement lives when every control is drawn into
  one window, what the drag-source half costs, and the API review that
  produced the one in [drag-and-drop.md](../docs/drag-and-drop.md).
- [architecture/accessibility.md](architecture/accessibility.md) — the
  AT-SPI2 bridge with no mirror tree: what it exposes, the event pipeline,
  and the alternatives that lost.
- [architecture/protocol-efficiency.md](architecture/protocol-efficiency.md)
  — a request-by-request audit of one hovered checkbox, across react-x11,
  ntk and node-x11, and the fixes it produced.
- [architecture/windowed-regions.md](architecture/windowed-regions.md) —
  when an X11 subwindow pays for itself and when it does not, measured
  against three servers. Research; nothing here is built.
