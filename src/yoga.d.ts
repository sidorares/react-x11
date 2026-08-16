/**
 * `react-x11/yoga` — the layout engine the renderer lays every box out with.
 *
 * **Most extensions never need this.** An element measures through
 * `measureContent`, which is handed its constraints in words (`'exactly'`,
 * `'at-most'`, `'unconstrained'`) rather than yoga's integers, precisely so
 * that yoga's ABI does not become part of the extension seam — see
 * [extending.md](../docs/extending.md).
 *
 * What this entry point is for is the other case: a package implementing a
 * **layout algorithm of its own** and wanting to delegate part of it. The
 * worked example is `@react-x11/components`'s `<Html>`, whose `display: flex`
 * builds a small yoga tree, asks it, and reads the answer back rather than
 * re-deriving flexbox by hand.
 *
 * Such a package must use **this** engine rather than its own `yoga-layout`
 * dependency. Two instances mean two WebAssembly modules, and a node created
 * by one cannot be inserted into a tree owned by the other — a failure that
 * surfaces as a crash inside the engine, naming nothing the author wrote.
 *
 * The engine is loaded, not imported: `createRoot()` awaits `loadLayout()`
 * before it builds anything, which is what keeps a top-level await out of
 * every bundle containing react-x11 (docs/packaging.md). The enum constants
 * are readable from the first tick regardless; `Node` and `Config` throw
 * until the assembly is in place.
 */
import type { Yoga as YogaAssembly } from 'yoga-layout/load';

export type { Config, MeasureFunction, Node } from 'yoga-layout/load';

/**
 * yoga's assembly — `Node.create()`, `Config`, and the rest — plus the flat
 * `SCREAMING_CASE` enum constants (`EDGE_LEFT`, `FLEX_DIRECTION_ROW`,
 * `MEASURE_MODE_AT_MOST`, …) that `styles.js` builds its lookup tables from.
 *
 * The constants are typed loosely because they are generated from yoga's
 * typed enums at import time rather than declared; for a checked alternative,
 * import the enums themselves from `yoga-layout/load` — they are plain
 * JavaScript and carry no WebAssembly with them.
 */
export type LayoutEngine = YogaAssembly & Record<string, number>;

export const Yoga: LayoutEngine;
export default Yoga;

/**
 * Load the engine's WebAssembly. Idempotent, and resolves with the same
 * `Yoga` object this module exports. `createRoot()` awaits it, so an
 * application rarely calls it — code that builds nodes outside a root (a test
 * harness over the mock app) needs it first.
 */
export function loadLayout(): Promise<LayoutEngine>;

/** Whether the assembly is in place — `Yoga.Node` will not throw. */
export function layoutLoaded(): boolean;
