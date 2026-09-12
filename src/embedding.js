// Whether a connection can take another process's window into its own.
//
// `<foreign>` asks before it builds a socket, and `useSupports('embedding')`
// asks for a component deciding whether to render one. One function for
// both, because the two have to agree: a hook that said yes over an element
// that then refused, or the reverse, is the bug this closes (issue #531).
//
// A feature test on the connection, not a question about which backend this
// is — and not "is there an `X`", which is true everywhere: the Cocoa app
// carries an X stub for the modules with an X escape hatch, and the headless
// mock carries the same one. Both also have a `createWindow` that takes a
// parent, which is how `<foreign>` used to get as far as a socket over them.
// So each part of embedding is asked about by name: a container window to
// hold the client, `ReparentWindow` to move somebody else's window into it,
// and the save set, which keeps that window alive if this process dies
// holding it — the promise docs/embedding.md makes about a window we do not
// own.
//
// A leaf module on purpose, for glbackend.js's reason: it imports nothing of
// ours, so both `appcontext.js` and the node layer can use it without the
// two importing each other.

/** Can `app` host another client's window inside one of its own? */
export function canEmbed(app) {
  const X = app?.X;
  return (
    typeof app?.createWindow === 'function' &&
    typeof X?.ReparentWindow === 'function' &&
    typeof X?.ChangeSaveSet === 'function'
  );
}
