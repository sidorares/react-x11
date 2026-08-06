// react-x11/debug — runtime X11 protocol tracing and frame diagnostics.
//
// The environment switch (read once by the Reconciler at import time):
//
//   REACT_X11_TRACE=summary                 opcode histogram + byte totals at exit
//   REACT_X11_TRACE=requests                one stderr line per request + per frame
//   REACT_X11_TRACE=chrome:/tmp/trace.json  Chrome Trace Event JSON at exit
//
// append `+stacks` to `requests` or `chrome` to capture a JS stack per
// request (node-x11's seq2stack), so an async X error names the call that
// sent the offending request. That costs an Error capture per request, so
// it is not on by default.
//
// The API (any connection, not only the renderer's):
//
//   import { startTrace } from 'react-x11/debug';
//   const trace = startTrace({ sink: 'chrome', path: '/tmp/t.json' });
//   ...
//   const { requests, bytesOut, replies, byOpcode } = trace.stop();
//
// With no `app`, the trace follows every connection the renderer has open
// or opens later. Pass `app` to trace one specific connection instead.
//
// The tracer attaches to a connection *after* its handshake: it wraps the
// pack stream that carries framed requests and adds a listener beside
// node-x11's own on the socket. The connection-setup packet — the one that
// carries the X auth cookie — was written before either hook existed, so
// the tracer cannot observe it. Redaction by construction, not by filter.
// Payload bytes are never recorded either — only opcode, length and
// direction — so window contents and property values stay off the log.
import { writeFileSync } from 'node:fs';
import { onApp, hooks } from './trace-registry.js';

// --- names --------------------------------------------------------------

// Core request opcodes 1..119 in protocol order (`-` marks a hole), plus
// 127. Kept as one word list so the table reads like the protocol index.
const CORE_REQUESTS = `- CreateWindow ChangeWindowAttributes
  GetWindowAttributes DestroyWindow DestroySubwindows ChangeSaveSet
  ReparentWindow MapWindow MapSubwindows UnmapWindow UnmapSubwindows
  ConfigureWindow CirculateWindow GetGeometry QueryTree InternAtom
  GetAtomName ChangeProperty DeleteProperty GetProperty ListProperties
  SetSelectionOwner GetSelectionOwner ConvertSelection SendEvent GrabPointer
  UngrabPointer GrabButton UngrabButton ChangeActivePointerGrab GrabKeyboard
  UngrabKeyboard GrabKey UngrabKey AllowEvents GrabServer UngrabServer
  QueryPointer GetMotionEvents TranslateCoordinates WarpPointer
  SetInputFocus GetInputFocus QueryKeymap OpenFont CloseFont QueryFont
  QueryTextExtents ListFonts ListFontsWithInfo SetFontPath GetFontPath
  CreatePixmap FreePixmap CreateGC ChangeGC CopyGC SetDashes
  SetClipRectangles FreeGC ClearArea CopyArea CopyPlane PolyPoint PolyLine
  PolySegment PolyRectangle PolyArc FillPoly PolyFillRectangle PolyFillArc
  PutImage GetImage PolyText8 PolyText16 ImageText8 ImageText16
  CreateColormap FreeColormap CopyColormapAndFree InstallColormap
  UninstallColormap ListInstalledColormaps AllocColor AllocNamedColor
  AllocColorCells AllocColorPlanes FreeColors StoreColors StoreNamedColor
  QueryColors LookupColor CreateCursor CreateGlyphCursor FreeCursor
  RecolorCursor QueryBestSize QueryExtension ListExtensions
  ChangeKeyboardMapping GetKeyboardMapping ChangeKeyboardControl
  GetKeyboardControl Bell ChangePointerControl GetPointerControl
  SetScreenSaver GetScreenSaver ChangeHosts ListHosts SetAccessControl
  SetCloseDownMode KillClient RotateProperties ForceScreenSaver
  SetPointerMapping GetPointerMapping SetModifierMapping
  GetModifierMapping`
  .trim()
  .split(/\s+/);
CORE_REQUESTS[127] = 'NoOperation';

const RENDER_MINORS = `QueryVersion QueryPictFormats QueryPictIndexValues -
  CreatePicture ChangePicture SetPictureClipRectangles FreePicture
  Composite - Trapezoids Triangles TriStrip TriFan - - - CreateGlyphSet
  ReferenceGlyphSet FreeGlyphSet AddGlyphs - FreeGlyphs CompositeGlyphs8
  CompositeGlyphs16 CompositeGlyphs32 FillRectangles CreateCursor
  SetPictureTransform QueryFilters SetPictureFilter CreateAnimCursor
  AddTraps CreateSolidFill CreateLinearGradient CreateRadialGradient
  CreateConicalGradient`
  .trim()
  .split(/\s+/);

