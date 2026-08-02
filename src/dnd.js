// XDND drag and drop, the drop-target half: react-x11 windows accept drags
// from other X11 applications (file managers, editors, browsers).
//
// Design: docs/architecture/drag-and-drop.md; protocol: XDND version 5.
// The advertisement (`XdndAware`) is a 4-byte property written
// unconditionally on every top-level window at realize time — it creates no
// X windows, so it is orthogonal to the windowed/windowless split.
// Laziness lives in the protocol's own channel instead: a window with no
// registered drop target answers the first XdndPosition with "not
// accepting" plus a suppression rectangle covering the whole window, which
// silences the source until the pointer leaves. De-advertising on unmount
// would race sources that cache the window list at drag start (GTK does),
// and would churn a property per commit for nothing a user can see.
//
// Drop handling is ordinary props on ordinary nodes — `dropAccept`,
// `onDragEnter/Over/Leave`, `onDrop` — dispatched through the same
// hit-test → capture/bubble machinery as every pointer event. `dropAccept`
// is data, not code, so XdndStatus is answered in the ClientMessage handler
// without waiting on React: an advertised window that stalls on a render
// stalls the *source application's* drag cursor.

import {
  runWithPriority,
  DiscreteEventPriority,
  ContinuousEventPriority,
} from './priority.js';
import { callHandler, reportHandlerError } from './errors.js';
import { discrete } from './events.js';

export const XDND_VERSION = 5;

/** How long an async onDrop may hold the source's XdndFinished. The reply
 * must always go out — a forgotten await in one app must not hang another
 * application's drag gesture. */
const DROP_TIMEOUT = 10_000;

// Edge auto-scroll. How near a viewport's edge the pointer has to be for
// the drag to start scrolling it, how often a step goes out, and the
// fastest one step can be.
const AUTOSCROLL_EDGE = 24;
const AUTOSCROLL_INTERVAL = 30;
const AUTOSCROLL_STEP = 14;

const ATOM_NAMES = [
  'XdndAware',
  'XdndSelection',
  'XdndTypeList',
  'XdndProxy',
  'XdndEnter',
  'XdndPosition',
  'XdndStatus',
  'XdndLeave',
  'XdndDrop',
  'XdndFinished',
  'XdndActionCopy',
  'XdndActionMove',
  'XdndActionLink',
  'XdndActionAsk',
  'XdndActionPrivate',
];

// per-connection atom table: X -> { atoms|null, promise, names: Map }
const tables = new WeakMap();

/** Intern the XDND atom vocabulary once per connection (one batched write;
 * node-x11 caches interned atoms, so re-entry costs nothing). Resolves to
 * `{ <name>: atom, byAtom: Map<atom, name> }`, also readable synchronously
 * via `dndAtomsOf` once resolved. */
export function dndAtoms(X) {
  let entry = tables.get(X);
  if (!entry) {
    entry = { atoms: null, promise: null, names: new Map() };
    entry.promise = Promise.all(
      ATOM_NAMES.map(
        (name) =>
          new Promise((resolve, reject) =>
            X.InternAtom(false, name, (err, atom) =>
              err ? reject(err) : resolve(atom),
            ),
          ),
      ),
    ).then((ids) => {
      const atoms = { byAtom: new Map() };
      ATOM_NAMES.forEach((name, i) => {
        atoms[name] = ids[i];
        atoms.byAtom.set(ids[i], name);
      });
      entry.atoms = atoms;
      return atoms;
    });
    tables.set(X, entry);
  }
  return entry.promise;
}

/** The resolved atom table, or null while the interning is in flight. */
export function dndAtomsOf(X) {
  return tables.get(X)?.atoms ?? null;
}

/** Atom → name, cached per connection. Type-list atoms are arbitrary MIME
 * strings interned by the source, so unknowns go through GetAtomName. */
function atomName(X, atom) {
  const entry = tables.get(X);
  const known = entry?.atoms?.byAtom.get(atom);
  if (known) return Promise.resolve(known);
  const cache = entry?.names;
  const hit = cache?.get(atom);
  if (hit) return hit;
  const p = new Promise((resolve) =>
    X.GetAtomName(atom, (err, name) => resolve(err ? null : name)),
  );
  cache?.set(atom, p);
  return p;
}

// ---------------------------------------------------------------------------
// The type vocabulary.
//
// The same logical payload arrives under different names depending on who is
// dragging: files are text/uri-list (plus desktop-specific variants), GTK
// text is text/plain;charset=utf-8 / UTF8_STRING / STRING / COMPOUND_TEXT,
// Firefox links are UTF-16 text/x-moz-url, Chromium's are _NETSCAPE_URL.
// String equality on 'text/plain' misses GTK text entirely — normalising
// this once, here, is the interop feature.
// ---------------------------------------------------------------------------

/** Best-first text flavours, for `e.text` and the 'text' group. */
const TEXT_TARGETS = [
  'text/plain;charset=utf-8',
  'UTF8_STRING',
  'text/plain',
  'STRING',
  'TEXT',
  'COMPOUND_TEXT',
];

const TYPE_GROUPS = {
  files: [
    'text/uri-list',
    'application/x-kde4-urilist',
    'x-special/gnome-copied-files',
  ],
  uris: ['text/uri-list', 'text/x-moz-url', '_NETSCAPE_URL'],
  text: TEXT_TARGETS,
};

/** Does the offered type list satisfy one accept entry — a semantic group
 * ('files' | 'uris' | 'text') or a concrete type name? MIME names compare
 * case-insensitively; X atom names like UTF8_STRING are exact. */
export function typeMatches(offered, want) {
  const group = TYPE_GROUPS[want];
  if (group) return group.some((t) => offered.includes(t));
  if (offered.includes(want)) return true;
  const lower = String(want).toLowerCase();
  return offered.some((t) => t.toLowerCase() === lower);
}

/**
 * Does a node's `dropAccept` accept this offer? `dropAccept` is a type
 * name, a semantic group, an array of either, or a predicate over the
 * offered names. Absent means "accepts anything" — a bare `onDrop` is a
 * valid dropzone.
 */
export function matchAccept(accept, offered) {
  if (accept == null) return true;
  if (typeof accept === 'function') return Boolean(accept(offered));
  const list = Array.isArray(accept) ? accept : [accept];
  return list.some((want) => typeMatches(offered, want));
}

/**
 * Parse a `text/uri-list` payload (RFC 2483): CRLF-separated, `#` lines are
 * comments, URIs are percent-encoded. `path` is present only for `file:`
 * URIs that are actually local — a remote `file://host/...` has no local
 * path and must not pretend to.
 */
