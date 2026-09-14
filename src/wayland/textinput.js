// Input methods: `zwp_text_input_v3`, the compositor's IME talking to the
// tree's text controls.
//
// On X11 there is no input method here at all — `compose.js` turns dead
// keys and Compose sequences into characters client-side, and that is the
// whole story. Under a Wayland compositor the input method is the
// compositor's (IBus behind mutter on GNOME), and it speaks this protocol:
// the client says which surface's text field has focus, what kind of text
// it holds, where its caret is and what surrounds it; the compositor answers
// with a **preedit** (the composition the user is still typing, to be shown
// at the caret) and **commits** (text to insert). That is the same shape as
// the client-side composer's `CompositionStart/Update/End`, and it lands on
// the same machinery (`src/nodes/preedit.js`) — the tree cannot tell an IBus
// preedit from a pending dead key, and neither can an application's
// `onCompositionUpdate`.
//
// Three things about the protocol shape this file:
//
// - **Both directions are double-buffered.** Requests describing the field
//   (`enable`, `set_content_type`, `set_cursor_rectangle`,
//   `set_surrounding_text`) take effect on `commit`, and the compositor's
//   events (`preedit_string`, `commit_string`, `delete_surrounding_text`)
//   take effect on `done`, all at once and in a fixed order: delete, then
//   commit, then the new preedit. `done` carries the number of commits the
//   compositor had seen; a stale one is still applied, as the spec says.
// - **The state comes from the tree, at the end of a frame.** What the IME
//   needs to know — which control is focused, where its caret is, what it
//   holds — changes on focus moves, on edits and on caret moves, and every
//   one of those repaints the field. So the backend window calls `sync()`
//   once each frame after the renderer has painted, when the layout is
//   current and the caret rectangle can be read off it, and `sync` sends
//   only what changed. No hook into the event manager, no listener per
//   field: a comparison per frame against what was last committed.
// - **The compositor filters keys the IME consumed** before `wl_keyboard.key`
//   reaches us, so nothing here touches key delivery. A key that does arrive
//   is one the input method declined, and the client-side composer is right
//   to have its usual go at it.
//
// The enter/leave of the text input follows the seat's keyboard focus and
// names a `wl_surface`; the focused *node* is the window's focus manager's
// business, and a node in another surface of the same focus group — a field
// in the owner window while a dropdown holds the grab — is left alone until
// the keyboard comes back to its surface, which is what a toolkit does too.

import { runWithPriority, DiscreteEventPriority } from '../priority.js';

/** `REACT_X11_WAYLAND_TRACE=1`: a line on stderr per text-input event. */
const TRACE = Boolean(process.env.REACT_X11_WAYLAND_TRACE);

/** `zwp_text_input_v3.content_hint` bits. */
export const CONTENT_HINT = {
  NONE: 0,
  COMPLETION: 1,
  SPELLCHECK: 2,
  AUTO_CAPITALIZATION: 4,
  LOWERCASE: 8,
  UPPERCASE: 16,
  TITLECASE: 32,
  HIDDEN_TEXT: 64,
  SENSITIVE_DATA: 128,
  LATIN: 256,
  MULTILINE: 512,
};

/** `zwp_text_input_v3.content_purpose`. */
export const CONTENT_PURPOSE = {
  NORMAL: 0,
  ALPHA: 1,
  DIGITS: 2,
  NUMBER: 3,
  PHONE: 4,
  URL: 5,
  EMAIL: 6,
  NAME: 7,
  PASSWORD: 8,
  PIN: 9,
  DATE: 10,
  TIME: 11,
  DATETIME: 12,
  TERMINAL: 13,
};

/** `zwp_text_input_v3.change_cause`. */
export const CHANGE_CAUSE = { INPUT_METHOD: 0, OTHER: 1 };

/**
 * The DOM's `inputMode` values, which is the vocabulary a `<textinput>` can
 * use to say what it expects, mapped onto the protocol's purposes. `text`,
 * `search` and `none` are the normal purpose: they change a virtual
 * keyboard's return key, which nothing here has.
 */
const PURPOSE_BY_INPUT_MODE = {
  numeric: CONTENT_PURPOSE.DIGITS,
  decimal: CONTENT_PURPOSE.NUMBER,
  tel: CONTENT_PURPOSE.PHONE,
  email: CONTENT_PURPOSE.EMAIL,
  url: CONTENT_PURPOSE.URL,
};

/**
 * The protocol's own cap on surrounding text — a Wayland message is at most
 * 4096 bytes, and the spec asks for no more than 4000 of text.
 */
