// The kind tables. registry.js fills them when an element registers, and
// the node classes read them — that direction, rather than the nodes
// importing the registry, is what keeps the two acyclic.

/**
 * Kinds that lay out with yoga and paint into the owning window —
 * `paintOrder` filters on this, so a kind missing from it lays out and
 * never paints. Mutable because `registerElement` (registry.js) adds to it;
 * that direction, rather than src/nodes/ importing the registry, is what
 * keeps the two files acyclic.
 */
export const DRAWN_KINDS = new Set([
  'box',
  'text',
  'image',
  'canvas',
  'textinput',
  'textarea',
  'svg',
]);

/** kind -> style names a registered element claims as its own semantics.
 * Filled by registry.js; read by `Node.semanticNames`, so a registered
 * element gets the exemption without subclassing the getter. */
export const CUSTOM_SEMANTIC_NAMES = new Map();

/** kind -> prop names a registered element claims the damage for itself.
 * Filled by registry.js, read by `Node.selfDamagedProps` — the same
 * arrangement as above, for the other declaration a scene-drawing element
 * makes (issue #301). */
export const CUSTOM_SELF_DAMAGED = new Map();

/**
 * The element `<ThemeProvider>` renders to carry its palette into the node
 * tree. Not one of `HOST_TYPES` and not documented as an element: the
 * provider is the API. What node it becomes depends on where it is written
 * (`createInstance`): inside a window it is a `<box>` that fills its parent —
 * directly inside one, a `ThemeBoxNode` that also hands nested windows on to
 * it — and at the root of the tree, above the windows, where nothing drawn
 * may be, a `ThemeScopeNode` that draws nothing and hands the palette to the
 * windows under it (nodes/scope.js).
 */
export const THEME_SCOPE = 'themescope';
