// Who owns the GL state right now.
//
// Every 2d context on this backend draws through one GLES context: a
// window's, the pane a `<glarea>`'s children are painted on, and each
// offscreen surface's are all the same device, differing only in which
// framebuffer they bind and what they left the blend, scissor and stencil
// state saying. That is unlike every other backend react-x11 has — an
// XRender context is an encoder aimed at a drawable, a Cocoa one is a CGL
// bitmap that carries its own state — and it is why ntk's advice to hold a
// surface's context and draw into it whenever you like did not hold here:
// a held context's draws landed wherever the *last* context had pointed the
// device (issue #566).
//
// So the device gets an owner. A context claims it before it touches GL,
// and claiming is where the target is bound and the state it assumes is put
// back. Whoever drew in between does not have to know who comes next, and a
// caller does not have to know there is a device at all.
//
// Claiming is also a *batch boundary*: a 2d context buffers its quads and
// draws them in one call later, so the outgoing owner is flushed on the way
// out. That is what makes the invariant this module offers true — **only the
// owner can have work still buffered** — and the invariant is what lets
// anyone about to read a target's pixels get them by flushing one context
// (`flushDevice`) rather than by knowing which one drew them. Without it a
// held surface context's whole frame could sit in a vertex buffer while the
// `drawImage` that should show it sampled the texture behind it (#578).
//
// One record per `gl`, keyed weakly: a GPU that goes away takes its record
// with it.
const devices = new WeakMap();

/** Whether this `gl` can key the table — a context may be built without one. */
const shared = (gl) =>
  gl !== null && (typeof gl === 'object' || typeof gl === 'function');

/**
 * The record for a device. `owner` is the context whose state is installed,
 * or null when something outside this bookkeeping — foreign GL in a
 * `<glarea>`, a framebuffer blit — has had its way with it.
 *
 * A context built with no GL behind it — `new WaylandContext2D(null)`, the
 * seams above the first draw that `test/wayland/pure.test.js` and
 * `glyph-runs.test.js` exercise — shares nothing, and gets a record of its
 * own rather than an error.
 *
 * @param {object} gl the GLES entry points
 * @returns {{ owner: object|null }}
 */
export function glDevice(gl) {
  if (!shared(gl)) return { owner: null };
  let device = devices.get(gl);
  if (!device) devices.set(gl, (device = { owner: null }));
  return device;
}

/**
 * Say that the state no longer belongs to whoever last claimed it, so the
 * next context to draw re-establishes its own. Call after touching GL
 * behind the contexts' backs.
 */
export function releaseDevice(gl) {
  const device = shared(gl) ? devices.get(gl) : null;
  if (device) device.owner = null;
}

/**
 * Draw what is still buffered, so that a target's texture holds everything
 * that has been drawn into it.
 *
 * The owner is the only context that can be holding anything (see above), so
 * flushing it is flushing the device. Call before *reading* a target's pixels
 * behind the contexts' backs — a framebuffer blit, a scroll copy — the way
 * `releaseDevice` is called after writing them.
 */
export function flushDevice(gl) {
  const device = shared(gl) ? devices.get(gl) : null;
  device?.owner?.flush();
}