export const MAX_SURROUNDING_BYTES = 4000;

const utf8 = (s) => Buffer.byteLength(s, 'utf8');

/** A fresh set of the compositor's double-buffered event state. */
const freshPending = () => ({
  preedit: null,
  commit: null,
  before: 0,
  after: 0,
});

export class WaylandTextInput {
  /**
   * @param {import('./app.js').WaylandApp} app — or anything with `conn`,
   *   `seat` and a `windows` map of `wl_surface` id → backend window
   */
  constructor(app, manager, proxy) {
    this.app = app;
    this.manager = manager;
    this.proxy = proxy;
    /** the `wl_surface` id with text-input focus, or null */
    this.entered = null;
    /** commit requests sent so far — the serial `done` echoes */
    this.commits = 0;
    /** the serial of the last `done` */
    this.doneSerial = 0;
    /**
     * The field the compositor has been told about, with the state last
     * committed for it, or null while disabled: `{ win, node, hint, purpose,
     * rect, value, caret, anchor, sendText }`.
     */
    this.active = null;
    /** whether an IME preedit is open on `active.node` */
    this.composing = false;
    this._pending = freshPending();
    /** the last text change was the IME's own — no `other` cause for it */
    this._imeChanged = false;
    this._destroyed = false;
  }

  /**
   * Bind the manager and make the seat's text input. Null when the
   * compositor has no `zwp_text_input_manager_v3` (every GNOME has one),
   * which the app treats as "no input method", the way it treats any other
   * absent global.
   */
  static async create(app) {
    const manager = await app.conn.bind('zwp_text_input_manager_v3');
    if (!manager || !app.seat?.seat) return null;
    const proxy = manager.$.get_text_input(app.seat.seat.id);
    proxy.setMaxListeners?.(0);
    const input = new WaylandTextInput(app, manager, proxy);
    input._wire();
    return input;
  }

  _wire() {
    const p = this.proxy;
    p.on('enter', (surfaceId) => this._onEnter(surfaceId));
    p.on('leave', (surfaceId) => this._onLeave(surfaceId));
    // Buffered until `done`, as the spec has it: each one replaces the
    // pending value, and `done` applies the set.
    p.on('preedit_string', (text, cursorBegin, cursorEnd) => {
      this._pending.preedit = { text: text ?? '', cursorBegin, cursorEnd };
    });
    p.on('commit_string', (text) => {
      this._pending.commit = text ?? '';
    });
    p.on('delete_surrounding_text', (before, after) => {
      this._pending.before = before;
      this._pending.after = after;
    });
    p.on('done', (serial) => this._onDone(serial));
  }

  // ---- focus ------------------------------------------------------------

  _window(surfaceId) {
    return surfaceId == null ? null : (this.app.windows.get(surfaceId) ?? null);
  }

  _onEnter(surfaceId) {
    if (TRACE) trace(`enter surface ${surfaceId}`);
    this.entered = surfaceId;
    const win = this._window(surfaceId);
    if (!win) return;
    // Now, with whatever layout the tree has — a field focused before the
    // window got the keyboard should be composing from the first key — and
    // again at the end of the next frame, when the caret rectangle is
    // certain to be read off a current layout.
    this.sync(win);
    win.requestAnimationFrame?.(() => {});
  }

  _onLeave(surfaceId) {
    if (TRACE) trace(`leave surface ${surfaceId}`);
    if (this.entered === surfaceId) this.entered = null;
    // The spec has the client drop its preedit here. The compositor
    // considers nothing enabled on a surface it has left, but saying so
    // costs one request and leaves no compositor guessing.
    if (this.active?.win === this._window(surfaceId) || !this.entered) {
      this._disable();
    }
  }

  /**
   * The focused text control of a window, or null: a node the window's
   * focus manager has, that lives in *this* surface, and that composes —
   * the duck type is `defaultComposition` + `textCaretRect`, which is what
   * `<textinput>` and `<textarea>` implement and what a registered element
   * with a caret of its own would implement to be reached the same way.
   * `composes === false` is an element with an input method of its own.
   */
  _focusedTextControl(win) {
    const node = win._reactX11Node?.events?.focusManager?.focused ?? null;
    if (!node || node.destroyed) return null;
    if (node.root?.window !== win) return null;
    if (typeof node.defaultComposition !== 'function') return null;
    if (typeof node.textCaretRect !== 'function') return null;
    if (node.composes === false) return null;
    return node;
  }

