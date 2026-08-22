# D-Bus

Everything the desktop wants from an app beyond drawing — a native file
dialog, the light/dark preference, notifications, a
[global menu](globalmenu.md), a tray icon
— is a D-Bus call. This page is the connection those features sit on, and
nothing else: no service is spoken to here, and the only traffic this layer
generates is its own handshake.

```jsx
import { useSessionBus } from 'react-x11';

function ColourScheme() {
  const { bus } = useSessionBus();
  if (!bus) return null; // no bus here — nothing to read a preference from
  // ...call org.freedesktop.portal.Settings through `bus`
}
```

There is **nothing to wrap**. No provider, no prop drilling, no setup step
for the app author — a component library can call this, which is the whole
reason it is shaped this way.

## The rule everything else is subordinate to

**Nothing throws at import time, and nothing crashes an app running where
there is no session bus.**

Concretely, that has to hold on XQuartz, under a bare `startx`, in CI, in an
ssh session on a headless server, in a container, and on Node 20 where the
transport is not installed at all. The ssh case is not an edge case — it is
react-x11's flagship persona. **"No bus" is a first-class configuration, not
a degraded one.**

So `sessionBus()` answers `null` rather than rejecting, and `useSessionBus()`
reports `'unavailable'` rather than throwing, when:

- `dbus-native` is not installed,
- `$DBUS_SESSION_BUS_ADDRESS` is unset and there is no `$XDG_RUNTIME_DIR/bus`,
- the connect fails, authentication fails, or the platform has no bus at all.

## The hooks

```ts
function useSessionBus(): BusHandle;
function useSystemBus(): BusHandle;

interface BusHandle {
  readonly bus: MessageBus | null; // null unless status === 'ready'
  readonly uniqueName: string | null;
  readonly status: 'connecting' | 'ready' | 'unavailable' | 'closed';
  readonly cause?: BusUnavailableError; // set when status === 'unavailable'
  retry(): void;
}
```

| `status`        |                                                          |
| --------------- | -------------------------------------------------------- |
| `'connecting'`  | the handshake is in flight — and also the first render   |
| `'ready'`       | `bus` and `uniqueName` are set                           |
| `'unavailable'` | no daemon, socket or permission here; `cause` says which |
| `'closed'`      | the connection died under you; `retry()` dials a new one |

