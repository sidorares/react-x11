// The X events a realized window listens to and what each one does, and the
// close request's default.

import { discrete } from '../../events.js';
import { createClientMessages } from '../../clientmessage.js';
import { callHandler } from '../../errors.js';
import { runWithPriority, DiscreteEventPriority } from '../../priority.js';
import { DEV } from '../util.js';

/** The window's event listeners, installed onto `WindowNode.prototype` by window.js. */
export class WindowListeners {
  /**
   * `parentWindow` is realize()'s, and only the close handshake reads it:
   * whether the window manager frames this window decides whether
   * WM_DELETE_WINDOW means anything on it.
   */
  _attachWindowListeners(parentWindow) {
    const wnd = this.window;
    if (typeof wnd.on !== 'function') return;
    wnd.on('resize', (ev) => {
      // ConfigureNotify also fires for pure moves and reparents; only a real
      // size change dirties layout or pixels.
      //
      // Compared against the laid-out rect rather than ntk's `ev.resized`
      // (which is "differs from the last delivered event"), because the two
      // answer different questions and this is the one that matters here: a
      // React-driven resize configures the window and lays out in the same
      // commit, and the server's echo comes back a moment later saying the
      // size changed — true, but already accounted for. `ev.resized` would
      // relayout and fully repaint a second time for every controlled
      // resize.
      if (ev.width !== this.abs.width || ev.height !== this.abs.height) {
        this.needsLayout = true;
        this.invalidate(true, null, 'resize');
      }
      // The end of an `'auto'` window's authority over its own size. A
      // ConfigureNotify that does not match what we last asked for is
      // somebody else's decision — the user dragging an edge, or a window
      // manager applying a policy of its own — and from here on the window
      // is theirs. Growing it back under a user who has just made it smaller
      // is the one behaviour worse than not fitting the content.
      //
      // Checked against `_requestedSize` rather than ntk's `ev.resized`
      // because our own configures come back as echoes, and every one of
      // them would otherwise read as the user taking over on the first
      // re-fit.
      const asked = this._requestedSize;
      if (asked && (ev.width !== asked.width || ev.height !== asked.height)) {
        this._userSized = true;
      }
      // Where the window sits on screen decides where popups anchored to it
      // belong — and finding that out is a server round trip
      // (TranslateCoordinates), so it is worth not making one per frame of a
      // resize drag that never moved the window. `ev.moved` is ntk >= 6.2
      // (sidorares/ntk#184), which is the floor; the `?? true` is for a mock
      // window or a deduped older copy, which then keep the unconditional
      // refresh rather than losing the anchor.
      if (ev.moved ?? true) this._refreshScreenOrigin();
      if (this.props.onResize) {
        // the payload is application-facing: an app that stores this size
        // and writes it back as `width`/`height` props must round-trip
        // through one unit, and props are logical
        const s = this.scale;
        this.props.onResize(
          s === 1
            ? ev
            : {
                ...ev,
                width: ev.width / s,
                height: ev.height / s,
                x: ev.x / s,
                y: ev.y / s,
              },
        );
      }
    });
    // A reparent is the other way the origin moves: the window manager puts
    // the window inside its frame, and ConfigureNotify coordinates become
    // frame-relative from then on. It usually arrives with a ConfigureNotify
    // whose coordinates changed, but "usually" is not a guarantee — a frame
    // whose client offset happens to match the old root position reports no
    // move at all. StructureNotify is already selected for 'resize', so
    // listening costs nothing.
    wnd.on('reparent', () => this._refreshScreenOrigin());
    // the frame clock emits 'draw' when the backing store content is invalid
    wnd.on('draw', () => {
      (this._frameReasons ??= new Set()).add('expose');
      this.needsPaint = true;
      this.flush();
    });
    wnd.on('expose', (ev) => {
      this.props.onExpose?.(ev);
    });
    // Every ClientMessage addressed to this window (src/clientmessage.js).
    // Unconditional, unlike the two opt-ins below it: a ClientMessage is
    // delivered to the window's owner whatever event mask it selected, so
    // there is nothing to arm and nothing a window without the prop pays.
    // That in turn means the handler can be read from `props` per message —
    // the rule every other event here follows — instead of being frozen at
    // realize time.
    //
    // Attached before `_initDnd`'s listener on the same stream, which is what
    // makes `preventDefault()` able to stop react-x11 answering XDND itself.
    //
    // Another client asking this one for something is a user action arriving
    // by another route, so it lands at the priority — and in the paint — a
    // click would get: `discrete`, like the WM close below.
    this._clientMessages = createClientMessages(
      this,
      discrete((ev) => {
        // Read here rather than where the message was taken, since a type the
        // server had to be asked to name puts a round trip in between and
        // React may have replaced the handler across it.
        const handler = this.props.onClientMessage;
        if (!handler) return;
        runWithPriority(DiscreteEventPriority, () => {
          callHandler(this, 'onClientMessage', handler, ev);
        });
      }),
    );
    wnd.on('message', (raw) => {
      // A window with no handler takes nothing on the queue and asks the
      // server for nothing, on a stream that carries every XDND step of a
      // drag passing over it.
      if (this.props.onClientMessage) this._clientMessages.handle(raw);
    });
    // What the window manager actually did, which is the other half of the
    // controlled pair — the props say what to ask for, this says what is
    // true. Subscribing is what makes ntk select PropertyChange and watch
    // `_NET_WM_STATE`, so it is opt-in: a window with no handler pays
    // nothing. Read at realize time like onCloseRequest, since the
    // subscription is a property of the X window, not of a render.
    if (this.props.onStatesChange && typeof wnd.getWmStates === 'function') {
      wnd.on('statechange', (states) => {
        // a WM state change is something the user did to the window, so it
        // carries the same priority a click would
        runWithPriority(DiscreteEventPriority, () => {
          this.props.onStatesChange?.(states);
        });
      });
    }
    // WM close button. Armed for every window the window manager actually
    // manages, prop or no prop, because the alternative is not "no close
    // handling" but a killed connection: a client with no WM_DELETE_WINDOW
    // in WM_PROTOCOLS cannot be *asked* to close, so XKillClient is the only
    // move the WM has left. Effects never clean up, and IceWM puts a "do you
    // want to kill this client?" dialog in front of the user first. Every
    // other toolkit arms this unconditionally for the same reason; making it
    // the prop's side effect only moved that trap one level up.
    //
    // Not armed where the property is dead weight, which is every window the
    // WM does not frame: a child <window> (a region inside another window)
    // and an override-redirect <popup>. A `<popup overrideRedirect={false}>`
    // is a real dialog and does get it.
    //
    // ntk >= 5.3 owns the protocol: listening for 'close' self-arms
    // WM_PROTOCOLS and decodes the ClientMessage (#160). Its default action
    // — destroy the window — is always prevented, because what happens next
    // is React's decision: ntk tearing the window down underneath the
    // reconciler is exactly what this handler exists to avoid. This also
    // leaves the raw 'message' stream free for protocols react-x11 speaks
    // itself (XDND, src/dnd.js).
    if (!parentWindow && this.attributes?.overrideRedirect !== true) {
      wnd.on(
        'close',
        // a WM close is a user action: discrete priority and a discrete
        // paint, like a click. An onCloseRequest that answers with a
        // "save your work?" dialog rather than an unmount is the case that
        // notices — the dialog is the response to the press on the WM's
        // close button, and it is one paint away.
        discrete((ev) => {
          ev.preventDefault();
          runWithPriority(DiscreteEventPriority, () => {
            const handler = this.props.onCloseRequest;
            if (handler) callHandler(this, 'onCloseRequest', handler, ev);
            else this._defaultCloseRequest();
          });
        }),
      );
    }
    this.events.attach();
  }