  /**
   * Bring the compositor up to date about `win`'s focused field. Called by
   * the backend window at the end of each frame it runs, and on `enter`.
   * Cheap when nothing changed: a handful of comparisons.
   */
  sync(win) {
    if (this._destroyed || !win) return;
    if (this.entered == null || this._window(this.entered) !== win) return;
    const node = win._destroyed ? null : this._focusedTextControl(win);
    if (node !== this.active?.node) {
      if (this.active) this._disable();
      if (node) this._enable(win, node);
      return;
    }
    if (node) this._update(win, node);
  }

  // ---- what the compositor is told ------------------------------------

  /**
   * The field as the protocol describes one: what kind of text, where the
   * caret is in surface-local logical pixels, and the value with the caret
   * and anchor in it (code points here; bytes on the wire, converted when
   * sent, since the comparison that decides whether to send is cheaper on
   * the strings the node already holds).
   */
  _describe(win, node) {
    const props = node.props ?? {};
    let hint = CONTENT_HINT.NONE;
    let purpose = CONTENT_PURPOSE.NORMAL;
    if (node.kind === 'textarea') hint |= CONTENT_HINT.MULTILINE;
    // `sensitive` is the field that never lets its text reach a selection
    // (docs/elements.md); an input method's word history is another place
    // it must not reach, and the same field says so with one prop.
    if (props.sensitive) hint |= CONTENT_HINT.SENSITIVE_DATA;
    const byMode = PURPOSE_BY_INPUT_MODE[props.inputMode];
    if (byMode !== undefined) purpose = byMode;
    const value = typeof node.value === 'string' ? node.value : '';
    const length = Array.from(value).length;
    const clamp = (n, fallback) =>
      Number.isInteger(n) ? Math.max(0, Math.min(n, length)) : fallback;
    const caret = clamp(node._caret, length);
    const anchor = clamp(node._anchor, caret);
    return {
      hint,
      purpose,
      rect: caretRectangle(win, node, caret),
      value,
      caret,
      anchor,
      // The surrounding text is what lets an IME reconvert a word or place
      // punctuation; a secret is not offered for that.
      sendText: !props.sensitive,
    };
  }

  _enable(win, node) {
    const d = this._describe(win, node);
    const p = this.proxy.$;
    p.enable();
    // Sent with the enable, not after it: the spec lets a compositor that
    // has once applied an empty cursor rectangle ignore later ones.
    p.set_content_type(d.hint, d.purpose);
    if (d.rect) {
      p.set_cursor_rectangle(d.rect.x, d.rect.y, d.rect.width, d.rect.height);
    }
    if (d.sendText) {
      const s = surroundingText(d.value, d.caret, d.anchor);
      p.set_surrounding_text(s.text, s.cursor, s.anchor);
    }
    this._commit();
    this.active = { win, node, ...d };
    this.composing = false;
    this._imeChanged = false;
    this._pending = freshPending();
    if (TRACE) {
      trace(
        `enable <${node.kind}> hint=${d.hint} purpose=${d.purpose} ` +
          `rect=${d.rect ? [d.rect.x, d.rect.y, d.rect.width, d.rect.height].join(',') : 'none'}`,
      );
    }
  }

  /**
   * Tell the compositor the field is gone, and the field that its
   * composition is. The tree's own focus change has already cleared the
   * preedit the field was drawing (`defaultBlur`); what is owed is the
   * `CompositionEnd` an application that saw the start is waiting for, with
   * no data, which is how an abandoned composition has always ended.
   */
  _disable() {
    const active = this.active;
    if (!active) return;
    this.active = null;
    this._pending = freshPending();
    const { node } = active;
    if (this.composing) {
      this.composing = false;
      const events = node.destroyed ? null : node.root?.events;
      if (events) {
        runWithPriority(DiscreteEventPriority, () =>
          events._composition('End', node, '', null),
        );
      }
    }
    this.proxy.$.disable();
    this._commit();
    if (TRACE) trace(`disable <${node.kind}>`);
  }

