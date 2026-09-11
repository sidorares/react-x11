// <textinput>: a single-line editable field — value, caret and selection,
// the keys, the mouse, the clipboard, the edit menu and painting. Undo/redo
// is in edithistory.js and IME composition in preedit.js, installed below.

import { localTextStyleChanged } from '../styles.js';
import { Yoga } from '../yoga.js';
import {
  DEFAULTS as DESKTOP_DEFAULTS,
  desktopSettings,
} from '../desktopsettings.js';
import { callHandler } from '../errors.js';
import { hooks as a11yHooks } from '../a11y.js';
import { lastInputTime } from '../inputtime.js';
import {
  ctrlChordLetter,
  MOD,
  XK_BACKSPACE,
  XK_RETURN,
  XK_KP_ENTER,
  XK_HOME,
  XK_LEFT,
  XK_RIGHT,
  XK_END,
  XK_DELETE,
} from '../keysyms.js';
import { codePoints, wordBoundary, wordRangeAt } from '../textrange.js';
import { takeVisibleSelection } from '../textselection.js';
import { TextInputHistory } from './edithistory.js';
import { openEditMenu, editMenuOpen } from './editmenupopup.js';
import { installMethods } from './install.js';
import { Node } from './node.js';
import { TextInputPreedit } from './preedit.js';
import { rangeBands } from './text.js';

/**
 * How long a caret stays in each of its two states, in milliseconds, on a
 * desktop that did not say.
 *
 * A desktop that *did* say — `Net/CursorBlinkTime`, and `Net/CursorBlink: 0`
 * for "do not blink at all" — is read through `desktopSettings(app)` at the
 * moment a field takes focus. This is the floor under that, and what a
 * connection with no settings daemon uses; it lives in `desktopsettings.js`
 * beside the rest of them so there is one number rather than two.
 *
 * Exported from `react-x11/node` because an element that edits text draws
 * its own caret and would otherwise hardcode a second cadence — two carets
 * on one screen blinking against each other (issue #251). An element with a
 * live connection to hand should prefer `useDesktopSettings().caretBlinkMs`,
 * which is this value already reconciled with the desktop.
 */
export const CARET_BLINK_MS = DESKTOP_DEFAULTS.caretBlinkMs;

/** The caret's own width, in *logical* pixels — it is a rectangle rather
 * than a line because a hairline disappears in a sea of dense pixels.
 * Multiplied by the node's scale where it is drawn and reserved for, like
 * every paint constant that never passes through a style (src/scale.js). */
export const CARET_WIDTH = 1.5;

/** The room a line of a field's text leaves for the caret that follows it,
 * at the right-hand edge of the content box in both directions — see
 * `TextInputNode._lineOriginX`, which is where the asymmetry is explained.
 * Logical, like CARET_WIDTH. */
export const CARET_RESERVE = 2;

/**
 * <textinput>: single-line editable text. Caret/selection via ntk TextLayout
 * prefix measurement, editing via the EventManager default-action hooks
 * (user onKeyDown/onMouseDown handlers run first and can preventDefault).
 * Clipboard: Ctrl+C/X/V on CLIPBOARD, X11-style middle-click paste and
 * select-to-own on PRIMARY (needs ntk >= 5.4.0 app.clipboard; degrades
 * gracefully without it). Controlled (`value` + `onChange`) or uncontrolled
 * (`defaultValue`). Caret indices are in code points, not UTF-16 units.
 */
export class TextInputNode extends Node {
  constructor(props, app, kind = 'textinput') {
    super(kind, props, app);
    this.focusableByDefault = true;
    this.defaultCursor = 'text';
    // a field's selection is its own: a `selectable` document around it does
    // not get to light up half of what is being typed, and the two take turns
    // being the one selection on screen (textselection.js)
    this.hasOwnSelection = true;
    this._value =
      props.defaultValue != null ? String(props.defaultValue) : null;
    // set only while an onChange/onSubmit handler is on the stack — see
    // `get value()` and `_fireValueEvent`
    this._pendingValue = null;
    // the X key event driving the current edit, for `ev.nativeEvent`
    this._keyNative = null;
    this._caret = this._chars().length;
    this._anchor = this._caret;
    this._scrollX = 0;
    this._focused = false;
    this._caretOn = false;
    this._blinkTimer = null;
    this._dragging = false;
    // undo/redo: snapshots of every state this input has shown, oldest
    // first, with _historyIndex on the current one
    this._history = [
      { value: this.value, caret: this._caret, anchor: this._anchor },
    ];
    this._historyIndex = 0;
    this._historyValue = this.value;
    this._undoRun = null;
    // the uncommitted composition: what a pending dead key or an open
    // Compose sequence is showing, and where it sits in the value. Never
    // part of `value`, and never in the history — see `defaultComposition`
    this._preedit = '';
    this._preeditAt = 0;
    // the open edit menu, if any (see `openEditMenu`)
    this._editMenu = null;
  }

  /** A preferred width, capped to whatever is on offer — `Infinity` when
   * nothing is, which is what makes the `Math.min` the whole rule. */
  measureContent({ width }) {
    // `_capBand` rounds, and a trimmed `<text>` rounds the same band the
    // same way — rounding one of them and not the other is a pixel of
    // difference between a field and the button beside it.
    return { width: Math.min(150, width), height: this._capBand() };
  }

