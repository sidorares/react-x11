# Changelog

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