export function parseUriList(text) {
  const files = [];
  for (const line of String(text).split(/\r?\n/)) {
    const uri = line.trim();
    if (!uri || uri.startsWith('#')) continue;
    const entry = { uri };
    try {
      const url = new URL(uri);
      if (
        url.protocol === 'file:' &&
        (url.hostname === '' || url.hostname === 'localhost')
      ) {
        entry.path = decodeURIComponent(url.pathname);
      }
    } catch {
      // not a parseable URI — keep the raw line, claim no path
    }
    files.push(entry);
  }
  return files;
}

/** The props that make a node a drop target (and register it, see
 * Reconciler commitMount / Node.applyProps). `dropAccept` is deliberately
 * namespaced — a generic name like `accept` could ride in on a prop spread
 * and silently turn a box into a dropzone. */
const DROP_PROPS = [
  'dropAccept',
  'onDrop',
  'onDropCapture',
  'onDragEnter',
  'onDragLeave',
  'onDragOver',
  'onDragOverCapture',
];

export function hasDropProps(props) {
  if (!props) return false;
  for (const key of DROP_PROPS) {
    if (props[key] != null) return true;
  }
  return false;
}

const ACTION_NAMES = {
  XdndActionCopy: 'copy',
  XdndActionMove: 'move',
  XdndActionLink: 'link',
  XdndActionAsk: 'ask',
  XdndActionPrivate: 'private',
};
const ACTION_ATOMS = {
  copy: 'XdndActionCopy',
  move: 'XdndActionMove',
  link: 'XdndActionLink',
  ask: 'XdndActionAsk',
  private: 'XdndActionPrivate',
};

function actionName(atoms, atom) {
  return ACTION_NAMES[atoms.byAtom.get(atom)] ?? 'copy';
}

function actionAtom(atoms, name) {
  return atoms[ACTION_ATOMS[name] ?? 'XdndActionCopy'];
}

/** Decode selection bytes for a text-ish target; anything else stays a
 * Buffer. STRING is defined as latin-1; everything textual else is UTF-8. */
function decodeData(data, target) {
  const textish =
    TEXT_TARGETS.includes(target) || /^text\//i.test(String(target));
  if (!textish) return data;
  return data.toString(target === 'STRING' ? 'latin1' : 'utf8');
}

/**
 * The viewport a drag over `path` scrolls: the nearest enclosing one,
 * found by walking out from the hit node the same way the wheel's default
 * action does ([events.js](./events.js)). Stopping at the first rather
 * than chaining to an outer viewport is that default's behaviour too, so
 * the two gestures agree about which viewport a point belongs to.
 *
 * `<textarea>` scrolls under the wheel but not under a drag: nothing can
 * be dropped into one, so scrolling it would move text the drag cannot
 * reach.
 */
function scrollerIn(path) {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].kind === 'scrollview') return path[i];
  }
  return null;
}

/**
 * Pixels to scroll per step for a pointer at `x, y` over `rect`, or null
 * when it is not near enough to an edge to scroll at all.
 *
 * The rate ramps with depth into the band rather than being constant: a
 * drag crossing a long list crawls at a constant slow rate, and one
 * nudging the next row into view overshoots at a constant fast one. Each
 * axis takes the nearer of its two edges, so a viewport shorter than two
 * bands still scrolls one way rather than fighting itself.
 */
function edgeVelocity(rect, x, y) {
  const inside =
    x >= rect.x &&
    x <= rect.x + rect.width &&
    y >= rect.y &&
    y <= rect.y + rect.height;
  if (!inside) return null;
  const ramp = (distance) =>
    distance >= AUTOSCROLL_EDGE
      ? 0
      : Math.ceil(
          (1 - Math.max(0, distance) / AUTOSCROLL_EDGE) * AUTOSCROLL_STEP,
        );
  const top = y - rect.y;
  const bottom = rect.y + rect.height - y;
  const left = x - rect.x;
  const right = rect.x + rect.width - x;
  const dy = top < bottom ? -ramp(top) : ramp(bottom);
  const dx = left < right ? -ramp(left) : ramp(right);
  return dx === 0 && dy === 0 ? null : { dx, dy };
}

// ---------------------------------------------------------------------------
// The per-top-level session.
// ---------------------------------------------------------------------------

/**
 * One per realized top-level window (`<window>` at the root, `<popup>`),
 * owned by the WindowNode as `_dnd`. Handles the incoming half of XDND:
 * Enter/Position/Leave/Drop in, Status/Finished out. Messages for drags
 * over nested `<window>` children also arrive here — since XDND v3 only
 * top-levels advertise — and are routed down in JS via each child's
 * `_screenOrigin`.
 */
export class DropSession {
  constructor(windowNode) {
    this.node = windowNode;
    this.X = windowNode.app.X;
    // FIFO gate: messages queue behind atom interning and XdndEnter's
    // async type-list resolution, so a Position never overtakes its Enter.
    this._chain = Promise.resolve();
    this._reset();
  }

  _reset() {
    this._stopAutoScroll();
    this.sourceWid = 0;
    this.version = 0;
    this.types = [];
    this.path = [];
    this.accepted = null;
    this.acceptedAction = 'copy';
    this.requestedAction = 'copy';
    this.lastPoint = null;
    // which transport is feeding this session: 'external' (XDND wire) or
    // 'internal' (a DragSession in this process). Carried onto every drag
    // event as `e.source`.
    this._source = 'external';
  }

  /** Entry point, from the window's 'message' listener. */
  handleMessage(ev) {
    if (ev.format !== 32 || !this.node.window) return;
    this._chain = this._chain
      .then(() => dndAtomsOf(this.X) ?? dndAtoms(this.X))
      .then((atoms) => this._route(ev, atoms))
      .catch(() => {}); // connection teardown mid-drag; nothing to do
  }

  _route(ev, atoms) {
    switch (ev.message_type) {
      case atoms.XdndEnter:
        return this._onEnter(ev);
      case atoms.XdndPosition:
        return this._onPosition(ev, atoms);
      case atoms.XdndLeave:
        return this._onLeave(ev);
      case atoms.XdndDrop:
        return this._onDrop(ev, atoms);
    }
  }

  /** A node is leaving the tree: no stale references (mirrors
   * EventManager.forget). */
  forget(node) {
    this.path = this.path.filter((n) => n !== node);
    if (this.accepted === node) this.accepted = null;
  }

  async _onEnter(ev) {
    this._clearPath(); // a fresh enter ends any stale session
    this._reset();
    this.sourceWid = ev.data[0] >>> 0;
    this.version = Math.min(XDND_VERSION, ev.data[1] >>> 24);
    const typeAtoms =
      ev.data[1] & 1
        ? await this._readTypeList(this.sourceWid)
        : [ev.data[2], ev.data[3], ev.data[4]].filter(Boolean);
    // returned before positions are processed — the chain awaits this
    this.types = (
      await Promise.all(typeAtoms.map((a) => atomName(this.X, a)))
    ).filter(Boolean);
  }

