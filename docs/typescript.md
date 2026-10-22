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

react-x11 cannot merge its elements into React's `JSX` namespace: `text`,
`image`, `canvas`, `html` and `svg` are already declared there by
`@types/react` with DOM props, and declaration merging cannot replace them.
So `react-x11/jsx-runtime` re-exports React's runtime with a `JSX` namespace
of its own that holds the react-x11 elements _and nothing else_:

```tsx
<div /> // error: Property 'div' does not exist on type 'JSX.IntrinsicElements'
```

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
| `src/types/nodes.d.ts`      | what a `ref` gives you: `DrawnNode`, `ScrollableNode`, ntk's `Window`         |
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

Design notes: [design/typescript.md](../design/typescript.md).
