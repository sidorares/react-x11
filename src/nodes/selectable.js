// The text an element answers for (#259) and being a selection surface: what
// a reader can select and copy out of a node, and the accessors every
// text-bearing element implements.

import { TextSelection } from '../textselection.js';

/** Text and selection, installed onto `Node.prototype` by node.js. */
export class NodeSelectable {
  // --- the text an element answers for (issue #259) ------------------------
  //
  // Four questions, in one index space and one coordinate space: characters
  // are **code points** (an emoji is one position, not two — the space ntk's
  // caret API speaks), and rectangles are in the owning window's coordinates,
  // the same ones `abs`, `contentBox()` and a mouse event's `x`/`y` are in.
  //
  // They are what a selection is made of, and the reason they are on `Node`
  // rather than on `<text>`: the selection service walks a subtree and asks,
  // so an element that answers them joins a document without core knowing it
  // exists. The defaults are the honest answers for an element with no text
  // — a `<box>` has none, and `null` says so rather than claiming an empty
  // string sits somewhere inside it.

  /** This element's text, or null when it has none — the string the three
   * accessors below index into. */
  textContent() {
    return null;
  }

  /** The character boundary nearest a point, in window coordinates. Clamps,
   * so a point past the end of the text answers with the end of it. */
  textIndexAt(x, y) {
    return 0;
  }

  /** Where a caret at this index would stand, in window coordinates — a
   * zero-width rect from the top of the glyphs to the bottom of them. */
  textCaretRect(index) {
    return null;
  }

  /**
   * The bands a highlight over `[start, end)` fills, in window coordinates:
   * one per line, and more than one on a line whose text changes direction
   * halfway across it. Empty when the range is empty or off the end.
   */
  textRangeRects(start, end) {
    return [];
  }

  /**
   * The part of this element's text the document selection covers, as
   * `{ start, end }` in code points, or null. An element that paints its own
   * text paints a band under it while this is set — `textRangeRects` gives
   * the rectangles and `selectionColor` the fill — and that is the whole of
   * taking part in a selection. `<text>` keeps no more state than this.
   */
  get selectionRange() {
    return this._selRange
      ? { start: this._selRange.start, end: this._selRange.end }
      : null;
  }

  /** What to fill `textRangeRects` with while `selectionRange` is set: the
   * surface's `selectionColor`, or the theme's accent tinted. */
  get selectionColor() {
    return this._selRange?.color ?? null;
  }

  // --- being a selection surface -------------------------------------------

  /** `selectable` arrived or left. `true` makes this element the surface a
   * drag inside it selects across; `false` opts its subtree out of the one
   * above it, and is read where the surface is looked up. */
  _syncSelectable(props) {
    const wanted = props.selectable === true;
    if (wanted === Boolean(this._textSelection)) return;
    if (wanted) {
      this._textSelection = new TextSelection(this);
      // The I-beam is what says the text here can be taken. A surface is
      // also a focus target — a11y.js reads the same prop — because Ctrl+C
      // is a keystroke and a keystroke has to arrive somewhere.
      this.defaultCursor ??= 'text';
    } else {
      this._textSelection.destroy();
      this._textSelection = null;
      if (this.defaultCursor === 'text') this.defaultCursor = undefined;
    }
  }

  /**
   * The document selection this element owns, or null: a snapshot of
   * `{ isCollapsed, text, ranges }`, not a live object.
   *
   * Named for the text rather than called `selection`, because a base class
   * that claims a plain noun claims it from every element built on it — and
   * `this.selection = ...` in a subclass constructor is then a TypeError
   * against a getter, which is a bad way to find out.
   */
  get textSelection() {
    const selection = this._textSelection;
    if (!selection) return null;
    return {
      isCollapsed: selection.isCollapsed,
      text: selection.text(),
      ranges: [...selection.ranges].map(([node, [start, end]]) => ({
        node,
        start,
        end,
      })),
    };
  }

  /** Select everything in this surface, and take PRIMARY with it. */
  selectAll() {
    this._textSelection?.selectAll();
    return this;
  }

  /** Drop the selection in this surface. PRIMARY is left where it is: the
   * text stays pasteable, which is what every other X client does. */
  clearSelection() {
    this._textSelection?.clear();
    return this;
  }

  /** What a copy would put on the clipboard. */
  selectedText() {
    return this._textSelection?.text() ?? '';
  }

  /** Set both ends by hand — `{ node, index }` each, indices in code points.
   * `setSelection(null)` is `clearSelection()`. */
  setSelection(anchor, focus = anchor) {
    this._textSelection?.setSelection(anchor, focus);
    return this;
  }

  /** Another surface is showing the app's selection now. */
  _selectionLost() {
    this._textSelection?.lost();
  }
}
