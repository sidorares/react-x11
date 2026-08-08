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
in a container and over ssh in ways a scheme handler does not. **For an OAuth
flow, make this the default and reach for the rest of this page only when you
cannot.**

Custom schemes still earn their place three ways: providers that only accept a
registered private-use scheme; deep links that are not logins at all
(`myapp://project/42` out of a chat message, a document opened from a
launcher); and the fact that owning a name on the bus is the same machinery
the [global menu](globalmenu.md) and a tray icon need anyway.

## Four things have to be true

|                  |                                                            | where                   |
| ---------------- | ---------------------------------------------------------- | ----------------------- |
| **Registration** | a `.desktop` entry claiming `x-scheme-handler/…`           | an install step         |
| **Dispatch**     | the URI reaching the running process                       | `registerApplication()` |
| **Delivery**     | `org.freedesktop.Application.Open`, answered before the UI | `useAppOpen()`          |
| **The raise**    | `_NET_ACTIVE_WINDOW`, with the right timestamp             | `activateWindow()`      |

The last one is the one that decides whether a user calls the feature working;
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

That is the whole runtime half. What follows is why each line is shaped the
way it is.

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

**`appId` is not a free parameter.** The desktop entry spec ties three things
to one string: the well-known bus name, the `.desktop` file's basename, and —
by RFC 8252 §7.1 — the URI scheme. The object path follows from it too, and is
derived rather than passed: dots become slashes, a slash goes on the front,
and **a dash becomes an underscore**. `com.example.my-app` is served at
`/com/example/my_app`; get that wrong and the desktop calls a path you do not
serve, which looks exactly like nothing happening.

**`null` means there is no session bus** — ssh, a bare `startx`, a container,
CI, Node 20 without the transport. The app runs as an ordinary single-window
program. A URI that arrived in `argv` is still delivered to `useAppOpen`: a
cold-start deep link needs no bus, only a second instance does.

