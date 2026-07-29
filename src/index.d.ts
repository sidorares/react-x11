/**
 * react-x11 — a React renderer whose host environment is an X11 server.
 *
 * These declarations are hand-written against the JavaScript in `src/`. The
 * host elements (`<window>`, `<box>`, `<text>`, …) are added to React's JSX
 * namespace below, so JSX type-checks with no tsconfig changes beyond
 * `"jsx": "react-jsx"`.
 */

import type { ReactNode } from 'react';
import type { NtkApp } from './types/nodes.js';
import type { ReactX11Elements } from './types/elements.js';

export * from './types/style.js';
export * from './types/events.js';
export * from './types/nodes.js';
export * from './types/elements.js';
export * from './types/components.js';

/** A mounted tree, as returned by {@link createRoot}. */
export interface Root {
  /** The ntk `App` this root renders through. */
  readonly app: NtkApp;
  render(element: ReactNode, callback?: () => void): void;
  unmount(): void;
}

/**
 * Connect to the X server and make a root:
 *
 * ```tsx
 * const root = await createRoot();   // connects via $DISPLAY
 * root.render(<App />);
 * ```
 *
 * Pass an ntk `App` to render into a connection you already have.
 */
export function createRoot(container?: NtkApp): Promise<Root>;

/**
 * Legacy entry point. Without a container it connects to the X server and
 * resolves once mounted; with one it mounts synchronously.
 */
export function render(
  element: ReactNode,
  callback?: () => void,
): Promise<void>;
export function render(
  element: ReactNode,
  callback: (() => void) | undefined,
  container: NtkApp,
): void;

export function unmountComponentAtNode(container: NtkApp): void;

/** The react-reconciler instance. Escape hatch; not a stable API. */
export const Renderer: any;

declare const ReactX11: {
  render: typeof render;
  createRoot: typeof createRoot;
  unmountComponentAtNode: typeof unmountComponentAtNode;
};
export default ReactX11;

export type { ReactX11Elements };
