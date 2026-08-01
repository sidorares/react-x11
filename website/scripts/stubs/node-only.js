// Stand-in for the two react-x11 modules that only make sense on a real
// desktop: the React DevTools bridge (a websocket to a running
// `react-devtools`) and click-to-component (spawns your editor). Both are
// dynamically imported by Reconciler.js behind environment variables the
// playground never sets, but bundling them would drag `ws` and
// `node:child_process` in — so the build redirects both here.
//
// The named exports mirror what Reconciler.js awaits from each module.
export async function prepare() {}
export function connect() {}
export function attachHighlightAgent() {}
export function install() {}
// debug.js (the REACT_X11_TRACE tracer — writes files, so node-only)
export function startTrace() {
  return { stats: {}, stop: () => ({}) };
}
export function startEnvTrace() {
  return null;
}
export default {};
