// Which windows owe a frame.
//
// Shared between the paint root (nodes.js — it records the debt in
// `invalidate()` and pays it in `flush()`) and the event dispatcher
// (events.js — it pays early, for discrete input). Its own module because
// nodes.js already imports events.js, and the dispatcher cannot import the
// node back without a cycle.
//
// The set answers "which windows have unpainted damage" in O(1) at event
// time. A tree walk would answer it too, but it is walked once per discrete
// event on a tree that can be thousands of nodes, to find the one or two
// roots that a `Set.add` in `invalidate()` already knew about.

const pending = new Set();

/** `node` has damage and no paint yet. Idempotent. */
export function addPendingFrame(node) {
  pending.add(node);
}

/** `node` is painting (or has nothing left to paint). */
export function clearPendingFrame(node) {
  pending.delete(node);
}

/**
 * Paint every window that owes a frame and whose server is caught up — the
 * synchronous half of the frame clock (issue #141).
 *
 * A discrete input has exactly one visual response: a button darkens, a
 * caret lands, focus moves. Scheduling that response through
 * `requestAnimationFrame` charges it up to a frame interval plus a fence
 * round trip before it reaches the wire, on top of a paint that measures in
 * the hundreds of microseconds. So the dispatcher calls this when the
 * handler unwinds, and the pixels go out with the handler's own requests
 * instead.
 *
 * Two things make that safe to do unconditionally at the call site:
 *
 *  - **The frame gate.** A window whose last frame has not landed keeps the
 *    frame it already scheduled. Painting it now would be work nobody sees:
 *    ntk defers the present until the frame ends, where it coalesces with
 *    the one already pending. This is what keeps a burst sane — spin a wheel
 *    and the first notch paints immediately, the rest fold into one catch-up
 *    frame. "Update instantly, then catch up", with the frame clock as the
 *    backpressure.
 *
 *    On ntk >= 7 what ends a frame is the display: the server reports the
 *    present it executed at a vertical blank, so the gate now means "the
 *    display has not shown the last frame" rather than "the socket has not
 *    acknowledged it". Same call, later and truer signal — and it is also
 *    what keeps us off a backing pixmap the server is still copying from.
 *  - **Every window answers for itself.** The set is app-wide, so a click
 *    that dirtied both a menu and the window under it paints both, each
 *    gated on its own window's frame clock.
 *
 * A window whose scheduled frame this pays off keeps that scheduled
 * callback; it runs and finds `needsPaint` false, which is already a cheap
 * no-op.
 */
export function flushPendingFrames() {
  if (pending.size === 0) return;
  for (const node of [...pending]) {
    const wnd = node.window;
    // ntk < 5.2.0 (sidorares/ntk#148) cannot say whether the frame has
    // landed, and a missing answer is not a "no" — without the gate a burst
    // would paint every event, so the paced frame stays the safe choice.
    // Same for a headless mock window that models no frame clock at all.
    if (typeof wnd?.frameInFlight !== 'function') continue;
    if (wnd.frameInFlight()) continue;
    node.flush();
  }
}
