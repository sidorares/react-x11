// The Wayland connection: a socket that can carry file descriptors, the
// protocol definitions loaded on top of it, and the globals the compositor
// advertises.
//
// Two things about this transport are worth stating up front, because they
// are the reason this backend exists as a separate thing rather than as a
// branch inside the X11 one.
//
// **Descriptors are not an optimisation here, they are the protocol.** The
// compositor sends the keymap as an fd; `wl_shm` pools go over as fds; a
// clipboard offer is a pipe fd. A transport that cannot receive descriptors
// is not a limited Wayland client, it is not a Wayland client. Node cannot on
// its own: an fd arriving on a libuv-read socket aborts the process, and
// nodejs/node#53391 — filed for exactly this — is closed "not planned". So
// there are two transports here, tried in order:
//
//   1. `x11-dri`'s `UnixSocket` — a native socket on the event loop
//      (`uv_poll`), no thread, works on Node and Bun. The measured cost of
//      the alternative below is what justified writing it.
//   2. node-x11's `fdpass-bun.js` — `bun:ffi` to `sendmsg`/`recvmsg`, with a
//      reader thread blocked in `poll(2)` because Bun's own reader drops
//      ancillary data it did not ask for. Bun only, and ~37µs of round-trip
//      latency for the thread hop (measured: 0.178ms vs 0.141ms sync→done).
//
// **The wire matches descriptors to arguments by position in the stream, not
// by message.** The spec is blunt that any byte, even a message header, may
// carry the ancillary data. That is why the fd queue is drained in parse
// order and never searched: the nth `fd` argument parsed takes the nth
// descriptor received, and any cleverness beyond that is a bug waiting for a
// compositor that batches differently.
//
// The protocol definitions are vendored as JSON under `./protocols/`
// (converted from wayland-protocols with the library's own parser), so the
// backend does not depend on the distribution's XML being installed or on
// the optional `xml-js`.

import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const WAYLAND_CLIENT_DISPLAY = ['wayland-client', 'dist', 'display.js'].join(
  '/',
);
const here = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL_DIR = path.join(here, 'protocols');

/**
 * The protocols this backend knows how to speak, over and above core
 * `wayland.xml`. Each is optional: a compositor that does not advertise the
 * global simply leaves the corresponding feature unavailable, which is the
 * same shape as an X extension that is not there.
 */
export const PROTOCOLS = [
  // The core protocol first: the library ships its own copy of wayland.xml,
  // and the vendored one is newer (wl_seat 9, with axis_value120 and
  // friends). Loading it over the library's updates every interface except
  // the two whose proxies already exist — see `loadCore`.
  'wayland',
  'xdg-shell',
  'linux-dmabuf-v1',
  'presentation-time',
  'viewporter',
  'fractional-scale-v1',
  'cursor-shape-v1',
  'tablet-v2',
  'xdg-activation-v1',
  'xdg-decoration-unstable-v1',
  'primary-selection-unstable-v1',
  'text-input-unstable-v3',
  'pointer-constraints-unstable-v1',
  'relative-pointer-unstable-v1',
  'ext-idle-notify-v1',
  'xdg-toplevel-icon-v1',
  'xdg-output-unstable-v1',
  'wlr-layer-shell-unstable-v1',
  'wlr-screencopy-unstable-v1',
  'ext-image-capture-source-v1',
  'ext-image-copy-capture-v1',
];

const definitions = new Map();
function protocolDefinitions(name) {
  let defs = definitions.get(name);
  if (!defs) {
    defs = JSON.parse(
      readFileSync(path.join(PROTOCOL_DIR, `${name}.json`), 'utf8'),
    );
    definitions.set(name, defs);
  }
  return defs;
}

/**
 * Open the fd-capable socket, or explain why there is none.
 *
 * @returns {{socket: object, transport: string}}
 */
