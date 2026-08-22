// Which GL backend a connection got, asked synchronously.
//
// The question is about the **connection**, not the machine. ntk's
// `glCapabilities()` answers the machine one — "could direct rendering work
// here" — and consults `glPolicy` only far enough to honour `'off'`, so on a
// DRI3-capable box it resolves `{ direct: true }` under the default
// `'indirect'` policy too. What actually draws is what the policy asked for,
// so that is what this module reports: the same rule ntk's own `backendFor()`
// applies when `getContext` picks a backend, kept in step here because it is
// not part of ntk's public API (issue #357).
//
// ntk settles the probe during its connection handshake — it runs it whenever
// `glPolicy` could select direct — so by the time any element is created the
// answer is a property read rather than a round trip. That is what lets
// `<shaderMaterial>` fail at creation, with a reason, instead of rendering an
// empty surface.
//
// A leaf module on purpose: it imports nothing of ours, so both
// `appcontext.js` (for `useSupports('shaders')`) and the node layer can use
// it without the two importing each other.

import { GLError } from 'ntk';

/** Does this connection's policy ever choose the direct backend? */
const wantsDirect = (app) => {
  const mode = app?.glPolicy?.mode;
  return mode === 'auto' || mode === 'direct';
};

/** ntk's coded-error shape — `code` to branch on, `hint` for what to do. */
function glError(code, message, hint) {
  const err = new Error(message);
  err.code = code;
  if (hint) err.hint = hint;
  return err;
}

/**
 * Is the direct backend — the one with shaders — what this connection draws
 * through?
 *
 * False under a policy that never asks for it, whatever the machine could do,
 * because the policy is what decides which backend is built.
 */
export function hasDirectGL(app) {
  return wantsDirect(app) && !!app._glCapsResolved?.direct;
}

/**
 * Why it is not, as a coded error — or null when it is available, or when the
 * probe that would say has not answered yet.
 *
 * Worth surfacing rather than describing: the reasons are genuinely different
 * (a policy that never asked, no GPU addon, a connection that cannot pass
 * descriptors, a server without DRI3) and only one of them is "turn the
 * policy on". A message that guesses sends people to check the wrong thing.
 *
 * The policy reasons are minted here because ntk has none to give: its probe
 * consults the mode only for `'off'`, so a connection left on the default
 * `'indirect'` carries capabilities with no `reason` in them at all — and on
 * a capable machine, with `direct: true` in them.
 */
export function directGLFailure(app) {
  const mode = app?.glPolicy?.mode;
  if (mode === 'off') {
    return glError(
      GLError.DISABLED,
      "glPolicy is 'off' on this connection, so no GL context is created at all",
      "No <glarea> draws under this policy. Pass glPolicy: 'auto'\n" +
        'to createRoot(), or drop the option, to get a context back.',
    );
  }
  if (!wantsDirect(app)) {
    return glError(
      'GL_POLICY_INDIRECT',
      "glPolicy is 'indirect' — ntk's default — so this connection draws " +
        'through indirect GLX, which has no shaders whatever this machine could do',
      "createRoot({ glPolicy: 'auto' }) takes the direct backend where it is\n" +
        'available and this one everywhere else, and NTK_GL_POLICY=auto switches\n' +
        'a single run. app.glCapabilities() still answers what the machine can do.',
    );
  }
  const caps = app._glCapsResolved;
  return caps && !caps.direct ? (caps.reason ?? null) : null;
}

/**
 * Call `onChange` when that answer settles, and hand back the unsubscribe —
 * the subscribe half of `useSupports('shaders')`.
 *
 * It settles at most once and then holds still. Under a policy that could
 * pick direct, `createRoot()` waits for ntk's probe before it hands the app
 * back, so the first render already reads the final answer and there is
 * nothing to watch; under one that could not, the answer is false and stays
 * false. What is left is a policy raised after connecting, which has missed
 * the handshake probe — `glCapabilities()` is idempotent and cached, and is
 * the same call ntk makes lazily when a context is created, so asking it here
 * settles the answer rather than leaving one component reading false and the
 * next reading true.
 */
export function watchDirectGL(app, onChange) {
  if (!wantsDirect(app) || app._glCapsResolved) return () => {};
  if (typeof app.glCapabilities !== 'function') return () => {};
  let live = true;
  // a probe that throws is a probe that found nothing: the answer stays
  // false, and re-reading a boolean that did not move costs a comparison
  const settled = () => {
    if (live) onChange();
  };
  app.glCapabilities().then(settled, settled);
  return () => {
    live = false;
  };
}
