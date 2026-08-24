// What the window manager has done with a window, as something a component
// re-renders on.
//
// A `<window>` asks for `fullscreen` or `maximized` and the window manager
// decides — and it decides on its own account too, when the user hits a
// hotkey or the titlebar button. `nodes.js` sends the requests; this is the
// half that reads back what actually happened, plus the two things an app
// needs that are not states at all: whether it has the keyboard, and whether
// anyone can see it.
//
// ## Where each field comes from
//
// | | |
// | --- | --- |
// | `focused` | FocusIn/FocusOut, via the event manager that already tracks it |
// | `minimized` `maximized` `fullscreen` `states` | `_NET_WM_STATE`, as ntk's `statechange` event |
// | `obscured` | VisibilityNotify |
// | `desktop` | `_NET_WM_DESKTOP` |
//
// Nothing here is asked for until something subscribes. `_NET_WM_STATE`
// costs a PropertyChange selection and a round trip per change,
// VisibilityNotify costs a mask bit, and an app that never asks pays for
// neither.
//
// ## The compositor caveat, because it will otherwise be found as a bug
//
// **`obscured` is always false when a compositing manager is running**, and
// one is running on every stock GNOME and KDE session. A composited window
// is redirected to an offscreen pixmap, so the server considers it entirely
// visible whatever is stacked on top of it, and VisibilityNotify says so.
// That is X working as designed and there is no protocol answer to it.
//
// So `obscured` is the bare-WM optimisation it looks like, and `visible` —
// which folds in `minimized`, the signal that *does* survive compositing —
// is the field to branch on. An animation paused on `visible` stops when the
// window is minimized everywhere, and additionally when it is buried on a
// desktop with no compositor.

import { useCallback, useSyncExternalStore } from 'react';

import { useAppOrNull } from './appcontext.js';
import { useTopLevelWindow, windowIdOf } from './windowid.js';

const VISIBILITY_NOTIFY = 15;
const VISIBILITY_CHANGE_MASK = 65536; // x11.eventMask.VisibilityChange
const PROPERTY_CHANGE_MASK = 4194304; // x11.eventMask.PropertyChange
const FULLY_OBSCURED = 2;
const DESKTOP_PROPERTY = '_NET_WM_DESKTOP';

/**
 * What is true before the window manager has said anything.
 *
 * `focused` and `visible` start **true**, and that is the whole reason this
 * constant is written out rather than being a pile of falses: a window opens
 * focused and on screen far more often than not, and a title bar that
 * renders dimmed on the first frame and un-dims on the second is a visible
 * flash on every launch. Starting from the common case makes the first paint
 * right and the correction — for the rarer window that opened in the
 * background — the thing that costs a re-render.
 */
const UNKNOWN = Object.freeze({
  focused: true,
  visible: true,
  obscured: false,
  minimized: false,
  maximized: false,
  fullscreen: false,
  states: Object.freeze([]),
  desktop: null,
});

const sessions = new WeakMap();

const SAME = (a, b) =>
  a.focused === b.focused &&
  a.visible === b.visible &&
  a.obscured === b.obscured &&
  a.minimized === b.minimized &&
  a.maximized === b.maximized &&
  a.fullscreen === b.fullscreen &&
  a.desktop === b.desktop &&
  a.states.length === b.states.length &&
  a.states.every((s, i) => s === b.states[i]);

class WindowStateSession {
  constructor(node) {
    this.node = node;
    this.snapshot = UNKNOWN;
    this.listeners = new Set();
    this.armed = false;
    this.stopped = false;
    this._desktopAtom = null;
    this._offs = [];
  }

  /**
   * Fold new fields into the snapshot and notify. A change that changes
   * nothing notifies nobody: `statechange` fires on every `_NET_WM_STATE`
   * rewrite, and window managers rewrite it with the same contents more
   * often than they change it.
   */
  publish(values) {
    const states = values.states ?? this.snapshot.states;
    const next = Object.freeze({
      ...this.snapshot,
      ...values,
      states: Object.freeze([...states]),
      // Derived rather than reported, in one place, so `visible` cannot
      // disagree with the fields it is made of.
      minimized: values.states
        ? states.includes('hidden')
        : this.snapshot.minimized,
      maximized: values.states
        ? states.includes('maximized_vert') && states.includes('maximized_horz')
        : this.snapshot.maximized,
      fullscreen: values.states
        ? states.includes('fullscreen')
        : this.snapshot.fullscreen,
    });
    const settled = Object.freeze({
      ...next,
      visible: !next.minimized && !next.obscured,
    });
    if (SAME(settled, this.snapshot)) return;
    this.snapshot = settled;
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // one subscriber throwing must not take the others with it, nor the
        // X event loop this runs on
      }
    }
  }

  stop() {
    this.stopped = true;
    for (const off of this._offs) {
      try {
        off();
      } catch {
        // a window already destroyed takes its listeners with it
      }
    }
    this._offs.length = 0;
    this.listeners.clear();
  }
}

