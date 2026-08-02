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
    this.sourceWid = 0;
    this.version = 0;
    this.types = [];
    this.path = [];
    this.accepted = null;
    this.acceptedAction = 'copy';
    this.requestedAction = 'copy';
    this.lastPoint = null;
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
    this._sendStatus(atoms, {
      accept: answer.accept,
      action: answer.action,
      rect: answer.freeze && accepted ? this._nodeRect(accepted) : null,
    });
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
        const raw = await this._getData('text/uri-list');
        text = String(raw);
        files = parseUriList(raw);
      } else {
        const best = TEXT_TARGETS.find((t) => this.types.includes(t));
        if (best) text = await this._getData(best);
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
        drop.getData = (type) => this._getData(this._resolveType(type));
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
      source: 'external',
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
   * clipboard drives ConvertSelection + INCR reassembly; note it converts
   * with CurrentTime rather than the drop timestamp (`read` has no time
   * option yet) — fine for every mainstream source, which serves whatever
   * it currently offers. */
  async _getData(target, _time) {
    const clipboard = this.node.app.clipboard;
    if (!clipboard) throw new Error('react-x11: no clipboard on this app');
    const data = await clipboard.read({
      selection: 'XdndSelection',
      target,
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
