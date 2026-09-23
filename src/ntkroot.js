// ntk's package root — the X11 client, ntk's windows and their contexts, the
// GL rungs, fontconfig and the rest of what the X11 backend draws with —
// loaded where an X connection is made rather than wherever react-x11 is
// imported.
//
// Only that backend needs it. The Cocoa, Windows and Wayland backends use a
// colour parser, the shadow arithmetic, the image and SVG decoders and the
// font parser of ntk's, each from a subpath of its own (`ntk/color`,
// `ntk/shadow-math`, `ntk/image`, `ntk/svg`, `ntk/font`, …), and importing
// the root for them was ~210 ms of module loading on Windows before the first
// window of an app that never opens an X connection.
//
// `createRoot` loads it on the X11 path, before the connection, and for an
// ntk app it is handed rather than makes — an app that could only have come
// from ntk's own `createClient`, so the import is already done and this is a
// lookup. `react-x11/ntk` hands over the root it imports. After that, the
// code that only ever runs against an X connection reads it synchronously.
let root = null;
let loading = null;

/** Load ntk's root, once; resolves to the module. */
export function loadNtk() {
  return (loading ??= import('ntk').then((mod) => (root = mod)));
}

/** A root imported some other way (`react-x11/ntk`): the same module, so
 *  nothing is loaded twice by taking it. */
export function adoptNtk(mod) {
  root ??= mod;
  loading ??= Promise.resolve(mod);
}

/** ntk's root, or null while no X connection has been made. */
export function ntkRoot() {
  return root;
}

/**
 * ntk's root, for code that only runs against an X connection — which
 * `createRoot` has loaded it for. Throws where it is not: reaching for an X
 * resource on a backend that has none is the mistake, and this says so
 * rather than failing inside ntk on an app that is not its own.
 */
export function x11Ntk(what) {
  if (root) return root;
  throw new Error(
    `react-x11: ${what} needs an X connection, and this process has none ` +
      '(ntk loads with the X11 backend, in createRoot).',
  );
}
