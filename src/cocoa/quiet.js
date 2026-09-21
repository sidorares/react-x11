// Layer changes with Core Animation's implicit actions off, for a layer
// that is ours rather than a presenter's (a <glarea>'s surface and overlay,
// a frame pane's host): no frame's transaction covers it, so a bare
// `addSublayer` or `removeFromSuperlayer` takes the default quarter-second
// order-in or order-out fade, and a bare property set tweens.
export function withoutActions(native, fn) {
  native.txBegin({ disableActions: true });
  try {
    return fn();
  } finally {
    native.txCommit();
  }
}
