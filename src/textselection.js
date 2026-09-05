// The selection a reader drags across a document (issue #259).
//
// Not the X selection — that is clipboard.js, and PRIMARY is where this ends
// up rather than what it is. This is the state: which characters of which
// elements are lit, what a copy assembles out of them, and the one rule that
// cannot live outside core — **only one selection on screen at a time**.
//
// Three things are worth knowing before reading the rest.
//
// **A surface is a `selectable` element, and its participants are whatever
// under it can answer for its own text.** An element joins by implementing
// the four accessors in nodes.js (`textContent`, `textIndexAt`,
// `textCaretRect`, `textRangeRects`) — `<text>` does, and so does a terminal
// or a log view written outside this package. There is no registration call
// and no list of blessed kinds: a document is a tree, and the tree is walked.
//
// **The separators a copy uses come from the layout, not from the markup.**
// Core cannot know that one `<text>` is a table cell and another is a
// paragraph, and asking applications to say so would be a second authoring
// model for something the screen already shows. So two participants that
// share a band of pixels are joined with a tab and one that starts below the
// last is joined with a newline — which is exactly "cells with tabs, rows
// with newlines" for a table, and plain paragraphs everywhere else.
//
// **Losing the selection is a message, not a poll.** `takeVisibleSelection`
// tells the previous owner it is no longer showing one, and `<textinput>`
// answers it too — so a drag across a document collapses the highlight in
// the field beside it, and vice versa, without either of them knowing the
// other exists.

import { callHandler } from './errors.js';
import { lastInputTime } from './inputtime.js';
import { ctrlChordLetter } from './keysyms.js';
import { codePoints, wordRangeAt } from './textrange.js';
// --- who is showing a selection ------------------------------------------
//
// One node per app: a `<textinput>`, or the surface below. The registry is
// what makes "two selectable surfaces cannot both claim the visible
// selection" a property of the system rather than of every surface's good
// behaviour — the loser is *told*, so it has nothing to check.

const owners = new WeakMap();

/** This node is now showing the app's selection. The previous owner, if it
 * was another node, is told to stop. */
export function takeVisibleSelection(node) {
  const app = node?.app;
  if (!app) return;
  const previous = owners.get(app);
  if (previous === node) return;
  owners.set(app, node);
  if (previous && !previous.destroyed) previous._selectionLost();
}

/** Give it up without telling anybody: the selection went away on its own. */
export function dropVisibleSelection(node) {
  const app = node?.app;
  if (app && owners.get(app) === node) owners.delete(app);
}

/** The node showing the app's selection, or null. */
export function visibleSelectionOwner(app) {
  const node = owners.get(app);
  if (!node) return null;
  if (node.destroyed) {
    owners.delete(app);
    return null;
  }
  return node;
}

// --- finding the surface --------------------------------------------------

/**
 * The selection this node's presses belong to: the nearest `selectable`
 * ancestor, or none at all once something on the way up has opted its
 * subtree out.
 *
 * `selectable={false}` is CSS's `user-select: none` and the reason it is
 * checked first: a button's label, a list's bullet or a table's chrome sits
 * inside a document and is not part of it.
 */
export function selectionSurfaceOf(node) {
  for (let n = node; n; n = n.parent) {
    if (n.props?.selectable === false) return null;
    // an editor answers its own presses; a document above it never sees them
    if (n.hasOwnSelection) return null;
    if (n._textSelection) return n._textSelection;
    if (n.isWindow) break;
  }
  return null;
}

/** Elements that answer for their own text, in document order, skipping
 * everything that has opted out and everything with a selection of its own. */
function participants(surface) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (child.props?.selectable === false) continue;
      // an editor keeps its own selection: a document around it does not get
      // to light up half a field the user is typing in
      if (child.hasOwnSelection) continue;
      if (child.hidden || child.style?.display === 'none') continue;
      // a nested surface owns its subtree, the way the nearest `selectable`
      // ancestor owns a press
      if (child._textSelection) continue;
      if (child.textContent?.() != null) out.push(child);
      else walk(child);
    }
  };
  walk(surface);
  return out;
}

/** How far a point is from a rect, as a score that ranks a miss on the wrong
 * line below any miss on the right one — dragging into the margin should
 * reach the paragraph beside the pointer, not the one it is nearest to. */
function distanceScore(rect, x, y) {
  const dy =
    y < rect.y
      ? rect.y - y
      : y > rect.y + rect.height
        ? y - rect.y - rect.height
        : 0;
  const dx =
    x < rect.x
      ? rect.x - x
      : x > rect.x + rect.width
        ? x - rect.x - rect.width
        : 0;
  return dy * 4096 + dx;
}

/**
 * Two participants on one line are cells; one that begins below the other is
 * a new row. Derived from the boxes rather than from the elements, because
 * the layout is the only thing here that knows which it is.
 */
function separatorBetween(previous, next) {
  const above = previous.abs;
  return next.abs.y >= above.y + above.height - 1 ? '\n' : '\t';
}