  /** The source offers more than three types: the full list is on its
   * window as XdndTypeList (type ATOM). */
  _readTypeList(sourceWid) {
    return new Promise((resolve) => {
      this.X.GetProperty(
        0,
        sourceWid,
        dndAtomsOf(this.X).XdndTypeList,
        0,
        0,
        0x1000,
        (err, prop) => {
          if (err || !prop?.data?.length) return resolve([]);
          const atoms = [];
          for (let o = 0; o + 4 <= prop.data.length; o += 4) {
            atoms.push(prop.data.readUInt32LE(o));
          }
          resolve(atoms);
        },
      );
    });
  }

  _onPosition(ev, atoms) {
    if (ev.data[0] >>> 0 !== this.sourceWid) return;
    const packed = ev.data[2] >>> 0;
    const rootX = packed >>> 16;
    const rootY = packed & 0xffff;
    const time = ev.data[3] >>> 0;
    this.requestedAction = actionName(atoms, ev.data[4] >>> 0);

    // Zero registered targets anywhere under this top-level: one refusal
    // with a rectangle covering the whole window, and a well-behaved
    // source goes quiet until the pointer leaves. This is the lazy channel
    // — no node work, no React, one message per window-entry.
    if (this.node._dndTargetCount() === 0) {
      this._sendStatus(atoms, { accept: false, rect: this._windowRect() });
      return;
    }

    const answer = this._overAt(rootX, rootY, time);
    this._sendStatus(atoms, {
      accept: answer.accept,
      action: answer.action,
      rect:
        answer.freeze && this.accepted ? this._nodeRect(this.accepted) : null,
    });
  }

  /**
   * One position update, whichever transport delivered it: route the root
   * point, hit-test, find the accepting node from `dropAccept` data, diff
   * the drag path (enter/leave + `:drag-over`), and give `onDragOver` its
   * synchronous chance to override. Returns the answer — XDND sends it as
   * XdndStatus, an internal DragSession reads it directly.
   */
  _overAt(rootX, rootY, time) {
    const { windowNode, x, y } = this._routePoint(rootX, rootY);
    const target = windowNode.hitTest(x, y) ?? windowNode;
    const path = windowNode.events._path(target);
    const native = { x, y, rootx: rootX, rooty: rootY, time, buttons: 0 };

    // deepest node that declares drop handling and matches the offer —
    // answered from `dropAccept` data, no React in the loop
    let accepted = null;
    for (let i = path.length - 1; i >= 0; i--) {
      const n = path[i];
      if (n.props.disabled || !hasDropProps(n.props)) continue;
      if (matchAccept(n.props.dropAccept, this.types)) {
        accepted = n;
        break;
      }
    }
    this.accepted = accepted;
    this.lastPoint = { windowNode, x, y, rootX, rootY, time };
    this._updateAutoScroll(path, x, y);

    const answer = {
      accept: Boolean(accepted),
      action: this.requestedAction,
      freeze: false,
    };
    runWithPriority(ContinuousEventPriority, () => {
      this._updateDragPath(path, native);
      // onDragOver may override the declarative answer, synchronously —
      // same latency budget as any event handler, no render awaited
      const over = this._makeDragEvent(
        windowNode,
        'dragOver',
        native,
        target,
        answer,
      );
      this._dispatchOver(windowNode, path, over);
    });
    this.acceptedAction = answer.action;
    return answer;
  }

  // -- the internal transport (a DragSession in this process) --------------
  //
  // Same session, same path diffing, same handlers — no wire. `e.source`
  // says 'internal', `e.items` carries live values, and the answer goes
  // back as a return value instead of an XdndStatus.

  localOver(rootX, rootY, offer, time) {
    this._source = 'internal';
    this.sourceWid = 0;
    this.types = offer.types;
    this.requestedAction = offer.action;
    const answer = this._overAt(rootX, rootY, time);
    return { accepted: answer.accept, action: answer.action };
  }

  localLeave() {
    if (this._source !== 'internal') return;
    discrete(() => this._clearPath())();
    this.accepted = null;
    this.lastPoint = null;
    this._source = 'external';
  }

  /** The internal drop: dispatch with the live extras a DragSession built
   * (`items`, prefetched `files`/`text`, a local `getData`). Synchronous
   * from the caller's point of view — `onDragEnd` follows immediately,
   * like the DOM's dragend after drop. */
  localDrop(offer, extras, time) {
    this._source = 'internal';
    this.types = offer.types;
    const point = this.lastPoint;
    const accepted = this.accepted;
    const action = this.acceptedAction;
    if (!accepted || accepted.destroyed || !point) {
      this.localLeave();
      return { handled: false, action: null };
    }
    discrete(() => {
      runWithPriority(DiscreteEventPriority, () => {
        const targetNode = this._dropTarget(point) ?? accepted;
        const drop = this._makeDragEvent(
          point.windowNode,
          'drop',
          {
            x: point.x,
            y: point.y,
            rootx: point.rootX,
            rooty: point.rootY,
            time,
            buttons: 0,
          },
          targetNode,
          null,
        );
        Object.assign(drop, extras);
        this._dispatchDrop(point.windowNode, targetNode, drop, []);
        this._clearPath();
      });
    })();
    this.accepted = null;
    this.lastPoint = null;
    this._source = 'external';
    return { handled: true, action };
  }

  _onLeave(ev) {
    if (ev.data[0] >>> 0 !== this.sourceWid) return;
    discrete(() => this._clearPath())();
    this.accepted = null;
    this.sourceWid = 0;
  }

