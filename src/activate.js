// The raise: asking the window manager to bring one of this app's windows to
// the front, with the timestamp that makes the request legitimate.
//
// This is the half of the deep-link story that decides whether a user calls
// the feature working. The failure mode is not an exception — it is that the
// user finishes logging in, the browser redirects, the app receives the code
// correctly, sends `_NET_ACTIVE_WINDOW` with `CurrentTime` because nobody
// parsed the launch timestamp, the WM's focus-stealing prevention declines,
// and the taskbar entry blinks. Every layer reports success.
//
// So the timestamp is a first-class parameter here rather than an
// implementation detail, and its default is the value EWMH itself names:
//
// > `data.l[1]` — "Client's last user activity timestamp … at the time of the
// > request"
//
// which is exactly what `inputtime.js` already stashes off the event stream.
// A launch context has something better — the timestamp of the click in the
// *browser* that redirected here — and that is what a caller passes in.
//
// EWMH is explicit that the window manager may refuse, and that its fallback
// is `_NET_WM_STATE_DEMANDS_ATTENTION`. That is its call, so this reports what
// was **sent**, never what happened.
//
// See docs/uri-schemes.md. Issue #173.

import { lastInputTime } from './inputtime.js';
import { liveApps } from './trace-registry.js';
import { topLevelWindows, windowIdOf } from './windowid.js';

const ACTIVE_WINDOW = '_NET_ACTIVE_WINDOW';

/** `1` is an application asking; `2` is a pager, which we are not. */
const SOURCE_APPLICATION = 1;

let warnedAboutAmbiguity = false;

/** A ref object → what it holds. Anything else passes through. */
function deref(target) {
  if (target && typeof target === 'object' && 'current' in target) {
    return target.isWindow ? target : target.current;
  }
  return target;
}

/**
 * The ntk window behind a node, a ref or an ntk window. Recognised by having
 * both an id and a connection, which is the pair this file needs anyway.
 */
function ntkWindowOf(node) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.id === 'number' && node.X) return node;
  if (node.window?.X) return node.window;
  if (node.root?.window?.X) return node.root.window;
  return null;
}

/**
 * The connection to send through, when the caller named a window that does not
 * carry one — a raw XID, or nothing at all.
 *
 * One process usually has exactly one. Several is legal (a root per display,
 * and a borrowed connection stays registered after its root unmounts), so the
 * tie-break is which of them currently has a window: raising is about a window
 * on screen, and a connection with none cannot be the one meant. Still
 * ambiguous after that is a real `null` — an XID means nothing without the
 * server that issued it.
 */
function soleApp() {
  const apps = liveApps();
  if (apps.length <= 1) return apps[0] ?? null;
  const showing = apps.filter((app) => topLevelWindows(app).length > 0);
  return showing.length === 1 ? showing[0] : null;
}

/**
 * Which of this app's windows to raise when the caller did not say.
 *
 * The same inference `useTopLevelWindow()` makes, for the same reason: one
 * top-level window is exact, and the focused one is right when there are
 * several, because it is the window the user was last in.
 */
function inferWindow(app) {
  const windows = topLevelWindows(app);
  if (windows.length <= 1) return windows[0] ?? null;
  const focused = windows.filter((w) => w.events?.windowFocused);
  if (focused.length === 1) return focused[0];
  if (process.env.NODE_ENV !== 'production' && !warnedAboutAmbiguity) {
    warnedAboutAmbiguity = true;
    console.warn(
      `react-x11: activateWindow() with no window to raise, and this tree ` +
        `has ${windows.length} top-level windows with none uniquely ` +
        'focused — raising the most recently opened. Name the window to be ' +
        'exact:\n' +
        '  const win = useRef(null);\n' +
        '  activateWindow(win, { timestamp });\n' +
        '  return <window ref={win}>…</window>;',
    );
  }
  return windows[windows.length - 1];
}

/** This app's currently active toplevel, for EWMH's `data.l[2]`. */
function currentActive(app) {
  const focused = topLevelWindows(app).filter((w) => w.events?.windowFocused);
  return focused.length === 1 ? (windowIdOf(focused[0]) ?? 0) : 0;
}

/**
 * Ask the window manager to raise and focus a window.
 *
 * ```jsx
 * useAppOpen((uris, ctx) => {
 *   activateWindow(win, { timestamp: ctx.timestamp });
 *   route(uris[0]);
 * });
 * ```
 *
 * `target` is anything {@link windowIdOf} accepts — a `<window>` ref, a ref to
 * any node inside it, a live ntk window, a raw XID — or nothing, in which case
 * this app's only top-level window is used (its focused one, when it has
 * several).
 *
 * `timestamp` is the X server time of the user action being answered.
 * **Getting this wrong is the whole failure mode of the feature**, so:
 *
 * - omitted — the last input this app saw, which is EWMH's own definition of
 *   the field;
 * - a number — the launch context's timestamp, which is what a deep link
 *   should pass: the click in the browser is the user action, not whatever
 *   this app last saw;
 * - `null` — `CurrentTime`. Legal, and most window managers will decline it.
 *
 * Returns whether the request was **issued**: `false` means there was no
 * window or no connection to send it through. `true` is not a promise that the
 * window came forward — EWMH lets the WM refuse and set
 * `_NET_WM_STATE_DEMANDS_ATTENTION` instead, which is the blinking taskbar
 * entry, and no client can tell the difference from here.
 */
export function activateWindow(target, { timestamp, source } = {}) {
  const node = deref(target);
  const wnd = ntkWindowOf(node);
  const app = node?.app ?? node?.root?.app ?? wnd?.app ?? soleApp();

  const chosen = wnd ?? (windowIdOf(node) === null ? inferWindow(app) : null);
  const xid = windowIdOf(chosen) ?? windowIdOf(node);
  const X = ntkWindowOf(chosen)?.X ?? wnd?.X ?? app?.X;
  const root = X?.display?.screen?.[0]?.root;

  if (!xid || !root || !X.SendClientMessage || !X.InternAtom) return false;

  const when =
    timestamp === undefined ? (lastInputTime(app) ?? 0) : (timestamp ?? 0);

  X.InternAtom(false, ACTIVE_WINDOW, (err, atom) => {
    if (err || !atom) return;
    // The message goes to the **root** and is *about* our window, which is why
    // both are arguments. The default event mask is
    // SubstructureRedirect|SubstructureNotify — what EWMH requires for
    // messages sent to the root — so it is deliberately not passed.
    X.SendClientMessage(root, xid, atom, 32, [
      source ?? SOURCE_APPLICATION,
      when >>> 0,
      currentActive(app),
    ]);
  });
  return true;
}
