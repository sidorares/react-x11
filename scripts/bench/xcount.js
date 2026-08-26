// Counting X11 stream wrapper: an in-process "benchmarking proxy".
//
// Sits between the client and the server stream and parses both directions
// well enough to count protocol units, not just bytes:
//
//   requests  — first 2 bytes are (major, minor/data), length in 4-byte
//               units at [2..4). A length of 0 means BIG-REQUESTS: the
//               real 32-bit length follows.
//   replies   — first byte 1, extra length (4-byte units) at [4..8)
//   errors    — first byte 0, always 32 bytes
//   events    — anything else, 32 bytes; GenericEvent (35) carries an
//               extra length at [4..8) exactly like a reply
//
// Beyond the totals, the parse feeds a protocol-efficiency analysis
// (`stats.analysis`) aimed at the waste categories a request count hides:
//
//   stalls        — blocking round trips: a reply that arrives while its
//                   request was the *last* thing the client sent, i.e. the
//                   client had nothing pipelined behind it. One per frame is
//                   the fence clock working; growth is new serialized waits.
//   dupQueries    — repeated identical queries: a reply-carrying request
//                   whose exact bytes were already sent on this connection
//                   (a cacheable InternAtom / GetProperty / QueryExtension).
//                   Two exemptions, both because the repeat is not a cache
//                   miss: GetInputFocus, the sync primitive, whose repeats
//                   are fences and void-syncs (priced under stalls), and a
//                   GetProperty with delete=1, which consumes what it reads
//                   and so answers differently every time.
//   churnPairs    — short-lived resources: an XID created *and* freed inside
//                   the window (pixmap/picture/gc/region/…), with the
//                   create's parameters kept so "same-sized pixmap rebuilt
//                   every frame" is visible as repeats of one churn key.
//   filters       — the live `convolution` filter, if any, on every picture,
//                   so a Composite can be priced by the taps the server runs
//                   per pixel rather than by area alone (see
//                   `convolvedPixels`).
//
// Requests are named (core table + extension majors learned live from
// QueryExtension replies, minor tables for the extensions this stack uses),
// so a histogram says *which* request type moved, not just "+40 requests".
//
// `countStream(stream, { record: true })` additionally keeps every chunk,
// hex-encoded with timing and direction, in x11vis's `.x11cap` line-JSON
// shape (`captureLines()`), so a bench run can be opened — and diffed —
// in the protocol visualizer.

const CORE_NAMES = {
  1: 'CreateWindow',
  2: 'ChangeWindowAttributes',
  3: 'GetWindowAttributes',
  4: 'DestroyWindow',
  5: 'DestroySubwindows',
  7: 'ReparentWindow',
  8: 'MapWindow',
  10: 'UnmapWindow',
  12: 'ConfigureWindow',
  14: 'GetGeometry',
  15: 'QueryTree',
  16: 'InternAtom',
  17: 'GetAtomName',
  18: 'ChangeProperty',
  19: 'DeleteProperty',
  20: 'GetProperty',
  21: 'ListProperties',
  22: 'SetSelectionOwner',
  23: 'GetSelectionOwner',
  24: 'ConvertSelection',
  25: 'SendEvent',
  26: 'GrabPointer',
  27: 'UngrabPointer',
  28: 'GrabButton',
  31: 'GrabKeyboard',
  33: 'GrabKey',
  35: 'AllowEvents',
  38: 'QueryPointer',
  40: 'TranslateCoordinates',
  41: 'WarpPointer',
  42: 'SetInputFocus',
  43: 'GetInputFocus',
  45: 'OpenFont',
  46: 'CloseFont',
  47: 'QueryFont',
  48: 'QueryTextExtents',
  53: 'CreatePixmap',
  54: 'FreePixmap',
  55: 'CreateGC',
  56: 'ChangeGC',
  59: 'SetClipRectangles',
  60: 'FreeGC',
  61: 'ClearArea',
  62: 'CopyArea',
  63: 'CopyPlane',
  65: 'PolyLine',
  66: 'PolySegment',
  67: 'PolyRectangle',
  69: 'FillPoly',
  70: 'PolyFillRectangle',
  72: 'PutImage',
  73: 'GetImage',
  84: 'AllocColor',
  85: 'AllocNamedColor',
  93: 'CreateCursor',
  94: 'CreateGlyphCursor',
  95: 'FreeCursor',
  97: 'QueryBestSize',
  98: 'QueryExtension',
  99: 'ListExtensions',
  101: 'GetKeyboardMapping',
  113: 'KillClient',
  127: 'NoOperation',
};

