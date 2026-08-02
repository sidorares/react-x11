// Startup notification (freedesktop): tell the desktop the app has finished
// starting, and tell the window manager which user action started it.
//
// Two visible defects without it, for anyone who launches from a launcher
// rather than a terminal. The launcher opens a startup sequence when it
// spawns us and closes it when we say we are up; say nothing and it runs to
// mutter's STARTUP_TIMEOUT_MS, which is 15 seconds of busy cursor over a
// window the user is already clicking. And `_NET_WM_USER_TIME` is the
// evidence focus-stealing prevention weighs when deciding whether a new
// window may come forward; with none, a strict desktop opens us behind
// whatever the user was doing.
//
// This is core rather than an integration package: it is X11 over the
// connection the renderer already has, using calls already in ntk and
// node-x11 — no dependency, no engines floor, nothing to opt into. It sits
// next to `WM_DELETE_WINDOW` and `_NET_WM_PID` in kind.
//
// See docs/desktop.md. Issue #174.
import { eventMask } from 'x11/lib/eventmask.js';

/** mutter gives up at 15s. This is the backstop for an app that never
 *  paints at all — early enough to beat that by a margin, late enough that
 *  no honest first frame trips it. */
const BACKSTOP_MS = 10_000;

const BEGIN = '_NET_STARTUP_INFO_BEGIN';
const CONTINUE = '_NET_STARTUP_INFO';
/** The protocol's chunk size: format 8, 20 bytes per ClientMessage. */
const CHUNK = 20;

/**
 * Take `DESKTOP_STARTUP_ID` out of the environment.
 *
 * **Deleted, not merely read.** The variable names exactly one launch, and
 * a child process that inherits it claims a sequence that is not its own
 * and ends it early — the parent's busy cursor stops when the child starts.
 * Every toolkit that gets this wrong produces that same bug, which is why
 * the read is destructive rather than tidy.
 *
 * Deliberately not memoized: the deletion is the memo, and a cache here
 * would outlive the launch it belongs to.
 */
function consumeEnv() {
  const found = process.env?.DESKTOP_STARTUP_ID || null;
  if (process.env) delete process.env.DESKTOP_STARTUP_ID;
  return found;
}

/** The id in force: whatever a root was given, else the environment's.
 *  `undefined` until something has looked. */
let currentId;

/** The live session, if any. One per process, because one launch is. */
let current = null;

/**
 * The X server timestamp of the user action that launched this app, from
 * the `_TIME` suffix of the startup id, or `null`.
 *
 * `null` is a real answer rather than a failure: an app started from a
 * shell has no launch timestamp and never will. Callers that want to raise
 * a window use it as the "when", and `0` is not a substitute — EWMH gives
 * zero its own meaning ("do not focus this on map").
 */
export function launchTimestamp() {
  if (currentId === undefined) currentId = consumeEnv();
  return parseLaunchTime(currentId);
}

/** `foo_TIME12345` → `12345`. Anything else, including a `_TIME` that is
 *  not a number, is `null`. Never throws. */
export function parseLaunchTime(id) {
  if (typeof id !== 'string') return null;
  const at = id.lastIndexOf('_TIME');
  if (at < 0) return null;
  const digits = id.slice(at + 5);
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * A value as the protocol's parser wants it. Always quoted, which is always
 * legal and saves deciding; inside the quotes only `\` and `"` are escaped.
 *
 * Note what this is *not*: C escaping. The spec is explicit that `\n` here
 * means the letter n, so a newline passes through as itself and must not be
 * turned into a backslash and an n.
 */
function quote(value) {
  return `"${String(value).replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** `remove: ID="foo"` — a message type and its key/value pairs. */
export function encodeStartupMessage(type, fields) {
  const pairs = Object.entries(fields)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${quote(v)}`);
  return `${type}: ${pairs.join(' ')}`;
}

/**
 * The message split into the ClientMessages that carry it: 20 bytes each,
 * nul-terminated, zero-padded.
 *
 * The trailing nul is part of the message rather than padding, so a message
 * whose bytes land on an exact multiple of 20 still needs the chunk after
 * it — otherwise the last byte used is not a nul and a strict reader waits
 * forever for the rest.
 */
