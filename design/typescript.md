# TypeScript: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/typescript.md](../docs/typescript.md), the reference, and keep
their original headings so code comments that cite them still resolve.

## Why a JSX runtime and not an augmentation

The usual way a library adds elements to JSX is to merge into React's
namespace:

```ts
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      window: WindowProps;
    }
  }
}
```

That cannot work here. Five element names — `text`, `image`, `canvas`,
`html`, `svg` — are also HTML or SVG element names, already declared by
`@types/react` with completely different props, and declaration merging
cannot replace an existing member:

```
Interface 'IntrinsicElements' incorrectly extends interface 'ReactX11Elements'.
  The types of 'text.ref' are incompatible between these types.
    Type 'Ref<SVGTextElement>' is not assignable to type 'Ref<DrawnNode>'.
```

So react-x11 provides its own JSX source instead — `react-x11/jsx-runtime`,
which re-exports React's actual runtime and carries a `JSX` namespace of its
own. That turns out to be the better answer regardless: the namespace holds
the X11 elements _and nothing else_, so

```tsx
<div /> // error: Property 'div' does not exist on type 'JSX.IntrinsicElements'
```

is caught at compile time rather than throwing at runtime. An augmentation
could never have done that, because `@types/react` declares every HTML and
SVG tag unconditionally.

## Keeping them honest

Hand-written declarations drift. `test/types/api.tsx` is compiled by
`npm run typecheck` — in CI alongside lint — and exercises the API the way
the examples do, including `@ts-expect-error` lines for things that must
_not_ compile:

```tsx
// @ts-expect-error — layout properties may not go in a state block
createStyles({ bad: { ':hover': { padding: 4 } } });
```

Those fail the build if the rejection stops happening, which is the half of
a type test that usually goes missing.

When you change a prop, change the declaration and add a line to that file.