const CORE_ERRORS = `- Request Value Window Pixmap Atom Cursor Font Match
  Drawable Access Alloc Colormap GC IDChoice Name Length Implementation`
  .trim()
  .split(/\s+/);

/** A `-` in the word lists above is a hole, not a name. */
const named = (table, index) => {
  const name = table[index];
  return name && name !== '-' ? name : null;
};

/** Extension major opcodes this connection negotiated, from the display. */
function extensionTable(app) {
  const table = new Map();
  const display = app?.display ?? app?.X?.display;
  if (!display || typeof display !== 'object') return table;
  for (const [key, value] of Object.entries(display)) {
    const major = value?.majorOpcode;
    if (typeof major === 'number' && major >= 128) {
      table.set(major, {
        name: key,
        minors: key === 'Render' ? RENDER_MINORS : null,
      });
    }
  }
  return table;
}

function opcodeName(extensions, major, minor) {
  if (major < 128) return named(CORE_REQUESTS, major) ?? `core${major}`;
  const ext = extensions.get(major);
  if (!ext) return `ext${major}.${minor}`;
  const minorName = ext.minors ? named(ext.minors, minor) : null;
  return `${ext.name}.${minorName ?? minor}`;
}

// --- framing ------------------------------------------------------------

const EMPTY = Buffer.alloc(0);
// Nothing ntk sends comes near this; a length beyond it means the parser
// lost the frame boundary (it attached mid-burst), so it resynchronises by
// dropping its buffer rather than swallowing the stream forever.
const MAX_SANE_LENGTH = 1 << 26;

/**
 * Incremental parser for the client->server direction of a post-handshake
 * X11 stream: framed requests, BIG-REQUESTS aware (a 16-bit length of 0
 * means the real 32-bit length follows the header).
 */
function requestParser(onRequest) {
  let buf = EMPTY;
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 4) return;
      const major = buf[0];
      const minor = buf[1];
      let len = buf.readUInt16LE(2) * 4;
      if (len === 0) {
        if (buf.length < 8) return;
        len = buf.readUInt32LE(4) * 4;
      }
      if (len < 4 || len > MAX_SANE_LENGTH) {
        buf = EMPTY; // desynchronised; drop and re-align on the next put
        return;
      }
      if (buf.length < len) return;
      onRequest(major, minor, len);
      buf = buf.subarray(len);
    }
  };
}

/**
 * Incremental parser for the server->client direction: 32-byte units, with
 * replies (type 1) and GenericEvents (code 35) carrying extra length.
 */
function inboundParser(onUnit) {
  let buf = EMPTY;
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 32) return;
      const type = buf[0];
      const code = type & 0x7f;
      let total = 32;
      if (type === 1 || code === 35) {
        total = 32 + buf.readUInt32LE(4) * 4;
        if (total > MAX_SANE_LENGTH) {
          buf = EMPTY;
          return;
        }
        if (buf.length < total) return;
      }
      if (type === 0) {
        onUnit('error', total, {
          errorCode: buf[1],
          seq: buf.readUInt16LE(2),
          minor: buf.readUInt16LE(8),
          major: buf[10],
        });
      } else if (type === 1) {
        onUnit('reply', total, null);
      } else {
        onUnit('event', total, { code });
      }
      buf = buf.subarray(total);
    }
  };
}

// --- seq2stack ----------------------------------------------------------

// How many recent requests keep their captured stack. A trace can run for
// minutes; an unbounded map of Error objects would not.
const STACK_WINDOW = 2048;

/**
 * node-x11 captures a stack per request when the client was created with
 * `{ debug: true }` (its "seq2stack" mode). A connection made without it
 * can still get the same accessor installed after the fact — same
 * mechanism, plus a sliding window so a long trace stays bounded.
 */
