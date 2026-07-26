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