/**
 * The selection of one surface. Lives on the node as `_selection` and is
 * created by the `selectable` prop; everything public about it is reached
 * through the node (`node.selectAll()`, `node.selectedText()`, ...).
 */
export class TextSelection {
  constructor(node) {
    this.node = node;
    // { node, index } each, in code points — an unordered pair, because which
    // end moves is the whole difference between extending and starting over
    this.anchor = null;
    this.focus = null;
    // 'char' | 'word' | 'block', from the click count that started the drag.
    // Kept for the whole drag: a selection begun on a double click keeps
    // snapping to words as it grows, which is what every text view does.
    this.granularity = 'char';
    this.dragging = false;
    // node -> { start, end, color }, so a change can repaint what moved
    this.ranges = new Map();
  }

  // --- gestures ----------------------------------------------------------

  press(ev) {
    if (ev.button !== 1) return;
    const at = this.positionAt(...this.devicePoint(ev));
    if (!at) return;
    this.granularity =
      ev.detail >= 3 ? 'block' : ev.detail === 2 ? 'word' : 'char';
    // shift+click extends the selection that is already there, the way it
    // does in a field — the anchor stays where it was
    if (ev.shiftKey && this.anchor) this.focus = at;
    else {
      this.anchor = at;
      this.focus = at;
    }
    this.dragging = true;
    this.apply();
    // A word or a block is complete at the press: there is a selection on
    // screen before the button comes up, so PRIMARY has something to own
    // and the gesture has already answered.
    if (this.granularity !== 'char') this.own();
  }

  drag(ev) {
    if (!this.dragging) return;
    const at = this.positionAt(...this.devicePoint(ev));
    if (!at) return;
    this.focus = at;
    this.apply();
  }

  release() {
    if (!this.dragging) return;
    this.dragging = false;
    this.own();
  }

  /**
   * Ctrl+A and Ctrl+C, run as this element's default action — which is why a
   * surface is a focus target (a11y.js): the copy has to have somewhere to
   * arrive. Nothing else is bound. A read-only document has no caret, so
   * shift+arrows would be caret browsing, which is a mode rather than a
   * default.
   */
  keyDown(ev) {
    if (!ev.ctrlKey) return;
    const letter = ctrlChordLetter(ev);
    if (letter === 0x61 /* a */) {
      this.selectAll();
      ev.preventDefault();
    } else if (letter === 0x63 /* c */) {
      this.copy('CLIPBOARD');
      ev.preventDefault();
    }
  }

  /**
   * The pointer in the space `abs` and the four accessors are in — device
   * pixels (docs/scale.md). A synthetic event's `x`/`y` are logical, so on
   * a 2x panel they name a point half as far from the window's origin as the
   * pointer is: a press landed on the wrong character and a drag stopped
   * short at half its distance. The X event underneath already carries the
   * device numbers; an event synthesized without one is multiplied up, the
   * way every other pointer consumer in nodes.js does it.
   */
  devicePoint(ev) {
    const scale = this.node.scale > 0 ? this.node.scale : 1;
    return [
      ev.nativeEvent?.x ?? ev.x * scale,
      ev.nativeEvent?.y ?? ev.y * scale,
    ];
  }

  // --- the selection itself ----------------------------------------------

  /** The participant and index nearest a point in window coordinates —
   * device pixels, the unit `abs` and `textIndexAt` speak. */
  positionAt(x, y) {
    let best = null;
    let bestScore = Infinity;
    for (const node of participants(this.node)) {
      const score = distanceScore(node.abs, x, y);
      if (score < bestScore) {
        bestScore = score;
        best = node;
      }
    }
    if (!best) return null;
    return { node: best, index: best.textIndexAt(x, y) };
  }

  /** Anchor and focus in document order, resolved against the live tree, or
   * null when there is nothing selected (or an end has gone away). */
  ordered() {
    if (!this.anchor || !this.focus) return null;
    const nodes = participants(this.node);
    const ai = nodes.indexOf(this.anchor.node);
    const fi = nodes.indexOf(this.focus.node);
    if (ai < 0 || fi < 0) return null;
    const a = { at: ai, index: this.anchor.index };
    const f = { at: fi, index: this.focus.index };
    const forward = ai < fi || (ai === fi && a.index <= f.index);
    const [start, end] = forward ? [a, f] : [f, a];
    if (this.granularity === 'char') return { nodes, start, end };
    // A word- or block-granular drag snaps both ends outwards, so the
    // selection is always whole words even where the pointer is mid-word.
    const startChars = codePoints(nodes[start.at].textContent() ?? '');
    const endChars = codePoints(nodes[end.at].textContent() ?? '');
    if (this.granularity === 'block') {
      start.index = 0;
      end.index = endChars.length;
    } else {
      // The far end is probed one character back, because an index is a
      // boundary rather than a character: a focus that has just reached the
      // start of the next word belongs to the word it came from, which is
      // what a drag feels like. Unless there is nothing to come from — a
      // double click has both ends on the same boundary.
      const collapsed = end.at === start.at && end.index === start.index;
      const probe = collapsed ? end.index : Math.max(0, end.index - 1);
      start.index = wordRangeAt(startChars, start.index)[0];
      end.index = wordRangeAt(endChars, probe)[1];
    }
    return { nodes, start, end };
  }

