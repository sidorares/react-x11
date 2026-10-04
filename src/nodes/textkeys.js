// The Mac's text-editing keys for <textinput> and <textarea>, and the caret
// geometry they move by: the ends of a line, of a paragraph and of the
// value, and a line up or down.
//
// The bindings are AppKit's own (StandardKeyBinding.dict, the table every
// Cocoa field reads): ⌥ moves and deletes by word, ⌘ goes to the ends of the
// line and of the document, ⌘⌫ deletes to the start of the line, and ⌃ is
// the Emacs set — ⌃A and ⌃E to the ends of the paragraph, ⌃K kills to its
// end and ⌃Y yanks it back. They apply where the app's shortcuts are pressed
// with ⌘ (`app.primaryModifier`, the Cocoa app), which is a fact about the
// backend rather than the platform: an X11 app under XQuartz is an X client
// and keeps the bindings in textinput.js's `_editKeyDown` — GTK's, Qt's and
// Windows', where Ctrl moves by word. The two sets disagree about Ctrl
// outright, which is why the Mac's are not a layer over the others: ⌃← is
// the start of the line here and a word there, and ⌃A is the start of the
// paragraph here and Select All there.
//
// Directions are logical, as the rest of the field's keys are: ← is towards
// the start of the value, also in a right-to-left field.

import {
  ctrlChordLetter,
  primaryModifier,
  XK_BACKSPACE,
  XK_DELETE,
  XK_DOWN,
  XK_LEFT,
  XK_RIGHT,
  XK_UP,
} from '../keysyms.js';

/** A chord a Mac field answers by doing nothing — and typing nothing. */
const NOTHING = 'noop';

/**
 * The AppKit command a key is bound to in a Mac text field — the selector's
 * name without the colon or `AndModifySelection`, since Shift is the
 * `extend` the command runs with — `NOTHING` for a chord the field types
 * nothing for, or null for a key the field's own handling covers: typing, a
 * plain arrow, Return, Tab, a ⌘ chord (Undo, Copy and the rest), and every
 * ⌃ chord the Mac does not bind, which `_editKeyDown` types nothing for.
 */
function macBinding(ev) {
  const cmd = ev.metaKey;
  const ctrl = ev.ctrlKey;
  const opt = ev.altKey;
  switch (ev.keysym) {
    case XK_LEFT:
    case XK_RIGHT: {
      const left = ev.keysym === XK_LEFT;
      // ⌘⌃← sets the paragraph's writing direction, which a field leaves
      // to its `direction` style
      if (cmd && ctrl) return NOTHING;
      // ⌃← is Mission Control's before it is the field's, and when the
      // system lets it through AppKit binds it beside ⌘←, not to a word
      if (cmd || ctrl) {
        return left ? 'moveToLeftEndOfLine' : 'moveToRightEndOfLine';
      }
      if (opt) return left ? 'moveWordLeft' : 'moveWordRight';
      return null;
    }
    case XK_UP:
    case XK_DOWN: {
      const up = ev.keysym === XK_UP;
      if (cmd) return up ? 'moveToBeginningOfDocument' : 'moveToEndOfDocument';
      // ⌃↑ scrolls a page without moving the caret, when Mission Control
      // has not taken it
      if (ctrl) return NOTHING;
      if (opt) return up ? 'moveParagraphBackward' : 'moveParagraphForward';
      return up ? 'moveUp' : 'moveDown';
    }
    case XK_BACKSPACE:
      if (opt) return 'deleteWordBackward'; // ⌥⌫, and ⌥⌃⌫
      if (cmd) return 'deleteToBeginningOfLine';
      if (ctrl) return 'deleteBackwardByDecomposingPreviousCharacter';
      return null;
    case XK_DELETE:
      if (opt) return 'deleteWordForward';
      if (ctrl) return 'deleteForward';
      return null;
  }
  // ⌃ and a letter: the Emacs set
  if (!ctrl || cmd || opt) return null;
  switch (ctrlChordLetter(ev)) {
    case 0x61 /* a */:
      return 'moveToBeginningOfParagraph';
    case 0x65 /* e */:
      return 'moveToEndOfParagraph';
    case 0x62 /* b */:
      return 'moveBackward';
    case 0x66 /* f */:
      return 'moveForward';
    case 0x70 /* p */:
      return 'moveUp';
    case 0x6e /* n */:
      return 'moveDown';
    case 0x68 /* h */:
      return 'deleteBackward';
    case 0x64 /* d */:
      return 'deleteForward';
    case 0x6b /* k */:
      return 'deleteToEndOfParagraph';
    case 0x79 /* y */:
      return 'yank';
  }
  return null;
}

