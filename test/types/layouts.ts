/**
 * Type tests for the two registration seams in react-x11/host — a layout and
 * a position of your own — and the augmentation that makes their names and
 * options part of `Style`. Compiled by `npm run typecheck`, never run.
 */
import {
  registerLayout,
  registerPosition,
  registeredLayouts,
  registeredPositions,
  type LayoutChild,
  type LayoutConstraints,
} from 'react-x11/host';
import type { Style } from 'react-x11';

declare module 'react-x11/host' {
  interface CustomLayouts {
    radial: { radius?: number };
  }
  interface CustomPositions {
    parallax: { rate?: number };
  }
}

registerLayout('radial', {
  options: { radius: { type: 'length', default: 80 } },
  layout(children: readonly LayoutChild[], c: LayoutConstraints, { radius }) {
    const step = (2 * Math.PI) / Math.max(1, children.length);
    const rects = children.map((child, i) => {
      const size = child.measure();
      return {
        x: c.width / 2 + radius * Math.cos(i * step) - size.width / 2,
        y: c.height / 2 + radius * Math.sin(i * step) - size.height / 2,
      };
    });
    return { width: c.width, height: c.height, children: rects };
  },
});

registerPosition('parallax', {
  options: { rate: { type: 'number', default: 0.5 } },
  place: (node, { pane, options }) =>
    pane ? { x: 0, y: Math.round(pane.scrollY * options.rate) } : null,
});

const names: string[] = [...registeredLayouts(), ...registeredPositions()];

const styles: Style[] = [
  { layout: 'radial' },
  { layout: { name: 'radial', radius: 40 } },
  { position: 'parallax' },
  { position: { name: 'parallax', rate: 0.25 } },
  { position: 'sticky', top: 0 },
];

// @ts-expect-error — radial has no `columns`
const wrong: Style = { layout: { name: 'radial', columns: 2 } };

registerLayout('unplaced', {
  // @ts-expect-error — a rect needs its y
  layout: () => ({ width: 0, height: 0, children: [{ x: 0 }] }),
});

void names;
void styles;
void wrong;
