// Browser stub for node's `module`. react-x11 uses createRequire() in two
// places: to read its own package.json for the version string, and inside
// the DevTools bridge (which is replaced by a stub in this bundle). Only
// the first is reachable here, so answer it and fail loudly otherwise.
'use strict';

const pkg = require('../../../package.json');

function createRequire() {
  return function browserRequire(id) {
    if (/package\.json$/.test(id)) return pkg;
    throw new Error(
      `require(${JSON.stringify(id)}) is not available in the browser`,
    );
  };
}

module.exports = { createRequire, default: { createRequire } };
