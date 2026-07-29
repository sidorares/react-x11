// Browser stub for node's `path` (posix-only, just what the bundled code
// touches on its browser-reachable paths).
module.exports = {
  join: (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/'),
  resolve: (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/'),
  dirname: (p) => p.replace(/\/[^/]*$/, '') || '/',
  basename: (p) => p.replace(/^.*\//, ''),
  extname: (p) => (/\.[^./]*$/.exec(p) || [''])[0],
  sep: '/',
};
