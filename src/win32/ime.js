// The input method, as the tree sees it.
//
// The bridge answers the IMM32 messages and hands over four events
// (windows/src/ime.cc); this turns them into the composition events the
// renderer already has — `CompositionStart`, `CompositionUpdate`,
// `CompositionEnd` — so that a `<textinput>` on Windows composes through
// exactly the machinery a `<textinput>` on Wayland composes through, and an
// application that handles one handles both.
//
// The order is the one `src/wayland/textinput.js` `_apply` fixes, because it
// is the order the events are defined in rather than a detail of either
// protocol: **the commit first, then the new preedit.** One
// WM_IME_COMPOSITION can carry both, and together they mean "this text is
// settled, and this is what is still being typed".
//
// The other half is telling the IME where to put its candidate list. The
// preedit is drawn in the field (src/nodes/preedit.js), so the candidate list
// is the only thing the IME still draws, and it has to sit at the caret
// rather than in the corner of the screen. `sync()` is what keeps it there:
// the frame loop calls it after each tick, when the layout the caret is read
// off is the one just painted.
import { runWithPriority, DiscreteEventPriority } from '../priority.js';

const TRACE = process.env.REACT_X11_TRACE_IME === '1';

/** How many code points `units` UTF-16 code units cover.
 *
 * The bridge counts in code units because that is what IMM32 hands it, and
 * the tree counts in code points. JS strings are UTF-16, so slicing at the
 * bridge's offset and counting the result is the whole conversion — and it is
 * done here rather than there because here is where the string is. */
function codePointsIn(text, units) {
  if (!(units > 0)) return 0;
  return Array.from(text.slice(0, units)).length;
}

export class Win32InputMethod {
  constructor(app) {
    this.app = app;
    this._native = app._native;
    /** The field the IME is enabled for: `{ wnd, node, rect }`, or null. */
    this.active = null;
    /** Whether the tree has heard a `CompositionStart` it is owed an end for. */
    this.composing = false;
  }

  // --- what the tree says ---------------------------------------------------

  /**
   * The focused text control of a window, or null.
   *
   * The duck type is `defaultComposition` + `textCaretRect`, which is what
   * `<textinput>` and `<textarea>` implement and what a registered element
   * with a caret of its own would implement to be reached the same way —
   * the same test `src/wayland/textinput.js` makes, deliberately.
   *
   * A `sensitive` field answers null: a password is not offered to an input
   * method, whose word history is one more place it must not reach. Windows
   * does the same for its own password boxes.
   */
  _focusedTextControl(wnd) {
    const node = wnd._reactX11Node?.events?.focusManager?.focused ?? null;
    if (!node || node.destroyed) return null;
    if (node.root?.window !== wnd) return null;
    if (typeof node.defaultComposition !== 'function') return null;
    if (typeof node.textCaretRect !== 'function') return null;
    if (node.composes === false) return null;
    if (node.props?.sensitive) return null;
    return node;
  }

