// Factory for inert module stubs: heavy optional dependencies (pngjs, …)
// are aliased to modules built from this so the playground
// bundle stays small. Importing the stub is free; *using* it throws with a
// clear message. The proxy answers the interop probes esbuild's ESM<->CJS
// helpers make (`__esModule`, `default`, symbols) without throwing.
'use strict';

module.exports = function unavailable(name) {
  const fail = (what) => {
    throw new Error(
      `${name} is not bundled in the playground (${what} was used); ` +
        'run this demo in node against a real X server instead',
    );
  };
  const handler = {
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === '__esModule') return true;
      if (prop === 'default') return proxy;
      if (prop === 'then') return undefined; // not a thenable
      return new Proxy(
        function stub() {
          fail(`${name}.${prop}()`);
        },
        {
          get: (t, p) => {
            if (typeof p === 'symbol' || p === 'then') return undefined;
            fail(`${name}.${prop}.${String(p)}`);
          },
          apply: () => fail(`${name}.${prop}()`),
          construct: () => fail(`new ${name}.${prop}()`),
        },
      );
    },
    apply: () => fail(`${name}()`),
    construct: () => fail(`new ${name}()`),
  };
  const proxy = new Proxy(function stubModule() {}, handler);
  return proxy;
};
