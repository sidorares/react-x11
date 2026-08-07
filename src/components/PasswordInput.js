// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useRef, useState } from 'react';
import { DEFAULT_TEXT_STYLE, createStyles } from '../styles.js';
import { useClipboard } from '../appcontext.js';
import { windowIdOf } from '../windowid.js';
import { useTheme } from './theme.js';
import { changeEvent } from './change.js';
import { measureLabel } from './anchor.js';
import { hash32, maskWidth, strokeScribble } from './scribble.js';
import {
  MOD,
  XK_BACKSPACE,
  XK_DELETE,
  XK_INSERT,
  XK_KP_ENTER,
  XK_RETURN,
  ctrlChordLetter,
} from '../keysyms.js';

const h = React.createElement;

// The reference advance the mask's width is measured in: one character of
// the field's own font, so a themed field keeps the mask in proportion —
// and the *only* text this widget ever lays out while it is masked.
const REFERENCE_GLYPH = 'n';
const ICON = 18;

// Ctrl chords this field answers, as keysym letters.
const CTRL_U = 0x75;
const CTRL_V = 0x76;

// Control characters, which a paste has no business contributing: a manager's
// clipboard entry often ends in a newline, and an auto-type sequence that
// pastes and then submits would otherwise put that newline *in* the secret.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

const s = createStyles({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 8,
    paddingLeft: 10,
    paddingRight: 6,
  },
  slot: { flexGrow: 1, flexShrink: 1, minWidth: 0, justifyContent: 'center' },
  icon: {
    width: ICON,
    height: ICON,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    cursor: 'pointer',
    transition: { backgroundColor: 80 },
  },
  eye: { width: 16, height: 12 },
  caps: { width: 12, height: 12, flexShrink: 0 },
});

/** An eye, and an eye with a line through it. Drawn rather than set in a
 *  font: a glyph the machine has not got is a tofu box in a login form. */
function EyeGlyph({ color, open }) {
  return h('canvas', {
    style: s.eye,
    onDraw: (ctx, { width, height }) => {
      const midY = height / 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(1, midY);
      ctx.quadraticCurveTo(width / 2, -1, width - 1, midY);
      ctx.quadraticCurveTo(width / 2, height + 1, 1, midY);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(width / 2, midY, 2.2, 0, Math.PI * 2);
      ctx.stroke();
      if (!open) {
        ctx.beginPath();
        ctx.moveTo(2, height - 1);
        ctx.lineTo(width - 2, 1);
        ctx.stroke();
      }
    },
  });
}

/** Caps Lock: an arrow standing on a bar, which is what the key is engraved
 *  with wherever it is engraved at all. */
function CapsGlyph({ color }) {
  return h('canvas', {
    style: s.caps,
    onDraw: (ctx, { width, height }) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(width / 2, 1);
      ctx.lineTo(width - 1, height / 2);
      ctx.lineTo(width * 0.72, height / 2);
      ctx.lineTo(width * 0.72, height - 4);
      ctx.lineTo(width * 0.28, height - 4);
      ctx.lineTo(width * 0.28, height / 2);
      ctx.lineTo(1, height / 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(width * 0.28, height - 2.5, width * 0.44, 2);
    },
  });
}

/** Code points, not UTF-16 units: deleting half a surrogate pair is how a
 *  password with an emoji in it becomes one nobody can retype. */
const chars = (text) => Array.from(text);

