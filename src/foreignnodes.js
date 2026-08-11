// <foreign>: another process's window, inside ours.
//
// The second element that owns a real X window without painting into its
// parent (NEXT_STEPS §4, after `<glarea>`), and the only one that makes a
// react-x11 app a *host* rather than a drawer of its own pixels: a terminal
// pane, a video surface, a docked tray icon.
//
// The protocol is ntk's (`XEmbedSocket`, sidorares/ntk#246) — the save-set,
// the reparent, `_XEMBED_INFO`, the `_XEMBED` messages, the synthetic ICCCM
// 4.1.5 ConfigureNotify. What is left here is the part that has to be
// React-shaped, and it is three things:
//
//  1. **When the X calls happen.** `createInstance` runs in the render
//     phase, which React may discard — and a ReparentWindow issued from a
//     render that is then thrown away has moved somebody else's window for
//     real. So this node holds no socket until the owning `WindowNode`
//     realizes it in the commit phase, exactly as `<glarea>` is realized
//     (`_realizeChildWindows`, nodes.js).
//
//  2. **Where the rect comes from.** Yoga, like any other child. Every
//     change is a ConfigureWindow on the client plus the synthetic
//     ConfigureNotify with root-relative coordinates, which is the geometry
//     question a client actually asks.
//
//  3. **Whose focus it is.** react-x11 has a focus manager, a tab order and
//     `preventDefault`; XEmbed has activation, logical focus and
//     FOCUS_NEXT/PREV. This file is the mapping — see "Focus" below.
//
// Unmount hands the client back: reparented to the root, dropped from the
// save set, **never destroyed**. Destroying somebody else's window because a
// React tree changed is the failure mode this element is most able to cause,
// and `test/foreign.test.js` asserts against it first.
import { XEMBED, XEmbedSocket } from 'ntk';

import { isFocusable } from './a11y.js';
import { inputTime } from './inputtime.js';
import { Node, pixelFor } from './nodes.js';

const px = (v) => Math.max(1, Math.round(v || 0));

/**
 * `<foreign>` — another client's top-level window, laid out as an element.
 *
 * ```jsx
 * <foreign
 *   windowId={id}
 *   style={{ flexGrow: 1, backgroundColor: '#101014' }}
 *   onEmbedded={({ xembed }) => setMode(xembed ? 'xembed' : 'reparented')}
 *   onClientGone={() => respawn()}
 * />
 * ```
 *
 * With no `windowId` the node instead **adopts** whatever is put inside it,
 * and hands out the id to put it in through `onReady` — which is the shape
 * `xterm -into WID` and `mpv --wid=WID` need, since the program has to be
 * given a window before it has one of its own.
 *
 * Like `<glarea>`, the child X window sits above everything drawn in the
 * parent, so 2D content cannot overlap it — a HUD belongs in a sibling
 * `<popup>`.
 *
 * ### Focus
 *
 * The classic embedder answers XEmbed focus with a *focus proxy*: an
 * InputOnly window that takes the real X input focus and forwards
 * keystrokes to the client with SendEvent. This one does not, deliberately.
 * Two reasons, and they point the same way:
 *
 *  - A proxy inside our own toplevel means the toplevel sees FocusOut
 *    (detail Inferior) the moment the client is focused, and react-x11 reads
 *    that as the window losing focus — the caret stops blinking, `<window
 *    onBlur>` fires, and this node is told to blur the client it just
 *    focused.
 *  - A key that reaches the proxy has already gone past every handler in the
 *    React tree, so an application chord cannot be checked first. That is
 *    the one rule this element has to keep: **while a `<foreign>` holds
 *    focus, the app's handlers see the key first and everything they do not
 *    consume is forwarded**. `preventDefault()` is how they consume it, the
 *    same word that stops a `<textinput>` from eating Tab.
 *
 * So the X focus stays on our own window, the logical focus is a message
 * (`XEMBED_FOCUS_IN`), and forwarding happens in `defaultKeyDown`/
 * `defaultKeyUp` — after dispatch, which is what "the app sees it first"
 * means mechanically.
 *
 * The one thing this cannot cover: X delivers a key to the deepest
 * descendant of the focus window that contains the pointer, so while the
 * pointer is *over* the embedded client the client receives keys directly
 * and no handler of ours runs. Chords work everywhere else in the window,
 * which is the trade a proxy would make in reverse.
 */
