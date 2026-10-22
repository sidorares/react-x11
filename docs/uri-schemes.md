# Custom URI schemes and single instances

Being the app that `com.example.myapp://…` opens: a link clicked in a browser,
a chat message or a launcher reaches the **already-running** app, and its
window comes to the front.

The flow this exists for is logging in through the browser. The app opens the
system browser, the provider redirects to
`com.example.myapp://auth?code=…`, the desktop routes that URI back, and the
app finishes the login without asking anyone to paste anything.

## Read this first: for a login, you probably want a loopback port

RFC 8252 §7.3 has a second answer that needs none of the machinery below —
redirect to `http://127.0.0.1:<port>/cb` and listen on it:

```js
import { createServer } from 'node:http';

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.end('You can close this tab.');
  finishLogin(url.searchParams.get('code'));
});
server.listen(0); // "Authorization servers MUST allow any port" — RFC 8252 §7.3
const port = server.address().port;
```

No desktop registration, no D-Bus, no install step, and it works on XQuartz,
in a container and over ssh where a scheme handler does not. **For an OAuth
flow, make this the default and use the rest of this page only when you
cannot.**

Custom schemes are still needed for providers that only accept a registered
private-use scheme, and for deep links that are not logins
(`myapp://project/42` from a chat message, a document opened from a launcher).

## Four things have to be true

|                  |                                                            | where                   |
| ---------------- | ---------------------------------------------------------- | ----------------------- |
| **Registration** | a `.desktop` entry claiming `x-scheme-handler/…`           | an install step         |
| **Dispatch**     | the URI reaching the running process                       | `registerApplication()` |
| **Delivery**     | `org.freedesktop.Application.Open`, answered before the UI | `useAppOpen()`          |
| **The raise**    | `_NET_ACTIVE_WINDOW`, with the right timestamp             | `activateWindow()`      |

