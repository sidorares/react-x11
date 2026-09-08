# Packaging and distribution

Five ways to ship a react-x11 app, cheapest first. Every recipe here was
run — except the two that need a signing identity, which say so — and
where something does not work, the reason is measured rather than
guessed.

| tier                            | works                      | cost                            |
| ------------------------------- | -------------------------- | ------------------------------- |
| 1. plain `npm install`          | yes                        | a `node_modules` on the target  |
| 2. a single `.mjs`              | yes, with one esbuild flag | one file, ~7 MB                 |
| 3. Node single executable (SEA) | yes, as CommonJS           | one file, ~142 MB               |
| 4. AppImage / `.deb`            | yes, wrapping tier 1 or 2  | packaging metadata              |
| 5. a macOS `.app`               | yes, wrapping tier 2 or 3  | a plist, and a signing identity |

## Tier 1 — `npm install`

The default, and fine for a server-side app, a CI tool, or anything already
deployed with a package manager. Nothing to say beyond: the package is ESM
(`"type": "module"`), it needs Node ≥ 22, and it has **no native
dependencies** — ntk, node-x11 and yoga-layout are pure JavaScript and WASM,
so there is no node-gyp, no prebuild matrix, and `npm install` on a fresh
box just works.

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
Nothing in this stack forces the issue — ntk has had no top-level await
since 5, and the layout engine, which was the other source of one, is loaded
rather than imported here (below). See
[tier 3](#tier-3--node-single-executable), which needs `cjs`; the choice is
only about what your own code does at module scope.

**The `--banner:js` is not optional.** node-x11 is CommonJS and uses dynamic
`require`, which esbuild cannot resolve statically. Without the banner the
bundle builds cleanly and then dies at startup:

```
Error: Dynamic require of "events" is not supported
```

The banner defines the `require` that shim calls. This is an upstream gap —
node-x11 wants an ESM entry point, or `node:`-prefixed requires — and until
it closes, the banner is the fix.

**The banner's import must be aliased.** The obvious form, `import
{createRequire} from 'node:module'`, collides with react-x11's own import of
the same name and the bundle fails to parse with `Identifier 'createRequire'
has already been declared`. Hence `as __cjsRequire` above. That one costs an
afternoon if you meet it without warning.

Two things that are _not_ problems, and are worth knowing because they
usually are:

- **yoga-layout is bundler-safe.** Its WASM is base64-inlined into the
  JavaScript, so nothing is emitted beside the bundle and nothing needs a
  loader rule or a copy step. Verified: no `.wasm` file appears, and the
  bundle renders.
- **`keysym` is gone.** It used to read a JSON file off disk at module load
  and broke every bundle; ntk 4.3.0 no longer depends on it. If you are
  reading an older account of this, that half is fixed.

Verified end to end: bundling an app that imports `react-x11`, `react` and
node-x11's in-process X server produces a 7 MB `app.mjs` that mounts a tree,
paints, and reads its own pixels back.

If you use react-x11's [DevTools](devtools.md) or
[click-to-component](click-to-component.md) integrations, note that they are
dynamically imported behind environment variables. A bundler will pull in
`ws` and `node:child_process` for them; if you do not want that, stub them
out with a resolver plugin the way
`website/scripts/build-demo-bundles.mjs` does.

## Tier 3 — Node single executable

```sh
esbuild app.jsx --bundle --platform=node --format=cjs --outfile=app.cjs
node --build-sea=sea.json          # { "main": "app.cjs", "output": "myapp" }
./myapp
```

```json
{ "main": "app.cjs", "output": "myapp", "disableExperimentalSEAWarning": true }
```

This did not work until recently, and the reason is worth keeping: Node's SEA
evaluates the embedded main as **CommonJS** — there is no `package.json`
inside the blob for it to consult, and the `.mjs` name has no effect on an
embedded script — while the stack forced ESM, because esbuild will not emit
CommonJS for a graph containing top-level await. The await came from the
layout engine: `yoga-layout`'s default entry is
`const Yoga = wrapAssembly(await loadYoga())`, and every app inherited it.
`src/yoga.js` loads the engine through `yoga-layout/load` instead — enums
synchronously, WebAssembly during `createRoot()` — and react-x11 moved its
own three `await import()`s for DevTools, click-to-component and tracing out
of module scope. Nothing in the graph has a top-level await now, and
`test/yoga.test.js` fails the build if an import puts one back.

Verified: a bundle of react-x11, react, ntk and node-x11's in-process X
server mounts a 40-row tree and paints it — 157 requests in 7 socket writes —
from a single 142 MB file, most of which is node itself.

What the CommonJS format costs you, in your own code:

- **No top-level `await`.** Put startup in an `async function main()`;
  `const root = await createRoot()` at the top level of your entry is enough
  to fail the build. esbuild names the file and line, so this is a
  five-second fix rather than a mystery.
- **`import.meta.url` is `undefined`.** Anything resolving paths through it
  needs `process.execPath` or a literal. react-x11 guards its own uses on
  the X11 path (the version string DevTools shows falls back rather than
  throwing) but not yet on the cocoa one: `src/cocoa/native.js` calls
  `createRequire(import.meta.url)` when that backend loads, and
  `createRequire(undefined)` throws `ERR_INVALID_ARG_VALUE`. Until that is
  fixed in code, `--define:import.meta.url='"file:///dev/null"'` at build
  time is the workaround ([tier 5](#developer-id-or-the-app-store) has the
  whole recipe); check your app for the same pattern.
- **Runtime module loading is out.** Inside a SEA, `require()` _and_
  `import()` resolve **built-in modules only** — a `data:` or `file:` URL
  import fails with `ERR_UNKNOWN_BUILTIN_MODULE`. A bundle has nothing left
  to resolve, so this only bites if you meant to load something later. It
  also closes the obvious workaround for the old ESM problem: you cannot
  carry an ESM bundle as a SEA asset and import it.
- **Assets are not files.** `sea.getAsset()` reads what the config's
  `assets` map embedded; fonts are the usual case, and `StaticFontSource`
  takes bytes directly ([ntk's fonts guide][ntk-fonts]).

On macOS the binary must be re-signed before it runs
(`codesign --remove-signature myapp && codesign --sign - myapp`); on Linux
nothing extra. Measured on Node 26.

[ntk-fonts]: https://github.com/sidorares/ntk/blob/master/docs/fonts.md

## Tier 4 — AppImage, `.deb`, `.rpm`

These wrap tier 1 or tier 2; the packaging is the desktop-integration
metadata rather than anything about JavaScript.

- A **`.desktop` file** — without one, the app has no launcher entry, no
  icon in the dock, and no association with its own windows. Its `StartupWMClass`
  must match the `wmClass` prop on your `<window>`
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
way — which is why this section is short rather than absent.

## Tier 5 — a macOS `.app`

The cocoa backend's counterpart to tier 4, and the same shape: a wrapper
around tier 2 or tier 3 whose content is metadata. It matters more than it
looks, because several integrations are not features you enable but things
macOS grants **a bundle** and refuses a loose executable — the notification
centre first among them ([notifications.md](notifications.md)).

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
resolved from the running executable's own path, so the bundle the system
sees would be node's location, not yours. Copy the binary in (or ship a tier
3 SEA, which is one file and wants to live there anyway).

What the bundle changes, measured with the same script run both ways:

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
(`notificationsNotAllowed`) — the prompt never appears, the status stays
`notDetermined`, and `usernotificationsd` logs nothing at all, so the system
never registered the app as a notification client. Measured here as not the
cause: registering with `lsregister -f`, launching through `open -a` instead
of exec'ing the binary, `activationPolicy: 'regular'` with a real window on
screen, and re-signing with the hardened runtime and node's own entitlements.
None of them move it.

The remaining variable is the identity itself — a real Apple Development or
Developer ID certificate, which a free Apple ID gets you through Xcode:

```sh
security find-identity -v -p codesigning        # pick one
codesign --force --sign "Apple Development: you@example.com (TEAMID)" $APP
```

That is the documented requirement and the untested one, because the machine
this page was measured on has no signing identity. If you have a certificate
and it still refuses, that is worth an issue rather than a workaround.

Until then the ladder does the right thing on its own: `notify()` falls
through to `osascript`, which delivers real banners attributed to Script
Editor, and `useNotifier().backend` says `osascript` so an app can tell the
difference ([notifications.md](notifications.md)). Nothing else about the
bundle depends on the certificate.

### Developer ID, or the App Store

Past the ad-hoc signature there are two ways out of the building, and they
want different runtimes. Measured 2026-09-08 on macOS 15.2 with bun 1.4.0
and node 26. The machine has no signing identity, so the line through this
section is the ad-hoc one: everything on the near side of it was run, and
everything past it is Apple's documentation, marked as such.

|                  | Developer ID — a download                          | Mac App Store                                        |
| ---------------- | -------------------------------------------------- | ---------------------------------------------------- |
| App Sandbox      | optional                                           | required                                             |
| hardened runtime | required, by notarization                          | not required                                         |
| runtime          | node or bun                                        | node — bun does not start under the sandbox          |
| shape            | this tier around tier 2 or 3, or bun's `--compile` | tier 3: a SEA, an executable that takes no arguments |
| identity         | Developer ID Application                           | Apple Distribution, plus an installer identity       |
| then             | `notarytool`, `stapler`                            | `productbuild`, Transporter                          |

**The sandbox is where bun stops.** Apple's App Sandbox page: "To
distribute a macOS app through the Mac App Store, you must enable the App
Sandbox capability" — one entitlement, `com.apple.security.app-sandbox`.
The form example's bundle, as `make-app.sh` builds it with
`bun build --compile` and re-signed with only that entitlement, crashes at
launch every time:

- **the bare binary**, outside any bundle: `SIGTRAP` in
  `_libsecinit_appsandbox`, the libSystem initializer that applies the
  sandbox — before a line of JavaScript runs;
- **inside the bundle**: `SIGABRT` in HIServices' `_RegisterApplication`,
  under `-[NSApplication init]`, after the kernel logs
  `Sandbox: Guestbook deny(1) mach-lookup com.apple.coreservices.launchservicesd`.

Measured not to be the cause: how it is launched (exec'd from a shell, in
the foreground under a watchdog, or by `open`), the plist (the example's
and a minimal one), and where the bundle sits. Upstream:
[oven-sh/bun#15661][bun-15661], "Cannot run Bun within macOS sandbox", open
since December 2024 — its "status code 5" is this SIGTRAP.

The same example, sandboxed with the same entitlement and the same ad-hoc
signature, runs as node: as an esbuild `.mjs` (tier 2) under a copied
`node` binary, and as a `node --build-sea` executable (tier 3). Both stayed
up with the window on screen and logged no `Sandbox: … deny` line at all;
the SEA, launched by `open`, registers with Launch Services as itself and
gets its container:

```
$ open SeaGuestbook.app
"LSDisplayName"="SeaGuestbook"
"CFBundleIdentifier"="com.example.seaguestbook"
container: ~/Library/Containers/com.example.seaguestbook
```

The control: a five-line Swift AppKit app (`NSApplication.shared`, print
the container id), ad-hoc-signed with the same entitlement, runs and
reports its container. So an ad-hoc signature plus the entitlement is a
valid local sandbox test, and no certificate is needed for this part.

**The SEA is the store shape.** Launch Services starts a bundle's
executable with no arguments, so a copied `node` has nothing to run; the
SEA carries its main. (The sandbox also moves the working directory into
the container — `ProbeNode probe.mjs` with a relative path failed with
`MODULE_NOT_FOUND` at `~/Library/Containers/…/Data/probe.mjs`, an absolute
one ran — and a SEA has no path to get wrong.) Its build is tier 3's, with
two esbuild defines that the form example needs today:

```sh
esbuild sea-main.js --bundle --platform=node --format=cjs --jsx=automatic --outfile=app.cjs \
  --define:process.env.REACT_X11_NO_AUTORUN='"1"' \
  --define:import.meta.url='"file:///dev/null"'
node --build-sea sea.json   # { "main": "app.cjs", "output": "Guestbook", "disableExperimentalSEAWarning": true }
```

- **`REACT_X11_NO_AUTORUN`.** `index.jsx` mounts itself under that guard
  with a top-level `await createRoot()`, which `cjs` cannot express;
  without the define esbuild stops at
  `Top-level await is currently not supported with the "cjs" output format`.
  Defined, the guard is a constant and the branch is dropped at build
  time; the entry mounts `App` itself, in an async function:

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

- **`import.meta.url`.** esbuild's `cjs` output leaves `import.meta`
  empty, and `src/cocoa/native.js` calls `createRequire(import.meta.url)`
  when the cocoa backend loads — `createRequire(undefined)` throws
  `ERR_INVALID_ARG_VALUE`. Any string URL satisfies it; the addon is then
  found through `REACT_X11_CALAYERS_PATH`, an absolute path, so the base
  is never used. Fixing that in react-x11 is a separate task; once it
  lands, drop this define.

The bundle is then tier 5's — the plist, the SEA at
`Contents/MacOS/Guestbook`, `calayers.node` in `Contents/Resources` — and
the signature is two commands, in this order:

```sh
codesign --force --sign - Guestbook.app/Contents/Resources/calayers.node
codesign --force --sign - --entitlements sandbox.plist Guestbook.app
open Guestbook.app
```

where `sandbox.plist` holds the one key. That is what ran.

**Sign inside-out, and never `--deep`.** Apple DTS, in "Signing a Mac
Product For Distribution" and "Creating distribution-signed code for Mac"
([forums 128166][dts-128166], [701514][dts-701514]): "Do not use the
`--deep` argument … it will cause problems when signing a complex
program". Sign each code item separately, dependencies first — the addon
before the app, because the app's signature seals the addon's — and put
entitlements on the main executable only: "Do not apply entitlements to
library code. It doesn't do anything useful and can prevent your code from
running." `--deep` applies one set of options to every item, which is the
wrong thing the moment the app has entitlements and the addon must not.

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
`com.apple.security.get-task-allow` — a debugging entitlement, and the
`node` you copy from a release carries it (`codesign -d --entitlements -`
on node 26 lists all six). Never ship it; a re-sign replaces node's
entitlements wholesale, so it only ever appears if your plist names it.

What the hardened runtime needs was measured with an ad-hoc signature and
`--options runtime`, which is the real thing: a copied `node` signed with
no entitlements aborts at startup —
`Fatal process out of memory: Failed to reserve virtual memory for CodeRange`,
V8 unable to map executable memory — and runs with `allow-jit` alone; a
`bun build --compile` binary ran with none, with `allow-jit` alone, and
with all five (whether its JIT was on was not measured). So `allow-jit` is
the load-bearing one for node, and the other four are what upstream
ships, not what this page found necessary. The Developer ID identity,
`notarytool` and `stapler` were not run: the machine has none.

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
runtime, and Apple's "Porting just-in-time compilers to Apple silicon" is
explicit that `allow-jit` "is required only when an app adopts the
Hardened Runtime capability". `Contents/embedded.provisionprofile` is
needed only for restricted entitlements (iCloud, push, app groups) or
TestFlight. The ad-hoc half of this — the sandboxed SEA bundle, launched
by `open`, registered, contained, zero denials — is what was measured; the
identity, `productbuild --sign` and the upload are Apple's documentation.

[bun-15661]: https://github.com/oven-sh/bun/issues/15661
[dts-128166]: https://developer.apple.com/forums/thread/128166
[dts-701514]: https://developer.apple.com/forums/thread/701514
[bun-codesign]: https://bun.com/docs/bundler/executables#code-signing-on-macos
[node-entitlements]: https://github.com/nodejs/node/blob/main/tools/osx-entitlements.plist

## Checklist

- Pick the format deliberately: `--format=esm` (tier 2, needs the banner) or
  `--format=cjs` (tier 3, needs no top-level await in your own code).
- With `esm`, alias the banner's `createRequire`.
- Do not ship `.Xauthority`, and do not bake `DISPLAY` into an image —
  [security.md](security.md).
- Set `wmClass` and match it in `StartupWMClass`.
- On macOS, ship a `.app` (tier 5) rather than a bare executable, and sign it
  with a real identity if you want the notification centre.
- For the Mac App Store, build tier 3 — a node SEA — and sandbox it: bun does
  not start under App Sandbox. Developer ID takes either runtime.
- Sign nested code first and the app last, entitlements on the app only, and
  never `--deep`.
- Test on a display you did not develop on. Fonts are the usual surprise:
  family resolution goes through `fc-match`, so `sans-serif` is a different
  face on the target ([remote.md](remote.md#the-other-x-servers), issue #86).

## Upstream

Two things would delete the rest of the friction here:

- **node-x11: ESM sources** ([node-x11#246][x11-246]). That removes tier 2's
  banner, which is now the only real trap on the page. Note the tempting
  cheaper version does not work: `node:`-prefixed requires change nothing,
  because esbuild wraps a CommonJS module either way and its `require` shim
  throws in ESM output regardless of the specifier — measured, not assumed.
- **bun: App Sandbox** ([oven-sh/bun#15661][bun-15661]). Until a
  `bun build --compile` binary can start sandboxed, a Mac App Store build is
  node's SEA and bun is a Developer ID runtime only.

ESM support for a SEA's embedded main would be welcome in Node, but it is no
longer load-bearing: tier 3 works as CommonJS. What is load-bearing, and
local: `src/cocoa/native.js`'s `createRequire(import.meta.url)`, which a SEA
cannot evaluate — the second define in tier 5 until it is fixed.

[x11-246]: https://github.com/sidorares/node-x11/issues/246