  /**
   * Where the caret is, in the window's client pixels — which is the space
   * the tree is already in on this backend (a mouse event's `x` reaches the
   * tree exactly as the bridge sent it), so there is no scale to divide out
   * and no frame inset to add. A field whose text has no layout yet offers
   * its content box, which at least puts the list under the field.
   */
  _caretRect(wnd, node) {
    let rect = null;
    try {
      const chars = Array.from(node.value ?? '');
      const caret = Number.isInteger(node._caret)
        ? Math.max(0, Math.min(node._caret, chars.length))
        : chars.length;
      rect = node.textCaretRect(caret);
    } catch {
      rect = null;
    }
    if (!rect) {
      const box = node.contentBox?.() ?? node.abs;
      if (!box) return null;
      rect = { x: box.x, y: box.y, width: 0, height: box.height };
    }
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.width ?? 0)),
      height: Math.max(1, Math.round(rect.height ?? 0)),
    };
  }

  /**
   * Bring the IME up to date about a window's focused field.
   *
   * Called at the end of every frame the window ran, which is cheap when
   * nothing changed: one duck-type check and four comparisons. Nothing is
   * sent to the UI thread unless the field or the caret actually moved.
   */
  sync(wnd) {
    if (this._destroyed || !wnd || wnd._destroyed) return;
    const node = this._focusedTextControl(wnd);
    if (node !== this.active?.node) {
      if (this.active) this._disable();
      if (node) this._enable(wnd, node);
      return;
    }
    if (node) this._place(wnd, node);
  }

  _enable(wnd, node) {
    this.active = { wnd, node, rect: null };
    this.composing = false;
    this._native.imeEnable(wnd.id, true);
    this._place(wnd, node);
    if (TRACE) trace(`enable <${node.kind}>`);
  }

  /**
   * Take the IME off this window, and end the composition the tree is owed.
   *
   * The field's own blur has already cleared the preedit it was drawing; what
   * is owed is the `CompositionEnd` an application that saw the start is
   * waiting for, with no data — which is how an abandoned composition has
   * always ended.
   */
  _disable() {
    const active = this.active;
    this.active = null;
    if (!active) return;
    if (this.composing) {
      this.composing = false;
      const node = active.node;
      const events = node.destroyed ? null : node.root?.events;
      if (events) {
        runWithPriority(DiscreteEventPriority, () =>
          events._composition('End', node, '', null),
        );
      }
    }
    this._native.imeEnable(active.wnd.id, false);
    if (TRACE) trace('disable');
  }

  /** Move the candidate list to the caret, if it is not already there. */
  _place(wnd, node) {
    const rect = this._caretRect(wnd, node);
    const was = this.active?.rect;
    if (!rect) return;
    if (
      was &&
      was.x === rect.x &&
      was.y === rect.y &&
      was.width === rect.width &&
      was.height === rect.height
    ) {
      return;
    }
    if (this.active) this.active.rect = rect;
    this._native.imeCaret(wnd.id, rect.x, rect.y, rect.width, rect.height);
  }

  // --- what the input method says -------------------------------------------

  /**
   * One `ime-*` event from the bridge.
   *
   * Every one is dispatched at `DiscreteEventPriority`: a composition is a
   * keystroke's worth of user intent and must not be batched behind a
   * transition, exactly as the Wayland transport dispatches its own.
   */
  handle(event, wnd) {
    const active = this.active;
    if (!active || active.wnd !== wnd) return;
    const node = active.node;
    if (node.destroyed) return;
    const events = node.root?.events;
    if (!events) return;

    // There is no key behind an input method's commit, which is what a
    // handler reading `nativeEvent` needs to be told.
    const native = { type: 'ime' };

    switch (event.type) {
      case 'ime-start':
        // The renderer's `CompositionStart` is raised lazily, with the first
        // text — the same as every other backend, so that a composition that
        // begins and ends with nothing in it never reaches an application.
        // This only clears a flag a previous session could have left.
        if (TRACE) trace('start');
        return;

      case 'ime-commit': {
        const text = event.text ?? '';
        if (!text) return;
        if (TRACE) trace(`commit ${JSON.stringify(text)}`);
        runWithPriority(DiscreteEventPriority, () => {
          if (!this.composing) events._composition('Start', node, '', native);
          this.composing = false;
          // `defaultComposition` inserts it the way a typed character is
          // inserted — through `_insert`, with `maxLength`, `onChange` and
          // the undo run all in play.
          events._composition('End', node, text, native);
        });
        return;
      }

      case 'ime-preedit': {
        const text = event.text ?? '';
        if (TRACE)
          trace(`preedit ${JSON.stringify(text)} ${event.a}..${event.b}`);
        runWithPriority(DiscreteEventPriority, () => {
          if (text) {
            if (!this.composing) {
              events._composition('Start', node, '', native);
              this.composing = true;
            }
            // The clause the IME is converting, which is what it wants drawn
            // as the selection inside the preedit.
            const cursor = {
              cursorBegin: codePointsIn(text, event.a),
              cursorEnd: codePointsIn(text, event.b),
            };
            events._composition('Update', node, text, native, cursor);
          } else if (this.composing) {
            this.composing = false;
            events._composition('End', node, '', native);
          }
        });
        return;
      }

      case 'ime-end':
        // Usually nothing to do: the commit or an emptied preedit has already
        // ended it. An IME that cancels without either lands here.
        if (!this.composing) return;
        if (TRACE) trace('end');
        runWithPriority(DiscreteEventPriority, () => {
          this.composing = false;
          events._composition('End', node, '', native);
        });
        return;

      default:
        return;
    }
  }

  destroy() {
    this._destroyed = true;
    this.active = null;
  }
}

function trace(line) {
  process.stderr.write(`react-x11 win32: ime ${line}\n`);
}
