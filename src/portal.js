// xdg-desktop-portal: the shared machinery every portal-backed feature needs,
// and nothing user-visible.
//
// A portal is a D-Bus API, not a widget. An app asks "the desktop" to run a
// dialog *in another process* and hand back the answer — which is how a
// sandboxed app gets a file picker it is not allowed to draw, and how a Qt app
// on GNOME gets a GTK dialog with your bookmarks in it.
//
// ## The one thing that is easy to get wrong
//
// Every portal method that shows UI has the same shape: it returns an object
// path **immediately** and answers later with a
// `org.freedesktop.portal.Request.Response` signal. Subscribe after the call
// returns and you can lose the answer — the dialog can be dismissed before
// your match rule is in place.
//
// So the path is predictable *by design*. From the upstream
// `org.freedesktop.portal.Request.xml`:
//
// > Since version 0.9 of xdg-desktop-portal, the handle will be of the form
// > `/org/freedesktop/portal/desktop/request/SENDER/TOKEN` where SENDER is the
// > callers unique name, with the initial ':' removed and all '.' replaced by
// > '_' […] This change was made to let applications subscribe to the Response
// > signal before making the initial portal call, thereby avoiding a race
// > condition.
//
// `portalRequest()` is that subscribe-then-call, written once, so every portal
// added later is a method name and an options dict rather than a race to
// re-solve.

import { loadTransport, sessionBus } from './bus.js';

export const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
export const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';

/** The portal answered; `response` is what it means. */
export const RESPONSE_OK = 0;
export const RESPONSE_CANCELLED = 1;
export const RESPONSE_ENDED = 2;

/**
 * There is no portal here — no bus, no service, or a version too old for what
 * was asked. A **typed** rejection rather than a crash: it is the signal that
 * a caller should fall back to something it can draw itself, which is exactly
 * what the file dialog does.
 */
export class NoPortalError extends Error {
  constructor(message, cause) {
    super(`react-x11: ${message}`, { cause });
    this.name = 'NoPortalError';
  }
}

/** The user closed the dialog, or the desktop ended the request some other way. */
export class PortalCancelledError extends Error {
  constructor(response = RESPONSE_CANCELLED) {
    super(
      response === RESPONSE_CANCELLED
        ? 'react-x11: the portal dialog was cancelled'
        : 'react-x11: the portal request ended without an answer',
    );
    this.name = 'PortalCancelledError';
    /** 1 when the user cancelled, 2 when it ended some other way. */
    this.response = response;
  }
}

/**
 * `':1.42'` → `'1_42'`.
 *
 * The transform is three characters of code and the whole reason the Request
 * race is avoidable, so it is named and tested rather than inlined.
 */
export const senderPath = (uniqueName) =>
  uniqueName.replace(/^:/, '').replaceAll('.', '_');

/**
 * A token that is a legal object-path element and not guessable — the XML asks
 * for "a per-library prefix combined with a random number", so: ours plus
 * eight random bytes.
 */
async function newToken() {
  const { randomBytes } = await import('node:crypto');
  return `rx11_${randomBytes(8).toString('hex')}`;
}

// --------------------------------------------------------------------------
// hasService
// --------------------------------------------------------------------------

/**
 * Cache per bus generation. `NameOwnerChanged` would invalidate it precisely;
 * a portal appearing mid-session is rare enough that the cheap version — cache
 * only the *positive* answer — is the honest trade. A false negative that
 * cached would be the bug (a feature disabled for the life of the process),
 * and this cannot produce one.
 */
const reachable = new Map();

/**
 * Is `name` reachable — owned right now, **or activatable on demand**?
 *
 * `NameHasOwner` alone is the wrong question and gets this wrong on a healthy
 * desktop. `org.freedesktop.portal.Desktop` ships a D-Bus service file:
 *
 *     [D-BUS Service]
 *     Name=org.freedesktop.portal.Desktop
 *     Exec=…/xdg-desktop-portal
 *
 * so on a GNOME session where no app has touched a portal yet the name has no
 * owner and would answer *false* — and a feature gated on it takes the
 * fallback path forever, on a machine where the portal works perfectly.
 */
export async function hasService(name, busRef) {
  if (reachable.get(name)) return true;
  const ref = busRef ?? (await sessionBus());
  if (!ref) return false;
  try {
    const [owned, activatable] = await Promise.all([
      ref.bus.listNames(),
      ref.bus.listActivatableNames().catch(() => []),
    ]);
    const found = owned.includes(name) || activatable.includes(name);
    if (found) reachable.set(name, true);
    return found;
  } catch {
    return false;
  } finally {
    if (!busRef) await ref.release();
  }
}

/** Test seam, not public: forget what was learned about the bus. */
export function _resetServiceCache() {
  reachable.clear();
}

// --------------------------------------------------------------------------
// The Request helper
// --------------------------------------------------------------------------

