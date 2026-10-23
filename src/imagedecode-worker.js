// The other end of `decodeImageBytes`'s `offThread` (imagedecode.js): the
// JavaScript rung, run where it holds no frame. A decode's pixels go back
// handed over, never copied, and its error as the message the caller's
// rejection carries.
import { parentPort } from 'node:worker_threads';

import { decodeHere } from './imagedecode.js';

parentPort.on('message', async ({ id, bytes }) => {
  try {
    const image = await decodeHere(bytes);
    let data = image.data;
    // a view of a larger buffer — a pooled Buffer — is copied out first,
    // so what is handed over is the pixels and nothing beside them
    if (
      !(data.buffer instanceof ArrayBuffer) ||
      data.byteOffset !== 0 ||
      data.byteLength !== data.buffer.byteLength
    ) {
      data = new Uint8Array(data);
    }
    parentPort.postMessage(
      { id, width: image.width, height: image.height, data: data.buffer },
      [data.buffer],
    );
  } catch (err) {
    parentPort.postMessage({
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
