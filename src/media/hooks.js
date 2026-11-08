// Media capture as render state (design/architecture/media-capture.md §2.2):
// the device list a picker renders, and acquisition folded into one hook in
// `usePermission`'s vocabulary instead of `permissions.query`, then
// `getUserMedia` in a try/catch, then a watch on the track.
//
//   const call = useUserMedia({ video: { width: 1280 }, audio: true });
//   // call.status: 'idle' | 'prompt' | 'pending' | 'live' | 'denied'
//   //            | 'unavailable' | 'error' | 'ended'
//   <video srcObject={call.stream} />
//
// The hook owns the tracks it opened: they stop when the component unmounts,
// when `stop()` is called, and when the constraints change — which opens the
// new ones. Two components asking for the same device at the same settings
// share one session underneath (src/media/stream.js), so a preview and a
// call screen mounted together do not fight over the camera.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';

import { useApp } from '../appcontext.js';
import {
  enumerateDevices,
  getDisplayMedia,
  getUserMedia,
  watchDevices,
} from './capture.js';
import { constraintsKey } from './constraints.js';

// --- the device list -------------------------------------------------------------

const PENDING_DEVICES = Object.freeze({
  devices: Object.freeze([]),
  cameras: Object.freeze([]),
  microphones: Object.freeze([]),
  speakers: Object.freeze([]),
  settled: false,
});

const sameDevices = (a, b) =>
  a.length === b.length &&
  a.every(
    (d, i) =>
      d.deviceId === b[i].deviceId &&
      d.kind === b[i].kind &&
      d.label === b[i].label &&
      d.isDefault === b[i].isDefault,
  );

/** One app's device list, read while anyone renders it and followed while it
 *  changes. */
class DeviceStore {
  constructor(app) {
    this.app = app;
    this.snapshot = PENDING_DEVICES;
    this._listeners = new Set();
    this._off = null;
    this._token = 0;
    this.subscribe = this.subscribe.bind(this);
    this.getSnapshot = () => this.snapshot;
  }

  subscribe(fn) {
    this._listeners.add(fn);
    if (this._listeners.size === 1) {
      this._off = watchDevices(() => this._refresh(), { app: this.app });
      this._refresh();
    }
    return () => {
      this._listeners.delete(fn);
      if (this._listeners.size === 0) {
        this._off?.();
        this._off = null;
        this._token++;
      }
    };
  }

  _refresh() {
    const token = ++this._token;
    enumerateDevices({ app: this.app }).then(
      (devices) => {
        if (token !== this._token) return;
        if (
          this.snapshot.settled &&
          sameDevices(this.snapshot.devices, devices)
        ) {
          return;
        }
        const of = (kind) =>
          Object.freeze(devices.filter((d) => d.kind === kind));
        this.snapshot = Object.freeze({
          devices: Object.freeze(devices),
          cameras: of('videoinput'),
          microphones: of('audioinput'),
          speakers: of('audiooutput'),
          settled: true,
        });
        for (const fn of [...this._listeners]) fn();
      },
      () => {},
    );
  }
}

const deviceStores = new WeakMap();

/**
 * The cameras, microphones and speakers there are, kept current as they are
 * plugged in and out: `{ devices, cameras, microphones, speakers, settled }`.
 * Empty and `settled: false` on the first frame — the list takes a moment to
 * read — so a picker renders its placeholder first and fills in, rather than
 * flashing "no camera". Names are there before any permission.
 */
export function useMediaDevices() {
  const app = useApp();
  let store = deviceStores.get(app);
  if (!store) deviceStores.set(app, (store = new DeviceStore(app)));
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}

// --- acquiring a stream ------------------------------------------------------------

const IDLE = Object.freeze({ status: 'idle', stream: null, error: null });

/** What a rejection means for a component deciding what to render. */
function statusOf(err) {
  switch (err?.name) {
    case 'NotAllowedError':
      return 'denied';
    case 'NotFoundError':
    case 'NotSupportedError':
      return 'unavailable';
    default:
      return 'error';
  }
}

/**
 * One stream at a time, opened by `open(request, options)`: started,
 * restarted with other constraints, stopped. Outside React so the hook is
 * only its binding.
 */
class MediaSession {
  constructor(app, open) {
    this.app = app;
    this.open = open;
    this.state = IDLE;
    this._run = null;
    this._listeners = new Set();
    this.subscribe = (fn) => {
      this._listeners.add(fn);
      return () => this._listeners.delete(fn);
    };
    this.getSnapshot = () => this.state;
  }

