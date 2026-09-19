// Drag and drop on the win32 backend — the OLE transport over
// @windowkit/win32: `IDropTarget` on every window that has a `dropAccept`
// under it, `DoDragDrop` out of one. The `dropAccept` / `onDrag*` / `dragData`
// prop contract is the tree's (src/dnd.js); what this file owns is the
// translation between the shell's vocabulary and `DropSession`/`DragSession`'s,
// the same job src/cocoa/dnd.js does for AppKit and src/wayland/dnd.js for the
// data device.
//
// ## The answer, and when it is given
//
// AppKit asks its questions on the thread the tree lives on and wants the
// answer from inside the callback. The shell asks on the bridge's UI thread
// and wants it before `IDropTarget::DragOver` returns — and this tree is on
// another thread, so "from inside the callback" is not available.
//
// The bridge splits the difference by what each question is for (src/dnd.cc):
// a motion's answer picks a cursor and is allowed to be one motion stale, so
// the native returns the previous answer and never waits; a drop's answer
// decides whether the source deletes its original, so the native waits for
// this file to call `dropResponse`. Both arrive here as ordinary events and
// both are answered the same way — the difference is entirely on the other
// side, and the only thing it asks of this file is that the drop is answered
// **synchronously in the event handler**, which `DropSession.localDrop`
// already is.
//
// ## Types
//
// The shell has no registration step: a window that is a drop target is
// offered everything, and what it accepts is decided per motion. So
// `refreshTypes` has nothing to register — it turns the target on when any
// `dropAccept` exists under the window and off when the last one goes, which
// is what keeps the shell from offering a cursor over a window that would
// refuse everything.
//
// Clipboard formats map to MIME in the bridge. `text/uri-list` is CF_HDROP,
// which is what a Explorer file drag arrives as, and anything the table does
// not name is a registered format named by the MIME string — two react-x11
// apps agree on it for free, like an X11 atom, and nothing else will.
//
// ## The source
//
// `beginDrag` resolves every type's data **up front** and hands the bytes
// over, then `DoDragDrop` runs its modal loop on the UI thread. That is a
// real difference from the cocoa transport, which keeps a thunk as a promise
// the bridge redeems when the receiver asks: here a thunk is called at the
// start of the drag instead. The reason is the thread split — a data object
// that asked JS for its bytes from inside the modal loop would be reaching
// across it at the one moment the UI thread cannot wait — and the cost is
// that a `dragData` thunk is not lazy on this backend.
//
// What the split buys back is the thing it was built for: JS keeps rendering
// for the whole drag. On the cocoa backend AppKit owns the thread from the
// threshold to the drop and no frame clock ticks in between.
const DEBUG = process.env.REACT_X11_WIN32_DEBUG === '1';

import {
  TEXT_TARGETS,
  TYPE_GROUPS,
  parseUriList,
  resolveType,
} from '../transfer.js';

/** Bytes for the wire: a string goes as UTF-8, anything else as it is. */
function wire(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return String(value);
}

/**
 * What `beginDrag` hands the bridge: every type with its bytes already
 * resolved, and the actions the gesture allows.
 */
export function dragSpec(session) {
  const items = [];
  for (const type of session.types) {
    const raw = session._resolve(type);
    if (raw == null) continue;
    items.push({ type, data: wire(raw) });
  }
  return { items, actions: session.actions ?? ['copy'] };
}

/**
 * One window's drop side: the four events turned into `DropSession` calls,
 * with the answer sent back before the handler returns.
 */
export class Win32DropTransport {
  constructor(wnd, session, node) {
    this.wnd = wnd;
    this.session = session;
    this.node = node;
    this._enabled = null;
    this.refreshTypes();
  }

  /**
   * The shell registers no types, so this is the on/off switch: a window with
   * nothing that would accept a drop is not a drop target at all, and the
   * shell shows the "no" cursor over it without asking anybody.
   */
  refreshTypes() {
    const wanted =
      (this.node._dndConcreteTypes?.() ?? []).length > 0 || this.node._dnd != null;
    if (wanted === this._enabled) return;
    this._enabled = wanted;
    if (DEBUG) console.error(`[win32] dropTarget ${this.wnd.id} -> ${wanted}`);
    this.wnd._native.dropTargetEnable(this.wnd.id, wanted);
  }

  /**
   * Register again now that there is an HWND to register on.
   *
   * The tree mounts its `dropAccept`s in the turn the window is asked for,
   * and this bridge creates a window asynchronously — `createWindow` answers
   * with an id and the HWND appears later. So the first registration lands
   * on a window that does not exist yet and does nothing, quietly, and the
   * only symptom is a window the shell never offers a drag to.
   */
  reattach() {
    this._enabled = null;
    this.refreshTypes();
  }

