/** Development counterpart of jsx-runtime.d.ts — the same JSX namespace. */

import type * as React from 'react';
import type { ReactX11Elements } from './types/elements.js';

export { Fragment, jsxDEV } from 'react/jsx-dev-runtime';

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
  interface IntrinsicElements extends ReactX11Elements {}
}
