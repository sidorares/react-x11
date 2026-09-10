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

/**
 * A throw from a layout or a placement (docs/extending.md) — code that runs
 * inside a frame, where no error boundary is on the stack either. Reported
 * the way a handler's throw is, `onUncaughtError` included, and the frame
 * carries on with the fallback `consequence` names: one bad algorithm must
 * not stop the window from painting.
 */
export function reportLayoutError(node, what, error, consequence) {
  const element = node?.kind ? `<${node.kind}>` : '(unknown)';
  const owner = ownerName(node);
  const custom = node?.app && perContainer.get(node.app);
  if (custom) {
    custom(error, {
      componentStack: owner ? `\n    in ${owner}` : undefined,
      element,
      handler: what,
      node,
    });
    return;
  }
  console.error(
    `react-x11: ${what} on ${element}${owner ? ` in ${owner}` : ''} threw. ` +
      'It ran inside a frame rather than a render, so no error boundary ' +
      `could catch it. ${consequence}.`,
    error,
  );
  markFailed();
}

/**
 * `REACT_X11_STRICT_TOKENS=1` makes a `$token` the theme does not define
 * fatal again, for a build that would rather stop than paint something
 * wrong. The default reports and carries on — see `reportStyleError`.
 *
 * Guarded rather than a bare `process.env` because the playground bundle
 * runs in a browser, where there is no `process` at all.
 */
export const STRICT_TOKENS =
  (typeof process === 'undefined'
    ? undefined
    : process.env?.REACT_X11_STRICT_TOKENS) === '1';

/** Messages already printed, so a shared misspelled style reports once per
 *  (node, message) rather than once per restyle — a theme swap re-resolves
 *  the whole subtree and would otherwise print the same line every time. */
const reportedStyleErrors = new WeakMap();

/**
 * A style the node cannot resolve — today only an unknown `$token`.
 *
 * Not a throw, and deliberately: the mistake is one property in one style,
 * and the tree it would take down is the whole GUI. The property is dropped
 * (so the widget paints without it, visibly wrong), the message names the
 * token and whose element wore it, and `process.exitCode` is set so a test
 * run or a supervisor still counts this as a failure. `REACT_X11_STRICT_TOKENS=1`
 * restores the throw.
 */
export function reportStyleError(
  node,
  message,
  consequence = 'The property is dropped and the app carries on',
) {
  const seen = reportedStyleErrors.get(node);
  if (seen?.has(message)) return;
  if (seen) seen.add(message);
  else reportedStyleErrors.set(node, new Set([message]));
  const owner = ownerName(node);
  console.error(
    `${message}${owner ? ` — in ${owner}` : ''}. ${consequence}; set ` +
      'REACT_X11_STRICT_TOKENS=1 to make this throw instead.',
  );
  markFailed();
}

/**
 * A style that asks for something that is not there — a layout or a
 * placement nobody registered, an option of the wrong type. Reported and
 * carried on from, once per node and message, the way an unknown token is;
 * with no strict switch, because the fallback it names is a real one and
 * not a property silently dropped.
 */
export function reportStyleProblem(node, message, consequence) {
  const seen = reportedStyleErrors.get(node);
  if (seen?.has(message)) return;
  if (seen) seen.add(message);
  else reportedStyleErrors.set(node, new Set([message]));
  const owner = ownerName(node);
  console.error(`${message}${owner ? ` — in ${owner}` : ''}. ${consequence}.`);
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
