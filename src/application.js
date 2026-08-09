// `org.freedesktop.Application`: being the app that a `myapp://…` link opens.
//
// The concrete flow this exists for: the app opens the system browser for an
// OAuth login, the provider redirects to `com.example.myapp://auth?code=…`,
// the desktop routes that URI back to the **already-running** app, and the
// app's window comes to the front with the code in hand.
//
// Four things have to be true and this module owns two of them — dispatch and
// delivery. Registration (a `.desktop` file claiming
// `x-scheme-handler/com.example.myapp`) is an install step rather than runtime
// code and is documented, not executed; the raise is `activate.js`, because it
// needs an X connection and a window id and this file deliberately has
// neither.
//
// ## Two dispatch paths, and why an app must survive both
//
// The desktop entry spec makes D-Bus activation sound like the whole story —
// `DBusActivatable=true` and implementations "should ignore the `Exec` key".
// *Should*, and the most common opener does not.
//
// - **GIO honours it.** `g_desktop_app_info_launch_uris_with_dbus` calls
//   `Open`/`Activate` on the app's well-known name with a `platform_data`
//   dict. `gio open`, and most of GNOME, take this path.
// - **`xdg-open`'s generic fallback does not.** Its
//   `open_generic_xdg_x_scheme_handler` resolves the handler with `xdg-mime
//   query default`, reads the `Exec` key and runs it — `DBusActivatable` is
//   never read on that path. Chromium shells out to `xdg-open`, and `xdg-open`
//   takes the generic branch on every desktop it cannot identify, which is
//   every WM-only session: react-x11's own persona.
//
// So **a second copy of the app gets spawned with the URI in `argv`, and it
// has to hand that URI to the first copy and exit.** An app that only exports
// the interface opens a second window on half of all desktops. Both halves are
// `registerApplication()`, which is why it answers `role` rather than a
// boolean.
//
// ## The launch call arrives before the UI exists
//
// On the D-Bus path the bus *starts the process* because someone called
// `Open()`, and that call is outstanding while the app boots. Two consequences
// shape the code below:
//
// - registration happens **before `createRoot`**, not inside a component, or
//   the launching call is answered with an unknown-method error;
// - the reply must not wait for the UI. `Open` is answered on the turn it
//   arrives, the URIs are buffered, and they replay to the first handler that
//   attaches. "Reply when the window is ready" is a design that gets slower
//   until it breaks.
//
// ## What this file may not import
//
// No `react`, no X11. The bus half of this feature is genuinely orthogonal —
// it would work for any Node GUI toolkit — and it is written to that seam so
// that extracting it later is a move rather than a rewrite. What keeps it
// *here* for now is the connection: `RequestName` lands on one socket, and the
// app's name, its global menu and its portal Request paths have to be the same
// identity on the same connection (see docs/dbus.md).
//
// See docs/uri-schemes.md. Issue #173.

import { loadTransport, sessionBus } from './bus.js';
import { parseLaunchTime } from './startup.js';

/** The standard interface a D-Bus-activatable application exports. */
export const APPLICATION_IFACE = 'org.freedesktop.Application';

/**
 * `RequestName` flags and replies, from the D-Bus specification.
 *
 * `DO_NOT_QUEUE` is what makes single-instance detection one round trip: with
 * it, "somebody else has this name" comes back as a reply code instead of
 * silently parking us in a queue behind them.
 */
const DO_NOT_QUEUE = 0x4;
const PRIMARY_OWNER = 1;
const EXISTS = 3;
const ALREADY_OWNER = 4;

/**
 * How long the *other* instance gets to accept a forwarded URI.
 *
 * Short and explicit, because dbus-native's default is 25 s and its reply
 * timer is not unref'd — a process whose only remaining job is to exit would
 * otherwise sit there for half a minute looking hung.
 */
const FORWARD_TIMEOUT = 5000;

/**
 * Schemes an app may not claim through this API.
 *
 * Being the default browser or the default file handler is a different feature
 * with a different threat model, and neither is what a deep link is for. The
 * list is short on purpose: `mailto:` or `ftp:` are things an app might
 * legitimately *be*, and refusing them would be this module inventing policy.
 */
const RESERVED_SCHEMES = new Set(['http', 'https', 'file']);

/** RFC 3986: `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`. */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*$/;

/** A D-Bus well-known bus name: two or more dot-separated elements. */
const BUS_NAME_RE = /^[A-Za-z_-][A-Za-z0-9_-]*(\.[A-Za-z_-][A-Za-z0-9_-]*)+$/;

