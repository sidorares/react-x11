/**
 * The JSX namespace for react-x11. Set
 *
 *   { "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "react-x11" } }
 *
 * and `<window>`, `<box>`, `<text>` … type-check, while `<div>` does not.
 *
 * This has to be a JSX *source* rather than an augmentation of React's own
 * namespace: five element names — `text`, `image`, `canvas`, `html`, `svg` —
 * also exist in `@types/react` as HTML or SVG elements with incompatible
 * props, and declaration merging cannot replace an existing member. Owning
 * the namespace is also what makes `<div>` an error here, which augmenting
 * could never do.
 */

import type * as React from 'react';
import type { ReactX11Elements } from './types/elements.js';

export { Fragment, jsx, jsxs } from 'react/jsx-runtime';

export namespace JSX {
  type ElementType = React.JSX.ElementType;
  type Element = React.JSX.Element;
  type ElementClass = React.JSX.ElementClass;
  type ElementAttributesProperty = React.JSX.ElementAttributesProperty;
  type ElementChildrenAttribute = React.JSX.ElementChildrenAttribute;
  type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<
    C,
    P
  >;
  type IntrinsicAttributes = React.JSX.IntrinsicAttributes;
  type IntrinsicClassAttributes<T> = React.JSX.IntrinsicClassAttributes<T>;

  /**
   * The X11 host elements — and only those. An interface so a project can
   * still declare extra elements of its own by merging into it.
   */
  interface IntrinsicElements extends ReactX11Elements {}
}
