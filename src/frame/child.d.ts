/**
 * `react-x11/frame/child` — the entry a `<Frame>` forks: a pane process's
 * whole bootstrap, over the IPC channel `fork()` sets up. **Resolved, not
 * imported**: a `transport` that starts the pane its own way — under a
 * sandbox, with a runtime of its own choosing — forks
 * `fileURLToPath(import.meta.resolve('react-x11/frame/child'))`, and
 * importing it anywhere else exits the process. No exports.
 */
export {};