/** Anything that starts like an absolute URI. */
const HAS_SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):/;

// --------------------------------------------------------------------------
// Derivations and validation
// --------------------------------------------------------------------------

/**
 * The object path the spec says an app id has, which is not a choice:
 *
 * > Starting with the well-known D-Bus name of the application, change all
 * > dots to slashes, prefix a slash, and if a dash is found, convert it to an
 * > underscore.
 *
 * `org.example.FooViewer` → `/org/example/FooViewer`;
 * `com.example.my-app` → `/com/example/my_app`. The dash rule is the one
 * everybody misses, and it fails as "the desktop launched us and then nothing
 * happened" rather than as an error — a dash is legal in a bus name and
 * illegal in an object path, so the call goes to a path we do not serve.
 */
export function objectPathForAppId(appId) {
  return `/${appId}`.replaceAll('.', '/').replaceAll('-', '_');
}

/**
 * `appId` is three things at once and the spec ties them together: the
 * well-known bus name, the `.desktop` file's basename, and — by convention and
 * by RFC 8252 §7.1 — the URI scheme. So it is checked as the strictest of
 * them, a bus name.
 *
 * This **throws**, and that is not a hole in the never-rejects rule: a
 * malformed app id is a mistake in the source, not a fact about the machine.
 * Answering `null` would hide it on every box without a session bus and
 * surface it only on the developer's, which is the worst place for a bug to
 * be discovered.
 */
function checkAppId(appId) {
  if (typeof appId !== 'string' || !BUS_NAME_RE.test(appId)) {
    throw new Error(
      `react-x11: registerApplication({ appId: ${JSON.stringify(appId)} }) — ` +
        'the app id is the well-known D-Bus name, the .desktop file name and ' +
        'the URI scheme all at once, so it must be a valid bus name: two or ' +
        'more dot-separated elements of [A-Za-z_-][A-Za-z0-9_-]*, e.g. ' +
        '"com.example.myapp".',
    );
  }
  if (appId.length > 255) {
    throw new Error(
      `react-x11: registerApplication — the app id is ${appId.length} ` +
        'characters; D-Bus caps a bus name at 255.',
    );
  }
  return appId;
}

/** Same contract as {@link checkAppId}: a bad scheme is a source mistake. */
function checkSchemes(schemes) {
  if (schemes === undefined) return null;
  if (!Array.isArray(schemes)) {
    throw new Error(
      'react-x11: registerApplication({ schemes }) — expected an array of ' +
        'scheme names, e.g. ["com.example.myapp"].',
    );
  }
  for (const scheme of schemes) {
    if (typeof scheme !== 'string' || !SCHEME_RE.test(scheme)) {
      throw new Error(
        `react-x11: registerApplication — ${JSON.stringify(scheme)} is not a ` +
          'scheme name. RFC 3986 wants a letter followed by letters, digits, ' +
          '"+", "-" or "." — and no colon.',
      );
    }
    if (RESERVED_SCHEMES.has(scheme.toLowerCase())) {
      throw new Error(
        `react-x11: registerApplication — "${scheme}" cannot be registered ` +
          'here. Being the default browser or file handler is a different ' +
          'feature; a deep link wants a scheme derived from a domain you ' +
          'control, written in reverse (RFC 8252 §7.1), e.g. ' +
          '"com.example.myapp".',
      );
    }
  }
  return schemes.map((scheme) => scheme.toLowerCase());
}

/**
 * The scheme of a URI, lowercased, or `null` when the string is not one.
 *
 * Deliberately not `new URL()`: this runs on attacker-supplied input from an
 * unauthenticated local peer, and a parser that throws on some inputs is a
 * parser every caller has to wrap.
 */
export function schemeOf(uri) {
  if (typeof uri !== 'string') return null;
  const match = HAS_SCHEME_RE.exec(uri);
  return match ? match[1].toLowerCase() : null;
}

/**
 * The URIs of `list` this app answers for.
 *
 * `file:` is always allowed, whatever `schemes` says. `Open` is not only the
 * deep-link entry point — it is also how a file manager says "open this
 * document with you", and an app that declared a custom scheme must not
 * thereby stop opening its own files. An app that declares no schemes at all
 * gets everything, which is the honest reading of "it has not told us what it
 * answers for".
 */
