// IME composition for <textinput> and <textarea>: the preedit an input
// method shows at the caret before it commits, and the mapping between the
// value and what is displayed while one is open.

/** IME composition, installed onto `TextInputNode.prototype` by textinput.js. */
export class TextInputPreedit {
  // --- composition ---------------------------------------------------------
  //
  // A composition is text the user is still typing: a dead key that has not
  // met its letter yet, or a Compose sequence half entered (src/compose.js).
  // It is shown at the caret and underlined, and it is deliberately *not*
  // the value:
  //
  // - `value`, `onChange` and the undo history never see it, so a commit is
  //   one entry rather than one per keystroke, and Ctrl+Z after `dead_acute`
  //   + `e` steps over `é` rather than into it;
  // - a **controlled** field whose parent rewrites `value` mid-composition
  //   cannot corrupt the buffer, because the buffer is not in the value.
  //   That is the classic web bug, and it is structurally absent here;
  // - abandoning it — Escape, focus leaving, a press elsewhere — is
  //   dropping a string, not undoing an edit.
  //
  // The one thing it does change is the *displayed* string, which is what
  // `_displayValue` is: everything measuring or hit-testing goes through
  // that, and `_displayIndex` is the door between the two index spaces.

  /** Where the composition sits in the value — clamped, because a
   * controlled parent may have replaced the value under it. */
  _preeditStart() {
    return Math.min(this._preeditAt, this._chars().length);
  }

  /** The string the field draws — the value with any composition spliced in
   * where it will land. */
  _displayValue() {
    if (!this._preedit) return this.value;
    const chars = this._chars();
    const at = this._preeditStart();
    return (
      chars.slice(0, at).join('') + this._preedit + chars.slice(at).join('')
    );
  }

  /** A value index in the displayed string. The caret is at the composition
   * while it is open, so it maps to the *end* of the preedit — which is
   * where the next keystroke of the sequence appears — unless the input
   * method said where inside its preedit the cursor is (`_preeditCursor`,
   * a compositor IME converting one segment of a longer phrase). */
  _displayIndex(index) {
    if (!this._preedit) return index;
    const start = this._preeditStart();
    if (index < start) return index;
    const length = Array.from(this._preedit).length;
    if (index === start && this._preeditCursor) {
      return start + Math.min(length, this._preeditCursor.begin);
    }
    return index + length;
  }

  /** The inverse, for indices that come back out of a layout. A hit inside
   * the preedit answers where the preedit starts: the composition is one
   * thing, not a run of characters to put a caret between. */
  _valueIndex(index) {
    if (!this._preedit) return index;
    const start = this._preeditStart();
    if (index <= start) return index;
    return Math.max(start, index - Array.from(this._preedit).length);
  }

  /**
   * `cursor` is `{ begin, end }` in code points into `text` — where an input
   * method wants the caret inside its preedit, or a segment of it
   * highlighted when the two differ — and null for the end, which is where
   * the client-side composer's caret always is.
   */
  _setPreedit(text, cursor = null) {
    const range = text && cursor ? cursor : null;
    if (text === this._preedit && sameRange(range, this._preeditCursor)) {
      return;
    }
    if (!this._preedit) this._preeditAt = this._selection()[0];
    this._preedit = text;
    this._preeditCursor = range;
    this._repaint();
  }

  /**
   * The composition default action, after `onCompositionStart` /
   * `onCompositionUpdate` / `onCompositionEnd` have had their say.
   *
   * `compositionEnd` carries the text the sequence produced — empty when it
   * was abandoned — and inserting it is an ordinary edit, so it replaces the
   * selection, respects `maxLength`, fires `onChange` and joins the undo run
   * the surrounding typing is in. `é` undoes like the letter it is.
   */
  defaultComposition(ev) {
    if (ev.type !== 'compositionEnd') {
      // `cursorBegin`/`cursorEnd` ride the event only when an input method
      // put them there (src/wayland/textinput.js); a dead key carries none
      const begin = ev.cursorBegin;
      const cursor = Number.isInteger(begin)
        ? {
            begin,
            end: Number.isInteger(ev.cursorEnd)
              ? Math.max(begin, ev.cursorEnd)
              : begin,
          }
        : null;
      this._setPreedit(ev.data, cursor);
      return;
    }
    this._setPreedit('');
    if (!ev.data) return;
    // the same bookkeeping `defaultKeyDown` does, so the `onChange` this
    // produces carries the keystroke that committed the sequence
    const previous = this._keyNative;
    this._keyNative = ev.nativeEvent ?? null;
    try {
      this._insert(ev.data, 'type');
    } finally {
      this._keyNative = previous;
    }
  }

  /**
   * Underline the composition. The convention every toolkit shares, and the
   * reason it is worth having: the accent showing at the caret is text the
   * user has not typed yet, and nothing else about it says so — it is in the
   * field's own ink, in the field's own font, where the next character will
   * be. The line is what makes it provisional.
   */
  _paintPreedit(ctx, originX, originY, style) {
    if (!this._preedit) return;
    const layout = this._valueLayout();
    if (!layout?.lines?.length) return;
    const start = this._preeditStart();
    const from = layout.caretPosition(start);
    const to = layout.caretPosition(start + Array.from(this._preedit).length);
    ctx.fillStyle = style.color;
    // a span per line rather than one rectangle, because `<textarea>` shares
    // this and a composition at a wrap point is two spans — drawn as one
    // batch, so the underline costs one request however it wraps
    const rects = [];
    const underline = (from, to, thickness) => {
      for (let li = from.line; li <= to.line; li++) {
        const line = layout.lines[li];
        if (!line) break;
        const x0 = li === from.line ? from.x : line.x;
        const x1 = li === to.line ? to.x : line.x + line.width;
        if (x1 <= x0) continue;
        rects.push(
          originX + x0,
          originY + line.y + line.ascent + 1,
          x1 - x0,
          thickness,
        );
      }
    };
    underline(from, to, 1);
    // The segment an input method is converting, when it named one: the
    // convention (GTK, Qt, the browsers) is a heavier line under the part of
    // the phrase the candidates are for, and a plain one under the rest.
    const cursor = this._preeditCursor;
    if (cursor && cursor.end > cursor.begin) {
      underline(
        layout.caretPosition(start + cursor.begin),
        layout.caretPosition(start + cursor.end),
        2,
      );
    }
    if (rects.length) ctx.fillRects(rects);
  }
}

function sameRange(a, b) {
  return a === b || (!!a && !!b && a.begin === b.begin && a.end === b.end);
}