/**
 * What ⌃K killed, per application: AppKit's kill buffer, which is its own
 * and not the pasteboard — a kill does not replace what ⌘C copied, and ⌃Y
 * in one field yanks what ⌃K killed in another.
 */
const killBuffers = new WeakMap();
const NO_APP = {};

/** Mac text keys for `TextInputNode`, installed by textinput.js. */
export class TextInputKeys {
  /**
   * The Mac binding for this key, run, ahead of `_editKeyDown`. Answers
   * whether the field took the key, as `_editKeyDown` does — false for a
   * chord the field types nothing for — and undefined where the key is not
   * a Mac binding, or this app does not edit with them.
   */
  _macKeyDown(ev) {
    // the Mac's keys go with the Mac's shortcuts, read off the app on every
    // key rather than cached, like every capability an app object carries
    if (primaryModifier(this.app) !== 'Super') return undefined;
    const command = macBinding(ev);
    if (command == null) return undefined;
    if (command === NOTHING) return false;
    this._runTextCommand(command, Boolean(ev.shiftKey));
    return true;
  }

  /** One AppKit editing command; `extend` keeps the anchor where it is. */
  _runTextCommand(command, extend) {
    const [a, b] = this._selection();
    const hasSelection = a !== b;
    const caret = this._caret;
    const length = this._chars().length;
    const move = (index) => this._moveCaret(index, extend);
    switch (command) {
      case 'moveBackward':
        return move(!extend && hasSelection ? a : caret - 1);
      case 'moveForward':
        return move(!extend && hasSelection ? b : caret + 1);
      case 'moveWordLeft':
        return move(this._wordBoundary(caret, -1));
      case 'moveWordRight':
        return move(this._wordBoundary(caret, 1));
      case 'moveToLeftEndOfLine':
        return move(this._lineEdge(caret, -1));
      case 'moveToRightEndOfLine':
        return move(this._lineEdge(caret, 1));
      case 'moveToBeginningOfParagraph':
        return move(this._paragraphEdge(caret, -1));
      case 'moveToEndOfParagraph':
        return move(this._paragraphEdge(caret, 1));
      // ⌥↑ is AppKit's (moveBackward:, moveToBeginningOfParagraph:): a caret
      // already at the start of a paragraph goes on to the previous one's
      case 'moveParagraphBackward':
        return move(
          this._paragraphEdge(!extend && hasSelection ? a : caret - 1, -1),
        );
      case 'moveParagraphForward':
        return move(
          this._paragraphEdge(!extend && hasSelection ? b : caret + 1, 1),
        );
      case 'moveToBeginningOfDocument':
        return move(0);
      case 'moveToEndOfDocument':
        return move(length);
      case 'moveUp':
        return move(this._verticalStep(-1));
      case 'moveDown':
        return move(this._verticalStep(1));
    }
    if (hasSelection && command !== 'yank') {
      if (command === 'deleteToEndOfParagraph') this._kill(a, b);
      else this._deleteRange(a, b);
      return;
    }
    switch (command) {
      case 'deleteBackward':
        if (caret > 0) this._deleteRange(caret - 1, caret, 'delete-back');
        return;
      case 'deleteForward':
        if (caret < length) {
          this._deleteRange(caret, caret + 1, 'delete-forward');
        }
        return;
      case 'deleteWordBackward':
        return this._deleteRange(this._wordBoundary(caret, -1), caret);
      case 'deleteWordForward':
        return this._deleteRange(caret, this._wordBoundary(caret, 1));
      case 'deleteToBeginningOfLine':
        return this._deleteRange(this._lineEdge(caret, -1), caret);
      case 'deleteToEndOfParagraph': {
        // at the end of a paragraph, the kill takes the line break, which
        // joins the next paragraph to this one — Emacs's ⌃K, and AppKit's
        const end = this._paragraphEdge(caret, 1);
        this._kill(caret, end > caret ? end : Math.min(caret + 1, length));
        return;
      }
      case 'deleteBackwardByDecomposingPreviousCharacter':
        return this._deleteDecomposing(caret);
      case 'yank': {
        const text = killBuffers.get(this.app ?? NO_APP)?.text;
        if (text) this._insert(text);
        return;
      }
    }
  }

