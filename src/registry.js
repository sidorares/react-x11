// The element registry: how a package that is not react-x11 adds a host
// element (issue #125).
//
// The vocabulary used to be a closed `switch` with a throwing default, so a
// `<sparkline>`, a tray icon or an XEMBED `<foreign>` meant forking. It is
// now that switch plus this table, consulted by `createInstance` before it
// gives up — the built-ins stay a switch because they are not data, and a
// registered element is data.
//
// Two things the table carries besides the constructor, both because
// getting them wrong fails somewhere far away:
//
// - **`drawn`** puts the kind in `DRAWN_KINDS`, which is what `paintOrder`
//   filters on. A node missing from it lays out and never paints, with no
//   error anywhere — the single most confusing way for a custom element to
//   fail.
// - **`semanticNames`** exempts the element's own prop names from the DEV
//   assertion that catches `<box width={10}>` (a style property written
//   flat). Without it an element whose vocabulary overlaps the style
//   vocabulary — `width`, `stroke`, `opacity` — throws on its own props in
//   development and works in production, which is the worst shape a bug
//   can have.
//
// And one that is an optimisation rather than a trap, `selfDamagedProps`,
// which is the commit half of the damage seam `Node.paintDamage()` opens
// (issue #301).
import {
  DRAWN_KINDS,
  CUSTOM_SEMANTIC_NAMES,
  CUSTOM_SELF_DAMAGED,
  Node,
} from './nodes.js';

/** kind -> definition. Insertion-ordered, which is the order errors list. */
const registry = new Map();

const RESERVED = new Set(['textchunk', 'svgchild']);

// The re-registration policy for hot reload (issue #318). Module-scope
// registration is the pattern the docs recommend and tree-shaking forces on
// component libraries, and a hot re-import runs that module scope again —
// so under an active reload session a duplicate registration replaces
// silently instead of throwing. The flag is flipped by react-x11/refresh's
// loader the moment the first hot re-import is compiled (before it
// evaluates, so the first reloaded module's own registerElement is already
// covered), and never outside a hot dev loop — a plain run still hears
// about two packages claiming one name. It stays one-way on purpose: after
// the first reload every registration may be a re-run of code that
// registered before, and there is no later moment at which that stops
// being true. The setter takes `false` only so tests can restore the
// default; nothing else should ever pass it.
let hotReloadSession = false;

/** @internal — called by react-x11/refresh; not part of the public API. */
export function markHotReloadSession(active = true) {
  hotReloadSession = active;
}

function assertNode(node, type) {
  if (!(node instanceof Node)) {
    throw new Error(
      `react-x11: the create() registered for <${type}> returned ` +
        `${node === undefined ? 'undefined' : typeof node} — it must return ` +
        'a Node (import { Node } from "react-x11/node").',
    );
  }
  if (node.kind !== type) {
    throw new Error(
      `react-x11: the create() registered for <${type}> returned a node of ` +
        `kind "${node.kind}". The kind is what paint order, queries and the ` +
        'DEV style assertion match on, so it has to be the element name.',
    );
  }
  return node;
}

/**
 * Teach react-x11 a new element.
 *
 * ```js
 * import { registerElement } from 'react-x11/host';
 * import { Node } from 'react-x11/node';
 *
 * class SparklineNode extends Node {
 *   constructor(props, app) {
 *     super('sparkline', props, app);
 *   }
 *   paint(ctx) {
 *     super.paint(ctx);          // background, border, clip
 *     // ...draw this.props.data inside this.abs
 *   }
 * }
 *
 * registerElement('sparkline', {
 *   create: (props, app) => new SparklineNode(props, app),
 *   drawn: true,
 *   semanticNames: ['data', 'stroke'],
 * });
 * ```
 *
 * @param {string} type element name, as written in JSX
 * @param {object} definition
 * @param {(props, app, hostContext) => Node} definition.create builds the
 *   node. `app` is the ntk connection the tree renders through — the second
 *   argument every built-in node constructor takes.
 * @param {boolean} [definition.drawn=true] lays out with yoga and paints
 *   into the owning window. `false` is for a node that owns a real child X
 *   window instead (`GlAreaNode` is the worked example).
 * @param {string[]} [definition.semanticNames] prop names this element owns
 *   even though they are also style names.
 * @param {string[]} [definition.selfDamagedProps] prop names whose damage
 *   the element's own `applyProps` claims, so a commit that changes one does
 *   not also damage the whole node. For an element that draws a scene into
 *   one node and invalidates the part of it that moved; an element that
 *   answers wrong shows stale pixels, so everything left out stays core's
 *   conservative answer (docs/extending.md).
 * @param {boolean} [definition.childrenAllowed=true] reject children in DEV
 *   with a message naming the element, rather than laying out something
 *   that cannot paint.
 * @param {boolean} [definition.override=false] replace an existing
 *   registration. Off by default: two packages claiming one name is a
 *   conflict to be told about, not resolved silently.
 */
