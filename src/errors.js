// Where a throw from user code goes when React is not on the stack.
//
// An event handler runs from an X event, not from a render, so no error
// boundary can catch it — a boundary only sees throws React itself invoked.
// Left bare, the throw unwinds out of the dispatcher into ntk's socket
// `data` handler and takes the process with it, or wedges the frame loop,
// which is worse: it looks like a hang rather than a crash.

// container -> the root's onUncaughtError, when it set one
const perContainer = new WeakMap();

export function setErrorHandler(container, fn) {
  if (fn) perContainer.set(container, fn);
  else perContainer.delete(container);
}

/** The component that rendered this node, which is the name worth printing
 * — `<box>` alone never tells anyone whose box it was. */
export function ownerName(node) {
  const type = node?._reactFiber?._debugOwner?.type;
  if (!type) return null;
  return type.displayName || type.name || '(anonymous)';
}

/** A GUI process whose tree threw must not exit 0 — that lies to CI and to
 * a supervisor. Guarded because the playground bundle runs in a browser. */
function markFailed() {
  if (typeof process !== 'undefined' && process) process.exitCode = 1;
}

/**
 * Report a throw from a user callback, then carry on.
 *
 * Carrying on is the point: one bad tooltip handler must not stop the rest
 * of the dispatch or the frame loop. The default still refuses to swallow —
 * it logs what threw and where, and sets `process.exitCode`. A root that
 * passed `onUncaughtError` decides for itself, because for a kiosk "crash
 * loudly" is the right answer and for a text editor it is not.
 */
export function reportHandlerError(node, handler, error) {
  const element = node?.kind ? `<${node.kind}>` : '(unknown)';
  const owner = ownerName(node);
  const custom = node?.app && perContainer.get(node.app);
  if (custom) {
    custom(error, {
      componentStack: owner ? `\n    in ${owner}` : undefined,
      element,
      handler,
      node,
    });
    return;
  }
  console.error(
    `react-x11: ${handler} on ${element}${owner ? ` in ${owner}` : ''} threw. ` +
      'It ran from an X event rather than a render, so no error boundary ' +
      'could catch it; dispatch continues.',
    error,
  );
  markFailed();
}

/** Wrap a call to user code so a throw is reported instead of escaping. */
export function callHandler(node, handler, fn, ev) {
  try {
    fn(ev);
  } catch (error) {
    reportHandlerError(node, handler, error);
  }
}

/**
 * The root error callbacks React itself invokes, as `(error, errorInfo)`.
 * `errorInfo.componentStack` is the whole reason a boundary is debuggable,
 * and printing it beside the error is most of what makes these useful.
 */
export const defaultRootHandlers = {
  onUncaughtError(error, errorInfo) {
    console.error(
      'react-x11: uncaught error' + (errorInfo?.componentStack ?? ''),
      error,
    );
    markFailed();
  },
  onCaughtError(error, errorInfo) {
    // an error boundary handled this one, so the process is still healthy
    console.error(
      'react-x11: error caught by a boundary' +
        (errorInfo?.componentStack ?? ''),
      error,
    );
  },
  onRecoverableError(error, errorInfo) {
    console.error(
      'react-x11: recoverable error' + (errorInfo?.componentStack ?? ''),
      error,
    );
  },
};