/**
 * The `WindowNode` behind a ref, a node, an ntk window or an XID.
 *
 * Popups are **not** excluded, unlike `topLevelWindows()`: a `<popup>` is
 * override-redirect so the window manager never gives it a `_NET_WM_STATE`,
 * and reporting the defaults for one is a truer answer than refusing to
 * resolve it.
 */
function nodeOf(app, target) {
  const value =
    target &&
    typeof target === 'object' &&
    'current' in target &&
    !target.isWindow
      ? target.current
      : target;
  if (!value) return null;
  if (value.isWindow && value.window) return value;
  const id = windowIdOf(value);
  if (id == null) return null;
  return (
    (app?._rootChildren ?? []).find(
      (node) => node?.isWindow && node.window?.id === id,
    ) ?? null
  );
}

function sessionFor(node) {
  let session = sessions.get(node);
  if (!session) {
    session = new WindowStateSession(node);
    sessions.set(node, session);
  }
  return session;
}

/**
 * Start listening on the X side. Once per window: the mask bits and the
 * PropertyChange selection cannot be given back when the last subscriber
 * leaves, and re-arming on the next one would cost another round trip for a
 * selection the server still has.
 */
function arm(session) {
  if (session.armed) return;
  const node = session.node;
  const wnd = node.window;
  // Not armed yet, rather than armed against nothing: a window realizes
  // during the commit that created it, so a subscription that got here first
  // gets another chance on the next one.
  if (!wnd) return;
  session.armed = true;

  // **One selection for everything this session needs.** Two masks are at
  // stake — PropertyChange for `_NET_WM_STATE`/`_NET_WM_DESKTOP`, and
  // VisibilityChange for the obscured watch — and ntk grows a window's mask
  // one request per first listener of each kind. Asking for both here, before
  // either subscription, makes the `statechange` listener below a detected
  // no-op and leaves `watchVisibility` nothing to select: one
  // ChangeWindowAttributes for a session instead of two, on a window that is
  // already mapped and on screen by the time any of this runs.
  if (typeof wnd.selectInput === 'function') {
    Promise.resolve(
      wnd.selectInput(PROPERTY_CHANGE_MASK | VISIBILITY_CHANGE_MASK),
    ).catch(() => {
      // a window destroyed between the ref resolving and this call; the
      // defaults stand and nothing further will arrive
    });
  }

  // Focus, from the event manager rather than from ntk directly: it already
  // dedups FocusIn/FocusOut and already knows the answer for a window that
  // has not seen either yet.
  if (typeof node.onWindowFocusChange === 'function') {
    session._offs.push(
      node.onWindowFocusChange((focused) => {
        if (!session.stopped) session.publish({ focused });
      }),
    );
    const now = node.events?.windowFocused;
    if (typeof now === 'boolean') session.publish({ focused: now });
  }

  // _NET_WM_STATE. Adding the listener is what makes ntk select
  // PropertyChange and intern the atom, so the read below is only for the
  // state the window already had when this ran.
  if (typeof wnd.on === 'function') {
    const onState = (states) => {
      if (!session.stopped) session.publish({ states: states ?? [] });
    };
    wnd.on('statechange', onState);
    session._offs.push(() => wnd.off?.('statechange', onState));
    Promise.resolve(wnd.getWmStates?.()).then(
      (states) => states && !session.stopped && session.publish({ states }),
      () => {},
    );

    // _NET_WM_DESKTOP rides on the PropertyChange selection the line above
    // already asked for, so watching it costs one comparison per property
    // change rather than a second selection.
    const onProperty = (ev) => {
      if (session.stopped || ev?.atom == null) return;
      if (ev.atom !== session._desktopAtom) return;
      readDesktop(session);
    };
    wnd.on('property', onProperty);
    session._offs.push(() => wnd.off?.('property', onProperty));
    Promise.resolve(wnd.atom?.(DESKTOP_PROPERTY)).then(
      (atom) => {
        session._desktopAtom = atom;
        if (!session.stopped) readDesktop(session);
      },
      () => {},
    );
  }

  watchVisibility(session);
}

