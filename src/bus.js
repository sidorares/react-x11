// The D-Bus floor: one connection per bus, shared by everything in the
// process, acquired lazily and never able to crash an app that has no bus.
//
// Everything the desktop wants from an app — a file dialog, the colour
// scheme, notifications, a global menu, a tray icon — is a D-Bus call, and
// each of those is a separate feature that will want a connection. This
// module exists so that they all get the *same* one.
//
// ## Why not just call `dbus.sessionBus()`
//
// Because `dbus-native`'s `sessionBus()` is a constructor in disguise: every
// call opens a new socket and gets its own unique name. Menu + tray + the
// app's own exported service would be three connections and three identities,
// and the desktop would see three half-applications. A D-Bus connection is
// *process* identity, so sharing is the design, not an optimisation.
//
// And because it throws. `createStream` (dbus-native index.js:32-37) throws
// `unknown bus address` synchronously when `DBUS_SESSION_BUS_ADDRESS` is
// unset — which is every environment react-x11 was designed for: a bare
// `startx`, a WM keybinding, an ssh session, a container, CI. That throw must
// never reach an app.
//
// ## The rule
//
// **Nothing here throws at import time, and nothing here crashes an app
// running where there is no session bus.** `sessionBus()` answers `null`; the
// caller turns its feature off. `required: true` is the escape hatch for an
// app whose whole purpose is the bus, and it is the only shape that rejects.
//
// ## Lifecycle: connect on first use, stay connected
//
// The ref count drives the socket's *event-loop hold*, not its existence:
//
//   refs > 0   connected, `ref()`d    — the process stays alive for it
//   refs == 0  connected, `unref()`d  — warm, costs one idle FD, holds nothing
//
// Closing at zero refs would be wrong for the consumers this actually has. A
// file dialog that mounts on click and unmounts on dismiss would tear the
// connection down and rebuild it every time — and every rebuild is a *new
// unique name*, with the daemon forgetting match rules and well-known names
// along with the old one. `closeBus()` is the way out for an app that wants
// the connection gone; it is never the automatic consequence of an unmount.

/** @typedef {'session'|'system'} BusKind */

const KINDS = ['session', 'system'];

/**
 * There is no bus to be had, and this is why.
 *
 * `cause` is the real reason — no address, `ECONNREFUSED`, an auth rejection,
 * `dbus-native` not installed. Deliberately not a second failure taxonomy: a
 * coarse enum layered on top would have to stay true across platforms, npm
 * layouts and transport versions, and in practice the reason gets logged far
 * more often than it gets branched on.
 */
export class BusUnavailableError extends Error {
  /**
   * @param {BusKind} kind
   * @param {unknown} [cause]
   */
  constructor(kind, cause) {
    super(
      `react-x11: no ${kind} bus available` +
        (cause instanceof Error ? ` (${cause.message})` : ''),
      { cause },
    );
    this.name = 'BusUnavailableError';
    /** @type {BusKind} which bus was asked for */
    this.kind = kind;
  }
}

/**
 * Per-kind state. One entry, replaced wholesale on every generation — a dead
 * connection is never resurrected, because a new socket is a new unique name
 * and callers holding the old one are talking to nobody.
 */
const state = {
  session: newState('session', 0),
  system: newState('system', 0),
};

function newState(kind, generation) {
  return {
    kind,
    /** Bumped per connection attempt; a ref remembers which one it belongs to. */
    generation,
    /** The in-flight connect, shared by concurrent acquisitions. */
    connecting: null,
    bus: null,
    uniqueName: null,
    /** Live refs on this generation. */
    refs: 0,
    /** Set when the connection died under us; the generation is retired. */
    dead: false,
  };
}

// --------------------------------------------------------------------------
// The transport
// --------------------------------------------------------------------------

/**
 * `dbus-native`, imported on the first acquisition and never at module load.
 *
 * It is an `optionalDependency`, so on Node 20 — where its own
 * `engines: ">=22.12.0"` makes npm skip it — this import fails, and "no
 * transport installed" collapses into the "no bus here" path rather than
 * adding a mode.
 */
let transport = null;

async function loadTransport() {
  if (transport) return transport;
  const mod = await import('dbus-native');
  // CJS with an `exports` map: named exports do not reliably survive
  // cjs-module-lexer, so take the default and destructure from it.
  transport = mod.default ?? mod;
  return transport;
}

