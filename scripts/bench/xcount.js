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
//   events    — anything else, 32 bytes (GenericEvent carries extra)
/**
 * Attach counters to an existing X11 stream without replacing it: wrap
 * `write` for the client->server direction and intercept the 'data' event
 * for server->client. Replacing the stream with a Duplex instead means
 * owning backpressure, which is easy to get subtly wrong and would make
 * the measurement itself a variable.
 */
export function countStream(inner) {
  const stats = {
    requests: 0,
    bytesOut: 0,
    replies: 0,
    events: 0,
    errors: 0,
    bytesIn: 0,
    byOpcode: new Map(),
    // (major, minor, w, h) for every 36-byte request, so Render Composite
    // pixel area can be totalled once the extension opcode is known
    composites: [],
  };

  let outBuf = Buffer.alloc(0);
  let inBuf = Buffer.alloc(0);
  let handshakeOut = false; // first client message is the connection setup
  let handshakeIn = false;

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
      if (len === 36) {
        stats.composites.push([
          opcode,
          outBuf[1],
          outBuf.readUInt16LE(32),
          outBuf.readUInt16LE(34),
        ]);
      }
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
      } else if (type === 0) {
        stats.errors += 1;
      } else {
        stats.events += 1;
      }
      inBuf = inBuf.subarray(total);
    }
  };

  const write = inner.write.bind(inner);
  inner.write = (chunk, ...rest) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stats.bytesOut += buf.length;
    outBuf = Buffer.concat([outBuf, buf]);
    countRequests();
    return write(chunk, ...rest);
  };

  const emit = inner.emit.bind(inner);
  inner.emit = (name, ...args) => {
    if (name === 'data') {
      const buf = args[0];
      stats.bytesIn += buf.length;
      inBuf = Buffer.concat([inBuf, buf]);
      countReplies();
    }
    return emit(name, ...args);
  };

  return { stream: inner, stats };
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
    if (major === renderOpcode && minor === 8) {
      px += w * h;
      n += 1;
    }
  }
  return { composites: n, pixels: px };
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
