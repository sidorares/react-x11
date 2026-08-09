/**
 * Custom URI schemes and single-instance launches:
 * `registerApplication()`, `useAppOpen()` and the raise an inbound link
 * needs. See docs/uri-schemes.md.
 */

import type { DrawnNode, NtkWindow } from './nodes.js';
import type { RefObject } from 'react';

/**
 * What the desktop said about the launch this handler is answering.
 *
 * **Every field is untrusted.** `org.freedesktop.Application.Open` is callable
 * by any peer on the session bus — a per-user socket, not an authorization
 * check — so a hostile local process can fabricate all of it. The timestamp in
 * particular is a hint, not a credential: the worst it buys an attacker is
 * making this app steal its own focus.
 */
export interface LaunchContext {
  /** `platform_data` as received, with variants unwrapped. */
  readonly platformData: Readonly<Record<string, unknown>>;
  /**
   * The X server timestamp of the user action behind the launch, from the
   * `_TIME` suffix of `desktop-startup-id`, or `null`.
   *
   * This is the value {@link activateWindow} wants. `null` is a real answer —
   * a launch from a shell has no timestamp — and `0` is not a substitute for
   * it: EWMH gives zero its own meaning.
   */
  readonly timestamp: number | null;
  /** `desktop-startup-id`, unparsed, or `null`. */
  readonly startupId: string | null;
  /** `activation-token`. Read and exposed; there is no Wayland here. */
  readonly activationToken: string | null;
}

export interface ApplicationOptions {
  /**
   * The well-known D-Bus name, the `.desktop` file's basename and the URI
   * scheme, all at once — the desktop entry spec ties them together. A
   * malformed one throws: it is a mistake in the source, not a fact about the
   * machine.
   */
  appId: string;
  /**
   * The schemes this app answers for. Used to filter what a second instance
   * forwards and what an inbound `Open` delivers; `file:` is always allowed
   * alongside them, and omitting this filters nothing.
   *
   * `http`, `https` and `file` are refused — being the default browser or file
   * handler is a different feature. RFC 8252 §7.1 wants a scheme derived from
   * a domain you control, written in reverse.
   */
  schemes?: string[];
  /** Same as subscribing with {@link onAppOpen}, before anything can arrive. */
  onOpen?: (uris: string[], ctx: LaunchContext) => void;
  onActivate?: (ctx: LaunchContext) => void;
  /**
   * A desktop action was invoked (`ActivateAction`). Without a handler the
   * method is a no-op that still replies correctly, which is the difference
   * between an unimplemented action and an app the shell thinks is broken.
   */
  onAction?: (name: string, params: unknown[], ctx: LaunchContext) => void;
  /**
   * The launch arguments to look for URIs in. Defaults to
   * `process.argv.slice(2)`, which is where `Exec=my-app %u` puts them.
   */
  argv?: string[];
}

export interface AppRegistration {
  /**
   * `'primary'` — this process owns the name and will receive `Open`.
   *
   * `'secondary'` — another instance owns it, this launch's URIs have been
   * forwarded to it, and the caller should exit. **The library does not exit
   * for you.**
   */
  readonly role: 'primary' | 'secondary';
  readonly appId: string;
  /** Derived from `appId`, never passed in — exposed because the dash rule is
   *  easy to get wrong and fails silently. */
  readonly objectPath: string;
  /** Give the name back and stop serving. Idempotent. */
  release(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Own this app's name on the session bus and export
 * `org.freedesktop.Application` on it.
 *
 * ```js
 * const app = await registerApplication({
 *   appId: 'com.example.myapp',
 *   schemes: ['com.example.myapp'],
 * });
 * if (app?.role === 'secondary') process.exit(0);
 * const root = await createRoot();
 * ```
 *
 * **Call it before `createRoot`.** On the D-Bus path the bus started this
 * process *because* someone called `Open`, and that call is outstanding while
 * the app boots.
 *
 * `null` means there is no session bus — ssh, a bare `startx`, a container,
 * CI, Node 20 without the transport. The app runs as an ordinary single-window
 * program, and a URI that arrived in `argv` still reaches {@link onAppOpen}.
 * It never rejects for anything about the machine; a malformed `appId` or an
 * unusable scheme throws.
 */
export declare function registerApplication(
  options: ApplicationOptions,
): Promise<AppRegistration | null>;

/**
 * The desktop handed this app URIs to open. Returns an unsubscribe function.
 * Anything that arrived before the first handler attached is replayed to it.
 */
export declare function onAppOpen(
  handler: (uris: string[], ctx: LaunchContext) => void,
): () => void;

/** The desktop asked this app to come forward with nothing to open. */
export declare function onAppActivate(
  handler: (ctx: LaunchContext) => void,
): () => void;

/** {@link onAppOpen} as rendering code sees it. Nothing to wrap. */
export declare function useAppOpen(
  handler: (uris: string[], ctx: LaunchContext) => void,
): void;

/** {@link onAppActivate} as rendering code sees it. */
export declare function useAppActivate(
  handler: (ctx: LaunchContext) => void,
): void;

export interface ActivateWindowOptions {
  /**
   * The X server time of the user action being answered.
   *
   * Omitted, the last input this app saw is used — EWMH's own definition of
   * the field. A deep link should pass `ctx.timestamp` instead: the click in
   * the browser is the user action, not whatever this app last saw. `null`
   * sends `CurrentTime`, which most window managers will decline.
   */
  timestamp?: number | null;
  /** EWMH source indication: `1` an application (default), `2` a pager. */
  source?: 1 | 2;
}

/**
 * Ask the window manager to raise and focus a window.
 *
 * `target` is anything {@link windowIdOf} accepts, or nothing — in which case
 * this app's only top-level window is used (its focused one, when it has
 * several).
 *
 * Returns whether the request was **issued**. `true` is not a promise that the
 * window came forward: EWMH lets the window manager refuse and set
 * `_NET_WM_STATE_DEMANDS_ATTENTION` instead, and no client can tell the
 * difference from here.
 */
export declare function activateWindow(
  target?:
    | NtkWindow
    | DrawnNode
    | RefObject<NtkWindow | DrawnNode | null>
    | number
    | null,
  options?: ActivateWindowOptions,
): boolean;
