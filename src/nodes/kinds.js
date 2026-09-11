// The kind tables. registry.js fills them when an element registers, and
// the node classes read them — that direction, rather than the nodes
// importing the registry, is what keeps the two acyclic.

/**
 * Kinds that lay out with yoga and paint into the owning window —
 * `paintOrder` filters on this, so a kind missing from it lays out and
 * never paints. Mutable because `registerElement` (registry.js) adds to it;
 * that direction, rather than nodes.js importing the registry, is what
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