  async _onDrop(ev, atoms) {
    if (ev.data[0] >>> 0 !== this.sourceWid) return;
    // captured now: a new drag may Enter while an async onDrop is still
    // settling, and the late XdndFinished must go to the *dropped* source
    const sourceWid = this.sourceWid;
    const version = this.version;
    const action = this.acceptedAction;
    const accepted = this.accepted;
    const point = this.lastPoint;
    if (!accepted || accepted.destroyed || !point) {
      this._sendFinished(atoms, sourceWid, version, { accepted: false });
      discrete(() => this._clearPath())();
      this._reset();
      return;
    }
    const time = ev.data[2] >>> 0;

    // Prefetch the common payloads so `e.files` / `e.text` read
    // synchronously in the handler; anything else stays behind
    // `await e.getData(type)`.
    let files = [];
    let text;
    try {
      if (typeMatches(this.types, 'files')) {
        const raw = await this._getData('text/uri-list', time);
        text = String(raw);
        files = parseUriList(raw);
      } else {
        const best = TEXT_TARGETS.find((t) => this.types.includes(t));
        if (best) text = await this._getData(best, time);
      }
    } catch {
      // conversion refused or timed out; the handler still runs with
      // getData available for retries of other types
    }

    const pending = [];
    discrete(() => {
      runWithPriority(DiscreteEventPriority, () => {
        const targetNode = this._dropTarget(point) ?? accepted;
        const drop = this._makeDragEvent(
          point.windowNode,
          'drop',
          {
            x: point.x,
            y: point.y,
            rootx: point.rootX,
            rooty: point.rootY,
            time,
            buttons: 0,
          },
          targetNode,
          null,
        );
        drop.files = files;
        drop.text = text;
        // `time` is captured, not read off the session: an async onDrop can
        // still be holding getData after a later drag has reset us
        drop.getData = (type) => this._getData(this._resolveType(type), time);
        this._dispatchDrop(point.windowNode, targetNode, drop, pending);
        this._clearPath();
      });
    })();

    // XdndFinished goes out when every handler promise settles, or when
    // the watchdog fires — whichever is first. Always.
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this._sendFinished(atoms, sourceWid, version, { accepted: true, action });
      // only clear session state if no new drag has entered meanwhile
      if (this.sourceWid === sourceWid) this._reset();
    };
    const timer = setTimeout(() => {
      if (process.env.NODE_ENV !== 'production' && !finished) {
        console.warn(
          'react-x11: onDrop has not settled after ' +
            `${DROP_TIMEOUT}ms; sending XdndFinished anyway so the drag ` +
            'source is not left hanging.',
        );
      }
      finish();
    }, DROP_TIMEOUT);
    timer.unref?.();
    Promise.allSettled(pending).then(finish);
  }

  /** The node under the last position, re-hit-tested at drop time — the
   * tree may have re-rendered between the last motion and the button
   * release. */
  _dropTarget(point) {
    const node = point.windowNode;
    if (node.destroyed) return null;
    return node.hitTest(point.x, point.y) ?? node;
  }

  // -- dispatch ------------------------------------------------------------

  /** Drag events ride the same synthetic-event shape as pointer events,
   * with the XDND extras flattened on. `answer` wires accept/reject/freeze
   * for dragOver; enter/leave/drop pass null and get inert versions. */
  _makeDragEvent(windowNode, type, native, target, answer) {
    const types = this.types;
    return windowNode.events._makeEvent(type, native, target, {
      types,
      has: (want) => typeMatches(types, want),
      action: this.requestedAction,
      source: this._source,
      screenX: native.rootx,
      screenY: native.rooty,
      accept: (action) => {
        if (!answer) return;
        answer.accept = true;
        if (action) answer.action = action;
      },
      reject: () => {
        if (answer) answer.accept = false;
      },
      freeze: () => {
        if (answer) answer.freeze = true;
      },
    });
  }

  /** Capture → target → bubble for onDragOver, sharing the path already
   * computed for the position. */
  _dispatchOver(windowNode, path, ev) {
    const events = windowNode.events;
    for (const n of path) {
      const handler = n.props.onDragOverCapture;
      if (handler) {
        ev.currentTarget = events._public(n);
        callHandler(n, 'onDragOverCapture', handler, ev);
        if (ev.propagationStopped) return;
      }
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const handler = path[i].props.onDragOver;
      if (handler) {
        ev.currentTarget = events._public(path[i]);
        callHandler(path[i], 'onDragOver', handler, ev);
        if (ev.propagationStopped) return;
      }
    }
  }

  /** onDrop dispatch that keeps the handlers' returned promises — the
   * XdndFinished watchdog needs them, and events.dispatch discards return
   * values. Same capture → target → bubble walk. */
  _dispatchDrop(windowNode, targetNode, ev, pending) {
    const events = windowNode.events;
    const nodePath = events._path(targetNode);
    const call = (n, name, handler) => {
      ev.currentTarget = events._public(n);
      try {
        const result = handler(ev);
        if (result && typeof result.then === 'function') pending.push(result);
      } catch (error) {
        reportHandlerError(n, name, error);
      }
    };
    for (const n of nodePath) {
      if (n.props.onDropCapture) {
        call(n, 'onDropCapture', n.props.onDropCapture);
        if (ev.propagationStopped) return;
      }
    }
    for (let i = nodePath.length - 1; i >= 0; i--) {
      if (nodePath[i].props.onDrop) {
        call(nodePath[i], 'onDrop', nodePath[i].props.onDrop);
        if (ev.propagationStopped) return;
      }
    }
  }

  // -- edge auto-scroll ----------------------------------------------------
  //
  // A drop target below the fold is otherwise unreachable: the pointer is
  // already at the bottom of the list, and a source that sees no motion
  // sends no more positions. So the timer, not the next position, is what
  // advances the drag — which is also why the suppression rectangle
  // (`e.freeze()`) is opt-in and off by default.

  /**
   * Aim the auto-scroll at whatever the pointer is over now, or stop it.
   * Called from every position update, so the velocity tracks the pointer
   * without the timer having to re-measure anything.
   */
  _updateAutoScroll(path, x, y) {
    const node = scrollerIn(path);
    const velocity = node?.abs ? edgeVelocity(node.abs, x, y) : null;
    if (!velocity) return this._stopAutoScroll();
    this._autoScroll = { node, ...velocity };
    // already stepping: the line above is the whole update
    if (this._autoScrollTimer) return;
    this._autoScrollTimer = setInterval(
      () => this._autoScrollStep(),
      AUTOSCROLL_INTERVAL,
    );
    // a drag must never be the reason a process cannot exit
    this._autoScrollTimer.unref?.();
  }

  _stopAutoScroll() {
    if (this._autoScrollTimer) clearInterval(this._autoScrollTimer);
    this._autoScrollTimer = null;
    this._autoScroll = null;
  }

  /**
   * One step. Re-routing after it is the point of the whole feature: the
   * content moved under a stationary pointer, so which node is hovered —
   * and whether it accepts — can differ from one step to the next.
   *
   * Nothing is sent to the source. An `XdndStatus` is the answer to an
   * `XdndPosition`, and an unsolicited one is not in the protocol; the next
   * real position carries the fresh answer instead.
   */
  _autoScrollStep() {
    const state = this._autoScroll;
    const point = this.lastPoint;
    if (!state || !point || state.node.destroyed) return this._stopAutoScroll();
    const { node, dx, dy } = state;
    // Nothing may escape a timer callback: there is no caller to catch it,
    // so a throw here would take the process down rather than end a drag.
    // The tree can be torn down between steps — a handler on the way past
    // is free to unmount whatever this was scrolling.
    try {
      const before = `${node.scrollX},${node.scrollY}`;
      node.scrollBy({ x: dx, y: dy });
      // at the limit: no movement, so nothing under the pointer changed and
      // there is nothing to re-route. The timer stays armed — the content
      // can still grow, and the pointer is still in the band.
      if (`${node.scrollX},${node.scrollY}` === before) return;
      this._overAt(point.rootX, point.rootY, point.time);
    } catch {
      this._stopAutoScroll();
    }
  }

  /** Enter/leave diffing over the drag path — the hover algorithm, with
   * `:drag-over` in place of `:hover`. Non-bubbling, like the DOM's. */
  _updateDragPath(newPath, native) {
    const oldPath = this.path;
    let common = 0;
    while (
      common < oldPath.length &&
      common < newPath.length &&
      oldPath[common] === newPath[common]
    ) {
      common++;
    }
    for (let i = oldPath.length - 1; i >= common; i--) {
      const n = oldPath[i];
      if (n.destroyed) continue;
      n.setStyleState(':drag-over', false);
      if (n.props.onDragLeave) {
        callHandler(
          n,
          'onDragLeave',
          n.props.onDragLeave,
          this._makeDragEvent(n.root, 'dragLeave', native, n, null),
        );
      }
    }
    for (let i = common; i < newPath.length; i++) {
      const n = newPath[i];
      n.setStyleState(':drag-over', true);
      if (n.props.onDragEnter) {
        callHandler(
          n,
          'onDragEnter',
          n.props.onDragEnter,
          this._makeDragEvent(n.root, 'dragEnter', native, n, null),
        );
      }
    }
    this.path = newPath;
  }

  _clearPath() {
    // every way a drag ends — leave, drop, reset — comes through here
    this._stopAutoScroll();
    const native = this.lastPoint
      ? {
          x: this.lastPoint.x,
          y: this.lastPoint.y,
          rootx: this.lastPoint.rootX,
          rooty: this.lastPoint.rootY,
          buttons: 0,
        }
      : { x: 0, y: 0, rootx: 0, rooty: 0, buttons: 0 };
    this._updateDragPath([], native);
  }

  // -- data ----------------------------------------------------------------

  /** One selection conversion, decoded for text-ish targets. ntk's
   * clipboard drives ConvertSelection + INCR reassembly.
   *
   * `time` is the timestamp from `XdndDrop`'s `l[2]`, which the protocol
   * says to convert with — never CurrentTime. Mainstream sources serve
   * whatever they currently offer and would not notice, but one that
   * validates the timestamp fails mysteriously, which is the worst failure
   * profile there is. */
  async _getData(target, time) {
    const clipboard = this.node.app.clipboard;
    if (!clipboard) throw new Error('react-x11: no clipboard on this app');
    const data = await clipboard.read({
      selection: 'XdndSelection',
      target,
      time,
    });
    return typeof data === 'string' ? data : decodeData(data, target);
  }

  /** `getData('files')` and friends: resolve a semantic group to the first
   * concretely offered member. */
  _resolveType(type) {
    const group = TYPE_GROUPS[type];
    if (!group) return type;
    return group.find((t) => this.types.includes(t)) ?? type;
  }

  // -- geometry ------------------------------------------------------------

  /** Root point → the deepest realized `<window>` under it (nested child
   * windows never advertise; the message lands here), in that window's
   * coordinates. */
  _routePoint(rootX, rootY) {
    const local = (wn) => {
      const origin = wn.window?._screenOrigin ?? {
        x: wn.window?.x ?? 0,
        y: wn.window?.y ?? 0,
      };
      return { x: rootX - origin.x, y: rootY - origin.y };
    };
    const descend = (wn) => {
      const kids = wn.children.filter(
        (c) => c.isWindow && !c.isPopup && c.window && !c.hidden,
      );
      // _xStack is bottom-to-top server order; hit the topmost first
      const order = [...kids].sort(
        (a, b) =>
          wn._xStack.indexOf(b.window.id) - wn._xStack.indexOf(a.window.id),
      );
      for (const child of order) {
        const p = local(child);
        if (
          p.x >= 0 &&
          p.y >= 0 &&
          p.x < (child.window.width ?? 0) &&
          p.y < (child.window.height ?? 0)
        ) {
          return descend(child);
        }
      }
      return wn;
    };
    const windowNode = descend(this.node);
    return { windowNode, ...local(windowNode) };
  }

  _windowRect() {
    const wnd = this.node.window;
    const origin = wnd?._screenOrigin ?? { x: wnd?.x ?? 0, y: wnd?.y ?? 0 };
    return {
      x: origin.x,
      y: origin.y,
      width: wnd?.width ?? 0,
      height: wnd?.height ?? 0,
    };
  }

  _nodeRect(node) {
    const wnd = node.root?.window;
    const origin = wnd?._screenOrigin ?? { x: wnd?.x ?? 0, y: wnd?.y ?? 0 };
    const abs = node.abs ?? { x: 0, y: 0, width: 0, height: 0 };
    return {
      x: origin.x + abs.x,
      y: origin.y + abs.y,
      width: abs.width,
      height: abs.height,
    };
  }

  // -- replies -------------------------------------------------------------

  /**
   * XdndStatus. `rect` null means "keep the positions coming" (flag bit 1
   * set, empty rectangle) — suppression silently breaks insertion carets
   * and edge auto-scroll, so it is opt-in via `e.freeze()`, plus the
   * automatic whole-window refusal when nothing is registered.
   */
  _sendStatus(atoms, { accept, action = 'copy', rect = null }) {
    const wid = this.node.window?.id;
    if (!wid || !this.sourceWid) return;
    const r = rect ?? { x: 0, y: 0, width: 0, height: 0 };
    this._send(this.sourceWid, atoms.XdndStatus, [
      wid,
      (accept ? 1 : 0) | (rect ? 0 : 2),
      (((r.x & 0xffff) << 16) | (r.y & 0xffff)) >>> 0,
      (((r.width & 0xffff) << 16) | (r.height & 0xffff)) >>> 0,
      accept ? actionAtom(atoms, action) : 0,
    ]);
  }

  _sendFinished(atoms, sourceWid, version, { accepted, action = 'copy' }) {
    const wid = this.node.window?.id;
    if (!wid || !sourceWid || version < 2) return;
    const v5 = version >= 5;
    this._send(sourceWid, atoms.XdndFinished, [
      wid,
      v5 && accepted ? 1 : 0,
      v5 && accepted ? actionAtom(atoms, action) : 0,
      0,
      0,
    ]);
  }

  /** Replies address the source window with event mask 0 — delivered to
   * its owner client, per ICCCM SendEvent semantics for client-to-client
   * messages. */
  _send(destWid, typeAtom, data) {
    try {
      this.X.SendClientMessage(destWid, destWid, typeAtom, 32, data, 0);
    } catch {
      // the source died mid-drag; its ClientMessages stop arriving too
    }
  }
}

