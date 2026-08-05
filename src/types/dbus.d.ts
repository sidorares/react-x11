/**
 * The D-Bus floor — `useSessionBus()`, `sessionBus()` and what they hand back.
 * See docs/dbus.md.
 */

/** Which bus. Session is the user's; system is hardware, networking, logind. */
export type BusKind = 'session' | 'system';

/** What a {@link BusHandle} is doing. See {@link useSessionBus}. */
export type BusStatus = 'connecting' | 'ready' | 'unavailable' | 'closed';

/**
 * The connection, as `dbus-native` presents it — **structurally**, so that
 * these declarations type-check on an install where the package is not there.
 *
 * That is not a hypothetical: `dbus-native` is an `optionalDependency` and
 * declares `engines: ">=22.12.0"`, so npm skips it on Node 20 and a
 * `import type { MessageBus } from 'dbus-native'` here would fail to resolve
 * for anyone type-checking with `skipLibCheck: false`. Nothing in react-x11's
 * declarations names the package for that reason.
 *
 * The members below are the ones this layer documents. **The index signature
 * is not a shrug** — the whole `dbus-native` surface is genuinely on this
 * object and reaching for one of the rest is the supported thing to do. Code
 * that wants the package's own checked types can import them on its side and
 * cast; the object is the same object.
 */
export interface MessageBus {
  /** This connection's unique name, once `Hello` has been answered. */
  name?: string;
  /** Signals, keyed by `mangle(path, interface, member)`. */
  signals?: unknown;
  /** The transport underneath. Reaching into it is not this layer's contract. */
  connection?: unknown;

  /** A remote object with its members resolved by introspection. */
  proxy(service: string, path: string, options?: unknown): PromiseLike<any>;
  getService(name: string): any;
  getObject(service: string, path: string): PromiseLike<any>;
  getInterface(
    service: string,
    path: string,
    interfaceName: string,
  ): PromiseLike<any>;
  invoke(message: unknown, options?: unknown): PromiseLike<any>;

  listNames(): PromiseLike<string[]>;
  listActivatableNames(): PromiseLike<string[]>;
  getNameOwner(name: string): PromiseLike<string>;
  nameHasOwner(name: string): PromiseLike<boolean>;
  requestName(name: string, flags: number): PromiseLike<number>;
  releaseName(name: string): PromiseLike<number>;
  addMatch(rule: string): PromiseLike<void>;
  removeMatch(rule: string): PromiseLike<void>;
  mangle(path: string, interfaceName?: string, member?: string): string;

  /**
   * **Do not call this on a shared bus.** It tears the connection out from
   * under every other consumer — the tray, the menu, the app's own exported
   * service. {@link closeBus} is the app-level decision; `release()` is the
   * only lifecycle verb a ref holder has.
   */
  close(): Promise<void>;

  [member: string]: any;
}

/**
 * There is no bus to be had, and this is why.
 *
 * `cause` carries the real reason — no address, `ECONNREFUSED`, an auth
 * rejection, the transport not being installed. There is deliberately no
 * second failure taxonomy on top of it: an enum would have to stay true
 * across platforms, npm layouts and `dbus-native` versions, and in practice
 * the reason gets logged far more often than it gets branched on.
 */
export declare class BusUnavailableError extends Error {
  constructor(kind: BusKind, cause?: unknown);
  /** Which bus was asked for. */
  readonly kind: BusKind;
  readonly cause?: unknown;
}

/**
 * One consumer's claim on the shared connection.
 *
 * `release()` drops the claim; it never closes anything. The connection stays
 * up for the life of the process — see docs/dbus.md — because every reconnect
 * is a new unique name, and a dialog that mounts and unmounts must not cost
 * the app its identity on the desktop.
 */
export interface BusRef {
  /** The full `dbus-native` surface, shared with every other ref. */
  readonly bus: MessageBus;
  /** This connection's unique name, e.g. `':1.42'`. Always a string. */
  readonly uniqueName: string;
  /** Drop this consumer's reference. Idempotent per ref. */
  release(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface AcquireOptions {
  /**
   * Reject with a {@link BusUnavailableError} instead of answering `null`.
   *
   * The escape hatch for an app whose purpose *is* the bus: `null` is right
   * for feature-probing plumbing and hides why from a service author. The
   * default stays never-rejecting.
   */
  required?: boolean;
}

/**
 * A shared session bus, or `null` when there is not one.
 *
 * ```js
 * const ref = await sessionBus();
 * if (!ref) return;                 // no bus here; turn the feature off
 * const portal = await ref.bus.proxy('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop');
 * await ref.release();
 * ```
 *
 * Lazy — nothing is dialled until the first call — and shared: every consumer
 * in the process gets the same socket and the same unique name, so the app's
 * exported service, its menu and its tray are visibly one application.
 */
export declare function sessionBus(
  options?: AcquireOptions & { required?: false },
): Promise<BusRef | null>;
export declare function sessionBus(
  options: AcquireOptions & { required: true },
): Promise<BusRef>;

/** A shared system bus, or `null`. Same contract as {@link sessionBus}. */
export declare function systemBus(
  options?: AcquireOptions & { required?: false },
): Promise<BusRef | null>;
export declare function systemBus(
  options: AcquireOptions & { required: true },
): Promise<BusRef>;

/**
 * Close the shared connection outright. Rare, explicit, never automatic —
 * and never something a consumer does on behalf of its siblings.
 */
export declare function closeBus(kind: BusKind): Promise<void>;

/** What {@link useSessionBus} and {@link useSystemBus} return. */
export interface BusHandle {
  /** The connection, or `null` unless `status === 'ready'`. */
  readonly bus: MessageBus | null;
  readonly uniqueName: string | null;
  readonly status: BusStatus;
  /** Why there is no bus. Set when `status === 'unavailable'`. */
  readonly cause?: BusUnavailableError;
  /** Dial again after `'closed'`. Not automatic — see docs/dbus.md. */
  retry(): void;
}

/**
 * The session bus, as rendering state. Works in any tree with **nothing to
 * wrap** — a D-Bus connection is process identity, so there is no provider
 * and nothing for an app author to install.
 *
 * ```tsx
 * const { bus } = useSessionBus();
 * if (!bus) return null;            // correct on its own; status is for detail
 * ```
 *
 * `'unavailable'` is a snapshot, not a verdict: failure is not cached, so a
 * bus that appears later will be found. Do not permanently disable a feature
 * on seeing it.
 */
export declare function useSessionBus(): BusHandle;

/** The system bus, as rendering state. Same shape as {@link useSessionBus}. */
export declare function useSystemBus(): BusHandle;
