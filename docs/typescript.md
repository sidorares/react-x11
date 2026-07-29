# TypeScript

Types ship with the package. There is no `@types/react-x11`, and nothing to
build — the declarations are hand-written `.d.ts` files next to the
JavaScript they describe.

## Setup

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react-x11",
    "moduleResolution": "bundler", // or "node16" / "nodenext"
  },
}
```

`jsxImportSource` is the whole configuration. Without it JSX resolves
against React's namespace, which describes the DOM.

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

If you need extra elements of your own, `IntrinsicElements` is an interface,
so merging still works:

```ts
declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      'my-element': { value?: number };
    }
  }
}
```

## What is typed

|                             |                                                                               |
| --------------------------- | ----------------------------------------------------------------------------- |
| `src/types/style.d.ts`      | `Style`, `StyleProp`, the yoga enums, state blocks, transitions, size queries |
| `src/types/events.d.ts`     | `SyntheticEvent` and the mouse / wheel / keyboard / focus shapes              |
| `src/types/nodes.d.ts`      | what a `ref` gives you: `DrawnNode`, `ScrollViewNode`, ntk's `Window`         |
| `src/types/elements.d.ts`   | every host element's props, including the 3D scene                            |
| `src/types/components.d.ts` | the widget set, `Theme`, the anchoring helpers                                |
| `src/index.d.ts`            | the entry: `createRoot`, `render`, and re-exports of the above                |

A few deliberate looseness decisions:

- **`Color` is `string`.** It is a CSS colour or a `$token` resolved against
  the nearest `theme`; narrowing it would reject valid values without
  catching much.
- **`ctx` and `gl` are `any`.** They are ntk's 2d context and its indirect
  GLX context, and ntk ships no types. Typing them here would mean
  maintaining a second, drifting copy of ntk's API.
- **`Renderer` is `any`.** It is the react-reconciler instance, an escape
  hatch rather than a supported surface.

Style values are as precise as the runtime is: `flexDirection` only takes
the four yoga values, a state block only takes paint properties (the same
rule `createStyles` enforces at runtime), and `width` takes
`number | '50%' | 'auto'`.

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
