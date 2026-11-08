// `<video src>` in a `<Frame>` pane on macOS. A pane process runs no
// NSApplication, so nothing there pumps the bridge's events, and a player it
// made would open the item and never hear AVFoundation say a word: no size,
// no play, no frame. So a pane's player is the host's. `PanePlayer` is what
// the pane's `<video>` holds — the same state and the same verbs as a
// `CocoaPlayer` — and it sends every verb up the frame channel; the host
// makes a real `CocoaPlayer` for it (`HostedPlayer`, made by
// src/cocoa/panehost.js) and sends its events back down.
//
// The picture comes down the way a pane's own goes up, the other way round:
// the host copies the frame showing into one of a ring of shared IOSurfaces
// (`playerCopyFrame`, src/cocoa/panering.js) and names it, and the pane looks
// it up by id and copies it into the element's surface when the element asks
// (`copyFrame`, a `blitSurface` memcpy). A pane has no layers to lift a part
// onto, so its `<video>` always draws.

import { canReadRing, HostRing, PaneRing } from './panering.js';
import { PlayerState } from './player.js';

// How often the host asks its player for a frame while it plays — the
// drawn `<video>`'s own cadence (src/nodes/video.js): a copy answers null
// for a frame that has not changed, so asking every display frame costs a
// call, and sends nothing.
const PULL_MS = 16;

// How many times the host asks a paused player for the frame a seek or the
// item's arrival shows before giving up, a display frame apart: AVFoundation
// has it a few frames after the event, and a stream that never decodes one
// should not keep a timer running.
const WANT_TRIES = 60;

let seq = 0;

/** Can a pane's player be shown over this bridge? It looks the host's
 *  buffers up and copies out of them. */
export const canShowPanePlayers = canReadRing;

/**
 * The pane's end: a player whose item the host plays. Its state is what
 * the host's events say; the frame is whichever shared buffer the host
 * named last, copied out on request.
 */
export class PanePlayer extends PlayerState {
  constructor(app, src, options = {}) {
    super(options.element);
    this.app = app;
    this._native = app._native;
    this.id = `pane-player-${++seq}`;
    /** the host's newest frame: its buffer here, size and time */
    this._shown = null;
    this._fresh = false;
    /** the host's buffers, looked up; a frame held in one goes with them */
    this._ring = new PaneRing(this._native, {
      onDrop: () => {
        this._shown = null;
        this._fresh = false;
      },
    });
    app._players.set(this.id, this);
    this._post({
      op: 'create',
      src: String(src),
      options: {
        autoPlay: Boolean(options.autoPlay),
        loop: Boolean(options.loop),
        muted: Boolean(options.muted),
        volume: typeof options.volume === 'number' ? options.volume : 1,
        playbackRate:
          typeof options.playbackRate === 'number' ? options.playbackRate : 1,
        element: this.element,
      },
    });
  }

  // held until the host is listening, as the pane's windows are
  // (`CocoaApp._postWindow`): a `<video>` in the pane's first commit asks
  // before the host has a pane host to answer
  _post(msg) {
    this.app._postWindow({ type: 'pane-player', player: this.id, ...msg });
  }

  set({ paused, playbackRate, volume, muted, loop } = {}) {
    if (this.released) return;
    this._post({
      op: 'set',
      settings: { paused, playbackRate, volume, muted, loop },
    });
  }

  seek(seconds) {
    if (this.released || !Number.isFinite(seconds)) return;
    this.currentTime = Math.max(0, seconds);
    this._post({ op: 'seek', seconds: this.currentTime });
  }

  /** The host named a buffer with a new frame in it. */
  _frame({ surface, width, height, time, seq }) {
    if (this.released) return;
    const handle = this._ring.lookUp(surface, width, height);
    // this frame's lookup is done, whatever it found: the host may free the
    // buffer, which it kept for it (`HostRing._freeRing`)
    if (seq != null) this._post({ op: 'seen', seq });
    if (!handle) return;
    this._shown = { handle, width, height, time };
    this._fresh = true;
    // a playing `<video>` asks every display frame; a paused one asks when
    // its time moves, and the frame a seek shows arrives after the time it
    // landed on did — so it is told the time again, with the frame in hand
    if (!this.playing) {
      this._event({
        type: 'player-time',
        id: this.id,
        currentTime: this.currentTime,
      });
    }
  }

