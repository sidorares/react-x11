// The pane process, from hello to exit. `src/frame/child.js` is the file
// the parent actually forks; everything it does beyond `process.send`
// plumbing is here, behind an injectable transport — so the tests run a
// real pane (module, root, window, props, callbacks, close handlers) in
// process, over a loopback pair, against the in-process X server. The fork
// boundary itself is the only thing this seam cannot cover, and the only
// thing the forked entry adds.
//
// Order matters three times in this file:
//
//  - The **update listener goes up before the module import starts.** The
//    import is the slow part of booting a pane, the parent sends updates
//    whenever its commits produce them, and a listener scoped to the
//    mounted tree would drop everything that arrived in between. So the
//    listener is a store the tree subscribes to later: the last update
//    always wins, however early it came.
//
//  - The module is imported **before** the root is created. A `src` that
//    does not resolve is the commonest way a frame fails, and failing it
//    should not cost an X connection — or worse, report a connection error
//    when the truth is a typo in a path.
//
//  - `ready` is sent only once the pane's window has an id, which is after
//    the commit that realizes it. The parent embeds on `ready`; an id sent
//    early would have the embedder reparenting a window that does not
//    exist.
//
// The window is `<window embeddable>`: created unmapped, because a window
// waiting to be embedded is unmapped — that is what waiting looks like —
// and the embedder maps it once it is reparented (ntk's XEmbedSocket).

import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { createRoot } from '../index.js';
import { windowIdOf } from '../windowid.js';
import { registeredFrameContext } from './env.js';
import { markFramed, runCloseHandlers } from './lifecycle.js';
import { PROTOCOL, reviveCallbacks } from './protocol.js';

const h = React.createElement;

/**
 * @typedef {object} ChildTransport The child's end of the wire.
 * @property {(msg: object) => void} send
 * @property {(cb: (msg: object) => void) => () => void} onMessage
 * @property {(cb: () => void) => () => void} onDisconnect the parent's end
 *   closed — there is nobody left to talk to
 */

/** Recreate the bridged providers around the pane's window, outermost
 * first — the parent's own nesting order, which the env Map records and
 * structured clone preserves. A key the pane never registered wraps
 * nothing: no module in this process reads it. Providers registered
 * `innermost` (the theme) wrap directly around the window, inside the
 * rest — see registerFrameProvider (src/frame/env.js) for why the
 * adjacency matters. */
function wrapEnv(env, inner) {
  const wrap = (tree, [key, value]) => {
    const registered = registeredFrameContext(key);
    if (!registered) return tree;
    return registered.render
      ? registered.render(value, tree)
      : h(
          registered.Context.Provider,
          { value: registered.revive ? registered.revive(value) : value },
          tree,
        );
  };
  const entries = [...env];
  const isInnermost = ([key]) =>
    registeredFrameContext(key)?.innermost === true;
  let tree = inner;
  for (const entry of entries.filter(isInnermost).reverse()) {
    tree = wrap(tree, entry);
  }
  for (const entry of entries.filter((e) => !isInnermost(e)).reverse()) {
    tree = wrap(tree, entry);
  }
  return tree;
}

function Bridge({ Component, store, rect, invoke, onReady }) {
  const wire = useSyncExternalStore(
    (cb) => {
      store.listeners.add(cb);
      return () => store.listeners.delete(cb);
    },
    () => store.value,
  );
  const snapshot = useMemo(
    () => ({
      props: reviveCallbacks(wire.props ?? {}, invoke),
      env: new Map(wire.env ?? []),
    }),
    [wire, invoke],
  );
  const ref = useRef(null);

  // The window realizes in the commit this effect follows — but `ready`
  // must carry its id, so a beat where the ref is still empty retries on a
  // fresh task rather than reporting a pane with no window.
  useEffect(() => {
    let cancelled = false;
    const report = (tries) => {
      if (cancelled) return;
      const windowId = windowIdOf(ref);
      if (windowId) onReady(windowId);
      else if (tries > 0) setTimeout(() => report(tries - 1), 10);
      else onReady(null);
    };
    report(200);
    return () => {
      cancelled = true;
    };
  }, [onReady]);

  // The bridged providers wrap the *window*, not the pane component — the
  // same position they held in the host. ThemeProvider plants the palette
  // on a window it finds among its children (theme.js, `planted`), and the
  // window is where it has to land: the window's own background follows the
  // palette, and it is the top of the node tree every `$token` beneath
  // resolves through. Mounted inside the window, the palette reached a box
  // and the window kept resolving against the pane process's own desktop —
  // a dark-desktop pane in a light-themed app, wrong in both directions.
  return wrapEnv(
    snapshot.env,
    h(
      'window',
      {
        ref,
        embeddable: true,
        width: Math.max(1, rect?.width ?? 400),
        height: Math.max(1, rect?.height ?? 300),
      },
      h(Component, snapshot.props),
    ),
  );
}

