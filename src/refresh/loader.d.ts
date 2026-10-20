/**
 * `react-x11/refresh/loader` — the loader half of state-preserving hot
 * reload. `react-x11/refresh/register` calls registerRefresh() with the
 * defaults; a tool that needs the seams writes its own --import module.
 */

export interface RefreshOptions {
  /** File extensions treated as hot modules. Default: ['.jsx']. */
  extensions?: string[];
  /**
   * Keep additional modules out of the hot graph (identity that must
   * survive a reload: contexts, stores). node_modules and react-x11's own
   * sources are always excluded.
   */
  ignore?: (path: string) => boolean;
  /**
   * Only 'classic' is supported: the automatic runtime injects an import
   * that breaks under the hot-module import rewrite. Passing anything
   * else throws.
   */
  jsxRuntime?: 'classic';
  /**
   * Extra statements injected into every hot module, one statement per
   * entry — an entry holding two statements or a newline throws.
   */
  prelude?: string[];
}

/** Register the loader + hot-module hooks. Once per process. */
export function registerRefresh(options?: RefreshOptions): Promise<void>;

/** The transform alone, for a tool hosting its own module hooks. */
export function createTransformer(options?: RefreshOptions): Promise<{
  preludeLineCount: number;
  matches(pathname: string): boolean;
  transform(source: string, filename: string): { code: string };
}>;

/** One hot module compiled: `error` is null when it compiled, and what the
 * compiler threw when it did not. */
export interface TransformEvent {
  filename: string;
  error: Error | null;
}

/**
 * Called for every hot module the loader compiles. A save that does not
 * compile is otherwise only printed — the app keeps running the module's last
 * version — so this is how a host shows it. Returns an unsubscribe.
 */
export function onTransform(
  listener: (event: TransformEvent) => void,
): () => void;