  /**
   * A close request nobody handled — `onCloseRequest` is the override, this
   * is what happens without one.
   *
   * Closing the app's primary window closes the app, which is what the
   * button means everywhere else on the desktop. The tree unmounts and the
   * connection closes, so effects clean up and the process ends on a drained
   * loop rather than on a dead socket.
   *
   * Any other top-level window is a dialog or a satellite, and whether it
   * goes away is app state this renderer cannot write: a `{open && <window/>}`
   * was opened by a `setOpen(true)` somewhere, and unmapping it behind
   * React's back would leave a window the app still believes is open and can
   * never reopen. So the request is refused, and in dev it is said out loud —
   * an inert close button is a bug, but a recoverable one, where guessing at
   * the app's state is not.
   */
  _defaultCloseRequest() {
    if (this._isPrimaryWindow()) {
      // fire and forget: unmount() is async (it awaits the connection
      // closing) and a WM close request is answered synchronously or not at
      // all. Errors reach the app's own handler, never an unhandled rejection.
      Promise.resolve(this.app?._reactX11Root?.unmount?.()).catch((err) => {
        this.app?.options?.onXError?.(err);
      });
      return;
    }
    if (DEV && !this._warnedNoCloseHandler) {
      this._warnedNoCloseHandler = true;
      console.warn(
        'react-x11: the window manager asked <window%s> to close, and it has ' +
          "no onCloseRequest — so nothing happened. Only the app's primary " +
          'window closes the app by default; a second window is opened by ' +
          'app state and only app state can close it.',
        this.props.title ? ` title=${JSON.stringify(this.props.title)}` : '',
      );
    }
  }
}