// ---------------------------------------------------------------------------
// The drag source.
//
// One drag session, two transports (docs/architecture/drag-and-drop.md §6.3):
// while the pointer is over this process's own windows the drag is local —
// no wire, live JS payloads, the DropSession above delivering to the same
// handlers with `e.source === 'internal'`. The moment it leaves them, the
// session promotes to XDND: the payload is published on XdndSelection
// through ntk's clipboard, the foreign target is found by descending from
// the root, and Enter/Position/Leave/Drop go out. Handlers cannot tell the
// transports apart except by asking.
// ---------------------------------------------------------------------------

/** DOM-ish drag threshold: a press is a click until it moves this far. */
const DRAG_THRESHOLD = 4;
/** How long to wait for a target's XdndFinished before ending the drag
 * anyway — the mirror of the drop side's watchdog. */
const FINISH_TIMEOUT = 5_000;
/** ButtonPress | ButtonRelease | PointerMotion: what the active grab must
 * keep selecting when the cursor is swapped mid-drag. */
const GRAB_EVENT_MASK = 4 | 8 | 64;

export function hasDragProps(props) {
  return Boolean(props?.draggable);
}

// Realized top-level WindowNodes per app: "is this root point over one of
// our windows" is the internal/external transport switch, and the same set
// answers internal cross-window routing.
const appTopLevels = new WeakMap();

