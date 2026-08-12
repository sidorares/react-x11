// ClientMessage, delivered to the element it was addressed to.
//
// ClientMessage is the carrier of every convention layered over the core
// protocol: EWMH's requests to the window manager, ICCCM's WM_PROTOCOLS,
// XEmbed, XDND, the system tray, and whatever two copies of one application
// agree between themselves. react-x11 speaks a few of those itself — XDND in
// `src/dnd.js`, WM_DELETE_WINDOW through ntk's `close` — and an application
// that speaks one core does not had exactly one route: subscribe to
// `X.on('event')`, which is every event on the connection for every window,
// and filter. `src/xsettings.js` does that internally and it is the right
// shape *there*, because a settings daemon's window is nobody's element. It
// is the wrong shape to hand an application: it is not scoped to a window,
// it does not go away when the window unmounts, and it is expressed in atom
// ids rather than names.
//
// So `<window onClientMessage>` is the seam, and this is what fills it.
//
// ## The type is a name, and that costs a round trip once
//
// `message_type` is an atom, and an atom is a number that means nothing away
// from the server that issued it. Comparing against one means interning it
// first, which is asynchronous, so the obvious handler cannot be written as a
// `switch` — it has to wait for an atom table to arrive before it can tell
// one message from another, and that table is the boilerplate this seam
// exists to delete.
//
// Most of the time the name is already there: node-x11 keeps a per-connection
// id → name table filled from every InternAtom and GetAtomName reply, so an
// atom this application has ever *named* — which is every atom in a protocol
// it sends, advertises or owns anything for — resolves synchronously and the
// message is dispatched in the turn it arrived in.
//
// A protocol this application only ever *receives* has no such moment, and
// that case is the whole point of the feature: a tray host does not send
// `_NET_SYSTEM_TRAY_OPCODE`, it is sent one. So an unknown atom is resolved
// with `GetAtomName` — and **every message behind it waits**, which is the
// part that is not optional. The protocols carried this way are chunked
// (`_NET_SYSTEM_TRAY_BEGIN_MESSAGE` and the `_NET_SYSTEM_TRAY_MESSAGE_DATA`
// pieces that reassemble by arrival order alone) or sequenced (XEmbed), so a
// round trip that let a later message overtake an earlier one would corrupt
// them in a way no handler could detect. The same FIFO gate `src/dnd.js`
// runs its own messages through, for the same reason.
//
// The cost is one round trip per message *type* per connection — node-x11
// caches the reply, so the second `_NET_SYSTEM_TRAY_OPCODE` is synchronous
// like everything else. `messageType` is therefore null only for an atom the
// server itself does not know, which is a broken sender rather than a case to
// design around; `atom` carries the id regardless.

/** X's event code for ClientMessage, for `ev.type`. */
const CLIENT_MESSAGE = 33;

/** Per-connection id → name lookups in flight or resolved, negatives kept:
 * a sender repeating a bogus atom must not repeat the round trip. */
const nameCaches = new WeakMap();

/** The name of an atom, or a promise for it. Never rejects. */
function atomName(X, id) {
  const known = X?.atom_names?.[id];
  if (known !== undefined) return known;
  if (typeof X?.GetAtomName !== 'function') return null;
  let cache = nameCaches.get(X);
  if (!cache) nameCaches.set(X, (cache = new Map()));
  const hit = cache.get(id);
  if (hit) return hit;
  const pending = new Promise((resolve) =>
    X.GetAtomName(id, (err, name) => resolve(err ? null : name)),
  );
  cache.set(id, pending);
  return pending;
}

/**
 * The stream of ClientMessages for one window: names each message's type and
 * hands it to `dispatch` in arrival order.
 *
 * `dispatch` is the caller's, so the priority and the paint stay with the
 * other window events in nodes.js; what lives here is the naming and the
 * ordering it has to preserve.
 */
export function createClientMessages(node, dispatch) {
  let queued = 0;
  let chain = Promise.resolve();

  /**
   * The event a handler receives. Not a `SyntheticEvent`: a ClientMessage is
   * addressed to a *window*, so there is no node under it, nothing to hit
   * test and no chain to bubble along. Same shape `onResize` has, for the
   * same reason.
   */
  const build = (raw, messageType) => ({
    type: CLIENT_MESSAGE,
    messageType,
    atom: raw.message_type,
    format: raw.format,
    data: raw.data,
    window: node.window,
    target: node.window,
    nativeEvent: raw,
    get defaultPrevented() {
      return raw.defaultPrevented === true;
    },
    preventDefault() {
      // Marked on the raw event, because what reads it is a second
      // subscriber to the same ntk stream (`WindowNode._initDnd`) rather
      // than a later step of this dispatch.
      raw.defaultPrevented = true;
    },
  });

  return {
    /** Take one raw ntk `'message'` event. */
    handle(raw) {
      const name = atomName(node.app?.X, raw.message_type);
      const settled = name === null || typeof name === 'string';
      if (queued === 0 && settled) {
        dispatch(build(raw, name));
        return;
      }
      queued++;
      chain = chain
        .then(() => name)
        .then((resolved) => dispatch(build(raw, resolved)))
        .catch(() => {}) // a handler throw is already reported by callHandler
        .then(() => {
          queued--;
        });
    },

    /**
     * `null` when every message so far has been dispatched, so a default
     * action can run in the same turn its message arrived in; otherwise the
     * promise after which it has been — which is what lets `preventDefault()`
     * still reach XDND on the one message whose type had to be named first.
     */
    pending() {
      return queued === 0 ? null : chain;
    },
  };
}