export function acceptUris(list, schemes) {
  const uris = (Array.isArray(list) ? list : []).filter(
    (uri) => typeof uri === 'string' && schemeOf(uri) !== null,
  );
  if (!schemes) return uris;
  const allowed = new Set([...schemes, 'file']);
  return uris.filter((uri) => {
    if (allowed.has(schemeOf(uri))) return true;
    debug(`ignoring ${redactUri(uri)}: not a scheme this app registered`);
    return false;
  });
}

/**
 * A URI with everything secret taken out of it: no query, no fragment, no
 * userinfo.
 *
 * The whole point of this feature is that an authorization code arrives inside
 * a URI, so **the URI must never be logged whole** — not by us, and the docs
 * say not by the app either. What is left identifies the link well enough to
 * debug a routing problem.
 */
export function redactUri(uri) {
  const text = String(uri);
  const cut = text.search(/[?#]/);
  const head = cut < 0 ? text : `${text.slice(0, cut)}…`;
  // `scheme://user:password@host/…` — the credential is in the authority, and
  // it survives stripping the query.
  return head.replace(/(:\/\/)[^/@]*@/, '$1…@');
}

/**
 * The debug channel for this module, off unless asked for.
 *
 * Its own switch rather than a general one, because *this* output is the one
 * that has to be safe to paste into an issue: everything that goes through it
 * has already been through {@link redactUri}.
 */
function debug(message) {
  if (process.env.REACT_X11_DEBUG_URI === '1') {
    console.error(`react-x11: ${message}`);
  }
}

// --------------------------------------------------------------------------
// platform_data
// --------------------------------------------------------------------------

/**
 * Whatever the wire produced for an `a{sv}`, as a plain object.
 *
 * dbus-native's defaults already hand back exactly that, so this is normally
 * one `Object.entries` pass. It tolerates the other shapes because
 * `setValueShapes()` is process-global and app policy (docs/dbus.md): an app
 * that flips it for its own service must not silently break the launch path.
 */
function plainDict(value) {
  const out = Object.create(null);
  if (!value || typeof value !== 'object') return out;
  const entries = Array.isArray(value)
    ? value.filter((e) => Array.isArray(e) && e.length >= 2)
    : Object.entries(value);
  for (const [key, raw] of entries) out[String(key)] = plainValue(raw);
  return out;
}

/** A variant in any of the three shapes dbus-native can produce, unwrapped. */
function plainValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    // `new Variant(signature, value)`
    if ('signature' in value && 'value' in value) return value.value;
    return value;
  }
  // the classic `[signatureTree, [value]]` pair
  if (Array.isArray(value) && value.length === 2 && Array.isArray(value[1])) {
    return value[1].length === 1 ? value[1][0] : value[1];
  }
  return value;
}

/**
 * The launch context a handler is given.
 *
 * **Everything on it is untrusted.** `Open` is callable by any peer on the
 * session bus — it is a per-user socket, not an authorization check — so a
 * hostile local process can fabricate a `desktop-startup-id` and make the app
 * raise itself. That is focus theft rather than data loss, and it is the
 * reason the timestamp is documented as a hint rather than a credential.
 */
function launchContext(platformData) {
  const data = plainDict(platformData);
  const startupId =
    typeof data['desktop-startup-id'] === 'string'
      ? data['desktop-startup-id']
      : null;
  const token =
    typeof data['activation-token'] === 'string'
      ? data['activation-token']
      : null;
  return Object.freeze({
    platformData: Object.freeze(data),
    // The `_TIME` suffix of the startup id is the X timestamp of the user
    // action that triggered the launch — the same parse startup notification
    // does, and the value the window manager weighs before letting a window
    // come forward.
    timestamp: parseLaunchTime(startupId),
    startupId,
    /** Read, exposed, and ignored: there is no Wayland here. */
    activationToken: token,
  });
}

/** The environment's version of the same thing, for a command-line launch. */
function environmentContext() {
  const data = {};
  // Read, never deleted. `beginStartup()` consumes DESKTOP_STARTUP_ID for the
  // startup sequence and must still find it — registration runs first.
  if (process.env.DESKTOP_STARTUP_ID) {
    data['desktop-startup-id'] = process.env.DESKTOP_STARTUP_ID;
  }
  if (process.env.XDG_ACTIVATION_TOKEN) {
    data['activation-token'] = process.env.XDG_ACTIVATION_TOKEN;
  }
  return launchContext(data);
}

// --------------------------------------------------------------------------
// Handlers, and the buffer in front of them
// --------------------------------------------------------------------------