function readDesktop(session) {
  Promise.resolve(
    session.node.window?.getProperty?.(DESKTOP_PROPERTY, { as: 'numbers' }),
  ).then(
    (values) => {
      if (session.stopped) return;
      const desktop = values?.[0];
      // 0xffffffff is EWMH for "on every desktop", which `states` already
      // reports as `sticky` — a workspace number is the wrong shape for it.
      session.publish({
        desktop:
          typeof desktop === 'number' && desktop !== 0xffffffff
            ? desktop
            : null,
      });
    },
    () => {},
  );
}

/**
 * VisibilityNotify, which ntk has no event name for — its mask table stops
 * at the events a widget toolkit needs — so the event is read off the raw
 * connection. The mask it needs was selected by `arm()`, together with the
 * one the state watch needs.
 */
function watchVisibility(session) {
  const wnd = session.node.window;
  const X = session.node.app?.X ?? wnd?.X;
  if (!X?.on || typeof wnd?.selectInput !== 'function') return;

  const onEvent = (ev) => {
    if (session.stopped) return;
    if (ev.type !== VISIBILITY_NOTIFY || ev.wid !== wnd.id) return;
    session.publish({ obscured: ev.state === FULLY_OBSCURED });
  };
  X.on('event', onEvent);
  session._offs.push(() => X.off?.('event', onEvent));
}

/** What is known about a window right now. Stable until it changes. */
export function windowStateSnapshot(app, target) {
  const node = nodeOf(app, target);
  if (!node) return UNKNOWN;
  return sessions.get(node)?.snapshot ?? UNKNOWN;
}

/** Subscribe to a window's state. Not public — `useWindowState()` is. */
export function watchWindowState(app, target, onChange) {
  const node = nodeOf(app, target);
  if (!node) return () => {};
  const session = sessionFor(node);
  arm(session);
  session.listeners.add(onChange);
  return () => session.listeners.delete(onChange);
}

/**
 * Test seam: state what the window manager did, without a window manager.
 * Marks the session armed, so nothing reaches for `_NET_WM_STATE` behind the
 * value; `states` re-derives `minimized`/`maximized`/`fullscreen` the way a
 * real `statechange` does.
 */
export function setWindowStateForTests(app, target, values) {
  const node = nodeOf(app, target);
  if (!node) return null;
  const session = sessionFor(node);
  session.armed = true;
  session.publish(values);
  return session.snapshot;
}

/** Tear down with the window. Called from `WindowNode.destroy`. */
export function endWindowState(node) {
  const session = sessions.get(node);
  if (!session) return;
  session.stop();
  sessions.delete(node);
}

/**
 * What the window manager has done with this window, live.
 *
 * ```jsx
 * const { focused, visible, fullscreen } = useWindowState();
 *
 * // a title bar that dims when the window is not the active one
 * <text style={{ color: focused ? theme.text : theme.textMuted }}>{title}</text>
 *
 * // and work that is pointless while nobody can see it
 * useEffect(() => {
 *   if (!visible) return;
 *   const id = setInterval(poll, 1000);
 *   return () => clearInterval(id);
 * }, [visible]);
 * ```
 *
 * | | |
 * | --- | --- |
 * | `focused` | this window has the keyboard |
 * | `visible` | **the one to branch on** — not minimized, not fully covered |
 * | `minimized` | `_NET_WM_STATE_HIDDEN`: iconified, or shaded away |
 * | `maximized` | both axes; one axis alone shows up in `states` |
 * | `fullscreen` | what the WM actually did, not what `<window fullscreen>` asked for |
 * | `obscured` | fully covered by other windows — **always false under a compositor** |
 * | `states` | the raw `_NET_WM_STATE` names, e.g. `['maximized_vert', 'focused']` |
 * | `desktop` | the workspace index, or null (a sticky window shows up in `states`) |
 *
 * With no argument it reads the window the component is in, inferred the way
 * `useTopLevelWindow()` infers it — exact for the one-window app, and a
 * documented guess for a tree with several. Pass a ref to be certain:
 *
 * ```jsx
 * const win = useRef(null);
 * const { fullscreen } = useWindowState(win);
 * return <window ref={win}>…</window>;
 * ```
 *
 * Nothing is asked of the server until something calls this, and the first
 * render answers from the defaults — focused and visible — rather than
 * waiting for a round trip. See the compositor note in this file's header
 * before reaching for `obscured`.
 */
export function useWindowState(ref = null) {
  const app = useAppOrNull();
  const owner = useTopLevelWindow();
  const target = ref ?? owner;
  const subscribe = useCallback(
    (onChange) => watchWindowState(app, target, onChange),
    [app, target],
  );
  const snapshot = useCallback(
    () => windowStateSnapshot(app, target),
    [app, target],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** @typedef {typeof UNKNOWN} WindowState */