function openSocket(socketPath, prefer) {
  const attempts = [];
  const order = prefer ? [prefer] : ['x11-dri', 'fdpass-bun'];

  for (const kind of order) {
    if (kind === 'x11-dri') {
      if (typeof Bun !== 'undefined') {
        // Bun exports libuv's symbols but aborts the process from several
        // of them (uv_poll_init included); nothing can be probed safely.
        attempts.push(
          'x11-dri: UnixSocket needs libuv polling, which Bun does not give addons',
        );
        continue;
      }
      try {
        const dri = require('x11-dri');
        if (typeof dri.UnixSocket === 'function') {
          return {
            socket: new dri.UnixSocket(socketPath),
            transport: 'x11-dri',
          };
        }
        attempts.push(
          'x11-dri: installed, but this version has no UnixSocket (needs >= 0.9)',
        );
      } catch (err) {
        attempts.push(`x11-dri: ${err.message.split('\n')[0]}`);
      }
    } else if (kind === 'fdpass-bun') {
      try {
        const fdpass = require('x11/lib/fdpass-bun.js');
        if (fdpass.available()) {
          const socket = fdpass.connect(socketPath, { receiveFds: true });
          if (socket) return { socket, transport: 'fdpass-bun' };
          attempts.push('fdpass-bun: connect returned null');
        } else {
          attempts.push('fdpass-bun: needs Bun (bun:ffi)');
        }
      } catch (err) {
        attempts.push(`fdpass-bun: ${err.message.split('\n')[0]}`);
      }
    }
  }
  throw new Error(
    'no transport can pass file descriptors over the Wayland socket, which the protocol requires.\n' +
      attempts.map((a) => `  - ${a}`).join('\n') +
      '\nInstall x11-dri >= 0.9 (native, Node and Bun), or run under Bun.',
  );
}

/**
 * The compositor connection.
 *
 * Wraps `wayland-client`'s `Display` rather than replacing it: the wire codec
 * and the XML-driven proxy generation are exactly the parts worth not
 * rewriting, and the socket is injected through its constructor, which is the
 * seam this needs.
 */
export class WaylandConnection extends EventEmitter {
  constructor(display, socket, transport) {
    super();
    this.display = display;
    this.socket = socket;
    /** which fd transport carried this connection: 'x11-dri' or 'fdpass-bun' */
    this.transport = transport;
    /** interface name -> bound proxy, for the singletons everyone shares */
    this._bound = new Map();
    /** the {@link Registry} view, once something has asked for it */
    this._registry = null;
    this.destroyed = false;
  }

  /**
   * Connect, bring up `wl_registry`, and load the protocol definitions.
   *
   * @param {object} [opts]
   * @param {string} [opts.display] `WAYLAND_DISPLAY`, or an absolute socket path
   * @param {string[]} [opts.protocols] which of {@link PROTOCOLS} to load
   * @param {'x11-dri'|'fdpass-bun'} [opts.transport] force one transport
   */
  static async open({
    display: name,
    protocols = PROTOCOLS,
    transport,
    socket: injected,
  } = {}) {
    // An open connection keeps the process alive, as a net.Socket would. The
    // fd transports do not: Bun's reads happen on a worker the runtime does
    // not count, so an app with nothing else pending — no timer, no server —
    // exited the moment its module finished evaluating, before `connect`
    // had even fired (`bun examples/simple.jsx` ran for 0.36 s and returned
    // 0). A ref'd interval is the one portable handle that says "still
    // running" to both runtimes; it starts before the first await and is
    // cleared with the connection.
    const keepAlive = setInterval(() => {}, 0x7fffffff);
    try {
      return await WaylandConnection._open(
        { display: name, protocols, transport, socket: injected },
        keepAlive,
      );
    } catch (err) {
      clearInterval(keepAlive);
      throw err;
    }
  }