**The terse path is correct on its own.** `const { bus } = useSessionBus()`
followed by `if (!bus) return fallback` is right, with no reference to
`status`; if reading `status` were _required_ to avoid a bug the shape would
be wrong. For a colour-scheme subscriber, `'connecting'` and `'unavailable'`
render identically anyway. The states earn their keep in diagnostics ("why is
my tray icon missing") and for an app that is itself a service.

**"Idle" is not a fourth state.** The first render happens before the effect
runs, so nothing has been attempted yet — calling that `'connecting'` is a
small inaccuracy that becomes true within a tick, and an honest fourth state
would give every consumer a branch that never needs different handling.

**`'unavailable'` is a snapshot, not a verdict.** Failure is not cached: a
session bus can appear later — `$XDG_RUNTIME_DIR/bus` exists the moment
something starts one — and the next acquisition retries. Do not permanently
disable a feature on seeing it. The name invites the opposite reading, which
is why this paragraph exists.

**`'closed'` does not auto-retry, deliberately.** Silently re-acquiring would
hand you a fresh `bus` under the same variable and hide the unique-name change
(see [the sharing contract](#the-sharing-contract)). A feature-level hook that
knows how to rebuild its bus-side state can call `retry()`; a generic one
cannot, so the decision is yours.

## The imperative pair

```ts
function sessionBus(opts?: { required?: boolean }): Promise<BusRef | null>;
function systemBus(opts?: { required?: boolean }): Promise<BusRef | null>;
function closeBus(kind: 'session' | 'system'): Promise<void>;

interface BusRef {
  readonly bus: MessageBus; // the full dbus-native surface, shared
  readonly uniqueName: string; // this connection's unique name, e.g. ':1.42'
  release(): Promise<void>; // drop this consumer's reference; idempotent
  [Symbol.asyncDispose](): Promise<void>;
}
```

This is what the hooks are built on, and it is public for two reasons that are
not "completeness":

- **Host-side code has no component to hang off.** The plumbing that later
  features add — a settings subscriber, a notification sender — is module code
  and event-loop glue, some of which must run with no root mounted at all.
- **A click handler wants to resolve at click time**, not at render time:

  ```jsx
  <Button
    onClick={async () => {
      await using ref = await sessionBus({ required: true });
      await ref.bus.proxy(/* … */);
    }}
  />
  ```

`required: true` is the service-author escape hatch. `null` is right for
feature-probing plumbing and hides _why_ from an app whose purpose is the bus,
so `required` converts unavailability into a rejection carrying the cause. The
default stays never-rejecting; the hooks use `required` internally purely to
obtain the reason for `cause`.

There is **no `busAddress` parameter**, deliberately: a per-call address is
incoherent under sharing — two callers, two addresses, one socket, which
would win? The address seam is D-Bus's own, `$DBUS_SESSION_BUS_ADDRESS`, plus
an `$XDG_RUNTIME_DIR/bus` fallback until
[dbus-native#389](https://github.com/sidorares/dbus-native/pull/389) lands.

## One connection, on purpose

`dbus-native`'s own `sessionBus()` is a constructor in disguise: every call
opens a new socket with its own unique name. A menu, a tray and an app's own
exported service would be three connections and three identities, and the
desktop would see three half-applications.

A D-Bus connection is **process** identity, so every consumer in the process
shares one socket and one unique name. That is also why these hooks need no
provider, where `useApp()` does: the X connection really is per-tree —
`createRoot()` opens one per root and a process can drive several — but two
roots on two X displays still share one session bus. Putting a process-global
on a tree-scoped context would assert a relationship that does not exist.

## Lifecycle: connect on first use, stay connected

The ref count drives the socket's **event-loop hold**, not its existence:

| refs | socket                | process exit                                              |
| ---- | --------------------- | --------------------------------------------------------- |
| `>0` | connected, `ref()`d   | held open — someone is using the bus                      |
| `0`  | connected, `unref()`d | not held; the connection stays warm and costs one idle FD |

Releasing the last ref does **not** close the connection. A file dialog that
mounts on click and unmounts on dismiss would otherwise tear the connection
down and rebuild it every time — and the real cost is not the handshake, it is
that **every reconnect is a new unique name**, with the daemon forgetting
match rules and well-known names along with the old connection. StrictMode's
double-mount becomes two counter flips rather than a full connect/disconnect
cycle.

`closeBus(kind)` is the way out for an app that genuinely wants the connection
gone. Rare, explicit, and never the automatic consequence of an unmount.

## The sharing contract

One connection with many consumers only works if the things one consumer can
break for another are named:

- **Never close a shared bus.** `release()` is the only lifecycle verb a ref
  holder has. `ref.bus.close()` or `bus.connection.end()` tears the connection
  out from under every other holder — libdbus makes closing a shared
  connection a hard application error, and here it is a rule.
- **react-x11 owns the connection's one `'error'` listener.** `dbus-native`
  deliberately attaches none, because an unlistened `'error'` crashing the
  process is the right contract for a caller-owned connection and the wrong
  one for a shared one. Do not attach your own.
- **A dead connection is not resurrected.** `dbus-native`'s reconnect stays
  off: a new socket is a new unique name, and the daemon forgets names and
  match rules with the old one. Refs on the dead connection fail their calls
  with `ConnectionClosedError` and `release()` harmlessly; the next
  `sessionBus()` dials fresh, and mounted hooks move to `'closed'`.
- **App-global stays app-global.** Well-known names (`RequestName` has no
  per-consumer refcount), exported object paths (re-exporting the same path
  and interface replaces silently) and `setValueShapes()` (which flips reply
  shapes for _every_ holder) are process-level resources. Owning them is app
  policy; a `BusRef` does not scope them, and react-x11 will never call
  `setValueShapes()` on the shared bus.

## Being a service, not just a client

An app that wants to _be_ on the bus gets the full `dbus-native` surface
through `ref.bus`, on the **same connection and unique name** as react-x11's
own plumbing — one socket, one identity on the desktop:

```js
const ref = await sessionBus({ required: true });
await ref.bus.requestName('org.example.MyApp', 0);
ref.bus.exportInterface(impl, '/org/example/MyApp', description);
// hold the ref for as long as you serve: it is what keeps the process alive
```

Holding the ref is not bookkeeping — it is the event-loop hold above. Release
it and nothing keeps the process running.

The one service react-x11 exports for you is `org.freedesktop.Application`, so
that a `myapp://…` link opens the app that is already running —
[uri-schemes.md](uri-schemes.md). It is on this connection for exactly the
reason above: a separately-dialled one would own the app's name under a
different unique name than the one the global menu registers under and the one
portals build Request paths from, and the desktop's model of "this
application" would come apart.

## Installing, and Node 20

```json
"optionalDependencies": { "dbus-native": "^0.15.1" }
```

`dbus-native` declares `engines: ">=22.12.0"` where react-x11 declares
`">=20.19"`, so **npm skips it on Node 20** and the install succeeds exactly
as before. There is no compiler and no install script either way — `npm i
react-x11` still needs no toolchain.

On Node 20, `useSessionBus()` reports `'unavailable'` with a `cause` that says
the transport is missing. That is the same code path an ssh session or a Mac
without a bus already takes: **"no transport installed" collapses into "no bus
here" rather than adding a mode.** To have it on Node 20 anyway, install it
explicitly:

```bash
npm i dbus-native
```

The declarations never name `dbus-native`, so they type-check on an install
where it is absent. `MessageBus` is a structural type covering the members
documented here, with an index signature over the rest of the package's
surface — code that wants `dbus-native`'s own checked types can import them
directly and cast; it is the same object.

## Known sharp edges

- **The `Hello` window is the one crash this layer cannot absorb.** A daemon
  that authenticates and then never answers `Hello` throws from inside
  `dbus-native` where nothing can catch it, 25 s in, from a timer tick —
  [dbus-native#393](https://github.com/sidorares/dbus-native/issues/393). Small
  window, real bug, tracked upstream.
- **Identical match rules are refcounted by the daemon, not by the client** —
  [dbus-native#394](https://github.com/sidorares/dbus-native/issues/394).
  Dormant here, since reconnect is off; recorded so that nobody enables
  reconnect without reading it.

## Seeing it

The bus explorer that used to live in `examples/` — session and system side
by side, a tree of names → object paths → interfaces built from live
introspection, a pane of an object's methods, signals and property values —
has moved to
[`@react-x11/components`](https://github.com/sidorares/react-x11-components).
It was built on `Tree`, which now lives there too, and a browser of that shape
is a component rather than a demonstration of this API.

What it demonstrated of _this_ page still holds and is worth knowing: point
`DBUS_SESSION_BUS_ADDRESS` at nothing and a well-built consumer renders the
`'unavailable'` state rather than failing to start. That is the degradation
rule above, and it is the thing to check in your own app.