  get value() {
    // While an onChange handler is running, the control's value is the one
    // the edit produced — the DOM behaves the same way, and it is what makes
    // `ev.target.value` right in *controlled* mode, where `props.value` is
    // still the old string until the parent re-renders.
    if (this._pendingValue !== null) return this._pendingValue;
    if (this.props.value != null) return String(this.props.value);
    return this._value ?? '';
  }

  /**
   * Writing `node.value = 'x'` sets the text the way typing would, minus the
   * `onChange` — assigning to a DOM input's `value` does not fire one
   * either. It exists because form libraries reset a field through the ref:
   * react-hook-form's `register()` does `ref.value = ''` on mount and on
   * `reset()`, and a getter-only `value` made that a TypeError during commit.
   *
   * On a **controlled** input `props.value` still wins the next time the
   * parent renders, exactly as in the DOM.
   */
  set value(next) {
    const text = next == null ? '' : String(next);
    if (text === this._value) return;
    this._value = text;
    const len = Array.from(text).length;
    this._caret = Math.min(this._caret, len);
    this._anchor = Math.min(this._anchor, len);
    // same bookkeeping a value arriving through props gets: its own undo
    // entry, so Ctrl+Z steps back through a programmatic reset too
    this._noteExternalValue();
    this._repaint();
  }

  /** The `name` prop, so `ev.target.name` reads the way the DOM does. */
  get name() {
    return this.props.name;
  }

