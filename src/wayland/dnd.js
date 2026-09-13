// Drag and drop on the Wayland backend — the DnD half of `wl_data_device`,
// both directions, over the same device object the clipboard already binds
// (src/wayland/clipboard.js hands it out as `dataDevice`). The `dropAccept` /
// `onDrag*` / `dragData` prop contract is the tree's (src/dnd.js); what this
// file owns is the translation between Wayland's data-device vocabulary and
// that of `DropSession`/`DragSession`, in both directions — the same job
// src/cocoa/dnd.js does for AppKit.
//
// ## The drop side
//
// A drag from another application arrives as `wl_data_device.enter` /
// `motion` / `leave` / `drop`, carrying a `wl_data_offer` that lists its MIME
// types. Those four are mapped onto `DropSession.localOver` / `localLeave` /
// `localDrop`, driven with an offer flagged `source: 'external'`, so the path
// diffing, `:drag-over`, `dropAccept` matching and the handler dispatch are
// the one implementation across every backend. The answer goes straight back
// on the offer: `wl_data_offer.accept(serial, mime)` (or an empty mime to
// refuse — the wire codec cannot encode a true null string, and an empty one
// names no type the source offered) and `set_actions`.
//
// Coordinates arrive surface-local and logical, measured from the whole
// surface including the client-side frame; the tree wants content-relative
// device pixels. One function subtracts the frame insets and multiplies by
// the scale, exactly as input.js does for the pointer — and a position over
// the titlebar or borders is outside the content, so it reads as a leave.
//
// The payload is read at the drop, eagerly, like the cocoa transport: for
// each offered type a pipe is handed to `wl_data_offer.receive` and drained
// to EOF, and `getData` then answers from that map. Only once the data is in
// hand is `wl_data_offer.finish` sent (data_device_manager v3) and the offer
// destroyed — the order the protocol requires.
//
// ## The drag source
//
// Once the renderer's threshold says a press is a drag, `DragSession._start`
// finds this backend has a session of its own (`WaylandBackendWindow`
// exposes `beginDrag`) and hands it the gesture. `beginDrag` creates a
// `wl_data_source`, offers every type, and calls `wl_data_device.start_drag`
// with the press serial. From there the compositor owns the pointer: motion
// and release stop arriving as pointer events, and the drag reports back on
// the source — `target`/`action` as it moves over accepting surfaces,
// `dnd_drop_performed`/`dnd_finished` on a completed drop, `cancelled`
// otherwise. Those end the `DragSession` the way cocoa's `_routeDragEnded`
// does. A drop on one of *our own* surfaces comes back through the data
// device's `enter`/`motion`/`drop` — the same drop side above — and is routed
// to the live `DragSession` (`app._activeDrag`) so an in-app drop keeps
// `e.items` by reference and `e.source === 'internal'`, exactly as the X11
// and cocoa transports do for a local drop.
//
// ## The drag icon
//
// `start_drag` takes an *icon surface*, not a popup: a Wayland popup cannot
// follow a drag, so the tree's `<popup dragPreview>` has no place here. The
// protocol's answer is a role-less `wl_surface` the compositor positions
// under the pointer. The wire codec cannot encode the null the protocol
// otherwise allows for "no icon", so a bare (bufferless) surface is created
// and passed instead — valid, and invisible until a buffer is attached.
// Rendering the tree's `<popup dragPreview>` into that icon surface (a
// role-less `wl_surface` the frame loop paints, in place of an xdg_popup) is
// the remaining step, left as a follow-up.
//
// ## Types
//
// Wayland types are MIME already, so there is no atom/UTI table to cross as
// there is on the other backends — only the `text/plain` beside
// `text/plain;charset=utf-8` convention the whole project keeps, so a
// `dropAccept: ['text/plain']` matches a GTK source that spells it with the
// charset, and a source that offers plain text is offered under both.

import { makePipe, readAll, writeAll, closeFd } from './fdutil.js';
import { TEXT_TARGETS, parseUriList, resolveType } from '../transfer.js';

