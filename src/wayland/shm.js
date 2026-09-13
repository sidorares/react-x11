// Shared-memory buffers: the CPU path to a `wl_buffer`, beside the dma-buf
// one the swapchain takes.
//
// Not for frames — every window frame here is a dma-buf and no pixel crosses
// the socket — but a screen capture has to land somewhere the client can
// read, and a compositor fills a `wl_shm` buffer, which is memory both sides
// map. On this side "map" is the problem: neither Node nor Bun has mmap. What
// both have is pread/pwrite on a descriptor, and a pool's memory *is* a file
// — a memfd (x11-dri's `memfdCreate`), or without the addon an unlinked file
// under /dev/shm — so the pixels are read back with `fs.readSync` from offset
// 0 once the compositor says the frame is ready. That is one copy of one
// screen on a path nobody runs per frame; the mmap it stands in for would
// have saved it and cost a native binding.
//
// Two descriptors per pool, on purpose. The transport closes a descriptor it
// has sent — `wl_shm.create_pool` hands ownership to the compositor — so the
// one that goes on the wire is a dup and the original stays ours.
//
// Pixel layouts are the DRM fourcc ones `wl_shm.format` names: a packed
// little-endian 32-bit word, so `XRGB8888` is the bytes B, G, R, X in memory
// and `XBGR8888` is R, G, B, X. This machine is little-endian, as is every
// machine a Wayland compositor has shipped on.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { closeFd } from './fdutil.js';

const require = createRequire(import.meta.url);

/** The `wl_shm.format` values this file reads and writes. */
export const SHM_FORMAT = {
  ARGB8888: 0,
  XRGB8888: 1,
  XBGR8888: 0x34324258,
  ABGR8888: 0x34324241,
};

const BGRX = new Set([SHM_FORMAT.ARGB8888, SHM_FORMAT.XRGB8888]);
const RGBX = new Set([SHM_FORMAT.XBGR8888, SHM_FORMAT.ABGR8888]);
const WITH_ALPHA = new Set([SHM_FORMAT.ARGB8888, SHM_FORMAT.ABGR8888]);

export function isSupportedShmFormat(format) {
  return BGRX.has(format) || RGBX.has(format);
}

/**
 * Shared memory of `size` bytes, as two descriptors on the same pages: `fd`
 * to keep, `wire` to give to the compositor.
 *
 * @returns {{ fd: number, wire: number, size: number }}
 */
export function openSharedMemory(size, name = 'react-x11') {
  try {
    const dri = require('x11-dri');
    if (
      typeof dri.memfdCreate === 'function' &&
      typeof dri.dup === 'function'
    ) {
      const fd = dri.memfdCreate(size, name);
      return { fd, wire: dri.dup(fd), size };
    }
  } catch {
    /* the addon is optional; the file below works without it */
  }
  // A file both ends open, gone from the namespace the moment both have.
  const path = `/dev/shm/${name}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const { O_RDWR, O_CREAT, O_EXCL } = fs.constants;
  const fd = fs.openSync(path, O_RDWR | O_CREAT | O_EXCL, 0o600);
  let wire = -1;
  try {
    fs.ftruncateSync(fd, size);
    wire = fs.openSync(path, O_RDWR);
    return { fd, wire, size };
  } catch (err) {
    closeFd(fd);
    throw err;
  } finally {
    try {
      fs.unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
}

export class ShmBuffer extends EventEmitter {
  /**
   * A pool holding exactly one buffer.
   *
   * @param {object} opts
   * @param {object} opts.shm the `wl_shm` proxy
   * @param {number} opts.width in pixels
   * @param {number} opts.height
   * @param {number} [opts.stride=width*4] bytes per row
   * @param {number} [opts.format=SHM_FORMAT.XRGB8888]
   * @param {string} [opts.name] what the memfd is called in /proc
   */
  constructor({
    shm,
    width,
    height,
    stride = width * 4,
    format = SHM_FORMAT.XRGB8888,
    name = 'react-x11-shm',
  }) {
    super();
    this.width = width;
    this.height = height;
    this.stride = stride;
    this.format = format;
    this.size = stride * height;
    const mem = openSharedMemory(this.size, name);
    this.fd = mem.fd;
    this.pool = shm.$.create_pool(mem.wire, this.size);
    /** the `wl_buffer` proxy */
    this.buffer = this.pool.$.create_buffer(0, width, height, stride, format);
    this.destroyed = false;
    this.buffer.on('release', () => this.emit('release'));
  }

  /** Everything in the pool, read back. */
  read() {
    const out = Buffer.allocUnsafe(this.size);
    let off = 0;
    while (off < this.size) {
      const n = fs.readSync(this.fd, out, off, this.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return out;
  }

  /** Overwrite the pool from offset 0. */
  write(bytes) {
    let off = 0;
    while (off < bytes.length) {
      off += fs.writeSync(this.fd, bytes, off, bytes.length - off, off);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.buffer.$.destroy();
      this.pool.$.destroy();
    } catch {
      /* connection gone */
    }
    closeFd(this.fd);
  }
}

/**
 * One pixel of a pool, as 0–255 channels.
 *
 * @param {Buffer|Uint8Array} bytes the pool's contents
 * @param {{ stride:number, format:number }} layout
 */
export function shmPixel(bytes, { stride, format }, x, y) {
  const o = y * stride + x * 4;
  if (BGRX.has(format)) {
    return { r: bytes[o + 2], g: bytes[o + 1], b: bytes[o] };
  }
  if (RGBX.has(format)) {
    return { r: bytes[o], g: bytes[o + 1], b: bytes[o + 2] };
  }
  throw new Error(`unsupported wl_shm format 0x${format.toString(16)}`);
}

/**
 * A pool's contents as straight RGBA, top row first — the shape
 * `readback.js`'s `encodePNG` takes.
 *
 * @param {object} frame
 * @param {Buffer|Uint8Array} frame.bytes
 * @param {boolean} [frame.yInvert] the rows are bottom-up (screencopy's flag)
 */
export function shmToRGBA({
  bytes,
  width,
  height,
  stride,
  format,
  yInvert = false,
}) {
  if (!isSupportedShmFormat(format)) {
    throw new Error(`unsupported wl_shm format 0x${format.toString(16)}`);
  }
  const swap = BGRX.has(format);
  const alpha = WITH_ALPHA.has(format);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const src = (yInvert ? height - 1 - y : y) * stride;
    const dst = y * width * 4;
    for (let x = 0; x < width; x++) {
      const s = src + x * 4;
      const d = dst + x * 4;
      if (swap) {
        data[d] = bytes[s + 2];
        data[d + 1] = bytes[s + 1];
        data[d + 2] = bytes[s];
      } else {
        data[d] = bytes[s];
        data[d + 1] = bytes[s + 1];
        data[d + 2] = bytes[s + 2];
      }
      data[d + 3] = alpha ? bytes[s + 3] : 255;
    }
  }
  return { width, height, data };
}

/** Reverse the row order in place: a y-inverted frame the right way up. */
export function flipRows(bytes, stride, height) {
  const tmp = Buffer.allocUnsafe(stride);
  for (let y = 0; y < height >> 1; y++) {
    const a = y * stride;
    const b = (height - 1 - y) * stride;
    bytes.copy(tmp, 0, a, a + stride);
    bytes.copy(bytes, a, b, b + stride);
    tmp.copy(bytes, b, 0, stride);
  }
  return bytes;
}