  /** As `CocoaPlayer.copyFrame`: the newest frame into `surface`, or null
   *  when the host has sent nothing since the last copy. */
  copyFrame(surface) {
    const shown = this._shown;
    if (this.released || !this._fresh || !surface?._surfaceHandle) return null;
    const { width, height, time } = shown;
    const fits = surface.width === width && surface.height === height;
    if (fits) {
      this._ring.copy(shown.handle, width, height, surface._surfaceHandle);
      this._fresh = false;
    }
    return { width, height, time, written: fits };
  }

  release() {
    if (this.released) return;
    this.released = true;
    this._listeners.clear();
    this.app._players.delete(this.id);
    this._ring.drop();
    this._post({ op: 'release' });
  }
}

/**
 * The host's end: a real player for one of the pane's, its events sent down
 * as they come and its frames copied into the shared ring while it plays —
 * or, paused, the one frame a seek or the item's arrival shows. An
 * `<audio>`'s has no picture, so nothing is copied and no ring is made —
 * a video file it plays for its sound included, whose frames nobody sees.
 */
export class HostedPlayer {
  constructor(app, send, { player, src, options }) {
    this.app = app;
    this._native = app._native;
    this._send = send;
    this.id = player;
    this.player = app.createPlayer(src, options);
    this._picture = this.player.element !== 'audio';
    this._ring = new HostRing(this._native);
    this._ringSize = null;
    this._want = 0;
    this._pull = null;
    this._off = this.player._subscribe((ev) => this._event(ev));
  }

  /** A message from the pane about this player. */
  handle(msg) {
    const player = this.player;
    if (player.released) return;
    if (msg.op === 'set') player.set(msg.settings);
    else if (msg.op === 'seek') player.seek(msg.seconds);
    else if (msg.op === 'seen') this._ring.seen(msg.seq);
    else if (msg.op === 'release') this.release();
  }

  _event(ev) {
    this._send({
      type: 'pane-player-event',
      player: this.id,
      ev: { ...ev, id: this.id },
    });
    const player = this.player;
    if (!this._picture) return;
    // a new size is what the next frame is copied at
    if (ev.type === 'player-metadata') this._ringSize = null;
    // the item's first frame, and the frame a seek lands on while paused,
    // are the frames nothing playing would copy
    if (
      ev.type === 'player-metadata' ||
      (ev.type === 'player-time' && !player.playing)
    ) {
      this._want = WANT_TRIES;
      this._copy();
    }
    this._syncPull();
  }

  _syncPull() {
    const player = this.player;
    const want = !player.released && (player.playing || this._want > 0);
    if (want && this._pull === null) {
      this._pull = setInterval(() => this._copy(), PULL_MS);
      this._pull.unref?.();
    } else if (!want && this._pull !== null) {
      clearInterval(this._pull);
      this._pull = null;
    }
  }

  /** The frame showing into the next buffer of the ring, and the pane told
   *  which; nothing when the player has nothing new. */
  _copy() {
    const player = this.player;
    if (player.released) return;
    const size = this._ringSize ?? {
      width: player.width,
      height: player.height,
    };
    let got = null;
    if (size.width > 0 && size.height > 0) {
      let named;
      ({ got, named } = this._ring.fill(size.width, size.height, (handle) =>
        this._native.playerCopyFrame(player.id, handle),
      ));
      if (named) {
        this._send({
          type: 'pane-player-frame',
          player: this.id,
          surface: named.surface,
          width: got.width,
          height: got.height,
          time: got.time,
          seq: named.seq,
        });
        if (!player.playing) this._want = 0;
      } else if (got?.width > 0 && got?.height > 0) {
        // a frame of another size than the ring (a stream that switched
        // renditions): the next is copied into a ring of its size
        this._ringSize = { width: got.width, height: got.height };
      }
    }
    if (!got?.written && this._want > 0) this._want -= 1;
    this._syncPull();
  }

  release() {
    if (this.player.released) return;
    this._off();
    this.player.release();
    this._want = 0;
    this._syncPull();
    // and what the ring kept: the pane's player is gone, or the pane is
    this._ring.release();
  }
}