const EXT_MINORS = {
  RENDER: {
    0: 'QueryVersion',
    1: 'QueryPictFormats',
    4: 'CreatePicture',
    5: 'ChangePicture',
    6: 'SetPictureClipRectangles',
    7: 'FreePicture',
    8: 'Composite',
    10: 'Trapezoids',
    11: 'Triangles',
    17: 'CreateGlyphSet',
    18: 'ReferenceGlyphSet',
    19: 'FreeGlyphSet',
    20: 'AddGlyphs',
    22: 'FreeGlyphs',
    23: 'CompositeGlyphs8',
    24: 'CompositeGlyphs16',
    25: 'CompositeGlyphs32',
    26: 'FillRectangles',
    27: 'CreateCursor',
    28: 'SetPictureTransform',
    30: 'SetPictureFilter',
    32: 'AddTraps',
    33: 'CreateSolidFill',
    34: 'CreateLinearGradient',
    35: 'CreateRadialGradient',
    36: 'CreateConicalGradient',
  },
  XFIXES: {
    0: 'QueryVersion',
    2: 'SelectSelectionInput',
    3: 'SelectCursorInput',
    5: 'CreateRegion',
    10: 'DestroyRegion',
    11: 'SetRegion',
  },
  Present: {
    0: 'QueryVersion',
    1: 'Pixmap',
    2: 'NotifyMSC',
    3: 'SelectInput',
    4: 'QueryCapabilities',
  },
  'BIG-REQUESTS': { 0: 'Enable' },
  'XC-MISC': { 0: 'GetVersion', 1: 'GetXIDRange', 2: 'GetXIDList' },
};

// The sync primitive. Its repeats are fences/void-syncs — flow control, not
// cacheable data — so it is priced as stalls, never as duplicate queries.
const SYNC_OPCODE = 43;

// A GetProperty that deletes what it reads is a *consuming* read: the same
// request bytes answer differently every time, because the reply is whatever
// arrived since the last one. ntk's shared-glyph directory works exactly this
// way — a property mailbox polled with delete=1 (lib/sharedglyphs.js) — so
// counting those repeats as cacheable queries reports waste that does not
// exist. `delete` is the byte after the opcode, which is what `minor` holds.
const GET_PROPERTY_OPCODE = 20;
const isConsumingRead = (entry) =>
  entry.op === GET_PROPERTY_OPCODE && entry.minor === 1;

