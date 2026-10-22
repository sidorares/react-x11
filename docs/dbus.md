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
for the app author — a component library can call this.

## The rule everything else is subordinate to

**Nothing throws at import time, and nothing crashes an app running where
there is no session bus** — XQuartz, a bare `startx`, CI, an ssh session on a
headless server, a container, Node 20 where the transport is not installed.
**"No bus" is a first-class configuration, not a degraded one.**

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
`status`. The states are for diagnostics ("why is my tray icon missing") and
for an app that is itself a service.

**`'unavailable'` is a snapshot, not a verdict.** Failure is not cached: a
session bus can appear later, and the next acquisition retries. Do not
permanently disable a feature on seeing it.

**`'closed'` does not auto-retry.** A new connection is a new unique name (see
[the sharing contract](#the-sharing-contract)), so a hook that knows how to
rebuild its bus-side state calls `retry()` itself.

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

For host-side code with no component to hang off, and for a click handler that
wants to resolve at click time rather than render time:

```jsx
<Button
  onClick={async () => {
    await using ref = await sessionBus({ required: true });
    await ref.bus.proxy(/* … */);
  }}
/>
```

`required: true` converts unavailability into a rejection carrying the cause —
for an app whose purpose is the bus. The default never rejects.

There is **no `busAddress` parameter**: the connection is shared, so the
address comes from `$DBUS_SESSION_BUS_ADDRESS`, falling back to
`$XDG_RUNTIME_DIR/bus`. On **macOS** it is looked up from launchd
(`launchctl getenv`), asynchronously and once per process, so it does not
block the first frame
([desktop.md](desktop.md#not-blocking-the-first-frame-on-the-bus)).

## One connection, on purpose

Every consumer in the process — the global menu, a tray, your own exported
service — shares **one socket and one unique name**, so the desktop sees one
application. That is also why these hooks need no provider: two roots on two X
displays still share one session bus.

## Lifecycle: connect on first use, stay connected

The ref count drives the socket's **event-loop hold**, not its existence:

| refs | socket                | process exit                                              |
| ---- | --------------------- | --------------------------------------------------------- |
| `>0` | connected, `ref()`d   | held open — someone is using the bus                      |
| `0`  | connected, `unref()`d | not held; the connection stays warm and costs one idle FD |

Releasing the last ref does **not** close the connection, so a dialog that
mounts and unmounts (or StrictMode's double mount) does not reconnect and get
a new unique name each time.

`closeBus(kind)` is the way out for an app that genuinely wants the connection
gone. Rare, explicit, and never the automatic consequence of an unmount.

## The sharing contract

- **Never close a shared bus.** `release()` is the only lifecycle verb a ref
  holder has. `ref.bus.close()` or `bus.connection.end()` tears the connection
  out from under every other holder.
- **react-x11 owns the connection's one `'error'` listener.** Do not attach
  your own.
- **A dead connection is not resurrected.** Refs on it fail their calls with
  `ConnectionClosedError` and `release()` harmlessly; the next `sessionBus()`
  dials fresh (a new unique name), and mounted hooks move to `'closed'`.
- **App-global stays app-global.** Well-known names (`RequestName` has no
  per-consumer refcount), exported object paths (re-exporting the same path
  and interface replaces silently) and `setValueShapes()` (which flips reply
  shapes for _every_ holder) are process-level resources. Owning them is app
  policy; a `BusRef` does not scope them, and react-x11 will never call
  `setValueShapes()` on the shared bus.

## Being a service, not just a client

An app that wants to _be_ on the bus gets the full `dbus-native` surface
through `ref.bus`, on the **same connection and unique name** as react-x11's
own plumbing:

```js
const ref = await sessionBus({ required: true });
await ref.bus.requestName('org.example.MyApp', 0);
ref.bus.exportInterface(impl, '/org/example/MyApp', description);
// hold the ref for as long as you serve: it is what keeps the process alive
```

Release the ref and nothing keeps the process running.

The one service react-x11 exports for you is `org.freedesktop.Application`, so
that a `myapp://…` link opens the app that is already running —
[uri-schemes.md](uri-schemes.md). It is on this same connection, so the app's
name, its global menu and its portal requests share one identity.

## Installing, and Node 20

```json
"optionalDependencies": { "dbus-native": "^0.16.0" }
```

`dbus-native` declares `engines: ">=22.12.0"` where react-x11 declares
`">=20.19"`, so **npm skips it on Node 20** and the install still succeeds. No
compiler and no install script either way.

On Node 20, `useSessionBus()` reports `'unavailable'` with a `cause` that says
the transport is missing — the same path as an ssh session or a Mac without a
bus. To have it on Node 20 anyway, install it explicitly:

```bash
npm i dbus-native
```

The declarations never name `dbus-native`, so they type-check on an install
where it is absent. `MessageBus` is a structural type covering the members
documented here, with an index signature over the rest of the package's
surface — code that wants `dbus-native`'s own checked types can import them
directly and cast; it is the same object.

## Known sharp edges

- **A daemon that authenticates and never answers `Hello`** crashes the
  process from inside `dbus-native`, 25 s in, where nothing can catch it. A
  small window, tracked upstream.

## Seeing it

Point `DBUS_SESSION_BUS_ADDRESS` at nothing: a well-built consumer renders the
`'unavailable'` state rather than failing to start. That is the thing to check
in your own app.

Design notes: [design/dbus.md](../design/dbus.md).
