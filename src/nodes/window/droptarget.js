// The window's half of XDND (docs/architecture/drag-and-drop.md): the drop
// targets registered under it and the types they accept.

import {
  DropSession,
  dndAtoms,
  registerTopLevel,
  XDND_VERSION,
} from '../../dnd.js';
import { TYPE_GROUPS } from '../../transfer.js';

/** The window's half of XDND, installed onto `WindowNode.prototype` by window.js. */
export class WindowDropTarget {
  /**
   * XDND drop-target wiring (src/dnd.js): write `XdndAware = 5`, start the
   * atom interning, and route incoming ClientMessages to the session.
   * Unconditional — the property is 4 bytes on a window that exists anyway,
   * and advertising lazily would race sources that cache the window list
   * at drag start. A window with no registered drop targets answers "not
   * accepting" once per entry instead (DropSession).
   *
   * The one exception is a `<popup dragPreview>`. It follows the pointer,
   * so for the whole gesture it is the frontmost window under it, and it
   * must never be what the drag is over. Where react-x11 picks the target
   * itself (src/dnd.js `topLevelAt`) it is skipped by name. Where the OS
   * picks, registering nothing is not enough: AppKit finds the window
   * under the pointer first and does not look past one with no dragged
   * types — the drag then has no destination at all — so the cocoa window
   * is made transparent to the pointer instead (src/cocoa/window.js,
   * `ignoresMouseEvents`, #488). A preview still gets none of this: no
   * session, no registry entry, no property, nothing to refuse with.
   */
  _initDnd() {
    if (this.props.dragPreview) return;
    const wnd = this.window;
    const X = this.app?.X;
    // A backend with drop machinery of its own (the cocoa backend's
    // NSDraggingDestination, src/cocoa/dnd.js): the same DropSession, driven
    // through its local entry points by the window's transport instead of
    // by XDND ClientMessages. No property to write, nothing to intern.
    if (typeof wnd?.attachDropTransport === 'function') {
      this._dnd = new DropSession(this);
      registerTopLevel(this);
      wnd.attachDropTransport(this._dnd, this);
      return;
    }
    if (
      !X ||
      typeof X.InternAtom !== 'function' ||
      typeof wnd.on !== 'function' ||
      typeof wnd.setProperty !== 'function'
    ) {
      return; // mock app, or an ntk too old to write raw properties
    }
    this._dnd = new DropSession(this);
    registerTopLevel(this);
    void dndAtoms(X).catch(() => {});
    wnd
      .setProperty('XdndAware', [XDND_VERSION], { type: 'ATOM' })
      .catch(() => {});
    wnd.on('message', (ev) => {
      // XDND is a *default action* on a ClientMessage, so it follows the same
      // rule every other one does: it runs after the application's handler
      // and is skipped when that handler called `preventDefault()`. That is
      // the seam for a window answering the drag protocol itself.
      //
      // `_attachWindowListeners` subscribed to this stream first, so normally
      // the flag is already decided by the time this runs. `pending()` is the
      // exception it cannot cover: a message whose type had to be named with
      // a round trip is dispatched a few turns later, and answering the drag
      // before the application has been asked would make `preventDefault()`
      // depend on whether an atom happened to be cached.
      const said = this._clientMessages?.pending();
      const route = () => {
        if (ev.defaultPrevented) return;
        this._dnd.handleMessage(ev);
        // a drag *out* of this window gets its XdndStatus/XdndFinished back
        // on the same channel
        this._dragSession?.handleMessage(ev);
      };
      if (said) said.then(route);
      else route();
    });
  }

  /** Nodes with drop props register with their root; the count gates the
   * whole-window "not accepting" fast path. Child <window>s roll up into
   * their top-level's count, since that is where the messages arrive. */
  _registerDropTarget(node) {
    (this._dropTargets ??= new Set()).add(node);
    this._dndTopLevel()?.window?.dropTargetsChanged?.();
  }

  _forgetDropTarget(node) {
    this._dropTargets?.delete(node);
    this._dndOwner()?.forget(node);
    this._dndTopLevel()?.window?.dropTargetsChanged?.();
  }

  /** The top-level whose drop session — and transport — this window's
   * targets roll up into. */
  _dndTopLevel() {
    let node = this;
    while (node && !node._dnd) node = node.parent?.root;
    return node ?? null;
  }

  /** The concrete type names every `dropAccept` under this top-level asks
   * for — what a backend that registers its accepted types up front (the
   * cocoa backend) adds to its base set. Groups and predicates name none. */
  _dndConcreteTypes() {
    const out = new Set();
    const walk = (wn) => {
      for (const node of wn._dropTargets ?? []) {
        const accept = node.props.dropAccept;
        for (const entry of Array.isArray(accept) ? accept : []) {
          if (typeof entry === 'string' && !(entry in TYPE_GROUPS)) {
            out.add(entry);
          }
        }
      }
      for (const child of wn.children) {
        if (child.isWindow && !child.isPopup) walk(child);
      }
    };
    walk(this);
    return [...out];
  }

  _dndTargetCount() {
    let count = this._dropTargets?.size ?? 0;
    for (const child of this.children) {
      if (child.isWindow && !child.isPopup) count += child._dndTargetCount();
    }
    return count;
  }

  /** The session that owns drags over this window: its own for a
   * top-level, the enclosing top-level's for a nested <window>. */
  _dndOwner() {
    let node = this;
    while (node && !node._dnd) node = node.parent?.root;
    return node?._dnd ?? null;
  }
}
