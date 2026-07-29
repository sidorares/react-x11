// Browser stub for node's `util` — just the handful of helpers reached by
// bundled dependencies (lru-cache v4 via canvas-fontstyle uses inherits and
// inspect-ish debugging).
'use strict';

function inherits(ctor, superCtor) {
  if (superCtor) {
    ctor.super_ = superCtor;
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  }
}

function format(f, ...args) {
  if (typeof f !== 'string') return [f, ...args].map(String).join(' ');
  let i = 0;
  const str = f.replace(/%[sdjifoO%]/g, (m) => {
    if (m === '%%') return '%';
    if (i >= args.length) return m;
    const a = args[i++];
    switch (m) {
      case '%s':
        return String(a);
      case '%d':
      case '%i':
      case '%f':
        return String(Number(a));
      case '%j':
        try {
          return JSON.stringify(a);
        } catch {
          return '[Circular]';
        }
      default:
        return String(a);
    }
  });
  return args.slice(i).reduce((acc, a) => `${acc} ${String(a)}`, str);
}

module.exports = {
  inherits,
  format,
  inspect: (obj) => {
    try {
      return JSON.stringify(obj);
    } catch {
      return String(obj);
    }
  },
  deprecate: (fn) => fn,
  debuglog: () => () => {},
  promisify:
    (fn) =>
    (...args) =>
      new Promise((resolve, reject) =>
        fn(...args, (err, value) => (err ? reject(err) : resolve(value))),
      ),
  types: {
    isUint8Array: (v) => v instanceof Uint8Array,
  },
};
