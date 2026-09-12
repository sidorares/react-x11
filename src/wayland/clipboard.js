// The clipboard and the primary selection, over `wl_data_device` and
// `zwp_primary_selection_device_v1`.
//
// The model is X's selections with the round trips taken out. An owner
// advertises MIME types (`wl_data_source.offer`); the compositor tells
// everyone else there is a new offer (`wl_data_device.selection`) carrying a
// `wl_data_offer` that lists those types; a reader hands the offer a pipe's
// write end (`receive`) and reads the content from the other end; the
// compositor asks the owner to `send` into it. There is no `INCR`, no
// property round trip, no `TARGETS` request — the types came with the offer.
//
// What is the same as X: ownership needs a recent input serial, because a
// client that was not just interacted with may not take the selection; and
// the two selections are two different objects. `CLIPBOARD` is
// `wl_data_device`, `PRIMARY` is the primary-selection protocol, and a
// compositor may have only the first.
//
// Type names: react-x11's `clipboard.js` speaks X's — `UTF8_STRING`,
// `STRING`, `TEXT` — as well as MIME. Both are offered when writing text, and
// `targets()` answers both spellings for a text offer, so a caller written
// against either finds what it expects.

import { makePipe, readAll, writeAll, closeFd } from './fdutil.js';

const TEXT_MIMES = [
  'text/plain;charset=utf-8',
  'text/plain',
  'UTF8_STRING',
  'STRING',
  'TEXT',
];
const X_TEXT = new Set(['UTF8_STRING', 'STRING', 'TEXT', 'COMPOUND_TEXT']);

function isText(mime) {
  return (
    X_TEXT.has(mime) || mime === 'text/plain' || mime.startsWith('text/plain;')
  );
}

/** The MIME to actually ask an offer for, given an X-style or MIME name. */
function pickMime(offered, want) {
  if (offered.includes(want)) return want;
  if (isText(want)) return offered.find((m) => isText(m)) ?? null;
  return null;
}

class Selection {
  /**
   * @param {object} opts
   * @param {string} opts.name 'CLIPBOARD' | 'PRIMARY'
   * @param {object} opts.device a `wl_data_device` or `zwp_primary_selection_device_v1`
   * @param {object} opts.manager the manager that creates sources
   * @param {() => number} opts.serial the latest input serial
   */
  constructor({ name, device, manager, serial }) {
    this.name = name;
    this.device = device;
    this.manager = manager;
    this.serial = serial;
    /** the current offer from someone else, with its advertised types */
    this.offer = null;
    this.offerTypes = [];
    /** our own source while we own the selection */
    this.source = null;
    this.ownData = null;
    this._pendingOffers = new Map(); // offer id -> types

    device.on('data_offer', (offer) => {
      const types = [];
      this._pendingOffers.set(offer.id, types);
      offer.on('offer', (mime) => types.push(mime));
    });
    device.on('selection', (offer) => {
      const id = offer?.id ?? offer;
      if (this.offer && this.offer.id !== id) {
        try {
          this.offer.$.destroy();
        } catch {
          /* gone */
        }
      }
      if (!offer || offer === 0) {
        this.offer = null;
        this.offerTypes = [];
        return;
      }
      this.offer = offer;
      this.offerTypes = this._pendingOffers.get(id) ?? [];
      this._pendingOffers.delete(id);
      // an offer from our own source means we still own it; anyone else's
      // means we lost it
      if (this.source && !this._isOurs(offer)) this._dropSource();
    });
  }

  _isOurs() {
    // Compositors hand back our own offer when we own the selection; the
    // types match exactly what we offered, which is the only test there is.
    if (!this.ownData) return false;
    const ours = Object.keys(this.ownData);
    return (
      ours.length === this.offerTypes.length &&
      ours.every((t) => this.offerTypes.includes(t))
    );
  }

  _dropSource() {
    if (this.source) {
      try {
        this.source.$.destroy();
      } catch {
        /* gone */
      }
    }
    this.source = null;
    this.ownData = null;
  }

