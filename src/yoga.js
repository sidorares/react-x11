// The layout engine, without a top-level await.
//
// Every drawn node owns one yoga node (`nodes.js`), and `styles.js` is the
// translation from style props to yoga setters. This module is where the
// engine itself comes from.
//
// It used to come from ntk, because ntk's own `HtmlView` laid out with
// flexbox and a second WASM instance would have meant nodes from one engine
// being mixed with nodes from the other. ntk's document widgets are gone, so
// the renderer is the only layout consumer left and owns the dependency
// directly.
//
// **Why not `yoga-layout`'s default entry.** It is
// `const Yoga = wrapAssembly(await loadYoga())` — and that one `await` is
// contagious: every bundle containing react-x11 inherits it, esbuild then
// refuses to emit CommonJS ("Top-level await is currently not supported with
// the cjs output format"), and Node's single-executable format runs its
// embedded main as CommonJS. One import would cost every app the ability to
// ship as a single binary (docs/packaging.md).
//
// So this imports the half of the package with no WASM in it —
// `yoga-layout/load` exports the enums as plain JavaScript and the assembly
// behind an async function — and `createRoot()` loads the assembly, which is
// already asynchronous.
//
// The object exported here keeps yoga's own shape, and that is the point:
// the flat SCREAMING_CASE constants are present from the first tick, so
// `styles.js` builds its lookup tables at module scope without awaiting
// anything. `Node`, `Config` and the rest of the assembly appear when
// `loadLayout()` resolves.
import {
  loadYoga,
  Align,
  BoxSizing,
  Dimension,
  Direction,
  Display,
  Edge,
  Errata,
  ExperimentalFeature,
  FlexDirection,
  Gutter,
  Justify,
  LogLevel,
  MeasureMode,
  NodeType,
  Overflow,
  PositionType,
  Unit,
  Wrap,
} from 'yoga-layout/load';

const ENUMS = {
  Align,
  BoxSizing,
  Dimension,
  Direction,
  Display,
  Edge,
  Errata,
  ExperimentalFeature,
  FlexDirection,
  Gutter,
  Justify,
  LogLevel,
  MeasureMode,
  NodeType,
  Overflow,
  PositionType,
  Unit,
  Wrap,
};

// yoga's generator names each constant <ENUM>_<MEMBER>, both snake-cased from
// PascalCase: FlexDirection.ColumnReverse -> FLEX_DIRECTION_COLUMN_REVERSE.
// test/yoga.test.js pins every name against the real assembly, so a rename
// upstream fails loudly instead of yielding an undefined constant.
const screamingSnake = (name) =>
  name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

/** The layout engine: enums now, assembly after `loadLayout()`. */
const Yoga = {};
for (const [enumName, members] of Object.entries(ENUMS)) {
  // a bundler may stub yoga out entirely, and importing react-x11 must still
  // work — a documentation build that only reads the module graph, say
  if (!members || typeof members !== 'object') continue;
  const prefix = screamingSnake(enumName);
  for (const [member, value] of Object.entries(members)) {
    if (typeof value === 'number')
      Yoga[`${prefix}_${screamingSnake(member)}`] = value;
  }
}

const notLoaded = (what) => () => {
  throw new Error(
    `react-x11: the layout engine is not loaded, so Yoga.${what} is not ` +
      'available yet. createRoot() loads it; a node built outside one — a ' +
      'test harness with a mock app — needs `await loadLayout()` first.',
  );
};

// A useful message instead of "Cannot read properties of undefined"
for (const name of ['Node', 'Config']) {
  Object.defineProperty(Yoga, name, {
    configurable: true,
    get: notLoaded(name),
  });
}

let loading = null;

/**
 * Load the layout engine's WebAssembly. Idempotent, and resolves with the
 * same `Yoga` object this module exports — `createRoot()` awaits it, so
 * applications rarely call it themselves. A tree built without one (the
 * headless mock app in `react-x11/test`) needs it.
 */
export function loadLayout() {
  if (!loading) {
    loading = loadYoga().then((assembly) => {
      for (const name of ['Node', 'Config']) delete Yoga[name]; // drop the throwing getters
      Object.assign(Yoga, assembly);
      return Yoga;
    });
  }
  return loading;
}

/** Whether the assembly is in place — layout will not throw. */
export function layoutLoaded() {
  return Object.getOwnPropertyDescriptor(Yoga, 'Node')?.value !== undefined;
}

export { Yoga };
export default Yoga;