export function registerTopLevel(windowNode) {
  const app = windowNode.app;
  let set = appTopLevels.get(app);
  if (!set) appTopLevels.set(app, (set = new Set()));
  set.add(windowNode);
}

export function forgetTopLevel(windowNode) {
  appTopLevels.get(windowNode.app)?.delete(windowNode);
}

/** The top-level under a root point. Popups sit above plain windows and a
 * later realization above an earlier one — a heuristic, since the server
 * owns top-level stacking; good enough for drags. A `<popup dragPreview>`
 * follows the pointer by design and must never be the thing under it. */
function topLevelAt(app, rootX, rootY) {
  const set = appTopLevels.get(app);
  if (!set) return null;
  let hit = null;
  for (const node of set) {
    if (node.destroyed || !node.window || node.props.dragPreview) continue;
    const wnd = node.window;
    const origin = wnd._screenOrigin ?? { x: wnd.x ?? 0, y: wnd.y ?? 0 };
    if (
      rootX >= origin.x &&
      rootY >= origin.y &&
      rootX < origin.x + (wnd.width ?? 0) &&
      rootY < origin.y + (wnd.height ?? 0)
    ) {
      if (!hit || node.isPopup || !hit.isPopup) hit = node;
    }
  }
  return hit;
}

/** Called on every button-1 press (events.js): the nearest draggable
 * ancestor of the hit node arms the window's DragSession, or nothing
 * happens at all. */
export function armDrag(windowNode, target, native) {
  let source = null;
  for (
    let n = target;
    n;
    n = n === windowNode ? null : (n.parent ?? windowNode)
  ) {
    if (hasDragProps(n.props) && !n.props.disabled) {
      source = n;
      break;
    }
    if (n === windowNode) break;
  }
  if (!source) return null;
  const session = (windowNode._dragSession ??= new DragSession(windowNode));
  session.arm(source, native);
  return session;
}

const isBinaryData = (v) =>
  Buffer.isBuffer(v) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer;

function internAtom(X, name) {
  return new Promise((resolve, reject) =>
    X.InternAtom(false, name, (err, atom) =>
      err ? reject(err) : resolve(atom),
    ),
  );
}

export class DragSession {
  constructor(windowNode) {
    this.node = windowNode;
    this.app = windowNode.app;
    this.X = windowNode.app.X;
    this._reset();
  }

  _reset() {
    this.phase = 'idle'; // 'idle' | 'armed' | 'dragging'
    this.source = null;
    this.press = null;
    this.types = [];
    this.actions = ['copy'];
    this.currentAction = 'copy';
    this.accepted = false;
    this.localSession = null;
    this._data = null;
    this._resolved = null;
    this._published = false;
    this._typeAtoms = null;
    this._atoms = null;
    this._cursor = null;
    this.ext = null;
  }

  /** The pressed node (or an ancestor) is draggable: remember where, and
   * wait for the threshold. Below it, the gesture is still a click. */
  arm(source, native) {
    this._reset();
    this.phase = 'armed';
    this.source = source;
    this.press = {
      x: native.x,
      y: native.y,
      rootx: native.rootx ?? native.x,
      rooty: native.rooty ?? native.y,
      time: (native.time ?? 0) >>> 0,
    };
  }

  cancel() {
    if (this.phase === 'dragging') {
      this.source?.setStyleState?.(':dragging', false);
      this.localSession?.localLeave();
    }
    this._reset();
  }

  /** A node leaving the tree mid-gesture: abort rather than dangle. */
  forget(node) {
    if (this.source === node) this.cancel();
  }

  /** Every mousemove while armed or dragging. Returns true when the drag
   * consumed the motion — the caller then skips hover and mousemove. */
  motion(native) {
    if (this.phase === 'armed') {
      const moved =
        Math.abs(native.x - this.press.x) + Math.abs(native.y - this.press.y);
      if (moved < DRAG_THRESHOLD) return false;
      if (!this._start(native)) return false;
    }
    if (this.phase !== 'dragging') return false;
    this._feed(native);
    return true;
  }

  _start(native) {
    const source = this.source;
    if (!source || source.destroyed) {
      this._reset();
      return false;
    }
    this._data = source.props.dragData ?? {};
    this.types = Object.keys(this._data);
    const actions = source.props.dragActions;
    this.actions =
      Array.isArray(actions) && actions.length > 0 ? actions : ['copy'];
    this.currentAction = this.actions[0];
    this._resolved = new Map();
    const ev = this.node.events.dispatch('DragStart', source, native, {
      types: this.types,
      action: this.currentAction,
      source: 'internal',
      screenX: native.rootx ?? native.x,
      screenY: native.rooty ?? native.y,
    });
    if (ev.defaultPrevented) {
      this._reset();
      return false;
    }
    this.phase = 'dragging';
    source.setStyleState(':dragging', true);
    this._setCursor('grab');
    return true;
  }

  /** dragData values resolve once per drag: thunks are called on first
   * use — at delivery for an internal drop, at promotion for an external
   * one — and never at mousedown. */
  _resolve(type) {
    if (!this._resolved.has(type)) {
      const value = this._data[type];
      this._resolved.set(type, typeof value === 'function' ? value() : value);
    }
    return this._resolved.get(type);
  }

  _offer() {
    return {
      types: this.types,
      action: this.actions[0],
      source: 'internal',
    };
  }

