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

import { readAll } from '../../src/wayland/fdutil.js';

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
  'xdg-output-unstable-v1',
  'text-input-unstable-v3',
  'tablet-v2',
  'xdg-decoration-unstable-v1',
  'wlr-layer-shell-unstable-v1',
  'wlr-screencopy-unstable-v1',
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
  ['zwp_text_input_manager_v3', 1],
  ['zwp_tablet_manager_v2', 1],
  // the wlroots-shaped extras: a compositor with everything, so a client
  // can be seen negotiating each; a test that wants one absent just never
  // binds it
  ['wl_shm', 1],
  ['zxdg_decoration_manager_v1', 1],
  ['zwlr_layer_shell_v1', 4],
  ['zwlr_screencopy_manager_v1', 3],
];

/** `wl_seat.capability` bits, as the mock's `capabilities` option spells them. */
const CAP = { POINTER: 1, KEYBOARD: 2, TOUCH: 4 };

const SERVER_ID_BASE = 0xff000000;

/**
 * An output as a test states it. Everything but `name` has a default:
 * `{ name, description, x, y, width, height, refresh, scale, transform,
 * mm: [w, h], make, model, logical: { x, y, width, height } }` — `width` and
 * `height` are the mode's pixels, `refresh` is millihertz, and `logical`
 * (what xdg_output reports) defaults to the mode over the scale, turned by
 * the transform, at the geometry's position.
 */
function outputSpec(spec) {
  const out = {
    description: `${spec.name} monitor`,
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    refresh: 60000,
    scale: 1,
    transform: 0,
    mm: [0, 0],
    make: 'Mock',
    model: 'M1',
    ...spec,
  };
  if (!out.logical) {
    const [w, h] =
      out.transform & 1 ? [out.height, out.width] : [out.width, out.height];
    out.logical = {
      x: out.x,
      y: out.y,
      width: Math.round(w / out.scale),
      height: Math.round(h / out.scale),
    };
  }
  return out;
}
/** `wl_shm.format`: what a screencopy frame is offered in. */
const XRGB8888 = 1;

/**
 * The frame a screencopy hands back unless a test scripts one: a gradient
 * whose pixel at (x, y) is (x, y, 0x55), so a test can name the pixel it
 * expects without a lookup table.
 */
const defaultFrame = (x, y) => [x & 255, y & 255, 0x55];