  handle(ev) {
    if (DEBUG) console.error(`[win32] ${ev.type} ${ev.a},${ev.b} "${ev.text ?? ''}"`);
    switch (ev.type) {
      case 'drag-enter':
      case 'drag-over':
        return this._over(ev);
      case 'drag-leave':
        return this._leave();
      case 'drag-drop':
        return this._drop(ev);
      default:
        return undefined;
    }
  }

  /** The live drag in this process, when this drop is our own gesture coming
   *  back over one of our windows. */
  _local() {
    return this.wnd.app._activeDrag ?? null;
  }

  _types(ev) {
    return String(ev.text ?? '')
      .split('\n')
      .filter(Boolean);
  }

  /** What the shell says the source allows, in the tree's vocabulary. The
   *  order is the preference: a source offering both copy and move means
   *  move, which is what every other transport reports. */
  _actions(effects) {
    const allowed = [];
    if (effects & 2) allowed.push('move');
    if (effects & 1) allowed.push('copy');
    if (effects & 4) allowed.push('link');
    return allowed;
  }

  _offer(ev) {
    const drag = this._local();
    if (drag) return drag._offer();
    const actions = this._actions(ev.c ?? 0);
    return {
      types: this._types(ev),
      action: actions[0] ?? 'copy',
      source: 'external',
    };
  }

  /**
   * The answer, and which question it answers.
   *
   * `forDrop` is not a detail: the bridge's UI thread is blocked inside
   * `IDropTarget::Drop` waiting for one, and the answers to the last few
   * motions are still arriving behind it — JS is a queue or two back by
   * then. Without the flag the first of those would release the wait, and
   * the drop would be decided by a motion's answer.
   */
  _answer(answer, forDrop = false) {
    this.wnd._native.dropResponse(
      this.wnd.id,
      Boolean(answer.accepted ?? answer.handled),
      answer.action ?? 'copy',
      forDrop,
    );
  }

  _over(ev) {
    const drag = this._local();
    const offer = this._offer(ev);
    const answer = this.session.localOver(ev.a, ev.b, offer, Date.now());
    if (drag) {
      drag.accepted = answer.accepted;
      if (answer.accepted) drag.currentAction = answer.action;
    }
    this._answer(answer);
  }

  _leave() {
    const drag = this._local();
    this.session.localLeave();
    if (drag) drag.accepted = false;
  }

  _drop(ev) {
    const drag = this._local();
    const offer = this._offer(ev);
    // The bridge read every format while the data object was alive; this asks
    // it for the ones the tree wants. A local drop keeps `e.items` by
    // reference instead, so an in-app drop never round-trips through bytes.
    const extras = drag ? drag._dropExtras() : this._payload(offer.types);
    let outcome = { handled: false, action: null };
    try {
      outcome = this.session.localDrop(offer, extras, Date.now());
    } catch (err) {
      if (DEBUG) console.error(`[win32] localDrop threw: ${err?.stack ?? err}`);
      throw err;
    } finally {
      // Answered in a `finally` because the bridge's UI thread is blocked
      // inside `IDropTarget::Drop` waiting for it. A handler that throws must
      // not leave it there for the whole two-second backstop — the pointer is
      // captured for as long as the drop is open.
      this._answer(outcome, true);
    }
    if (DEBUG) console.error(`[win32] drop outcome ${JSON.stringify(outcome)}`);
    if (drag && outcome.handled) drag.currentAction = outcome.action;
  }

  /**
   * What the bridge read at the drop, in the shape `localDrop` takes — the
   * same four fields the cocoa transport builds from a pasteboard.
   *
   * Textual types come back as strings and everything else as the bytes the
   * source put on the clipboard: a `text/uri-list` that was decoded from
   * CF_HDROP is text by the time it gets here, and an
   * `application/x-myapp-thing` is whatever its owner wrote.
   */
  _payload(types) {
    const values = {};
    for (const type of types) {
      const bytes = this.wnd._native.dropData(type);
      if (!bytes) continue;
      values[type] = this._textual(type) ? bytes.toString('utf8') : bytes;
    }
    if (
      values['text/plain;charset=utf-8'] !== undefined &&
      values['text/plain'] === undefined
    ) {
      values['text/plain'] = values['text/plain;charset=utf-8'];
    }
    const best = TEXT_TARGETS.find((t) => values[t] !== undefined);
    return {
      items: values,
      files: values['text/uri-list'] ? parseUriList(values['text/uri-list']) : [],
      text: best ? values[best] : undefined,
      // A promise, like the cocoa transport's: the payload is already in
      // hand, and answering synchronously here would make this the one
      // backend where `await e.getData(…)` was not needed.
      getData: (type) =>
        Promise.resolve(values[resolveType(type, types)] ?? null),
    };
  }

  _textual(type) {
    return (
      TEXT_TARGETS.includes(type) ||
      TYPE_GROUPS.files.includes(type) ||
      type.startsWith('text/')
    );
  }
}
