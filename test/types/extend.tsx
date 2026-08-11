/**
 * Type tests for the extension surface (#125). Not run — compiled. The
 * point of the file is that the module-augmentation story in
 * docs/typescript.md and docs/extending.md stays true: a third party can
 * declare its own element to JSX and get it type-checked.
 */
import React from 'react';
import {
  registerElement,
  unregisterElement,
  registeredElements,
  hostTypes,
  knownElements,
  drawnKinds,
} from '../../src/host.js';
import { Node, BoxNode, intrinsicSize } from '../../src/node.js';
import type { MeasureConstraints } from '../../src/node.js';
import {
  isStyleProp,
  flattenStyle,
  createStyles,
  resolveTokens,
} from '../../src/style.js';
import type { Style } from '../../src/style.js';

// The element, declared to JSX exactly as docs/extending.md shows.
declare module '../../src/jsx-runtime.js' {
  namespace JSX {
    interface IntrinsicElements {
      sparkline: {
        data: number[];
        color?: string;
        style?: Style;
      };
      gauge: {
        ticks?: number;
        style?: Style;
      };
      thumb: {
        style?: Style;
      };
    }
  }
}

class SparklineNode extends Node {
  constructor(props: Record<string, unknown>, app: never) {
    super('sparkline', props, app);
  }

  paint(ctx: unknown): void {
    super.paint(ctx);
    // the subclass surface docs/extending.md promises
    const _rect: number = this.abs.width;
    const _kind: string = this.kind;
    const _destroyed: boolean = this.destroyed;
    void this.style;
    void this.theme;
    void this.props.data;
    void this.app;
    this.invalidate(false, this.abs, 'content');
  }
}

registerElement('sparkline', {
  create: (props, app) => new SparklineNode(props, app as never),
  drawn: true,
  semanticNames: ['data', 'color'],
  childrenAllowed: false,
});

// An element with a size of its own (#250): the modes are words, the offer is
// a number, and nothing here names yoga.
class GaugeNode extends Node {
  constructor(props: Record<string, unknown>, app: never) {
    super('gauge', props, app);
  }

  measureContent({ width, widthMode }: MeasureConstraints): {
    width: number;
    height: number;
  } {
    const ticks = Number(this.props.ticks ?? 4);
    const _mode: 'exactly' | 'at-most' | 'unconstrained' = widthMode;
    return { width: Math.min(ticks * 30, width), height: 24 };
  }

  applyProps(
    next: Record<string, unknown>,
    prev: Record<string, unknown>,
  ): void {
    const before = prev ?? this.props;
    super.applyProps(next, prev);
    if (next.ticks !== before.ticks) this.invalidateMeasure();
  }
}

// …and the aspect-ratio recipe, which is `<image>`'s own measurement.
class ThumbNode extends Node {
  constructor(props: Record<string, unknown>, app: never) {
    super('thumb', props, app);
  }

  measureContent(constraints: MeasureConstraints) {
    return intrinsicSize({ width: 400, height: 100 }, constraints);
  }
}

registerElement('gauge', {
  create: (props, app) => new GaugeNode(props, app as never),
  semanticNames: ['ticks'],
});
registerElement('thumb', {
  create: (props, app) => new ThumbNode(props, app as never),
});

// the minimum: a create() and nothing else
registerElement('minimal', {
  create: (props, app) => new BoxNode(props, app),
});

const _removed: boolean = unregisterElement('minimal');
const _registered: string[] = registeredElements();
const _built: string[] = hostTypes();
const _known: string[] = knownElements();
const _drawn: string[] = drawnKinds();

// the style vocabulary, from outside
const _isStyle: boolean = isStyleProp('color');
const _flat = flattenStyle([{ width: 10 }, { height: 20 }]);
const _w: number | string | undefined = _flat.width;
const styles = createStyles({ chart: { width: 120, height: 40 } });
void resolveTokens(styles.chart, { accent: '#c0392b' });

function Chart() {
  return (
    <box style={styles.chart}>
      <sparkline data={[1, 4, 2, 8]} color="#c0392b" style={{ flexGrow: 1 }} />
      <gauge ticks={6} />
      <thumb />
    </box>
  );
}

// @ts-expect-error — `data` is required on <sparkline>
const _missingData = <sparkline color="red" />;
// @ts-expect-error — a create() is not optional
registerElement('broken', { drawn: true });

export default Chart;
