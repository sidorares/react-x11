// A small Wayland compositor, in-process, for tests.
//
// The X11 suite's superpower is `x11/lib/xserver`: a pure-JS X server the
// tests connect to, so every test runs the real protocol with no display.
// This is the Wayland twin, and it is smaller — the hard part of that server
// is the drawing protocol, and Wayland has none. What a compositor has to do
// to drive this client end to end is: answer the registry, hand out objects,
// complete the configure handshake, answer frame callbacks, and inject seat
// events. That is all this does, and it records every request it receives so
// a test can assert on what the client said.
//
// The wire codec is the client library's own (`wayland-client`'s args.js) and
// the interface definitions are the vendored JSON, so the mock cannot drift
// from the client's idea of the protocol.
//
// Two transports: `listen()` puts it behind a unix socket path for a plain
// `net.Socket` client (no descriptors either way), and `pair()` connects it
// over `socketpair()` through x11-dri's `UnixSocket` when that is available,
// which is what lets a test send the client a real keymap fd.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// The fork of wayland-client is consumed through a link until it is
// published; where it is not installed, the suite skips rather than fails.
let codec = null;
try {
  codec = await import(import.meta.resolve('wayland-client/dist/args.js'));
} catch {
  codec = null;
}
export const waylandClientAvailable = codec !== null;
const { format_args, get_args, writeUInt, readUInt } = codec ?? {};

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOLS = path.join(here, '..', '..', 'src', 'wayland', 'protocols');

function loadDefs(names) {
  const byName = new Map();
  for (const n of names) {
    const file = path.join(PROTOCOLS, `${n}.json`);
    for (const itf of JSON.parse(fs.readFileSync(file, 'utf8')))
      byName.set(itf.name, itf);
  }
  return byName;
}

const DEFS = loadDefs([
  'wayland',
  'xdg-shell',
  'cursor-shape-v1',
  'viewporter',
  'fractional-scale-v1',
]);

/** Globals the mock advertises: name -> [interface, version]. */
const GLOBALS = [
  ['wl_compositor', 6],
  ['wl_seat', 9],
  ['xdg_wm_base', 6],
  ['wl_data_device_manager', 3],
  ['wp_viewporter', 1],
  ['wp_fractional_scale_manager_v1', 1],
  ['wp_cursor_shape_manager_v1', 1],
];

const SERVER_ID_BASE = 0xff000000;