/**
 * One registration per process, because an application has one identity on the
 * desktop. Module state rather than a context, for the same reason
 * `launchTimestamp()` is: `useAppOpen()` has to reach it from inside a tree
 * that was mounted after the launch it is asking about.
 */
let current = null;

const openHandlers = new Set();
const activateHandlers = new Set();

/**
 * Calls that arrived before anything was listening.
 *
 * Drained by the **first** handler to attach and then gone — replaying to
 * every later subscriber would deliver one login twice.
 */
let buffered = [];

/**
 * Run app code detached from the D-Bus reply.
 *
 * Two things this buys, both of which are the difference between a working
 * launch and a mysterious one: the reply goes out on the turn the call
 * arrived, however long the handler takes; and a handler that throws stays the
 * app's problem instead of becoming an error reply to a desktop that has no
 * idea what to do with it.
 */
function dispatch(fn) {
  queueMicrotask(() => {
    try {
      fn();
    } catch (err) {
      // Not swallowed: an app whose deep-link handler throws would otherwise
      // see nothing at all, and there is no React boundary above a D-Bus call.
      console.error('react-x11: a handler for an app launch threw', err);
    }
  });
}

function deliver(event) {
  const handlers = event.kind === 'open' ? openHandlers : activateHandlers;
  if (handlers.size === 0) {
    buffered.push(event);
    return;
  }
  for (const handler of [...handlers]) {
    dispatch(() =>
      event.kind === 'open'
        ? handler(event.uris, event.ctx)
        : handler(event.ctx),
    );
  }
}

function drainTo(kind, handler) {
  if (buffered.length === 0) return;
  const mine = buffered.filter((event) => event.kind === kind);
  if (mine.length === 0) return;
  buffered = buffered.filter((event) => event.kind !== kind);
  for (const event of mine) {
    dispatch(() =>
      kind === 'open' ? handler(event.uris, event.ctx) : handler(event.ctx),
    );
  }
}

/**
 * Be told when the desktop hands this app URIs to open.
 *
 * ```js
 * const stop = onAppOpen((uris, ctx) => {
 *   activateWindow(null, { timestamp: ctx.timestamp });
 *   route(uris[0]);
 * });
 * ```
 *
 * Anything that arrived before the first handler attached is replayed to it,
 * so an app whose React tree mounts a second after the launch loses nothing.
 * Safe to call with no registration and no bus — it simply never fires.
 */
export function onAppOpen(handler) {
  if (typeof handler !== 'function') return () => {};
  openHandlers.add(handler);
  drainTo('open', handler);
  return () => openHandlers.delete(handler);
}

/**
 * Be told when the desktop asks this app to come forward with nothing to open
 * — a second launch from the panel, or `gio launch` on a running app.
 *
 * The handler is what raises the window; nothing is raised for you, because
 * this module has no X connection and an app that wants to answer differently
 * (a new document, say) should not have to undo a raise first.
 */
export function onAppActivate(handler) {
  if (typeof handler !== 'function') return () => {};
  activateHandlers.add(handler);
  drainTo('activate', handler);
  return () => activateHandlers.delete(handler);
}

// --------------------------------------------------------------------------
// The exported interface
// --------------------------------------------------------------------------

/**
 * `org.freedesktop.Application`, as the desktop entry spec defines it.
 *
 * All three methods answer with nothing and answer immediately. `Open`'s
 * `uris` are filtered before the app sees them; `ActivateAction` is a
 * deliberate stub — the desktop-actions half wants a design alongside the
 * global menu — but it is a stub that *replies correctly*, which is the
 * difference between an unimplemented action and a shell that thinks the app
 * is broken.
 */
function defineApplication(dbus, { schemes, onAction }) {
  return dbus.defineInterface({
    name: APPLICATION_IFACE,
    methods: {
      Activate: {
        in: { platform_data: 'a{sv}' },
        out: {},
        handler: ({ platform_data: platformData }) => {
          deliver({ kind: 'activate', ctx: launchContext(platformData) });
        },
      },
      Open: {
        in: { uris: 'as', platform_data: 'a{sv}' },
        out: {},
        handler: ({ uris, platform_data: platformData }) => {
          const accepted = acceptUris(uris, schemes);
          debug(
            `Open(${accepted.map(redactUri).join(', ')}) from the session bus`,
          );
          deliver({
            kind: 'open',
            uris: accepted,
            ctx: launchContext(platformData),
          });
        },
      },
      ActivateAction: {
        in: {
          action_name: 's',
          parameter: 'av',
          platform_data: 'a{sv}',
        },
        out: {},
        handler: ({
          action_name: name,
          parameter,
          platform_data: platformData,
        }) => {
          if (!onAction) return;
          const ctx = launchContext(platformData);
          dispatch(() => onAction(name, parameter ?? [], ctx));
        },
      },
    },
  });
}