  /** node -> [start, end) for everything the selection covers. */
  rangesOf(ordered) {
    const out = new Map();
    if (!ordered) return out;
    const { nodes, start, end } = ordered;
    for (let i = start.at; i <= end.at; i++) {
      const node = nodes[i];
      const length = codePoints(node.textContent() ?? '').length;
      const from = i === start.at ? start.index : 0;
      const to = i === end.at ? end.index : length;
      if (to > from) out.set(node, [from, to]);
    }
    return out;
  }

  get isCollapsed() {
    for (const [, [from, to]] of this.ranges) if (to > from) return false;
    return true;
  }

  /**
   * Push the ranges down to the elements that paint them, and repaint only
   * the ones whose range moved. Every route to a new selection ends here —
   * the drag, the keys, and the programmatic `setSelection`.
   */
  apply() {
    const color = this.node.props.selectionColor ?? this.node.theme.selection;
    const next = this.rangesOf(this.ordered());
    let changed = false;
    for (const [node, range] of next) {
      const before = node._selRange;
      if (before && before.start === range[0] && before.end === range[1]) {
        continue;
      }
      node._selRange = { start: range[0], end: range[1], color };
      node.invalidate(false, node, 'selection');
      // the same push a `<textinput>` makes when its selection moves: what
      // is lit is what a screen reader should be reading (#288's seam)
      node.notifyA11yTextChanged?.();
      changed = true;
    }
    for (const node of this.ranges.keys()) {
      if (next.has(node)) continue;
      changed = true;
      if (node.destroyed) continue;
      node._selRange = null;
      node.invalidate(false, node, 'selection');
      node.notifyA11yTextChanged?.();
    }
    this.ranges = next;
    if (!changed) return;
    if (this.isCollapsed) dropVisibleSelection(this.node);
    else takeVisibleSelection(this.node);
    const handler = this.node.props.onSelectionChange;
    if (handler) {
      callHandler(this.node, 'onSelectionChange', handler, {
        type: 'selectionChange',
        target: this.node,
        currentTarget: this.node,
        text: this.text(),
        isCollapsed: this.isCollapsed,
      });
    }
  }

  /** Everything in this surface, and PRIMARY with it — the same rule the
   * mouse gestures follow, and what makes a middle-click paste after Ctrl+A
   * paste what is on screen. */
  selectAll() {
    const nodes = participants(this.node);
    if (!nodes.length) return;
    const last = nodes[nodes.length - 1];
    this.granularity = 'char';
    this.anchor = { node: nodes[0], index: 0 };
    this.focus = {
      node: last,
      index: codePoints(last.textContent() ?? '').length,
    };
    this.apply();
    this.own();
  }

  clear() {
    this.anchor = null;
    this.focus = null;
    this.dragging = false;
    this.apply();
  }

  /** Set both ends by hand: `{ node, index }` each, in code points. */
  setSelection(anchor, focus) {
    this.granularity = 'char';
    this.anchor = anchor ? { ...anchor } : null;
    this.focus = focus ? { ...focus } : anchor ? { ...anchor } : null;
    this.apply();
  }

  /**
   * What a copy puts on the clipboard. Each participant contributes the code
   * points the selection covers, joined by what the layout says they are —
   * see `separatorBetween`.
   */
  text() {
    const ordered = this.ordered();
    if (!ordered) return '';
    const ranges = this.rangesOf(ordered);
    let out = '';
    let previous = null;
    for (const [node, [from, to]] of ranges) {
      if (previous) out += separatorBetween(previous, node);
      out += codePoints(node.textContent() ?? '')
        .slice(from, to)
        .join('');
      previous = node;
    }
    return out;
  }

  /** Take PRIMARY, which in X is what "there is a selection here" means to
   * every other application on the display. */
  own() {
    if (this.isCollapsed) return;
    takeVisibleSelection(this.node);
    this.copy('PRIMARY');
  }

  copy(selection) {
    const text = this.text();
    if (!text) return;
    const clipboard = this.node.app?.clipboard;
    if (!clipboard) return; // ntk < 5.4.0: no selection machinery to take
    clipboard
      // ICCCM 2.1: stamped with the input that caused the copy, so a race
      // with another client copying at the same moment is orderable
      .write(text, { selection, time: lastInputTime(this.node.app) })
      .catch((err) => {
        console.warn(
          `react-x11: could not take the ${selection} selection: ${err?.message ?? err}`,
        );
      });
  }

  /** Somebody else is showing the app's selection now. */
  lost() {
    if (!this.anchor && !this.focus) return;
    this.anchor = null;
    this.focus = null;
    this.dragging = false;
    this.apply();
  }

  destroy() {
    dropVisibleSelection(this.node);
    for (const node of this.ranges.keys()) {
      if (!node.destroyed) {
        node._selRange = null;
        node.invalidate(false, node, 'selection');
      }
    }
    this.ranges = new Map();
    this.anchor = null;
    this.focus = null;
  }
}