export class MockCompositor extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = { width: 640, height: 480, ...opts };
    /** every request received, in order: { id, iface, name, args } */
    this.requests = [];
    this.objects = new Map(); // id -> { iface, data }
    this.serial = 1;
    this.time = 1000;
    this.socket = null;
    this._recv = Buffer.alloc(0);
    this._nextServerId = SERVER_ID_BASE;
    this.surfaces = new Map(); // surface id -> state
    this.pointer = null;
    this.keyboard = null;
    this.seat = null;
    this.registry = null;
    this.objects.set(1, { iface: 'wl_display' });
  }

  // ---- transports ----------------------------------------------------------

  /** Listen on a temp path; returns it. A plain net.Socket can connect. */
  async listen() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-mock-'));
    this.path = path.join(dir, 'wayland-mock');
    this.server = net.createServer((sock) => this._attach(sock));
    await new Promise((resolve) => this.server.listen(this.path, resolve));
    return this.path;
  }

  /**
   * Connect over a socketpair through x11-dri's UnixSocket, both ends fd
   * capable. Returns the client end, or null when the addon has no
   * UnixSocket (or this runtime cannot poll).
   */
  pair() {
    let dri;
    try {
      dri = require('x11-dri');
    } catch {
      return null;
    }
    if (typeof dri.UnixSocket !== 'function') return null;
    let fds;
    try {
      fds = dri.socketpair();
      const server = dri.UnixSocket.fromFd(fds[0]);
      const client = dri.UnixSocket.fromFd(fds[1]);
      this._attach(server);
      return client;
    } catch {
      return null;
    }
  }

  _attach(sock) {
    this.socket = sock;
    sock.on('data', (d) => this._onData(d));
    sock.on('error', () => {});
    sock.on('close', () => this.emit('disconnect'));
    this.emit('connect');
  }

  close() {
    try {
      this.socket?.destroy();
    } catch {
      /* */
    }
    this.server?.close();
  }

  // ---- wire ------------------------------------------------------------------

  _onData(d) {
    d = this._recv.length ? Buffer.concat([this._recv, d]) : d;
    while (d.length >= 8) {
      const len = readUInt(d, 4) >>> 16;
      if (d.length < len) break;
      const id = readUInt(d, 0);
      const opcode = readUInt(d, 4) & 0xffff;
      this._onRequest(id, opcode, d.subarray(8, len));
      d = d.subarray(len);
    }
    this._recv = d;
  }

  /**
   * Send an event to the client: `send(objectId, 'event_name', ...args)`.
   *
   * An `fd`-typed argument is given in its normal position — the codec wants
   * every argument present, a descriptor's slot included — and goes out as
   * ancillary data, which needs the `pair()` transport.
   */
  send(id, eventName, ...args) {
    const obj = this.objects.get(id);
    if (!obj) throw new Error(`mock: no object ${id}`);
    const def = DEFS.get(obj.iface);
    const opcode = def.events.findIndex((e) => e.name === eventName);
    if (opcode < 0)
      throw new Error(`mock: ${obj.iface} has no event ${eventName}`);
    const argDefs = def.events[opcode].args;
    const body = format_args(args, argDefs);
    const head = Buffer.alloc(8);
    writeUInt(head, id, 0);
    writeUInt(head, (8 + body.length) * 0x10000 + opcode, 4);
    const msg = Buffer.concat([head, body]);
    const fds = argDefs
      .map((a, i) => (a.type === 'fd' ? args[i] : null))
      .filter((v) => v != null);
    if (fds.length) {
      if (typeof this.socket.sendFds !== 'function')
        throw new Error('mock: this transport cannot send descriptors');
      this.socket.sendFds(msg, fds);
    } else {
      this.socket.write(msg);
    }
  }

  _newServerObject(iface) {
    const id = this._nextServerId++;
    this.objects.set(id, { iface });
    return id;
  }

  _onRequest(id, opcode, body) {
    const obj = this.objects.get(id);
    if (!obj) {
      this.emit('warning', `request on unknown object ${id}`);
      return;
    }
    const def = DEFS.get(obj.iface);
    const req = def?.requests?.[opcode];
    if (!req) {
      this.emit('warning', `unknown request ${opcode} on ${obj.iface}`);
      return;
    }
    let args;
    if (obj.iface === 'wl_registry' && req.name === 'bind') {
      // the one request whose new_id carries interface and version inline
      args = get_args(body, [
        { name: 'name', type: 'uint' },
        { name: 'interface', type: 'string' },
        { name: 'version', type: 'uint' },
        { name: 'id', type: 'new_id' },
      ]);
    } else {
      args = get_args(body, req.args);
    }
    const record = { id, iface: obj.iface, name: req.name, args };
    this.requests.push(record);
    this.emit('request', record);
    // register any new_id the client allocated
    req.args.forEach((a, i) => {
      if (a.type === 'new_id' && a.interface)
        this.objects.set(args[i], { iface: a.interface, parent: id });
    });
    this._handle(obj, req.name, args, id);
  }

  _handle(obj, name, args, id) {
    const iface = obj.iface;
    if (iface === 'wl_display') {
      if (name === 'sync') {
        this.send(args[0], 'done', this.serial++);
        this.send(1, 'delete_id', args[0]);
        this.objects.delete(args[0]);
      } else if (name === 'get_registry') {
        this.registry = args[0];
        for (let i = 0; i < GLOBALS.length; i++)
          this.send(args[0], 'global', i + 1, GLOBALS[i][0], GLOBALS[i][1]);
      }
      return;
    }
    if (iface === 'wl_registry' && name === 'bind') {
      const [gname, ifaceName, version, newId] = args;
      this.objects.set(newId, { iface: ifaceName, version, global: gname });
      if (ifaceName === 'wl_seat') {
        this.seat = newId;
        this.send(newId, 'capabilities', 3);
        if (version >= 2) this.send(newId, 'name', 'seat0');
      }
      return;
    }
    if (iface === 'wl_compositor' && name === 'create_surface') {
      this.surfaces.set(args[0], {
        id: args[0],
        role: null,
        commits: 0,
        attached: null,
        frames: [],
        pendingConfigure: false,
        scale: 1,
      });
      return;
    }
    if (iface === 'wl_surface') {
      const s = this.surfaces.get(id);
      if (!s) return;
      if (name === 'frame') s.frames.push(args[0]);
      else if (name === 'attach') s.attached = args[0];
      else if (name === 'set_buffer_scale') s.scale = args[0];
      else if (name === 'commit') {
        s.commits++;
        if (s.role && !s.role.configured) {
          s.role.configured = true;
          this._configure(s);
        }
        // frame callbacks are answered on the next tick, as a compositor
        // would at its next repaint
        const frames = s.frames.splice(0);
        if (frames.length) {
          setImmediate(() => {
            for (const cb of frames) {
              if (!this.objects.has(cb) && !this.socket) continue;
              this.time += 16;
              this.send(cb, 'done', this.time);
              this.send(1, 'delete_id', cb);
            }
          });
        }
        this.emit('commit', s);
      } else if (name === 'destroy') {
        this.surfaces.delete(id);
        this.objects.delete(id);
      }
      return;
    }
    if (iface === 'xdg_wm_base') {
      if (name === 'get_xdg_surface') {
        const s = this.surfaces.get(args[1]);
        const role = {
          xdgSurface: args[0],
          surface: args[1],
          kind: null,
          configured: false,
        };
        if (s) s.role = role;
        this.objects.get(args[0]).role = role;
      } else if (name === 'create_positioner') {
        this.objects.get(args[0]).positioner = {};
      }
      return;
    }
    if (iface === 'xdg_positioner') {
      const p = obj.positioner ?? (obj.positioner = {});
      p[name] = args;
      return;
    }
    if (iface === 'xdg_surface') {
      if (name === 'get_toplevel') {
        obj.role.kind = 'toplevel';
        obj.role.toplevel = args[0];
        this.objects.get(args[0]).role = obj.role;
      } else if (name === 'get_popup') {
        obj.role.kind = 'popup';
        obj.role.popup = args[0];
        obj.role.parent = args[1];
        obj.role.positioner = this.objects.get(args[2])?.positioner ?? {};
        this.objects.get(args[0]).role = obj.role;
      } else if (name === 'ack_configure') {
        obj.role.acked = args[0];
        this.emit('ack', args[0]);
      }
      return;
    }
    if (iface === 'xdg_toplevel' || iface === 'xdg_popup') {
      const role = obj.role;
      if (!role) return;
      (role.requests ??= []).push({ name, args });
      return;
    }
    if (iface === 'wl_seat') {
      if (name === 'get_pointer') this.pointer = args[0];
      else if (name === 'get_keyboard') {
        this.keyboard = args[0];
        if (
          this.opts.keymapFd != null &&
          typeof this.socket.sendFds === 'function'
        ) {
          // the transport consumes the descriptor; hand it a copy so the test
          // can keep (and close) its own
          this.send(
            args[0],
            'keymap',
            1,
            require('x11-dri').dup(this.opts.keymapFd),
            this.opts.keymapSize,
          );
        }
        this.send(args[0], 'repeat_info', 30, 400);
      }
      return;
    }
  }

  /** The configure pair a role gets after its first commit. */
  _configure(s) {
    const role = s.role;
    const serial = this.serial++;
    if (role.kind === 'toplevel') {
      const states = this.opts.states ?? [4]; // activated
      this.send(
        role.toplevel,
        'configure',
        this.opts.width,
        this.opts.height,
        statesArray(states),
      );
    } else if (role.kind === 'popup') {
      const size = role.positioner?.set_size ?? [100, 50];
      const anchor = role.positioner?.set_anchor_rect ?? [0, 0, 1, 1];
      this.send(
        role.popup,
        'configure',
        anchor[0],
        anchor[1],
        size[0],
        size[1],
      );
    }
    this.send(role.xdgSurface, 'configure', serial);
    role.lastSerial = serial;
  }

  // ---- test helpers -----------------------------------------------------------

  /** Reconfigure a toplevel: a new size and/or states. */
  configure(surfaceId, { width, height, states }) {
    const s = this.surfaces.get(surfaceId);
    if (!s?.role) throw new Error('mock: surface has no role');
    if (width) this.opts.width = width;
    if (height) this.opts.height = height;
    if (states) this.opts.states = states;
    this._configure(s);
    return s.role.lastSerial;
  }

  requestClose(surfaceId) {
    const s = this.surfaces.get(surfaceId);
    this.send(s.role.toplevel, 'close');
  }

  /** The requests recorded for one interface name, or one request name. */
  sent(iface, name) {
    return this.requests.filter(
      (r) => r.iface === iface && (!name || r.name === name),
    );
  }

  // pointer injection: surface-local logical coordinates
  pointerEnter(surfaceId, x, y) {
    this.send(this.pointer, 'enter', this.serial++, surfaceId, x, y);
    this.send(this.pointer, 'frame');
  }
  pointerMotion(x, y) {
    this.send(this.pointer, 'motion', (this.time += 8), x, y);
    this.send(this.pointer, 'frame');
  }
  pointerButton(evdev, pressed) {
    this.send(
      this.pointer,
      'button',
      this.serial++,
      (this.time += 8),
      evdev,
      pressed ? 1 : 0,
    );
    this.send(this.pointer, 'frame');
  }
  pointerAxis({ axis = 0, value = 0, v120 = null, source = 0 }) {
    this.send(this.pointer, 'axis_source', source);
    this.send(this.pointer, 'axis', (this.time += 8), axis, value);
    if (v120 != null) this.send(this.pointer, 'axis_value120', axis, v120);
    this.send(this.pointer, 'frame');
  }
  pointerLeave(surfaceId) {
    this.send(this.pointer, 'leave', this.serial++, surfaceId);
    this.send(this.pointer, 'frame');
  }
  keyboardEnter(surfaceId) {
    this.send(
      this.keyboard,
      'enter',
      this.serial++,
      surfaceId,
      new Uint8Array(0),
    );
  }
  modifiers(depressed, latched = 0, locked = 0, group = 0) {
    this.send(
      this.keyboard,
      'modifiers',
      this.serial++,
      depressed,
      latched,
      locked,
      group,
    );
  }
  key(evdev, pressed) {
    this.send(
      this.keyboard,
      'key',
      this.serial++,
      (this.time += 8),
      evdev,
      pressed ? 1 : 0,
    );
  }
}

function statesArray(states) {
  const out = new Uint8Array(states.length * 4);
  const view = new DataView(out.buffer);
  states.forEach((s, i) => view.setUint32(i * 4, s, true));
  return out;
}

/** Wait until a predicate holds, polling the loop. */
export function until(pred, { timeout = 3000, what = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let v;
      try {
        v = pred();
      } catch (e) {
        return reject(e);
      }
      if (v) return resolve(v);
      if (Date.now() - started > timeout)
        return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}
