# Changelog

## [2.1.2](https://github.com/sidorares/react-x11/compare/v2.1.1...v2.1.2) (2026-08-25)


### Performance Improvements

* **theme:** mounting a token-styled subtree no longer repaints the window ([#403](https://github.com/sidorares/react-x11/issues/403)) ([731cc2a](https://github.com/sidorares/react-x11/commit/731cc2a50f9604a0c290b19d9b4359a6a8fa245e)), closes [#402](https://github.com/sidorares/react-x11/issues/402)

## [2.1.1](https://github.com/sidorares/react-x11/compare/v2.1.0...v2.1.1) (2026-08-25)


### Performance Improvements

* **nodes:** amortize a commit's per-insert bookkeeping across the parent ([#399](https://github.com/sidorares/react-x11/issues/399)) ([4e030ef](https://github.com/sidorares/react-x11/commit/4e030ef4c4cfd0420f9b91e1f47f98c33cac6f52)), closes [#397](https://github.com/sidorares/react-x11/issues/397)
* **scroll:** a blitting viewport keeps a ledger of what changed inside it ([#401](https://github.com/sidorares/react-x11/issues/401)) ([522279d](https://github.com/sidorares/react-x11/commit/522279d82daa33ca98115de31d0c73c346bda31a)), closes [#398](https://github.com/sidorares/react-x11/issues/398)

## [2.1.0](https://github.com/sidorares/react-x11/compare/v2.0.1...v2.1.0) (2026-08-24)


### Features

* **examples:** San Francisco via fontconfig — the macOS lookalike setup ([#395](https://github.com/sidorares/react-x11/issues/395)) ([80781de](https://github.com/sidorares/react-x11/commit/80781debf827d878ae8d14fc2158c42978e0cd39))
* **gl:** ntk 8.4.0 — direct rendering on macOS via Apple-DRI ([#396](https://github.com/sidorares/react-x11/issues/396)) ([267fe30](https://github.com/sidorares/react-x11/commit/267fe30e7e0e3f24a2ecc9773e65cff11592db42))


### Bug Fixes

* **scale:** a server that is not describing hardware no longer answers the ladder ([#392](https://github.com/sidorares/react-x11/issues/392)) ([4bfc83c](https://github.com/sidorares/react-x11/commit/4bfc83ca697e1a65d26c8d7648e82d569ba681b9))

## [2.0.1](https://github.com/sidorares/react-x11/compare/v2.0.0...v2.0.1) (2026-08-24)


### Bug Fixes

* **focus:** a click into a field lights its ring, and a clicked widget stops hiding its focus ([#390](https://github.com/sidorares/react-x11/issues/390)) ([cc7cef7](https://github.com/sidorares/react-x11/commit/cc7cef7ed2478a67115f12f0102bcab16153f5f8))
* **screens:** select the work-area watch through ntk's root window ([#388](https://github.com/sidorares/react-x11/issues/388)) ([7892a70](https://github.com/sidorares/react-x11/commit/7892a707342801a780e4738232a3acb7ef8c05be))


### Performance Improvements

* **events:** stop asking for a cursor and a mask the window already has ([#389](https://github.com/sidorares/react-x11/issues/389)) ([1a0b480](https://github.com/sidorares/react-x11/commit/1a0b4801ac05d16f53ec844da70fb2d8a475658d))

## [2.0.0](https://github.com/sidorares/react-x11/compare/v1.2.0...v2.0.0) (2026-08-23)


### ⚠ BREAKING CHANGES

* `Tree`, `Calendar` and `DatePicker` are no longer exported from `react-x11`. They ship in `@react-x11/components`, which is where they have been since #338 and the tree/calendar work; core carried a second copy.
* **menus:** a menu item's `shortcut` is now a key binding rather than a caption. An application that also binds the same chord in its own `onKeyDown` will run the command twice unless that handler calls `preventDefault`, or the menu is given `accelerators={false}`.
* **deps:** ntk 8 ([#324](https://github.com/sidorares/react-x11/issues/324))
* the `<markdown>`, `<html>` and `<tex>` elements are removed — use `<Markdown>` and `<Formula>` from @react-x11/components. `react-x11/ntk` no longer re-exports `Yoga`: the layout engine is not ntk's any more, and an element never needs it (`measureContent` states its constraints in words, not yoga integers).
* **system:** the `WindowState` type is now the object `useWindowState()` returns. The union of _NET_WM_STATE names that `<window states>` takes is `WindowStateName`.
* **theme:** `dim` and `dimActive` are `textMuted` and `textMutedActive`. A theme that gave `background` a control fill distinct from the window's ground should move that colour to `surface`.
* **layout:** `flexShrink` defaults to 1 rather than yoga's 0, and every flex item carries a min-content floor on its container's main axis. A layout that relied on nothing shrinking now squeezes down to its content; write `flexShrink: 0` to keep it rigid. `flexShrink: 1` no longer means "this may shrink to nothing" for the `minWidth="auto"` window floor — that is now `minWidth: 0`, or an `overflow` that clips — and `overflow: 'scroll'` no longer injects `flexShrink: 1`, since it is the default.
* **events:** `useApp()` is typed as `NtkApp` rather than `unknown`, the same type `Root.app` already had — `lastInputTime(useApp())` does not compile otherwise. A call site that leant on the `unknown` needs its cast removed.
* **events:** the shortcut stays where the letters moved — keyboard layouts ([#279](https://github.com/sidorares/react-x11/issues/279))
* **popups:** `AnchorOptions.gap` and `AnchorOptions.flip` are gone from the declarations. Neither was ever read — `offset` is the gap, and the flip is unconditional — so nothing behaves differently, but TypeScript now says so. Popup placement is bounded by the monitor's work area rather than by the whole virtual screen, which moves menus and tooltips near a panel or a monitor seam.
* **events:** needs ntk >= 7.5.0. `ev.deltaX` and `ev.deltaY` are still pixels but are no longer multiples of 48 — a device that measures a scroll reports what it measured, so a handler that assumed whole notches sees fractions. The wheel is no longer a discrete event.
* **events:** `KeyboardEvent.key` and `.codepoint` are declared optional, which they always were at runtime — a function key carries neither, and now neither does a key an open composition took. TypeScript code that assigned `ev.key` to a `string` needs to narrow it.
* **extending:** `_canScroll(dx, dy)` is now `canScroll(dx, dy)` and `Node._paintContent(ctx)` is now `paintContent(ctx)`. A `Scrollable`'s content extent comes from `measureScrollContent()`, which returns `{ width, height }` including the end padding, where the private `_measureContent()` it replaces returned `{ right, bottom }` without it.
* **style:** the palette's new `direction` token defaults to the environment's locale, so an app run under an RTL locale now mirrors where it previously did not. Pin it with a ThemeProvider to keep the old behaviour.
* **style:** `color` and the font properties now reach descendants. A `<box style={{ color }}>` that previously affected nothing below it now sets the ink of every label inside it, and an `<Icon>` with no `color` follows the element around it rather than the palette. `<Icon>`'s own `size` still does not inherit and is still not `fontSize`.
* **types:** `DrawnNode.type` is now `DrawnNode.kind`. Nothing read it at runtime, since no node has ever had a `type` property, so only TypeScript callers are affected and the fix is the rename.
* **theme:** text that names no `fontSize` now takes the palette's rather than a constant 14, so an app whose theme sets `fontSize` gets the size it asked for in every unstyled `<text>`, `<textinput>` and widget label. `MenuBar`, `ContextMenu` and `Table` are unaffected: they take an explicit `fontSize` or `rowHeight`, because they size themselves before there is anywhere to measure in.
* **elements:** scrolling is a style, not an element ([#233](https://github.com/sidorares/react-x11/issues/233))
* **menu:** menu items use dbusmenu's vocabulary. `separator: true` is now `type: 'separator'`, `disabled: true` is `enabled: false`, `checked` is `toggleType: 'checkmark'` with `toggleState: 0 | 1 | -1`, and `shortcut` is `[['Control', 'S']]` rather than `'Ctrl+S'`.
* **window:** omitting `width`/`height` on a `<window>` no longer means 800x800 — it means `'auto'`, and the window is sized from its content. Pass the numbers to keep a fixed size.
* requires ntk >= 7. The frame rate a window runs at, the meaning of `frameLatency`, and the traced `fenceMs` field all change with it.
* **controls:** the theme token `borderActive` is now `borderFocus`. It was always the border of a *focused* control, and `:active` is the pressed state — keeping both spellings next to the new `accentActive` / `surfaceActive` / `dimActive` would have been actively misleading.
* render and unmountComponentAtNode are removed. Build a root with createRoot, then call render on it and await its unmount.
* `Checkbox`, `Switch`, `RadioGroup`, `Select` and `Slider` pass their `onChange` a single change event instead of `(value, event)`. Migration is `onChange={setX}` to `onChange={(ev) => setX(ev.value)}`.
* `<textinput onChange>` and `<textarea onChange>` receive a synthetic event instead of the new string, and `onSubmit` receives one instead of `(text, ev)`. Migration is `(text) => …` to `(ev) => …ev.target.value`.
* `createRoot(app)` is now `createRoot({ app })`; the old form throws an error naming the new one. `unmount` returns a Promise and closes a connection the root opened.
* `SelectThemeProvider` is deleted — use `ThemeProvider`, which it aliased. `ThemeProvider` now renders a box that was not there before; pass `style` to change how it lays out.
* requires ntk 4. A markdown fence tagged mermaid renders as a code block rather than a diagram.
* style is the only style channel ([#68](https://github.com/sidorares/react-x11/issues/68))

### Features

* &lt;scrollview&gt; scrolls on both axes ([#77](https://github.com/sidorares/react-x11/issues/77)) ([3b5fc71](https://github.com/sidorares/react-x11/commit/3b5fc71c2c3fed1cd135f682fca0266d52a16681))
* &lt;textinput onChange&gt; passes a synthetic event, and controls take a `name` ([#142](https://github.com/sidorares/react-x11/issues/142)) ([fdc7284](https://github.com/sidorares/react-x11/commit/fdc72841d3a580fbf7adb7925cf002643849b036))
* **3d:** a shader renderer for the direct backend ([#235](https://github.com/sidorares/react-x11/issues/235)) ([9f83f55](https://github.com/sidorares/react-x11/commit/9f83f55c654edfc7110ea07d89a35e445f234742))
* **3d:** points, lines, instances and useFrame ([#236](https://github.com/sidorares/react-x11/issues/236)) ([3f6d214](https://github.com/sidorares/react-x11/commit/3f6d214fc122fd6724e4d90895d57f58ad6eb382))
* **3d:** post-processing — &lt;effectComposer&gt; and a pass graph ([#237](https://github.com/sidorares/react-x11/issues/237)) ([9e00bb1](https://github.com/sidorares/react-x11/commit/9e00bb1b589cedf9fd382361b53ab7934706245f))
* a dialog the window manager knows belongs to its parent ([#143](https://github.com/sidorares/react-x11/issues/143)) ([03b0ece](https://github.com/sidorares/react-x11/commit/03b0ece213761cc4ca49e99d5b45548f43d41dc6)), closes [#130](https://github.com/sidorares/react-x11/issues/130)
* a right-click edit menu for &lt;textinput&gt; and &lt;textarea&gt; ([#90](https://github.com/sidorares/react-x11/issues/90)) ([2625308](https://github.com/sidorares/react-x11/commit/2625308473d716a6a6b8be840fcc0a7faba1da2c))
* a stress app to poke at by hand, and the bugs it found ([#104](https://github.com/sidorares/react-x11/issues/104)) ([8c3bac5](https://github.com/sidorares/react-x11/commit/8c3bac5b6ac9ca38a5ada6052fea281af636ef15))
* **a11y:** a focus ring, a keyboard-operable scrollview, and hitSlop ([#176](https://github.com/sidorares/react-x11/issues/176)) ([dd636b5](https://github.com/sidorares/react-x11/commit/dd636b58b9ebe89ad6a95b3c8eebbbb3cf0eae32))
* **a11y:** AT-SPI in core — screen readers see the tree ([#231](https://github.com/sidorares/react-x11/issues/231)) ([3a3d3cf](https://github.com/sidorares/react-x11/commit/3a3d3cf7ec02de7abe9d8682c9a932cded8b09d7))
* **a11y:** the accent is not the character — a preedit a screen reader can tell from its commit ([#281](https://github.com/sidorares/react-x11/issues/281)) ([98a4cba](https://github.com/sidorares/react-x11/commit/98a4cbae2793423df336ed73b6a4903866e75d42))
* **a11y:** the editor somebody else wrote, read by the paths ours is ([#288](https://github.com/sidorares/react-x11/issues/288)) ([37d3505](https://github.com/sidorares/react-x11/commit/37d35058a393a3f2eba38c95d9a2dab60d3e836c)), closes [#257](https://github.com/sidorares/react-x11/issues/257)
* **appearance:** follow the desktop's light/dark, accent, contrast and motion ([#213](https://github.com/sidorares/react-x11/issues/213)) ([8d65982](https://github.com/sidorares/react-x11/commit/8d6598223acb5fa18247fe72db16259e7670ba45))
* **bench:** protocol-efficiency analyzer, hover scenario, CI gate ([#380](https://github.com/sidorares/react-x11/issues/380)) ([9404209](https://github.com/sidorares/react-x11/commit/9404209f3fe7d85adb85fb28f8b90784df5c9f31))
* **button:** outline and ghost variants, a small size, and the ink reaches element children ([#376](https://github.com/sidorares/react-x11/issues/376)) ([315619d](https://github.com/sidorares/react-x11/commit/315619db4383a5bd59a704bd481056df15990b6d)), closes [#369](https://github.com/sidorares/react-x11/issues/369)
* **canvas:** DrawInfo carries the node's origin, so putImageData can land in the node ([#372](https://github.com/sidorares/react-x11/issues/372)) ([63acae5](https://github.com/sidorares/react-x11/commit/63acae5d78c71bc155b417758accbc53fa6db34c)), closes [#366](https://github.com/sidorares/react-x11/issues/366)
* **clipboard:** grey Paste when there is nothing to paste ([#172](https://github.com/sidorares/react-x11/issues/172)) ([8561fb8](https://github.com/sidorares/react-x11/commit/8561fb8839509a017c6a066866b2f441fabc7a7d)), closes [#164](https://github.com/sidorares/react-x11/issues/164)
* **clipboard:** useClipboard(), over the vocabulary drag and drop already had ([#171](https://github.com/sidorares/react-x11/issues/171)) ([66da92d](https://github.com/sidorares/react-x11/commit/66da92d886f6f9649b0b0d9a89ac63e5bfa74ce5)), closes [#164](https://github.com/sidorares/react-x11/issues/164)
* component queries and in-process DevTools inspection in react-x11/test ([#155](https://github.com/sidorares/react-x11/issues/155)) ([bb45f81](https://github.com/sidorares/react-x11/commit/bb45f81210b39866f3caff60fa32369a7e465893))
* **components:** a date picker — one date, a range, and days you can block ([#229](https://github.com/sidorares/react-x11/issues/229)) ([a937436](https://github.com/sidorares/react-x11/commit/a93743665d8773a9ccb58ba0e26041e7d0475306))
* **components:** a menu bar too narrow for its titles grows a chevron ([#246](https://github.com/sidorares/react-x11/issues/246)) ([87e54f8](https://github.com/sidorares/react-x11/commit/87e54f82fca90796ea19e8d546a5b59041efbda5)), closes [#241](https://github.com/sidorares/react-x11/issues/241)
* **components:** a password field that scribbles instead of counting ([#230](https://github.com/sidorares/react-x11/issues/230)) ([25960dc](https://github.com/sidorares/react-x11/commit/25960dc06f8c420ddf6767dcd628f0c427b5f974))
* **components:** a system icon set, and `<canvas mono>` to draw it ([#242](https://github.com/sidorares/react-x11/issues/242)) ([5502658](https://github.com/sidorares/react-x11/commit/550265895cb972286cdcdf2ce710dec90eefd263))
* **controls:** answer the press, not just the release ([#178](https://github.com/sidorares/react-x11/issues/178)) ([70d0bbe](https://github.com/sidorares/react-x11/commit/70d0bbe7d068aa9b569c33894489b0c4f398a46e))
* createRoot takes options, and owns the connection it opened ([#133](https://github.com/sidorares/react-x11/issues/133)) ([1ead87b](https://github.com/sidorares/react-x11/commit/1ead87b37bf8f344faa1c99f3854bb2021f69e5a)), closes [#114](https://github.com/sidorares/react-x11/issues/114)
* **dbus:** lazy, shared, never-throwing `useSessionBus()` / `useSystemBus()` ([#209](https://github.com/sidorares/react-x11/issues/209)) ([71208d9](https://github.com/sidorares/react-x11/commit/71208d9484c86ed6d6e8fe8d49e8ee74aafd8f77))
* **debug:** report the frame fence, and a live-server frame bench ([#185](https://github.com/sidorares/react-x11/issues/185)) ([ad6ff9a](https://github.com/sidorares/react-x11/commit/ad6ff9a76c83b67872805f14e2affc348af06333))
* **desktop:** myapp:// links open the app that is already running ([#234](https://github.com/sidorares/react-x11/issues/234)) ([44f284f](https://github.com/sidorares/react-x11/commit/44f284f18b1893feabdc72c2b06bdaf251136c8a)), closes [#173](https://github.com/sidorares/react-x11/issues/173)
* **desktop:** tell the launcher the app has started ([#179](https://github.com/sidorares/react-x11/issues/179)) ([ea97f82](https://github.com/sidorares/react-x11/commit/ea97f8292650ce2de9cfc2b88bbbb3c8e041a757))
* **devtools:** the overlays, the picker and the style editor a backend asks its host for ([#293](https://github.com/sidorares/react-x11/issues/293)) ([895b7ed](https://github.com/sidorares/react-x11/commit/895b7ed2adf9f3ad6429e383ce7a42c327bada7b))
* **dnd:** drag sources — in-app drags and XDND out ([#126](https://github.com/sidorares/react-x11/issues/126) phases 2+3) ([#165](https://github.com/sidorares/react-x11/issues/165)) ([2e38151](https://github.com/sidorares/react-x11/commit/2e38151b058076d64d33fff8735b53cccfce8d62))
* **dnd:** hand a drop the choices an asking source is offering ([#170](https://github.com/sidorares/react-x11/issues/170)) ([c4b27cc](https://github.com/sidorares/react-x11/commit/c4b27ccfc5a486949640b549230c1a13f7b90cf6)), closes [#126](https://github.com/sidorares/react-x11/issues/126)
* **dnd:** scroll a scrollview when a drag rests near its edge ([#169](https://github.com/sidorares/react-x11/issues/169)) ([6a75fce](https://github.com/sidorares/react-x11/commit/6a75fce422f56493df4c03a7d7270f98348f9f01)), closes [#126](https://github.com/sidorares/react-x11/issues/126)
* **dnd:** XDND drop target — accept drags from other X11 applications ([#162](https://github.com/sidorares/react-x11/issues/162)) ([d9788f5](https://github.com/sidorares/react-x11/commit/d9788f53faf5df00de4669c4f552c768901a6127))
* **elements:** another process's window, in the layout — &lt;foreign&gt; ([#277](https://github.com/sidorares/react-x11/issues/277)) ([4b25a26](https://github.com/sidorares/react-x11/commit/4b25a26535925729bb78aaf00a30b8f0b29e578d)), closes [#269](https://github.com/sidorares/react-x11/issues/269)
* **elements:** scrolling is a style, not an element ([#233](https://github.com/sidorares/react-x11/issues/233)) ([6593220](https://github.com/sidorares/react-x11/commit/659322098906db108eb6dbe6981b7625c46bfab9))
* **elements:** the text a reader can take — selection across a document ([#291](https://github.com/sidorares/react-x11/issues/291)) ([8d79413](https://github.com/sidorares/react-x11/commit/8d794134ba7995ceafeac5407c522ff9853f6e27))
* **events:** an `unstable_onAttention` event — the pointer is heading here (ntk[#37](https://github.com/sidorares/react-x11/issues/37)) ([#385](https://github.com/sidorares/react-x11/issues/385)) ([c2c0af1](https://github.com/sidorares/react-x11/commit/c2c0af166869adff8bbf6425bd8ba5bac507ec78))
* **events:** Space and Enter press what a click would press ([#336](https://github.com/sidorares/react-x11/issues/336)) ([58cd228](https://github.com/sidorares/react-x11/commit/58cd2286adc28399dbac5903bda1491bb5664134)), closes [#329](https://github.com/sidorares/react-x11/issues/329)
* **events:** the accent and the letter are one character — dead keys, Compose, and a preedit ([#276](https://github.com/sidorares/react-x11/issues/276)) ([af24146](https://github.com/sidorares/react-x11/commit/af241467eb5ab0c1d191fffa5715e5cc40fc8898))
* **events:** the modifier the user held is the modifier the handler reads — altKey and metaKey ([#286](https://github.com/sidorares/react-x11/issues/286)) ([76acf4e](https://github.com/sidorares/react-x11/commit/76acf4ea37923da84ab605af905d3c33a503065d)), closes [#284](https://github.com/sidorares/react-x11/issues/284)
* **events:** the protocol arrives at the window that speaks it — &lt;window onClientMessage&gt; ([#282](https://github.com/sidorares/react-x11/issues/282)) ([5d2966c](https://github.com/sidorares/react-x11/commit/5d2966c6555bab1f55612c3e867074536b499a99))
* **events:** the scroll is the distance the device measured ([#278](https://github.com/sidorares/react-x11/issues/278)) ([3924938](https://github.com/sidorares/react-x11/commit/39249386105f646b2c326ca5292b631fbf9cf38e))
* **events:** the shortcut stays where the letters moved — keyboard layouts ([#279](https://github.com/sidorares/react-x11/issues/279)) ([d5dd9b1](https://github.com/sidorares/react-x11/commit/d5dd9b14ed9db54353494f52d19615c174bbc1b8))
* **examples:** a countdown timer, and the half of an app that is not drawing ([#343](https://github.com/sidorares/react-x11/issues/343)) ([ac68467](https://github.com/sidorares/react-x11/commit/ac68467cfda49d66a51519426bd5d537b2d80e15))
* **examples:** a file browser, and the desktop it has to talk to ([#339](https://github.com/sidorares/react-x11/issues/339)) ([15156c9](https://github.com/sidorares/react-x11/commit/15156c9809828d3a339801a1bbf183d89d07aba5))
* **examples:** a font explorer — which face you actually get, and what it measures ([#344](https://github.com/sidorares/react-x11/issues/344)) ([69cf112](https://github.com/sidorares/react-x11/commit/69cf112d95f9f8a4b5f1f41601a53332bca1987b))
* **examples:** a model viewer, and what geometry costs on the wire ([#349](https://github.com/sidorares/react-x11/issues/349)) ([f95d223](https://github.com/sidorares/react-x11/commit/f95d223f6879d94a9f95470ea1cd6a5afe160a8a))
* **examples:** a preferences window, and what mirroring actually costs ([#340](https://github.com/sidorares/react-x11/issues/340)) ([fb88575](https://github.com/sidorares/react-x11/commit/fb885750b81208c64de573c9302f11b7b9c686d6))
* **examples:** a process monitor, and an input that stays responsive ([#335](https://github.com/sidorares/react-x11/issues/335)) ([b1abf31](https://github.com/sidorares/react-x11/commit/b1abf31687a19ef1b4c4a184291c5aac07d187cd))
* **examples:** a reparenting window manager, frames and all ([#82](https://github.com/sidorares/react-x11/issues/82)) ([390b151](https://github.com/sidorares/react-x11/commit/390b15169aa1b290154d8dcafdba54d573c8e456))
* **examples:** a variable-font lab, built from whatever axes a file has ([#224](https://github.com/sidorares/react-x11/issues/224)) ([9dc5d8b](https://github.com/sidorares/react-x11/commit/9dc5d8ba06ca6db014b0a620f36cba24e6ddd116))
* **examples:** GitHub, macOS and Windows demo themes, and a size query ([#79](https://github.com/sidorares/react-x11/issues/79)) ([adb10ab](https://github.com/sidorares/react-x11/commit/adb10abb77e7b35de2ce37ad34edcd9543b38758))
* **examples:** priority, Suspense, optimistic state, Activity and boundaries, in one window ([#216](https://github.com/sidorares/react-x11/issues/216)) ([88c0c12](https://github.com/sidorares/react-x11/commit/88c0c120800da603fcd5986ad34f255596e194d5))
* **examples:** scope the glyph path to the specimen, not the app ([#227](https://github.com/sidorares/react-x11/issues/227)) ([f754360](https://github.com/sidorares/react-x11/commit/f7543603883caeeaad8acb6a631d5915d0878580))
* **examples:** the React features doing their actual job — a chat client ([#325](https://github.com/sidorares/react-x11/issues/325)) ([24ec07b](https://github.com/sidorares/react-x11/commit/24ec07b39e2abcab0364f38c5a44c361fefdbccf))
* **extending:** a size the element decides — measureContent ([#265](https://github.com/sidorares/react-x11/issues/265)) ([6f792d5](https://github.com/sidorares/react-x11/commit/6f792d54f30df6a572c3acfe8acb5046b4474036)), closes [#250](https://github.com/sidorares/react-x11/issues/250)
* **extending:** behaviour the element decides — default actions ([#266](https://github.com/sidorares/react-x11/issues/266)) ([037a75d](https://github.com/sidorares/react-x11/commit/037a75d9a0ee0697bffb03df6061a0a30ae14875)), closes [#251](https://github.com/sidorares/react-x11/issues/251)
* **extending:** pixels that scroll — the wheel chain as public protocol ([#274](https://github.com/sidorares/react-x11/issues/274)) ([e885ca8](https://github.com/sidorares/react-x11/commit/e885ca81a72c28b591d0bce9598689a091501517)), closes [#253](https://github.com/sidorares/react-x11/issues/253)
* **extending:** the blit an element with a viewport of its own can ask for ([#307](https://github.com/sidorares/react-x11/issues/307)) ([e1dfea3](https://github.com/sidorares/react-x11/commit/e1dfea32ee56a84f46374520e10ca58778c657e4))
* **extending:** the box and the type an element draws in — contentBox and resolvedTextStyle ([#268](https://github.com/sidorares/react-x11/issues/268)) ([95c2531](https://github.com/sidorares/react-x11/commit/95c25318367b03c537f05f8b965c37d07d6d6af1)), closes [#254](https://github.com/sidorares/react-x11/issues/254)
* **extending:** the furniture an element blit keeps beside it ([#310](https://github.com/sidorares/react-x11/issues/310)) ([cefbf44](https://github.com/sidorares/react-x11/commit/cefbf44cc978719b54fd625b4bd270695acea6ba))
* **extending:** the menu a field opens is the menu an element can open — openEditMenu ([#289](https://github.com/sidorares/react-x11/issues/289)) ([b98d520](https://github.com/sidorares/react-x11/commit/b98d520cad69c1433d07473370687ba9ca9312ad))
* **extending:** the rect a pass is painting, and the commit claim an element makes itself ([#305](https://github.com/sidorares/react-x11/issues/305)) ([43b6d58](https://github.com/sidorares/react-x11/commit/43b6d58cea993b30323ead8bfdcfac2fdc2675f9))
* **extending:** the scene a registered element describes to a screen reader ([#308](https://github.com/sidorares/react-x11/issues/308)) ([5f055db](https://github.com/sidorares/react-x11/commit/5f055db630abeeab5aca4a21d2d5daf783eeab90)), closes [#304](https://github.com/sidorares/react-x11/issues/304)
* **extending:** the wheel and the hover a registered element can answer ([#306](https://github.com/sidorares/react-x11/issues/306)) ([d7dab0d](https://github.com/sidorares/react-x11/commit/d7dab0d70189f9cec4ea80dbe6d6e38c523370e1))
* **eyedropper:** pickScreenColor() / useEyedropper() — sample a colour from the screen ([#360](https://github.com/sidorares/react-x11/issues/360)) ([#377](https://github.com/sidorares/react-x11/issues/377)) ([ed2720b](https://github.com/sidorares/react-x11/commit/ed2720b32b52c4e8fb23f17b105bba7fbb9f7f08))
* **filedialog:** open, save and pick a folder, on whatever the machine has ([#210](https://github.com/sidorares/react-x11/issues/210)) ([b73eff0](https://github.com/sidorares/react-x11/commit/b73eff0b5021fea4289d931196a80e9b0dd38796))
* **focus:** focus follows visibility, so a hidden subtree stops taking keys ([#323](https://github.com/sidorares/react-x11/issues/323)) ([530fca2](https://github.com/sidorares/react-x11/commit/530fca2e45748085a7007f264f2db39d9ced36a5))
* **fonts:** openFont, loadFont and useFont — a font file the app opens itself ([#346](https://github.com/sidorares/react-x11/issues/346)) ([#347](https://github.com/sidorares/react-x11/issues/347)) ([eefb71e](https://github.com/sidorares/react-x11/commit/eefb71e3d188434f24dfbbe4031a1e2333ab315b))
* **frame:** &lt;Frame&gt; — a module in its own process, its window in yours ([#359](https://github.com/sidorares/react-x11/issues/359)) ([91e8fd8](https://github.com/sidorares/react-x11/commit/91e8fd8a64de758263489e7d89113e884a7287cd))
* **glarea:** render something useful when the server has no GL ([#200](https://github.com/sidorares/react-x11/issues/200)) ([2390946](https://github.com/sidorares/react-x11/commit/2390946fa7d001174c645ddf153af34e41a42673))
* **image:** accept in-memory pixels, and an existing Picture/Drawable id ([#373](https://github.com/sidorares/react-x11/issues/373)) ([5decad7](https://github.com/sidorares/react-x11/commit/5decad752ed66e5c0de703cfeb7de6fc7499e061)), closes [#367](https://github.com/sidorares/react-x11/issues/367)
* **layout:** everything shrinks, and nothing shrinks below what it needs ([#249](https://github.com/sidorares/react-x11/issues/249)) ([#292](https://github.com/sidorares/react-x11/issues/292)) ([b0ead04](https://github.com/sidorares/react-x11/commit/b0ead04d70f04f7739d1470048eb82ee5bd35917))
* **menu:** hand the menu bar to the desktop's global menu ([#232](https://github.com/sidorares/react-x11/issues/232)) ([7b07710](https://github.com/sidorares/react-x11/commit/7b077107b09339edf2c56d2a6090a12cacfefd7c))
* **menus:** a shortcut a menu draws is a shortcut it answers ([#351](https://github.com/sidorares/react-x11/issues/351)) ([#355](https://github.com/sidorares/react-x11/issues/355)) ([23865f5](https://github.com/sidorares/react-x11/commit/23865f534a122872da40741f047fde758b1ebff3))
* move to ntk 7, where the display sets the frame rate ([#221](https://github.com/sidorares/react-x11/issues/221)) ([f4f14df](https://github.com/sidorares/react-x11/commit/f4f14df4f67b789949161427e672790041a71e55))
* ntk 4, so a mermaid fence is a code block ([#107](https://github.com/sidorares/react-x11/issues/107)) ([30fa827](https://github.com/sidorares/react-x11/commit/30fa827a00cc20bb1324e5a54e89577a9392f645))
* own the layout engine, drop the document elements ([#315](https://github.com/sidorares/react-x11/issues/315)) ([02646d4](https://github.com/sidorares/react-x11/commit/02646d44e3d59d391d1df692e8d4ef5ca102334b))
* paint a discrete input's response from its handler, not the next frame ([#153](https://github.com/sidorares/react-x11/issues/153)) ([5fe669c](https://github.com/sidorares/react-x11/commit/5fe669c0ada56a6de5e0402e2335d6d23ce4d905))
* **popups:** a popup at the caret, sized by its own rows — anchor and at ([#280](https://github.com/sidorares/react-x11/issues/280)) ([3b3691a](https://github.com/sidorares/react-x11/commit/3b3691a549ba81968cf4fe13000057d2b52e307a))
* **popups:** rounded menus, tooltips with arrows, and the tokens for both ([#215](https://github.com/sidorares/react-x11/issues/215)) ([382f815](https://github.com/sidorares/react-x11/commit/382f815ab72a544376924e9a8defb27d9a8fbeb3))
* **refresh:** productize the hot-reload example pattern into react-x11/refresh ([#321](https://github.com/sidorares/react-x11/issues/321)) ([8c52235](https://github.com/sidorares/react-x11/commit/8c52235a2096710fa3fe09da5d8f132dd2e795f3))
* registerElement() and the subpath exports a third-party element needs ([#158](https://github.com/sidorares/react-x11/issues/158)) ([f6e7cb1](https://github.com/sidorares/react-x11/commit/f6e7cb1c463796cd33f4fc74e127daaf55f98825)), closes [#125](https://github.com/sidorares/react-x11/issues/125)
* **registry:** a re-registration policy for hot reload — the same definition does not throw ([#322](https://github.com/sidorares/react-x11/issues/322)) ([6f4bbcf](https://github.com/sidorares/react-x11/commit/6f4bbcf454cb65c1534872cfb4bc20fd28b618af)), closes [#318](https://github.com/sidorares/react-x11/issues/318)
* remove Tree, Calendar, DatePicker, Canvas3D and the scene graph ([#379](https://github.com/sidorares/react-x11/issues/379)) ([663e4c0](https://github.com/sidorares/react-x11/commit/663e4c0712477acde3b8b0fb1899317efc99995f))
* retire the legacy render()/unmountComponentAtNode() pair ([#159](https://github.com/sidorares/react-x11/issues/159)) ([f09d284](https://github.com/sidorares/react-x11/commit/f09d28436c51dcf08508045d0e825fed814ad297)), closes [#114](https://github.com/sidorares/react-x11/issues/114)
* runtime diagnostics — protocol tracer, paint flashing, invalidation reasons ([#137](https://github.com/sidorares/react-x11/issues/137)) ([d4b5d98](https://github.com/sidorares/react-x11/commit/d4b5d9826ed6c3fdb1a279d28d04c37cf9ad0079))
* **scale:** a display scale model — apps write logical pixels, 'auto' resolves the factor from the connection ([#378](https://github.com/sidorares/react-x11/issues/378)) ([aba5b63](https://github.com/sidorares/react-x11/commit/aba5b63d6e6f726f24186dd14d5b3ea9b6d2fa8a)), closes [#116](https://github.com/sidorares/react-x11/issues/116)
* ship a supported react-x11/test entry point ([#144](https://github.com/sidorares/react-x11/issues/144)) ([a19f55c](https://github.com/sidorares/react-x11/commit/a19f55c32cfcc936b99402e87bc71c7829f77122)), closes [#123](https://github.com/sidorares/react-x11/issues/123)
* style is the only style channel ([#68](https://github.com/sidorares/react-x11/issues/68)) ([754c373](https://github.com/sidorares/react-x11/commit/754c373dad8dab7ccdcd5bc03ebda4896287f1ad))
* style transitions, and a Switch thumb that slides ([#70](https://github.com/sidorares/react-x11/issues/70)) ([37eaa71](https://github.com/sidorares/react-x11/commit/37eaa71b8ecbe44780aaa5f3981ec46c767d6af3))
* **style:** per-side borders — borderLeftWidth and friends ([#262](https://github.com/sidorares/react-x11/issues/262)) ([#263](https://github.com/sidorares/react-x11/issues/263)) ([f95c24b](https://github.com/sidorares/react-x11/commit/f95c24b01c9c0c4e5aa0c67841a49fd3e700fa61))
* **styles:** a looping animation, and the indeterminate bar it was for ([#352](https://github.com/sidorares/react-x11/issues/352)) ([#356](https://github.com/sidorares/react-x11/issues/356)) ([fcb7f25](https://github.com/sidorares/react-x11/commit/fcb7f256074be4ca3b46c12203ae0cbd1f2caff0))
* **styles:** backgroundImage gradients and boxShadow, so a panel stays a box ([#348](https://github.com/sidorares/react-x11/issues/348)) ([088fa78](https://github.com/sidorares/react-x11/commit/088fa78197cc1540f1a61589b2900b309118ca1e))
* **style:** the ink and the face travel down the tree — text inheritance, and :focus-within ([#270](https://github.com/sidorares/react-x11/issues/270)) ([40a170f](https://github.com/sidorares/react-x11/commit/40a170f159dad00b3b72e367ff217a654c565e43))
* **style:** the layout mirrors — direction, logical edges, and an RTL widget set ([#275](https://github.com/sidorares/react-x11/issues/275)) ([1d3f5b4](https://github.com/sidorares/react-x11/commit/1d3f5b47517a3304f53dd215583a989924140db1))
* **system:** the machine around the app ([#313](https://github.com/sidorares/react-x11/issues/313)) ([751f247](https://github.com/sidorares/react-x11/commit/751f24797d4920d6e750e5d1cb73879176a5cc03))
* Table — sticky header, resizable columns, virtualized rows ([#78](https://github.com/sidorares/react-x11/issues/78)) ([5e14c50](https://github.com/sidorares/react-x11/commit/5e14c50eb2e01b0ef0e6acfd6729bd001e75cd39))
* Tabs and SplitPane, and a showcase example that hosts the others ([#75](https://github.com/sidorares/react-x11/issues/75)) ([3861968](https://github.com/sidorares/react-x11/commit/3861968f9dc8f04313b8a548211f08f251b43bc0))
* **text:** fontVariationSettings, a variable font's axes on &lt;text&gt; ([#223](https://github.com/sidorares/react-x11/issues/223)) ([3099c18](https://github.com/sidorares/react-x11/commit/3099c18488fc92a3620ec84089d228755b407a5c))
* **text:** textOverflow and maxLines, so a cut name says it was cut ([#350](https://github.com/sidorares/react-x11/issues/350)) ([#354](https://github.com/sidorares/react-x11/issues/354)) ([4cd0c80](https://github.com/sidorares/react-x11/commit/4cd0c80307d1b88f269aa556154bddad89939901))
* **text:** textRendering, and it does not reflow ([#226](https://github.com/sidorares/react-x11/issues/226)) ([5813913](https://github.com/sidorares/react-x11/commit/58139136c13856de3b6895877da4fc784560cbf0))
* the value widgets pass a change event too, so one signature covers the library ([#146](https://github.com/sidorares/react-x11/issues/146)) ([85c4469](https://github.com/sidorares/react-x11/commit/85c4469571beeadeb1a984137bbbfb116d6ba067))
* theme tokens — $name style values ([#72](https://github.com/sidorares/react-x11/issues/72)) ([a926061](https://github.com/sidorares/react-x11/commit/a926061410cd418697320d917bb2cfc89cd89552))
* **theme:** the four things a screen says with colour, and a surface that is one ([#290](https://github.com/sidorares/react-x11/issues/290)) ([49fb2b3](https://github.com/sidorares/react-x11/commit/49fb2b30ec04f8d48291cb9e3d1dafee45194fc2))
* **theme:** the palette carries the type — fontFamily and monoFamily ([#264](https://github.com/sidorares/react-x11/issues/264)) ([ddb4b22](https://github.com/sidorares/react-x11/commit/ddb4b22acf7b7995b1e609b25da1595505708ef2)), closes [#261](https://github.com/sidorares/react-x11/issues/261)
* **tooltip:** element labels size themselves — measure hidden, place, then map ([#375](https://github.com/sidorares/react-x11/issues/375)) ([48db8e7](https://github.com/sidorares/react-x11/commit/48db8e7032e75d0570bb5af4b3ba578d5ca244d1)), closes [#368](https://github.com/sidorares/react-x11/issues/368)
* Tree — disclosure rows with a file-browser keyboard model ([#76](https://github.com/sidorares/react-x11/issues/76)) ([8912fb8](https://github.com/sidorares/react-x11/commit/8912fb88a71e329e38630f849d9f3aebc18587be))
* TypeScript declarations for the public API ([#83](https://github.com/sidorares/react-x11/issues/83)) ([cf40565](https://github.com/sidorares/react-x11/commit/cf40565838ec1457453d7541ca2ba2d00f4b4ce0))
* **types:** declarations that match the runtime — focus, kind, chords, invalidate ([#267](https://github.com/sidorares/react-x11/issues/267)) ([fe70192](https://github.com/sidorares/react-x11/commit/fe70192aeaccf6ddddc651221997056ff63ce626))
* undo and redo in &lt;textinput&gt; and &lt;textarea&gt; ([#84](https://github.com/sidorares/react-x11/issues/84)) ([5e433f4](https://github.com/sidorares/react-x11/commit/5e433f4c39a955d26ff4a44441b82679f8e8e469))
* window size queries — '[@width](https://github.com/width) &gt;= 600' style blocks ([#74](https://github.com/sidorares/react-x11/issues/74)) ([d50b17b](https://github.com/sidorares/react-x11/commit/d50b17b89b19308364215bbab59b821d3161187b))
* window states, undecorated windows, and a hidden pointer ([#135](https://github.com/sidorares/react-x11/issues/135)) ([2bb852a](https://github.com/sidorares/react-x11/commit/2bb852a16824e0c37a67af118c62c9d4f637ee31)), closes [#122](https://github.com/sidorares/react-x11/issues/122)
* **windows:** a bound the content decides — minWidth="auto" and friends ([#248](https://github.com/sidorares/react-x11/issues/248)) ([2c063ed](https://github.com/sidorares/react-x11/commit/2c063ed4007dd9e4326b71acd7e09140c63f823b))
* **window:** size a window from its content when it is not given one ([#228](https://github.com/sidorares/react-x11/issues/228)) ([8aa6c88](https://github.com/sidorares/react-x11/commit/8aa6c8835dc94156f869faf6c97dac21871babe2))
* **window:** transparent, for ARGB windows and rounded popups ([#208](https://github.com/sidorares/react-x11/issues/208)) ([a74a36a](https://github.com/sidorares/react-x11/commit/a74a36ab8c67036f2958af08bff4b3e0e843c5d6))
* **yoga:** give the layout engine a public home ([#320](https://github.com/sidorares/react-x11/issues/320)) ([3722ea5](https://github.com/sidorares/react-x11/commit/3722ea55d162bcb8a0970126887eca485d22bd39))


### Bug Fixes

* a throwing event handler no longer takes the process with it ([#136](https://github.com/sidorares/react-x11/issues/136)) ([af416bf](https://github.com/sidorares/react-x11/commit/af416bfbfc071808c655bf7567d8d876c5ce3014)), closes [#113](https://github.com/sidorares/react-x11/issues/113)
* a transition started by a prop change draws its own first frame ([#108](https://github.com/sidorares/react-x11/issues/108)) ([0ed08d1](https://github.com/sidorares/react-x11/commit/0ed08d13f462149768ddcb231838d55f4ed27a62))
* **anchor:** keep an open popup tracking its trigger ([#214](https://github.com/sidorares/react-x11/issues/214)) ([5c22ea4](https://github.com/sidorares/react-x11/commit/5c22ea4fc73e6a76205b8294562cc62233b1c015))
* **clipboard:** ICCCM timestamps on copy, paste, drop and drag-end release ([#167](https://github.com/sidorares/react-x11/issues/167)) ([cfbddc9](https://github.com/sidorares/react-x11/commit/cfbddc9c8712e4c0790b4e31b548ef7f93675cb6))
* **components:** a menu bar item is the same pill as the row it opens ([#245](https://github.com/sidorares/react-x11/issues/245)) ([7bad5dd](https://github.com/sidorares/react-x11/commit/7bad5dd95f836ce2b0b60432e1298dfe81054e3a))
* **components:** double click opens a row, and the table header stops fighting the pointer ([#240](https://github.com/sidorares/react-x11/issues/240)) ([aab98eb](https://github.com/sidorares/react-x11/commit/aab98eb76644d03e564ae92edda16262ff8c277b))
* **debug:** REACT_X11_NO_SCROLL_BLIT answers only to 1 ([#184](https://github.com/sidorares/react-x11/issues/184)) ([0fe5436](https://github.com/sidorares/react-x11/commit/0fe543665e73ec6a836ea2cb6c99010ae4b5b93b))
* **deps:** bump ntk to 7.6.1 ([#300](https://github.com/sidorares/react-x11/issues/300)) ([ceb9da5](https://github.com/sidorares/react-x11/commit/ceb9da51c22bf7d91da44656ff2db2d7fada647e))
* **deps:** ntk 5.1.0, which rasterizes small drawings locally ([#152](https://github.com/sidorares/react-x11/issues/152)) ([7e37112](https://github.com/sidorares/react-x11/commit/7e37112064257c75e49d01af014f695f72dcf5e7))
* **dialog:** a managed dialog draws its title once, in the frame ([#374](https://github.com/sidorares/react-x11/issues/374)) ([5d50923](https://github.com/sidorares/react-x11/commit/5d50923019e1000177584a8238579c53b6be9a4e)), closes [#370](https://github.com/sidorares/react-x11/issues/370)
* **dnd:** an async onDrop that rejects is reported, not fatal ([#243](https://github.com/sidorares/react-x11/issues/243)) ([0f70d51](https://github.com/sidorares/react-x11/commit/0f70d513704b06f75c494e10937c0499adcaf58d))
* **elements:** size &lt;image&gt; and &lt;svg&gt; by style, ink &lt;tex&gt; by style ([#175](https://github.com/sidorares/react-x11/issues/175)) ([64bf402](https://github.com/sidorares/react-x11/commit/64bf402268a8863db9c8e3fdc0d80781ae55347f)), closes [#118](https://github.com/sidorares/react-x11/issues/118)
* **events:** a key goes to the node that has focus, not to the window it landed on ([#332](https://github.com/sidorares/react-x11/issues/332)) ([331ecd0](https://github.com/sidorares/react-x11/commit/331ecd0bba73c038ad7b970f6dac722865fa5ac5)), closes [#331](https://github.com/sidorares/react-x11/issues/331)
* **events:** the caret follows the keyboard, not one of the windows sharing a focus ([#334](https://github.com/sidorares/react-x11/issues/334)) ([3457fcd](https://github.com/sidorares/react-x11/commit/3457fcd0096c416cac46d9dff396beadb6bd4fce)), closes [#333](https://github.com/sidorares/react-x11/issues/333)
* **gl:** useSupports('shaders') answers for the connection, not the machine ([#358](https://github.com/sidorares/react-x11/issues/358)) ([343c3f2](https://github.com/sidorares/react-x11/commit/343c3f20e8e7f6108342f1ffe7e54f018a4b055b)), closes [#357](https://github.com/sidorares/react-x11/issues/357)
* **layout:** the width a content floor is a height for ([#312](https://github.com/sidorares/react-x11/issues/312)) ([96ddcc0](https://github.com/sidorares/react-x11/commit/96ddcc077d1781959eb41881d049daf9f7fd2ce1)), closes [#311](https://github.com/sidorares/react-x11/issues/311)
* one ThemeProvider, one palette ([#132](https://github.com/sidorares/react-x11/issues/132)) ([6d13e13](https://github.com/sidorares/react-x11/commit/6d13e13105528998cd35c124006cd3c52174d62a)), closes [#119](https://github.com/sidorares/react-x11/issues/119)
* **paint:** a frame scheduled before the connection closed paints nothing ([#314](https://github.com/sidorares/react-x11/issues/314)) ([d9cbfad](https://github.com/sidorares/react-x11/commit/d9cbfad54be1b49a7beaba89f60f751662b7d2ae))
* **paint:** cull a node past a clipping ancestor's own box, not just the window's ([#212](https://github.com/sidorares/react-x11/issues/212)) ([d6a84df](https://github.com/sidorares/react-x11/commit/d6a84dfa9f98c6350e56f94d539e5c58b7826390)), closes [#211](https://github.com/sidorares/react-x11/issues/211)
* **popup:** a popup that declares nothing is a popup_menu, and the sheets say dropdown_menu ([#363](https://github.com/sidorares/react-x11/issues/363)) ([07d3684](https://github.com/sidorares/react-x11/commit/07d36842cc7400ae9a0ec9c8834652258aaa048a)), closes [#298](https://github.com/sidorares/react-x11/issues/298)
* popups anchor to the window, not to the corner of the screen ([#81](https://github.com/sidorares/react-x11/issues/81)) ([685f8ee](https://github.com/sidorares/react-x11/commit/685f8eea8e6eaef134f9d0afd8b8cef7b14910b4))
* **portal:** an abort that beats the portal's reply is not lost ([#247](https://github.com/sidorares/react-x11/issues/247)) ([24a67da](https://github.com/sidorares/react-x11/commit/24a67da078a20de9379d964a9a7a5c45ee8ef04b))
* row gaps in the feature grid, and bun as a JSX runner ([#97](https://github.com/sidorares/react-x11/issues/97)) ([4445a56](https://github.com/sidorares/react-x11/commit/4445a562c8d476b63ab81fac5913bc5592f03af0))
* **scripts:** read pixels back as RGBA, which is what ntk now hands over ([#177](https://github.com/sidorares/react-x11/issues/177)) ([a925745](https://github.com/sidorares/react-x11/commit/a925745f42ad1fa658531904aecc9f371b313b58))
* scrollbars can be dragged with the pointer ([#73](https://github.com/sidorares/react-x11/issues/73)) ([fcc95fd](https://github.com/sidorares/react-x11/commit/fcc95fda09580c0ffd76505fe27c7299ad744c6c))
* **scroll:** poison the blit when damage precedes the frame's first scrollTo ([#296](https://github.com/sidorares/react-x11/issues/296)) ([a1abc6d](https://github.com/sidorares/react-x11/commit/a1abc6d038ac4b85d0316b9b63429be35ed32884))
* **select:** a menu long enough to scroll swallowed every click ([#225](https://github.com/sidorares/react-x11/issues/225)) ([f6d9b28](https://github.com/sidorares/react-x11/commit/f6d9b281c7942bfef6c50045a6e793ba64fc3ea5))
* size a Select's menu to its longest option, not the selected one ([#109](https://github.com/sidorares/react-x11/issues/109)) ([249e6dd](https://github.com/sidorares/react-x11/commit/249e6dde2baa8cc9d66dd3f2d8340c69d1013fdd))
* stop passing DevTools a config it throws away ([#134](https://github.com/sidorares/react-x11/issues/134)) ([bcd1637](https://github.com/sidorares/react-x11/commit/bcd16379ec6d4dfce525751749099f74d7052ad9)), closes [#121](https://github.com/sidorares/react-x11/issues/121)
* stop tracking the node_modules symlink ([#382](https://github.com/sidorares/react-x11/issues/382)) ([87b3452](https://github.com/sidorares/react-x11/commit/87b34529d6f33cc99d380f3b36abb43acb0e4d09))
* straight alpha for GL and colour interpolation ([#101](https://github.com/sidorares/react-x11/issues/101)) ([b90596c](https://github.com/sidorares/react-x11/commit/b90596c684f3972df11fc4dceab20d7d6888cabb))
* **style:** a field is exactly as tall as the button beside it ([#327](https://github.com/sidorares/react-x11/issues/327)) ([c73c338](https://github.com/sidorares/react-x11/commit/c73c33878f84f6b8d434482f1e7ba338411fde96))
* **style:** a field's text sits where its capitals are centred, leading and all ([#328](https://github.com/sidorares/react-x11/issues/328)) ([32ee7cc](https://github.com/sidorares/react-x11/commit/32ee7cc71755485941f4949ee53f476ed9f79d47))
* **text:** a field reads the direction of the box it is in ([#342](https://github.com/sidorares/react-x11/issues/342)) ([2a0a7d4](https://github.com/sidorares/react-x11/commit/2a0a7d46708d13d83576b60cb7922dece9beb728)), closes [#341](https://github.com/sidorares/react-x11/issues/341)
* **text:** re-measure when a text style prop changes ([#222](https://github.com/sidorares/react-x11/issues/222)) ([2846e99](https://github.com/sidorares/react-x11/commit/2846e99d898b1fbbe3066932c149aba966e09b05))
* transitions start from now, not from the last frame drawn ([#80](https://github.com/sidorares/react-x11/issues/80)) ([7b9b5de](https://github.com/sidorares/react-x11/commit/7b9b5de57fc008bb73cd9e0e8862d9e02ef83bb4))
* **types:** a registered element is a DrawnNode again ([#294](https://github.com/sidorares/react-x11/issues/294)) ([9a51351](https://github.com/sidorares/react-x11/commit/9a51351548ff496201baa93c2f5ea0af15609055))
* **windows:** a move is not a resize ([#183](https://github.com/sidorares/react-x11/issues/183)) ([b5205ef](https://github.com/sidorares/react-x11/commit/b5205efe346a16a6be61c91a3597300464fe77ca))
* **windows:** don't map a &lt;window&gt; the same commit hides ([#244](https://github.com/sidorares/react-x11/issues/244)) ([dbf9e01](https://github.com/sidorares/react-x11/commit/dbf9e01f4d8622987093c9707ae0460cb720fd2d)), closes [#201](https://github.com/sidorares/react-x11/issues/201)
* **windows:** keep event props out of ntk's creation attributes ([#196](https://github.com/sidorares/react-x11/issues/196)) ([d72310c](https://github.com/sidorares/react-x11/commit/d72310ccfa307f02764693da136840d69539cd0b))
* **window:** the WM close button asks, instead of killing the connection ([#365](https://github.com/sidorares/react-x11/issues/365)) ([c55d50f](https://github.com/sidorares/react-x11/commit/c55d50fd53ac0b6e27cfd7d1178ec02f99e1ff82))


### Performance Improvements

* bound React updates to the nodes that actually changed ([#102](https://github.com/sidorares/react-x11/issues/102)) ([d3421d8](https://github.com/sidorares/react-x11/commit/d3421d894e252328658c35aad02688f88a9683a1))
* **boxes:** ride ntk 6.7.0's corner-glyph fast path, and see when a box misses it ([#220](https://github.com/sidorares/react-x11/issues/220)) ([091a8e5](https://github.com/sidorares/react-x11/commit/091a8e5df6aecee4a54f136b507b92521a221338))
* cache rendered &lt;svg&gt; and &lt;tex&gt; content, keyed on what is drawn ([#157](https://github.com/sidorares/react-x11/issues/157)) ([d5257ce](https://github.com/sidorares/react-x11/commit/d5257ce1a8a1b8f643f34753146cf5569ceba337))
* **deps:** ntk 8.3.0 — the rect-clip and picture-clip fixes land ([#384](https://github.com/sidorares/react-x11/issues/384)) ([084570e](https://github.com/sidorares/react-x11/commit/084570e0ceb74680eebe9e43264003f98f15996b))
* **events:** select XI2 on the first wheel, not at creation ([#383](https://github.com/sidorares/react-x11/issues/383)) ([9911657](https://github.com/sidorares/react-x11/commit/9911657e63beb99bf9ddd5ee15d1828deec118da))
* **events:** stop allocating per node per event on the pointer path ([#188](https://github.com/sidorares/react-x11/issues/188)) ([#194](https://github.com/sidorares/react-x11/issues/194)) ([ecc08c4](https://github.com/sidorares/react-x11/commit/ecc08c4ccd2f751b248e57877bf18f9d2a3ef11e))
* paint a region, not the box around it ([#106](https://github.com/sidorares/react-x11/issues/106)) ([66b951b](https://github.com/sidorares/react-x11/commit/66b951b6a73c616512d5c8a88359b8749864512a))
* **paint:** bound layout damage to what moved ([#186](https://github.com/sidorares/react-x11/issues/186)) ([#191](https://github.com/sidorares/react-x11/issues/191)) ([4ff8e7d](https://github.com/sidorares/react-x11/commit/4ff8e7dec717070bec704a0486a918cb0bdcd65e))
* **paint:** bound the invalidate sites that already know their rect ([#187](https://github.com/sidorares/react-x11/issues/187)) ([#193](https://github.com/sidorares/react-x11/issues/193)) ([3f1891b](https://github.com/sidorares/react-x11/commit/3f1891bdf1d083484d4866431981cca640e0b3fa))
* **protocol:** checkbox-hover protocol audit — event mask at CreateWindow, concurrent startup probes, hover-frame bench ([#381](https://github.com/sidorares/react-x11/issues/381)) ([a127916](https://github.com/sidorares/react-x11/commit/a1279160d1341748b87e2cf6b66e9571d630198b))
* repaint only the region that changed ([#100](https://github.com/sidorares/react-x11/issues/100)) ([35ed595](https://github.com/sidorares/react-x11/commit/35ed595c4053b104e747a249fb7fcc8687e72f1c))
* scroll a viewport by blitting the surviving band, repainting only the exposed strip ([#139](https://github.com/sidorares/react-x11/issues/139)) ([d4786f1](https://github.com/sidorares/react-x11/commit/d4786f121c48ca262d608ad78beb9fd1f16a6c70))
* **startup:** overlap the engine load with the connection, and gate the pixels ([#386](https://github.com/sidorares/react-x11/issues/386)) ([3325c27](https://github.com/sidorares/react-x11/commit/3325c27d88dad8a2989bb6db9c89c24f30ed0e57))
* **text:** only the lines on screen, and all of them in one request ([#285](https://github.com/sidorares/react-x11/issues/285)) ([f642deb](https://github.com/sidorares/react-x11/commit/f642debe674d1f8c8de67754ba98f7aea7845021))
* **windows:** only ask where the window is when it actually moved ([#195](https://github.com/sidorares/react-x11/issues/195)) ([b844736](https://github.com/sidorares/react-x11/commit/b844736a8b20a64ec79289859948d4747f74f4b8))


### Build System

* **deps:** ntk 8 ([#324](https://github.com/sidorares/react-x11/issues/324)) ([a69cc15](https://github.com/sidorares/react-x11/commit/a69cc152e818f1c7c194bed5f2ea4aa2e92c8119))

## [1.2.0](https://github.com/sidorares/react-x11/compare/v1.1.0...v1.2.0) (2026-07-28)


### Features

* child window stacking follows JSX order and zIndex ([#66](https://github.com/sidorares/react-x11/issues/66)) ([557d446](https://github.com/sidorares/react-x11/commit/557d44659567ad54eeed728489a6bd46a8a1e784))

## [1.1.0](https://github.com/sidorares/react-x11/compare/v1.0.0...v1.1.0) (2026-07-28)


### Features

* click-to-component — Alt/Option+Click opens the source in your editor ([#65](https://github.com/sidorares/react-x11/issues/65)) ([cf4bfa2](https://github.com/sidorares/react-x11/commit/cf4bfa294a12152613749125d941e96c69ba639a))
* **examples:** hot reloading with React Fast Refresh for the tasks example ([#62](https://github.com/sidorares/react-x11/issues/62)) ([cb94f5e](https://github.com/sidorares/react-x11/commit/cb94f5e3dce587c2e2d331a4e6baf0cdcc939326))

## 1.0.0 (2026-07-27)


### ⚠ BREAKING CHANGES

* package is now ESM ("type": "module"); raw strings are only legal inside <text>; event handler props are dispatched synthetically instead of being registered on the ntk window at creation.

### Features

* &lt;window onCloseRequest&gt; + examples overhaul (fixed xeyes, multi-window demo, shared Button) ([ceb0760](https://github.com/sidorares/react-x11/commit/ceb076070c2f6bc42daca46ad97989a80054caa2))
* 3D over indirect GLX — &lt;glarea&gt; surface and the &lt;mesh&gt; scene tree ([#50](https://github.com/sidorares/react-x11/issues/50)) ([7e30643](https://github.com/sidorares/react-x11/commit/7e306434996a64d5abbef7c3e53396ab92d61d19))
* adopt ntk 3.3.0 caret API, README overhaul, docs/ API reference ([768631b](https://github.com/sidorares/react-x11/commit/768631b40a667ebf62bc921bf7b8f14b0a396631))
* adopt ntk 3.3.0 caret API; README overhaul; docs/ API reference ([86fb6f7](https://github.com/sidorares/react-x11/commit/86fb6f78e88506f5533e50fc60ac6c7eec024df2))
* bump ntk to ^3.4.0 — async rich content reflows via onInvalidate ([1a67aa1](https://github.com/sidorares/react-x11/commit/1a67aa107c0273c075e7ec862d7bac9e69e54426))
* create X11 windows top-down in the commit phase ([10ee29e](https://github.com/sidorares/react-x11/commit/10ee29e1ef775f383a0ddb3c5a60a06326e2a3e3))
* create X11 windows top-down in the commit phase ([c43453f](https://github.com/sidorares/react-x11/commit/c43453f89a32d6c97072f68b784f5582aaa4656f)), closes [#4](https://github.com/sidorares/react-x11/issues/4)
* **examples:** live markdown preview in the widget gallery ([#60](https://github.com/sidorares/react-x11/issues/60)) ([54bb09f](https://github.com/sidorares/react-x11/commit/54bb09fafd4b8f43ac4d7927a56b12c1e8545ccd))
* lights and lit materials ([#51](https://github.com/sidorares/react-x11/issues/51)) ([84393b4](https://github.com/sidorares/react-x11/commit/84393b4fd5a9c6351b2f930df1c25ce105da85d9))
* MenuBar and ContextMenu on useAnchor; guard 'transparent' colours ([#40](https://github.com/sidorares/react-x11/issues/40)) ([3231341](https://github.com/sidorares/react-x11/commit/3231341c7afb1ee823dbd43845f0ddbcccf0d3e3))
* modernize renderer to React 19 and revive project tooling ([2054f3a](https://github.com/sidorares/react-x11/commit/2054f3aba815d5a476a80f3f05424d90c0ad0c4c))
* modernize renderer to React 19 and revive project tooling ([0b43b33](https://github.com/sidorares/react-x11/commit/0b43b3314bb39cead42ffaf726dd7da3469aa92f))
* nested submenus for MenuBar and ContextMenu ([#41](https://github.com/sidorares/react-x11/issues/41)) ([80fd2bd](https://github.com/sidorares/react-x11/commit/80fd2bd74d8073eebea21ca478f00976ad4a25ea))
* PageUp/PageDown in Select and the menus ([#48](https://github.com/sidorares/react-x11/issues/48)) ([000a538](https://github.com/sidorares/react-x11/commit/000a538d5ad4176c45e2e9b9a6a5cce98092eb3f))
* pointer capture for userland, and a Slider built on it ([#38](https://github.com/sidorares/react-x11/issues/38)) ([d512dd2](https://github.com/sidorares/react-x11/commit/d512dd2b1abfa80aed0e2eda6d5062c076be65b7))
* React DevTools highlight-on-hover ([16b3523](https://github.com/sidorares/react-x11/commit/16b35232ba4caf6e241f4b478118d813be7b1660))
* React DevTools highlight-on-hover ([4e085d6](https://github.com/sidorares/react-x11/commit/4e085d6bf753e1d6b6d727aa92ef2678c4d676d5))
* React-DOM-style content for rich elements — SVG JSX children, string children for markdown/html/tex ([ca3426c](https://github.com/sidorares/react-x11/commit/ca3426c62f48e33877ed0dcc9c3e4410d6fe34c2))
* require ntk 3 as a runtime dependency and add end-to-end test ([c7252e0](https://github.com/sidorares/react-x11/commit/c7252e0ee976b89e28f1cc9bcf8a69149cbf0327))
* retained widget renderer with yoga layout, synthetic events, and drawn elements ([1a9afcd](https://github.com/sidorares/react-x11/commit/1a9afcd8d2eff062a2da320d9d058a4fe467b2aa))
* rich-content elements &lt;markdown&gt;, &lt;html&gt;, &lt;svg&gt;, &lt;tex&gt; ([cc45347](https://github.com/sidorares/react-x11/commit/cc45347308d31745ac31c4aa5aa1748f4da659da))
* rich-content elements &lt;markdown&gt;, &lt;html&gt;, &lt;svg&gt;, &lt;tex&gt; ([fa9e014](https://github.com/sidorares/react-x11/commit/fa9e0141a5e764c2e67665866e0f97f660788e5e))
* safe-polygon hover for submenus and tooltips ([#55](https://github.com/sidorares/react-x11/issues/55)) ([d25d1a8](https://github.com/sidorares/react-x11/commit/d25d1a8c66454137525e776f54f99380b09e6fe2))
* screenshots:framed — capture examples with the WM's window frame ([#36](https://github.com/sidorares/react-x11/issues/36)) ([c48b54b](https://github.com/sidorares/react-x11/commit/c48b54b5ac9ff7b180cea12c48b39139f5ac7dd5))
* Select keyboard navigation + scrollview scrollIntoView ([#34](https://github.com/sidorares/react-x11/issues/34)) ([7dc5fa4](https://github.com/sidorares/react-x11/commit/7dc5fa490c76a37ecc449be7fcf178f12c97bd84))
* Select widget component, double-click word selection, form example ([7fabae8](https://github.com/sidorares/react-x11/commit/7fabae8173a1b30da55d5c44db1731b2bb559e0e))
* Select widget component, double-click word selection, form example ([70324ae](https://github.com/sidorares/react-x11/commit/70324ae17b6c6f1156741c5214e917bf57431fd5))
* tab order, focus scopes, and a Dialog built on them ([#61](https://github.com/sidorares/react-x11/issues/61)) ([177a8cd](https://github.com/sidorares/react-x11/commit/177a8cdd9e2779baf1ec858b55ea5fa9aedb1702))
* textarea/textinput polish — word movement, PageUp/Down, shift+click, scrollbar ([#44](https://github.com/sidorares/react-x11/issues/44)) ([c253382](https://github.com/sidorares/react-x11/commit/c25338233a056a2b9894d5debdef801e7977f949))
* textures and pointer events on meshes ([#53](https://github.com/sidorares/react-x11/issues/53)) ([0890947](https://github.com/sidorares/react-x11/commit/0890947033d3c834e8c2eb06e1a6e14f0cc2cdb1))
* type-ahead in Select and the menus ([#42](https://github.com/sidorares/react-x11/issues/42)) ([0c0dbdd](https://github.com/sidorares/react-x11/commit/0c0dbdd2f531d815edd2d0a2da060d91cbb98a96))
* useAnchor/anchorRect extracted from Select, and a Tooltip on it ([#39](https://github.com/sidorares/react-x11/issues/39)) ([f2af77e](https://github.com/sidorares/react-x11/commit/f2af77e4d227eee1f0e7498f9144c90147c68098))
* window focus, a public focus API, and menus that dismiss on an outside press ([#56](https://github.com/sidorares/react-x11/issues/56)) ([bb802fd](https://github.com/sidorares/react-x11/commit/bb802fd35c4f5a06ad80ce0767104781842feaf5))
* window manager hints as &lt;window&gt; props; type hint on &lt;popup&gt; ([#37](https://github.com/sidorares/react-x11/issues/37)) ([1c2f3ba](https://github.com/sidorares/react-x11/commit/1c2f3ba3bb3c93001803dc421692f49c72a42f0c))


### Bug Fixes

* distribute text leading below the ink evenly (CSS half-leading) ([471f47a](https://github.com/sidorares/react-x11/commit/471f47addc287d56bf034f25cc7795f811d1e673))
* distribute text leading evenly (CSS half-leading) — centered labels no longer ride high ([3f86954](https://github.com/sidorares/react-x11/commit/3f86954fde94ede618109631a5927a7992a4e4a0))
* make the DevTools bridge actually work with react-devtools-core 7 ([2a6d4a1](https://github.com/sidorares/react-x11/commit/2a6d4a141279ceb064f1c4be8afd524fc1c8ba92))
* pad the textinput selection/caret marker around the glyph ink ([d66521a](https://github.com/sidorares/react-x11/commit/d66521ae9d52ec8304c58dbcbdf79e49cfdd2faf))
* satisfy DevTools' DOM-ish host-instance contract so highlight works ([334ab2b](https://github.com/sidorares/react-x11/commit/334ab2b6dd853fcd92bc6a0165bb6057d0f5364b))
* scrollview sizing, image aspect ratio, and examples that predate the ([#57](https://github.com/sidorares/react-x11/issues/57)) ([ccb2516](https://github.com/sidorares/react-x11/commit/ccb2516133723894c727e885a7d553d0feb00860))
* Slider and ProgressBar no longer inflate the box they sit in ([#58](https://github.com/sidorares/react-x11/issues/58)) ([c5ae735](https://github.com/sidorares/react-x11/commit/c5ae735e5f153cddec7a79b895bd9b6946b60d1b))
* textinput caret stuck when typing trailing spaces ([89794cf](https://github.com/sidorares/react-x11/commit/89794cfa7c80f3a4a64f516e8cb8fdafb422e1d6))
* textinput caret stuck when typing trailing spaces ([035dac0](https://github.com/sidorares/react-x11/commit/035dac0294920659bfca307781eaf9d990fd7982))