/**
 * <PasswordInput value onChange …boxProps> — a masked field whose mask is a
 * **scribble**, not a row of bullets.
 *
 *   <PasswordInput value={secret} onChange={(ev) => setSecret(ev.value)} />
 *
 * Bullets answer the wrong question. They report how many characters have
 * been typed — countably, from across the room — and report almost nothing
 * about the keystroke that just landed, one more identical dot at the end of
 * a row of identical dots being the least visible change a field could make.
 *
 * Here one stroke is drawn through points from a generator seeded by the
 * window and the value, so **every keystroke redraws the whole curve** and
 * nothing in the shape is per-character. The width grows with what has been
 * typed — a mask that did not would say nothing about progress — by a
 * per-position advance from a *window*-seeded stream, so it is monotonic
 * without being a ruler. `scribble.js` carries the reasoning and the limits;
 * the headline limit is that this hides a glance, not a recording.
 *
 * **The secret is never laid out or drawn while it is masked.** The mask's
 * width comes from one reference character, so the password never enters
 * ntk's shaping cache and its glyphs never reach the X server. Revealing it
 * costs exactly what revealing it costs.
 *
 * Editing is deliberately smaller than `<textinput>`'s, because a scribble
 * has nowhere to put a caret: type, Backspace, Ctrl+Backspace or Ctrl+U or
 * Delete to clear, Ctrl+V or Shift+Insert to paste, Enter for `onSubmit`.
 * There is no caret, no selection, no undo history — a rewindable secret is
 * not a feature — and **no copy**: Ctrl+C and Ctrl+X do nothing, and the
 * field never takes the PRIMARY selection, so a middle-click in another
 * application cannot spill it.
 *
 * Those two exclusions are also the integration story, which is why they are
 * exactly this shape: **paste** is how every password manager on the desktop
 * delivers a secret it did not type, and **typing** is the other half —
 * XTEST auto-type arrives as ordinary key events and this field cannot tell
 * it from a person. See docs/components.md.
 *
 * The eye is a pointer affordance and not a tab stop, as GTK's peek icon is.
 * `revealed` + `onRevealChange` make it controlled, for an app that wants the
 * toggle somewhere its keyboard can reach.
 */
