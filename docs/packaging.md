# Packaging and distribution

Five ways to ship a react-x11 app, cheapest first. Every recipe here was
run, except the signing steps that need a real identity, which say so.

| tier                            | works                      | cost                            |
| ------------------------------- | -------------------------- | ------------------------------- |
| 1. plain `npm install`          | yes                        | a `node_modules` on the target  |
| 2. a single `.mjs`              | yes, with one esbuild flag | one file, ~7 MB                 |
| 3. Node single executable (SEA) | yes, as CommonJS           | one file, ~142 MB               |
| 4. AppImage / `.deb`            | yes, wrapping tier 1 or 2  | packaging metadata              |
| 5. a macOS `.app`               | yes, wrapping tier 2 or 3  | a plist, and a signing identity |

## Tier 1 — `npm install`

The default, and fine for a server-side app, a CI tool, or anything already
deployed with a package manager. The package is ESM (`"type": "module"`),
needs Node ≥ 20.19 (`engines` in its `package.json`), and has **no required
native dependencies** — ntk, node-x11 and yoga-layout are pure JavaScript
and WASM, so the X11 backend needs no node-gyp and no prebuild matrix. The
native bridges the other backends drive — `@windowkit/appkit` for Cocoa,
`@windowkit/win32` for win32, `x11-dri` for Wayland's GPU path — are
`optionalDependencies` that install from a bundled prebuild where one
matches the platform, so an install that cannot build one still succeeds.

## Tier 2 — one `.mjs` file

```sh
esbuild app.jsx --bundle --platform=node --format=esm --outfile=app.mjs \
  --banner:js="import{createRequire as __cjsRequire}from'node:module';const require=__cjsRequire(import.meta.url);"

node app.mjs
```

Three things about that command are load-bearing.

