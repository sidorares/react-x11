// <Frame>: a pane of this application, running in its own process.
//
// The composition is deliberately thin, because both halves already exist:
// the window boundary is `<foreign>` (the pane's window, embedded and laid
// out like any child — docs/embedding.md), and the process boundary is a
// forked node with `src/frame/child.js` as its entry. What this file owns is
// the contract between them, and the contract is narrow on purpose:
//
//  - **`props` is a bag of data**, snapshotted per parent commit and sent
//    whole (structured clone; `serialization: 'advanced'`). Functions in it
//    become RPC stubs — fire and forget, one direction (src/frame/protocol.js).
//  - **Context crosses only through the bridge** (src/frame/env.js):
//    `createFrameContext` values, and the theme by default, because a pane
//    that silently loses the app's palette looks broken in a way that
//    indicts the whole feature. `bridge={false}` (or an allowlist) is the
//    off switch that default owes.
//  - **The pane owns its data and its animation.** Props are for queries,
//    ids, ranges — an update is an IPC hop plus a child commit, the right
//    cost for "show this now", the wrong one for driving a spinner at 60fps.
//
// What a process boundary is here, and is not: an uncaught throw, a leak or
// a GC pause in the pane stays in the pane, and the shell's event loop never
// waits for it. It is **not a security boundary** — the pane holds a
// full-privilege connection to the same X server (docs/security.md), so
// `<Frame>` contains a pane's *failures*, not its intentions.
//
// Lifecycle, from both sides: the child reports `ready` (→ `onStarted`,
// and the embed), `fatal` (why the exit about to happen is one) and exit
// (→ `onExit`, and `fallback` when the host did not ask for it). The host
// closes a pane by message first — `useFrameClose` handlers run there —
// and only escalates to signals when asked nicely stops working.

import { fork } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import React, {
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import { useAppOrNull } from '../appcontext.js';
import { FrameEnv } from './env.js';
import { CallbackTable, PROTOCOL } from './protocol.js';

const h = React.createElement;

/** The forked entry's path — resolved at first spawn, not at import. The
 * website playground bundles this module with throw-on-call stubs for the
 * node builtins, and a top-level `fileURLToPath` would throw on *load*;
 * lazily, `<Frame>` imports everywhere and says "needs a desktop" only
 * when something actually spawns. */
let childEntry = null;
const childPath = () =>
  (childEntry ??= fileURLToPath(new URL('./child.js', import.meta.url)));

/**
 * @typedef {object} FrameTransport The parent's end of the wire to a pane.
 * @property {(msg: object) => void} send may throw when the channel is gone
 * @property {(cb: (msg: object) => void) => () => void} onMessage
 * @property {(cb: (info: { code: number|null, signal: string|null }) => void) => () => void} onExit
 * @property {(signal: string) => void} [kill] escalation; absent on
 *   transports with nothing to kill
 * @property {number} [pid]
 */

/** The default transport: fork this package's child entry. `execArgv` is
 * inherited, which is what carries a dev loader (tsx, the refresh loader)
 * into the pane; a bundled app forks plain JS and needs none. */
function forkTransport({ src, display }) {
  const child = fork(childPath(), [], {
    serialization: 'advanced',
    // dev loaders (tsx, the refresh loader) follow into the pane; the test
    // runner's own flags must not — `--test` in execArgv would run the pane
    // entry as a test file
    execArgv: process.execArgv.filter(
      (a) => a !== '--test' && !a.startsWith('--test-'),
    ),
    env: {
      ...process.env,
      REACT_X11_FRAME: '1',
      ...(display ? { DISPLAY: display } : {}),
    },
  });
  void src; // resolved by the child from the hello, not from argv
  return {
    send: (msg) => {
      if (!child.connected) throw new Error('the pane process is gone');
      child.send(msg);
    },
    onMessage: (cb) => {
      child.on('message', cb);
      return () => child.off('message', cb);
    },
    onExit: (cb) => {
      const onExit = (code, signal) => cb({ code, signal });
      const onError = (err) =>
        cb({ code: null, signal: null, error: err ?? null });
      child.on('exit', onExit);
      child.on('error', onError);
      return () => {
        child.off('exit', onExit);
        child.off('error', onError);
      };
    },
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        // already gone, which is what the signal was for
      }
    },
    pid: child.pid,
  };
}