  /** Offer `data` — a string, or `{ [type]: string|Buffer }`. */
  async write(data) {
    const map = {};
    if (typeof data === 'string' || Buffer.isBuffer(data)) {
      for (const t of TEXT_MIMES) map[t] = data;
    } else if (data && typeof data === 'object') {
      for (const [t, v] of Object.entries(data)) {
        if (v == null) continue;
        map[t] = v;
        if (isText(t)) for (const alias of TEXT_MIMES) map[alias] ??= v;
      }
    }
    if (Object.keys(map).length === 0) return;
    this._dropSource();
    const source = this.manager.$.create_source();
    for (const t of Object.keys(map)) source.$.offer(t);
    source.on('send', (mime, fd) => {
      const v =
        map[mime] ??
        map[Object.keys(map).find((k) => isText(k) && isText(mime))];
      const bytes = Buffer.isBuffer(v)
        ? v
        : Buffer.from(String(v ?? ''), 'utf8');
      writeAll(fd, bytes).catch(() => closeFd(fd));
    });
    source.on('cancelled', () => {
      if (this.source === source) {
        this.source = null;
        this.ownData = null;
      }
      try {
        source.$.destroy();
      } catch {
        /* gone */
      }
    });
    source.on('target', () => {});
    source.on('action', () => {});
    source.on('dnd_drop_performed', () => {});
    source.on('dnd_finished', () => {});
    this.source = source;
    this.ownData = map;
    this.device.$.set_selection(source.id, this.serial());
  }

  async clear() {
    this._dropSource();
    this.device.$.set_selection(0, this.serial());
  }

  async targets() {
    if (this.ownData) return Object.keys(this.ownData);
    const types = [...this.offerTypes];
    if (types.some(isText))
      for (const t of TEXT_MIMES) if (!types.includes(t)) types.push(t);
    return types;
  }

  async read(target = 'UTF8_STRING') {
    if (this.ownData) {
      const v =
        this.ownData[target] ??
        (isText(target)
          ? Object.entries(this.ownData).find(([k]) => isText(k))?.[1]
          : undefined);
      if (v === undefined) return null;
      return isText(target)
        ? String(v)
        : Buffer.isBuffer(v)
          ? v
          : Buffer.from(String(v));
    }
    if (!this.offer) return null;
    const mime = pickMime(this.offerTypes, target);
    if (!mime) return null;
    const { read, write } = makePipe();
    this.offer.$.receive(mime, write);
    // The write end is the compositor's now; ours is closed once sent (the
    // transport consumes it). Flushing the request is what starts the copy.
    const bytes = await readAll(read);
    return isText(target) ? bytes.toString('utf8') : bytes;
  }
}

/**
 * The `app.clipboard` object react-x11's `createClipboard(app)` wraps.
 *
 * @param {object} opts
 * @param {import('./connection.js').WaylandConnection} opts.conn
 * @param {object} opts.seat the `wl_seat` proxy
 * @param {() => number} opts.serial the latest input serial
 */
export async function createWaylandClipboard({ conn, seat, serial }) {
  const selections = new Map();
  const ddm = await conn.bind('wl_data_device_manager');
  if (ddm) {
    const device = ddm.$.get_data_device(seat.id);
    selections.set(
      'CLIPBOARD',
      new Selection({ name: 'CLIPBOARD', device, manager: ddm, serial }),
    );
  }
  const psm = await conn.bind('zwp_primary_selection_device_manager_v1');
  if (psm) {
    const device = psm.$.get_device(seat.id);
    selections.set(
      'PRIMARY',
      new Selection({ name: 'PRIMARY', device, manager: psm, serial }),
    );
  }

  const sel = (name = 'CLIPBOARD') => {
    const s = selections.get(name);
    if (!s) {
      throw new Error(
        name === 'PRIMARY'
          ? 'clipboard: this compositor has no primary selection (zwp_primary_selection_device_manager_v1)'
          : `clipboard: unknown selection ${name}`,
      );
    }
    return s;
  };

  return {
    backend: 'wayland',
    selections: [...selections.keys()],
    write: (data, { selection } = {}) => sel(selection).write(data),
    clear: (selection) => sel(selection).clear(),
    targets: ({ selection } = {}) => sel(selection).targets(),
    read: ({ selection, target } = {}) => sel(selection).read(target),
    /** the data device, for drag-and-drop to build on */
    dataDevice: selections.get('CLIPBOARD')?.device ?? null,
    manager: ddm,
  };
}