  /** What an internal drop event carries beyond the external one: the live
   * values themselves, plus the same prefetched `files`/`text` shape so a
   * handler cannot tell the transports apart unless it asks. */
  _dropExtras() {
    const items = {};
    for (const t of this.types) items[t] = this._resolve(t);
    let files = [];
    const uriType = this.types.find((t) => TYPE_GROUPS.files.includes(t));
    if (uriType) {
      const v = this._resolve(uriType);
      if (typeof v === 'string') files = parseUriList(v);
    }
    let text;
    const best = TEXT_TARGETS.find((t) => this.types.includes(t));
    if (best) {
      const v = this._resolve(best);
      if (typeof v === 'string') text = v;
    }
    const getData = (type) => {
      const group = TYPE_GROUPS[type];
      const concrete = group
        ? (this.types.find((t) => group.includes(t)) ?? type)
        : type;
      return Promise.resolve(this._resolve(concrete));
    };
    return { items, files, text, getData };
  }

  _feed(native) {
    const rootX = native.rootx ?? native.x;
    const rootY = native.rooty ?? native.y;
    const over = topLevelAt(this.app, rootX, rootY);
    if (over?._dnd) {
      // internal: deliver through the window's own DropSession
      if (this.ext?.current) this._extLeave();
      if (this.localSession && this.localSession !== over._dnd) {
        this.localSession.localLeave();
      }
      this.localSession = over._dnd;
      const result = this.localSession.localOver(
        rootX,
        rootY,
        this._offer(),
        (native.time ?? 0) >>> 0,
      );
      this.accepted = result.accepted;
      if (result.accepted) this.currentAction = result.action;
      this._setCursor(result.accepted ? 'grab' : 'not-allowed');
    } else {
      // external: over a foreign window (or nothing)
      if (this.localSession) {
        this.localSession.localLeave();
        this.localSession = null;
        this.accepted = false;
      }
      this._extMotion(rootX, rootY, (native.time ?? 0) >>> 0);
    }
    const source = this.source;
    if (source && !source.destroyed && source.props.onDrag) {
      callHandler(
        source,
        'onDrag',
        source.props.onDrag,
        this.node.events._makeEvent('drag', native, source, {
          types: this.types,
          action: this.currentAction,
          source: this.localSession ? 'internal' : 'external',
          accepted: this.accepted,
          screenX: rootX,
          screenY: rootY,
        }),
      );
    }
  }

  /** Button release. Returns true when a drag ran (the caller suppresses
   * mouseup/click, like the DOM after a drag gesture). */
  release(native) {
    if (this.phase !== 'dragging') {
      this._reset();
      return false;
    }
    const source = this.source;
    source?.setStyleState?.(':dragging', false);
    if (this.localSession) {
      let outcome = { handled: false, action: null };
      if (this.accepted) {
        outcome = this.localSession.localDrop(
          this._offer(),
          this._dropExtras(),
          (native.time ?? 0) >>> 0,
        );
      } else {
        this.localSession.localLeave();
      }
      this._end(
        native,
        outcome.handled ? outcome.action : null,
        outcome.handled,
      );
    } else if (this.ext?.current && this.accepted) {
      this._extDrop(native); // async: onDragEnd follows XdndFinished
    } else {
      if (this.ext?.current) this._extLeave();
      this._end(native, null, false);
    }
    return true;
  }

  _end(native, action, dropped) {
    const source = this.source;
    if (this._published) this._disown();
    if (source && !source.destroyed) {
      this.node.events.dispatch('DragEnd', source, native, {
        types: this.types,
        action,
        dropped,
        source: 'internal',
        screenX: native.rootx ?? native.x ?? 0,
        screenY: native.rooty ?? native.y ?? 0,
      });
    }
    this._reset();
  }

  /** Swap the active grab's cursor (X ChangeActivePointerGrab works on the
   * implicit button grab too). Core-font approximations — see the doc's
   * XCursor caveat; the mask must keep selecting motion and release or the
   * gesture goes silent. */
  _setCursor(name) {
    if (name === this._cursor) return;
    const X = this.X;
    if (typeof X.ChangeActivePointerGrab !== 'function') return;
    const cursors = this.app.cursors;
    if (!cursors?.get) return;
    try {
      X.ChangeActivePointerGrab(cursors.get(name), 0, GRAB_EVENT_MASK);
      this._cursor = name;
    } catch {
      // no cursor feedback is a cosmetic failure, never a functional one
    }
  }

  // -- the external transport (XDND out) -----------------------------------

  /** First motion outside our windows: publish the payload. Thunks resolve
   * now; live objects are JSON-serialised for the wire (internal drops got
   * them by reference). ntk's clipboard owns XdndSelection and serves the
   * conversions, INCR included. */
  async _publish() {
    if (this._published) return;
    this._published = true;
    this._atoms = await dndAtoms(this.X);
    this._typeAtoms = await Promise.all(
      this.types.map((t) => internAtom(this.X, t)),
    );
    const map = {};
    for (const t of this.types) {
      let v = this._resolve(t);
      if (typeof v !== 'string' && !isBinaryData(v)) v = JSON.stringify(v);
      map[t] = v;
    }
    const clipboard = this.app.clipboard;
    if (clipboard && this.types.length > 0) {
      await clipboard.write(map, {
        selection: 'XdndSelection',
        ...(this.press.time ? { time: this.press.time } : {}),
      });
    }
    if (
      this._typeAtoms.length > 3 &&
      typeof this.node.window?.setProperty === 'function'
    ) {
      await this.node.window.setProperty('XdndTypeList', this._typeAtoms, {
        type: 'ATOM',
      });
    }
  }

  /** Positions are serialized behind the publish and the async target
   * descent; only the newest queued point is ever resolved, so a motion
   * burst costs one descent, not one per event. */
  _extMotion(rootX, rootY, time) {
    const ext = (this.ext ??= {
      current: null,
      queue: null,
      busy: false,
      suppress: null,
      finish: null,
    });
    ext.queue = { rootX, rootY, time };
    if (ext.busy) return;
    ext.busy = true;
    (async () => {
      try {
        await this._publish();
        while (this.ext?.queue && this.phase === 'dragging') {
          const point = this.ext.queue;
          this.ext.queue = null;
          await this._extStep(point);
        }
      } catch {
        // connection teardown mid-drag
      } finally {
        if (this.ext) this.ext.busy = false;
      }
    })();
  }

