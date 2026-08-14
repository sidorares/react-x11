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
  Scrollable,
  intrinsicSize,
  CARET_BLINK_MS,
} from '../../src/node.js';
import type {
  A11yTextState,
  MeasureConstraints,
  TextStyle,
} from '../../src/node.js';
import type { Rect } from '../../src/types/nodes.js';
import { XK_ESCAPE, XK_TAB } from '../../src/keysyms.js';
// the synthetic events, not the DOM's same-named globals
import type {
  CompositionEvent,
  KeyboardEvent,
  MouseEvent,
} from '../../src/types/events.js';
import {
  isStyleProp,
  flattenStyle,
  createStyles,
  resolveTokens,
} from '../../src/style.js';
import type { Style } from '../../src/style.js';
import { ctrlChordLetter, keysymOf } from '../../src/keysyms.js';
import { closeEditMenu, editMenuOpen, openEditMenu } from '../../src/index.js';
import type { EditMenuActions } from '../../src/index.js';

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
      flow: {
        nodes: { id: string; x: number; y: number }[];
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
    // damage as a rect, and as the node itself — both are what the window
    // node collects, and `invalidate` is on every node, not just that one
    this.invalidate(false, this.abs, 'content');
    this.invalidate(false, this, 'content');
  }

  // The two accessors a drawing element reads (#254): where its content
  // goes, and the text style the cascade resolved for it — the second in
  // ntk's spelling, ready for `app.fonts.layout`.
  label(): string {
    const box: Rect = this.contentBox();
    const type: TextStyle = this.resolvedTextStyle();
    const _family: string = type.family;
    const _size: number = type.size;
    const _ink: string = type.color;
    void box.width;
    void _family;
    void _size;
    return _ink;
  }

  // The focus half of the same surface (#252): an element takes focus as a
  // click would, and reads where focus is.
  activate(): SparklineNode {
    if (!this.focused && !this.focusWithin)
      this.focus().invalidate(false, this);
    void this.contains(this.parent);
    return this.blur();
  }

  // A widget that answers a chord of its own reads the letter from keysyms
  // rather than copying the Shift rule.
  handleKey(ev: { keysym?: number; codepoint: number }): boolean {
    const letter: number | null = ctrlChordLetter(ev);
    return letter === keysymOf('d');
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
  private text = '';
  private caret = 0;

  constructor(props: Record<string, unknown>, app: never) {
    super('codeeditor', props, app);
    this.focusableByDefault = true;
    this.defaultCursor = 'text';
    // what it is when the application writes no `role` (#257)
    this.a11yRole = 'textbox';
  }

  // The accessibility seam (#257): the state a screen reader reads, the two
  // writes it may make, and the notification that ties them to the element's
  // own editing.
  a11yTextState(): A11yTextState {
    return {
      value: this.text,
      caret: this.caret,
      selectionStart: this.caret,
      selectionEnd: this.caret,
      editable: true,
      multiline: true,
      preedit: null,
    };
  }

  a11ySetSelection(_start: number, end: number): boolean {
    this.caret = end;
    this.notifyA11yTextChanged();
    return true;
  }

  a11yReplaceText(start: number, end: number, text: string): boolean {
    this.text = this.text.slice(0, start) + text + this.text.slice(end);
    this.caret = start + text.length;
    this.notifyA11yTextChanged();
    return true;
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
    // `key` is absent for a key that types nothing — a function key, and
    // every key an open composition took
    const _typed: string | undefined = ev.key;
    void _typed;
  }

  defaultComposition(ev: CompositionEvent): void {
    const _data: string = ev.data;
    void _data;
  }

  defaultMouseDown(ev: MouseEvent): void {
    ev.capturePointer();
    const _button: number = ev.button;
    void _button;
  }

  defaultMouseDrag(_ev: MouseEvent): void {}

  defaultMouseUp(_ev: MouseEvent): void {}

  // the standard edit menu, opened with this element's own verbs (#256)
  defaultContextMenu(ev: MouseEvent): void {
    openEditMenu(
      this,
      { x: ev.x, y: ev.y },
      {
        hasSelection: this.caretOn,
        canUndo: false,
        undo: () => {},
        cut: () => {},
        copy: () => {},
        paste: () => {},
        canSelectAll: true,
        selectAll: () => {},
      },
    );
    const _open: boolean = editMenuOpen(this);
    if (_open) closeEditMenu(this);
  }

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

// An element that scrolls pixels it painted (#253). The mixin brings the
// offsets, the bars and the keys; the override is the one number pair only
// this element knows.
class TerminalNode extends Scrollable(Node) {
  private rows: string[] = [];

  constructor(props: Record<string, unknown>, app: never) {
    super('miniterm', props, app);
  }

  isScroller(): boolean {
    return true;
  }

  measureScrollContent(): { width: number; height: number } {
    return { width: 400, height: this.rows.length * 16 };
  }

  paintContent(_ctx: unknown): void {
    // the offsets the mixin clamped, subtracted by the drawing itself
    const _x: number = this.scrollX;
    const _y: number = this.scrollY;
    void _x;
    void _y;
  }
}

// …and the chain on its own: two methods, no mixin, the shape the wheel's
// default action calls.
class TickerNode extends Node {
  private at = 0;

  constructor(props: Record<string, unknown>, app: never) {
    super('miniticker', props, app);
  }

  canScroll(_dx: number, dy: number): boolean {
    return Boolean(dy) && this.at < 400;
  }

  scrollBy(by: number | { x?: number; y?: number }): void {
    this.at += typeof by === 'number' ? by : (by.y ?? 0);
  }
}

registerElement('miniterm', {
  create: (props, app) => new TerminalNode(props, app as never),
  childrenAllowed: false,
});
registerElement('miniticker', {
  create: (props, app) => new TickerNode(props, app as never),
  childrenAllowed: false,
});

// An element that draws a whole scene into one node (#301): it reads the
// rect of the pass it is being painted for, and the damage for the props it
// diffs itself is its own to claim. Both shapes of the commit half are here
// so both compile; a real element picks the one that fits.
class FlowNode extends Node {
  constructor(props: Record<string, unknown>, app: never) {
    super('flow', props, app);
  }

  paintContent(_ctx: unknown): void {
    // null outside a paint and on an unbounded one, and both read the same:
    // nothing bounds you, draw the lot
    const damage: Rect | null = this.paintDamage();
    for (const box of this.routedBounds()) {
      if (damage && box.x > damage.x + damage.width) continue;
      void box;
    }
  }

  routedBounds(): Rect[] {
    return [this.contentBox()];
  }

  applyProps(
    next: Record<string, unknown>,
    prev: Record<string, unknown>,
  ): void {
    const before = prev ?? this.props;
    super.applyProps(next, prev);
    // …so the only claim for a drag step is the box that actually moved
    if (next.nodes !== before.nodes) this.invalidate(false, this.abs, 'props');
  }

  paintChanged(
    next: Record<string, unknown>,
    prev: Record<string, unknown>,
  ): boolean {
    const claimed: ReadonlySet<string> = this.selfDamagedProps;
    if (claimed.has('nodes') && next.nodes !== prev.nodes) return false;
    return super.paintChanged(next, prev);
  }
}

registerElement('flow', {
  create: (props, app) => new FlowNode(props, app as never),
  semanticNames: ['nodes'],
  selfDamagedProps: ['nodes'],
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
      <flow nodes={[{ id: 'a', x: 0, y: 0 }]} />
    </box>
  );
}

// a read-only surface offers only what it can do; the rows it left out are
// absent rather than greyed, which is what makes this shape the whole API
const readOnlyVerbs: EditMenuActions = {
  hasSelection: true,
  copy: () => {},
  selectAll: () => {},
};
void readOnlyVerbs;

// @ts-expect-error — `data` is required on <sparkline>
const _missingData = <sparkline color="red" />;
// @ts-expect-error — a create() is not optional
registerElement('broken', { drawn: true });

export default Chart;

// issue #259: an element that answers for its own text joins a `selectable`
// document — the four accessors and the range it paints, nothing else
class LogViewNode extends Node {
  constructor(props: Record<string, unknown>, app: never) {
    super('logview', props, app);
    // a log view is read-only: the document around it selects across it
    this.hasOwnSelection = false;
  }

  textContent(): string {
    return String(this.props.buffer ?? '');
  }

  textIndexAt(x: number, y: number): number {
    const box = this.contentBox();
    return Math.max(0, Math.round(x - box.x) + Math.round(y - box.y));
  }

  textCaretRect(index: number): Rect {
    const box = this.contentBox();
    return { x: box.x + index * 8, y: box.y, width: 0, height: 16 };
  }

  textRangeRects(start: number, end: number): Rect[] {
    const from = this.textCaretRect(start);
    const to = this.textCaretRect(end);
    return [
      { x: from.x, y: from.y, width: to.x - from.x, height: from.height },
    ];
  }

  paint(ctx: unknown): void {
    super.paint(ctx);
    const range = this.selectionRange;
    if (!range) return;
    const fill: string | null = this.selectionColor;
    void [this.textRangeRects(range.start, range.end), fill];
  }
}

void LogViewNode;
