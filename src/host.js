// `react-x11/host` — the seam a package that is not react-x11 uses to add
// a host element. See docs/extending.md for the node contract; this file is
// only the entry point.
export {
  registerElement,
  unregisterElement,
  registeredElements,
} from './registry.js';

import { DRAWN_KINDS as DRAWN } from './nodes.js';
import { registeredElements } from './registry.js';

const BUILT_IN = Object.freeze([
  'window',
  'popup',
  'box',
  'text',
  'image',
  'canvas',
  'textinput',
  'textarea',
  'svg',
  'glarea',
  'foreign',
]);

/** The built-in element names. A copy: the vocabulary grows through
 * `registerElement`, never by mutating this. */
export function hostTypes() {
  return [...BUILT_IN];
}

/** Every element name currently known, built-in and registered. */
export function knownElements() {
  return [...BUILT_IN, ...registeredElements()];
}

/** Kinds that lay out with yoga and paint into the owning window. A copy —
 * to add one, register the element with `drawn: true`. */
export function drawnKinds() {
  return [...DRAWN];
}
