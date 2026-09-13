// Turning a GPU buffer into something the compositor can show.
//
// This is the whole of the Wayland side of Tier D, and it is short, which is
// the point the RFC was making: x11-dri's `Surface.swap()` already answers
// `{ fd, stride, offset, modifier }`, and that is exactly the argument list
// `zwp_linux_buffer_params_v1.add` wants. No pixels cross the socket — the
// descriptor goes over once per buffer, and every later frame in that buffer
// is an `attach` of a `wl_buffer` the compositor already holds.
//
// The one judgement call is `create` versus `create_immed`. `create_immed`
// saves a round trip and answers the buffer synchronously; the price is that
// a refusal is a *protocol error*, which is fatal and takes the connection
// with it. A refusal is not hypothetical — it is what happens when client and
// compositor are on different DRM devices and the tiled layout means nothing
// to the one displaying it — and it has a real remedy, a linear buffer. So
// the first import of a generation goes through `create`, whose `failed`
// event is catchable and gives the fallback somewhere to happen. Buffers are
// created a handful of times per generation and never again in steady state,
// so this is a startup cost, not a per-frame one.

/** `zwp_linux_buffer_params_v1.flags` — none of which we want. */
const NO_FLAGS = 0;

/**
 * Import one dma-buf as a `wl_buffer`.
 *
 * Takes ownership of `out.fd`: the transport closes descriptors once they are
 * on the wire, which is the contract every fd-passing Wayland request has.
 *
 * @param {object} dmabuf a bound `zwp_linux_dmabuf_v1`
 * @param {object} out a `SwapResult` from `Surface.swap()`, with `isNew: true`
 * @param {number} format a DRM fourcc — `x11-dri`'s `FORMAT.XRGB8888` and friends
 * @returns {Promise<object>} the `wl_buffer` proxy
 */
export async function importDmabuf(dmabuf, out, format) {
  const params = await dmabuf.create_params();
  // A single plane. The modifier is split across two uint arguments because
  // the wire has no 64-bit integer type.
  const modifier = BigInt(out.modifier ?? 0n);
  await params.add(
    out.fd,
    0, // plane_idx
    out.offset >>> 0,
    out.stride >>> 0,
    Number(modifier >> 32n) >>> 0,
    Number(modifier & 0xffffffffn) >>> 0,
  );

  return await new Promise((resolve, reject) => {
    let settled = false;
    params.on('created', (buffer) => {
      if (settled) return;
      settled = true;
      // The params object is single-use; the buffer outlives it.
      params.destroy().catch(() => {});
      resolve(buffer);
    });
    params.on('failed', () => {
      if (settled) return;
      settled = true;
      params.destroy().catch(() => {});
      reject(
        new DmabufRefused(
          `the compositor refused a ${out.width}x${out.height} dma-buf ` +
            `(stride ${out.stride}, modifier 0x${modifier.toString(16)})`,
        ),
      );
    });
    params.create(out.width, out.height, format, NO_FLAGS).catch((err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * The compositor would not take this buffer.
 *
 * Distinguished from any other failure because it has a remedy — retry the
 * generation with a linear layout — and because it is the expected answer on
 * a multi-GPU machine rather than a bug.
 */
export class DmabufRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'DmabufRefused';
  }
}
