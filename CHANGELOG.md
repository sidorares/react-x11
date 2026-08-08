# Changelog

## [2.0.0](https://github.com/sidorares/react-x11/compare/v1.2.0...v2.0.0) (2026-08-08)


### ⚠ BREAKING CHANGES

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
* a dialog the window manager knows belongs to its parent ([#143](https://github.com/sidorares/react-x11/issues/143)) ([03b0ece](https://github.com/sidorares/react-x11/commit/03b0ece213761cc4ca49e99d5b45548f43d41dc6)), closes [#130](https://github.com/sidorares/react-x11/issues/130)
* a right-click edit menu for &lt;textinput&gt; and &lt;textarea&gt; ([#90](https://github.com/sidorares/react-x11/issues/90)) ([2625308](https://github.com/sidorares/react-x11/commit/2625308473d716a6a6b8be840fcc0a7faba1da2c))
* a stress app to poke at by hand, and the bugs it found ([#104](https://github.com/sidorares/react-x11/issues/104)) ([8c3bac5](https://github.com/sidorares/react-x11/commit/8c3bac5b6ac9ca38a5ada6052fea281af636ef15))
* **a11y:** a focus ring, a keyboard-operable scrollview, and hitSlop ([#176](https://github.com/sidorares/react-x11/issues/176)) ([dd636b5](https://github.com/sidorares/react-x11/commit/dd636b58b9ebe89ad6a95b3c8eebbbb3cf0eae32))
* **appearance:** follow the desktop's light/dark, accent, contrast and motion ([#213](https://github.com/sidorares/react-x11/issues/213)) ([8d65982](https://github.com/sidorares/react-x11/commit/8d6598223acb5fa18247fe72db16259e7670ba45))
* **clipboard:** grey Paste when there is nothing to paste ([#172](https://github.com/sidorares/react-x11/issues/172)) ([8561fb8](https://github.com/sidorares/react-x11/commit/8561fb8839509a017c6a066866b2f441fabc7a7d)), closes [#164](https://github.com/sidorares/react-x11/issues/164)
* **clipboard:** useClipboard(), over the vocabulary drag and drop already had ([#171](https://github.com/sidorares/react-x11/issues/171)) ([66da92d](https://github.com/sidorares/react-x11/commit/66da92d886f6f9649b0b0d9a89ac63e5bfa74ce5)), closes [#164](https://github.com/sidorares/react-x11/issues/164)
* component queries and in-process DevTools inspection in react-x11/test ([#155](https://github.com/sidorares/react-x11/issues/155)) ([bb45f81](https://github.com/sidorares/react-x11/commit/bb45f81210b39866f3caff60fa32369a7e465893))
* **components:** a date picker — one date, a range, and days you can block ([#229](https://github.com/sidorares/react-x11/issues/229)) ([a937436](https://github.com/sidorares/react-x11/commit/a93743665d8773a9ccb58ba0e26041e7d0475306))
* **components:** a password field that scribbles instead of counting ([#230](https://github.com/sidorares/react-x11/issues/230)) ([25960dc](https://github.com/sidorares/react-x11/commit/25960dc06f8c420ddf6767dcd628f0c427b5f974))
* **controls:** answer the press, not just the release ([#178](https://github.com/sidorares/react-x11/issues/178)) ([70d0bbe](https://github.com/sidorares/react-x11/commit/70d0bbe7d068aa9b569c33894489b0c4f398a46e))
* createRoot takes options, and owns the connection it opened ([#133](https://github.com/sidorares/react-x11/issues/133)) ([1ead87b](https://github.com/sidorares/react-x11/commit/1ead87b37bf8f344faa1c99f3854bb2021f69e5a)), closes [#114](https://github.com/sidorares/react-x11/issues/114)
* **dbus:** lazy, shared, never-throwing `useSessionBus()` / `useSystemBus()` ([#209](https://github.com/sidorares/react-x11/issues/209)) ([71208d9](https://github.com/sidorares/react-x11/commit/71208d9484c86ed6d6e8fe8d49e8ee74aafd8f77))
* **debug:** report the frame fence, and a live-server frame bench ([#185](https://github.com/sidorares/react-x11/issues/185)) ([ad6ff9a](https://github.com/sidorares/react-x11/commit/ad6ff9a76c83b67872805f14e2affc348af06333))
* **desktop:** tell the launcher the app has started ([#179](https://github.com/sidorares/react-x11/issues/179)) ([ea97f82](https://github.com/sidorares/react-x11/commit/ea97f8292650ce2de9cfc2b88bbbb3c8e041a757))
* **dnd:** drag sources — in-app drags and XDND out ([#126](https://github.com/sidorares/react-x11/issues/126) phases 2+3) ([#165](https://github.com/sidorares/react-x11/issues/165)) ([2e38151](https://github.com/sidorares/react-x11/commit/2e38151b058076d64d33fff8735b53cccfce8d62))
* **dnd:** hand a drop the choices an asking source is offering ([#170](https://github.com/sidorares/react-x11/issues/170)) ([c4b27cc](https://github.com/sidorares/react-x11/commit/c4b27ccfc5a486949640b549230c1a13f7b90cf6)), closes [#126](https://github.com/sidorares/react-x11/issues/126)
* **dnd:** scroll a scrollview when a drag rests near its edge ([#169](https://github.com/sidorares/react-x11/issues/169)) ([6a75fce](https://github.com/sidorares/react-x11/commit/6a75fce422f56493df4c03a7d7270f98348f9f01)), closes [#126](https://github.com/sidorares/react-x11/issues/126)
* **dnd:** XDND drop target — accept drags from other X11 applications ([#162](https://github.com/sidorares/react-x11/issues/162)) ([d9788f5](https://github.com/sidorares/react-x11/commit/d9788f53faf5df00de4669c4f552c768901a6127))
* **examples:** a reparenting window manager, frames and all ([#82](https://github.com/sidorares/react-x11/issues/82)) ([390b151](https://github.com/sidorares/react-x11/commit/390b15169aa1b290154d8dcafdba54d573c8e456))
* **examples:** a variable-font lab, built from whatever axes a file has ([#224](https://github.com/sidorares/react-x11/issues/224)) ([9dc5d8b](https://github.com/sidorares/react-x11/commit/9dc5d8ba06ca6db014b0a620f36cba24e6ddd116))
* **examples:** GitHub, macOS and Windows demo themes, and a size query ([#79](https://github.com/sidorares/react-x11/issues/79)) ([adb10ab](https://github.com/sidorares/react-x11/commit/adb10abb77e7b35de2ce37ad34edcd9543b38758))
* **examples:** priority, Suspense, optimistic state, Activity and boundaries, in one window ([#216](https://github.com/sidorares/react-x11/issues/216)) ([88c0c12](https://github.com/sidorares/react-x11/commit/88c0c120800da603fcd5986ad34f255596e194d5))
* **examples:** scope the glyph path to the specimen, not the app ([#227](https://github.com/sidorares/react-x11/issues/227)) ([f754360](https://github.com/sidorares/react-x11/commit/f7543603883caeeaad8acb6a631d5915d0878580))
* **filedialog:** open, save and pick a folder, on whatever the machine has ([#210](https://github.com/sidorares/react-x11/issues/210)) ([b73eff0](https://github.com/sidorares/react-x11/commit/b73eff0b5021fea4289d931196a80e9b0dd38796))
* **glarea:** render something useful when the server has no GL ([#200](https://github.com/sidorares/react-x11/issues/200)) ([2390946](https://github.com/sidorares/react-x11/commit/2390946fa7d001174c645ddf153af34e41a42673))
* move to ntk 7, where the display sets the frame rate ([#221](https://github.com/sidorares/react-x11/issues/221)) ([f4f14df](https://github.com/sidorares/react-x11/commit/f4f14df4f67b789949161427e672790041a71e55))
* ntk 4, so a mermaid fence is a code block ([#107](https://github.com/sidorares/react-x11/issues/107)) ([30fa827](https://github.com/sidorares/react-x11/commit/30fa827a00cc20bb1324e5a54e89577a9392f645))
* paint a discrete input's response from its handler, not the next frame ([#153](https://github.com/sidorares/react-x11/issues/153)) ([5fe669c](https://github.com/sidorares/react-x11/commit/5fe669c0ada56a6de5e0402e2335d6d23ce4d905))
* **popups:** rounded menus, tooltips with arrows, and the tokens for both ([#215](https://github.com/sidorares/react-x11/issues/215)) ([382f815](https://github.com/sidorares/react-x11/commit/382f815ab72a544376924e9a8defb27d9a8fbeb3))
* registerElement() and the subpath exports a third-party element needs ([#158](https://github.com/sidorares/react-x11/issues/158)) ([f6e7cb1](https://github.com/sidorares/react-x11/commit/f6e7cb1c463796cd33f4fc74e127daaf55f98825)), closes [#125](https://github.com/sidorares/react-x11/issues/125)
* retire the legacy render()/unmountComponentAtNode() pair ([#159](https://github.com/sidorares/react-x11/issues/159)) ([f09d284](https://github.com/sidorares/react-x11/commit/f09d28436c51dcf08508045d0e825fed814ad297)), closes [#114](https://github.com/sidorares/react-x11/issues/114)
* runtime diagnostics — protocol tracer, paint flashing, invalidation reasons ([#137](https://github.com/sidorares/react-x11/issues/137)) ([d4b5d98](https://github.com/sidorares/react-x11/commit/d4b5d9826ed6c3fdb1a279d28d04c37cf9ad0079))
* ship a supported react-x11/test entry point ([#144](https://github.com/sidorares/react-x11/issues/144)) ([a19f55c](https://github.com/sidorares/react-x11/commit/a19f55c32cfcc936b99402e87bc71c7829f77122)), closes [#123](https://github.com/sidorares/react-x11/issues/123)
* style is the only style channel ([#68](https://github.com/sidorares/react-x11/issues/68)) ([754c373](https://github.com/sidorares/react-x11/commit/754c373dad8dab7ccdcd5bc03ebda4896287f1ad))
* style transitions, and a Switch thumb that slides ([#70](https://github.com/sidorares/react-x11/issues/70)) ([37eaa71](https://github.com/sidorares/react-x11/commit/37eaa71b8ecbe44780aaa5f3981ec46c767d6af3))
* Table — sticky header, resizable columns, virtualized rows ([#78](https://github.com/sidorares/react-x11/issues/78)) ([5e14c50](https://github.com/sidorares/react-x11/commit/5e14c50eb2e01b0ef0e6acfd6729bd001e75cd39))
* Tabs and SplitPane, and a showcase example that hosts the others ([#75](https://github.com/sidorares/react-x11/issues/75)) ([3861968](https://github.com/sidorares/react-x11/commit/3861968f9dc8f04313b8a548211f08f251b43bc0))
* **text:** fontVariationSettings, a variable font's axes on &lt;text&gt; ([#223](https://github.com/sidorares/react-x11/issues/223)) ([3099c18](https://github.com/sidorares/react-x11/commit/3099c18488fc92a3620ec84089d228755b407a5c))
* **text:** textRendering, and it does not reflow ([#226](https://github.com/sidorares/react-x11/issues/226)) ([5813913](https://github.com/sidorares/react-x11/commit/58139136c13856de3b6895877da4fc784560cbf0))
* the value widgets pass a change event too, so one signature covers the library ([#146](https://github.com/sidorares/react-x11/issues/146)) ([85c4469](https://github.com/sidorares/react-x11/commit/85c4469571beeadeb1a984137bbbfb116d6ba067))
* theme tokens — $name style values ([#72](https://github.com/sidorares/react-x11/issues/72)) ([a926061](https://github.com/sidorares/react-x11/commit/a926061410cd418697320d917bb2cfc89cd89552))
* Tree — disclosure rows with a file-browser keyboard model ([#76](https://github.com/sidorares/react-x11/issues/76)) ([8912fb8](https://github.com/sidorares/react-x11/commit/8912fb88a71e329e38630f849d9f3aebc18587be))
* TypeScript declarations for the public API ([#83](https://github.com/sidorares/react-x11/issues/83)) ([cf40565](https://github.com/sidorares/react-x11/commit/cf40565838ec1457453d7541ca2ba2d00f4b4ce0))
* undo and redo in &lt;textinput&gt; and &lt;textarea&gt; ([#84](https://github.com/sidorares/react-x11/issues/84)) ([5e433f4](https://github.com/sidorares/react-x11/commit/5e433f4c39a955d26ff4a44441b82679f8e8e469))
* window size queries — '[@width](https://github.com/width) &gt;= 600' style blocks ([#74](https://github.com/sidorares/react-x11/issues/74)) ([d50b17b](https://github.com/sidorares/react-x11/commit/d50b17b89b19308364215bbab59b821d3161187b))
* window states, undecorated windows, and a hidden pointer ([#135](https://github.com/sidorares/react-x11/issues/135)) ([2bb852a](https://github.com/sidorares/react-x11/commit/2bb852a16824e0c37a67af118c62c9d4f637ee31)), closes [#122](https://github.com/sidorares/react-x11/issues/122)
* **window:** size a window from its content when it is not given one ([#228](https://github.com/sidorares/react-x11/issues/228)) ([8aa6c88](https://github.com/sidorares/react-x11/commit/8aa6c8835dc94156f869faf6c97dac21871babe2))
* **window:** transparent, for ARGB windows and rounded popups ([#208](https://github.com/sidorares/react-x11/issues/208)) ([a74a36a](https://github.com/sidorares/react-x11/commit/a74a36ab8c67036f2958af08bff4b3e0e843c5d6))


### Bug Fixes

* a throwing event handler no longer takes the process with it ([#136](https://github.com/sidorares/react-x11/issues/136)) ([af416bf](https://github.com/sidorares/react-x11/commit/af416bfbfc071808c655bf7567d8d876c5ce3014)), closes [#113](https://github.com/sidorares/react-x11/issues/113)
* a transition started by a prop change draws its own first frame ([#108](https://github.com/sidorares/react-x11/issues/108)) ([0ed08d1](https://github.com/sidorares/react-x11/commit/0ed08d13f462149768ddcb231838d55f4ed27a62))
* **anchor:** keep an open popup tracking its trigger ([#214](https://github.com/sidorares/react-x11/issues/214)) ([5c22ea4](https://github.com/sidorares/react-x11/commit/5c22ea4fc73e6a76205b8294562cc62233b1c015))
* **clipboard:** ICCCM timestamps on copy, paste, drop and drag-end release ([#167](https://github.com/sidorares/react-x11/issues/167)) ([cfbddc9](https://github.com/sidorares/react-x11/commit/cfbddc9c8712e4c0790b4e31b548ef7f93675cb6))
* **debug:** REACT_X11_NO_SCROLL_BLIT answers only to 1 ([#184](https://github.com/sidorares/react-x11/issues/184)) ([0fe5436](https://github.com/sidorares/react-x11/commit/0fe543665e73ec6a836ea2cb6c99010ae4b5b93b))
* **deps:** ntk 5.1.0, which rasterizes small drawings locally ([#152](https://github.com/sidorares/react-x11/issues/152)) ([7e37112](https://github.com/sidorares/react-x11/commit/7e37112064257c75e49d01af014f695f72dcf5e7))
* **elements:** size &lt;image&gt; and &lt;svg&gt; by style, ink &lt;tex&gt; by style ([#175](https://github.com/sidorares/react-x11/issues/175)) ([64bf402](https://github.com/sidorares/react-x11/commit/64bf402268a8863db9c8e3fdc0d80781ae55347f)), closes [#118](https://github.com/sidorares/react-x11/issues/118)
* one ThemeProvider, one palette ([#132](https://github.com/sidorares/react-x11/issues/132)) ([6d13e13](https://github.com/sidorares/react-x11/commit/6d13e13105528998cd35c124006cd3c52174d62a)), closes [#119](https://github.com/sidorares/react-x11/issues/119)
* **paint:** cull a node past a clipping ancestor's own box, not just the window's ([#212](https://github.com/sidorares/react-x11/issues/212)) ([d6a84df](https://github.com/sidorares/react-x11/commit/d6a84dfa9f98c6350e56f94d539e5c58b7826390)), closes [#211](https://github.com/sidorares/react-x11/issues/211)
* popups anchor to the window, not to the corner of the screen ([#81](https://github.com/sidorares/react-x11/issues/81)) ([685f8ee](https://github.com/sidorares/react-x11/commit/685f8eea8e6eaef134f9d0afd8b8cef7b14910b4))
* row gaps in the feature grid, and bun as a JSX runner ([#97](https://github.com/sidorares/react-x11/issues/97)) ([4445a56](https://github.com/sidorares/react-x11/commit/4445a562c8d476b63ab81fac5913bc5592f03af0))
* **scripts:** read pixels back as RGBA, which is what ntk now hands over ([#177](https://github.com/sidorares/react-x11/issues/177)) ([a925745](https://github.com/sidorares/react-x11/commit/a925745f42ad1fa658531904aecc9f371b313b58))
* scrollbars can be dragged with the pointer ([#73](https://github.com/sidorares/react-x11/issues/73)) ([fcc95fd](https://github.com/sidorares/react-x11/commit/fcc95fda09580c0ffd76505fe27c7299ad744c6c))
* **select:** a menu long enough to scroll swallowed every click ([#225](https://github.com/sidorares/react-x11/issues/225)) ([f6d9b28](https://github.com/sidorares/react-x11/commit/f6d9b281c7942bfef6c50045a6e793ba64fc3ea5))
* size a Select's menu to its longest option, not the selected one ([#109](https://github.com/sidorares/react-x11/issues/109)) ([249e6dd](https://github.com/sidorares/react-x11/commit/249e6dde2baa8cc9d66dd3f2d8340c69d1013fdd))
* stop passing DevTools a config it throws away ([#134](https://github.com/sidorares/react-x11/issues/134)) ([bcd1637](https://github.com/sidorares/react-x11/commit/bcd16379ec6d4dfce525751749099f74d7052ad9)), closes [#121](https://github.com/sidorares/react-x11/issues/121)
* straight alpha for GL and colour interpolation ([#101](https://github.com/sidorares/react-x11/issues/101)) ([b90596c](https://github.com/sidorares/react-x11/commit/b90596c684f3972df11fc4dceab20d7d6888cabb))
* **text:** re-measure when a text style prop changes ([#222](https://github.com/sidorares/react-x11/issues/222)) ([2846e99](https://github.com/sidorares/react-x11/commit/2846e99d898b1fbbe3066932c149aba966e09b05))
* transitions start from now, not from the last frame drawn ([#80](https://github.com/sidorares/react-x11/issues/80)) ([7b9b5de](https://github.com/sidorares/react-x11/commit/7b9b5de57fc008bb73cd9e0e8862d9e02ef83bb4))
* **windows:** a move is not a resize ([#183](https://github.com/sidorares/react-x11/issues/183)) ([b5205ef](https://github.com/sidorares/react-x11/commit/b5205efe346a16a6be61c91a3597300464fe77ca))
* **windows:** keep event props out of ntk's creation attributes ([#196](https://github.com/sidorares/react-x11/issues/196)) ([d72310c](https://github.com/sidorares/react-x11/commit/d72310ccfa307f02764693da136840d69539cd0b))


### Performance Improvements

* bound React updates to the nodes that actually changed ([#102](https://github.com/sidorares/react-x11/issues/102)) ([d3421d8](https://github.com/sidorares/react-x11/commit/d3421d894e252328658c35aad02688f88a9683a1))
* **boxes:** ride ntk 6.7.0's corner-glyph fast path, and see when a box misses it ([#220](https://github.com/sidorares/react-x11/issues/220)) ([091a8e5](https://github.com/sidorares/react-x11/commit/091a8e5df6aecee4a54f136b507b92521a221338))
* cache rendered &lt;svg&gt; and &lt;tex&gt; content, keyed on what is drawn ([#157](https://github.com/sidorares/react-x11/issues/157)) ([d5257ce](https://github.com/sidorares/react-x11/commit/d5257ce1a8a1b8f643f34753146cf5569ceba337))
* **events:** stop allocating per node per event on the pointer path ([#188](https://github.com/sidorares/react-x11/issues/188)) ([#194](https://github.com/sidorares/react-x11/issues/194)) ([ecc08c4](https://github.com/sidorares/react-x11/commit/ecc08c4ccd2f751b248e57877bf18f9d2a3ef11e))
* paint a region, not the box around it ([#106](https://github.com/sidorares/react-x11/issues/106)) ([66b951b](https://github.com/sidorares/react-x11/commit/66b951b6a73c616512d5c8a88359b8749864512a))
* **paint:** bound layout damage to what moved ([#186](https://github.com/sidorares/react-x11/issues/186)) ([#191](https://github.com/sidorares/react-x11/issues/191)) ([4ff8e7d](https://github.com/sidorares/react-x11/commit/4ff8e7dec717070bec704a0486a918cb0bdcd65e))
* **paint:** bound the invalidate sites that already know their rect ([#187](https://github.com/sidorares/react-x11/issues/187)) ([#193](https://github.com/sidorares/react-x11/issues/193)) ([3f1891b](https://github.com/sidorares/react-x11/commit/3f1891bdf1d083484d4866431981cca640e0b3fa))
* repaint only the region that changed ([#100](https://github.com/sidorares/react-x11/issues/100)) ([35ed595](https://github.com/sidorares/react-x11/commit/35ed595c4053b104e747a249fb7fcc8687e72f1c))
* scroll a viewport by blitting the surviving band, repainting only the exposed strip ([#139](https://github.com/sidorares/react-x11/issues/139)) ([d4786f1](https://github.com/sidorares/react-x11/commit/d4786f121c48ca262d608ad78beb9fd1f16a6c70))
* **windows:** only ask where the window is when it actually moved ([#195](https://github.com/sidorares/react-x11/issues/195)) ([b844736](https://github.com/sidorares/react-x11/commit/b844736a8b20a64ec79289859948d4747f74f4b8))

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
