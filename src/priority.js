// Shared update-priority state between the host config and the event
// dispatcher. react-reconciler is CJS; default-import and destructure so the
// named bindings work regardless of cjs-module-lexer's view of the package.
import ReactReconcilerConstants from 'react-reconciler/constants.js';

export const {
  ConcurrentRoot,
  DefaultEventPriority,
  DiscreteEventPriority,
  ContinuousEventPriority,
  NoEventPriority,
} = ReactReconcilerConstants;

let currentUpdatePriority = NoEventPriority;

export function getCurrentUpdatePriority() {
  return currentUpdatePriority;
}

export function setCurrentUpdatePriority(priority) {
  currentUpdatePriority = priority;
}

export function resolveUpdatePriority() {
  return currentUpdatePriority !== NoEventPriority
    ? currentUpdatePriority
    : DefaultEventPriority;
}

// The renderer's `flushSyncWork`, registered by Reconciler.js when it builds
// the reconciler. The dispatcher needs it and cannot import the Reconciler
// back without a cycle, and there is only ever one reconciler per process.
let syncFlush = null;

export function setSyncFlush(fn) {
  syncFlush = fn;
}

/**
 * Land every discrete-priority update React is holding, now.
 *
 * `scheduleMicrotask` in the host config is what makes this necessary: a
 * sync-lane update is committed in a microtask, so an event handler that has
 * returned has *not* yet seen React's half of its own response. Painting
 * before this ran would show the default action's half — the `:active` flip,
 * the caret — and leave React's to the next frame, which is both a frame
 * late and a second paint.
 *
 * A no-op when there is nothing pending, and when React is already rendering
 * or committing (`flushSyncWork` checks its own execution context).
 */
export function flushSyncWork() {
  syncFlush?.();
}

/** Run fn (an event handler batch) at the given update priority. */
export function runWithPriority(priority, fn) {
  const previous = currentUpdatePriority;
  currentUpdatePriority = priority;
  try {
    return fn();
  } finally {
    currentUpdatePriority = previous;
  }
}
