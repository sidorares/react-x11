// A `<Frame>` transport that runs the pane in this process — the seam the
// component was given for exactly this (docs/frame.md). The pane is real:
// `runFrameChild`, a real module import, a real root on a second connection
// to the in-process X server. Only the process boundary is simulated, and
// its one observable property — values cross by copy — is kept honest by
// `structuredClone` on every message, so a props bag that would not survive
// the fork's serialization does not survive this either.

import { runFrameChild } from '../../src/frame/childmain.js';

/**
 * A transport factory to pass as `<Frame transport>`. Each spawn runs
 * `runFrameChild` against `childApp` (a borrowed connection) and appears in
 * `factory.sessions` with its `done` promise, recorded kills, and exit code.
 */
export function loopbackFrameFactory({ childApp }) {
  const sessions = [];
  const factory = ({ src, display }) => {
    const parentInbox = { queue: [], handlers: new Set() };
    const childInbox = { queue: [], handlers: new Set() };
    const exitListeners = new Set();
    const disconnectListeners = new Set();

    const deliver = (inbox, msg) => {
      const wire = structuredClone(msg);
      queueMicrotask(() => {
        if (inbox.handlers.size === 0) inbox.queue.push(wire);
        else for (const cb of [...inbox.handlers]) cb(wire);
      });
    };
    const attach = (inbox, cb) => {
      inbox.handlers.add(cb);
      if (inbox.queue.length) {
        const drained = inbox.queue.splice(0);
        queueMicrotask(() => {
          for (const msg of drained) {
            for (const handler of [...inbox.handlers]) handler(msg);
          }
        });
      }
      return () => inbox.handlers.delete(cb);
    };

    const session = {
      src,
      display,
      exitCode: null,
      exitSignal: null,
      kills: [],
    };
    let settle;
    session.done = new Promise((resolve) => {
      settle = (code, signal) => {
        if (session.exitCode !== null || session.exitSignal !== null) return;
        session.exitCode = code;
        session.exitSignal = signal ?? null;
        resolve({ code, signal: signal ?? null });
        queueMicrotask(() => {
          for (const cb of [...exitListeners]) {
            cb({ code, signal: signal ?? null });
          }
        });
      };
    });

    session.child = runFrameChild(
      {
        send: (msg) => deliver(parentInbox, msg),
        onMessage: (cb) => attach(childInbox, cb),
        onDisconnect: (cb) => {
          disconnectListeners.add(cb);
          return () => disconnectListeners.delete(cb);
        },
      },
      {
        exit: (code) => settle(code, null),
        rootOptions: { app: childApp },
        trapProcessErrors: false,
      },
    );
    session.child.catch(() => {});

    session.transport = {
      send: (msg) => deliver(childInbox, msg),
      onMessage: (cb) => attach(parentInbox, cb),
      onExit: (cb) => {
        exitListeners.add(cb);
        return () => exitListeners.delete(cb);
      },
      kill: (signal) => {
        session.kills.push(signal);
        if (signal === 'SIGKILL') settle(null, 'SIGKILL');
      },
      pid: 4242,
    };
    sessions.push(session);
    return session.transport;
  };
  factory.sessions = sessions;
  return factory;
}