/**
 * Run the pane: handshake, load `src`, mount its default export, follow
 * updates, and exit when told to (or when the parent goes away).
 *
 * `exit` and `rootOptions` are the test seams: a test passes a loopback
 * transport, a borrowed in-process connection (`rootOptions.app`) and an
 * `exit` that resolves instead of killing the runner.
 */
export async function runFrameChild(transport, options = {}) {
  const {
    exit = (code) => process.exit(code),
    rootOptions,
    // The pane process's last resort: an async throw nothing else caught is
    // reported before the exit it forces. Off in the in-process tests,
    // where "the process" is the test runner and trapping its errors would
    // convert a failing test into a politely-reported pane crash.
    trapProcessErrors = true,
  } = options;

  const fatal = (phase, err) => {
    try {
      transport.send({
        type: 'fatal',
        phase,
        message: err?.message ?? String(err),
        stack: err?.stack,
      });
    } catch {
      // the channel is gone; the exit code still says what happened
    }
    console.error(`react-x11 frame pane (${phase}):`, err);
    exit(1);
  };

  if (trapProcessErrors) {
    process.on('uncaughtException', (err) => fatal('runtime', err));
    process.on('unhandledRejection', (err) => fatal('runtime', err));
  }
  markFramed();

  const hello = await new Promise((resolve) => {
    const off = transport.onMessage((msg) => {
      if (msg?.type !== 'hello') return;
      off();
      resolve(msg);
    });
  });
  if (hello.protocol !== PROTOCOL) {
    return fatal(
      'handshake',
      new Error(
        `frame protocol ${hello.protocol} from the host, ${PROTOCOL} here — ` +
          'host and pane are running different react-x11 versions',
      ),
    );
  }

  // From here every update is kept, mounted tree or not: last one wins.
  const store = {
    value: { props: hello.props ?? {}, env: hello.env ?? [] },
    listeners: new Set(),
  };
  transport.onMessage((msg) => {
    if (msg?.type !== 'update') return;
    store.value = { props: msg.props ?? {}, env: msg.env ?? [] };
    for (const listener of [...store.listeners]) listener();
  });

  let Component;
  try {
    const url = isAbsolute(hello.src)
      ? pathToFileURL(hello.src).href
      : hello.src;
    const mod = await import(url);
    Component = mod.default;
    if (typeof Component !== 'function' && typeof Component !== 'object') {
      throw new Error(`${hello.src} has no default export to mount`);
    }
  } catch (err) {
    return fatal('load', err);
  }

  let root;
  try {
    root = await createRoot({
      ...(hello.display ? { display: hello.display } : {}),
      ...rootOptions,
      onUncaughtError: (err) => fatal('runtime', err),
    });
  } catch (err) {
    return fatal('connect', err);
  }

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await runCloseHandlers();
      await root.unmount();
    } catch {
      // exiting is the point; nothing downstream of it to protect
    }
    exit(0);
  };

  transport.onMessage((msg) => {
    if (msg?.type === 'unmount') close();
  });
  transport.onDisconnect(close);

  root.render(
    h(Bridge, {
      Component,
      store,
      rect: hello.rect,
      invoke: (id, args) => {
        try {
          transport.send({ type: 'invoke', id, args });
        } catch {
          // the host is going away; its shutdown handles the rest
        }
      },
      onReady: (windowId) => {
        if (windowId) transport.send({ type: 'ready', windowId });
        else fatal('runtime', new Error('the pane window never realized'));
      },
    }),
  );

  return { root, close };
}