function enableSeq2Stack(X) {
  if (!X || X.seq2stack) return Boolean(X?.seq2stack);
  const desc = Object.getOwnPropertyDescriptor(X, 'seq_num');
  if (desc && !('value' in desc)) return false; // someone else's accessor
  try {
    let value = X.seq_num ?? 0;
    X.seq2stack = {};
    Object.defineProperty(X, 'seq_num', {
      configurable: true,
      get: () => value,
      set: function seqNumSetter(v) {
        value = v;
        const err = new Error();
        Error.captureStackTrace(err, seqNumSetter);
        err.timestamp = Date.now();
        X.seq2stack[v] = err;
        delete X.seq2stack[v - STACK_WINDOW];
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** The stack captured for a wire sequence number (16-bit, so it has to be
 * widened against the client's full counter before the lookup). */
function stackForSeq(X, seq16) {
  const map = X?.seq2stack;
  if (!map) return null;
  const current = X.seq_num ?? 0;
  const base = current & ~0xffff;
  for (const candidate of [base + seq16, base - 0x10000 + seq16]) {
    if (candidate >= 0 && candidate <= current && map[candidate]) {
      return map[candidate].stack;
    }
  }
  return null;
}

// --- the rounded-box fast path ------------------------------------------

/**
 * Every 2d context this app paints windows through. react-x11 caches one
 * per window node (nodes.js), which is where ntk keeps `shapeStats`.
 */
function contextsOf(app) {
  return (app?._rootChildren ?? [])
    .map((node) => node?._ctx)
    .filter((ctx) => ctx?.shapeStats);
}

/** `{ hits, misses }` summed over an app's contexts; zeroes on older ntk. */
function readShapes(app) {
  const total = { hits: 0, misses: {} };
  for (const ctx of contextsOf(app)) {
    const { hits = 0, misses = {} } = ctx.shapeStats;
    total.hits += hits;
    for (const [reason, count] of Object.entries(misses)) {
      total.misses[reason] = (total.misses[reason] ?? 0) + count;
    }
  }
  return total;
}

/**
 * One human line for a `stats.shapes` tally, or null when nothing drew a
 * rounded box at all. A bail-out is a silent perf cliff — a box that misses
 * the fast path is rasterized as a polygon instead — so the reasons are
 * spelled out rather than summed: `gradient`, `transform`, `clip-mask`,
 * `fractional`, `dashes`, `radius-cap`, `composite-op`, `geometry`,
 * `radii-mix`, `join`. docs/debugging.md explains what each one means.
 */
export function formatShapes(shapes) {
  if (!shapes) return null;
  const missed = Object.entries(shapes.misses ?? {}).sort(
    (a, b) => b[1] - a[1],
  );
  const total = missed.reduce((sum, [, count]) => sum + count, 0);
  if (!shapes.hits && !total) return null;
  const why = missed.map(([reason, count]) => `${reason} ${count}`).join(', ');
  return (
    `${shapes.hits} fast (glyph+rect), ${total} fell back` +
    (total ? ` (${why})` : '')
  );
}

/** b - a, clamped at zero: a context replaced mid-trace restarts at 0. */
function shapesDelta(a, b) {
  const delta = { hits: Math.max(0, b.hits - a.hits), misses: {} };
  for (const [reason, count] of Object.entries(b.misses)) {
    const grew = count - (a.misses[reason] ?? 0);
    if (grew > 0) delta.misses[reason] = grew;
  }
  return delta;
}

// --- the session --------------------------------------------------------

const usec = () => Math.round(performance.now() * 1000);

// A Chrome trace is buffered in memory until stop; this is the ceiling.
const MAX_TRACE_EVENTS = 1_000_000;

function createSession({ sink, path }) {
  const stats = {
    requests: 0,
    bytesOut: 0,
    replies: 0,
    events: 0,
    errors: 0,
    bytesIn: 0,
    /** decoded request name -> count, e.g. 'Render.CompositeGlyphs32' */
    byOpcode: new Map(),
    /**
     * ntk's rounded-rect fast path (ntk >= 6.7.0): boxes drawn as cached
     * corner glyphs + FillRectangles, and the ones that fell back to
     * polygon rasterization, by reason. Zeroes when the toolkit predates
     * it — see collectShapes.
     */
    shapes: { hits: 0, misses: {} },
  };
  /** app -> per-context shapeStats at attach time, so a trace started mid
   * session reports its own window rather than the process's history */
  const shapeBaselines = new Map();
  const chrome = sink === 'chrome' ? [] : null;
  let dropped = 0;
  let frames = 0;
  let commitStarted = 0;
  let finished = false;

  const record = (event) => {
    if (!chrome) return;
    if (chrome.length >= MAX_TRACE_EVENTS) {
      dropped += 1;
      return;
    }
    chrome.push(event);
  };

  const line = (text) => process.stderr.write(`${text}\n`);

  return {
    stats,

    /**
     * Take an app's fast-path counters as the zero point. Contexts are
     * created lazily on first paint, so a window that has not painted yet
     * simply has no baseline and counts in full.
     */
    watchApp(app) {
      if (app) shapeBaselines.set(app, readShapes(app));
    },

    request(name, bytes) {
      stats.requests += 1;
      stats.bytesOut += bytes;
      stats.byOpcode.set(name, (stats.byOpcode.get(name) ?? 0) + 1);
      if (sink === 'requests') {
        line(`x11 → ${name} ${bytes}B`);
      }
      record({
        name,
        ph: 'i',
        s: 't',
        ts: usec(),
        pid: process.pid,
        tid: 1,
        cat: 'x11',
        args: { bytes },
      });
    },

    inbound(kind, bytes, info, X, extensions) {
      stats.bytesIn += bytes;
      if (kind === 'reply') stats.replies += 1;
      else if (kind === 'event') stats.events += 1;
      else {
        stats.errors += 1;
        const errorName =
          named(CORE_ERRORS, info.errorCode) ?? `#${info.errorCode}`;
        const request = opcodeName(extensions, info.major, info.minor);
        const stack = stackForSeq(X, info.seq);
        if (sink === 'requests') {
          line(`x11 ← Error ${errorName} on ${request} (seq ${info.seq})`);
          if (stack) line(stack.replace(/^Error\n?/, ''));
        }
        record({
          name: `Error ${errorName} (${request})`,
          ph: 'i',
          s: 'p',
          ts: usec(),
          pid: process.pid,
          tid: 1,
          cat: 'x11,error',
          args: { seq: info.seq, stack: stack ?? undefined },
        });
      }
    },

    frame({ rects, reasons, start, end, fence }) {
      frames += 1;
      const full = !rects;
      const area = full
        ? null
        : rects.reduce((sum, r) => sum + r.width * r.height, 0);
      if (sink === 'requests') {
        const where = full
          ? 'FULL WINDOW'
          : rects.map((r) => `${r.width}x${r.height}@${r.x},${r.y}`).join(' ');
        const why = reasons?.length ? ` reasons=${reasons.join('+')}` : '';
        // the previous frame's measured server drain: on a healthy local
        // server it sits well under a millisecond, and a fence that grows
        // with window area is the signature of a server-side bottleneck
        // (software-fallback RENDER ops, a virtualized GPU) that client
        // timings cannot show
        const wait =
          typeof fence === 'number' ? ` fence=${fence.toFixed(1)}ms` : '';
        line(`frame ${frames}: ${where}${why}${wait}`);
      }
      record({
        name: 'frame',
        ph: 'X',
        ts: Math.round(start * 1000),
        dur: Math.max(1, Math.round((end - start) * 1000)),
        pid: process.pid,
        tid: 1,
        cat: 'react-x11',
        args: {
          full,
          rects: rects?.length ?? 0,
          area,
          reasons: reasons ?? [],
          fenceMs: typeof fence === 'number' ? +fence.toFixed(2) : undefined,
        },
      });
    },

    commitStart() {
      commitStarted = usec();
    },

    commitEnd() {
      if (!commitStarted) return;
      record({
        name: 'commit',
        ph: 'X',
        ts: commitStarted,
        dur: Math.max(1, usec() - commitStarted),
        pid: process.pid,
        tid: 1,
        cat: 'react-x11',
      });
      commitStarted = 0;
    },

    finish() {
      if (finished) return stats;
      finished = true;
      for (const [app, baseline] of shapeBaselines) {
        const delta = shapesDelta(baseline, readShapes(app));
        stats.shapes.hits += delta.hits;
        for (const [reason, count] of Object.entries(delta.misses)) {
          stats.shapes.misses[reason] =
            (stats.shapes.misses[reason] ?? 0) + count;
        }
      }
      if (sink === 'summary') {
        const top = [...stats.byOpcode.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8);
        const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
        line(
          `react-x11 trace: ${stats.requests} requests (${kb(stats.bytesOut)} out), ` +
            `${stats.replies} replies, ${stats.events} events, ` +
            `${stats.errors} errors (${kb(stats.bytesIn)} in)`,
        );
        for (const [name, count] of top) {
          line(`  ${String(count).padStart(7)}  ${name}`);
        }
        const shapeLine = formatShapes(stats.shapes);
        if (shapeLine) line(`  rounded boxes: ${shapeLine}`);
      }
      if (chrome) {
        if (dropped) {
          chrome.push({
            name: `trace truncated: ${dropped} events dropped`,
            ph: 'i',
            s: 'g',
            ts: usec(),
            pid: process.pid,
            tid: 1,
            cat: 'react-x11',
          });
        }
        writeFileSync(
          path,
          JSON.stringify({ traceEvents: chrome, displayTimeUnit: 'ms' }),
        );
        line(`react-x11 trace: wrote ${chrome.length} events to ${path}`);
      }
      return stats;
    },
  };
}

// --- attaching ----------------------------------------------------------

/**
 * Attach the session's counters to one connection. Returns a detacher, or
 * null when the connection has nothing to attach to (a mock app in tests).
 */
function attachApp(app, session, { seq2stack }) {
  const X = app?.X;
  const packStream = X?.pack_stream;
  if (!packStream || typeof packStream.put !== 'function') return null;
  const extensions = extensionTable(app);
  if (seq2stack) enableSeq2Stack(X);

  let active = true;
  const parseOut = requestParser((major, minor, len) => {
    session.request(opcodeName(extensions, major, minor), len);
  });
  const parseIn = inboundParser((kind, bytes, info) => {
    session.inbound(kind, bytes, info, X, extensions);
  });

  const origPut = packStream.put;
  const tracedPut = function (...args) {
    if (active && Buffer.isBuffer(args[0])) parseOut(args[0]);
    return origPut.apply(this, args);
  };
  packStream.put = tracedPut;

  const onData = (chunk) => {
    if (active && Buffer.isBuffer(chunk)) parseIn(chunk);
  };
  const stream = X.stream;
  if (typeof stream?.on === 'function') stream.on('data', onData);

  return () => {
    active = false;
    // only unhook what is still ours — another trace may have wrapped on top
    if (packStream.put === tracedPut) packStream.put = origPut;
    if (typeof stream?.removeListener === 'function') {
      stream.removeListener('data', onData);
    }
  };
}

// --- public API ---------------------------------------------------------

/**
 * Start tracing. `sink` is 'summary' (default), 'requests' or 'chrome'
 * (which needs `path`). With no `app` the trace follows every connection
 * the renderer has open or opens later; pass one to trace it alone.
 * `seq2stack: true` captures a JS stack per request so an asynchronous X
 * error can name the call that sent it — an Error capture per request, so
 * off by default.
 *
 * Returns `{ stats, stop }`; `stop()` detaches everything, flushes the
 * sink and returns the totals.
 */
export function startTrace(options = {}) {
  const {
    app,
    sink = 'summary',
    path = 'react-x11-trace.json',
    seq2stack = false,
  } = options;
  if (!['summary', 'requests', 'chrome'].includes(sink)) {
    throw new Error(
      `react-x11/debug: unknown trace sink ${JSON.stringify(sink)} — ` +
        "expected 'summary', 'requests' or 'chrome'.",
    );
  }
  const session = createSession({ sink, path });
  const detachers = [];
  const attach = (a) => {
    const detach = attachApp(a, session, { seq2stack });
    if (detach) detachers.push(detach);
    // independent of the pack-stream hook: the fast path is counted by the
    // toolkit, not observed on the wire, so a mock app with no stream to
    // wrap can still report it
    session.watchApp(a);
  };
  const unsubscribe = app ? null : onApp(attach);
  if (app) attach(app);

  const frame = (info) => session.frame(info);
  if (sink === 'requests' || sink === 'chrome') hooks.frame = frame;
  const commitStart = () => session.commitStart();
  const commitEnd = () => session.commitEnd();
  if (sink === 'chrome') {
    hooks.commitStart = commitStart;
    hooks.commitEnd = commitEnd;
  }

  let stopped = false;
  return {
    stats: session.stats,
    stop() {
      if (stopped) return session.stats;
      stopped = true;
      unsubscribe?.();
      for (const detach of detachers) detach();
      if (hooks.frame === frame) hooks.frame = null;
      if (hooks.commitStart === commitStart) hooks.commitStart = null;
      if (hooks.commitEnd === commitEnd) hooks.commitEnd = null;
      return session.finish();
    },
  };
}

/**
 * The REACT_X11_TRACE entry point, called by the Reconciler at import time.
 * Grammar: `summary`, `requests[+stacks]`, `chrome[+stacks]:<path>`.
 * The trace runs until the process exits, then flushes its sink.
 */
export function startEnvTrace(spec) {
  const match = /^(summary|requests|chrome)(\+stacks)?(?::(.*))?$/.exec(spec);
  if (!match) {
    console.warn(
      `react-x11: REACT_X11_TRACE=${JSON.stringify(spec)} not understood — ` +
        "expected 'summary', 'requests[+stacks]' or 'chrome[+stacks]:<path>'.",
    );
    return null;
  }
  const [, sink, stacks, path] = match;
  const trace = startTrace({
    sink,
    path: path || 'react-x11-trace.json',
    seq2stack: Boolean(stacks),
  });
  process.on('exit', () => trace.stop());
  return trace;
}
