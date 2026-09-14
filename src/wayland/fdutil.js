// The two descriptor primitives Wayland data transfer needs and JavaScript
// runtimes do not expose: a pipe, and reading/writing a raw fd as a stream.
//
// A clipboard paste on Wayland is: make a pipe, hand the write end to the
// compositor (`wl_data_offer.receive`), read the content from the read end.
// A copy is the reverse: the compositor hands us a write end and we stream
// into it. Neither Node nor Bun has `pipe(2)`. x11-dri grew one for exactly
// this; on Bun without it, `bun:ffi` reaches libc directly.

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let bunPipe = null;

/**
 * @returns {{ read: number, write: number }} both ends, close-on-exec
 */
export function makePipe() {
  try {
    const dri = require('x11-dri');
    if (typeof dri.pipe === 'function') return dri.pipe();
  } catch {
    /* fall through */
  }
  if (typeof Bun !== 'undefined') {
    if (!bunPipe) bunPipe = loadBunPipe();
    if (bunPipe) return bunPipe();
  }
  throw new Error(
    'no way to create a pipe: install x11-dri >= 0.9, or run under Bun',
  );
}

function loadBunPipe() {
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi');
    const names = ['libc.so.6', 'libc.so', 'libSystem.B.dylib'];
    let lib = null;
    for (const n of names) {
      try {
        lib = dlopen(n, {
          pipe2: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        });
        break;
      } catch {
        /* next */
      }
    }
    if (!lib) return null;
    const O_CLOEXEC = 0x80000;
    return () => {
      const fds = new Int32Array(2);
      if (lib.symbols.pipe2(ptr(fds), O_CLOEXEC) !== 0)
        throw new Error('pipe2 failed');
      return { read: fds[0], write: fds[1] };
    };
  } catch {
    return null;
  }
}

/**
 * Read everything from a descriptor until EOF, then close it. Resolves with
 * a Buffer. The compositor (or the source client) writes at its own pace, so
 * this is a stream, not a blocking read.
 */
export function readAll(fd, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = fs.createReadStream('', { fd, autoClose: true });
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new Error('timed out waiting for the selection content'));
    }, timeout);
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Write a buffer to a descriptor and close it. */
export function writeAll(fd, data) {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream('', { fd, autoClose: true });
    stream.on('error', (err) => {
      // EPIPE: the reader went away; that is their business, not an error here
      if (err?.code === 'EPIPE') resolve();
      else reject(err);
    });
    stream.end(data, () => resolve());
  });
}

export function closeFd(fd) {
  try {
    fs.closeSync(fd);
  } catch {
    /* already closed */
  }
}
