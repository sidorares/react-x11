// Browser build of the `keysym` package: the original reads its JSON tables
// with fs.readFileSync(__dirname + ...) at module load, which cannot work in
// a bundle. Same API, but the tables are imported so esbuild inlines them.
'use strict';

// resolved relative to this file (website/scripts/browser-shims/) — a bare
// 'keysym/data/…' import would loop through the very alias that points here
const data = require('../../../node_modules/keysym/data/keysyms.json');
const events = require('../../../node_modules/keysym/data/events.json');

exports.records = data.records;

exports.fromKeysym = function (keysym) {
  return data.records[data.keysyms[keysym]];
};

exports.fromUnicode = function (code) {
  if (typeof code === 'string') {
    if (code.length !== 1) {
      throw new Error('String must be 1 character');
    }
    return exports.fromUnicode(code.charCodeAt(0));
  }
  return (data.unicodes[code] || []).map(function (i) {
    return data.records[i];
  });
};

const a = 'a'.charCodeAt(0);
const A = 'A'.charCodeAt(0),
  Z = 'Z'.charCodeAt(0);

function lookup(e) {
  return e.length === 1
    ? exports.fromUnicode(e)[0].keysym
    : exports.fromName(e).keysym;
}

exports.keyEvent = function (code, shiftMask) {
  if (A <= code && code <= Z) {
    return code + (shiftMask ? 0 : a - A);
  } else if (events.both[code]) {
    return lookup(events.both[code]);
  } else if (shiftMask && events.shifted[code]) {
    return lookup(events.shifted[code]);
  } else if (!shiftMask && events.unshifted[code]) {
    return lookup(events.unshifted[code]);
  } else {
    const c = exports.fromUnicode(code)[0];
    return (c && c.keysym) || code;
  }
};

exports.fromName = function (name) {
  return data.records[data.names[name]];
};