function srcString(src) {
  if (src !== null && typeof src === 'object' && typeof src.href === 'string') {
    return src.href;
  }
  if (
    typeof src === 'string' &&
    (/^[a-z][a-z0-9+.-]*:/i.test(src) || isAbsolute(src))
  ) {
    return src;
  }
  throw new Error(
    'react-x11: <Frame src> must be a URL or an absolute path — a relative ' +
      "one would resolve against react-x11's own files, not yours. Pass " +
      "src={new URL('./pane.js', import.meta.url)}.",
  );
}

/** Bridged values are data; here is where that is enforced. A value that
 * cannot cross is dropped with its key named — once — rather than taking
 * the whole update down with a DataCloneError deep in a send. */
const cloneable = new WeakSet();
const warnedKeys = new Set();
function bridgedEnv(env, bridge) {
  if (bridge === false) return new Map();
  const allow = Array.isArray(bridge) ? new Set(bridge) : null;
  const out = new Map();
  for (const [key, value] of env) {
    if (allow && !allow.has(key)) continue;
    if (value !== null && typeof value === 'object' && !cloneable.has(value)) {
      try {
        structuredClone(value);
        cloneable.add(value);
      } catch (err) {
        if (!warnedKeys.has(key)) {
          warnedKeys.add(key);
          console.warn(
            `react-x11: <Frame> cannot bridge context '${key}' ` +
              `(${err.message}) — bridged values are data only; dispatchers ` +
              'and other functions travel in props (docs/frame.md)',
          );
        }
        continue;
      }
    } else if (typeof value === 'function') {
      if (!warnedKeys.has(key)) {
        warnedKeys.add(key);
        console.warn(
          `react-x11: <Frame> cannot bridge context '${key}': it is a ` +
            'function — bridged values are data only (docs/frame.md)',
        );
      }
      continue;
    }
    out.set(key, value);
  }
  return out;
}

/** One `Object.is` pass over the bag, so a parent that re-renders without
 * touching the pane's inputs does not wake the pane. Inline handlers defeat
 * it — a new closure is a new value — and that only costs the send. */
function shallowEqual(a, b) {
  if (a === b) return true;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!Object.is(a[k], b[k])) return false;
  return true;
}

const EMPTY_PROPS = {};

/**
 * A module of this application, mounted in its own process, its window
 * embedded here.
 *
 * ```jsx
 * <Frame
 *   src={new URL('./charts.pane.js', import.meta.url)}
 *   props={{ rows, range, onPick }}
 *   style={{ flexGrow: 1, backgroundColor: '$surface' }}
 *   fallback={({ error, restart }) => <Crashed error={error} onRetry={restart} />}
 * />
 * ```
 *
 * The pane module's default export is the component; it receives `props`
 * (functions arrive as fire-and-forget stubs), under the bridged context
 * providers. `ref` exposes `{ restart(), pid }`.
 */
