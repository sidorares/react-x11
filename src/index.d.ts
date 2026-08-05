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
export * from './types/dbus.js';

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

/**
 * Parse a `text/uri-list` payload (RFC 2483): CRLF-separated,
 * percent-encoded, `#` lines are comments. What `DropEvent.files` is made
 * of; exported for handling `getData('text/uri-list')` results yourself.
 * `path` is present only for genuinely local `file:` URIs.
 */
export function parseUriList(
  text: string | Uint8Array,
): Array<{ uri: string; path?: string }>;

/** A semantic group, or any concrete type name the owner offers. */
export type TransferType = 'text' | 'files' | 'uris' | (string & {});

export interface ClipboardOptions {
  /** Selection atom name; `'CLIPBOARD'` by default, `'PRIMARY'` for the
   * middle-click buffer. Any name works. */
  selection?: string;
  /** ms to wait for the owner at each protocol step. */
  timeout?: number;
  /** The server timestamp of the event behind this (ICCCM 2.1 / 2.4).
   * Defaults to the last input event seen on this connection, which is
   * almost always what you want. */
  time?: number;
}

export interface SelectionChange {
  selection: string;
  /** Window now owning it, or `0` when nothing does — the case an edit
   * menu wants. */
  owner: number;
  timestamp?: number;
  selectionTimestamp?: number;
  reason?: 'new-owner' | 'destroyed' | 'closed';
}

/** What `useClipboard()` returns. See docs/clipboard.md. */
export interface Clipboard {
  /** Offer several flavours of one thing: type name to string or bytes. */
  write(
    data: string | Record<string, string | Uint8Array>,
    options?: ClipboardOptions,
  ): Promise<void>;
  writeText(text: string, options?: ClipboardOptions): Promise<void>;
  /** Stop owning the selection, so nothing is served for it any more. */
  clear(selection?: string): Promise<void>;
  /** What the current owner can convert to; `[]` when nothing owns it. */
  targets(options?: ClipboardOptions): Promise<string[]>;
  /** Plain text, via the owner's `UTF8_STRING`/`STRING` targets. Rejects
   * when there is no owner or it offers neither — `read('text')` is the
   * interop-hardened version. */
  readText(options?: ClipboardOptions): Promise<string>;
  /** One type, decoded, or `null` when the owner has nothing of that kind.
   * Text-ish types resolve to a string, anything else to bytes. */
  read(
    type: TransferType,
    options?: ClipboardOptions,
  ): Promise<string | Uint8Array | null>;
  /** Files copied in a file manager, parsed; `[]` when there are none. */
  readFiles(
    options?: ClipboardOptions,
  ): Promise<Array<{ uri: string; path?: string }>>;
  /** Called whenever the selection changes hands. Resolves to an
   * unsubscribe function. Rejects on a server without XFixes. */
  watch(handler: (change: SelectionChange) => void): Promise<() => void>;
  watch(
    selection: string,
    handler: (change: SelectionChange) => void,
  ): Promise<() => void>;
}

/**
 * The ntk connection this tree renders onto — `app.fonts`, `app.cursors`,
 * `app.X` and the rest. Throws outside a tree rendered by `createRoot()`.
 */
export function useApp(): unknown;

/** The clipboard, scoped to this tree's connection. */
export function useClipboard(): Clipboard;

/** Features `useSupports()` can be asked about. */
export type SupportsFeature = 'transparency';

/**
 * Can this **display** do something? `'transparency'` is true when the
 * server has a 32-bit visual to draw on *and* a compositor is running to
 * blend it; it re-renders when a compositor starts or stops.
 *
 * The companion is the `'@supports transparency'` style block, which asks
 * about the window a node is actually in. Reach for that first — this is
 * for decisions that are not styling, and that have to be made before a
 * window exists (sizing a popup to hold a client-drawn shadow, say).
 */
export function useSupports(feature: SupportsFeature): boolean;

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
  /**
   * Startup notification (freedesktop), on by default. Reads
   * `DESKTOP_STARTUP_ID`, sets `_NET_STARTUP_ID` and `_NET_WM_USER_TIME` on
   * the first toplevel before it maps, and ends the launcher's startup
   * sequence when the app is up — which stops the busy cursor and gives
   * focus-stealing prevention the evidence it asks for.
   *
   * `false` turns it off entirely, for an app that runs its own sequence or
   * an embedder that owns the toplevel. A string supplies the id for a
   * launch where it did not arrive in the environment.
   *
   * See {@link StartupNotificationOptions.completeOn} for *when* the app
   * counts as up, and docs/desktop.md.
   */
  startupNotification?: boolean | string | StartupNotificationOptions;
}

export interface StartupNotificationOptions {
  /** The launch id, when it did not come from `DESKTOP_STARTUP_ID`. */
  id?: string;
  /**
   * What counts as "started". Default `'paint'`.
   *
   * - `'paint'` — the first frame that actually drew. This renderer maps a
   *   window and paints it a frame later, so the map is an empty rectangle;
   *   ending there stops the busy cursor over a blank window.
   * - `'map'` — the first toplevel mapping, which is what GTK does. Earlier,
   *   and right for an app whose first frame is expensive enough that it
   *   would rather the cursor stopped before it.
   * - `'manual'` — nothing automatic; call {@link notifyStartupComplete}.
   *   For an app that is not up until it says so, such as one restoring a
   *   session behind a splash.
   *
   * A backstop timer ends the sequence regardless, so an app that never
   * paints — or never calls — cannot leave the cursor spinning.
   */
  completeOn?: 'paint' | 'map' | 'manual';
}

/**
 * The X server timestamp of the user action that launched this app, from
 * the startup id, or `null` when there was none.
 *
 * `null` is a real answer rather than a failure: an app started from a
 * shell has no launch timestamp and never will. It is the "when" that a
 * legitimate request to come forward is weighed against, and `0` is not a
 * substitute — EWMH gives zero its own meaning.
 */
export function launchTimestamp(): number | null;

/**
 * End the startup sequence now. Idempotent, and a no-op when there is none,
 * so it may be called unconditionally. The seam behind
 * `startupNotification: { completeOn: 'manual' }`.
 */
export function notifyStartupComplete(): void;

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
