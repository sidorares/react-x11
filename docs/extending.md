# Extending the element vocabulary

`<box>`, `<text>`, `<glarea>` and the rest are built in, but the list is not
closed. `registerElement()` adds an element from outside the package — a
`<sparkline>`, a tray icon, an XEMBED `<foreign>` — so a sibling package can
ship one without forking react-x11 and without the core growing.

```js
import { registerElement } from 'react-x11/host';
import { Node } from 'react-x11/node';

class SparklineNode extends Node {
  constructor(props, app) {
    super('sparkline', props, app); // the kind must be the element name
  }

  paint(ctx) {
    super.paint(ctx); // background, border, clip
    const { x, y, width, height } = this.abs;
    const data = this.props.data ?? [];
    const max = Math.max(1, ...data);
    ctx.beginPath();
    data.forEach((value, i) => {
      const px = x + (width * i) / Math.max(1, data.length - 1);
      const py = y + height - (height * value) / max;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.strokeStyle = this.props.color ?? '#000';
    ctx.stroke();
  }
}

registerElement('sparkline', {
  create: (props, app) => new SparklineNode(props, app),
  semanticNames: ['data', 'color'],
});
```

```jsx
<sparkline
  data={[1, 4, 2, 8]}
  color="#c0392b"
  style={{ width: 120, height: 40 }}
/>
```

Register before you render. The registry is consulted when an element is
first created, so a late registration only affects trees mounted after it.

## The definition

| field                         |                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `create(props, app, hostCtx)` | builds the node. `app` is the ntk connection — the second argument every built-in node constructor takes. Must return a `Node`.       |
| `drawn`                       | default `true`: lays out with yoga and paints into the owning window. `false` for a node that owns a real child X window (see below). |
| `semanticNames`               | prop names this element owns even though they are also style names                                                                    |
| `childrenAllowed`             | default `true`; `false` rejects children by name instead of laying out something that never paints                                    |
| `override`                    | replace an existing registration. Off by default — two packages claiming one name is a conflict worth hearing about                   |

Two of these exist because getting them wrong fails a long way from the
cause, so they are worth understanding rather than copying:

**`drawn` decides whether your element paints at all.** `paintOrder()`
filters children on the set of drawn kinds; a node missing from it lays out
correctly, reports a sensible `abs` rect, and never appears on screen, with
no error anywhere. `registerElement` puts you in that set unless you opt out.

**`semanticNames` is the difference between DEV and production.** react-x11
throws in development on `<box width={10} />`, because `width` is a style
property written flat — a real mistake with an unhelpful failure otherwise.
An element whose own vocabulary overlaps the style vocabulary (`width`,
`color`, `fontSize`) therefore has to say so, or it throws on its own props
in development and works in production. `<window width>` is the built-in
precedent: on a `<window>` it is the X window's width and never style.

`react-x11/style`'s `isStyleProp(name)` is how to check whether a name you
are about to use needs declaring.

## The node contract

`Node` already implements the whole reconciler-facing surface, so an element
that only draws needs a constructor and a `paint`. What you may override:

| method                         | when                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `paint(ctx)`                   | draw. Call `super.paint(ctx)` first for background, border and clip, then draw inside `this.abs`. |
| `applyProps(next, prev)`       | props changed. Call `super.applyProps(next, prev)`; invalidate if you cache anything derived.     |
| `hitTest(x, y)`                | non-rectangular hit areas. The default walks children in reverse paint order.                     |
| `insertBefore` / `removeChild` | only if children mean something structural to you                                                 |
| `destroySubtree()`             | release anything you allocated (pixmaps, fonts, timers). Call `super.destroySubtree()`.           |

And what you read:

- `this.props` — the current props, replaced wholesale on update.
- `this.style` — the flattened `style` prop with the active `:hover` /
  `:focus` / `:active` / `:disabled` blocks overlaid, and `$token`
  references already resolved against the theme. **Everything that paints or
  lays out reads this, never `props`.**
- `this.abs` — position and size within the owning window, valid after
  layout.
- `this.root` — the owning `<window>` node; `this.app` — the ntk connection.
- `this.theme` — the nearest theme at or above this node.

To ask for a repaint: `this.root?.invalidate(layout, rect, reason)`. Pass a
`rect` when you know what changed — an invalidation with no bound repaints
the whole window, which is this renderer's main performance bug class (see
[debugging.md](debugging.md)). `reason` joins the closed set the diagnostics
print.

### Elements that own a real X window

`drawn: false` is for a node backed by its own child X window rather than
painted into its parent — a GL surface, an XEMBED socket, a video overlay.
`GlAreaNode` (`src/glnodes.js`) is the worked example: it holds no paint
code, and the owning `WindowNode` realizes it in the commit phase
(`_realizeGlAreas`) so the child window names its real parent from the
start. Read those two together before writing a third one; the ordering
constraint — no X calls in the render phase, because the render phase is
discardable — is the part that is easy to get wrong.

## The subpath exports

| subpath             |                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `react-x11/host`    | `registerElement`, `unregisterElement`, `registeredElements`, `hostTypes`, `knownElements`, `drawnKinds` |
| `react-x11/node`    | `Node` and the built-in node classes                                                                     |
| `react-x11/style`   | `createStyles`, `flattenStyle`, `isStyleProp`, `resolveTokens`, the rest of the vocabulary               |
| `react-x11/ntk`     | ntk itself, re-exported                                                                                  |
| `react-x11/keysyms` | the `XK_*` constants                                                                                     |

**Reach ntk through `react-x11/ntk`, not a second dependency.** Two copies
of ntk in one process means two Yoga instances and two font caches, and a
node built against one cannot be painted by the other — a failure that
looks like a layout bug rather than a dependency bug.

## Typing

The element also has to be declared to JSX, which is module augmentation —
the same mechanism [typescript.md](typescript.md) describes:

```ts
import type { Style } from 'react-x11/style';

declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      sparkline: {
        data: number[];
        color?: string;
        style?: Style;
        ref?: React.Ref<unknown>;
      };
    }
  }
}
```

`test/types/extend.tsx` in this repo compiles exactly that, so the story
stays true as the declarations move.
