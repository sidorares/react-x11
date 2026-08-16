/**
 * `react-x11/refresh` — the runtime half of state-preserving hot reload.
 * Run the app under the loader (`node --import react-x11/refresh/register`)
 * and import from here only for the two seams below.
 */

/** One applied hot-reload batch. */
export interface ReloadEvent {
  /** Canonical URLs of the refresh-boundary modules that re-evaluated. */
  urls: string[];
  /** False when the batch left no component updates to apply. */
  refreshed: boolean;
}

/**
 * Called after each hot-reload batch has re-rendered the edited
 * components in place. Returns an unsubscribe function.
 */
export function onReload(listener: (event: ReloadEvent) => void): () => void;

/** Apply pending component updates now. Returns null if nothing was pending. */
export function performReactRefresh(): unknown;

/**
 * Internal surface for the loader's injected prelude/footer — reached as
 * the default export because only default bindings initialize
 * synchronously inside a hot module. Not part of the public API.
 */
declare const runtime: {
  register(type: unknown, id: string): void;
  createSignatureFunctionForTransform(): unknown;
  moduleReady(
    hot: unknown,
    url: string,
    exportsMap: Record<string, unknown> | null,
  ): void;
  performReactRefresh: typeof performReactRefresh;
  onReload: typeof onReload;
};
export default runtime;