The raise is the one that decides whether a user calls the feature working;
see [the raise is the part that fails](#the-raise-is-the-part-that-fails).

## The code

```js
import { createRoot, registerApplication } from 'react-x11';

const app = await registerApplication({
  appId: 'com.example.myapp',
  schemes: ['com.example.myapp'],
});
if (app?.role === 'secondary') process.exit(0); // we do not exit for you

const root = await createRoot();
root.render(<App />);
```

```jsx
import { activateWindow, useAppOpen } from 'react-x11';

function App() {
  const win = useRef(null);
  useAppOpen((uris, ctx) => {
    activateWindow(win, { timestamp: ctx.timestamp });
    const code = new URL(uris[0]).searchParams.get('code');
    finishLogin(code);
  });
  return <window ref={win}>…</window>;
}
```

That is the whole runtime half.

### `registerApplication()`

```ts
function registerApplication(options: {
  appId: string;
  schemes?: string[];
  onOpen?: (uris: string[], ctx: LaunchContext) => void;
  onActivate?: (ctx: LaunchContext) => void;
  onAction?: (name: string, params: unknown[], ctx: LaunchContext) => void;
  argv?: string[];
}): Promise<AppRegistration | null>;

interface AppRegistration {
  readonly role: 'primary' | 'secondary';
  readonly appId: string;
  readonly objectPath: string;
  release(): Promise<void>;
}
```

**Call it before `createRoot()`.** On the D-Bus path the bus _started this
process_ because someone called `Open`, and that call is outstanding while the
app boots — registering from inside a component answers it with an
unknown-method error, and the launch is lost.

**`appId` is not a free parameter.** The desktop entry spec ties the
well-known bus name, the `.desktop` file's basename and (RFC 8252 §7.1) the URI
scheme to one string. The object path is derived from it: dots become slashes,
a slash goes on the front, and **a dash becomes an underscore**
(`com.example.my-app` is served at `/com/example/my_app`).

**`null` means there is no session bus** — ssh, a bare `startx`, a container,
CI, Node 20 without the transport. The app runs as an ordinary single-window
program. A URI that arrived in `argv` is still delivered to `useAppOpen`: a
cold-start deep link needs no bus, only a second instance does.

**A malformed `appId` or an unusable scheme throws**, which is not a hole in
[the never-throws rule](dbus.md#the-rule-everything-else-is-subordinate-to):
`null` means "this machine has no bus", and a typo must not hide behind it.

### Two dispatch paths, and why `role` exists

Openers that honour `DBusActivatable=true` (GIO: `gio open`, most of GNOME)
call `Open` on the running app. `xdg-open`'s generic fallback — which Chromium
uses, and which every WM-only session gets — ignores it and runs the `Exec`
line, so **a second copy of your app is spawned with the URI in `argv`**.
`registerApplication` handles both: the second copy forwards the URI to the
first and reports its role.

| `role`        |                                                                    |
| ------------- | ------------------------------------------------------------------ |
| `'primary'`   | this process owns the name and will receive `Open`                 |
| `'secondary'` | another instance owns it; this launch was forwarded — **exit now** |

It does not call `process.exit()` for you; exiting is the app's decision.

A second launch with **no** URI forwards `Activate` rather than an empty
`Open`, so "the user started the app again" and "the user clicked a link"
arrive as different events.

### Delivery: buffered, and replayed

`Open` is answered on the turn it arrives — never when the UI is ready. The
URIs are buffered and replayed to the **first handler that attaches**, so an
app whose React tree mounts a second later loses nothing, and an app whose
first frame is slow does not creep towards the caller's 25-second timeout.

Replay happens once. A second subscriber does not get the same login again.

```ts
function useAppOpen(
  handler: (uris: string[], ctx: LaunchContext) => void,
): void;
function useAppActivate(handler: (ctx: LaunchContext) => void): void;

// the same two, for code that has no component to hang off
function onAppOpen(handler): () => void;
function onAppActivate(handler): () => void;

interface LaunchContext {
  readonly platformData: Readonly<Record<string, unknown>>;
  readonly timestamp: number | null;
  readonly startupId: string | null;
  readonly activationToken: string | null;
}
```

There is **nothing to wrap** — no provider, no prop drilling. The registration
is process-global, so a component library can call these hooks.

`schemes` filters what arrives: a URI whose scheme you did not register is
dropped before your handler sees it. `file:` is always allowed alongside them,
because `Open` is also how a file manager says "open this document with you".
Declaring no schemes at all filters nothing.

### The raise is the part that fails

```ts
function activateWindow(
  target?: NtkWindow | DrawnNode | RefObject<…> | number | null,
  options?: { timestamp?: number | null; source?: 1 | 2 },
): boolean;
```

Sends `_NET_ACTIVE_WINDOW` to the root window: source indication, timestamp,
and this app's currently active toplevel. `target` is anything
[`windowIdOf()`](elements.md) accepts, or nothing — in which case this app's
only top-level window is used, its focused one when it has several.

**The timestamp is the whole feature.** A window manager's focus-stealing
prevention weighs the X timestamp of the user action that triggered the launch
(the digits after `_TIME` in the startup id). Get it wrong and nothing reports
an error: the app receives the code, the WM declines to raise it, and the
taskbar entry blinks.

| `timestamp`     |                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| omitted         | the last input this app saw — EWMH's own definition of the field                                              |
| `ctx.timestamp` | **what a deep link should pass**: the click in the browser is the user action, not whatever this app last saw |
| `null`          | `CurrentTime`; legal, and most window managers will decline it                                                |

The return value is whether the request was **issued**, not whether it worked:
the window manager may refuse and set `_NET_WM_STATE_DEMANDS_ATTENTION`
instead (the blinking taskbar entry), and no client can tell.

## Registration: the half that is not runtime code

react-x11 does **not** write into `~/.local/share` for you (that would not
work for a system-installed or Flatpak app anyway). Ship these from your
installer, your package, or a setup command your users run.

`~/.local/share/applications/com.example.myapp.desktop` — the basename is tied
to the bus name by the spec:

```ini
[Desktop Entry]
Type=Application
Name=My App
Exec=my-app %u
Icon=com.example.myapp
DBusActivatable=true
StartupWMClass=com.example.myapp
MimeType=x-scheme-handler/com.example.myapp;
```

`StartupWMClass` must match the `appId` prop on your `<window>`, or the
window manager cannot match the window that appears to the launch that asked
for it.

Then tell the MIME database it changed:

```bash
update-desktop-database ~/.local/share/applications
```

And, so that the bus can _start_ the app when it is not running,
`~/.local/share/dbus-1/services/com.example.myapp.service`:

```ini
[D-BUS Service]
Name=com.example.myapp
Exec=/usr/bin/my-app
```

### Checking it by hand

```bash
gio open com.example.myapp://test              # path A: D-Bus activation
```

```bash
env -u XDG_CURRENT_DESKTOP xdg-open com.example.myapp://test   # path B: Exec %u
```

Run each twice: once with the app closed (it should start and handle the link)
and once with it running (it should come to the front, and no second window
should appear). `REACT_X11_DEBUG_URI=1` narrates what this module decided —
with every URI's query and fragment stripped, so the output is safe to paste
into an issue.

## Security

The URI is attacker-controlled input from an unauthenticated local caller.

- **Scheme squatting is unfixable and expected.** Nothing in the MIME database
  enforces uniqueness; the last handler to register wins. RFC 8252 §6 requires
  PKCE for public native clients — **use it**, and do not treat receiving a
  code as proof of anything. The reverse-domain naming rule (why `appId` is
  validated) is the other half of the mitigation.
- **`Open` is callable by any peer on the session bus.** It is not an
  authenticated entry point: the bus is a per-user socket, not an
  authorization check. Validate what you receive, and never turn a URI's path
  into a filesystem path.
- **`platform_data` is spoofable.** A hostile local process can fabricate a
  `desktop-startup-id` and make your app raise itself. Same uid, so it is focus
  theft rather than data loss — but treat `ctx.timestamp` as a hint, not a
  credential.
- **On the `xdg-open` path the URI lands in `argv`**, so a code is briefly
  visible in `/proc/<pid>/cmdline` to processes of the same user. The D-Bus
  path does not have this property; loopback avoids it too.
- **Never log the URI.** react-x11 does not: everything on
  `REACT_X11_DEBUG_URI` goes through a redaction that drops the query, the
  fragment and any userinfo. Hold your own logging to the same rule — the code
  is _in_ the URI.

## On macOS

The same hooks, a different transport. On the cocoa backend the OS talks to
the application through **Apple Events**, which `@windowkit/appkit` (≥ 0.5)
forwards into the same delivery as a D-Bus `Open`:

|                                                    |                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `kAEGetURL` — a URL for a scheme the bundle claims | `useAppOpen(uris, ctx)`, filtered by the registration's `schemes` like an `Open`                                    |
| `kAEOpenDocuments` — a document from the Finder    | `useAppOpen`, as `file://` URLs (`file:` is always allowed)                                                         |
| `kAEReopenApplication` — a Dock click, `open -a`   | `useAppActivate(ctx)`, with `ctx.platformData['has-visible-windows']`                                               |
| `kAEQuitApplication` — Dock › Quit, ⌘Q, a logout   | the **primary window's close request**: `onCloseRequest` where there is one, else the default, which closes the app |

Three things differ from the bus, and none of them changes app code:

- **Single instance is the platform default.** Launch Services activates the
  running app rather than starting a second one, so there is no `secondary`
  role to exit from; `registerApplication()` resolves `null` on a Mac with no
  D-Bus (the normal Mac) and its `schemes` still filter what arrives.
- **`ctx.timestamp` is `null`.** Apple Events carry no startup id, and the
  raise does not need one: `activateWindow()` there is `NSApp.activate`, which
  no focus-stealing rule weighs.
- **Registration is `Info.plist`, not a `.desktop` file** — `CFBundleURLTypes`
  for the scheme and `CFBundleDocumentTypes` for documents, in an app bundle
  (see [packaging.md](packaging.md)). A bare `node` process receives nothing
  from Launch Services, because there is no bundle for it to look up.

A quit becomes the same close request the red light sends to the app's primary
window: an `onCloseRequest` that opens a "save your work?" dialog has vetoed it
until it decides, and one that unmounts has accepted it. Once the app has
closed on a quit, the process ends
(`createRoot({ cocoa: { exitOnQuit: false } })` turns that off for an embedder
that owns the process). One limit: a **logout** is cancelled by macOS the
moment it asks, and the app then quits on its own — the logout has to be
started again.

## Over ssh

Both mechanisms only work when the browser runs on the **same host as the
app**. A URL pasted into your laptop's browser reaches neither a loopback port
nor a scheme handler on the server you are `ssh -X`'d into.

## Deliberately not here

- **Desktop actions** (jump-list entries): `ActivateAction` replies correctly
  and `onAction` receives it; nothing more.
- **Writing `.desktop` files** — your installer's job (see above).
- **A full OAuth client** — no PKCE implementation or token store.
- **`http`/`https` handling** — being the default browser is not this.
- **The launcher's Wayland `xdg-activation` token** is exposed on
  `ctx.activationToken` and otherwise ignored; on the
  [Wayland backend](wayland-backend.md) `activateWindow()` requests a token of
  its own.

Design notes: [design/uri-schemes.md](../design/uri-schemes.md).
