// The wire between a `<Frame>` and its pane process. Pure data — no React,
// no X11, no `child_process` — so the same protocol runs over node's IPC
// channel (the fork transport), a loopback pair (the tests), or whatever a
// custom transport is built on.
//
// Six messages, all objects with a `type`:
//
//   parent → child
//     hello    { protocol, src, display, rect, props, env }   first, once
//     update   { props, env }        full snapshots, one per parent commit
//     unmount  {}                    run close handlers, unmount, exit
//
//   child → parent
//     ready    { windowId }          the pane mounted; embed this
//     invoke   { id, args }          a bridged callback fired
//     fatal    { phase, message, stack }   why the exit about to happen is one
//
// Values cross by **structured clone** (fork uses `serialization:
// 'advanced'`), so Dates, Maps, TypedArrays and cycles survive — and
// functions do not, which is what the callback bridge is for: the parent
// swaps each function in `props` for a `{ [CALLBACK]: id }` marker and keeps
// the function; the child revives markers as stubs that send `invoke` back.
// Fire and forget — a stub returns undefined, because a return value would
// make every event handler an await and every await a frame of latency.
//
// Ids are **monotonic across updates**, never reused. The table keeps the
// current snapshot's entries and the previous one's: React recreates handler
// closures render to render, so a click that raced a props update arrives
// with the previous snapshot's id and must still land — one snapshot of
// grace covers the in-flight window, while an id from two updates ago is
// dropped (with a warning) rather than delivered to the wrong function.
// Functions the caller keeps stable (`useCallback`) keep their id, which is
// what makes the grace window about racing messages rather than about how
// the app was written.

export const PROTOCOL = 1;

/** The marker key a function in `props` becomes on the wire. */
export const CALLBACK = '$$reactX11FrameCallback';

const isPlainObject = (v) =>
  v !== null &&
  typeof v === 'object' &&
  (Object.getPrototypeOf(v) === Object.prototype ||
    Object.getPrototypeOf(v) === null);

/**
 * The parent's side of the callback bridge: give out wire snapshots of a
 * props bag, answer `invoke` messages with the function each id stood for.
 */
export class CallbackTable {
  constructor({ warn = console.warn } = {}) {
    this._ids = new WeakMap(); // fn → id, stable across snapshots
    this._seq = 0;
    this._live = new Map(); // id → fn, the latest snapshot
    this._prev = new Map(); // …and the one before it: the grace window
    this._warn = warn;
  }

  /**
   * Deep-copy `props` with every function replaced by its marker. Walks
   * plain objects and arrays — a function buried in a `Map` value is not
   * found, and the send will refuse the clone, which is the honest failure.
   * Cycle-safe: a value already walked keeps one wire identity.
   */
  snapshot(props) {
    const found = new Map();
    const seen = new Map();
    const walk = (value) => {
      if (typeof value === 'function') {
        let id = this._ids.get(value);
        if (id === undefined) {
          id = this._seq++;
          this._ids.set(value, id);
        }
        found.set(id, value);
        return { [CALLBACK]: id };
      }
      if (Array.isArray(value)) {
        if (seen.has(value)) return seen.get(value);
        const out = [];
        seen.set(value, out);
        for (const item of value) out.push(walk(item));
        return out;
      }
      if (isPlainObject(value)) {
        if (seen.has(value)) return seen.get(value);
        const out = {};
        seen.set(value, out);
        for (const key of Object.keys(value)) out[key] = walk(value[key]);
        return out;
      }
      return value;
    };
    const wire = walk(props);
    this._prev = this._live;
    this._live = found;
    return wire;
  }

  /** Answer an `invoke` from the child. Returns whether an entry was found. */
  invoke(id, args = []) {
    const fn = this._live.get(id) ?? this._prev.get(id);
    if (!fn) {
      this._warn(
        `react-x11: <Frame> dropped a callback (id ${id}) that outlived ` +
          'two props updates — the child held a stub outside the props flow',
      );
      return false;
    }
    fn(...args);
    return true;
  }
}

/**
 * The child's side: rebuild `props` with each marker replaced by a stub
 * that sends `invoke(id, args)`. Same walk, other direction.
 */
export function reviveCallbacks(wire, invoke) {
  const seen = new Map();
  const walk = (value) => {
    if (Array.isArray(value)) {
      if (seen.has(value)) return seen.get(value);
      const out = [];
      seen.set(value, out);
      for (const item of value) out.push(walk(item));
      return out;
    }
    if (isPlainObject(value)) {
      if (CALLBACK in value) {
        const id = value[CALLBACK];
        return (...args) => invoke(id, sanitizeArgs(args));
      }
      if (seen.has(value)) return seen.get(value);
      const out = {};
      seen.set(value, out);
      for (const key of Object.keys(value)) out[key] = walk(value[key]);
      return out;
    }
    return value;
  };
  return walk(wire);
}

/**
 * Callback arguments, made sendable. A pane calls `onPick(item, ev)` the
 * way it would call any handler, and `ev` is full of functions and node
 * references — dropping what cannot cross (functions become `undefined`,
 * everything else is kept) beats throwing away the whole call, which is
 * what an unfiltered structured clone would do.
 */
export function sanitizeArgs(args) {
  const seen = new Map();
  const walk = (value) => {
    if (typeof value === 'function') return undefined;
    if (Array.isArray(value)) {
      if (seen.has(value)) return seen.get(value);
      const out = [];
      seen.set(value, out);
      for (const item of value) out.push(walk(item));
      return out;
    }
    if (isPlainObject(value)) {
      if (seen.has(value)) return seen.get(value);
      const out = {};
      seen.set(value, out);
      for (const key of Object.keys(value)) {
        const walked = walk(value[key]);
        if (walked !== undefined || value[key] === undefined) {
          out[key] = walked;
        }
      }
      return out;
    }
    return value;
  };
  return args.map(walk);
}