export function Frame({
  src,
  props = EMPTY_PROPS,
  style,
  display,
  bridge = true,
  fallback,
  focusable,
  onStarted,
  onExit,
  transport,
  ref,
}) {
  const env = useContext(FrameEnv);
  // A backend that composites panes from shared memory (Cocoa) declares
  // itself with createPaneHost; everything else embeds the pane's real
  // window through <foreign>, exactly as before.
  const appOrNull = useAppOrNull();
  const paneApp = appOrNull?.createPaneHost ? appOrNull : null;
  const [state, setState] = useState({
    phase: 'starting',
    windowId: null,
    error: null,
  });
  const [generation, setGeneration] = useState(0);
  const session = useRef(null);
  // the latest render's callbacks and bags, for the long-lived effect
  const current = useRef(null);
  current.current = { props, env, bridge, onStarted, onExit };

  const restart = useCallback(() => {
    setState({ phase: 'starting', windowId: null, error: null });
    setGeneration((g) => g + 1);
  }, []);
  useImperativeHandle(ref, () => ({
    restart,
    get pid() {
      return session.current?.transport?.pid ?? null;
    },
  }));

  const source = srcString(src);
  const makeTransport = transport ?? forkTransport;
  const containerRef = useRef(null);

  // The session: one child process per (src, display, transport, restart).
  // Declared before the update effect so that on the mounting commit the
  // hello goes out first and the update pass sees itself already sent.
  useEffect(() => {
    let alive = true;
    const fail = (error) => {
      if (!alive) return;
      setState({ phase: 'failed', windowId: null, error });
    };

    let t;
    try {
      t = makeTransport({ src: source, display });
    } catch (err) {
      fail(Object.assign(err, { phase: 'spawn' }));
      return undefined;
    }
    const s = {
      transport: t,
      table: new CallbackTable(),
      closing: false,
      fatal: null,
      sent: null,
      shutdown: null,
    };
    session.current = s;

    const trySend = (msg) => {
      try {
        t.send(msg);
        return true;
      } catch (err) {
        // hello or an update that would not serialize (or a channel that
        // closed mid-send): the pane cannot follow the app from here
        if (!s.closing) fail(Object.assign(err, { phase: 'send' }));
        return false;
      }
    };
    s.trySend = trySend;

    // Both listeners live until the *exit*, not until the effect cleanup: a
    // `useFrameClose` handler flushing through a callback prop sends its
    // `invoke` after the unmount message, and dropping it would make the
    // close hook useless for the one thing it is for.
    let offMessage = t.onMessage((msg) => {
      if (msg?.type === 'ready') {
        if (!alive || s.closing) return;
        setState({ phase: 'running', windowId: msg.windowId, error: null });
        current.current.onStarted?.({
          pid: t.pid ?? null,
          windowId: msg.windowId,
        });
      } else if (msg?.type === 'invoke') {
        s.table.invoke(msg.id, msg.args);
      } else if (msg?.type === 'fatal') {
        s.fatal = msg;
      }
    });

    let clearEscalation = null;
    let offExit = null;
    const detach = () => {
      offMessage?.();
      offMessage = null;
      offExit?.();
      offExit = null;
    };
    offExit = t.onExit(({ code = null, signal = null, error } = {}) => {
      clearEscalation?.();
      detach();
      const expected = s.closing;
      if (alive && !expected) {
        const f = s.fatal;
        const err = Object.assign(
          new Error(
            f?.message ??
              error?.message ??
              `the pane exited (${signal ?? `code ${code}`})`,
          ),
          { phase: f?.phase ?? 'exit', code, signal },
        );
        if (f?.stack) err.stack = f.stack;
        fail(err);
      }
      // Deliberately not gated on `alive`: the exit a graceful close ends in
      // arrives *after* the unmount that asked for it, and `expected: true`
      // would otherwise be an event no one can ever receive. The exit
      // belongs to the session, not to the mounted lifetime.
      current.current.onExit?.({ code, signal, expected });
    });

    // Ask first, signal later. The message lets `useFrameClose` handlers
    // run and the root unmount cleanly; the signals are for a pane that
    // stopped listening — which a crashed or wedged one has.
    s.shutdown = () => {
      if (s.closing) return;
      s.closing = true;
      let sent = false;
      try {
        t.send({ type: 'unmount' });
        sent = true;
      } catch {
        // never came up, or already gone — straight to the signal
      }
      const term = setTimeout(() => t.kill?.('SIGTERM'), sent ? 1500 : 0);
      const kill = setTimeout(() => t.kill?.('SIGKILL'), 4000);
      term.unref?.();
      kill.unref?.();
      clearEscalation = () => {
        clearTimeout(term);
        clearTimeout(kill);
      };
    };

    // The hello carries everything the first paint needs — above all the
    // bridged theme, so the pane's first frame is in the app's palette
    // rather than one frame of default before an update lands.
    const { props: p, env: e, bridge: b } = current.current;
    const node = containerRef.current;
    const sc = node?.scale ?? 1;
    const rect = {
      width: Math.round((node?.abs?.width || 0) / sc) || 400,
      height: Math.round((node?.abs?.height || 0) / sc) || 300,
    };
    s.sent = { props: p, env: e, bridge: b };
    trySend({
      type: 'hello',
      protocol: PROTOCOL,
      src: source,
      display,
      rect,
      props: s.table.snapshot(p),
      env: bridgedEnv(e, b),
    });

    return () => {
      alive = false;
      s.shutdown();
      // the listeners and escalation timers outlive the effect on purpose:
      // the listeners deliver what the close handlers still send and clear
      // the escalation on exit, the timers bound a pane that ignores the
      // ask, and everything is unref'd so nothing holds the host open
      if (session.current === s) session.current = null;
    };
  }, [source, display, generation, makeTransport]);

  // One update per commit that changed the pane's inputs, props and env in
  // the same message — so a theme flip and the state change that caused it
  // land in the child as one commit, not a torn pair.
  useEffect(() => {
    const s = session.current;
    if (!s || s.closing || !s.sent) return;
    if (
      shallowEqual(s.sent.props, props) &&
      s.sent.env === env &&
      s.sent.bridge === bridge
    ) {
      return;
    }
    s.sent = { props, env, bridge };
    s.trySend({
      type: 'update',
      props: s.table.snapshot(props),
      env: bridgedEnv(env, bridge),
    });
  }, [props, env, bridge, generation]);

  if (state.phase === 'running') {
    if (paneApp) {
      return h(PaneHostView, {
        containerRef,
        session,
        app: paneApp,
        style,
        focusable,
        onEmbedError: (err) => {
          session.current?.shutdown?.();
          setState({
            phase: 'failed',
            windowId: null,
            error: Object.assign(err, { phase: 'embed' }),
          });
        },
      });
    }
    return h('foreign', {
      ref: containerRef,
      windowId: state.windowId,
      style,
      ...(focusable === undefined ? {} : { focusable }),
      onError: (err) => {
        session.current?.shutdown?.();
        setState({
          phase: 'failed',
          windowId: null,
          error: Object.assign(err, { phase: 'embed' }),
        });
      },
      // the exit path owns the state change; the window vanishing first is
      // just the order X delivers the same death in
      onClientGone: () => {},
    });
  }
  const showFallback = state.phase === 'failed' && fallback !== undefined;
  return h(
    'box',
    { ref: containerRef, style },
    showFallback
      ? typeof fallback === 'function'
        ? fallback({ error: state.error, restart })
        : fallback
      : null,
  );
}