export class ForeignNode extends Node {
  constructor(props, app) {
    super('foreign', props, app);
    /** ntk's XEmbedSocket, from the commit phase onwards */
    this.socket = null;
    /** `{ id, xembed, version }` while a client is in, else null */
    this.client = null;
    /** the error that stopped an embed, if one did */
    this.error = null;
    /** geometry last sent to the X windows */
    this.rect = null;
    // an embedded client is a control the user can Tab to, like a
    // <textinput> — `focusable={false}` opts out (a video surface, say)
    this.focusableByDefault = true;
    // whether an XEMBED_FOCUS_IN is outstanding, so the matching FOCUS_OUT
    // is sent once and only after one
    this._focusSent = false;
    this._backgroundPixel = null;
  }

  get isForeign() {
    return true;
  }

  _setRoot(root) {
    super._setRoot(root);
    // a <foreign> mounted into a live tree realizes here; one mounted with
    // the window is picked up by WindowNode.realize
    if (root?.window) this.realize();
  }

  /**
   * Create the container X window and start embedding. Called from the
   * commit phase and from `_setRoot`, both of which are past the point
   * where React can discard the work.
   */
  realize() {
    if (this.socket || this.destroyed) return;
    const parent = this.root?.window;
    if (!parent || typeof this.app?.createWindow !== 'function') return;
    const rect = this._geometry();
    this.rect = rect;
    const socket = new XEmbedSocket(parent, {
      ...rect,
      // react-x11 has a focus manager; a socket that answered
      // XEMBED_REQUEST_FOCUS by itself would move focus behind its back and
      // the rest of the tree would never hear about it
      focusOnRequest: false,
    });
    this.socket = socket;
    socket.window._reactX11Node = this;
    this._applyBackground();
    socket.on('embedded', (info) => this._onEmbedded(info));
    socket.on('gone', () => this._onGone());
    socket.on('requestFocus', () => this._onRequestFocus());
    socket.on('focusNext', () => this._moveFocus(false));
    socket.on('focusPrev', () => this._moveFocus(true));
    this._start(this.props.windowId);
    // after `_start`, which maps the container itself — both paths do,
    // because a client cannot be viewable inside an unmapped one
    this._syncMapped();
  }

  /**
   * Embed `windowId`, or — with none — wait for something to put a window
   * inside the container and take that.
   *
   * The token guards the async edge: a `windowId` that changes while an
   * embed is in flight must not have the stale one report success, and a
   * node that unmounted must not report anything at all.
   */
  _start(windowId) {
    const socket = this.socket;
    if (!socket) return;
    const token = (this._token = {});
    this.error = null;
    const started = windowId ? socket.embed(windowId) : socket.adopt();
    started.catch((err) => {
      if (this._token !== token || this.destroyed) return;
      this.error = err;
      if (this.props.onError) this.props.onError(err);
      else console.warn(`react-x11: <foreign> could not embed: ${err.message}`);
    });
    // The container id is what a program is *given* — `xterm -into ID` — so
    // it has to be reachable before there is anything in it, and it is the
    // only way the adopt path can ever start.
    //
    // On a microtask, because this runs in the **commit phase**: a handler
    // that sets state — which is what "start the program and show its
    // status" is — would be setting it on a component React has not finished
    // mounting, and React says so. The microtask lands after the whole
    // synchronous commit and still before any reply from the server, which
    // is the only ordering the caller can observe.
    const onReady = this.props.onReady;
    if (onReady) {
      queueMicrotask(() => {
        if (this._token !== token || this.destroyed) return;
        onReady({ windowId: socket.window.id, node: this });
      });
    }
  }

  _onEmbedded(info) {
    if (this.destroyed) return;
    this.client = { id: info.id, xembed: info.xembed, version: info.version };
    this._syncMapped();
    // A client that arrives while this node already has focus has missed the
    // activation and the focus-in that went out before it was there — a
    // terminal spawned into a focused pane, which is the ordinary case.
    const manager = this._focusManager();
    if (manager?.focused === this && manager.windowFocused) this.defaultFocus();
    this.props.onEmbedded?.({ ...this.client, node: this });
  }

  _onGone() {
    if (this.destroyed) return;
    this.client = null;
    this._focusSent = false;
    this.props.onClientGone?.({ node: this });
  }

  /**
   * `XEMBED_REQUEST_FOCUS`: the client says the user clicked it. Routed
   * through the focus manager rather than answered here, so `:focus`,
   * `:focus-within`, `onBlur` on whatever had focus and the AT-SPI bridge
   * all observe it the way they observe any other focus change.
   */
  _onRequestFocus() {
    if (this.destroyed) return;
    this.props.onRequestFocus?.({ node: this });
    if (isFocusable(this)) this.focus();
  }