export function messageChunks(text) {
  const body = Buffer.from(text, 'utf8');
  const bytes = Buffer.concat([body, Buffer.from([0])]);
  const chunks = [];
  for (let at = 0; at < bytes.length; at += CHUNK) {
    const chunk = new Array(CHUNK).fill(0);
    for (let i = 0; i < CHUNK && at + i < bytes.length; i++) {
      chunk[i] = bytes[at + i];
    }
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * Resolve the `startupNotification` option into `{ id, completeOn }`, or
 * `null` for opted out.
 *
 * `completeOn` defaults to `'paint'` — see `StartupSession.painted`.
 */
function settings(option) {
  if (option === false) return null;
  // Consumed either way, even when an explicit id wins: leaving it set
  // would hand this launch's id to the next child process spawned.
  const fromEnv = consumeEnv();
  const given =
    typeof option === 'string'
      ? { id: option }
      : option && typeof option === 'object'
        ? option
        : {};
  return { id: given.id ?? fromEnv, completeOn: given.completeOn ?? 'paint' };
}

class StartupSession {
  constructor(app, { id, completeOn }) {
    this.app = app;
    this.id = id;
    this.completeOn = completeOn;
    this.time = parseLaunchTime(id);
    this.done = false;
    this.timer = null;
  }

  /**
   * `_NET_STARTUP_ID` and `_NET_WM_USER_TIME` on the first toplevel, and
   * **before it maps**: EWMH's guarantee is about the state of the window at
   * the moment it is mapped, so setting them afterwards is too late and
   * looks identical in a log.
   */
  decorate(wnd) {
    if (this.claimed || !this.id) return;
    this.claimed = wnd;
    wnd.setProperty?.('_NET_STARTUP_ID', this.id);
    if (this.time !== null) {
      wnd.setProperty?.('_NET_WM_USER_TIME', [this.time], {
        type: 'CARDINAL',
        format: 32,
      });
    }
    // Intern now rather than at the moment of completion. Both are round
    // trips, and the whole point of this feature is that the second one
    // happens the instant the app is up — spending it here, while the first
    // frame is still being built, costs nothing anybody can see.
    this._primeAtoms(wnd);
  }

  _primeAtoms(wnd) {
    const X = wnd.X;
    if (!X?.InternAtom) return;
    const atom = (name) =>
      new Promise((resolve, reject) =>
        X.InternAtom(false, name, (err, id) =>
          err ? reject(err) : resolve(id),
        ),
      );
    this.atomsReady = Promise.all([atom(BEGIN), atom(CONTINUE)])
      .then((ids) => {
        this.atoms = ids;
      })
      .catch(() => {
        // A display that cannot intern an atom has worse problems than a
        // busy cursor, and the launcher's own timeout still covers this.
      });
  }

  /** The first toplevel is up. Arms the backstop; completes now if that is
   *  what this app asked for. */
  mapped(wnd) {
    if (this.done || !this.id || this.claimed !== wnd) return;
    if (this.completeOn === 'map') return this.complete();
    // Whichever comes first. An app that never paints — headless, a throw in
    // the first render, a window mounted hidden — must still end the
    // sequence, or this reproduces the bug it exists to fix.
    this.timer ??= setTimeout(() => this.complete(), BACKSTOP_MS);
    this.timer.unref?.();
  }

  /**
   * A flush actually painted — the default moment, and the one this
   * renderer can name where a toolkit that paints on map cannot.
   *
   * Not the map: `invalidate()` schedules through the frame clock and the
   * drawing happens in `flush()` a frame later, so a mapped window is an
   * empty one. Ending the sequence there stops the busy cursor over a blank
   * rectangle — compliant, and a worse answer than the timeout.
   *
   * Not "real" content either. If the first frame is a spinner because the
   * tree is suspended, that is exactly the right moment to stop the
   * *system's* spinner: the app is up and is telling the user what it is
   * doing. There is no signal for "finished loading" and guessing at one is
   * how this ends up back at fifteen seconds.
   */
  painted() {
    if (this.completeOn === 'paint') this.complete();
  }

  /**
   * Send `remove:` and stand down. Idempotent, because three things race to
   * call it and the protocol should see exactly one.
   */
  complete() {
    if (this.done) return;
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.app._reactX11Startup === this) this.app._reactX11Startup = null;
    const wnd = this.claimed;
    if (!this.id || !wnd) return;
    const text = encodeStartupMessage('remove', { ID: this.id });
    // Normally the atoms landed while the first frame was being built, and
    // this goes out in the same turn as the paint that triggered it. The
    // fallback is for completing before they arrive, which is what
    // `completeOn: 'map'` does on a cold connection.
    if (this.atoms) send(wnd, this.atoms, text);
    else this.atomsReady?.then(() => this.atoms && send(wnd, this.atoms, text));
  }
}

/**
 * Broadcast a startup message to the root window.
 *
 * Two things the transport gets wrong by default. The event mask has to be
 * `PropertyChange` — `SendClientMessage` defaults to the substructure pair
 * EWMH wants for root messages, and this protocol is not that. And the
 * `window` field names a window the *sender* owns, while the destination is
 * the root, which is why both are arguments.
 */
function send(wnd, [begin, cont], text) {
  const X = wnd.X;
  const root = X?.display?.screen?.[0]?.root;
  if (!X?.SendClientMessage || !root) return;
  messageChunks(text).forEach((chunk, i) => {
    X.SendClientMessage(
      root,
      wnd.id,
      i === 0 ? begin : cont,
      8,
      chunk,
      eventMask.PropertyChange,
    );
  });
}

/**
 * Begin a session for a root, or `null` when there is nothing to do — no
 * id in the environment (a terminal, CI, XQuartz) or the app opted out.
 * Nothing is sent and nothing is set in that case.
 */
export function beginStartup(app, option) {
  const resolved = settings(option);
  currentId = resolved?.id ?? null;
  if (!resolved?.id) return null;
  const session = new StartupSession(app, resolved);
  app._reactX11Startup = session;
  current = session;
  return session;
}

/**
 * End the startup sequence now. Idempotent, and a no-op when there is none,
 * so an app may call it unconditionally.
 *
 * This is the seam behind `completeOn: 'manual'`, for an app that knows
 * better than "the first frame" — one whose first frame is a splash it does
 * not want to be judged by, or which is up only once a session is restored.
 * No arguments, because a process has one launch however many roots it
 * builds.
 */
export function notifyStartupComplete() {
  current?.complete();
}