// --------------------------------------------------------------------------
// Registration
// --------------------------------------------------------------------------

/**
 * Own this app's name on the session bus, export
 * `org.freedesktop.Application` on it, and answer whether this process is the
 * app or a second copy of it.
 *
 * ```js
 * const app = await registerApplication({
 *   appId: 'com.example.myapp',
 *   schemes: ['com.example.myapp'],
 * });
 * if (app?.role === 'secondary') process.exit(0);   // we do not exit for you
 * const root = await createRoot();
 * ```
 *
 * **Call it before `createRoot`.** On the D-Bus path the bus started this
 * process *because* someone called `Open`, and that call is outstanding while
 * the app boots; registering from inside a component answers it with an
 * unknown-method error.
 *
 * `null` means there is no session bus — ssh, a bare `startx`, a container,
 * CI, Node 20 without the transport. The app runs as an ordinary
 * single-window program, and a URI that arrived in `argv` is still delivered
 * to {@link onAppOpen}: a cold-start deep link does not need a bus, only a
 * second one does.
 *
 * It never rejects for anything about the machine. It does throw for a
 * malformed `appId` or an unusable `scheme`, which are mistakes in the source
 * — see {@link checkAppId}.
 */
export async function registerApplication(options = {}) {
  const { onOpen, onActivate, onAction } = options;
  const appId = checkAppId(options.appId);
  const schemes = checkSchemes(options.schemes);
  const objectPath = objectPathForAppId(appId);

  if (current) {
    // An app has one identity; two registrations would be two RequestNames and
    // two exports on the same path, with the second silently replacing the
    // first. The same id answers the existing registration and **ignores the
    // rest of the options** — a double call cannot corrupt anything, and a
    // second set of handlers belongs on `onAppOpen()` where adding one is what
    // the function is for.
    if (current.appId === appId) return current;
    throw new Error(
      `react-x11: registerApplication("${appId}") — this process is already ` +
        `registered as "${current.appId}". An application has one identity ` +
        'on the bus; release() the first registration to change it.',
    );
  }

  if (typeof onOpen === 'function') onAppOpen(onOpen);
  if (typeof onActivate === 'function') onAppActivate(onActivate);

  // The URIs this launch carried on the command line, before any of the bus
  // work: they are equally real whether we turn out to be the first copy of
  // the app or the second, and whether or not there is a bus at all.
  const argv = Array.isArray(options.argv)
    ? options.argv
    : process.argv.slice(2);
  const uris = acceptUris(argv, schemes);

  const ref = await sessionBus();
  if (!ref) {
    // No bus is a first-class configuration, not a degraded one. This process
    // is the app because it is the only one that can be.
    if (uris.length > 0) {
      debug(`no session bus; delivering ${uris.length} URI(s) from argv`);
      deliver({ kind: 'open', uris, ctx: environmentContext() });
    }
    return null;
  }

  let dbus;
  try {
    dbus = await loadTransport();
  } catch {
    // Unreachable in practice — `sessionBus()` already loaded it — but this
    // module must not be the one thing that turns a missing optional
    // dependency into a crash.
    await ref.release();
    return null;
  }

  const iface = defineApplication(dbus, { schemes, onAction });

  // **Export before requesting the name.** The daemon queues the activating
  // `Open` call against the well-known name and delivers it the instant we own
  // it; an object exported one await later is an object that did not exist
  // when the launch arrived, and the launcher gets UnknownMethod. Exporting
  // first costs nothing if we turn out to be the second copy — nobody can
  // route to us under a name we do not hold.
  let registration;
  try {
    registration = await ref.bus.export(objectPath, iface);
  } catch (cause) {
    // The path is derived from an id that has already been validated, so this
    // is a transport-level failure rather than a caller error — and a caller
    // whose deep links do not work must still get an app that runs.
    debug(`exporting ${objectPath} failed: ${cause?.message ?? cause}`);
    await ref.release();
    return null;
  }

  let reply;
  try {
    reply = await ref.bus.requestName(appId, DO_NOT_QUEUE);
  } catch (cause) {
    debug(`RequestName(${appId}) failed: ${cause?.message ?? cause}`);
    await registration.remove().catch(() => {});
    await ref.release();
    return null;
  }

  const primary = reply === PRIMARY_OWNER || reply === ALREADY_OWNER;

  if (!primary) {
    // The first copy of the app is running; hand it what we were launched with
    // and become nothing. `DO_NOT_QUEUE` is what makes this one round trip:
    // without it the daemon parks us behind the owner and answers 2 instead,
    // which is a state with no useful behaviour attached to it.
    debug(
      reply === EXISTS
        ? `${appId} is owned by another instance`
        : `RequestName(${appId}) answered ${reply}; not the primary owner`,
    );
    await registration.remove().catch(() => {});
    await forward(ref, dbus, { appId, objectPath, uris });
    await ref.release();
    const secondary = {
      role: 'secondary',
      appId,
      objectPath,
      async release() {},
    };
    secondary[Symbol.asyncDispose] = () => secondary.release();
    return secondary;
  }

  if (uris.length > 0) {
    // Launched from the command line *with* a link — `xdg-open`'s path, and
    // the cold start of the D-Bus one. Same delivery as a bus call, so an app
    // handles one code path instead of two.
    debug(`launched with ${uris.length} URI(s) in argv`);
    deliver({ kind: 'open', uris, ctx: environmentContext() });
  }

  let released = false;
  const primaryRegistration = {
    role: 'primary',
    appId,
    objectPath,
    /**
     * Give the name back and stop serving. Rare: a registration normally lives
     * as long as the process, and the bus ref it holds is what keeps the
     * process alive while there is a name to answer for.
     *
     * Idempotent on its own flag rather than on `current`, so that a test seam
     * that forgot the registration cannot turn this into a no-op that leaks
     * the bus ref — a held ref is a `ref()`d socket and a process that never
     * exits.
     */
    async release() {
      if (released) return;
      released = true;
      if (current === primaryRegistration) current = null;
      await ref.bus.releaseName(appId).catch(() => {});
      await registration?.remove().catch(() => {});
      registration = null;
      await ref.release();
    },
  };
  primaryRegistration[Symbol.asyncDispose] = () =>
    primaryRegistration.release();
  current = primaryRegistration;
  return primaryRegistration;
}

