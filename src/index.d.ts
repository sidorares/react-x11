/**
 * react-x11 — a React renderer whose host environment is an X11 server.
 *
 * These declarations are hand-written against the JavaScript in `src/`. The
 * host elements (`<window>`, `<box>`, `<text>`, …) are added to React's JSX
 * namespace below, so JSX type-checks with no tsconfig changes beyond
 * `"jsx": "react-jsx"`.
 */

import type { ReactNode, RefObject } from 'react';
import type { DrawnNode, NtkApp, NtkWindow } from './types/nodes.js';
import type { ReactX11Elements } from './types/elements.js';

export * from './types/style.js';
export * from './types/events.js';
export * from './types/nodes.js';
export * from './types/elements.js';
export * from './types/components.js';

/**
 * The XID of the X11 window a ref points at, or `null` if there is not one
 * yet. Accepts a `<window>`/`<popup>` ref (whose `current` is the live ntk
 * window), a ref to any drawn node (resolved to the window that owns it),
 * the ref object itself, or a raw XID.
 *
 * This is the walk `transientFor` resolves its prop through, and the one an
 * xdg-desktop-portal `parent_window` handle needs — `x11:` followed by
 * lowercase hex with no `0x` prefix.
 */
export function windowIdOf(
  target:
    | NtkWindow
    | DrawnNode
    | RefObject<NtkWindow | DrawnNode | null>
    | number
    | null
    | undefined,
): number | null;

/**
 * `windowIdOf` bound to a ref. Returns a **getter**, stable across renders,
 * the same shape {@link useAnchor} has — refs attach after the commit that
 * created the window, so a value read during render would be null on the
 * render that matters.
 */
export function useWindowId(
  ref: RefObject<NtkWindow | DrawnNode | null>,
): () => number | null;

/** What React reports alongside an error it caught. */
export interface ErrorInfo {
  componentStack?: string;
}

export interface RootOptions {
  /** `':1'`, `'host:0.0'`, or a unix socket path. Defaults to `$DISPLAY`. */
  display?: string;
  /**
   * Render into a connection you already have — tests, embedding, a client
   * built with options this bag does not carry. A borrowed connection is
   * never closed by {@link Root.unmount}.
   */
  app?: NtkApp;
  /** An already-connected duplex stream, instead of dialling `$DISPLAY`. */
  stream?: unknown;
  /** Pluggable system-font lookup; see ntk's docs/fonts.md. */
  fontSource?: unknown;
  /** A visual id for `getContext('opengl')`, instead of querying for one. */
  glxVisual?: unknown;
  /** X protocol errors no request callback claimed. Default warns. */
  onXError?: (err: Error) => void;
  onUncaughtError?: (error: unknown, errorInfo: ErrorInfo) => void;
  onCaughtError?: (error: unknown, errorInfo: ErrorInfo) => void;
  onRecoverableError?: (error: unknown, errorInfo: ErrorInfo) => void;
  /**
   * The X connection ended without being asked to — server exit, ssh drop,
   * kill. Not called for a connection this root closed itself.
   *
   * A reconnect is not a reconnect: every window id, pixmap, glyph set and
   * font is invalidated with the connection. Tear the root down and build a
   * new one; nothing survives.
   */
  onDisconnect?: (reason: 'closed' | 'error', err?: Error) => void;
}

/** A mounted tree, as returned by {@link createRoot}. */
export interface Root {
  /** The ntk `App` this root renders through. */
  readonly app: NtkApp;
  render(element: ReactNode, callback?: () => void): void;
  /** Unmounts, then closes the connection unless `app` was passed in. */
  unmount(): Promise<void>;
}

/**
 * Connect to the X server and make a root:
 *
 * ```tsx
 * const root = await createRoot();                 // connects via $DISPLAY
 * const other = await createRoot({ display: ':1' });
 * root.render(<App />);
 * await root.unmount();
 * ```
 *
 * Each root without `app` opens its own connection and owns it, so two
 * roots are two independent trees.
 */
export function createRoot(options?: RootOptions): Promise<Root>;

/** The react-reconciler instance. Escape hatch; not a stable API. */
export const Renderer: any;

declare const ReactX11: {
  createRoot: typeof createRoot;
};
export default ReactX11;

export type { ReactX11Elements };