  /** Send what changed about the active field since the last commit. */
  _update(win, node) {
    const a = this.active;
    const d = this._describe(win, node);
    const p = this.proxy.$;
    let changed = false;
    if (d.hint !== a.hint || d.purpose !== a.purpose) {
      p.set_content_type(d.hint, d.purpose);
      changed = true;
    }
    if (d.rect && !sameRect(d.rect, a.rect)) {
      p.set_cursor_rectangle(d.rect.x, d.rect.y, d.rect.width, d.rect.height);
      changed = true;
    }
    if (d.value !== a.value || d.caret !== a.caret || d.anchor !== a.anchor) {
      // A change the IME did not make — typing a key it declined, a click
      // placing the caret — is the IME's cue to drop or restart what it was
      // composing; the cause is how it tells that apart from its own edit
      // coming back as surrounding text. The initial value of the cause is
      // `input_method` and it resets on every commit, so only `other` is
      // ever worth sending.
      if (!this._imeChanged) p.set_text_change_cause(CHANGE_CAUSE.OTHER);
      if (d.sendText) {
        const s = surroundingText(d.value, d.caret, d.anchor);
        p.set_surrounding_text(s.text, s.cursor, s.anchor);
      }
      changed = true;
    }
    this._imeChanged = false;
    if (!changed) return;
    this._commit();
    Object.assign(a, d);
  }

  _commit() {
    this.proxy.$.commit();
    this.commits++;
  }

  // ---- what the compositor says ----------------------------------------

  /**
   * Apply the buffered events, in the order the spec fixes: the old preedit
   * gives way to the cursor, the surrounding text is deleted, the commit
   * string is inserted, the new preedit goes in at the caret.
   *
   * A serial that is not the number of commits sent means the compositor
   * answered an older state; the spec is explicit that the changes are
   * applied all the same. Nothing is sent *in response* here either way —
   * the field's repaint runs the next frame's `sync`, which reports the new
   * surrounding text as a change of the input method's own making.
   */
  _onDone(serial) {
    this.doneSerial = serial;
    const pending = this._pending;
    this._pending = freshPending();
    const active = this.active;
    if (TRACE) {
      // what a `sensitive` field is being sent is a secret in a log too
      const shown = (s) =>
        active && !active.sendText
          ? `<${Array.from(s).length} hidden>`
          : JSON.stringify(s);
      trace(
        `done #${serial}${serial !== this.commits ? ` (stale, ${this.commits} sent)` : ''}` +
          ` delete=${pending.before}/${pending.after}` +
          ` commit=${shown(pending.commit ?? '')}` +
          ` preedit=${shown(pending.preedit?.text ?? '')}`,
      );
    }
    if (!active || active.node.destroyed) return;
    const node = active.node;
    const events = node.root?.events;
    if (!events) return;
    runWithPriority(DiscreteEventPriority, () =>
      this._apply(events, node, pending, serial),
    );
  }

  _apply(events, node, pending, serial) {
    // What `nativeEvent` carries on the events this raises: there is no key
    // behind an IME's commit, and the serial is what ties it back to the
    // protocol trace.
    const native = { type: 'text-input', serial };

    // The preedit is never in the value, so deleting around the selection
    // works on the value directly and leaves the composition — about to
    // end — where it is drawn. `before` and `after` are bytes either side
    // of the selection, whole characters only.
    if (pending.before > 0 || pending.after > 0) {
      const chars = Array.from(node.value ?? '');
      const caret = clampIndex(node._caret, chars.length);
      const anchor = clampIndex(node._anchor, caret);
      const a = Math.min(caret, anchor);
      const b = Math.max(caret, anchor);
      const from = a - charsWithin(chars, a, -pending.before);
      const to = b + charsWithin(chars, b, pending.after);
      if (to > from && typeof node._deleteRange === 'function') {
        node._deleteRange(from, to);
        this._imeChanged = true;
      }
    }

    // The commit string ends the composition with the text it produced —
    // `defaultComposition` inserts it the way a typed character is
    // inserted, through `_insert`, with `maxLength`, `onChange` and the
    // undo run all in play. A commit with no preedit before it is a
    // composition that started and ended in one `done`, which is what an
    // emoji picker or a direct-commit engine produces, and an application
    // hears the same pair of events either way.
    const commit = pending.commit;
    if (commit) {
      if (!this.composing) events._composition('Start', node, '', native);
      this.composing = false;
      events._composition('End', node, commit, native);
      this._imeChanged = true;
    }

    // The new preedit, with its cursor. The protocol counts the cursor in
    // bytes into the preedit; the tree wants code points, and a hidden
    // cursor (both -1) is drawn at the end, which is where a caret with no
    // better information goes.
    const preedit = pending.preedit;
    const text = preedit?.text ?? '';
    if (text) {
      if (!this.composing) {
        events._composition('Start', node, '', native);
        this.composing = true;
      }
      const cursor = preeditCursor(
        text,
        preedit.cursorBegin,
        preedit.cursorEnd,
      );
      events._composition('Update', node, text, native, cursor);
    } else if (this.composing) {
      this.composing = false;
      events._composition('End', node, '', native);
    }
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.active = null;
    this.proxy.removeAllListeners?.();
    try {
      this.proxy.$.destroy();
    } catch {
      /* the connection is going */
    }
  }
}

