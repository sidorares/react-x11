// Server-side decorations, through xdg-decoration.
//
// The compositor may draw the frame — wlroots compositors and KDE do, when
// asked, and GNOME does not advertise the protocol at all — so "who draws the
// titlebar" is negotiated per toplevel. The client creates a decoration
// object *before the toplevel's first commit* and says which mode it would
// prefer; the compositor answers with `configure(mode)`, which is part of
// the surface's configure sequence and takes effect on the same ack as the
// size and states it arrived with. A client prefers, it never insists: sway
// grants server_side, and a compositor that will not draw frames answers
// client_side — which is the state the backend was already in, so
// `decorations.js` stays and is switched off rather than removed.
//
// The mode is adopted, not applied on arrival, for the reason the configure
// ack is deferred (window.js): a mode change is a size change — the surface
// loses or gains its own titlebar — and the frame that adopts it has to be
// painted at the new insets. `adopt()` runs from the xdg_surface.configure
// handler, so a window hears 'decorationmode' before it hears 'configure'.

import { EventEmitter } from 'node:events';

/** `zxdg_toplevel_decoration_v1.mode`. */
export const DECORATION_MODE = { CLIENT_SIDE: 1, SERVER_SIDE: 2 };

/**
 * What `decorations` means, at the app (`createRoot({ decorations })`) and
 * per window (`<window decorations={false}>`, the one value the tree passes):
 *
 *   undefined | true | 'server'  a frame — the compositor's where it offers
 *                                one, this backend's own otherwise
 *   'client'                     a frame, always this backend's own
 *   false                        no frame at all
 *
 * The per-window `false` wins over whatever the app said. A window with no
 * frame still gets a decoration object when the compositor has the protocol,
 * to *decline* server-side: sway frames every toplevel that has not said
 * client_side, and a frameless window would come up with a title bar.
 *
 * @returns {{ draw: boolean, prefer: 'server'|'client' }} whether the window
 *   wants a frame at all, and which side should draw it if so
 */
export function decorationPolicy(appOption, windowOption) {
  const draw = appOption !== false && windowOption !== false;
  const prefer = draw && appOption !== 'client' ? 'server' : 'client';
  return { draw, prefer };
}

export class ServerDecoration extends EventEmitter {
  /**
   * Create the decoration object and state a preference. Must run before
   * the toplevel's first commit; `WaylandWindow.createSync` calls it there.
   *
   * @param {object} opts
   * @param {object} opts.manager the `zxdg_decoration_manager_v1` proxy
   * @param {object} opts.toplevel the `xdg_toplevel` proxy
   * @param {'server'|'client'} [opts.prefer='server']
   */
  constructor({ manager, toplevel, prefer = 'server' }) {
    super();
    this.proxy = manager.$.get_toplevel_decoration(toplevel.id);
    /** the mode in effect: 'server' | 'client', null before the first configure */
    this.mode = null;
    /** a mode the compositor sent that the next xdg_surface.configure adopts */
    this.pending = null;
    this.destroyed = false;
    this.proxy.on('configure', (mode) => {
      this.pending = mode === DECORATION_MODE.SERVER_SIDE ? 'server' : 'client';
    });
    this.prefer(prefer);
  }

  /** State (or restate) the preference; the compositor answers with a configure. */
  prefer(prefer) {
    if (this.destroyed) return;
    this.proxy.$.set_mode(
      prefer === 'client'
        ? DECORATION_MODE.CLIENT_SIDE
        : DECORATION_MODE.SERVER_SIDE,
    );
  }

  /**
   * Adopt the pending mode, if there is one.
   *
   * @returns {boolean} whether the mode in effect changed
   */
  adopt() {
    if (this.pending == null) return false;
    const changed = this.pending !== this.mode;
    this.mode = this.pending;
    this.pending = null;
    if (changed) this.emit('mode', this.mode);
    return changed;
  }

  /** Before the toplevel: destroying them the other way round is a protocol error. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.proxy.$.destroy();
    } catch {
      /* the connection may already be gone */
    }
  }
}