/**
 * The address seam is D-Bus's own — `DBUS_SESSION_BUS_ADDRESS` — plus the
 * `$XDG_RUNTIME_DIR/bus` fallback `dbus-native` does not have yet
 * (sidorares/dbus-native#389). Delete the fallback when that lands.
 *
 * Deliberately no `busAddress` parameter on the public API: a per-call
 * address is incoherent under sharing. Two callers, two addresses, one
 * socket — which would win? Tests use this same seam.
 */
function addressFor(kind) {
  if (kind === 'system') {
    return (
      process.env.DBUS_SYSTEM_BUS_ADDRESS ||
      'unix:path=/var/run/dbus/system_bus_socket'
    );
  }
  if (process.env.DBUS_SESSION_BUS_ADDRESS) {
    return process.env.DBUS_SESSION_BUS_ADDRESS;
  }
  // macOS advertises the session bus through launchd, which dbus-native
  // already falls back to on its own. Leave it undefined and let it.
  if (process.platform === 'darwin') return undefined;
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  return runtimeDir ? `unix:path=${runtimeDir}/bus` : undefined;
}

function noAddressError(kind) {
  return new Error(
    `react-x11: no ${kind} bus address. ` +
      (kind === 'session'
        ? '$DBUS_SESSION_BUS_ADDRESS is unset and $XDG_RUNTIME_DIR is not ' +
          'set either, which is normal over ssh, under a bare startx and in ' +
          'most containers.'
        : '$DBUS_SYSTEM_BUS_ADDRESS is unset and there is no default.'),
  );
}

function noTransportError(cause) {
  return new Error(
    'react-x11: the D-Bus transport is not installed. dbus-native is an ' +
      'optional dependency and npm skips it on Node < 22.12 (this process ' +
      `is ${process.version}). Install it explicitly — npm i dbus-native — ` +
      'or run on Node >= 22.12.',
    { cause },
  );
}

// --------------------------------------------------------------------------
// Connecting
// --------------------------------------------------------------------------

/** Swallow whatever a doomed connection has left to say. */
function silence(bus) {
  bus.connection.removeAllListeners('error');
  bus.connection.on('error', () => {});
}

async function discard(bus) {
  silence(bus);
  try {
    await bus.close();
  } catch {
    // Already gone. The cause we are on our way to reporting is the
    // interesting one, not this.
  }
}

/**
 * One connect attempt: dial, wait for the handshake, wait for the unique
 * name, and take ownership of the connection's `'error'` channel.
 *
 * Resolves with `{ bus, uniqueName }` or rejects with a `BusUnavailableError`
 * carrying the real reason. Never resolves before `bus.name` is set.
 */
async function connect(kind, generation) {
  const fail = (cause) => {
    throw new BusUnavailableError(kind, cause);
  };

  let dbus;
  try {
    dbus = await loadTransport();
  } catch (cause) {
    return fail(noTransportError(cause));
  }

  const busAddress = addressFor(kind);
  if (!busAddress && process.platform !== 'darwin') {
    return fail(noAddressError(kind));
  }

  let bus;
  try {
    // Reconnection stays off, deliberately: a new socket is a new unique
    // name, and the daemon forgets names and match rules along with the old
    // one. The replacement is a new generation, which is explicit.
    bus = dbus.createClient({ busAddress });
  } catch (cause) {
    // The synchronous throw this whole module exists to absorb.
    return fail(cause);
  }

  const conn = bus.connection;

  // **This layer owns the connection's one 'error' listener.** dbus-native
  // deliberately attaches none — an unlistened 'error' crashes the process,
  // which is the right contract for a caller-owned connection and the wrong
  // one for a shared one. Consumers never attach their own.
  let onConnect, onClose, onError;
  try {
    await new Promise((resolve, reject) => {
      onConnect = () => resolve();
      onClose = (cause) =>
        reject(cause ?? new Error(`react-x11: the ${kind} bus closed`));
      onError = (err) => reject(err);
      conn.once('connect', onConnect);
      conn.once('close', onClose);
      conn.on('error', onError);
    });
  } catch (cause) {
    await discard(bus);
    return fail(cause);
  } finally {
    conn.removeListener('connect', onConnect);
    conn.removeListener('close', onClose);
    conn.removeListener('error', onError);
  }

  // Name-ready. `bus.name` is assigned in the Hello reply callback
  // (dbus-native lib/bus.js:1002-1009), so it is *not* set when the
  // constructor returns. One org.freedesktop.DBus round trip is an ordering
  // barrier: replies arrive behind the Hello dbus-native sent first. Without
  // it, the first consumer to derive state from the app's own identity — a
  // portal Request path, say — races Hello and builds a path with
  // `undefined` in it.
  try {
    await bus.listNames();
  } catch (cause) {
    await discard(bus);
    return fail(cause);
  }
  if (bus.name == null) {
    await discard(bus);
    return fail(
      new Error(
        `react-x11: the ${kind} bus answered a call but never assigned a ` +
          'unique name — the peer is not a message bus.',
      ),
    );
  }

  // Live. From here a failure is a *death* rather than a failed connect, so
  // both channels retarget onto the generation.
  conn.on('error', () => bury(kind, generation));
  conn.once('close', () => bury(kind, generation));

  return { bus, uniqueName: bus.name };
}

