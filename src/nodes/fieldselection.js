// A field's selection, read and set from outside it: `selectionStart`,
// `selectionEnd`, `selectionDirection`, `setSelectionRange()` and
// `select()`, the DOM's names on the node, for <textinput> and <textarea>
// alike. What a copy-link box, a search field that selects on focus, an
// input mask or an emoji picker does through a DOM input's, an application
// does through the ref — and `@react-x11/components`' `<Html>` does for the
// page's scripts, on the field it mounts for an `<input>`.
//
// Two things here are decisions rather than accidents.
//
// **The offsets are UTF-16 code units**, as the DOM's are, where the rest of
// the field counts code points (textrange.js). Code that reads them slices
// `value` with them — `value.slice(selectionStart, selectionEnd)` is what is
// selected, `value.slice(0, start) + emoji + value.slice(end)` is an insert
// at the caret — and a JavaScript string is indexed in code units, so an
// offset in code points is one short for every emoji before it. An offset
// that falls between the two halves of a surrogate pair is taken to the
// character's start, as `codePointAtOffset` rounds.
//
// **A selection set from outside is not the user's.** It is the field's
// selection in every way an edit can tell — it is drawn while the field has
// the focus, Backspace deletes it, typing replaces it, Shift+arrow extends
// it — but it does not take PRIMARY. On X11 PRIMARY is what the user last
// selected, for a middle-click to paste somewhere else, and a field that a
// script selects on focus would otherwise replace it every time it is
// tabbed into, with a timestamp no user event gave (ICCCM 2.1). It does
// take the visible selection, where it is drawn: one lit range on screen at
// a time (textselection.js).

import { codePointAtOffset, codeUnitOffsets } from '../textrange.js';
import { takeVisibleSelection } from '../textselection.js';

/** The selection API, installed onto `TextInputNode.prototype` by
 * textinput.js. */
export class TextInputSelection {
  /** The offset, in UTF-16 code units, where the selection starts — the
   * caret's, where nothing is selected. */
  get selectionStart() {
    return this._unitOffset(this._selection()[0]);
  }

  /** As the DOM's: the end moves with the start where the start passes it. */
  set selectionStart(start) {
    const at = this._clampUnits(start);
    this.setSelectionRange(
      at,
      Math.max(at, this.selectionEnd),
      this.selectionDirection,
    );
  }

  /** The offset, in UTF-16 code units, where the selection ends. */
  get selectionEnd() {
    return this._unitOffset(this._selection()[1]);
  }

  /** As the DOM's: the start moves back to the end where the end is put
   * before it. */
  set selectionEnd(end) {
    this.setSelectionRange(
      this.selectionStart,
      this._clampUnits(end),
      this.selectionDirection,
    );
  }

  /**
   * Which end the caret is at: `'backward'` where it is at the start,
   * `'forward'` where it is at the end, and `'none'` for a bare caret. A
   * direction set through `setSelectionRange` reads back as it was set —
   * `'none'` included, over a range — until the user moves either end.
   */
  get selectionDirection() {
    const set = this._directionSet;
    if (set && set.caret === this._caret && set.anchor === this._anchor) {
      return set.direction;
    }
    if (this._caret < this._anchor) return 'backward';
    if (this._caret > this._anchor) return 'forward';
    return 'none';
  }

  set selectionDirection(direction) {
    this.setSelectionRange(this.selectionStart, this.selectionEnd, direction);
  }

  /**
   * Select `[start, end)`, in UTF-16 code units, as a DOM input's
   * `setSelectionRange` does: each end clamped to the value, a start past
   * the end moved back to it, and the caret at the end — or, for
   * `'backward'`, at the start, so Shift+Left goes on from there. Equal
   * offsets put a bare caret. An open composition is left where it is.
   */
  setSelectionRange(start, end, direction = 'none') {
    const to = this._clampUnits(end);
    const from = Math.min(this._clampUnits(start), to);
    const offsets = codeUnitOffsets(this.value);
    const a = codePointAtOffset(offsets, from);
    const b = codePointAtOffset(offsets, to);
    const backward = direction === 'backward';
    this._anchor = backward ? b : a;
    this._caret = backward ? a : b;
    this._directionSet = {
      direction: backward || direction === 'forward' ? direction : 'none',
      caret: this._caret,
      anchor: this._anchor,
    };
    // typing that resumes at the new caret is a new edit, as after a click
    this._breakUndoRun();
    if (a !== b && this._focused) takeVisibleSelection(this);
    this._repaint();
  }

  /** Select the whole value, as a DOM input's `select()` does. */
  select() {
    this.setSelectionRange(0, this.value.length);
  }

  /** A code-point index in the value as a UTF-16 offset. */
  _unitOffset(index) {
    const offsets = codeUnitOffsets(this.value);
    return offsets[Math.min(Math.max(0, index), offsets.length - 1)];
  }

  /** A UTF-16 offset from outside, as a whole number inside the value:
   * NaN is 0, a fraction is cut, and either side of the value is its end. */
  _clampUnits(offset) {
    const n = Math.trunc(Number(offset));
    if (Number.isNaN(n)) return 0;
    return Math.min(Math.max(0, n), this.value.length);
  }
}
