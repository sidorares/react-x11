// Stand-in for `ntk/xv`, aliased only while the ntk in node_modules predates
// it. `src/xvideo.js` imports it *dynamically*, the first time a sink or a
// `<video>` is made on X11, and treats a failed import as "no Xv here" — but
// esbuild follows a dynamic import all the same, and with no such subpath in
// ntk's exports map the specifier falls through to the `ntk` alias and is
// read as '<…>/lib/index.js/xv', which fails the build.
//
// Throwing from the module body is what `await import('ntk/xv')` does on an
// ntk without it, so the playground takes the path every such install takes:
// no port, and every frame converted in JavaScript. A browser's in-page X
// server has no image adaptor to offer anyway.
throw new Error(
  'react-x11 playground: this ntk has no ntk/xv, so XVideo is not bundled — ' +
    'every <video> frame is converted in JavaScript, as on any server ' +
    'without an image adaptor.',
);
