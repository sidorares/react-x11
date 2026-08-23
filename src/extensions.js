// Asking the server for an extension, once per connection.
//
// `X.require` caches the extension object only once its reply lands, so two
// callers in the same tick both put a QueryExtension on the wire and one of
// the answers is thrown away. That did not matter while each extension had a
// single caller that awaited it in turn. It does now: the startup probes run
// concurrently, and both the compositing watch and the XSETTINGS watch want
// XFixes at the same moment.
//
// So the promise is memoized, not the result — a second caller arriving
// while the first is still in flight subscribes to it instead of asking
// again. Keyed per connection, and null (an extension the server does not
// have) is cached like any other answer: it is a real reply, and re-asking
// would put the same question back on the wire every time.
const tables = new WeakMap();

/**
 * The extension object for `name` on this connection, or null when the
 * server does not have it (or the connection cannot answer).
 *
 * @param {object} app the ntk App
 * @param {string} name node-x11's extension name, e.g. 'fixes'
 * @returns {Promise<object|null>}
 */
export function requireExtension(app, name) {
  const X = app?.X;
  if (!X || typeof X.require !== 'function') return Promise.resolve(null);
  let table = tables.get(X);
  if (!table) {
    table = new Map();
    tables.set(X, table);
  }
  let pending = table.get(name);
  if (!pending) {
    pending = new Promise((resolve) => {
      try {
        X.require(name, (err, ext) => resolve(err || !ext ? null : ext));
      } catch {
        resolve(null);
      }
    });
    table.set(name, pending);
  }
  return pending;
}