export function registerElement(type, definition) {
  if (typeof type !== 'string' || type === '') {
    throw new Error('react-x11: registerElement needs an element name.');
  }
  if (!/^[a-z][a-z0-9-]*$/.test(type)) {
    // Capitalised names are components to JSX, never host elements, so
    // `registerElement('Sparkline')` would register something unreachable.
    throw new Error(
      `react-x11: "${type}" cannot be an element name — JSX only treats ` +
        'lowercase names as host elements. Use "sparkline", not "Sparkline".',
    );
  }
  if (RESERVED.has(type)) {
    throw new Error(
      `react-x11: <${type}> is internal to react-x11 and cannot be ` +
        'registered.',
    );
  }
  if (!definition || typeof definition.create !== 'function') {
    throw new Error(
      `react-x11: registerElement("${type}") needs a create(props, app) ` +
        'function that returns a Node.',
    );
  }
  if (registry.has(type) && !definition.override) {
    // Identical re-registration — the same create() reference — is the
    // same definition arriving twice (a module evaluated twice, a test
    // registering in a loop) and never a conflict; the latest flags win.
    // Everything else is a real collision unless a hot-reload session is
    // re-running module scopes, which is the one loop where "already
    // registered" means "registered by the previous version of yourself".
    // Mounted nodes keep the old prototype until they remount — the same
    // staleness contract React Refresh has for classes.
    const identical = registry.get(type).create === definition.create;
    if (!identical && !hotReloadSession) {
      throw new Error(
        `react-x11: <${type}> is already registered. Pass { override: true } ` +
          'if replacing it is deliberate — two packages claiming one element ' +
          'name is usually not. (Under hot reload a module re-registering ' +
          'its own elements replaces them silently; this error means two ' +
          'different definitions collided outside any reload.)',
      );
    }
  }

  const {
    create,
    drawn = true,
    semanticNames = [],
    selfDamagedProps = [],
    childrenAllowed = true,
  } = definition;

  registry.set(type, { create, drawn, childrenAllowed });

  // paintOrder() filters on this set, so a drawn element has to join it or
  // it lays out and never paints
  if (drawn) DRAWN_KINDS.add(type);
  else DRAWN_KINDS.delete(type);

  if (semanticNames.length > 0) {
    CUSTOM_SEMANTIC_NAMES.set(type, new Set(semanticNames));
  } else {
    CUSTOM_SEMANTIC_NAMES.delete(type);
  }

  // Both maps are keyed on the kind and cleared when the name is not
  // claimed, so re-registering with `override` cannot leave the previous
  // definition's declarations behind for the new one to inherit.
  if (selfDamagedProps.length > 0) {
    CUSTOM_SELF_DAMAGED.set(type, new Set(selfDamagedProps));
  } else {
    CUSTOM_SELF_DAMAGED.delete(type);
  }
}

/** Undo a registration. Mostly for tests, which must not leak an element
 * into the next file's expectations. */
export function unregisterElement(type) {
  DRAWN_KINDS.delete(type);
  CUSTOM_SEMANTIC_NAMES.delete(type);
  CUSTOM_SELF_DAMAGED.delete(type);
  return registry.delete(type);
}

/** The definition for a registered element, or undefined. */
export function elementDefinition(type) {
  return registry.get(type);
}

/** Registered element names, in registration order. */
export function registeredElements() {
  return [...registry.keys()];
}

/**
 * Build a registered element's node, or undefined if the name is not one.
 * Called from `createInstance`'s default branch, so an unregistered name
 * still produces the built-in "unknown element" error.
 */
export function createRegisteredNode(type, props, app, hostContext) {
  const definition = registry.get(type);
  if (!definition) return undefined;
  const node = assertNode(definition.create(props, app, hostContext), type);
  // read by Node.insertBefore — carried on the instance so nodes.js needs
  // no import from here
  if (!definition.childrenAllowed) node._childrenAllowed = false;
  return node;
}
