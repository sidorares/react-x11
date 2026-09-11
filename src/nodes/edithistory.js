// Undo and redo for <textinput> and <textarea>: the history an edit is
// recorded into, run by run, capped at UNDO_LIMIT entries.

/** Undo entries kept per input. Snapshots of a single field are small; the
 * cap is what stops a long-lived form from growing without bound. */
const UNDO_LIMIT = 200;

/** Undo and redo, installed onto `TextInputNode.prototype` by textinput.js. */
export class TextInputHistory {
  // --- undo/redo ------------------------------------------------------
  //
  // Full-value snapshots rather than a diff log: a single field is small,
  // and a snapshot is the only representation that stays right when the
  // value is controlled and the parent rewrites what we send it. Each
  // entry also carries the caret from *before* the edit that produced it,
  // so undoing puts the caret back where the typing happened rather than
  // where the run ended.

  /** True while there is an earlier state to go back to. */
  get canUndo() {
    return this._historyIndex > 0;
  }

  /** True while an undone state is still ahead. */
  get canRedo() {
    return this._historyIndex < this._history.length - 1;
  }

  /** Step back one edit. Returns false when there is nothing to undo. */
  undo() {
    if (!this.canUndo) return false;
    const undone = this._history[this._historyIndex];
    const target = this._history[--this._historyIndex];
    // the caret goes where the undone edit started, not where it ended
    this._applyHistory(target.value, undone.beforeCaret, undone.beforeAnchor);
    return true;
  }

  /** Step forward one undone edit. False when there is nothing to redo. */
  redo() {
    if (!this.canRedo) return false;
    const target = this._history[++this._historyIndex];
    this._applyHistory(target.value, target.caret, target.anchor);
    return true;
  }

  /** End the coalescing run: the next edit starts a fresh undo entry. */
  _breakUndoRun() {
    this._undoRun = null;
  }

  _applyHistory(value, caret, anchor) {
    this._breakUndoRun();
    const previous = this.value;
    if (this.props.value == null) this._value = value;
    this._historyValue = value;
    const len = Array.from(value).length;
    this._caret = Math.min(Math.max(0, caret), len);
    this._anchor = Math.min(Math.max(0, anchor), len);
    if (value !== previous) this._fireValueEvent('onChange', value);
    this._repaint();
  }

  /**
   * Fold the edit into the open run, or start a new entry. A run continues
   * while the same kind of edit keeps happening at the caret it left off
   * at, so a word of typing — or a run of backspaces — undoes as one step.
   */
  _recordEdit(kind, entry) {
    const top = this._history[this._historyIndex];
    const continues =
      kind != null &&
      kind === this._undoRun &&
      // a replaced selection is a distinct edit, however it was typed
      entry.beforeCaret === entry.beforeAnchor &&
      top?.caret === entry.beforeCaret;
    if (continues) {
      top.value = entry.value;
      top.caret = entry.caret;
      top.anchor = entry.anchor;
    } else {
      this._pushHistory(kind, entry);
    }
    this._historyValue = entry.value;
  }

  _pushHistory(kind, entry) {
    // a fresh edit after an undo drops whatever was ahead
    this._history.length = this._historyIndex + 1;
    this._history.push(entry);
    if (this._history.length > UNDO_LIMIT) this._history.shift();
    this._historyIndex = this._history.length - 1;
    this._undoRun = kind;
  }

  /**
   * A controlled `value` that changed to something we did not commit was
   * edited outside the control — a form reset, or an onChange that filters
   * what it is given. It becomes its own history entry, so undo walks back
   * through states that really existed. The neighbour checks catch the
   * parent echoing an undo back at us, or refusing one: that moves through
   * the history instead of appending to it, which is what keeps a filtering
   * onChange from growing the stack on every keystroke.
   */
  _noteExternalValue() {
    const value = this.value;
    if (value === this._historyValue) return;
    this._breakUndoRun();
    if (this._history[this._historyIndex + 1]?.value === value) {
      this._historyIndex++;
    } else if (this._history[this._historyIndex - 1]?.value === value) {
      this._historyIndex--;
    } else {
      this._pushHistory(null, {
        value,
        caret: this._caret,
        anchor: this._anchor,
        beforeCaret: this._caret,
        beforeAnchor: this._anchor,
      });
    }
    this._historyValue = value;
  }
}
