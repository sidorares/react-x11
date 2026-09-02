// Browser stub for node's `zlib`. One caller: react-x11's Cocoa font
// manager uses `inflateSync` to unwrap a `.woff` (zlib-compressed per table)
// into sfnt bytes CoreText can read. That path exists only on the macOS
// backend, which a browser never selects — but esbuild follows the dynamic
// import of the cocoa backend and bundles it, so the specifier has to
// resolve. Callable and throwing rather than silently empty: there is no
// Core Animation in a web page, so this is never actually reached, and a
// throw is the honest answer if it somehow were.
const nope = () => {
  throw new Error(
    'react-x11 playground: node:zlib is used only by the macOS backend ' +
      '(woff decoding) and has no browser implementation.',
  );
};

module.exports = {
  inflateSync: nope,
};