// ---- helpers ------------------------------------------------------------

function trace(line) {
  process.stderr.write(`react-x11 wayland: text-input ${line}\n`);
}

const clampIndex = (n, length) =>
  Number.isInteger(n) ? Math.max(0, Math.min(n, length)) : length;

/**
 * Where the caret is, in surface-local logical pixels — what
 * `set_cursor_rectangle` wants and where the IME puts its candidate window.
 * The node answers in content-relative device pixels (the rule in
 * backendwindow.js), so the frame's insets are added and the scale divided
 * out. A field whose text has no layout yet — no fonts, or not painted —
 * offers its content box, which at least puts the popup under the field.
 */
function caretRectangle(win, node, caret) {
  let r = null;
  try {
    r = node.textCaretRect(caret);
  } catch {
    r = null;
  }
  if (!r) {
    const box = node.contentBox?.() ?? node.abs;
    if (!box) return null;
    r = { x: box.x, y: box.y, width: 0, height: box.height };
  }
  const s = win.scale || 1;
  const i = win.insets ?? { left: 0, top: 0 };
  return {
    x: Math.round(r.x / s + (i.left ?? 0)),
    y: Math.round(r.y / s + (i.top ?? 0)),
    width: Math.max(1, Math.round((r.width ?? 0) / s)),
    height: Math.max(1, Math.round((r.height ?? 0) / s)),
  };
}

function sameRect(a, b) {
  return (
    !!a &&
    !!b &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

/**
 * The value around the selection as `set_surrounding_text` takes it: UTF-8
 * text with the cursor and anchor as byte offsets into it. The whole value
 * when it fits the message; otherwise a window grown outward from the
 * selection until the next character would not fit, so the cursor and the
 * selection are always inside what is sent.
 */
export function surroundingText(value, caret, anchor) {
  const chars = Array.from(value);
  let from = 0;
  let to = chars.length;
  if (utf8(value) > MAX_SURROUNDING_BYTES) {
    const a = Math.min(caret, anchor);
    const b = Math.max(caret, anchor);
    from = a;
    to = a;
    let bytes = 0;
    // the selection first, clipped at the cap if it alone is over it
    while (to < b) {
      const n = utf8(chars[to]);
      if (bytes + n > MAX_SURROUNDING_BYTES) break;
      bytes += n;
      to++;
    }
    let grew = true;
    while (grew) {
      grew = false;
      if (from > 0) {
        const n = utf8(chars[from - 1]);
        if (bytes + n <= MAX_SURROUNDING_BYTES) {
          from--;
          bytes += n;
          grew = true;
        }
      }
      if (to < chars.length) {
        const n = utf8(chars[to]);
        if (bytes + n <= MAX_SURROUNDING_BYTES) {
          to++;
          bytes += n;
          grew = true;
        }
      }
    }
  }
  const window = chars.slice(from, to);
  const offset = (index) =>
    utf8(
      window
        .slice(0, Math.max(0, Math.min(index - from, window.length)))
        .join(''),
    );
  return {
    text: window.join(''),
    cursor: offset(caret),
    anchor: offset(anchor),
  };
}

/**
 * How many whole characters fit in `bytes` of UTF-8 walking from `index` —
 * forwards when `bytes` is positive, backwards when negative. A count that
 * lands inside a character stops before it.
 */
export function charsWithin(chars, index, bytes) {
  let count = 0;
  let left = Math.abs(bytes);
  if (bytes < 0) {
    for (let i = index - 1; i >= 0; i--) {
      const n = utf8(chars[i]);
      if (n > left) break;
      left -= n;
      count++;
    }
  } else {
    for (let i = index; i < chars.length; i++) {
      const n = utf8(chars[i]);
      if (n > left) break;
      left -= n;
      count++;
    }
  }
  return count;
}

/**
 * The preedit cursor as the tree takes it: `{ cursorBegin, cursorEnd }` in
 * code points into the preedit, or nothing for a hidden cursor.
 */
export function preeditCursor(text, beginBytes, endBytes) {
  if (beginBytes < 0 || endBytes < 0) return undefined;
  const chars = Array.from(text);
  const toChars = (bytes) => charsWithin(chars, 0, bytes);
  const begin = toChars(beginBytes);
  const end = Math.max(begin, toChars(endBytes));
  return { cursorBegin: begin, cursorEnd: end };
}