/**
 * The connection died. Retire the generation rather than resurrecting it:
 * refs on it fail their calls with the transport's `ConnectionClosedError`
 * and `release()` harmlessly, mounted hooks move to `'closed'`, and the next
 * acquisition dials a fresh socket with a fresh unique name.
 */
function bury(kind, generation) {
  const s = state[kind];
  if (s.generation !== generation || s.dead) return;
  s.dead = true;
  s.refs = 0;
  s.connecting = null;
  notify(kind);
}

// --------------------------------------------------------------------------
// The event-loop hold
// --------------------------------------------------------------------------

/**
 * `ref()`/`unref()` the live socket, so the ref count decides whether the
 * connection *holds the process open* without deciding whether it exists.
 *
 * `bus.connection.stream` is a `net.Socket` on every path this module dials
 * (dbus-native index.js:169, :30-31). It is reaching into an internal, hence
 * the guards: a caller-supplied stream need not be a socket. A missing `ref`
 * costs nothing worse than a process that exits a beat earlier than it should
 * have, which the exit test would catch.
 */
function hold(s, held) {
  const stream = s.bus?.connection?.stream;
  if (!stream) return;
  if (held) stream.ref?.();
  else stream.unref?.();
}

// --------------------------------------------------------------------------
// Acquisition
// --------------------------------------------------------------------------

/**
 * @param {BusKind} kind
 * @param {{ required?: boolean }} [opts]
 * @returns {Promise<BusRefShape | null>}
 */
async function acquire(kind, opts = {}) {
  let s = state[kind];

  // A dead generation is retired: a fresh acquisition starts a new one rather
  // than handing out a corpse.
  if (s.dead) {
    s = state[kind] = newState(kind, s.generation + 1);
  }

  if (!s.bus) {
    // Concurrent acquisitions share one connect attempt.
    if (!s.connecting) {
      const generation = s.generation;
      const attempt = connect(kind, generation).then((result) => {
        // A `closeBus()` that landed mid-connect wins: drop what we dialled.
        if (state[kind] !== s) {
          discard(result.bus);
          throw new BusUnavailableError(
            kind,
            new Error(`react-x11: the ${kind} bus was closed while connecting`),
          );
        }
        s.bus = result.bus;
        s.uniqueName = result.uniqueName;
        // Nothing holds a ref yet, so the socket must not keep the process
        // alive on its own.
        hold(s, false);
        notify(kind);
        return result;
      });
      // **Failure is not cached.** A failed attempt answers its waiters and is
      // forgotten: a session bus can genuinely appear later — the moment
      // something creates $XDG_RUNTIME_DIR/bus — feature probes happen once
      // per feature init so the retry costs nothing, and a transient failure
      // must never become a process-lifetime false negative.
      s.connecting = attempt;
      attempt
        .catch(() => {})
        .then(() => {
          if (s.connecting === attempt) s.connecting = null;
        });
    }
    try {
      await s.connecting;
    } catch (cause) {
      if (opts.required) throw cause;
      return null;
    }
    // `closeBus()` can land between that resolving and this line.
    if (state[kind] !== s || !s.bus) return acquire(kind, opts);
  }

  return makeRef(s);
}

/** @typedef {{ bus: any, uniqueName: string, release(): Promise<void> }} BusRefShape */