/**
 * Hand this launch to the copy of the app that owns the name.
 *
 * `Open` when there is something to open, `Activate` when there is not —
 * "the user started the app again" and "the user clicked a link" are different
 * events, and an app that treats a second launch as an empty `Open` cannot
 * tell them apart.
 *
 * **Auto-start is deliberately left on here**, which is the opposite of the
 * rule `globalmenu.js` follows. There, starting the service we are talking to
 * would be actively harmful; here, the owner exiting between our `RequestName`
 * and this call is exactly the case where launching a fresh instance to handle
 * the URI is the right outcome rather than a bug.
 */
async function forward(ref, dbus, { appId, objectPath, uris }) {
  const platformData = {};
  for (const [key, value] of Object.entries(
    environmentContext().platformData,
  )) {
    platformData[key] = new dbus.Variant('s', String(value));
  }
  const call =
    uris.length > 0
      ? { member: 'Open', signature: 'asa{sv}', body: [uris, platformData] }
      : { member: 'Activate', signature: 'a{sv}', body: [platformData] };
  debug(
    `another instance owns ${appId}; forwarding ${call.member}` +
      (uris.length ? ` (${uris.map(redactUri).join(', ')})` : ''),
  );
  try {
    await ref.bus.invoke(
      {
        destination: appId,
        path: objectPath,
        interface: APPLICATION_IFACE,
        member: call.member,
        signature: call.signature,
        body: call.body,
      },
      { timeout: FORWARD_TIMEOUT },
    );
  } catch (cause) {
    // The owner died in the window between the two calls, or refuses the
    // interface. Nothing left to try: we do not own the name, so we cannot
    // serve the link either. Reported rather than thrown — the caller's job is
    // still to exit.
    debug(`forwarding to ${appId} failed: ${cause?.message ?? cause}`);
  }
}

/** This process's registration, or `null`. Not public; the docs use `role`. */
export function currentRegistration() {
  return current;
}

/** Test seam, not public: forget every handler, buffer and registration. */
export function _resetApplicationState() {
  current = null;
  openHandlers.clear();
  activateHandlers.clear();
  buffered = [];
}