/** `wl_data_device_manager.dnd_action` bits. */
const ACTION = { none: 0, copy: 1, move: 2, ask: 4 };
/** What a drop target says it can do: copy or move (link has no Wayland bit). */
const ACTIONS_WE_TAKE = ACTION.copy | ACTION.move;

/** The best of a `dnd_action` mask, in react-x11's words. Move wins over
 * copy the way a compositor's own negotiation prefers it; `ask` and an empty
 * mask fall back to copy, which is every source's least-surprising default. */
function actionName(mask) {
  if (mask & ACTION.move) return 'move';
  if (mask & ACTION.copy) return 'copy';
  if (mask & ACTION.ask) return 'ask';
  return 'copy';
}

/** One react-x11 action name as a `dnd_action` bit. `link` has no Wayland
 * equivalent, so it travels as copy. */
function actionBit(name) {
  if (name === 'move') return ACTION.move;
  return ACTION.copy;
}

/** The action mask a source advertises for its allowed actions. */
function actionMask(names) {
  let mask = 0;
  for (const name of names ?? []) mask |= actionBit(name);
  return mask || ACTION.copy;
}

const TEXT_ALIASES = ['text/plain;charset=utf-8', 'text/plain'];

/** Narrow: only the plain-text spellings, for the source alias convention —
 * a `text/plain` source is also offered as `text/plain;charset=utf-8`, but a
 * `text/uri-list` one is not. */
function isTextMime(mime) {
  return (
    mime === 'text/plain' ||
    mime.startsWith('text/plain;') ||
    TEXT_TARGETS.includes(mime)
  );
}

/** Broad: every `text/*` flavour, for deciding whether received bytes decode
 * to a string — the same rule transfer.js's `decodeData` applies. */
function isTextual(mime) {
  return TEXT_TARGETS.includes(mime) || /^text\//i.test(mime);
}

/** What a data offer's MIME list is in react-x11's vocabulary: the types as
 * offered, with `text/plain` surfaced beside a `text/plain;charset=utf-8` so
 * a `dropAccept: ['text/plain']` matches the charset spelling GTK/Qt use. */
export function offeredTypes(mimes) {
  const out = [];
  const add = (t) => t && !out.includes(t) && out.push(t);
  for (const mime of mimes ?? []) {
    add(mime);
    if (mime === 'text/plain;charset=utf-8') add('text/plain');
  }
  return out;
}

/** The MIME types a source offers for a session's payload: every declared
 * type, plus both text spellings when either is present, so a plain-text
 * source still satisfies a `text/plain;charset=utf-8` target. Returns a map
 * from the offered MIME back to the session type that resolves it. */
export function sourceOffers(session) {
  const map = {};
  for (const type of session.types) {
    map[type] = type;
    if (isTextMime(type)) {
      for (const alias of TEXT_ALIASES) if (!(alias in map)) map[alias] = type;
    }
  }
  return map;
}

/** A value as the wire carries it: strings and bytes as they are, anything
 * else as JSON — the same rule the X and cocoa transports apply. */