function makeRef(s) {
  const generation = s.generation;
  // Captured, not read through the state: a ref's `bus` must stay the object
  // it was handed even after the generation is retired, so that a call on it
  // fails with ConnectionClosedError rather than on `null`.
  const bus = s.bus;
  const uniqueName = s.uniqueName;
  let live = true;

  // No `notify()` here or in `release()`: the ref count is not part of any
  // status a watcher renders, and waking every mounted hook on every
  // acquire/release would be render churn with nothing behind it.
  if (s.refs++ === 0) hold(s, true);

  const ref = {
    bus,
    uniqueName,
    /**
     * Drop this consumer's reference. Idempotent *per ref*, so `finally`
     * blocks and `asyncDispose` compose without double-decrement bugs.
     *
     * It does not close anything. `release()` is the only lifecycle verb a
     * ref holder has, deliberately: `ref.bus.close()` would tear the
     * connection out from under the tray, the menu and the app's own service.
     */
    async release() {
      if (!live) return;
      live = false;
      // A ref on a retired generation decrements nothing — `bury` and
      // `closeBus` already zeroed the count, and this ref's slot went with it.
      if (state[s.kind] !== s || s.generation !== generation || s.dead) return;
      if (--s.refs === 0) hold(s, false);
    },
  };
  ref[Symbol.asyncDispose] = () => ref.release();
  return ref;
}

/**
 * A shared session bus, or `null`.
 *
 * ```js
 * const ref = await sessionBus();
 * if (!ref) return;                    // no bus here; turn the feature off
 * const player = await ref.bus.proxy('org.mpris.MediaPlayer2.vlc', '/org/mpris/MediaPlayer2');
 * await ref.release();
 * ```
 *
 * Never rejects — unless `required: true` asks it to, which converts
 * unavailability into a `BusUnavailableError` carrying the reason. `null` is
 * right for feature-probing plumbing, and hides *why* from an app whose whole
 * purpose is the bus.
 *
 * @param {{ required?: boolean }} [opts]
 */
export function sessionBus(opts) {
  return acquire('session', opts);
}

/**
 * A shared system bus, or `null`. Hardware, networking, logind — read-mostly
 * for an application. Same contract as {@link sessionBus}.
 *
 * @param {{ required?: boolean }} [opts]
 */
export function systemBus(opts) {
  return acquire('system', opts);
}

/**
 * Close the shared connection outright. Rare, explicit, never automatic.
 *
 * This is the app-level decision a consumer must not make for its siblings.
 * Outstanding refs are retired with the generation: their calls fail with
 * `ConnectionClosedError` and `release()` still succeeds.
 *
 * @param {BusKind} kind
 */
export async function closeBus(kind) {
  if (!KINDS.includes(kind)) {
    throw new Error(
      `react-x11: closeBus(${JSON.stringify(kind)}) — expected ` +
        `${KINDS.map((k) => JSON.stringify(k)).join(' or ')}.`,
    );
  }
  const s = state[kind];
  const bus = s.bus;
  // Swap the state first, so anything awaiting the old generation sees it
  // retired rather than racing the socket teardown.
  state[kind] = newState(kind, s.generation + 1);
  notify(kind);
  if (!bus) return;
  silence(bus);
  await bus.close();
}

// --------------------------------------------------------------------------
// Subscription, for the hooks
// --------------------------------------------------------------------------

const watchers = { session: new Set(), system: new Set() };

/**
 * Re-render when a bus's status changes. Not public: `useSessionBus()` is the
 * public shape, and a consumer reaching for the imperative API does not want
 * a store.
 */
export function watchBus(kind, onChange) {
  watchers[kind].add(onChange);
  return () => watchers[kind].delete(onChange);
}

function notify(kind) {
  for (const fn of [...watchers[kind]]) fn();
}

/** Whether the generation a ref belongs to has been retired. Not public. */
export function busGeneration(kind) {
  return state[kind].generation;
}

/** Whether the live generation for `kind` has been buried. Not public. */
export function busIsDead(kind) {
  return state[kind].dead;
}

/**
 * Test seam, not public: forget every connection without closing anything.
 * `withBus()` hard-closes first and then calls this, so that no match rule or
 * exported object survives into the next test.
 */
export function _resetBusState() {
  for (const kind of KINDS) {
    state[kind] = newState(kind, state[kind].generation + 1);
    notify(kind);
  }
}