  get running() {
    return this._run !== null;
  }

  _set(state) {
    if (
      state.status === this.state.status &&
      state.stream === this.state.stream &&
      state.error === this.state.error
    ) {
      return;
    }
    this.state = Object.freeze(state);
    for (const fn of [...this._listeners]) fn();
  }

  start(request) {
    this._end();
    const run = { abort: new AbortController(), stream: null, off: null };
    this._run = run;
    this._set({ status: 'pending', stream: null, error: null });
    this.open(request, {
      app: this.app,
      signal: run.abort.signal,
      onPrompt: () => {
        if (this._run === run) {
          this._set({ status: 'prompt', stream: null, error: null });
        }
      },
    }).then(
      (stream) => {
        if (this._run !== run) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        run.stream = stream;
        run.off = stream.onChange(() => {
          if (this._run === run && !stream.active) {
            this._set({ status: 'ended', stream, error: null });
          }
        });
        this._set({
          status: stream.active ? 'live' : 'ended',
          stream,
          error: null,
        });
      },
      (error) => {
        if (this._run !== run) return;
        if (error?.name === 'AbortError') return;
        this._set({ status: statusOf(error), stream: null, error });
      },
    );
  }

  /** The current run's tracks stopped, and its answer ignored if it is still
   *  coming. */
  _end() {
    const run = this._run;
    if (!run) return;
    this._run = null;
    run.abort.abort();
    run.off?.();
    for (const t of run.stream?.getTracks() ?? []) t.stop();
  }

  stop() {
    this._end();
    this._set(IDLE);
  }
}

function useMediaSession(open, request, autoStart) {
  const app = useApp();
  const session = useMemo(() => new MediaSession(app, open), [app, open]);
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const latest = useRef(request);
  latest.current = request;
  const key = constraintsKey(request);
  const before = useRef(null);

  useEffect(() => () => session.stop(), [session]);
  useEffect(() => {
    const was = before.current;
    before.current = { key, autoStart };
    if (autoStart) {
      session.start(latest.current);
    } else if (was?.autoStart) {
      // `start: false` after true: off, as the option now says
      session.stop();
    } else if (was && was.key !== key && session.running) {
      // started by hand, and asked for something else since: the new thing
      session.start(latest.current);
    }
  }, [session, key, autoStart]);

  const start = useCallback(() => session.start(latest.current), [session]);
  const stop = useCallback(() => session.stop(), [session]);
  return useMemo(() => ({ ...state, start, stop }), [state, start, stop]);
}

/**
 * A camera, a microphone or both, as render state:
 *
 * ```jsx
 * const call = useUserMedia({
 *   video: { deviceId, width: 1280, frameRate: 30 },
 *   audio: { echoCancellation: true },
 * });
 * if (call.status === 'denied') return <AskForCamera />;
 * <video srcObject={call.stream} style={{ objectFit: 'cover' }} />;
 * ```
 *
 * `{ status, stream, error, start(), stop() }`. Starts when the component
 * mounts and again when the constraints change — pass `{ start: false }`
 * to wait for `start()`. `status` is `'idle'` before a start and after a
 * stop, `'prompt'` while the system asks the user, `'pending'` while the
 * device opens, `'live'`, `'denied'` (`NotAllowedError`), `'unavailable'`
 * (no such device, or nothing here can open one), `'error'` (in use
 * elsewhere, overconstrained — `error` says which), and `'ended'` once
 * every track has ended other than by `stop()`: the camera unplugged, or a
 * track the app stopped by hand.
 */
export function useUserMedia(constraints, options = {}) {
  return useMediaSession(getUserMedia, constraints, options.start ?? true);
}

/**
 * A screen or a window, as render state — `useUserMedia`'s shape over
 * `getDisplayMedia`:
 *
 * ```jsx
 * const share = useDisplayMedia({ video: { frameRate: 30 } });
 * <button onClick={share.start}>Share screen</button>
 * ```
 *
 * Unlike `useUserMedia` it **waits for `start()`** unless `{ start: true }`
 * is passed: sharing a screen is something a user asks for, and a picker
 * that opens because a component mounted is one nobody asked to see.
 */
export function useDisplayMedia(request = {}, options = {}) {
  return useMediaSession(getDisplayMedia, request, options.start ?? false);
}