  /**
   * `XEMBED_FOCUS_NEXT`/`_PREV`: the client ran off the end of its own tab
   * chain. Continuing into ours is what makes Tab feel like one application
   * instead of two.
   */
  _moveFocus(backwards) {
    if (this.destroyed) return;
    const manager = this._focusManager();
    // Only from focus we gave it. A client asking to be tabbed out of when
    // it does not hold the focus would move focus somewhere the user is not
    // looking, and the message is stale by definition.
    if (manager?.focused !== this) return;
    manager._cycleFocus(backwards);
  }

  // --- focus ---------------------------------------------------------

  /**
   * This node has the focus *and* the toplevel has the X focus — which is
   * exactly when EventManager calls this. Both halves of the XEmbed
   * handshake go out: the window is active, and the client has the logical
   * focus.
   *
   * `detail` is the direction Tab arrived from, which is what tells the
   * client whether to focus its first widget or its last; a click or a
   * `focus()` call leaves the client's own focus where it was.
   */
  defaultFocus(info) {
    const socket = this.socket;
    if (!socket || !this.client) return;
    const time = inputTime(this.app);
    socket.activate(true, { time });
    const detail =
      info?.reason === 'key'
        ? info.backwards
          ? XEMBED.FOCUS_LAST
          : XEMBED.FOCUS_FIRST
        : XEMBED.FOCUS_CURRENT;
    // `socket.focusIn()` would create the focus proxy — see the class
    // comment for why this element sends the message and keeps the X focus
    socket.send(XEMBED.FOCUS_IN, detail, 0, 0, { time });
    this._focusSent = true;
  }

  /** Focus left, or the toplevel stopped being the active window. */
  defaultBlur() {
    const socket = this.socket;
    if (!socket) return;
    const time = inputTime(this.app);
    if (this._focusSent) {
      socket.send(XEMBED.FOCUS_OUT, 0, 0, 0, { time });
      this._focusSent = false;
    }
    socket.activate(false, { time });
  }

  defaultKeyDown(ev) {
    this._forwardKey(ev);
  }

  defaultKeyUp(ev) {
    this._forwardKey(ev);
  }

  /**
   * The key, re-addressed to the client.
   *
   * Reached only after the whole React tree has had the event and left it
   * undefaulted, so an application chord bound above this node has already
   * won. Consuming it here in turn is what stops the focus cycle from also
   * running: Tab belongs to the client, which has its own chain and says so
   * with FOCUS_NEXT when it reaches the end of it.
   */
  _forwardKey(ev) {
    const client = this.socket?.client;
    const native = ev.nativeEvent;
    if (!client || client._destroyed || !native?.type) return;
    const X = this.app?.X;
    if (!X) return;
    try {
      X.SendEvent(client.id, 0, 0, {
        ...native,
        wid: client.id,
        child: 0,
        // window-relative coordinates do not survive the move; the client's
        // origin is this node's rect (root coordinates are unaffected)
        x: (native.x ?? 0) - Math.round(this.abs.x),
        y: (native.y ?? 0) - Math.round(this.abs.y),
      });
    } catch {
      // the connection is going away; there is nothing to forward to
    }
    ev.preventDefault();
  }

  // --- layout --------------------------------------------------------

  _geometry() {
    return {
      x: Math.round(this.abs.x),
      y: Math.round(this.abs.y),
      width: px(this.abs.width),
      height: px(this.abs.height),
    };
  }

  absolutize(originX, originY) {
    super.absolutize(originX, originY);
    this._syncGeometry();
  }

  _syncGeometry() {
    const socket = this.socket;
    if (!socket) return;
    const rect = this._geometry();
    const prev = this.rect;
    if (
      prev &&
      prev.x === rect.x &&
      prev.y === rect.y &&
      prev.width === rect.width &&
      prev.height === rect.height
    ) {
      return;
    }
    this.rect = rect;
    // moves the container, resizes the client with it and sends the
    // synthetic ConfigureNotify with root-relative coordinates (ICCCM 4.1.5)
    socket.resize(rect).catch(() => {});
  }