export class MockCompositor extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {object[]} [opts.outputs] `wl_output` globals to advertise, see
   *   `outputSpec`; with any, `zxdg_output_manager_v1` is advertised too
   *   unless `xdgOutput: false`
   * @param {number} [opts.outputVersion] the `wl_output` version to
   *   advertise (4)
   * @param {number} [opts.xdgOutputVersion] the manager's version (3)
   * @param {{width: number, height: number}} [opts.bounds] sent as
   *   `configure_bounds` ahead of every toplevel configure
   */
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
    this.touch = null;
    this.seat = null;
    /** the `zwp_tablet_seat_v2` the client asked for, or null */
    this.tabletSeat = null;
    /** every wl_registry the client asked for (the last one, and all) */
    this.registry = null;
    this.registries = [];
    /** what the registry currently lists: { name, iface, version, output? } */
    this.globals = GLOBALS.map(([iface, version], i) => ({
      name: i + 1,
      iface,
      version,
    }));
    this._nextGlobal = GLOBALS.length + 1;
    /** output name -> { spec, global, bound: Set<proxy id>, xdg: Set<id> } */
    this.outputs = new Map();
    // One screen-sized output unless a test lists its own (`outputs: []` for
    // none): the decoration, layer-shell and screencopy tests bind "the"
    // output the way a client on a laptop does.
    const outputs = opts.outputs ?? [
      { name: 'MOCK-1', width: this.opts.width, height: this.opts.height },
    ];
    for (const spec of outputs) this._addOutputGlobal(spec);
    if (outputs.length && opts.xdgOutput !== false) {
      this.globals.push({
        name: this._nextGlobal++,
        iface: 'zxdg_output_manager_v1',
        version: opts.xdgOutputVersion ?? 3,
      });
    }
    /** the client's `zwp_text_input_v3`, once it asked for one */
    this.textInput = null;
    /** `commit` requests received on it — what a `done` echoes */
    this.textInputCommits = 0;
    // drag and drop: the client's data device and source, the server's
    // current data offer, and what a `receive` answers with, by MIME.
    this.dataDevice = null;
    this.dataSource = null;
    this._dndOffer = null;
    this.dndPayload = {};
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
      // A request may carry a descriptor (wl_data_offer.receive hands us a
      // pipe, wl_shm.create_pool a memfd): pull it from the transport's
      // ancillary queue in argument order, the same rule the client parses
      // events with; a transport without one reads it as -1.
      args = get_args(body, req.args, () => this._takeFd());
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
        // every registry gets the whole list, and announcements after
        this.registry = args[0];
        this.registries.push(args[0]);
        for (const g of this.globals)
          this.send(args[0], 'global', g.name, g.iface, g.version);
      }
      return;
    }
    if (iface === 'wl_registry' && name === 'bind') {
      const [gname, ifaceName, version, newId] = args;
      this.objects.set(newId, { iface: ifaceName, version, global: gname });
      if (ifaceName === 'wl_seat') {
        this.seat = newId;
        // pointer and keyboard unless the test says otherwise; `capabilities:
        // 7` adds a touchscreen
        this.send(
          newId,
          'capabilities',
          this.opts.capabilities ?? CAP.POINTER | CAP.KEYBOARD,
        );
        if (version >= 2) this.send(newId, 'name', 'seat0');
      } else if (ifaceName === 'wl_output') {
        const out = this._outputByGlobal(gname);
        if (out) {
          out.bound.add(newId);
          this._sendOutputState(newId, out, version);
        }
      } else if (ifaceName === 'wl_shm') {
        this.send(newId, 'format', XRGB8888);
        this.send(newId, 'format', 0 /* argb8888 */);
      }
      return;
    }
    if (iface === 'wl_shm' && name === 'create_pool') {
      Object.assign(this.objects.get(args[0]), { fd: args[1], size: args[2] });
      return;
    }
    if (iface === 'wl_shm_pool') {
      if (name === 'create_buffer') {
        const [id, offset, width, height, stride, format] = args;
        Object.assign(this.objects.get(id), {
          pool: obj,
          offset,
          width,
          height,
          stride,
          format,
        });
      } else if (name === 'destroy') {
        if (obj.fd >= 0) {
          try {
            fs.closeSync(obj.fd);
          } catch {
            /* */
          }
        }
        this.objects.delete(id);
      }
      return;
    }
    if (iface === 'wl_buffer' && name === 'destroy') {
      this.objects.delete(id);
      return;
    }
    if (iface === 'zxdg_decoration_manager_v1') {
      if (name === 'get_toplevel_decoration') {
        const role = this.objects.get(args[1])?.role;
        this.objects.get(args[0]).role = role;
        if (role) role.decoration = args[0];
      }
      return;
    }
    if (iface === 'zxdg_toplevel_decoration_v1') {
      const role = obj.role;
      if (name === 'set_mode') role.decorationRequested = args[0];
      else if (name === 'unset_mode') role.decorationRequested = null;
      else if (name === 'destroy') {
        if (role) role.decoration = null;
        this.objects.delete(id);
      }
      return;
    }
    if (iface === 'zwlr_layer_shell_v1') {
      if (name === 'get_layer_surface') {
        const [newId, surfaceId, output, layer, namespace] = args;
        const s = this.surfaces.get(surfaceId);
        const role = {
          kind: 'layer',
          layerSurface: newId,
          surface: surfaceId,
          output,
          layer,
          namespace,
          configured: false,
          props: {},
          popups: [],
        };
        if (s) s.role = role;
        this.objects.get(newId).role = role;
      }
      return;
    }
    if (iface === 'zwlr_layer_surface_v1') {
      const role = obj.role;
      if (name === 'ack_configure') {
        role.acked = args[0];
        this.emit('ack', args[0]);
      } else if (name === 'get_popup') {
        role.popups.push(args[0]);
      } else if (name === 'destroy') {
        this.objects.delete(id);
      } else {
        role.props[name] = args;
      }
      return;
    }
    if (iface === 'zwlr_screencopy_manager_v1') {
      if (name === 'capture_output' || name === 'capture_output_region') {
        const frame = this.objects.get(args[0]);
        frame.version = obj.version;
        frame.capture = { cursor: args[1], output: args[2] };
        const { width, height } = this.opts;
        this.send(args[0], 'buffer', XRGB8888, width, height, width * 4);
        if (obj.version >= 3) this.send(args[0], 'buffer_done');
      }
      return;
    }
    if (iface === 'zwlr_screencopy_frame_v1') {
      if (name === 'copy' || name === 'copy_with_damage') {
        this._copyFrame(id, args[0]);
      } else if (name === 'destroy') {
        this.objects.delete(id);
      }
      return;
    }
    if (iface === 'wl_output') {
      if (name === 'release') {
        for (const out of this.outputs.values()) out.bound.delete(id);
        this.objects.delete(id);
      }
      return;
    }
    if (iface === 'zxdg_output_manager_v1') {
      if (name === 'get_xdg_output') {
        const [xdgId, outputId] = args;
        const out = this._outputByProxy(outputId);
        if (!out) return;
        out.xdg.add(xdgId);
        this.objects.get(xdgId).output = out;
        this._sendXdgState(xdgId, out, obj.version);
        // xdg_output's own `done` is deprecated from v3: the atom is then
        // wl_output.done, which real compositors send after these events
        if (obj.version >= 3) this.send(outputId, 'done');
        else this.send(xdgId, 'done');
      }
      return;
    }
    if (iface === 'zxdg_output_v1') {
      if (name === 'destroy') {
        obj.output?.xdg.delete(id);
        this.objects.delete(id);
      }
      return;
    }
    if (iface === 'zwp_tablet_manager_v2' && name === 'get_tablet_seat') {
      this.tabletSeat = args[0];
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
      if (iface === 'xdg_popup' && name === 'grab' && role.configured) {
        // mutter's rule: a popup's setup ends with its initial commit, and a
        // grab after it is fatal
        this.send(1, 'error', id, 0, 'tried to grab after popup was mapped');
        return;
      }
      (role.requests ??= []).push({ name, args });
      return;
    }
    if (iface === 'wl_seat') {
      if (name === 'get_pointer') this.pointer = args[0];
      else if (name === 'get_touch') this.touch = args[0];
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
    if (iface === 'zwp_text_input_manager_v3' && name === 'get_text_input') {
      this.textInput = args[0];
      this.textInputCommits = 0;
      return;
    }
    if (iface === 'zwp_text_input_v3') {
      // the requests themselves are on record (`sent`); the count of commits
      // is the serial the protocol has the compositor echo back
      if (name === 'commit') this.textInputCommits++;
      else if (name === 'destroy') {
        if (this.textInput === id) this.textInput = null;
        this.objects.delete(id);
      }
      return;
    }
    if (iface === 'wl_data_device_manager') {
      if (name === 'create_data_source') {
        this.dataSource = args[0];
        this.objects.get(args[0]).offers = [];
      } else if (name === 'get_data_device') {
        this.dataDevice = args[0];
      }
      return;
    }
    if (iface === 'wl_data_source') {
      const src = this.objects.get(id);
      if (name === 'offer') (src.offers ??= []).push(args[0]);
      else if (name === 'destroy') this.objects.delete(id);
      return;
    }
    if (iface === 'wl_data_device') {
      // start_drag / set_selection / release are recorded in this.requests;
      // start_drag's origin/icon/serial are what a source test asserts on.
      return;
    }
    if (iface === 'wl_data_offer') {
      if (name === 'receive') this._answerReceive(args[0], args[1]);
      else if (name === 'destroy') this.objects.delete(id);
      return;
    }
  }

  /** Answer a `wl_data_offer.receive`: write the payload for the MIME to the
   * pipe the client handed us, and close it. */
  _answerReceive(mime, fd) {
    if (typeof fd !== 'number' || fd < 0) return;
    const value = this.dndPayload?.[mime];
    const bytes =
      value == null
        ? Buffer.alloc(0)
        : Buffer.isBuffer(value)
          ? value
          : Buffer.from(String(value), 'utf8');
    try {
      fs.writeSync(fd, bytes);
    } catch {
      /* the reader may have gone */
    }
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }

  _takeFd() {
    const fds = this.socket?.takeFds?.(1);
    return typeof fds?.[0] === 'number' ? fds[0] : -1;
  }

  /**
   * Fill a client's buffer with the scripted frame and say it is ready.
   * Rows go in bottom-up when `opts.yInvert` is set, with the flag to say
   * so, which is how a GL-rendering compositor hands frames over.
   */
  _copyFrame(frameId, bufferId) {
    const buf = this.objects.get(bufferId);
    if (this.opts.captureFails || !buf?.pool || buf.pool.fd < 0) {
      this.send(frameId, 'failed');
      return;
    }
    const { width, height, stride, offset } = buf;
    const frame = this.opts.frame ?? defaultFrame;
    const bytes = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
      const row = this.opts.yInvert ? height - 1 - y : y;
      for (let x = 0; x < width; x++) {
        const [r, g, b] = frame(x, y);
        const o = row * stride + x * 4;
        bytes[o] = b;
        bytes[o + 1] = g;
        bytes[o + 2] = r;
        bytes[o + 3] = 0xff;
      }
    }
    fs.writeSync(buf.pool.fd, bytes, 0, bytes.length, offset);
    this.send(frameId, 'flags', this.opts.yInvert ? 1 : 0);
    this.send(frameId, 'ready', 0, 1, 0);
  }

  /** The configure pair a role gets after its first commit. */
  _configure(s) {
    const role = s.role;
    const serial = this.serial++;
    if (role.kind === 'layer') {
      // 0 on an axis is "stretch": the output's extent stands in
      const [w, h] = role.props.set_size ?? [0, 0];
      this.send(
        role.layerSurface,
        'configure',
        serial,
        w || this.opts.width,
        h || this.opts.height,
      );
      role.lastSerial = serial;
      return;
    }
    if (role.kind === 'toplevel') {
      const states = this.opts.states ?? [4]; // activated
      const bounds = this.opts.bounds;
      if (bounds) {
        this.send(
          role.toplevel,
          'configure_bounds',
          bounds.width,
          bounds.height,
        );
      }
      this.send(
        role.toplevel,
        'configure',
        this.opts.width,
        this.opts.height,
        statesArray(states),
      );
      // a decoration mode rides the same configure sequence: the mode a
      // test set, else what the client asked for, else client-side
      if (role.decoration) {
        this.send(
          role.decoration,
          'configure',
          role.decorationMode ??
            this.opts.decorationMode ??
            role.decorationRequested ??
            1,
        );
      }
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

  /** Reconfigure a toplevel: a new size, states and/or bounds. */
  configure(surfaceId, { width, height, states, bounds }) {
    const s = this.surfaces.get(surfaceId);
    if (!s?.role) throw new Error('mock: surface has no role');
    if (width) this.opts.width = width;
    if (height) this.opts.height = height;
    if (states) this.opts.states = states;
    if (bounds) this.opts.bounds = bounds;
    this._configure(s);
    return s.role.lastSerial;
  }

  // ---- outputs -------------------------------------------------------------

  _addOutputGlobal(spec) {
    const out = {
      spec: outputSpec(spec),
      global: this._nextGlobal++,
      bound: new Set(),
      xdg: new Set(),
    };
    this.outputs.set(out.spec.name, out);
    this.globals.push({
      name: out.global,
      iface: 'wl_output',
      version: this.opts.outputVersion ?? 4,
      output: out,
    });
    return out;
  }

  _outputByGlobal(gname) {
    for (const out of this.outputs.values())
      if (out.global === gname) return out;
    return null;
  }

  _outputByProxy(proxyId) {
    for (const out of this.outputs.values())
      if (out.bound.has(proxyId)) return out;
    return null;
  }

  /** What a compositor says to a freshly bound wl_output. */
  _sendOutputState(id, out, version, only = null) {
    const s = out.spec;
    const want = (k) => !only || only.has(k);
    if (want('geometry'))
      this.send(
        id,
        'geometry',
        s.x,
        s.y,
        s.mm[0],
        s.mm[1],
        0,
        s.make,
        s.model,
        s.transform,
      );
    if (want('mode')) this.send(id, 'mode', 3, s.width, s.height, s.refresh);
    if (version >= 2 && want('scale')) this.send(id, 'scale', s.scale);
    if (version >= 4 && want('name')) {
      this.send(id, 'name', s.name);
      this.send(id, 'description', s.description);
    }
    if (version >= 2 && !only) this.send(id, 'done');
  }

  _sendXdgState(xdgId, out, version) {
    const l = out.spec.logical;
    this.send(xdgId, 'logical_position', l.x, l.y);
    this.send(xdgId, 'logical_size', l.width, l.height);
    if (version >= 2) {
      this.send(xdgId, 'name', out.spec.name);
      this.send(xdgId, 'description', out.spec.description);
    }
  }

  /** Plug a monitor in: a new global, announced to every registry. */
  addOutput(spec) {
    const out = this._addOutputGlobal(spec);
    const g = this.globals[this.globals.length - 1];
    for (const r of this.registries)
      this.send(r, 'global', g.name, g.iface, g.version);
    return out;
  }

  /** Unplug one: `global_remove` to every registry. */
  removeOutput(name) {
    const out = this.outputs.get(name);
    if (!out) throw new Error(`mock: no output ${name}`);
    this.outputs.delete(name);
    this.globals = this.globals.filter((g) => g.output !== out);
    for (const r of this.registries) this.send(r, 'global_remove', out.global);
  }

  /**
   * Change an output — a new mode, scale or position — and tell every proxy
   * bound to it, as a compositor does: only the events that changed, then
   * `done` on each wl_output (xdg_output's logical rect follows the mode).
   */
  updateOutput(name, patch) {
    const out = this.outputs.get(name);
    if (!out) throw new Error(`mock: no output ${name}`);
    const keep = patch.logical ? { logical: patch.logical } : {};
    out.spec = outputSpec({ ...out.spec, ...patch, logical: null, ...keep });
    const only = new Set();
    for (const k of Object.keys(patch)) {
      if (['x', 'y', 'mm', 'make', 'model', 'transform'].includes(k))
        only.add('geometry');
      else if (['width', 'height', 'refresh'].includes(k)) only.add('mode');
      else if (k === 'scale') only.add('scale');
      else if (k === 'name' || k === 'description') only.add('name');
    }
    for (const id of out.bound) {
      const version = this.objects.get(id)?.version ?? 4;
      this._sendOutputState(id, out, version, only);
      for (const xdgId of out.xdg) {
        const manager = this.objects.get(xdgId);
        this._sendXdgState(xdgId, out, manager?.version ?? 3);
      }
      if (version >= 2) this.send(id, 'done');
    }
  }

  /** The client's proxy ids for one output. */
  outputProxies(name) {
    return [...(this.outputs.get(name)?.bound ?? [])];
  }

  /** `wl_surface.enter`/`leave`: the surface now overlaps this output. */
  enterOutput(surfaceId, name) {
    for (const id of this.outputProxies(name))
      this.send(surfaceId, 'enter', id);
  }

  leaveOutput(surfaceId, name) {
    for (const id of this.outputProxies(name))
      this.send(surfaceId, 'leave', id);
  }

  requestClose(surfaceId) {
    const s = this.surfaces.get(surfaceId);
    this.send(s.role.toplevel, 'close');
  }

  /** Change a toplevel's decoration mode: a decoration configure, then the surface's. */
  setDecorationMode(surfaceId, mode) {
    const s = this.surfaces.get(surfaceId);
    if (!s?.role?.decoration) throw new Error('mock: no decoration object');
    s.role.decorationMode = mode;
    this._configure(s);
    return s.role.lastSerial;
  }

  /** Reconfigure a layer surface at a size of the compositor's choosing. */
  configureLayer(surfaceId, { width, height }) {
    const s = this.surfaces.get(surfaceId);
    if (s?.role?.kind !== 'layer') throw new Error('mock: not a layer surface');
    const serial = this.serial++;
    this.send(s.role.layerSurface, 'configure', serial, width, height);
    s.role.lastSerial = serial;
    return serial;
  }

  /** The compositor takes a layer surface down. */
  closeLayer(surfaceId) {
    const s = this.surfaces.get(surfaceId);
    this.send(s.role.layerSurface, 'closed');
  }

  /** The surfaces with a layer role, newest last — how a test finds an overlay. */
  layerSurfaces() {
    return [...this.surfaces.values()].filter((s) => s.role?.kind === 'layer');
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

  // text-input v3: the input method's side. The three state events are
  // buffered by the client until `done`, exactly as a compositor sends them.
  textInputEnter(surfaceId) {
    this.send(this.textInput, 'enter', surfaceId);
  }
  textInputLeave(surfaceId) {
    this.send(this.textInput, 'leave', surfaceId);
  }
  /** `cursorBegin`/`cursorEnd` are byte offsets into `text`; -1 hides it. */
  preeditString(text, cursorBegin = -1, cursorEnd = -1) {
    this.send(this.textInput, 'preedit_string', text, cursorBegin, cursorEnd);
  }
  commitString(text) {
    this.send(this.textInput, 'commit_string', text);
  }
  /** Bytes to delete before and after the selection. */
  deleteSurroundingText(before, after = 0) {
    this.send(this.textInput, 'delete_surrounding_text', before, after);
  }
  /** Apply what was buffered; the serial defaults to the commits seen. */
  textInputDone(serial = this.textInputCommits) {
    this.send(this.textInput, 'done', serial);
  }

  /** The requests on the text input, by name, oldest first. */
  textInputRequests(since = 0) {
    return this.requests
      .filter((r) => r.iface === 'zwp_text_input_v3')
      .slice(since);
  }

  /** A later `capabilities` event: a device came or went. */
  capabilities(caps) {
    this.send(this.seat, 'capabilities', caps);
  }

  // touch injection: surface-local logical coordinates. Events group under
  // `touchFrame()`, as a compositor's do; the serials come back so a test can
  // check a move or resize was started with the right one.
  touchDown(surfaceId, id, x, y) {
    const serial = this.serial++;
    this.send(
      this.touch,
      'down',
      serial,
      (this.time += 8),
      surfaceId,
      id,
      x,
      y,
    );
    return serial;
  }
  touchMotion(id, x, y) {
    this.send(this.touch, 'motion', (this.time += 8), id, x, y);
  }
  touchUp(id) {
    const serial = this.serial++;
    this.send(this.touch, 'up', serial, (this.time += 8), id);
    return serial;
  }
  touchShape(id, major, minor) {
    this.send(this.touch, 'shape', id, major, minor);
  }
  touchFrame() {
    this.send(this.touch, 'frame');
  }
  touchCancel() {
    this.send(this.touch, 'cancel');
  }

  // tablet injection. Tablets and tools are server-created objects announced
  // through the tablet seat, described, and finished with `done`; the ids
  // returned are what the tool events are sent on.
  tabletAdded({
    name = 'Mock Tablet',
    vid = 0x056a,
    pid = 0x0357,
    path = '/dev/input/event9',
  } = {}) {
    const id = this._newServerObject('zwp_tablet_v2');
    this.send(this.tabletSeat, 'tablet_added', id);
    this.send(id, 'name', name);
    this.send(id, 'id', vid, pid);
    this.send(id, 'path', path);
    this.send(id, 'done');
    return id;
  }
  toolAdded({ type = 0x140, capabilities = [2, 1], serial = [0, 42] } = {}) {
    const id = this._newServerObject('zwp_tablet_tool_v2');
    this.send(this.tabletSeat, 'tool_added', id);
    this.send(id, 'type', type);
    this.send(id, 'hardware_serial', serial[0], serial[1]);
    for (const c of capabilities) this.send(id, 'capability', c);
    this.send(id, 'done');
    return id;
  }
  toolProximityIn(toolId, tabletId, surfaceId) {
    const serial = this.serial++;
    this.send(toolId, 'proximity_in', serial, tabletId, surfaceId);
    return serial;
  }
  toolProximityOut(toolId) {
    this.send(toolId, 'proximity_out');
  }
  toolMotion(toolId, x, y) {
    this.send(toolId, 'motion', x, y);
  }
  /** `pressure`, `distance`, `tilt`, `rotation`, `slider`, `wheel`, with their arguments */
  toolAxis(toolId, axis, ...args) {
    this.send(toolId, axis, ...args);
  }
  toolDown(toolId) {
    const serial = this.serial++;
    this.send(toolId, 'down', serial);
    return serial;
  }
  toolUp(toolId) {
    this.send(toolId, 'up');
  }
  toolButton(toolId, evdev, pressed) {
    const serial = this.serial++;
    this.send(toolId, 'button', serial, evdev, pressed ? 1 : 0);
    return serial;
  }
  toolFrame(toolId) {
    this.send(toolId, 'frame', (this.time += 8));
  }
  toolRemoved(toolId) {
    this.send(toolId, 'removed');
  }

  // ---- drag and drop injection (the compositor as the other application) ----

  /**
   * Begin an incoming drag over a surface: hand the client a data offer that
   * lists `mimes`, then `enter` at surface-local (x, y). Returns the server
   * offer id, which later action/finish events name.
   */
  dndEnter(surfaceId, mimes, { x = 0, y = 0, sourceActions = 1 } = {}) {
    const offer = this._newServerObject('wl_data_offer');
    this._dndOffer = offer;
    this.send(this.dataDevice, 'data_offer', offer);
    for (const mime of mimes) this.send(offer, 'offer', mime);
    this.send(offer, 'source_actions', sourceActions);
    this.send(this.dataDevice, 'enter', this.serial++, surfaceId, x, y, offer);
    return offer;
  }
  dndMotion(x, y) {
    this.send(this.dataDevice, 'motion', (this.time += 8), x, y);
  }
  dndOfferAction(action) {
    if (this._dndOffer) this.send(this._dndOffer, 'action', action);
  }
  dndLeave() {
    this.send(this.dataDevice, 'leave');
  }
  dndDrop() {
    this.send(this.dataDevice, 'drop');
  }

  /** The MIME types the client's data source offered, in order. */
  sourceOffers() {
    return this.objects.get(this.dataSource)?.offers ?? [];
  }
  /** Tell the source the current target accepts `mime` (empty string = none). */
  sourceTarget(mime) {
    this.send(this.dataSource, 'target', mime ?? '');
  }
  sourceAction(action) {
    this.send(this.dataSource, 'action', action);
  }
  /** Ask the source to send `mime` down a pipe; resolves with the bytes it
   * wrote. */
  async sourceSend(mime) {
    const dri = require('x11-dri');
    const { read, write } = dri.pipe();
    this.send(this.dataSource, 'send', mime, write);
    return readAll(read);
  }
  sourceDropPerformed() {
    this.send(this.dataSource, 'dnd_drop_performed');
  }
  sourceFinished() {
    this.send(this.dataSource, 'dnd_finished');
  }
  sourceCancelled() {
    this.send(this.dataSource, 'cancelled');
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