export function wireBytes(value) {
  if (value == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.from(JSON.stringify(value), 'utf8');
}

/**
 * Surface-local logical coordinates → content-relative device pixels, or
 * null when the point is over the client-side frame (titlebar or border),
 * which is outside the content and reads as a leave. Mirrors input.js's
 * `_point`, minus nothing: the frame test is the same insets the pointer
 * router uses.
 */
function contentPoint(win, x, y) {
  const i = win.insets ?? { top: 0, left: 0, right: 0, bottom: 0 };
  const s = win.scale ?? 1;
  if (x < i.left || y < i.top) return null;
  return { x: Math.round((x - i.left) * s), y: Math.round((y - i.top) * s) };
}

/**
 * The app-wide drag-and-drop object, one per connection, created after the
 * clipboard so it can share its `wl_data_device` (the DnD events arrive on
 * the same object the clipboard's selection events do).
 */
export class WaylandDnd {
  /**
   * @param {object} opts
   * @param {import('./app.js').WaylandApp} opts.app
   * @param {object} opts.device the shared `wl_data_device`
   * @param {object} opts.manager the `wl_data_device_manager`
   * @param {import('./seat.js').WaylandSeat} opts.seat
   */
  constructor({ app, device, manager, seat }) {
    this.app = app;
    this.device = device;
    this.manager = manager;
    this.seat = seat;
    /** wl_surface id -> { window, session, node } for each drop target */
    this._targets = new Map();
    /** wl_data_offer id -> { offer, types, sourceActions, action, enterSerial } */
    this._offers = new Map();
    /** the drag currently over one of our surfaces, or null */
    this._incoming = null;
    /** our own outgoing drag, or null */
    this._source = null;
    this._wire();
  }

  _wire() {
    const d = this.device;
    // A second `data_offer` listener beside the clipboard's: both track the
    // offer's types, and only the matching gesture (a `selection` for the
    // clipboard, an `enter` for a drag) consumes what it collected.
    d.on('data_offer', (offer) => this._trackOffer(offer));
    d.on('enter', (serial, surface, x, y, offer) =>
      this._onEnter(serial, surface, x, y, offer),
    );
    d.on('motion', (time, x, y) => this._onMotion(time, x, y));
    d.on('leave', () => this._onLeave());
    d.on('drop', () => this._onDrop());
  }

  // ---- drop targets -------------------------------------------------------

  /** A window's `attachDropTransport` registers here: its surface routes to
   * this DropSession. */
  attach(window, session, node) {
    this._targets.set(window.wl.surface.id, { window, session, node });
  }

  detach(window) {
    this._targets.delete(window.wl.surface.id);
  }

  // ---- the drop side ------------------------------------------------------

  _trackOffer(offer) {
    const state = {
      offer,
      types: [],
      sourceActions: 0,
      action: 0,
      enterSerial: 0,
    };
    this._offers.set(offer.id, state);
    offer.on('offer', (mime) => state.types.push(mime));
    offer.on('source_actions', (mask) => {
      state.sourceActions = mask;
    });
    offer.on('action', (mask) => {
      state.action = mask;
    });
  }

  /** The live drag in this process, when it is ours that is over our own
   * window — the analogue of cocoa's `ev.local`. Only ever non-null while
   * this client is the drag source (`DragSession` set `app._activeDrag`). */
  _localDrag() {
    const drag = this.app._activeDrag;
    return drag && drag._nativeSession ? drag : null;
  }

  _onEnter(serial, surfaceId, x, y, offerObj) {
    const offerId = offerObj?.id ?? offerObj ?? 0;
    const state = this._offers.get(offerId) ?? null;
    const target = this._targets.get(surfaceId) ?? null;
    if (state) state.enterSerial = serial; // accept/refuse quote the enter
    if (!target || !state) {
      // Not one of our drop-capable surfaces (or an offer we never saw the
      // types of): refuse so the compositor shows no-drop, and forget it.
      if (state) this._reject(state);
      this._incoming = null;
      return;
    }
    this._incoming = { target, state };
    this._over(x, y, Date.now());
  }

  _onMotion(time, x, y) {
    if (this._incoming) this._over(x, y, time >>> 0 || Date.now());
  }

  _over(x, y, time) {
    const inc = this._incoming;
    if (!inc) return;
    const { target, state } = inc;
    const point = contentPoint(target.window, x, y);
    if (!point) {
      // over the frame: outside the content, so leave the tree and refuse
      target.session.localLeave();
      const drag = this._localDrag();
      if (drag) drag.accepted = false;
      this._reject(state);
      return;
    }
    const drag = this._localDrag();
    const offer = drag
      ? drag._offer()
      : {
          types: offeredTypes(state.types),
          action: actionName(state.action || state.sourceActions),
          source: 'external',
        };
    const answer = target.session.localOver(point.x, point.y, offer, time);
    if (drag) {
      drag.accepted = answer.accepted;
      if (answer.accepted) drag.currentAction = answer.action;
    }
    if (answer.accepted) this._accept(state, answer.action);
    else this._reject(state);
  }

  _onLeave() {
    const inc = this._incoming;
    this._incoming = null;
    if (!inc) return;
    inc.target.session.localLeave();
    const drag = this._localDrag();
    if (drag) drag.accepted = false;
    this._destroyOffer(inc.state);
  }

  _onDrop() {
    const inc = this._incoming;
    this._incoming = null;
    if (!inc) return;
    const { target, state } = inc;
    const drag = this._localDrag();
    if (drag) {
      // in-app: the live payload by reference, no pipes and no receive
      const outcome = target.session.localDrop(
        drag._offer(),
        drag._dropExtras(),
        Date.now(),
      );
      if (outcome.handled) {
        drag.currentAction = outcome.action;
        this._finishOffer(state, outcome.action);
      } else {
        this._destroyOffer(state);
      }
      return;
    }
    void this._externalDrop(target, state);
  }

  /**
   * Read every offered type over a pipe, drain each to EOF, then dispatch the
   * drop with the assembled payload and, only if a handler took it, finish
   * the offer. Reading eagerly (rather than lazily behind `getData`) is what
   * lets `finish` be sent — the protocol requires the data to be in hand
   * first, and the offer is gone the moment it is.
   */
  async _externalDrop(target, state) {
    const types = offeredTypes(state.types);
    const values = {};
    for (const mime of state.types) {
      try {
        const { read, write } = makePipe();
        state.offer.$.receive(mime, write);
        const bytes = await readAll(read);
        values[mime] = isTextual(mime) ? bytes.toString('utf8') : bytes;
        if (
          mime === 'text/plain;charset=utf-8' &&
          values['text/plain'] === undefined
        ) {
          values['text/plain'] = values[mime];
        }
      } catch {
        // a type the source could not actually convert to; skip it
      }
    }
    const files = values['text/uri-list']
      ? parseUriList(values['text/uri-list'])
      : [];
    const best = TEXT_TARGETS.find((t) => values[t] !== undefined);
    const extras = {
      items: values,
      files,
      text: best ? values[best] : undefined,
      getData: (type) =>
        Promise.resolve(values[resolveType(type, types)] ?? null),
    };
    const action = actionName(state.action || state.sourceActions);
    const outcome = target.session.localDrop(
      { types, action, source: 'external' },
      extras,
      Date.now(),
    );
    if (outcome.handled) this._finishOffer(state, outcome.action);
    else this._destroyOffer(state);
  }

  /** Tell the source we take the drag, and how. */
  _accept(state, action) {
    this._setActions(state, action);
    this._offerAccept(state, state.types[0] ?? '');
  }

  /** Tell the source we do not: no action, and a mime that names nothing. */
  _reject(state) {
    this._setActions(state, null);
    this._offerAccept(state, '');
  }

  _setActions(state, action) {
    if (typeof state.offer.$.set_actions !== 'function') return;
    try {
      if (!action) state.offer.$.set_actions(0, ACTION.none);
      else state.offer.$.set_actions(ACTIONS_WE_TAKE, actionBit(action));
    } catch {
      /* the offer may be gone */
    }
  }

  _offerAccept(state, mime) {
    try {
      // No true null on the wire (the codec cannot encode one), so a refusal
      // is an empty mime — a name no source offers, which reads as "none".
      state.offer.$.accept(state.enterSerial, mime ?? '');
    } catch {
      /* the offer may be gone */
    }
  }

  _finishOffer(state, action) {
    this._setActions(state, action);
    this._offerAccept(state, state.types[0] ?? '');
    try {
      if (typeof state.offer.$.finish === 'function') state.offer.$.finish();
    } catch {
      /* v2 offer, or already gone */
    }
    this._destroyOffer(state);
  }

  _destroyOffer(state) {
    this._offers.delete(state.offer.id);
    try {
      state.offer.$.destroy();
    } catch {
      /* already gone */
    }
  }

  // ---- the drag source ----------------------------------------------------

  /**
   * Hand a `DragSession`'s gesture to a `wl_data_source`. Called by
   * `DragSession._start` through `WaylandBackendWindow.beginDrag`; returns
   * truthy once the drag is under way, null when there is no data device to
   * start it on.
   */
  beginDrag(window, session) {
    if (!this.manager || !this.app.compositor) return null;
    const source = this.manager.$.create_data_source();
    const offerMap = sourceOffers(session);
    for (const mime of Object.keys(offerMap)) source.$.offer(mime);
    if (typeof source.$.set_actions === 'function') {
      source.$.set_actions(actionMask(session.actions));
    }
    source.on('send', (mime, fd) => this._send(session, offerMap, mime, fd));
    source.on('target', (mime) => this._onTarget(session, mime));
    source.on('action', (mask) => this._onAction(session, mask));
    source.on('dnd_drop_performed', () => {
      if (this._source) this._source.performed = true;
    });
    source.on('dnd_finished', () => this._endSource(session, true));
    source.on('cancelled', () => this._endSource(session, false));

    // The icon is a role-less surface the compositor puts under the pointer.
    // Bare (no buffer) here — a valid "no visible icon", and the only way to
    // say it, since the wire codec cannot encode the null the protocol
    // reserves for it. Rendering the preview into it is a follow-up.
    let icon = null;
    try {
      icon = this.app.compositor.$.create_surface();
    } catch {
      icon = null;
    }
    if (!icon) return null;

    const serial = this.seat.lastPressSerial || this.seat.lastSerial || 0;
    this._source = {
      session,
      source,
      offerMap,
      icon,
      window,
      action: session.currentAction,
      performed: false,
      ended: false,
    };
    try {
      this.device.$.start_drag(
        source.id,
        window.wl.surface.id,
        icon.id,
        serial,
      );
    } catch (err) {
      this._teardownSource();
      throw err;
    }
    return true;
  }

  _send(session, offerMap, mime, fd) {
    if (typeof fd !== 'number' || fd < 0) return;
    try {
      const type = offerMap[mime] ?? mime;
      const bytes = wireBytes(session._resolve(type));
      writeAll(fd, bytes).catch(() => closeFd(fd));
    } catch {
      closeFd(fd);
    }
  }

  /** The source's own view of the gesture: the current target accepts (a
   * non-empty mime) or not (empty, the wire's stand-in for null). Feeds
   * `onDrag` with the updated accept state. */
  _onTarget(session, mime) {
    session.accepted = Boolean(mime);
    session.nativeMoved?.(this._sourcePos(session));
  }

  _onAction(session, mask) {
    const name = actionName(mask);
    if (this._source) this._source.action = name;
    session.currentAction = name;
    session.nativeMoved?.(this._sourcePos(session));
  }

  /**
   * The gesture is over. `dropped` is whether it landed on a target
   * (`dnd_finished`) or was cancelled — the same shape `nativeEnded` reads on
   * every backend, so `onDragEnd` and a `move`'s source deletion follow the
   * one path.
   */
  _endSource(session, dropped) {
    const s = this._source;
    if (!s || s.session !== session || s.ended) return;
    s.ended = true;
    const pos = this._sourcePos(session);
    try {
      session.nativeEnded?.({
        x: pos.x,
        y: pos.y,
        operation: dropped ? s.action : null,
        dropped,
      });
    } finally {
      this._teardownSource();
    }
  }

  /** A best-effort pointer position for the source's `onDrag`/`onDragEnd`.
   * A Wayland drag delivers no global motion to the source, so this is the
   * press point in logical coordinates — the preview that would follow it is
   * the compositor's icon surface here, not a popup. */
  _sourcePos(session) {
    const scale = this._source?.window?.scale ?? this.app.scale ?? 1;
    const p = session.press ?? {};
    return {
      x: (p.rootx ?? p.x ?? 0) / scale,
      y: (p.rooty ?? p.y ?? 0) / scale,
    };
  }

  _teardownSource() {
    const s = this._source;
    if (!s) return;
    this._source = null;
    try {
      s.icon?.$.destroy();
    } catch {
      /* already gone */
    }
    try {
      s.source.$.destroy();
    } catch {
      /* already gone */
    }
  }
}