/**
 * The Cocoa pane region: a box for layout, focus and input — hit-tested
 * here, in the host, and forwarded over the channel — with a backend pane
 * host object carrying the composited layer. The pane process presents by
 * message; this view points the layer at each presented buffer.
 */
function PaneHostView({
  containerRef,
  session,
  app,
  style,
  focusable,
  onEmbedError,
}) {
  // `onEmbedError` is a fresh closure every host render (it captures
  // setState), and the host ticks its own state many times a second — so it
  // must not be an effect dependency, or the effect below tears the pane
  // layer down and rebuilds it on every host render, and the gap between
  // `host.destroy()` and the next present is a visible full-pane flash. A
  // ref carries the latest callback into a once-per-session effect.
  const embedErrorRef = useRef(onEmbedError);
  embedErrorRef.current = onEmbedError;

  useEffect(() => {
    const s = session.current;
    const node = containerRef.current;
    const wnd = node?.root?.window;
    if (!s || !node || !wnd) {
      embedErrorRef.current?.(
        new Error('the pane region has no window to sit in'),
      );
      return undefined;
    }
    let host;
    try {
      host = app.createPaneHost(wnd);
    } catch (err) {
      embedErrorRef.current?.(err);
      return undefined;
    }
    s.paneHost = host;

    // The pane's size is this box's laid-out size, told to the pane whenever
    // it changes — the same absolutize hook a <foreign> child window uses
    // (src/foreignnodes.js), because onViewport fires only for scrollers.
    let sentSize = null;
    const syncSize = () => {
      host.setRect(node.abs);
      const sc = node.scale ?? 1;
      const width = Math.max(1, Math.round(node.abs.width / sc));
      const height = Math.max(1, Math.round(node.abs.height / sc));
      if (sentSize && sentSize.width === width && sentSize.height === height) {
        return;
      }
      sentSize = { width, height };
      s.trySend?.({ type: 'pane-rect', width, height, scale: sc });
    };
    const origAbsolutize = node.absolutize.bind(node);
    node.absolutize = (ox, oy) => {
      origAbsolutize(ox, oy);
      syncSize();
    };
    const origShift = node._shiftAbs?.bind(node);
    if (origShift) {
      node._shiftAbs = (dx, dy) => {
        origShift(dx, dy);
        host.setRect(node.abs);
      };
    }
    if (node.abs?.width) syncSize();

    const off = s.transport.onMessage((msg) => {
      if (msg?.type === 'pane-present') {
        host.setRect(node.abs);
        host.present(msg.id);
      }
    });
    return () => {
      off();
      node.absolutize = origAbsolutize;
      if (origShift) node._shiftAbs = origShift;
      if (s.paneHost === host) s.paneHost = null;
      host.destroy();
    };
  }, [app, session, containerRef]);

  const forward = (name, data) => (ev) => {
    const s = session.current;
    const node = containerRef.current;
    if (!s || !node) return;
    const sc = node.scale ?? 1;
    const payload = {
      x: Math.max(0, Math.round(ev.x * sc - node.abs.x)),
      y: Math.max(0, Math.round(ev.y * sc - node.abs.y)),
      rootx: Math.round(ev.x * sc),
      rooty: Math.round(ev.y * sc),
      buttons: ev.buttons ?? 0,
      time: Date.now(),
      ...data(ev),
    };
    try {
      s.trySend?.({ type: 'pane-event', name, ev: payload });
    } catch {
      // the exit path owns the failure story
    }
  };

  return h('box', {
    ref: containerRef,
    style,
    focusable: focusable ?? true,
    onMouseDown: forward('mousedown', (ev) => ({ keycode: ev.button ?? 1 })),
    onMouseUp: forward('mouseup', (ev) => ({ keycode: ev.button ?? 1 })),
    onMouseMove: forward('mousemove', () => ({})),
    onWheel: forward('wheel', (ev) => ({
      deltaX: ev.deltaX ?? 0,
      deltaY: ev.deltaY ?? 0,
      deltaMode: ev.deltaMode ?? 'line',
      smooth: Boolean(ev.smooth),
      source: 'forwarded',
    })),
    onKeyDown: forward('keydown', (ev) => ({
      keysym: ev.keysym,
      baseKeysym: ev.baseKeysym ?? ev.keysym,
      codepoint: ev.codepoint,
      keycode: ev.keycode ?? 0,
    })),
    onKeyUp: forward('keyup', (ev) => ({
      keysym: ev.keysym,
      baseKeysym: ev.baseKeysym ?? ev.keysym,
      codepoint: ev.codepoint,
      keycode: ev.keycode ?? 0,
    })),
  });
}