  static async _open(
    { display: name, protocols, transport, socket: injected },
    keepAlive,
  ) {
    let socket;
    let used;
    let socketPath = '(injected socket)';
    if (injected) {
      // A connected socket the caller made — a socketpair end talking to an
      // in-process compositor in the tests. It only has to be
      // net.Socket-shaped; whether descriptors pass then depends on what it is.
      socket = injected;
      used = 'injected';
    } else {
      const wanted = name ?? process.env.WAYLAND_DISPLAY;
      if (!wanted)
        throw new Error('WAYLAND_DISPLAY is not set and no display was named');
      socketPath = wanted.startsWith('/')
        ? wanted
        : path.join(process.env.XDG_RUNTIME_DIR ?? '/run/user/1000', wanted);
      ({ socket, transport: used } = openSocket(socketPath, transport));
    }
    // The library's callback requests add a listener per in-flight call;
    // a frame of `damage` calls followed by `sync` is well over ten.
    socket.setMaxListeners?.(0);
    if (!(injected && injected.connecting === false)) {
      await new Promise((resolve, reject) => {
        const ok = () => {
          socket.off('error', fail);
          resolve();
        };
        const fail = (err) => {
          socket.off('connect', ok);
          reject(
            new Error(
              `could not connect to the compositor at ${socketPath}: ${err.message}`,
            ),
          );
        };
        socket.once('connect', ok);
        socket.once('error', fail);
      });
    }

    // A computed specifier on purpose: a bundler (the docs site's esbuild)
    // resolves a literal `import('wayland-client/…')` at build time and fails
    // where the package is not installed. The fork is consumed through a
    // link until it is published, and this backend is optional either way.
    const { default: Display } = await import(WAYLAND_CLIENT_DISPLAY);
    const display = new Display(socket);
    display.setMaxListeners(0);
    const conn = new WaylandConnection(display, socket, used);
    conn._keepAlive = keepAlive;

    display.on('error', (err) => {
      // Nothing after destroy() is news, and Bun's reader thread reports its
      // own shutdown as two errors when the process exits under it — a
      // connection that is going away is a close, not a failure.
      if (conn.destroyed) return;
      if (
        /reader thread stopped|waiting on the connection failed/.test(
          err?.message ?? '',
        )
      ) {
        conn._closed();
        return;
      }
      if (err?.name === 'WaylandProtocolError') {
        // Fatal by definition: the compositor has closed its end already.
        // Nothing may write to it from here — the next frame's commit would
        // die of EPIPE, which was the error a user saw second, after the one
        // that mattered — so the connection is dead before anyone hears
        // why, and the keep-alive goes with it.
        conn.destroyed = true;
        conn._release();
      }
      conn.emit('error', err);
    });
    display.on('warning', (w) => conn.emit('warning', w));
    display.on('close', () => {
      if (conn.destroyed) return;
      conn._closed();
    });

    await display.init();
    for (const key of protocols) {
      const defs = protocolDefinitions(key);
      // `init()` created wl_display and wl_registry from the library's own
      // definitions and patched wl_registry.bind's argument list in place;
      // replacing those two would lose the patch and orphan the proxies.
      await display.load(
        key === 'wayland'
          ? defs.filter(
              (d) => d.name !== 'wl_display' && d.name !== 'wl_registry',
            )
          : defs,
      );
    }
    return conn;
  }

  /** Every global the compositor advertised, by interface name. */
  get globals() {
    return new Set(this.display.listGlobals());
  }

  has(iface) {
    return this.globals.has(iface);
  }

  /**
   * Bind a singleton global once and hand the same proxy out afterwards.
   *
   * Returns null for a global the compositor does not advertise, so a caller
   * can treat an absent protocol as a missing capability rather than an
   * error — which is what most of them are.
   */
  async bind(iface, version) {
    if (this._bound.has(iface)) return this._bound.get(iface);
    if (!this.has(iface)) return null;
    const proxy = await this.display.bind(iface, version);
    proxy.setMaxListeners?.(0);
    this._bound.set(iface, proxy);
    return proxy;
  }

  /** Bind, or throw naming what the compositor would need to support. */
  async require(iface, version) {
    const proxy = await this.bind(iface, version);
    if (!proxy) {
      throw new Error(
        `this compositor does not advertise ${iface}. ` +
          `Available globals: ${[...this.globals].sort().join(', ')}`,
      );
    }
    return proxy;
  }