**`--format=esm` is the easy path, not the only one.** It tolerates top-level
await anywhere in the graph; `cjs` does not, and refuses to build with
`Top-level await is currently not supported with the "cjs" output format`.
react-x11's own graph has none (the layout engine is loaded during
`createRoot()`, not imported), so the choice is only about what your own
code does at module scope. [Tier 3](#tier-3--node-single-executable) needs
`cjs`.

**The `--banner:js` is not optional.** node-x11 is CommonJS and uses dynamic
`require`, which esbuild cannot resolve statically. Without the banner the
bundle builds cleanly and then dies at startup:

```
Error: Dynamic require of "events" is not supported
```

The banner defines the `require` that esbuild's shim calls; it is needed
until node-x11 ships ESM sources ([node-x11#246][x11-246]).

**The banner's import must be aliased.** The obvious form, `import
{createRequire} from 'node:module'`, collides with react-x11's own import of
the same name and the bundle fails to parse with `Identifier 'createRequire'
has already been declared`. Hence `as __cjsRequire` above.

**yoga-layout is bundler-safe**: its WASM is base64-inlined into the
JavaScript, so nothing is emitted beside the bundle and nothing needs a
loader rule or a copy step.

react-x11's [DevTools](devtools.md) and
[click-to-component](click-to-component.md) integrations are dynamically
imported behind environment variables, so a bundler pulls in `ws` and
`node:child_process` for them; to leave them out, stub them with a resolver
plugin the way `website/scripts/build-demo-bundles.mjs` does.

On macOS the bundle moves onto a worker as it starts, as the source does,
and still needs nothing beside it: the worker's entry is the bundle itself
([below](#on-macos-the-app-moves-onto-a-worker)).

## Tier 3 — Node single executable

```sh
esbuild app.jsx --bundle --platform=node --format=cjs --outfile=app.cjs
node --build-sea=sea.json          # { "main": "app.cjs", "output": "myapp" }
./myapp
```

```json
{ "main": "app.cjs", "output": "myapp", "disableExperimentalSEAWarning": true }
```

Node's SEA evaluates the embedded main as **CommonJS** — there is no
`package.json` inside the blob, and a `.mjs` name has no effect on an
embedded script — so the bundle is `--format=cjs`. Nothing in react-x11's
graph has a top-level await, so that builds. What the CommonJS format costs
you, in your own code:

- **No top-level `await`.** Put startup in an `async function main()`;
  `const root = await createRoot()` at the top level of your entry is enough
  to fail the build. esbuild names the file and line.
- **`import.meta.url` is `undefined`.** Anything resolving paths through it
  needs `process.execPath` or a literal; react-x11 guards its own uses. Two
  features cannot be guarded, because what they resolve has to exist on
  disk, and neither works in a SEA. Each fails when first used rather than
  at startup: `<Frame>` forks a child entry, and a pane hands its `fallback`
  a `spawn`-phase `ERR_INVALID_URL` (and is an empty box without one);
  click-to-component opens your source, and `createRoot()` with
  `REACT_X11_CLICK_TO_COMPONENT` set rejects with `ERR_INVALID_ARG_TYPE`.
- **Runtime module loading is out.** Inside a SEA, the embedded main's
  `require()` _and_ `import()` resolve **built-in modules only** — a `data:`
  or `file:` URL import fails with `ERR_UNKNOWN_BUILTIN_MODULE`. A bundle has
  nothing left to resolve, so this only bites if you meant to load something
  later (an ESM bundle carried as a SEA asset cannot be imported either).
  The one door left open is `createRequire(process.execPath)` from
  `node:module` — a full CommonJS loader rooted at the executable.
- **Assets are not files.** `sea.getAsset()` reads what the config's
  `assets` map embedded; fonts are the usual case, and `StaticFontSource`
  takes bytes directly ([ntk's fonts guide][ntk-fonts]).

On macOS the binary must be re-signed before it runs
(`codesign --remove-signature myapp && codesign --sign - myapp`); on Linux
nothing extra.

**The cocoa backend works in a SEA, with the addon beside the binary.** The
native bridge is a `.node` file the blob cannot carry, so react-x11 loads it
through `createRequire(process.execPath)`, which resolves from the
executable's own directory. Either point `REACT_X11_CALAYERS_PATH` at the
addon (the `@windowkit/appkit` package directory or its `calayers.node`
prebuild, the way `examples/form/main.js` names it inside a compiled
bundle), or ship `node_modules/@windowkit/appkit` next to the executable and
let the bare name resolve. With neither, the error names both attempts.

A SEA runs the cocoa backend in pump mode, on the main thread — its entry
is inside the binary, where a worker cannot load it from — so a menu, a
drag or a live resize stops its JS
([below](#on-macos-the-app-moves-onto-a-worker)).

[ntk-fonts]: https://github.com/sidorares/ntk/blob/master/docs/fonts.md

## Tier 4 — AppImage, `.deb`, `.rpm`

These wrap tier 1 or tier 2; the packaging is the desktop-integration
metadata rather than anything about JavaScript.

- A **`.desktop` file** — without one, the app has no launcher entry, no
  icon in the dock, and no association with its own windows. Its `StartupWMClass`
  must match the `appId` prop on your `<window>`
  ([elements.md](elements.md)), or the desktop groups your window under the
  wrong icon.
- **Icons** at 48, 128 and 256 px under
  `usr/share/icons/hicolor/<size>/apps/`. Set `_NET_WM_ICON` too, which the
  window manager reads for the titlebar and alt-tab; the WM example already
  reads both sources ([AGENTS.md](../AGENTS.md), "Writing a window
  manager").
- **Node itself**, if you are not depending on a system one. That is most of
  the size.

Nothing here is react-x11-specific — any Node desktop app packages the same
way.

## Tier 5 — a macOS `.app`

The cocoa backend's counterpart to tier 4: a wrapper around tier 2 or tier
3 whose content is metadata. Several integrations are things macOS grants
**a bundle** and refuses a loose executable — the notification centre first
among them ([notifications.md](notifications.md)).

```sh
APP=Downloads.app
mkdir -p $APP/Contents/MacOS
cp "$(command -v node)" $APP/Contents/MacOS/Downloads   # a copy, not a script
cat > $APP/Contents/Info.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Downloads</string>
  <key>CFBundleExecutable</key><string>Downloads</string>
  <key>CFBundleIdentifier</key><string>com.example.downloads</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

codesign --force --sign - $APP          # ad-hoc; see the signature note below
$APP/Contents/MacOS/Downloads app.mjs   # or app.cjs from tier 3
```

**The executable must be the real binary, in `Contents/MacOS/`.** A shell
script that execs node from elsewhere does not work: `NSBundle.mainBundle` is
resolved from the running executable's own path. Copy the binary in (or ship
a tier 3 SEA). Which tier the bundle wraps decides where the app's JS runs: a
tier 2 bundle beside the binary moves onto a worker, a SEA stays on the pump
([below](#on-macos-the-app-moves-onto-a-worker)).

What the bundle changes:

|                                           | inside the `.app`       | bare `node`        |
| ----------------------------------------- | ----------------------- | ------------------ |
| `notificationSettings().bundleIdentifier` | `com.example.downloads` | `null`             |
| the notification centre                   | `available: true`       | `available: false` |
| `notificationBackend()`                   | `'cocoa'`               | `'osascript'`      |

Everything that keys off a bundle id follows the first column: the app's own
name in the menu bar rather than "node", a Dock tile that is yours to badge
([desktop.md](desktop.md)), `activationPolicy` meaning something, and URL
schemes and document types you can declare in the same plist and receive as
Apple Events ([uri-schemes.md](uri-schemes.md)).

### The signature is the part that bites

An **ad-hoc signature (`--sign -`) is enough to be a bundle, and not enough to
post a notification.** With one, the centre reports `available: true` and
every authorization request fails with `UNErrorDomain` code 1
(`notificationsNotAllowed`): the prompt never appears and the status stays
`notDetermined`. Registering with `lsregister -f`, launching through
`open -a`, `activationPolicy: 'regular'` and the hardened runtime do not
change that.

The documented requirement is a real Apple Development or Developer ID
certificate, which a free Apple ID gets you through Xcode (not tested here):

```sh
security find-identity -v -p codesigning        # pick one
codesign --force --sign "Apple Development: you@example.com (TEAMID)" $APP
```

Without one, `notify()` falls through to `osascript`, which delivers real
banners attributed to Script Editor, and `useNotifier().backend` says
`osascript` so an app can tell the difference
([notifications.md](notifications.md)). Nothing else about the bundle
depends on the certificate.

### Developer ID, or the App Store

Past the ad-hoc signature there are two ways to distribute, and they want
different runtimes. The sandboxed, ad-hoc-signed half below was run (macOS
15.2, bun 1.4.0, node 26); the steps that need a real identity follow
Apple's documentation and were not run.

|                  | Developer ID — a download                          | Mac App Store                                        |
| ---------------- | -------------------------------------------------- | ---------------------------------------------------- |
| App Sandbox      | optional                                           | required                                             |
| hardened runtime | required, by notarization                          | not required                                         |
| runtime          | node or bun                                        | node — bun does not start under the sandbox          |
| shape            | this tier around tier 2 or 3, or bun's `--compile` | tier 3: a SEA, an executable that takes no arguments |
| identity         | Developer ID Application                           | Apple Distribution, plus an installer identity       |
| then             | `notarytool`, `stapler`                            | `productbuild`, Transporter                          |

**Bun does not start under the App Sandbox**, which the Mac App Store
requires (one entitlement, `com.apple.security.app-sandbox`). A
`bun build --compile` binary signed with it crashes at launch: `SIGTRAP` in
`_libsecinit_appsandbox` before any JavaScript runs, or, inside a bundle,
`SIGABRT` in `_RegisterApplication` after a
`Sandbox: … deny(1) mach-lookup com.apple.coreservices.launchservicesd`
([oven-sh/bun#15661][bun-15661]). The same app as node — a tier 2 `.mjs`
under a copied `node`, or a tier 3 SEA — runs sandboxed. An ad-hoc
signature plus the entitlement is a valid local sandbox test; no
certificate is needed for it.

**The SEA is the store shape.** Launch Services starts a bundle's
executable with no arguments, so a copied `node` has nothing to run; the
SEA carries its main. The sandbox also moves the working directory into the
container (`~/Library/Containers/<bundle id>/Data`), so a relative script
path fails with `MODULE_NOT_FOUND`; a SEA has no path to get wrong. Its
build is tier 3's, with one esbuild define that the form example needs:

```sh
esbuild sea-main.js --bundle --platform=node --format=cjs --jsx=automatic --outfile=app.cjs \
  --define:process.env.REACT_X11_NO_AUTORUN='"1"'
node --build-sea sea.json   # { "main": "app.cjs", "output": "Guestbook", "disableExperimentalSEAWarning": true }
```

`index.jsx` mounts itself under a `REACT_X11_NO_AUTORUN` guard with a
top-level `await createRoot()`, which `cjs` cannot express; defined, the
guard is a constant, the branch is dropped at build time, and the entry
mounts `App` itself, in an async function:

```js
// sea-main.js — main.js's job, as CommonJS
const path = require('node:path');
const contents = path.resolve(path.dirname(process.execPath), '..');
process.env.REACT_X11_CALAYERS_PATH ??= path.join(
  contents,
  'Resources',
  'calayers.node',
);
process.env.REACT_X11_BACKEND ??= 'cocoa';
(async () => {
  const [{ createRoot }, { default: App }, React] = await Promise.all([
    import('react-x11'),
    import('./index.jsx'),
    import('react'),
  ]);
  const root = await createRoot();
  root.render(React.createElement(App));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

The bundle is then tier 5's — the plist, the SEA at
`Contents/MacOS/Guestbook`, `calayers.node` in `Contents/Resources` — and
the signature is two commands, in this order:

```sh
codesign --force --sign - Guestbook.app/Contents/Resources/calayers.node
codesign --force --sign - --entitlements sandbox.plist Guestbook.app
open Guestbook.app
```

where `sandbox.plist` holds the one key.

**Sign inside-out, and never `--deep`** (Apple DTS, [forums
128166][dts-128166], [701514][dts-701514]). Sign each code item separately,
dependencies first — the addon before the app, because the app's signature
seals the addon's — and put entitlements on the main executable only.
`--deep` applies one set of options to every item, which is wrong the moment
the app has entitlements and the addon must not.

**Developer ID — not run.** For a download outside the store, Gatekeeper
wants a Developer ID signature with the hardened runtime, then
notarization:

```sh
ID="Developer ID Application: NAME (TEAMID)"
codesign --force --timestamp --sign "$ID" Guestbook.app/Contents/Resources/calayers.node
codesign --force --timestamp --options runtime --entitlements developer-id.plist \
  --sign "$ID" Guestbook.app
ditto -c -k --keepParent Guestbook.app Guestbook.zip
xcrun notarytool submit Guestbook.zip --keychain-profile notary --wait
xcrun stapler staple Guestbook.app
```

`developer-id.plist` is the upstream list for the runtime you ship. Bun's
"Code signing on macOS" ([the executables guide][bun-codesign]) and Node's
[`tools/osx-entitlements.plist`][node-entitlements] name the same five:
`com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory`,
`disable-executable-page-protection`, `allow-dyld-environment-variables`
and `disable-library-validation`. Node's file has a sixth,
`com.apple.security.get-task-allow` — a debugging entitlement, which the
`node` you copy from a release carries. Never ship it; a re-sign replaces
node's entitlements wholesale, so it only appears if your plist names it.

Under the hardened runtime a copied `node` signed with no entitlements
aborts at startup with
`Fatal process out of memory: Failed to reserve virtual memory for CodeRange`;
`allow-jit` alone is enough for it to run. A `bun build --compile` binary
ran with none. The other four are what upstream ships.

**Mac App Store — not run.** Sign the same bundle, inside-out, with the
store identity, and package it as an installer:

```sh
ID="Apple Distribution: NAME (TEAMID)"
codesign --force --timestamp --sign "$ID" Guestbook.app/Contents/Resources/calayers.node
codesign --force --timestamp --entitlements store.plist --sign "$ID" Guestbook.app
productbuild --sign "3rd Party Mac Developer Installer: NAME (TEAMID)" \
  --component Guestbook.app /Applications Guestbook.pkg
xcrun altool --upload-app -f Guestbook.pkg -t macos --apiKey KEY --apiIssuer ISSUER   # or Transporter
```

`store.plist` is `com.apple.security.app-sandbox` plus what the app
actually needs — `network.client`, `files.user-selected.read-write` — and
none of the hardened-runtime keys: the store does not require the hardened
runtime, and `allow-jit` is needed only under it.
`Contents/embedded.provisionprofile` is needed only for restricted
entitlements (iCloud, push, app groups) or TestFlight.

Design notes — the sandbox crash investigation, what was measured and how:
[design/packaging.md](../design/packaging.md#developer-id-or-the-app-store).

[bun-15661]: https://github.com/oven-sh/bun/issues/15661
[dts-128166]: https://developer.apple.com/forums/thread/128166
[dts-701514]: https://developer.apple.com/forums/thread/701514
[bun-codesign]: https://bun.com/docs/bundler/executables#code-signing-on-macos
[node-entitlements]: https://github.com/nodejs/node/blob/main/tools/osx-entitlements.plist

## On macOS: the app moves onto a worker

On macOS the first import of react-x11 moves the app onto a
`worker_threads` Worker. AppKit keeps the process main thread — the only
thread it lets own a window — and an app whose JS ran there would stop
through every menu, drag, live resize and modal panel
([macos.md](macos.md#js-on-a-worker-a-ui-thread-of-the-bridges-own)). The
worker's entry is your entry itself, run from the top: when react-x11 is
imported the entry has not run a line yet, because its imports finish
before its body does. The main thread then waits, and launches AppKit only
when the app's first cocoa `createRoot` asks for it.

The move costs 25–73 ms of startup and 30–50 MB: the main thread loads the
entry's imports once before the worker loads them again (a tier 2 bundle is
at the low end). An app that imports react-x11 and never makes a cocoa root
— an X11 app on XQuartz, a script — never launches AppKit, and takes
95–131 ms longer to exit. Measurements:
[design/packaging.md](../design/packaging.md#on-macos-the-app-moves-onto-a-worker).

To skip the cost, or the move:

- **Start with the launcher**: `node --import react-x11/cocoa-main app.mjs`,
  or `bun --preload react-x11/cocoa-main app.mjs`. It moves the app before
  the entry is loaded at all, which is faster than the pump and costs only
  the worker. It resolves the installed package, so it is for an app run
  from a checkout or an `npm install` — anywhere you write the command
  line.
- **Stay on the pump** with `REACT_X11_THREADED=0`: the app keeps the main
  thread, and a menu, a drag or a live resize stops its JS again.
- **Import react-x11 first** in the entry. What the entry imports before
  it loads on the main thread as well as on the worker: nothing to notice
  for React, but a module that does work as it loads — opens a port,
  writes a file, logs — does it twice, and one that makes a call only a
  main thread may, `process.chdir()`, throws the second time
  ([macos.md](macos.md#what-changes-for-an-app)).

The move does not happen in a single executable (tier 3, and
`bun build --compile`), whose entry is not a file a worker can load, so it
runs on the pump; in a `<Frame>` pane, whose IPC channel to its host is
the main thread's; under a test runner; with `REACT_X11_THREADED=0` or
`REACT_X11_BACKEND=x11`; when react-x11 is imported after the app has
started running — by an `import()` from a timer, or one the entry awaits —
where the worker would run again what the entry has already done; and on
Node 20 and 22, under an ES module loader. By Node version, measured on
20.20, 22.16, 24.12 and 26.0:

| the app                                                | Node 20, 22 | Node 24 and later |
| ------------------------------------------------------ | ----------- | ----------------- |
| `node app.mjs`, an ES module entry, or a tier 2 bundle | moves       | moves             |
| `node app.cjs`, a CommonJS entry                       | moves       | moves             |
| `tsx app.jsx`, or any `--import` or `--loader`         | stays       | moves             |
| under `--import react-x11/cocoa-main`                  | moves       | moves             |
| importing react-x11 with an `import()`                 | stays       | stays             |

An app under a loader stays on the main thread on Node 20 and 22: tsx, the
likeliest loader, keeps its hooks to the main thread there, and a worker
without them stops on the first `.jsx` or `.ts` file it loads. Any
`--import` or `--loader`, on the command line or in `NODE_OPTIONS`, counts.
The launcher moves such an app all the same, for a loader that does follow
it onto a worker (tsx 4.23 does from Node 22.22.3). On Node 24 and later
tsx follows from tsx 4.21.1 and Node 24.11.1; an older tsx there stops the
app as it starts with `ERR_UNKNOWN_FILE_EXTENSION` — update tsx, or set
`REACT_X11_THREADED=0`. Bun moves an ES module entry and a CommonJS one,
`bun app.mjs` and `bun app.cjs`, and keeps the main thread for an entry
that imports react-x11 with an `import()`; it tells a late import its own
way ([macos.md](macos.md#what-changes-for-an-app)).

## Checklist

- On macOS, choose where the app's JS runs: the default move onto a worker
  costs 25–73 ms of startup, `--import react-x11/cocoa-main` skips it,
  `REACT_X11_THREADED=0` keeps the pump, and a SEA always does, as does an
  app under a loader on Node 20 or 22
  ([above](#on-macos-the-app-moves-onto-a-worker)).
- Pick the format deliberately: `--format=esm` (tier 2, needs the banner) or
  `--format=cjs` (tier 3, needs no top-level await in your own code).
- With `esm`, alias the banner's `createRequire`.
- Do not ship `.Xauthority`, and do not bake `DISPLAY` into an image —
  [security.md](security.md).
- Set `appId` and match it in `StartupWMClass`.
- On macOS, ship a `.app` (tier 5) rather than a bare executable, and sign it
  with a real identity if you want the notification centre.
- For the Mac App Store, build tier 3 — a node SEA — and sandbox it: bun does
  not start under App Sandbox. Developer ID takes either runtime.
- Sign nested code first and the app last, entitlements on the app only, and
  never `--deep`.
- Test on a display you did not develop on. Fonts are the usual surprise:
  family resolution goes through `fc-match`, so `sans-serif` is a different
  face on the target ([remote.md](remote.md#the-other-x-servers)).

[x11-246]: https://github.com/sidorares/node-x11/issues/246
