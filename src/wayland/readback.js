// Reading a frame back off the GPU, as a PNG.
//
// This exists for testing, and it is the Wayland side of a property the RFC
// singles out: on X11 a pixel assertion is a `GetImage` round trip to the
// server, and here every committed buffer is just memory. `glReadPixels`
// against the frame that is about to be handed over answers "what did we
// actually draw" with no compositor, no display and no screenshot portal in
// the way — which is the only way to check rendering on a machine whose
// compositor will not serve `wlr-screencopy`, and the right way regardless,
// because it isolates the renderer from everything downstream of it.
//
// The PNG encoder is here rather than as a dependency because it is forty
// lines and a test helper should not add a package to the tree.

import zlib from 'node:zlib';

/**
 * Read the current framebuffer as straight (un-premultiplied) RGBA.
 *
 * @returns {{width:number, height:number, data:Uint8Array}} top-row-first,
 *   which is the opposite of what GL hands back.
 */
export function readFramebuffer(gl, width, height) {
  const raw = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  // GL's origin is bottom-left; flip into image order.
  const data = new Uint8Array(raw.length);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * rowBytes;
    data.set(raw.subarray(src, src + rowBytes), y * rowBytes);
  }
  // The renderer composites premultiplied; undo it so the PNG looks right in
  // a viewer, which expects straight alpha.
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0 || a === 255) continue;
    data[i] = Math.min(255, Math.round((data[i] * 255) / a));
    data[i + 1] = Math.min(255, Math.round((data[i + 1] * 255) / a));
    data[i + 2] = Math.min(255, Math.round((data[i + 2] * 255) / a));
  }
  return { width, height, data };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode straight RGBA as a PNG. */
export function encodePNG({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rowBytes = width * 4;
  // One filter byte (0 = None) in front of each scanline.
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0;
    raw.set(
      data.subarray(y * rowBytes, (y + 1) * rowBytes),
      y * (rowBytes + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Read the framebuffer and encode it in one step. */
export function snapshotPNG(gl, width, height) {
  return encodePNG(readFramebuffer(gl, width, height));
}
