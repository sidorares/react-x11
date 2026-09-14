// Server-side decorations: asking the compositor to draw the frame, and
// falling back to drawing it ourselves only when nothing will.
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
// ## Two protocols say the same thing
//
// `xdg-decoration-unstable-v1` is the one to ask with, and where it is
// offered it is the only one used. But it arrived late (2018) and KDE had
// shipped `org_kde_kwin_server_decoration` years before, so a compositor may
// advertise only the older one — KWin still carries both, and a handful of
// smaller compositors never picked up the xdg protocol. Asking with whatever
// is there is the difference between a real titlebar and an imitation, so
// `createServerDecoration` tries them in that order and only gives up on
// server-side when neither global exists.
//
// The KDE protocol is the same conversation in different words: it hangs off
// the `wl_surface` rather than the `xdg_toplevel`, its enum has a third value
// (`none`, no frame at all), its destructor is `release`, and — the one
// difference that matters — its `mode` event is not part of a configure
// sequence. Nothing promises a configure will follow it, so that driver
// flushes itself (`flushesOutsideConfigure`); the xdg one keeps the stricter
// discipline below.
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
 * `org_kde_kwin_server_decoration.mode`. The two that overlap with
 * xdg-decoration share its numbering; `NONE` — no frame from either side —
 * has no xdg equivalent and is only ever received, never asked for. A window
 * that wants no frame asks for `CLIENT` and then draws nothing, which is the
 * same picture and one less thing for `decorationPolicy` to express.
 */
export const KDE_DECORATION_MODE = { NONE: 0, CLIENT: 1, SERVER: 2 };

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

/**
 * What both protocols have in common: a mode that arrives from the
 * compositor, is held until the frame that can paint it adopts it, and an
 * object that has to be destroyed before the thing it decorates.
 */
class Decoration extends EventEmitter {
  constructor() {
    super();
    /** the mode in effect: 'server' | 'client', null before the first answer */
    this.mode = null;
    /** a mode the compositor sent that the next configure adopts */
    this.pending = null;
    this.destroyed = false;
  }

  /**
   * Whether an answer can arrive with no configure behind it, in which case
   * whoever owns this has to flush it rather than wait (window.js). False
   * for xdg-decoration, whose mode is part of the configure sequence.
   */
  get flushesOutsideConfigure() {
    return false;
  }

  /** The compositor's answer, held until `adopt()`. */
  _answer(mode) {
    this.pending = mode;
    if (this.flushesOutsideConfigure) this.emit('pending');
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
      this._release();
    } catch {
      /* the connection may already be gone */
    }
  }
}

export class ServerDecoration extends Decoration {
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
    this.proxy.on('configure', (mode) => {
      this._answer(mode === DECORATION_MODE.SERVER_SIDE ? 'server' : 'client');
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

  _release() {
    this.proxy.$.destroy();
  }
}

/**
 * The same conversation over `org_kde_kwin_server_decoration`, for the
 * compositors that have only that one. It decorates the `wl_surface`, so it
 * is created from the surface rather than the toplevel — but the ordering
 * rule is the toplevel's all the same, since that is what carries the frame.
 */
export class KdeServerDecoration extends Decoration {
  /**
   * @param {object} opts
   * @param {object} opts.manager the `org_kde_kwin_server_decoration_manager`
   * @param {object} opts.surface the `wl_surface` proxy
   * @param {'server'|'client'} [opts.prefer='server']
   */
  constructor({ manager, surface, prefer = 'server' }) {
    super();
    this.proxy = manager.$.create(surface.id);
    this.proxy.on('mode', (mode) => {
      // `none` is not server-side, and this side draws nothing for it: the
      // window that asked for no frame is already drawing nothing.
      this._answer(mode === KDE_DECORATION_MODE.SERVER ? 'server' : 'client');
    });
    this.prefer(prefer);
  }

  /** Nothing sequences this protocol's `mode` event; window.js flushes it. */
  get flushesOutsideConfigure() {
    return true;
  }

  prefer(prefer) {
    if (this.destroyed) return;
    this.proxy.$.request_mode(
      prefer === 'client'
        ? KDE_DECORATION_MODE.CLIENT
        : KDE_DECORATION_MODE.SERVER,
    );
  }

  _release() {
    this.proxy.$.release();
  }
}

/**
 * Ask whichever protocol the compositor has, preferring the standard one.
 * Returns null only when there is nobody to ask — the case where the frame
 * has to be this backend's own (GNOME).
 *
 * @param {object} opts
 * @param {object} [opts.manager] `zxdg_decoration_manager_v1`, if bound
 * @param {object} [opts.kdeManager] `org_kde_kwin_server_decoration_manager`
 * @param {object} opts.toplevel the `xdg_toplevel` proxy
 * @param {object} opts.surface the `wl_surface` proxy
 * @param {'server'|'client'} [opts.prefer='server']
 * @returns {Decoration|null}
 */
export function createServerDecoration({
  manager,
  kdeManager,
  toplevel,
  surface,
  prefer = 'server',
}) {
  if (manager) return new ServerDecoration({ manager, toplevel, prefer });
  if (kdeManager)
    return new KdeServerDecoration({ manager: kdeManager, surface, prefer });
  return null;
}