  // --- props ---------------------------------------------------------

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    super.applyProps(newProps, oldProps);
    if (!this.socket) return;
    if (newProps.windowId !== before.windowId) this._reembed(before.windowId);
    this._applyBackground();
  }

  /**
   * `windowId` changed. The old client is handed back before the new one is
   * taken: a socket holds one client, and the window that is leaving is
   * still somebody else's to keep.
   */
  _reembed(previousId) {
    const socket = this.socket;
    const next = this.props.windowId;
    // Switching between "embed this id" and "adopt whatever turns up" is a
    // different socket, not a different client: a pending adopt() has no
    // cancel, and would otherwise take a window out from under the id that
    // replaced it.
    if (!previousId !== !next) {
      this._teardown();
      this.realize();
      return;
    }
    this._token = {};
    this.client = null;
    this._focusSent = false;
    socket
      .release()
      .then(() => {
        if (this.destroyed || this.socket !== socket) return;
        this._start(next);
      })
      .catch(() => {});
  }

  /**
   * What shows in the rect before a client arrives and after one leaves.
   *
   * It is the container window's `backgroundPixel` — the server paints it,
   * because this element draws nothing itself. Read from the ordinary
   * `backgroundColor` style rather than a prop of its own: a second name for
   * the one colour it does show would leave `backgroundColor` as a style
   * property that silently does nothing beside it.
   */
  _applyBackground() {
    const wnd = this.socket?.window;
    if (typeof wnd?.setBackgroundPixel !== 'function') return;
    const pixel = pixelFor(this.style.backgroundColor);
    if (pixel === null || pixel === this._backgroundPixel) return;
    this._backgroundPixel = pixel;
    wnd.setBackgroundPixel(pixel);
  }

  setHidden(hidden) {
    super.setHidden(hidden);
    this._syncMapped();
  }

  /** The container follows `hidden`; the client follows the container,
   * because an inferior of an unmapped window is not viewable however
   * mapped it is itself. */
  _syncMapped() {
    const wnd = this.socket?.window;
    if (!wnd) return;
    if (this.hidden) wnd.unmap?.();
    else wnd.map?.();
  }

  // the client's window covers this rect: nothing to paint into the
  // parent's 2d context, and pointer events over it are the client's
  paint() {}

  /**
   * Children would be drawn *under* another client's window and never seen —
   * the same stacking rule `<glarea>` has, with no scene graph to make an
   * exception for. Said here rather than swallowed, because an overlay is a
   * reasonable thing to want and a sibling `<popup>` is how to have one.
   */
  insertBefore(child, beforeChild) {
    throw new Error(
      `react-x11: <foreign> takes no children — <${child.kind}> would be ` +
        "drawn under the embedded client's X window and never seen. Put an " +
        'overlay in a sibling <popup>.',
    );
  }

  // --- teardown ------------------------------------------------------

  destroySubtree() {
    if (this.destroyed) return;
    super.destroySubtree();
    this._teardown();
  }

  /**
   * Give the client back, and drop the container — both **synchronously**,
   * which is the whole reason this is not `socket.destroy()`.
   *
   * `XEmbedSocket.release()` asks the server where the container is before
   * it reparents, and `destroy()` awaits that before dropping the container
   * window. Neither wait is affordable here: `WindowNode.destroySubtree`
   * destroys the toplevel in the same synchronous turn as this runs, and
   * DestroyWindow takes every inferior with it — so an awaited release
   * reparents a client that has already been destroyed along with the window
   * it was sitting in. The save set does not cover it either: X processes
   * that when a *connection* closes, not when a window is destroyed.
   *
   * So the position is computed rather than asked for (the toplevel's screen
   * origin plus this node's rect, both already known), and the three
   * requests go out in the order that matters — hand the client back, then
   * destroy what it was inside. Requests on one connection are ordered, so
   * "then" is a guarantee rather than a hope.
   */
  _teardown() {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    this._token = {};
    this.client = null;
    this._focusSent = false;
    this._backgroundPixel = null;
    socket.removeAllListeners();

    const client = socket.client;
    // …and the socket must not act on it again: `client` is the field it
    // publishes, and null means "nothing embedded", which is now true
    socket.client = null;
    try {
      if (client && !client._destroyed) {
        const origin = this.root?.window?._screenOrigin ?? { x: 0, y: 0 };
        const rect = this.rect ?? this._geometry();
        // stop selecting events on a window that is no longer ours, so the
        // ReparentNotify below does not come back to us as `gone`
        client.eventMask = 0;
        this.app.X.ChangeWindowAttributes(
          client.id,
          { eventMask: 0 },
          () => {},
        );
        client.reparentTo(
          this.app.rootWindow(),
          origin.x + rect.x,
          origin.y + rect.y,
        );
        client.removeFromSaveSet();
      }
      socket.window.destroy();
    } catch {
      // the connection is closing: the client goes back to the root through
      // the save set, which is exactly what it is for
    }
  }
}
