// Which GL backend a connection got, asked synchronously.
//
// ntk settles this during its connection handshake — it probes for direct
// rendering whenever `glPolicy` could select it — so by the time any element
// is created the answer is a property read rather than a round trip. That is
// what lets `<shaderMaterial>` fail at creation, with a reason, instead of
// rendering an empty surface.
//
// A leaf module on purpose: it imports nothing, so both `appcontext.js` (for
// `useSupports('shaders')`) and the node layer can use it without the two
// importing each other.

/** Is the direct backend — the one with shaders — available on `app`? */
export function hasDirectGL(app) {
  return !!app?._glCapsResolved?.direct;
}

/**
 * Why it is not, as ntk's coded error — or null when it is available, or
 * when nothing has asked yet.
 *
 * Worth surfacing rather than describing: the reasons are genuinely different
 * (no GPU addon, a connection that cannot pass descriptors, a server without
 * DRI3, a policy left at `'indirect'`) and only one of them is "turn the
 * policy on". A message that guesses sends people to check the wrong thing.
 */
export function directGLFailure(app) {
  const caps = app?._glCapsResolved;
  return caps && !caps.direct ? (caps.reason ?? null) : null;
}