/**
 * Call a portal method that answers through a `Request`, with the
 * subscription already in place before the call goes out.
 *
 * ```js
 * const { response, results } = await portalRequest(ref, {
 *   iface: 'org.freedesktop.portal.FileChooser',
 *   member: 'OpenFile',
 *   parentWindow: 'x11:1a00007',
 *   title: 'Open',
 *   options: { multiple: true },
 * });
 * ```
 *
 * Three things it owns, so that no caller reimplements them:
 *
 * - **Cancellation.** An `AbortSignal` calls `Request.Close()` on the same
 *   path. Per the XML that means **no `Response` is emitted**, so the promise
 *   has to be settled here rather than left waiting for one.
 * - **Deadlines.** There is deliberately **no timeout on the answer** — a
 *   dialog can legitimately be open for an hour, which is the whole reason
 *   portals are request-shaped instead of plain calls. Only the initial method
 *   call gets a short one: a portal that does not hand back a handle in a few
 *   seconds is not there.
 * - **A pre-0.9 portal** that returns an unpredictable path. Cheap insurance:
 *   re-subscribe on whatever came back.
 *
 * @param {{ bus: any, uniqueName: string }} busRef
 * @returns {Promise<{ response: number, results: object }>}
 */
export async function portalRequest(
  busRef,
  { iface, member, parentWindow = '', title = '', options = {}, signal },
) {
  const { bus, uniqueName } = busRef;
  const token = await newToken();
  const path = `${PORTAL_PATH}/request/${senderPath(uniqueName)}/${token}`;

  if (signal?.aborted) throw signal.reason ?? new PortalCancelledError();

  const subscribe = async (requestPath) => {
    const sub = await bus.watch(
      `type='signal',sender='${PORTAL_NAME}',` +
        `interface='${REQUEST_IFACE}',member='Response',path='${requestPath}'`,
    );
    const key = bus.mangle(requestPath, REQUEST_IFACE, 'Response');
    return { sub, key };
  };

  // Subscribe FIRST. Everything else in this function is bookkeeping around
  // the fact that this line comes before the invoke.
  let { sub, key } = await subscribe(path);
  const answered = new Promise((resolve) => {
    // `bus.signals` emits the signal's argument array.
    bus.signals.once(key, ([response, results]) =>
      resolve({ response, results: results ?? {} }),
    );
  });

  const closeRequest = (requestPath) =>
    bus
      .invoke({
        destination: PORTAL_NAME,
        path: requestPath,
        interface: REQUEST_IFACE,
        member: 'Close',
        signature: '',
        body: [],
      })
      .catch(() => {
        // The request may already be gone — that is the outcome we wanted.
      });

  let onAbort;
  try {
    let handle;
    try {
      handle = await bus.invoke(
        {
          destination: PORTAL_NAME,
          path: PORTAL_PATH,
          interface: iface,
          member,
          signature: 'ssa{sv}',
          body: [parentWindow, title, { ...options, handle_token: token }],
        },
        { timeout: 10_000 },
      );
    } catch (cause) {
      throw new NoPortalError(`${iface}.${member} did not answer`, cause);
    }

    // Pre-0.9 portals chose their own path. Re-subscribe on the real one; the
    // first subscription stays until the finally below, which is cheaper than
    // getting the ordering wrong.
    if (typeof handle === 'string' && handle !== path) {
      const moved = await subscribe(handle);
      bus.signals.once(moved.key, ([response, results]) => {
        bus.signals.emit(key, [response, results]);
      });
      sub = { remove: () => Promise.all([sub.remove(), moved.sub.remove()]) };
    }

    if (signal) {
      onAbort = () => closeRequest(handle ?? path);
      signal.addEventListener('abort', onAbort, { once: true });
      // `Close()` produces no Response, so the abort has to settle the race
      // itself rather than wait for one that will never arrive.
      const aborted = new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(signal.reason ?? new PortalCancelledError()),
          { once: true },
        );
      });
      return await Promise.race([answered, aborted]);
    }

    return await answered;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    await sub.remove().catch(() => {});
  }
}

/**
 * A `parent_window` handle for the portal, or `''` when there is no window to
 * name — which is legal and just means the dialog floats.
 *
 * Lowercase hex, no `0x`. Both shipping backends tolerate a prefix, which is
 * precisely why it is easy to get wrong and never notice; Qt's parser answers
 * 0 on failure with no error path, so a third backend would silently give an
 * unparented, non-modal dialog rather than throw.
 */
export function parentWindowHandle(xid) {
  return typeof xid === 'number' && xid > 0 ? `x11:${xid.toString(16)}` : '';
}

/**
 * `Variant`, from the one copy of the transport the bus layer loaded.
 *
 * Needed for the option types inference cannot produce — `a(sa(us))` for
 * filters, `u` where a plain number would marshal as `i`.
 */
export async function variant(signature, value) {
  const dbus = await loadTransport();
  return new dbus.Variant(signature, value);
}

/**
 * A NUL-terminated byte array, which is how the FileChooser portal spells a
 * path in its options (`current_folder`, `current_file`). A plain string there
 * marshals as `s` and the backend ignores it — silently, which is the failure
 * mode worth writing a helper to avoid.
 */
export function pathBytes(value) {
  return Buffer.from(`${value}\0`, 'utf8');
}