**A malformed `appId` or an unusable scheme throws**, and that is not a hole in
[the never-throws rule](dbus.md#the-rule-everything-else-is-subordinate-to):
`null` means "this machine has no bus", and using it for a typo would hide the
typo on every box without one.

### Two dispatch paths, and why `role` exists

The desktop entry spec makes D-Bus activation sound like the whole story.
`DBusActivatable=true`, and implementations _should_ ignore `Exec` and send a
D-Bus message instead. _Should_ — and the most common opener does not.

- **GIO honours it.** `g_app_info_launch_default_for_uri` calls `Open` on the
  app's well-known name. `gio open`, and most of GNOME, take this path.
- **`xdg-open`'s generic fallback does not.** It resolves the handler with
  `xdg-mime query default`, reads the `Exec` key and runs it;
  `DBusActivatable` is never read on that branch. Chromium shells out to
  `xdg-open`, and `xdg-open` takes the generic branch on every desktop it
  cannot identify — which is every WM-only session, react-x11's own persona.

So on half of all desktops **a second copy of your app is spawned with the URI
in `argv`**, and it has to hand that URI to the first copy and exit. An app
that only exports the interface opens a second window every time.
`registerApplication` does both halves, which is why it answers a role:

| `role`        |                                                                    |
| ------------- | ------------------------------------------------------------------ |
| `'primary'`   | this process owns the name and will receive `Open`                 |
| `'secondary'` | another instance owns it; this launch was forwarded — **exit now** |

It does not call `process.exit()` for you. Exiting is an application decision
and a library that takes it is a library that surprises somebody.

A second launch with **no** URI forwards `Activate` rather than an empty
`Open`: "the user started the app again" and "the user clicked a link" are
different events, and an app that cannot tell them apart cannot answer the
first one properly.

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

There is **nothing to wrap** — no provider, no prop drilling. An application
has one identity on the desktop, so the registration is process-global and a
component library can call these hooks.

`schemes` filters what arrives: a URI whose scheme you did not register is
dropped before your handler sees it. `file:` is always allowed alongside them,
because `Open` is also how a file manager says "open this document with you"
and declaring a custom scheme must not stop your app opening its own files.
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

**The timestamp is the whole feature.** Per the startup-notification protocol
the digits after `_TIME` in a startup id are the X timestamp of the user action
that triggered the launch, and that timestamp is what a window manager's
focus-stealing prevention weighs before letting a window come forward. Get it
wrong and nothing reports an error: the user finishes logging in, the browser
redirects, your app receives the code correctly, the WM declines, and the
taskbar entry blinks. Every layer says it worked.

| `timestamp`     |                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| omitted         | the last input this app saw — EWMH's own definition of the field                                              |
| `ctx.timestamp` | **what a deep link should pass**: the click in the browser is the user action, not whatever this app last saw |
| `null`          | `CurrentTime`; legal, and most window managers will decline it                                                |

The return value is whether the request was **issued**, not whether it worked.
EWMH is explicit that the window manager may refuse and set
`_NET_WM_STATE_DEMANDS_ATTENTION` instead — that is the blinking taskbar entry,
it is the WM's call, and no client can tell the difference from here.

## Registration: the half that is not runtime code

react-x11 does **not** write into `~/.local/share` for you. A library that
edits a user's data directory on import is the kind of thing that surprises
people, and it cannot work for a system-installed or Flatpak app anyway. Ship
these from your installer, your package, or a one-line setup command your users
run.

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

`StartupWMClass` must match the `wmClass` prop on your `<window>`, or the
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

Neither branch below is reachable from `npm test` — the in-process broker has
no service activation and no security policy — so this is the pass that covers
them:

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
  enforces uniqueness; the last handler to register wins. RFC 8252 §7.1 says as
  much, which is why §6 requires PKCE for public native clients — **use it**,
  and do not treat receiving a code as proof of anything. The reverse-domain
  naming rule is the other half of the mitigation, and it is why `appId` is
  validated the way it is.
- **`Open` is callable by any peer on the session bus.** It is not an
  authenticated entry point. The bus is a per-user socket, not an authorization
  check. Validate what you receive, and never turn a URI's path into a
  filesystem path.
- **`platform_data` is spoofable.** A hostile local process can fabricate a
  `desktop-startup-id` and make your app raise itself. Same uid, so it is focus
  theft rather than data loss — but treat `ctx.timestamp` as a hint, not a
  credential.
- **On the `xdg-open` path the URI lands in `argv`**, so a code is briefly
  visible in `/proc/<pid>/cmdline` to processes of the same user. One more
  reason to point login flows at loopback first; the D-Bus path does not have
  this property.
- **Never log the URI.** react-x11 does not: everything on
  `REACT_X11_DEBUG_URI` goes through a redaction that drops the query, the
  fragment and any userinfo. Hold your own logging to the same rule — the code
  is _in_ the URI.

## Over ssh

Both mechanisms only work when the browser runs on the **same host as the
app**. A URL pasted into your laptop's browser reaches neither a loopback port
nor a scheme handler on the server you are `ssh -X`'d into. That is not fixable
here; it is the shape of the problem.

## Deliberately not here

- **`ActivateAction` beyond a correct reply.** Desktop actions (jump-list
  entries) want a design alongside the global menu. The method answers properly
  today, and `onAction` is there if you want it — a stub that _errors_ would
  make a shell conclude the app is broken rather than that the action is
  unhandled.
- **Writing `.desktop` files.** See above. A generator belongs with the
  packaging work ([packaging.md](packaging.md)), not on an import.
- **A full OAuth client.** This is the transport for a redirect, not a PKCE
  implementation or a token store.
- **`http`/`https` handling.** Being the default browser is not this.
- **Wayland's `xdg-activation` token.** `platform_data.activation-token` is
  read and exposed on `ctx`, and ignored. There is no Wayland here.
