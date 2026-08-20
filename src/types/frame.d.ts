/**
 * `<Frame>` — a pane of this application in its own process — and the
 * context bridge that follows the app into it. See docs/frame.md.
 */

import type { Context, ReactElement, ReactNode, Ref } from 'react';
import type { StyleProp } from './style.js';

/**
 * The props bag a `<Frame>` sends its pane. Values cross by structured
 * clone; functions become fire-and-forget stubs on the pane side, so a
 * callback's return value is always `undefined` over there.
 */
export type FrameProps = Record<string, unknown>;

/** Why a pane is not running, for `fallback` and `onExit` to read. */
export interface FrameError extends Error {
  /** Where it went wrong: `'spawn' | 'load' | 'connect' | 'handshake' |
   * 'runtime' | 'send' | 'embed' | 'exit'`. */
  phase?: string;
  code?: number | null;
  signal?: string | null;
}

export interface FrameHandle {
  /** Start a fresh pane process; what `fallback` receives to retry with. */
  restart(): void;
  /** The pane's pid, `null` before the first spawn and after an exit. */
  pid: number | null;
}

export interface FrameComponentProps {
  /**
   * The pane module: its default export is mounted as the pane's root
   * component. A `URL` (`new URL('./pane.js', import.meta.url)` — typed
   * structurally so no DOM lib is needed) or an absolute path — never
   * relative, which would resolve against react-x11's own files rather
   * than the caller's.
   */
  src: { href: string } | string;
  /** Data for the pane, snapshotted and sent whole once per commit that
   * changes it. Functions anywhere in the bag become RPC stubs. */
  props?: FrameProps;
  /** The embedded pane's rect in this tree — sized like any other child. */
  style?: StyleProp;
  /** X display for the pane process; defaults to the inherited `$DISPLAY`. */
  display?: string;
  /**
   * Which bridged contexts follow the app into this pane: `true` (default)
   * for every registered one — the theme included — `false` for none, or an
   * allowlist of keys.
   */
  bridge?: boolean | string[];
  /**
   * What this rect shows when the pane crashed or could not start: an
   * element, or a function of the error and a `restart` that respawns.
   * Without one the rect is an empty box in its `style`.
   */
  fallback?:
    | ReactElement
    | ((info: { error: FrameError | null; restart: () => void }) => ReactNode);
  /** Whether the pane joins the tab order, like any `<foreign>`. */
  focusable?: boolean;
  /** The pane mounted and its window is being embedded. */
  onStarted?(info: { pid: number | null; windowId: number }): void;
  /** The pane process ended. `expected` is true when this side asked —
   * unmount, `restart()`, a `src` change — and false for a crash. */
  onExit?(info: {
    code: number | null;
    signal: string | null;
    expected: boolean;
  }): void;
  /**
   * Replace the fork with a transport of your own — the seam the tests use
   * (a loopback pair into `runFrameChild`), and the door to running a pane
   * somewhere other than a child process. Advanced; see docs/frame.md.
   */
  transport?(options: { src: string; display?: string }): FrameTransport;
  ref?: Ref<FrameHandle>;
}

/** The parent's end of the wire to a pane. */
export interface FrameTransport {
  /** May throw when the channel is gone or the message will not clone. */
  send(msg: object): void;
  onMessage(cb: (msg: object) => void): () => void;
  onExit(
    cb: (info: {
      code?: number | null;
      signal?: string | null;
      error?: Error | null;
    }) => void,
  ): () => void;
  kill?(signal: string): void;
  pid?: number;
}

/**
 * A module of this application, mounted in its own process, its window
 * embedded here (over `<foreign>`). Props cross as data, callbacks as
 * fire-and-forget stubs, context through the bridge — and the process
 * boundary contains the pane's failures, not its intentions: it is not a
 * security boundary (docs/security.md).
 */
export function Frame(props: FrameComponentProps): ReactElement | null;

export interface FrameContext<T> {
  /** The name this value travels under; unique per application. */
  key: string;
  /** The ordinary React context, for `useContext` and class consumers. */
  Context: Context<T>;
  /** The provider that also publishes the value to `<Frame>` panes. */
  Provider: (props: { value: T; children?: ReactNode }) => ReactElement;
  /** `useContext(Context)`, as a method. */
  use(): T;
}

/**
 * A React context whose value follows the app into its `<Frame>` panes:
 * in-process an ordinary context, across a frame a structured-clone
 * snapshot recreated as a real provider around the pane. One direction,
 * data only — a value that will not clone is dropped with a warning, and
 * dispatchers travel in `props` where the wiring is visible.
 *
 * Both sides must import the module that calls this — which the pane
 * already does, since its components read the context from it.
 */
export function createFrameContext<T>(
  key: string,
  defaultValue: T,
  options?: {
    serialize?: (value: T) => unknown;
    revive?: (wire: unknown) => T;
  },
): FrameContext<T>;

/**
 * Runs when the host is letting this pane go — the `<Frame>` unmounted,
 * the host app is exiting — bounded by the host's patience (it escalates
 * to signals). May return a promise. Not called on a crash; outside a
 * frame it never runs.
 */
export function useFrameClose(handler: () => void | Promise<void>): void;

/** Whether this process is a `<Frame>` pane. */
export function isFramed(): boolean;