  /**
   * Delete `[from, to)` into the kill buffer. Kills one after another — ⌃K,
   * ⌃K, with nothing in between — add up, so the two that take a line and
   * then its break yank back as the line.
   *
   * A `sensitive` field deletes and keeps nothing, for the reason it offers
   * no Copy: the text would outlive the field.
   */
  _kill(from, to) {
    if (to <= from) return;
    const chars = this._chars();
    const killed = chars.slice(from, to).join('');
    // What the kill leaves, worked out rather than read back: a controlled
    // field's `value` is the parent's until it re-renders.
    const left = [...chars.slice(0, from), ...chars.slice(to)].join('');
    const key = this.app ?? NO_APP;
    const buffer = killBuffers.get(key);
    const last = this._lastKill;
    const appends =
      buffer != null &&
      last?.buffer === buffer &&
      last.value === this.value &&
      last.caret === from;
    this._deleteRange(from, to);
    if (this.props.sensitive) return;
    const next = { text: appends ? buffer.text + killed : killed };
    killBuffers.set(key, next);
    this._lastKill = { buffer: next, value: left, caret: from };
  }

  /**
   * ⌃⌫: take the last mark off the character before the caret — `é` back to
   * `e` — and delete the character only when it has none.
   */
  _deleteDecomposing(caret) {
    if (caret === 0) return;
    const chars = this._chars();
    const parts = Array.from(chars[caret - 1].normalize('NFD'));
    if (parts.length < 2) {
      this._deleteRange(caret - 1, caret, 'delete-back');
      return;
    }
    const left = Array.from(parts.slice(0, -1).join('').normalize('NFC'));
    this._commit(
      [...chars.slice(0, caret - 1), ...left, ...chars.slice(caret)],
      caret - 1 + left.length,
    );
  }

  /** The start (`dir` < 0) or end of the paragraph `index` is in: the
   * value's ends in a single line, a line break's two sides in a textarea. */
  _paragraphEdge(index, dir) {
    const chars = this._chars();
    let i = Math.min(Math.max(0, index), chars.length);
    if (dir < 0) {
      while (i > 0 && chars[i - 1] !== '\n') i--;
    } else {
      while (i < chars.length && chars[i] !== '\n') i++;
    }
    return i;
  }

  /** The start or end of the line `index` is on as it is drawn. One line
   * here; a textarea's wraps. */
  _lineEdge(index, dir) {
    return this._paragraphEdge(index, dir);
  }

  /** Where ↑ and ↓ take the caret: in a single line, as in an NSTextField,
   * to its start and its end. */
  _verticalStep(dir) {
    return dir < 0 ? 0 : this._chars().length;
  }
}

/** Mac text keys for `TextAreaNode`, installed by textarea.js. */
export class TextAreaKeys {
  /** ↑ and ↓ keep the goal column they set; every other command is a fresh
   * start, as every other key is in `_editKeyDown`. */
  _runTextCommand(command, extend) {
    if (command !== 'moveUp' && command !== 'moveDown') this._goalX = null;
    return super._runTextCommand(command, extend);
  }

  /** The wrapped line's ends, as Home and End find them. */
  _lineEdge(index, dir) {
    const layout = this._valueLayout();
    if (!layout || this.value.length === 0) {
      return super._lineEdge(index, dir);
    }
    const pos = layout.caretPosition(index);
    const line = layout.lines[pos.line];
    const y = line.y + (line.ascent + line.descent) / 2;
    // indexAt clamps into the line: far left = line start; just past the
    // right edge = end of visible content (before the newline)
    return dir < 0
      ? layout.indexAt(-1e6, y)
      : layout.indexAt(line.x + line.width + 0.01, y);
  }

  /** A visual line up or down, keeping the goal column. */
  _verticalStep(dir) {
    const layout = this._valueLayout();
    if (!layout || this.value.length === 0) return this._caret;
    return this._verticalMove(layout, dir);
  }
}