  async _extStep({ rootX, rootY, time }) {
    const atoms = this._atoms;
    const found = await this._findTarget(rootX, rootY);
    const ext = this.ext;
    if (!ext || this.phase !== 'dragging') return;
    const current = ext.current;
    if ((found?.wid ?? 0) !== (current?.wid ?? 0)) {
      if (current) {
        this._sendTo(current.sendWid, atoms.XdndLeave, [
          this.node.window.id,
          0,
          0,
          0,
          0,
        ]);
      }
      ext.current = found;
      ext.suppress = null;
      this.accepted = false;
      this._setCursor('not-allowed');
      if (found) {
        const flags =
          ((XDND_VERSION << 24) | (this.types.length > 3 ? 1 : 0)) >>> 0;
        const t = this._typeAtoms ?? [];
        this._sendTo(found.sendWid, atoms.XdndEnter, [
          this.node.window.id,
          flags,
          t[0] ?? 0,
          t[1] ?? 0,
          t[2] ?? 0,
        ]);
      }
    }
    if (!ext.current) return;
    const s = ext.suppress;
    if (
      s &&
      rootX >= s.x &&
      rootY >= s.y &&
      rootX < s.x + s.width &&
      rootY < s.y + s.height
    ) {
      return; // the target asked for silence inside this rectangle
    }
    this._sendTo(ext.current.sendWid, atoms.XdndPosition, [
      this.node.window.id,
      0,
      (((rootX & 0xffff) << 16) | (rootY & 0xffff)) >>> 0,
      time >>> 0,
      actionAtom(atoms, this.actions[0]),
    ]);
  }

  /**
   * The XDND target under a root point: descend the window tree with
   * TranslateCoordinates, checking XdndAware at each level (since v3 it is
   * on the top-level client window, which under a reparenting WM sits a
   * level or two below the frame). XdndProxy redirects the sends. Per
   * motion and uncached — 2–4 round trips, fine locally; the drag-start
   * window cache from the design doc is the remote-X follow-up.
   */
  async _findTarget(rootX, rootY) {
    const root = this.X.display?.screen?.[0]?.root;
    if (root == null) return null;
    let wid = root;
    for (let depth = 0; depth < 16; depth++) {
      const child = await this._translate(root, wid, rootX, rootY);
      if (!child) return null;
      if (this._isOurs(child)) return null;
      const aware = await this._readAware(child);
      if (aware) {
        return {
          wid: child,
          sendWid: aware.proxy || child,
          version: Math.min(XDND_VERSION, aware.version),
        };
      }
      wid = child;
    }
    return null;
  }

  _translate(srcWid, dstWid, x, y) {
    return new Promise((resolve) => {
      this.X.TranslateCoordinates(srcWid, dstWid, x, y, (err, res) =>
        resolve(err ? 0 : (res?.child ?? 0)),
      );
    });
  }

  _isOurs(wid) {
    const set = appTopLevels.get(this.app);
    if (!set) return false;
    for (const node of set) {
      if (node.window?.id === wid) return true;
    }
    return false;
  }

  _readAware(wid) {
    const atoms = this._atoms;
    const read = (atom) =>
      new Promise((resolve) => {
        this.X.GetProperty(0, wid, atom, 0, 0, 4, (err, prop) =>
          resolve(
            err || !prop?.data || prop.data.length < 4 ? null : prop.data,
          ),
        );
      });
    return Promise.all([read(atoms.XdndAware), read(atoms.XdndProxy)]).then(
      ([aware, proxy]) =>
        aware
          ? {
              version: aware.readUInt32LE(0),
              proxy: proxy ? proxy.readUInt32LE(0) : 0,
            }
          : null,
    );
  }

  /** XdndStatus / XdndFinished sent back by the foreign target, routed here
   * from the source window's 'message' listener. */
  handleMessage(ev) {
    if (ev.format !== 32) return;
    const atoms = dndAtomsOf(this.X);
    if (!atoms) return; // cannot be ours: we intern before we publish
    if (ev.message_type === atoms.XdndStatus) this._onStatus(ev, atoms);
    else if (ev.message_type === atoms.XdndFinished) this._onFinished(ev);
  }

  _onStatus(ev, atoms) {
    const ext = this.ext;
    if (!ext?.current || ev.data[0] >>> 0 !== ext.current.wid) return;
    const accept = Boolean(ev.data[1] & 1);
    this.accepted = accept;
    if (accept) this.currentAction = actionName(atoms, ev.data[4] >>> 0);
    const wantInside = Boolean(ev.data[1] & 2);
    const rw = ev.data[3] >>> 16;
    const rh = ev.data[3] & 0xffff;
    ext.suppress =
      wantInside || (rw === 0 && rh === 0)
        ? null
        : {
            x: ev.data[2] >>> 16,
            y: ev.data[2] & 0xffff,
            width: rw,
            height: rh,
          };
    this._setCursor(accept ? 'grab' : 'not-allowed');
  }

  _onFinished(ev) {
    const ext = this.ext;
    if (ext?.finish) {
      const finish = ext.finish;
      ext.finish = null;
      finish({
        accepted: Boolean(ev.data[1] & 1),
        actionAtom: ev.data[2] >>> 0,
      });
    }
  }

  _extLeave() {
    const ext = this.ext;
    if (!ext?.current || !this._atoms) return;
    this._sendTo(ext.current.sendWid, this._atoms.XdndLeave, [
      this.node.window.id,
      0,
      0,
      0,
      0,
    ]);
    ext.current = null;
    ext.suppress = null;
    this.accepted = false;
  }

  _extDrop(native) {
    const ext = this.ext;
    const atoms = this._atoms;
    const target = ext.current;
    this._sendTo(target.sendWid, atoms.XdndDrop, [
      this.node.window.id,
      0,
      (native.time ?? 0) >>> 0,
      0,
      0,
    ]);
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (this.ext) this.ext.finish = null;
      // pre-v5 XdndFinished carries no verdict: treat silence and old
      // versions as "done, with the action the status negotiated"
      const rejected = result != null && result.accepted === false;
      const action =
        result?.accepted && target.version >= 5 && result.actionAtom
          ? actionName(atoms, result.actionAtom)
          : this.currentAction;
      this._end(native, rejected ? null : action, !rejected);
    };
    const timer = setTimeout(() => finish(null), FINISH_TIMEOUT);
    timer.unref?.();
    if (target.version >= 2) ext.finish = finish;
    else finish(null);
  }

  /** Give XdndSelection up at drag end. Ownership is otherwise held until
   * someone else drags — harmless, except that a stale offer answered long
   * after XdndFinished is exactly what the spec warns about.
   *
   * `clipboard.clear()` rather than a raw `SetSelectionOwner` (ntk >= 5.4.0):
   * it releases with the timestamp the selection was acquired with, as ICCCM
   * 2.3.1 requires, so a drag that has already lost XdndSelection to another
   * client leaves it alone — where CurrentTime would have taken it away from
   * them. It also keeps ntk's own record of what it owns in step, instead of
   * waiting for the SelectionClear to come back and say so. */
  _disown() {
    // Nothing here may throw: `_end` calls this before dispatching DragEnd,
    // so a throw would cost the app the end of its own drag.
    try {
      this.app?.clipboard?.clear('XdndSelection')?.catch(() => {});
    } catch {
      // a connection already closing
    }
  }

  _sendTo(destWid, typeAtom, data) {
    try {
      this.X.SendClientMessage(destWid, destWid, typeAtom, 32, data, 0);
    } catch {
      // the target died mid-drag
    }
  }
}