/** FNV-1a over a request's bytes: identical request ⇒ identical hash. */
function fnv1a(buf, len) {
  let h = 0x811c9dc5;
  for (let i = 0; i < len; i++) {
    h ^= buf[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}

// RENDER minors the picture-filter tracker cares about. A filter is picture
// *state*: it is set once and re-applied by the server on every composite
// that reads the picture, so pricing a Composite needs the filter that was
// live when the Composite went out — which means following the state, not
// looking at the Composite alone.
const RENDER_CREATE_PICTURE = 4;
const RENDER_FREE_PICTURE = 7;
const RENDER_COMPOSITE = 8;
const RENDER_SET_PICTURE_FILTER = 30;
// CreateSolidFill / CreateLinear|Radial|ConicalGradient: also pictures, and
// also worth clearing, because node-x11 recycles XIDs
const RENDER_CREATE_SOURCE = new Set([33, 34, 35, 36]);
const FIXED = 65536; // RENDER FIXED: 16.16 signed

/** Widen a 16-bit wire sequence number against the full request count. */
function widenSeq(low, current) {
  let full = (current & ~0xffff) | low;
  if (full > current) full -= 0x10000;
  return full;
}

/**
 * Attach counters to an existing X11 stream without replacing it: wrap
 * `write` for the client->server direction and intercept the 'data' event
 * for server->client. Replacing the stream with a Duplex instead means
 * owning backpressure, which is easy to get subtly wrong and would make
 * the measurement itself a variable.
 */
export function countStream(inner, { record = false } = {}) {
  const analysis = {
    seq: 0, // requests parsed so far (widened sequence space)
    lastWritten: 0, // seq of the most recent request on the wire
    reqLog: [], // 1-based by seq: { op, minor, name, len, hash }
    stalls: 0,
    stallList: [], // { seq, name }
    dupQueries: 0,
    dupList: [], // { seq, name }
    queryHashes: new Map(), // hash -> { name, count }
    churnPairs: 0,
    churned: [], // { type, key, createdSeq, freedSeq }
    live: new Map(), // xid -> { type, key, seq }
    extNames: new Map(), // major opcode -> extension name
    pendingQueryExt: new Map(), // seq -> extension name asked about
    filters: new Map(), // picture xid -> { taps, key } for a convolution
  };

  const stats = {
    requests: 0,
    bytesOut: 0,
    replies: 0,
    events: 0,
    errors: 0,
    bytesIn: 0,
    byOpcode: new Map(),
    // (major, minor, w, h, taps, kernel) for every 36-byte request, so Render
    // Composite pixel area — and the convolution work inside that area —
    // can be totalled once the extension opcode is known
    composites: [],
    analysis,
    captureRecords: record ? [] : null,
  };

  let outBuf = Buffer.alloc(0);
  let inBuf = Buffer.alloc(0);
  let handshakeOut = false; // first client message is the connection setup
  let handshakeIn = false;

  const nameOf = (op, minor) => {
    const ext = analysis.extNames.get(op);
    if (ext) return `${ext}:${EXT_MINORS[ext]?.[minor] ?? `minor${minor}`}`;
    return CORE_NAMES[op] ?? `op${op}`;
  };

  const trackResource = (op, minor, buf, base) => {
    // `base` skips the BIG-REQUESTS extended length word when present, so
    // argument offsets are the same for both framings
    const xid = (at) => buf.readUInt32LE(base + at);
    const ext = analysis.extNames.get(op);
    let create = null; // { id, type, key }
    let free = null;
    if (ext === 'RENDER') {
      if (minor === 4) create = { id: xid(4), type: 'picture', key: 'picture' };
      else if (minor === 33)
        create = { id: xid(4), type: 'picture', key: 'solid-fill' };
      else if (minor === 34 || minor === 35 || minor === 36)
        create = { id: xid(4), type: 'picture', key: 'gradient' };
      else if (minor === 17)
        create = { id: xid(4), type: 'glyphset', key: 'glyphset' };
      else if (minor === 7 || minor === 19) free = xid(4);
    } else if (ext === 'XFIXES') {
      if (minor === 5) create = { id: xid(4), type: 'region', key: 'region' };
      else if (minor === 10) free = xid(4);
    } else if (!ext) {
      switch (op) {
        case 1:
          create = { id: xid(4), type: 'window', key: 'window' };
          break;
        case 4:
          free = xid(4);
          break;
        case 53:
          create = {
            id: xid(4),
            type: 'pixmap',
            key: `pixmap ${buf.readUInt16LE(base + 12)}x${buf.readUInt16LE(base + 14)}x${buf[1]}`,
          };
          break;
        case 54:
          free = xid(4);
          break;
        case 55:
          create = { id: xid(4), type: 'gc', key: 'gc' };
          break;
        case 60:
          free = xid(4);
          break;
        case 45:
          create = { id: xid(4), type: 'font', key: 'font' };
          break;
        case 46:
          free = xid(4);
          break;
        case 93:
        case 94:
          create = { id: xid(4), type: 'cursor', key: 'cursor' };
          break;
        case 95:
          free = xid(4);
          break;
      }
    }
    if (create) {
      analysis.live.set(create.id, {
        type: create.type,
        key: create.key,
        seq: analysis.seq,
      });
    } else if (free != null) {
      const entry = analysis.live.get(free);
      if (entry) {
        analysis.live.delete(free);
        analysis.churnPairs += 1;
        analysis.churned.push({
          type: entry.type,
          key: entry.key,
          createdSeq: entry.seq,
          freedSeq: analysis.seq,
        });
      }
    }
  };

  /**
   * Follow RENDER's per-picture `convolution` filter.
   *
   * SetPictureFilter draws nothing itself, but it decides what every later
   * Composite through that picture *does*: the server re-runs the kernel per
   * composite, so a 61x61 filter turns each destination pixel into 3721
   * multiply-accumulates. The XID is cleared on FreePicture and on any
   * picture create, because node-x11 recycles ids and a stale kernel would
   * price the wrong surface.
   */
  const trackFilter = (op, minor, buf, base, len) => {
    if (analysis.extNames.get(op) !== 'RENDER') return;
    if (
      minor === RENDER_FREE_PICTURE ||
      minor === RENDER_CREATE_PICTURE ||
      RENDER_CREATE_SOURCE.has(minor)
    ) {
      analysis.filters.delete(buf.readUInt32LE(base + 4));
      return;
    }
    if (minor !== RENDER_SET_PICTURE_FILTER || len < base + 12) return;
    const pid = buf.readUInt32LE(base + 4);
    const nameLen = buf.readUInt16LE(base + 8);
    const nameEnd = base + 12 + nameLen;
    // any other filter — and a convolution whose parameters we cannot read —
    // is one tap a pixel, i.e. exactly what compositePixels already prices
    if (len < nameEnd) return;
    const params = base + 12 + ((nameLen + 3) & ~3);
    if (
      buf.toString('latin1', base + 12, nameEnd) !== 'convolution' ||
      len < params + 8
    ) {
      analysis.filters.delete(pid);
      return;
    }
    // a convolution's first two FIXED parameters are the kernel's extent
    const kw = Math.max(1, Math.round(buf.readInt32LE(params) / FIXED));
    const kh = Math.max(1, Math.round(buf.readInt32LE(params + 4) / FIXED));
    analysis.filters.set(pid, { taps: kw * kh, key: `${kw}x${kh}` });
  };

  /**
   * A Composite, with the convolution its source and mask carry folded in.
   * Priced here rather than in `convolvedPixels` because the filter is
   * mutable state: by the end of the run the picture may carry a different
   * kernel, or none, or belong to something else entirely.
   */
  const trackComposite = (op, minor, buf, base, len) => {
    if (len - base !== 36) return;
    let taps = 0;
    const kernels = [];
    if (
      analysis.extNames.get(op) === 'RENDER' &&
      minor === RENDER_COMPOSITE &&
      analysis.filters.size
    ) {
      for (const [role, at] of [
        ['src', 8],
        ['mask', 12],
      ]) {
        const filter = analysis.filters.get(buf.readUInt32LE(base + at));
        if (!filter) continue;
        taps += filter.taps;
        kernels.push(`${role} ${filter.key}`);
      }
    }
    const w = buf.readUInt16LE(base + 32);
    const h = buf.readUInt16LE(base + 34);
    stats.composites.push([
      op,
      minor,
      w,
      h,
      taps * w * h,
      kernels.join(' + ') || null,
    ]);
  };

  const onRequest = (buf, len) => {
    const op = buf[0];
    const minor = buf[1];
    // BIG-REQUESTS framing: length field 0, real length in an extra word at
    // [4..8) — every argument after the header shifts by 4 bytes
    const base = buf.readUInt16LE(2) === 0 ? 4 : 0;
    analysis.seq += 1;
    analysis.lastWritten = analysis.seq;
    const entry = {
      op,
      minor,
      name: nameOf(op, minor),
      len,
      hash: fnv1a(buf, len),
    };
    analysis.reqLog[analysis.seq] = entry;
    if (op === 98 && len >= base + 8) {
      const n = buf.readUInt16LE(base + 4);
      if (len >= base + 8 + n) {
        analysis.pendingQueryExt.set(
          analysis.seq,
          buf.toString('latin1', base + 8, base + 8 + n),
        );
      }
    }
    trackResource(op, minor, buf, base);
    trackFilter(op, minor, buf, base, len);
    trackComposite(op, minor, buf, base, len);
  };

  const onReply = (buf) => {
    const seq = widenSeq(buf.readUInt16LE(2), analysis.seq);
    const entry = analysis.reqLog[seq];
    if (seq === analysis.lastWritten) {
      analysis.stalls += 1;
      analysis.stallList.push({ seq, name: entry?.name ?? '?' });
    }
    const asked = analysis.pendingQueryExt.get(seq);
    if (asked !== undefined) {
      analysis.pendingQueryExt.delete(seq);
      if (buf[8]) analysis.extNames.set(buf[9], asked);
    }
    if (entry && entry.op !== SYNC_OPCODE && !isConsumingRead(entry)) {
      const known = analysis.queryHashes.get(entry.hash);
      if (known) {
        known.count += 1;
        analysis.dupQueries += 1;
        analysis.dupList.push({ seq, name: entry.name });
      } else {
        analysis.queryHashes.set(entry.hash, { name: entry.name, count: 1 });
      }
    }
  };

  const countRequests = () => {
    for (;;) {
      if (!handshakeOut) {
        // setup request: 12-byte header + padded auth strings
        if (outBuf.length < 12) return;
        const n = outBuf.readUInt16LE(6);
        const d = outBuf.readUInt16LE(8);
        const total = 12 + ((n + 3) & ~3) + ((d + 3) & ~3);
        if (outBuf.length < total) return;
        outBuf = outBuf.subarray(total);
        handshakeOut = true;
        continue;
      }
      if (outBuf.length < 4) return;
      const opcode = outBuf[0];
      let len = outBuf.readUInt16LE(2) * 4;
      if (len === 0) {
        if (outBuf.length < 8) return;
        len = outBuf.readUInt32LE(4) * 4;
      }
      if (len === 0 || outBuf.length < len) return;
      stats.requests += 1;
      stats.byOpcode.set(opcode, (stats.byOpcode.get(opcode) ?? 0) + 1);
      onRequest(outBuf, len);
      outBuf = outBuf.subarray(len);
    }
  };

  const countReplies = () => {
    for (;;) {
      if (!handshakeIn) {
        if (inBuf.length < 8) return;
        const extra = inBuf.readUInt16LE(6) * 4;
        const total = 8 + extra;
        if (inBuf.length < total) return;
        inBuf = inBuf.subarray(total);
        handshakeIn = true;
        continue;
      }
      if (inBuf.length < 32) return;
      const type = inBuf[0];
      let total = 32;
      if (type === 1) {
        total = 32 + inBuf.readUInt32LE(4) * 4;
        if (inBuf.length < total) return;
        stats.replies += 1;
        onReply(inBuf);
      } else if (type === 0) {
        stats.errors += 1;
      } else {
        // GenericEvent (XGE, e.g. Present CompleteNotify) carries an extra
        // length like a reply; every other event is a fixed 32 bytes.
        if ((type & 0x7f) === 35) {
          total = 32 + inBuf.readUInt32LE(4) * 4;
          if (inBuf.length < total) return;
        }
        stats.events += 1;
      }
      inBuf = inBuf.subarray(total);
    }
  };

  const recordChunk = (dir, buf) => {
    stats.captureRecords.push(
      JSON.stringify({
        c: 0,
        d: dir,
        m: Math.round(performance.now()),
        w: Date.now(),
        b: buf.toString('hex'),
      }),
    );
  };

  const write = inner.write.bind(inner);
  inner.write = (chunk, ...rest) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stats.bytesOut += buf.length;
    if (stats.captureRecords) recordChunk('c2s', buf);
    outBuf = Buffer.concat([outBuf, buf]);
    countRequests();
    return write(chunk, ...rest);
  };

  const emit = inner.emit.bind(inner);
  inner.emit = (name, ...args) => {
    if (name === 'data') {
      const buf = args[0];
      stats.bytesIn += buf.length;
      if (stats.captureRecords) recordChunk('s2c', buf);
      inBuf = Buffer.concat([inBuf, buf]);
      countReplies();
    }
    return emit(name, ...args);
  };

  return { stream: inner, stats };
}

/**
 * Snapshot the analysis counters, so a caller can measure a window: take a
 * mark, run the interaction, and hand both to `windowAnalysis`.
 */
export function analysisMark(stats) {
  const a = stats.analysis;
  return {
    seq: a.seq,
    stalls: a.stalls,
    dupQueries: a.dupQueries,
    churnPairs: a.churnPairs,
  };
}

/**
 * The efficiency numbers for everything after `mark`, plus the hotspot
 * detail behind each number: which request names stalled, which queries
 * repeated, which resources churned (keyed by their creation parameters,
 * so "same-size pixmap rebuilt per frame" reads as one line with a count).
 */
export function windowAnalysis(stats, mark) {
  const a = stats.analysis;
  const byName = new Map();
  for (let seq = mark.seq + 1; seq <= a.seq; seq++) {
    const entry = a.reqLog[seq];
    if (entry) byName.set(entry.name, (byName.get(entry.name) ?? 0) + 1);
  }
  const tally = (list, keyOf) => {
    const out = new Map();
    for (const item of list) {
      const key = keyOf(item);
      out.set(key, (out.get(key) ?? 0) + 1);
    }
    return [...out.entries()].sort((x, y) => y[1] - x[1]);
  };
  const inWindow = (seq) => seq > mark.seq;
  // Churn means created AND freed inside the window — a run phase tearing
  // down something prepare built is a one-off, not a create/free cycle, so
  // it must not count (and must not trip the gate when a cleanup moves).
  const churned = a.churned.filter(
    (c) => inWindow(c.createdSeq) && inWindow(c.freedSeq),
  );
  return {
    stalls: a.stalls - mark.stalls,
    dupQueries: a.dupQueries - mark.dupQueries,
    churn: churned.length,
    byName: [...byName.entries()].sort((x, y) => y[1] - x[1]),
    stallsBy: tally(
      a.stallList.filter((s) => inWindow(s.seq)),
      (s) => s.name,
    ),
    dupsBy: tally(
      a.dupList.filter((d) => inWindow(d.seq)),
      (d) => d.name,
    ),
    churnBy: tally(churned, (c) => c.key),
  };
}

/**
 * The recorded session as `.x11cap` text (x11vis's line-JSON format:
 * header line, then one hex-encoded chunk per line), so bench runs can be
 * opened with `x11vis --open` and compared with `x11vis --diff`.
 */
export function captureLines(stats, target = 'react-x11 bench (in-process)') {
  if (!stats.captureRecords) {
    throw new Error('countStream was not created with { record: true }');
  }
  const header = JSON.stringify({
    x11cap: 1,
    savedAt: Date.now(),
    target,
    connections: [],
  });
  return `${[header, ...stats.captureRecords].join('\n')}\n`;
}

/**
 * Pixels touched by Render Composite. Requests and bytes miss this
 * entirely — a Composite request is 36 bytes whether it touches ten
 * pixels or the whole surface — so a change can look free on the wire
 * while multiplying the server's work.
 */
export function compositePixels(stats, renderOpcode) {
  let px = 0;
  let n = 0;
  for (const [major, minor, w, h] of stats.composites) {
    if (major === renderOpcode && minor === RENDER_COMPOSITE) {
      px += w * h;
      n += 1;
    }
  }
  return { composites: n, pixels: px };
}

/**
 * Multiply-accumulates inside those composites. `compositePixels` counts
 * *area*, and by doing so assumes a destination pixel costs the same
 * everywhere. A source or mask picture carrying RENDER's `convolution`
 * filter breaks that assumption, and breaks it by orders of magnitude: the
 * server re-runs the kernel on every composite that reads the picture, so
 * one composite of a 65k-pixel surface is 65k taps or 244M depending on a
 * piece of picture state neither the request count nor the area can see.
 *
 * That is not hypothetical — it is issue #413. A blurred `boxShadow` set the
 * filter on a cached coverage surface instead of baking the blur into its
 * pixels; every shadowed repaint re-convolved, ~700x slower on a real
 * display, and requests, bytes, composites, area, stalls, dups, churn and
 * the rendered pixels were all unchanged across the fix.
 *
 * `pixels` is the tap count — `kernel_w × kernel_h × area`, summed over the
 * source and the mask when both are filtered — so it is directly comparable
 * with `compositePixels`: equal means one tap a pixel, 3721x means a 61x61
 * gaussian is running over every one of them.
 */
export function convolvedPixels(stats, renderOpcode) {
  let taps = 0;
  let n = 0;
  const byKernel = new Map();
  for (const [major, minor, , , price, kernel] of stats.composites) {
    if (major !== renderOpcode || minor !== RENDER_COMPOSITE || !price)
      continue;
    taps += price;
    n += 1;
    byKernel.set(kernel, (byKernel.get(kernel) ?? 0) + 1);
  }
  return {
    composites: n,
    pixels: taps,
    byKernel: [...byKernel.entries()].sort((a, b) => b[1] - a[1]),
  };
}

export function summarize(stats, topOpcodes = 6) {
  const top = [...stats.byOpcode.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topOpcodes);
  return {
    requests: stats.requests,
    bytesOut: stats.bytesOut,
    replies: stats.replies,
    events: stats.events,
    errors: stats.errors,
    bytesIn: stats.bytesIn,
    topOpcodes: top,
  };
}