  /**
   * The synthetic event `onChange` and `onSubmit` are handed. Same shape
   * every other handler in the system gets — `_makeEvent` builds it — with
   * the value on both `ev.value` and `ev.target.value`, and `name` mirrored
   * the same way, because that is what every DOM form library reads.
   *
   * `_makeEvent` lives on the owning window's EventManager; a node that is
   * not attached to one (a unit test, an edit that outlives its window) gets
   * an equivalent object rather than nothing.
   */
  _makeValueEvent(type, native) {
    // not dispatched through the tree, so currentTarget is the target —
    // exactly what the DOM reports for a handler on the element itself
    const extra = {
      value: this.value,
      name: this.props.name,
      currentTarget: this,
    };
    const events = this.root?.events;
    if (events) return events._makeEvent(type, native, this, extra);
    const ev = {
      type,
      x: native?.x ?? 0,
      y: native?.y ?? 0,
      target: this,
      nativeEvent: native ?? null,
      shiftKey: Boolean(native?.buttons & MOD.Shift),
      ctrlKey: Boolean(native?.buttons & MOD.Control),
      altKey: Boolean(native?.buttons & MOD.Alt),
      metaKey: Boolean(native?.buttons & MOD.Super),
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        ev.defaultPrevented = true;
      },
      stopPropagation() {
        ev.propagationStopped = true;
      },
      capturePointer() {},
      releasePointer() {},
      ...extra,
    };
    return ev;
  }

  /**
   * Call `onChange`/`onSubmit` with `value` as the control's current value,
   * whatever `props.value` still says. Restored in a `finally` so a throwing
   * handler cannot leave the control reporting a value it never took.
   */
  _fireValueEvent(prop, value, native = null) {
    const handler = this.props[prop];
    if (!handler) return;
    native ??= this._keyNative;
    const previous = this._pendingValue;
    this._pendingValue = value;
    const type = prop === 'onSubmit' ? 'submit' : 'change';
    try {
      callHandler(this, prop, handler, this._makeValueEvent(type, native));
    } finally {
      this._pendingValue = previous;
    }
  }

  _chars() {
    return codePoints(this.value);
  }

  _layoutOf(text) {
    const fonts = this.app?.fonts;
    if (!fonts) return null;
    const style = this.resolvedTextStyle();
    return fonts.layout(text, style);
  }

  _lineHeight() {
    const layout = this._layoutOf('Mg');
    if (layout) return layout.height;
    // No fonts to measure with. `resolvedTextStyle()` rather than the style
    // prop alone, so the guess is made at the size this field inherits — the
    // palette's — and not at 14 whatever the theme said.
    return this.resolvedTextStyle().size * 1.4;
  }

  /**
   * What one line of this field is *worth* vertically: the capitals down to
   * the baseline, which is what its padding is measured from.
   *
   * The same rule every label follows — `textBoxTrim: 'cap-alphabetic'` in
   * styling.md — reached a different way, because a field cannot trim. Its
   * caret and its selection are measured against the full line box, and the
   * glyphs have to be able to hang out of the box for the descenders to be
   * there at all; so the *box* is the cap band and the drawing is clipped to
   * the padding box instead, one step out. A field and a `<Button>` with the
   * same padding are then the same height, which is the whole point: they sit
   * next to each other on every form there has ever been.
   */
  /**
   * The rectangle the text may draw in: the padding box horizontally
   * unchanged, vertically grown out to where the border starts. `<textarea>`
   * keeps the content box, because its box *is* line boxes and nothing hangs
   * out of it.
   */
  _inkClip(content) {
    const box = this.abs;
    const top = box.y + this.yoga.getComputedBorder(Yoga.EDGE_TOP);
    const bottom =
      box.y + box.height - this.yoga.getComputedBorder(Yoga.EDGE_BOTTOM);
    return {
      x: content.x,
      y: Math.min(content.y, top),
      width: content.width,
      height: Math.max(content.height, bottom - Math.min(content.y, top)),
    };
  }

  /** Whole pixels either way: a field's height is a flex item's main size,
   *  and a fractional one costs the tree its content floors (see
   *  `TextNode._trim`, issue #411). The face with no `capHeight` to round is
   *  the one that reaches the fallback. */
  _capBand() {
    const style = this.resolvedTextStyle();
    const cap = this.app?.fonts
      ?.match?.(style.family, { weight: style.weight, style: style.style })
      ?.metrics?.(style.size)?.capHeight;
    return Math.round(cap || this._lineHeight());
  }

  /** Shaped layout of the current value, cached per (value, style,
   * direction).
   * Caret math rides ntk >= 3.3.0's TextLayout caret API, which is exact
   * across kerning/shaping boundaries, bidi runs and trailing whitespace
   * (replaces the prefix-width measurement this used before).
   *
   * Laid out at its **natural width**, with no `maxWidth` and no `align`:
   * a single-line field never wraps, and a `maxWidth` is what makes ntk
   * break lines. So the alignment ntk would have applied inside the layout
   * box is applied to the box instead, by `_lineOriginX` — see there. */
  _valueLayout() {
    const fonts = this.app?.fonts;
    if (!fonts) return null;
    const text = this._displayValue();
    const s = this.resolvedTextStyle();
    const direction = this.direction;
    const key = `${text}|${s.family}|${s.size}|${s.weight}|${s.style}|${direction}`;
    if (this._valueLayoutKey !== key) {
      this._valueLayoutKey = key;
      this._valueLayoutCache = fonts.layout(text, s, { direction });
    }
    return this._valueLayoutCache;
  }

  /** Visual caret x for a logical code-point index **in the value**. */
  _prefixWidth(count) {
    return this._prefixWidthAt(this._displayIndex(count));
  }

  /** The same, for an index in the displayed string — which is the value
   * unless a composition is showing. */
  _prefixWidthAt(index) {
    const layout = this._valueLayout();
    if (!layout) return 0;
    return layout.caretPosition(index).x;
  }

  _selection() {
    return [
      Math.min(this._caret, this._anchor),
      Math.max(this._caret, this._anchor),
    ];
  }

  _selectedText() {
    const [a, b] = this._selection();
    return this._chars().slice(a, b).join('');
  }

  _repaint() {
    this._caretOn = true;
    this.root?.invalidate(false, this, 'text');
    // every edit, caret move and selection change funnels through here
    a11yHooks.textState?.(this);
  }

  /**
   * The one place the value changes. `kind` names the edit for undo
   * coalescing (`type`, `delete-back`, `delete-forward`); anything left
   * unnamed — a paste, a cut, a replaced selection, a newline — is its own
   * undo step.
   */
  _commit(nextChars, caret, kind = null) {
    const next = nextChars.join('');
    const previous = this.value;
    const beforeCaret = this._caret;
    const beforeAnchor = this._anchor;
    this._caret = caret;
    this._anchor = caret;
    if (this.props.value == null) this._value = next;
    if (next !== previous) {
      // `this.value` is still the old one in controlled mode — the parent
      // has not answered onChange yet — so record what we computed
      this._recordEdit(kind, {
        value: next,
        caret,
        anchor: caret,
        beforeCaret,
        beforeAnchor,
      });
      this._fireValueEvent('onChange', next);
    }
    this._repaint();
  }

  /** Single-line: newlines collapse to spaces (textarea overrides). */
  _normalizeInsert(text) {
    return String(text).replace(/[\r\n]+/g, ' ');
  }

  _insert(text, kind = null) {
    const insert = Array.from(this._normalizeInsert(text));
    if (this.props.maxLength != null) {
      const room =
        this.props.maxLength -
        (this._chars().length - (this._selection()[1] - this._selection()[0]));
      if (insert.length > room) insert.length = Math.max(0, room);
    }
    const chars = this._chars();
    const [a, b] = this._selection();
    this._commit(
      [...chars.slice(0, a), ...insert, ...chars.slice(b)],
      a + insert.length,
      kind,
    );
  }

  _deleteRange(from, to, kind = null) {
    const chars = this._chars();
    this._commit([...chars.slice(0, from), ...chars.slice(to)], from, kind);
  }

  _moveCaret(index, extend) {
    const len = this._chars().length;
    this._caret = Math.min(Math.max(0, index), len);
    if (!extend) this._anchor = this._caret;
    // typing that resumes somewhere else is a new edit, not the old one
    this._breakUndoRun();
    this._repaint();
  }

  _clipboardApi() {
    return this.app?.clipboard ?? null;
  }

  /**
   * Put the selection on a selection — unless this input is `sensitive`.
   *
   * Every route out of the field funnels through here: Ctrl+C, the copy half
   * of Ctrl+X, the right-click menu, and the select-to-own that hands PRIMARY
   * to a middle click in some other application. One gate covers them all,
   * which is the reason the field is the thing that knows it holds a secret
   * rather than each of the six callers.
   *
   * The reason a *revealed* password field still refuses: what is on screen
   * stops being on screen when the field is hidden again, and what is on the
   * clipboard does not. Any client on the display can ask for it, and a
   * clipboard manager will have written it down.
   */
  _copySelection(selection = 'CLIPBOARD') {
    if (this.props.sensitive) return;
    const text = this._selectedText();
    if (!text) return;
    this._clipboardApi()
      // ICCCM 2.1: the timestamp of the event that triggered the copy is
      // what arbitrates a race with another app copying at the same moment.
      // It also saves ntk a round trip asking the server for one, which on
      // PRIMARY is a round trip per selection-extending keystroke.
      ?.write(text, { selection, time: lastInputTime(this.app) })
      .catch((err) => {
        // Losing the race is now possible rather than theoretical: a real
        // event timestamp can be older than another client's, where the
        // server-time fallback never was. A cut that deleted the text
        // without acquiring the selection should not be silent.
        //
        // `err?.message ?? err` because a throw in here would be an
        // unhandled rejection, which ends the process — the exact failure
        // errors.js exists to keep away from a GUI event path.
        console.warn(
          `react-x11: could not take the ${selection} selection: ${err?.message ?? err}`,
        );
      });
  }

  _pasteFrom(selection = 'CLIPBOARD') {
    this._clipboardApi()
      // ICCCM 2.4: convert with the timestamp of the event that asked for
      // the paste, so an owner that has replaced its data since can tell
      // which value was wanted (ntk >= 5.4.0)
      ?.read({ selection, time: lastInputTime(this.app) })
      .then((text) => {
        if (!this.destroyed && text) this._insert(text);
      })
      .catch(() => {});
  }

  // --- default actions (run after user handlers unless preventDefault) ---

  /**
   * Remember the X event driving the edit so the `onChange` it produces can
   * carry it on `nativeEvent`. Subclasses override `_editKeyDown`, not this,
   * so the bookkeeping cannot be forgotten in one of them.
   *
   * Only keystrokes get this far. A paste resolves a promise, an undo is not
   * an input event at all, and a value pushed from a parent has no X event
   * behind it — those report `nativeEvent: null`, which is the truth.
   *
   * `_editKeyDown` answers **whether it took the key**, and a key it took is
   * consumed the way every default action says so: `preventDefault()`, whose
   * meaning one layer down is "the default action after this one does not
   * run". That is what keeps Ctrl+C in a focused field rather than in the
   * menu's accelerator for it, on the same rule Tab and Space/Enter already
   * follow (#351) — and it is why the ctrl chord below returns false for the
   * letters it does *not* answer, instead of swallowing every chord in the
   * alphabet.
   */
  defaultKeyDown(ev) {
    const previous = this._keyNative;
    this._keyNative = ev.nativeEvent ?? null;
    try {
      if (this._editKeyDown(ev)) ev.preventDefault();
    } finally {
      this._keyNative = previous;
    }
  }

  /** @returns {boolean} whether the field answered this key. */
  _editKeyDown(ev) {
    const [a, b] = this._selection();
    const hasSelection = a !== b;
    const k = ev.keysym;

    if (k === XK_RETURN || k === XK_KP_ENTER) {
      this._fireValueEvent('onSubmit', this.value, ev.nativeEvent);
      return true;
    }
    if (k === XK_BACKSPACE) {
      if (hasSelection) this._deleteRange(a, b);
      else if (ev.ctrlKey) this._deleteRange(this._wordBoundary(a, -1), a);
      else if (a > 0) this._deleteRange(a - 1, a, 'delete-back');
      return true;
    }
    if (k === XK_DELETE) {
      if (hasSelection) this._deleteRange(a, b);
      else if (ev.ctrlKey) this._deleteRange(a, this._wordBoundary(a, 1));
      else {
        this._deleteRange(
          a,
          Math.min(a + 1, this._chars().length),
          'delete-forward',
        );
      }
      return true;
    }
    if (k === XK_LEFT) {
      if (ev.ctrlKey) {
        this._moveCaret(this._wordBoundary(this._caret, -1), ev.shiftKey);
      } else if (!ev.shiftKey && hasSelection) {
        this._moveCaret(a, false);
      } else {
        this._moveCaret(this._caret - 1, ev.shiftKey);
      }
      if (ev.shiftKey) this._copySelection('PRIMARY');
      return true;
    }
    if (k === XK_RIGHT) {
      if (ev.ctrlKey) {
        this._moveCaret(this._wordBoundary(this._caret, 1), ev.shiftKey);
      } else if (!ev.shiftKey && hasSelection) {
        this._moveCaret(b, false);
      } else {
        this._moveCaret(this._caret + 1, ev.shiftKey);
      }
      if (ev.shiftKey) this._copySelection('PRIMARY');
      return true;
    }
    if (k === XK_HOME) {
      this._moveCaret(0, ev.shiftKey);
      return true;
    }
    if (k === XK_END) {
      this._moveCaret(this._chars().length, ev.shiftKey);
      return true;
    }
    if (ev.ctrlKey) {
      const letter = ctrlChordLetter(ev);
      if (letter === 0x61 /* a */) {
        this._selectAll();
      } else if (letter === 0x63 /* c */) {
        this._copySelection();
      } else if (letter === 0x78 /* x */) {
        this._copySelection();
        if (hasSelection) this._deleteRange(a, b);
      } else if (letter === 0x76 /* v */) {
        this._pasteFrom();
      } else if (letter === 0x7a /* z */) {
        // Ctrl+Shift+Z redoes, the way it does in GTK and Qt
        if (ev.shiftKey) this.redo();
        else this.undo();
      } else if (letter === 0x79 /* y */) {
        this.redo();
      } else {
        // A chord this field has no answer for is not the field's: Ctrl+S
        // belongs to whatever bound it, and a text control that swallowed
        // every chord would be a text control no application can put a
        // shortcut behind.
        return false;
      }
      return true;
    }
    if (ev.codepoint != null && ev.codepoint >= 0x20 && ev.codepoint !== 0x7f) {
      const ch = String.fromCodePoint(ev.codepoint);
      this._insert(ch, 'type');
      // undo a word at a time: the space that ends a word joins the run it
      // ends, and the next word starts a fresh one
      if (/\s/.test(ch)) this._breakUndoRun();
      return true;
    }
    return false;
  }

  /** Click-to-caret for a mouse event. Both kinds answer it the same way —
   * through the field's own geometry accessor, which is the one the caret
   * and the highlight are drawn from. */
  _indexAtPoint(ev) {
    // `textIndexAt` is the device-pixel geometry contract (it is also what
    // the a11y bridge calls with screen points); the synthetic event is
    // logical, so the click goes back through its native coordinates.
    const native = ev.nativeEvent;
    return this.textIndexAt(
      native?.x ?? ev.x * this.scale,
      native?.y ?? ev.y * this.scale,
    );
  }

  /** Word range around a code-point index (whitespace-delimited). */
  _wordRangeAt(index) {
    return wordRangeAt(this._chars(), index);
  }

  /** Caret index one word away, the way Ctrl+arrow moves in a text editor. */
  _wordBoundary(from, dir) {
    return wordBoundary(this._chars(), from, dir);
  }

  // --- geometry (the accessors every text-bearing element answers) --------

  /**
   * Where a single line of text sits in the field, and the band a mark over
   * it fills. Centred on the **capitals**, not on the line box and not on
   * the ink.
   *
   * The layout box carries the line's leading entirely below the glyphs, so
   * centring that pushes the text visually up (see `halfLeading`). Centring
   * ascent + descent — what this did — fixes the leading but not the
   * asymmetry underneath it: a font's ascent clears its capitals by
   * `ascent - capHeight`, which is not its descent, so a single line of
   * text sits off-centre by a number that belongs to the typeface. At 14px
   * that is 0.7px of extra space above the capitals in SF NS and 2.5px the
   * other way in Helvetica — visible in a field, where there is one short
   * line and a border close on both sides to measure it against.
   *
   * So: put the baseline where the space above the capitals equals the
   * space under it. A `<text>` says the same thing as `textBoxTrim`, but a
   * field cannot trim its box — the caret and the selection are measured
   * against the full line box — so it moves the line instead, and the marks
   * follow because they are derived from the same origin.
   */
  _lineMetrics(layout, content, style) {
    const line = layout.lines?.[0];
    const inkHeight = line ? line.ascent + line.descent : layout.height;
    const ascent = line?.ascent ?? 0;
    // Where the painter puts the first baseline inside the layout box. It is
    // **not** `ascent`: the line carries its leading above the glyphs too, so
    // on a face with a real line gap the two are pixels apart. Verdana's gap
    // is 0.03em and the error rounds away; Hiragino Sans — which is what
    // `sans-serif` resolves to on a macOS box with Homebrew's fontconfig
    // first on PATH (#86) — carries 0.5em, and every field drew its text
    // three pixels low. Positioning by `ascent` was the whole of that bug.
    const baseline = line?.baseline ?? ascent;
    const leading = baseline - ascent;
    const capHeight = this.app?.fonts
      ?.match?.(style.family, {
        weight: style.weight,
        style: style.style,
      })
      ?.metrics?.(style.size)?.capHeight;
    const textY =
      capHeight && line
        ? content.y + (content.height + capHeight) / 2 - baseline
        : content.y + Math.max(0, (content.height - inkHeight) / 2) - leading;
    // The glyphs start a leading below the box they are drawn in, and the
    // marks are measured against the glyphs rather than against the box.
    const inkTop = textY + leading;
    // selection/caret read better with breathing room around the glyphs
    // (a DOM input highlights the whole line box, not just the ink)
    const markPad = Math.min(3, Math.max(0, inkTop - content.y));
    return {
      textY,
      markY: inkTop - markPad,
      markHeight: inkHeight + markPad * 2,
      inkHeight,
    };
  }

  /**
   * Where a line of the field's text starts, in window coordinates, before
   * the scroll offset — the whole of the field's horizontal placement, and
   * the only place that knows which edge the text is against.
   *
   * The line is laid out at its natural width (`_valueLayout`), so ntk had
   * no container to align it in and `line.x` is 0. This is that alignment:
   * `textAlign` resolved against the base direction, which is what puts an
   * RTL field's value, placeholder and caret on the right-hand side without
   * anybody asking for it.
   *
   * **The caret is why the reserve is at the right in both directions.** A
   * caret is a rectangle drawn *rightwards* from the boundary it marks, so
   * the one position that can fall outside the content box is the rightmost
   * one: the end of the text in LTR — which is what the `+ 2` in the scroll
   * clamp has always been keeping room for — and the *start* of it in RTL,
   * where the text is flush against the right edge and index 0 sits on it.
   * Without the reserve an empty RTL field has no visible caret at all.
   *
   * Alignment only has a say while the text fits. An overflowing field
   * scrolls, and `_scrollX: 0` means "showing the start of the value", so
   * the start edge is where an overflowing line is pinned whatever the
   * alignment says.
   */
  _lineOriginX(layout, content) {
    const rtl = this.direction === 'rtl';
    const free = content.width - CARET_RESERVE * this.scale - layout.width;
    let align = this.style.textAlign ?? 'start';
    if (align === 'start') align = rtl ? 'right' : 'left';
    else if (align === 'end') align = rtl ? 'left' : 'right';
    const offset = align === 'right' ? free : align === 'center' ? free / 2 : 0;
    return content.x + (rtl ? Math.min(free, offset) : Math.max(0, offset));
  }

  /**
   * How far the text is displaced by the scroll, signed. `_scrollX` counts
   * from the start of the value in both directions — the rule
   * `ScrollableNode` follows for a scroll box — and the start is the
   * right-hand edge when the field reads right to left, so the text it
   * uncovers is to the *left* and the displacement is the other way.
   */
  _scrollShift() {
    return this.direction === 'rtl' ? this._scrollX : -this._scrollX;
  }

  /** How far a value wider than its box can be scrolled. The reserve is the
   * caret's, the same one `_lineOriginX` keeps: at full scroll the far end
   * of the text stops short of the edge by exactly the width of the caret
   * that sits there. */
  _maxScrollX(layout, content) {
    return Math.max(
      0,
      layout.width - (content.width - CARET_RESERVE * this.scale),
    );
  }

  /** The value's layout and where it is drawn, in window coordinates. The
   * placeholder is not in it: the accessors answer about the text the field
   * holds, and an empty field holds none. */
  _placedValue() {
    const layout = this._valueLayout();
    if (!layout) return null;
    const content = this.contentBox();
    const metrics = this._lineMetrics(
      layout,
      content,
      this.resolvedTextStyle(),
    );
    return {
      layout,
      x: this._lineOriginX(layout, content) + this._scrollShift(),
      y: metrics.textY,
    };
  }

  /** The value. The indices below are into this string, in code points — an
   * open composition is spliced into what is *drawn* and never into what the
   * field holds, so it is not in here either. */
  textContent() {
    return this.value;
  }

  textIndexAt(x, y) {
    const placed = this._placedValue();
    if (!placed) return this._chars().length;
    return this._valueIndex(placed.layout.indexAt(x - placed.x, y - placed.y));
  }

  textCaretRect(index) {
    const placed = this._placedValue();
    if (!placed) return null;
    const caret = placed.layout.caretPosition(this._displayIndex(index));
    return {
      x: placed.x + caret.x,
      y: placed.y + caret.y,
      width: 0,
      height: caret.height,
    };
  }

  textRangeRects(start, end) {
    const placed = this._placedValue();
    if (!placed) return [];
    return rangeBands(
      placed.layout,
      this._displayValue(),
      this._displayIndex(start),
      this._displayIndex(end),
    ).map((band) => ({
      x: placed.x + band.x,
      y: placed.y + band.y,
      width: band.width,
      height: band.height,
    }));
  }

  defaultMouseDown(ev) {
    // wherever the caret lands, editing resumes as a new undo entry
    this._breakUndoRun();
    if (ev.button === 3) {
      // A right-click is about to open a menu that acts on the selection,
      // so it must not be the thing that throws the selection away: a click
      // inside one keeps it, and only a click outside moves the caret. Both
      // GTK and Qt behave this way, and it is why this cannot fall through
      // to the caret placement below — that also started a drag nobody
      // asked for.
      const i = this._indexAtPoint(ev);
      const [a, b] = this._selection();
      if (i < a || i > b) {
        this._caret = i;
        this._anchor = i;
        this._repaint();
      }
      return;
    }
    if (ev.button === 2) {
      // X11 middle-click: paste the PRIMARY selection at the click position
      const i = this._indexAtPoint(ev);
      this._caret = i;
      this._anchor = i;
      this._pasteFrom('PRIMARY');
      return;
    }
    const i = this._indexAtPoint(ev);
    if (ev.detail >= 3) {
      this._anchor = 0;
      this._caret = this._chars().length;
      this._ownSelection();
      return;
    }
    if (ev.detail === 2) {
      const [a, b] = this._wordRangeAt(i);
      this._anchor = a;
      this._caret = b;
      this._ownSelection();
      return;
    }
    // shift+click extends from the existing anchor rather than starting a
    // fresh selection, and keeps dragging from there
    if (ev.shiftKey) {
      this._caret = i;
      this._dragging = true;
      this._ownSelection();
      return;
    }
    this._caret = i;
    this._anchor = i;
    this._dragging = true;
    this._repaint();
  }

  /** Select everything, and take PRIMARY with it. Both ways in — Ctrl+A and
   * the menu row — come through here: every other selection gesture owns
   * PRIMARY, and GTK and Qt both do it for select-all too, so a middle-click
   * paste after Ctrl+A pastes what is on screen rather than whatever was
   * selected before it. */
  _selectAll() {
    this._anchor = 0;
    this._caret = this._chars().length;
    this._breakUndoRun();
    this._ownSelection();
  }

  _ownSelection() {
    this._repaint();
    if (this._caret === this._anchor) return;
    // Whatever else on screen was showing a selection stops: the highlight
    // is a single-owner thing across the whole app, the way PRIMARY is
    // across the whole display (issue #259).
    takeVisibleSelection(this);
    this._copySelection('PRIMARY');
  }

  /** Another surface took the visible selection. Collapse, rather than only
   * stop drawing: two lit ranges on one screen is the state this exists to
   * prevent, and a field that kept its own would light it up again the next
   * time it was focused. */
  _selectionLost() {
    if (this._caret === this._anchor) return;
    this._anchor = this._caret;
    this._repaint();
  }

  /** The selection stays lit while its own menu is up: the popup holds the
   * keyboard, so `_focused` is false, but the text the menu is about to act
   * on has to stay visibly selected. */
  _showsSelection() {
    return this._focused || editMenuOpen(this);
  }

  defaultMouseDrag(ev) {
    if (!this._dragging) return;
    this._caret = this._indexAtPoint(ev);
    this._repaint();
  }

  defaultMouseUp() {
    if (!this._dragging) return;
    this._dragging = false;
    this._ownSelection();
  }

  // --- the built-in edit menu -----------------------------------------
  //
  // The menu itself is `openEditMenu` (above): core's, exported, and shared
  // with anything else that edits or selects text (#256). What is left here
  // is the only part that is the field's — which verbs it offers, and what
  // each of them is worth right now. `contextMenu={false}` opts out, as does
  // `preventDefault()` in an `onContextMenu` handler.

  /** The verbs the standard menu is opened with. Every one of them is the
   * keyboard path's own entry point, so a row can never drift from what its
   * shortcut does. */
  _editActions() {
    const [a, b] = this._selection();
    const length = this._chars().length;
    return {
      canUndo: this.canUndo,
      undo: () => this.undo(),
      canRedo: this.canRedo,
      redo: () => this.redo(),
      hasSelection: a !== b,
      // A `sensitive` field offers neither Cut nor Copy: they are not
      // disabled rows, they are absent, because a greyed Copy over a
      // password reads as a bug in the application rather than as a
      // decision. Paste stays — a secret still has to be got in.
      ...(this.props.sensitive
        ? null
        : {
            cut: () => {
              const [from, to] = this._selection();
              this._copySelection();
              if (from !== to) this._deleteRange(from, to);
            },
            copy: () => this._copySelection(),
          }),
      paste: () => this._pasteFrom(),
      canSelectAll: length > 0 && !(a === 0 && b === length),
      selectAll: () => this._selectAll(),
    };
  }

  defaultContextMenu(ev) {
    if (this.props.contextMenu === false) return;
    openEditMenu(this, { x: ev.x, y: ev.y }, this._editActions());
  }

  defaultFocus() {
    this._focused = true;
    this._caretOn = true;
    // The desktop's cadence, read at focus rather than at import: XSETTINGS
    // is started but not awaited by createRoot, so this is the first moment
    // it is reliably in — and a field focused before that gets the default
    // and the desktop's answer from the next focus on.
    const { caretBlink, caretBlinkMs } = desktopSettings(this.root?.app);
    // `Net/CursorBlink: 0` is an accessibility setting, not a preference: a
    // solid caret is still a caret, so the field draws one and never arms a
    // timer for it.
    if (caretBlink) {
      this._blinkTimer = setInterval(() => {
        // A field can still hold focus when the connection goes — an app
        // closing its own client, a server exit, a test closing the app it
        // lent the root. Nothing blurs the field on that route, so this is
        // the timer's own exit: the next tick would paint a caret onto a
        // closing connection and throw out of the frame clock, where there
        // is nothing to catch it.
        if (this.destroyed || this.app?.X?._closing) {
          clearInterval(this._blinkTimer);
          this._blinkTimer = null;
          return;
        }
        this._caretOn = !this._caretOn;
        // twice a second, forever, for as long as a field has focus: the one
        // repaint that most wants to cost only the field it happens in
        this.root?.invalidate(false, this, 'caret');
      }, caretBlinkMs);
      this._blinkTimer.unref?.();
    }
    this.root?.invalidate(false, this, 'focus');
  }

  defaultBlur() {
    this._focused = false;
    this._caretOn = false;
    // the EventManager ends an open composition before focus moves, so this
    // is the belt to that braces: a field that lost focus by some other
    // route must not keep drawing an accent nobody can finish
    this._preedit = '';
    // coming back to a field later is a new edit, not more of the old one
    this._breakUndoRun();
    clearInterval(this._blinkTimer);
    this._blinkTimer = null;
    this.root?.invalidate(false, this, 'focus');
  }

  destroySubtree() {
    clearInterval(this._blinkTimer);
    this._blinkTimer = null;
    super.destroySubtree();
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    const beforeStyle = this.style;
    super.applyProps(newProps, oldProps);
    const len = Array.from(
      newProps.value != null ? String(newProps.value) : (this._value ?? ''),
    ).length;
    this._caret = Math.min(this._caret, len);
    this._anchor = Math.min(this._anchor, len);
    this._noteExternalValue();
    // The face and the size arrive through `_textStyleMoved`, whether they
    // came from this commit or from an ancestor; what is left here is the
    // node-local half of the text vocabulary.
    if (localTextStyleChanged(this.style, beforeStyle)) {
      this.invalidateMeasure('props');
    } else if (newProps.value !== before.value) {
      // painting clips to the content box and the measure function reads
      // only font metrics, so a value change is confined to the field —
      // the same claim applyProps makes for any paint-only prop
      this.root?.invalidate(false, this, 'text');
    }
  }

  paintContent(ctx) {
    const fonts = this.app?.fonts;
    if (!fonts) return;
    const content = this.contentBox();
    if (content.width <= 0 || content.height <= 0) return;

    const style = this.resolvedTextStyle();
    const text = this._displayValue();
    const isEmpty = text.length === 0;
    const shown = isEmpty ? (this.props.placeholder ?? '') : text;
    const color = isEmpty
      ? (this.props.placeholderColor ?? this.theme.textMuted)
      : style.color;
    // The placeholder is the *field's* chrome rather than the user's
    // content, so it is laid out and placed at the field's own direction —
    // an English hint in an Arabic form starts at the right-hand edge with
    // everything else in the window.
    const layout = fonts.layout([{ text: shown, ...style, color }], style, {
      direction: this.direction,
    });
    const { textY, markY, markHeight } = this._lineMetrics(
      layout,
      content,
      style,
    );

    // Keep the caret inside the viewport — but only while the field is being
    // edited. The caret starts at the *end* of the value, so chasing it
    // unconditionally meant a field whose text is wider than its box rendered
    // scrolled to the end before anyone had touched it: the first characters
    // were simply missing, which reads as a rendering bug rather than as a
    // scroll position. An unfocused field shows the beginning of its value,
    // the way a DOM input does.
    //
    // The chase is in *visual* coordinates — how far the caret is from the
    // left of the content box once the value has been placed and scrolled —
    // because that is the question the viewport asks, and it is the same
    // question in both directions. Which way the scroll displaces the text
    // is `_scrollShift`'s business.
    const valueLayout = this._valueLayout();
    const caretX = this._prefixWidth(this._caret);
    // where the caret sits before the scroll, relative to the content box
    const caretAt = valueLayout
      ? this._lineOriginX(valueLayout, content) + caretX - content.x
      : caretX;
    const limit = content.width - CARET_RESERVE * this.scale;
    if (!this._focused) this._scrollX = 0;
    else {
      let shift = this._scrollShift();
      if (caretAt + shift > limit) shift = limit - caretAt;
      if (caretAt + shift < 0) shift = -caretAt;
      this._scrollX = this.direction === 'rtl' ? shift : -shift;
    }
    // The extent is the *value*'s, never the placeholder's: a hint longer
    // than the box is clipped, not scrolled, since nothing can move the caret
    // through it.
    this._scrollX = Math.max(
      0,
      Math.min(
        this._scrollX,
        valueLayout ? this._maxScrollX(valueLayout, content) : 0,
      ),
    );

    ctx.save();
    ctx.beginPath();
    // Clipped to the **padding** box, not the content box: the content box is
    // the cap band, and an ascender or a descender is outside it by
    // construction. The padding is where a field's own border stops the text
    // anyway, so this is the edge that was always meant.
    const clip = this._inkClip(content);
    ctx.rect(clip.x, clip.y, clip.width, clip.height);
    ctx.clip();
    const shift = this._scrollShift();
    // Where the ink goes, and where the marks over the value go. They are
    // the same origin whenever there is a value to mark: the two differ only
    // for an empty field, where the ink is the placeholder — as wide as the
    // hint and placed for it — and the caret still belongs to the value,
    // which is empty and sits at the start edge.
    const originX = this._lineOriginX(layout, content) + shift;
    const valueX = valueLayout
      ? this._lineOriginX(valueLayout, content) + shift
      : originX;

    const [a, b] = this._selection();
    if (this._showsSelection() && a !== b && !isEmpty && valueLayout) {
      // A **translucent** accent rather than an opaque light blue. The ink
      // on top is `style.color`, which this fill does not control, so an
      // opaque highlight has to be picked to contrast with it — and no one
      // colour does that on both a light and a dark palette. `#b3d4fc`
      // under the dark palette's near-white ink is 1.3:1, which is nothing.
      // Tinting the surface instead leaves the ink's own contrast intact.
      ctx.fillStyle = this.props.selectionColor ?? this.theme.selection;
      // One band per direction run, not one rectangle between the two caret
      // positions: a range is contiguous in logical order and a line is laid
      // out in visual order, so a selection that crosses into an Arabic word
      // covers two disjoint stretches of pixels and the single rect this
      // used to draw painted over text nobody had selected. The bands are
      // `textRangeRects`'s, so the highlight is the geometry the accessors
      // report; only the vertical extent is the field's own — a field
      // highlights the cap band with breathing room rather than the line box.
      for (const band of rangeBands(
        valueLayout,
        this._displayValue(),
        this._displayIndex(a),
        this._displayIndex(b),
      )) {
        ctx.fillRect(valueX + band.x, markY, band.width, markHeight);
      }
    }

    layout.draw(ctx, originX, textY);
    this._paintPreedit(ctx, valueX, textY, style);

    if (this._focused && this._caretOn && a === b) {
      ctx.fillStyle = this.props.caretColor ?? this.theme.caret ?? style.color;
      ctx.fillRect(
        valueX + caretX,
        markY,
        CARET_WIDTH * this.scale,
        markHeight,
      );
    }
    ctx.restore();
  }
}

// Undo/redo and IME composition live in their own files (see install.js).
installMethods(TextInputNode, TextInputHistory, TextInputPreedit);
