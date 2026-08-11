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
import {
  Node,
  BoxNode,
  intrinsicSize,
  CARET_BLINK_MS,
} from '../../src/node.js';
import type { MeasureConstraints } from '../../src/node.js';
import { XK_ESCAPE, XK_TAB } from '../../src/keysyms.js';
// the synthetic events, not the DOM's same-named globals
import type { KeyboardEvent, MouseEvent } from '../../src/types/events.js';
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
      codeeditor: {
        value?: string;
        style?: Style;
        // a third party declares the handlers it composes with, and gets the
        // synthetic event rather than the DOM's same-named one
        onKeyDown?: (ev: KeyboardEvent) => void;
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

// An element with behaviour of its own (#251): the default actions run after
// the app's handlers, and Tab is an ordinary key it may keep.
class EditorNode extends Node {
  private caretOn = false;
  private tabEscapes = false;

  constructor(props: Record<string, unknown>, app: never) {
    super('codeeditor', props, app);
    this.focusableByDefault = true;
    this.defaultCursor = 'text';
  }

  defaultKeyDown(ev: KeyboardEvent): void {
    if (ev.keysym === XK_ESCAPE) {
      this.tabEscapes = true;
      return;
    }
    if (ev.keysym === XK_TAB && !this.tabEscapes) {
      ev.preventDefault(); // mine: the focus cycle does not get this one
      return;
    }
    this.tabEscapes = false;
    const _typed: string = ev.key;
    void _typed;
  }

  defaultMouseDown(ev: MouseEvent): void {
    ev.capturePointer();
    const _button: number = ev.button;
    void _button;
  }

  defaultMouseDrag(_ev: MouseEvent): void {}

  defaultMouseUp(_ev: MouseEvent): void {}

  defaultFocus(): void {
    // the timer is node's; what this pins is the cadence it runs at
    const _every: number = CARET_BLINK_MS;
    this.caretOn = true;
    this.invalidate(false, this.abs, 'caret');
  }

  defaultBlur(): void {
    this.caretOn = false;
    this.invalidate(false, this.abs, 'caret');
  }
}

registerElement('codeeditor', {
  create: (props, app) => new EditorNode(props, app as never),
});

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
      {/* an app handler and the element's own behaviour, composed */}
      <codeeditor value="const x = 1" onKeyDown={(ev) => void ev.keysym} />
    </box>
  );
}

// @ts-expect-error — `data` is required on <sparkline>
const _missingData = <sparkline color="red" />;
// @ts-expect-error — a create() is not optional
registerElement('broken', { drawn: true });

export default Chart;