export function PasswordInput({
  value,
  defaultValue,
  onChange,
  onSubmit,
  name,
  placeholder = 'Password',
  revealable = true,
  revealed,
  onRevealChange,
  maxLength,
  drawMask,
  disabled = false,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const fieldRef = useRef(null);
  const clipboard = useClipboard();
  const [ownValue, setOwnValue] = useState(defaultValue ?? '');
  const [ownRevealed, setOwnRevealed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [capsLock, setCapsLock] = useState(false);

  const text = String(value ?? ownValue ?? '');
  const length = chars(text).length;
  const showing = revealed === undefined ? ownRevealed : revealed;

  const size = DEFAULT_TEXT_STYLE.size;
  const unit = measureLabel(fieldRef.current, REFERENCE_GLYPH, { size });
  const lineHeight = Math.ceil(unit.height || size * 1.4);

  // The window is in the seed so the same password does not draw the same
  // curve in two windows, or in this one tomorrow: an X id is not a secret,
  // but it is not a constant either.
  const windowSeed = hash32(`w${windowIdOf(fieldRef) ?? 0}`);
  const shapeSeed = (windowSeed ^ hash32(text)) >>> 0;

  const commit = (next) => {
    const clipped =
      maxLength == null ? next : chars(next).slice(0, maxLength).join('');
    if (clipped === text) return;
    if (value === undefined) setOwnValue(clipped);
    onChange?.(changeEvent('password', name, clipped));
  };

  const reveal = (on) => {
    if (revealed === undefined) setOwnRevealed(on);
    onRevealChange?.(on);
  };

  const paste = (selection) => {
    try {
      clipboard
        .readText({ selection })
        // nothing owns the selection, or its owner refused text: a field that
        // threw here would take the app down over an empty clipboard
        .then(
          (pasted) => commit(text + String(pasted).replace(CONTROL_CHARS, '')),
          () => {},
        );
    } catch {
      // no clipboard on this app object at all (a mock, an old ntk)
    }
  };

  const onKeyDown = (ev) => {
    if (disabled) return;
    setCapsLock(Boolean(ev.nativeEvent?.buttons & MOD.Lock));

    if (ev.keysym === XK_RETURN || ev.keysym === XK_KP_ENTER) {
      onSubmit?.(text);
      return;
    }
    if (ev.keysym === XK_BACKSPACE) {
      // Ctrl+Backspace deletes a word everywhere else, and a password has no
      // words — so it clears, which is what someone who has lost track of
      // what is in there actually wants.
      commit(ev.ctrlKey ? '' : chars(text).slice(0, -1).join(''));
      return;
    }
    if (ev.keysym === XK_DELETE) {
      commit('');
      return;
    }
    if (ev.keysym === XK_INSERT) {
      if (ev.shiftKey) paste('CLIPBOARD');
      return;
    }
    if (ev.ctrlKey) {
      const letter = ctrlChordLetter(ev);
      // Ctrl+U clears the line, as readline and every pinentry on the desktop
      // do; Ctrl+V pastes. Nothing for C, X or A — there is no selection to
      // copy, and the secret does not leave by the clipboard.
      if (letter === CTRL_U) commit('');
      else if (letter === CTRL_V) paste('CLIPBOARD');
      return;
    }
    // A printable character and only that: a control code is not text, and
    // neither is a key that types nothing at all.
    if (ev.codepoint != null && ev.codepoint >= 32 && ev.codepoint !== 127) {
      commit(text + String.fromCodePoint(ev.codepoint));
    }
  };

  const draw = (ctx, box) => {
    const info = {
      width: maskWidth(
        length,
        unit.width || size * 0.55,
        windowSeed,
        box.width,
      ),
      height: box.height,
      seed: shapeSeed,
      color: disabled ? theme.dim : theme.text,
      length,
    };
    if (drawMask) drawMask(ctx, info);
    else strokeScribble(ctx, info);
  };

  return h(
    'box',
    {
      theme,
      role: 'textbox',
      ref: fieldRef,
      focusable: !disabled,
      onKeyDown: disabled ? undefined : onKeyDown,
      onFocus: () => setFocused(true),
      onBlur: () => {
        setFocused(false);
        // A field nobody is in should not still be showing the secret: the
        // reveal is for the moment you are looking at it, not a mode. The eye
        // is not focusable, so this only fires on the way out of the widget.
        reveal(false);
        setCapsLock(false);
      },
      ...boxProps,
      style: [
        s.field,
        {
          cursor: disabled ? 'default' : 'text',
          borderWidth: theme.borderWidth,
          borderRadius: theme.radius,
          borderColor: focused ? theme.borderFocus : theme.border,
          backgroundColor: disabled ? theme.surfaceHover : theme.background,
        },
        style,
      ],
    },
    h(
      'box',
      { style: [s.slot, { height: lineHeight }] },
      length === 0
        ? h('text', { style: { color: theme.dim } }, placeholder)
        : showing
          ? h('text', { style: { color: theme.text } }, text)
          : h('canvas', {
              // `onDraw` is a plain prop compared by identity, so a fresh
              // closure each render is what repaints the mask — and it
              // repaints that one node, not the field around it.
              onDraw: draw,
              style: { flexGrow: 1, height: lineHeight },
            }),
    ),
    capsLock && !showing && h(CapsGlyph, { color: theme.dim }),
    revealable &&
      !disabled &&
      h(
        'box',
        {
          role: 'button',
          // Not a tab stop, and not a focus target for a press either: focus
          // stays on the field, so leaving the widget is the only blur it
          // ever sees — which is what makes "hide it again on the way out"
          // mean what it says.
          focusable: false,
          onClick: () => reveal(!showing),
          style: [
            s.icon,
            { borderRadius: theme.radiusSmall },
            {
              ':hover': { backgroundColor: theme.surfaceHover },
              ':active': { backgroundColor: theme.surfaceActive },
            },
          ],
        },
        h(EyeGlyph, {
          color: disabled ? theme.border : theme.dim,
          open: !showing,
        }),
      ),
  );
}