  /**
   * The registry as a list rather than a dictionary: every global with the
   * numeric name the compositor gave it, and the arrivals and departures
   * after startup.
   *
   * `bind()` above is enough for the singletons, but the library files
   * globals by interface name, so of three `wl_output`s it remembers the
   * last — and its own registry consumed the initial announcement inside
   * `init()`, before anything here could listen. A second `wl_registry` is
   * the protocol's own answer: the compositor replays its globals to each
   * registry it hands out and sends `global`/`global_remove` to all of them
   * afterwards, which is also what makes hot-plug visible. One round trip,
   * paid by the first caller, then shared.
   */
  async registry() {
    if (!this._registry) {
      this._registry = (async () => {
        const view = new Registry(this);
        await view._open();
        return view;
      })();
    }
    return this._registry;
  }

  /**
   * Wait for everything sent so far to have been processed.
   *
   * `wl_display.sync` is the only ordering primitive Wayland has — there are
   * no replies to requests — so this stands in for every "did that work?"
   * round trip an X client would write.
   */
  async roundtrip() {
    await this.display.sync();
  }

  /** The compositor went away, or the socket did: one 'close', then quiet. */
  _closed() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._release();
    this.emit('close');
  }

  _release() {
    if (this._keepAlive) {
      clearInterval(this._keepAlive);
      this._keepAlive = null;
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._release();
    // The reader worker reports the descriptor closing under it as an
    // error, on the socket, after this returns; with no listener left that
    // is an uncaught exception at exit (examples/app.jsx died of it).
    this.socket.on?.('error', () => {});
    // `end(cb)` on the fd transports does not take a callback the way
    // net.Socket does, and a reader thread keeps the process alive until the
    // descriptor is actually gone — so tear down rather than half-close.
    this.socket.destroy();
  }
}

/**
 * What {@link WaylandConnection.registry} hands out.
 *
 * Emits `global(name, interface, version)` and `global_remove(name)` for
 * changes after the initial list — the initial list itself is in `globals`
 * by the time the promise resolves, so a caller reads first and listens
 * second without a gap between the two.
 */
export class Registry extends EventEmitter {
  constructor(conn) {
    super();
    this.setMaxListeners(0);
    this.conn = conn;
    /** numeric name -> { interface, version } */
    this.globals = new Map();
    this.proxy = null;
  }

  async _open() {
    const display = this.conn.display;
    // Synchronous on purpose: the listeners have to be on before the first
    // announcement can be parsed, and the request's bytes go out now.
    this.proxy = display.wl_display.$.get_registry();
    this.proxy.setMaxListeners?.(0);
    this.proxy.on('global', (name, iface, version) => {
      this.globals.set(name, { interface: iface, version });
      if (this._opened) this.emit('global', name, iface, version);
    });
    this.proxy.on('global_remove', (name) => {
      this.globals.delete(name);
      if (this._opened) this.emit('global_remove', name);
    });
    await this.conn.roundtrip();
    this._opened = true;
  }

  /** Every global of one interface: `[{ name, interface, version }]`. */
  of(iface) {
    const out = [];
    for (const [name, g] of this.globals)
      if (g.interface === iface) out.push({ name, ...g });
    return out;
  }

  /**
   * Bind one global by its numeric name, at the highest version both sides
   * speak (or `version`, when lower). A fresh proxy each time, the caller's
   * to release; null once the global has gone.
   */
  bind(name, iface, version) {
    const entry = this.globals.get(name);
    if (!entry || entry.interface !== iface) return null;
    const display = this.conn.display;
    const def = display.getDefinition(iface);
    const negotiated = Math.min(
      def.version,
      entry.version,
      version ?? Infinity,
    );
    const proxy = display.createInterface(iface, negotiated);
    proxy.setMaxListeners?.(0);
    this.proxy.$.bind(name, iface, negotiated, proxy.id);
    return proxy;
  }
}
