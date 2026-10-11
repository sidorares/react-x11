// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { capTrim, labelContent, useTheme } from './theme.js';
import { windowRect } from '../anchor.js';
import { XK_ESCAPE } from './keys.js';

const h = React.createElement;

const DEFAULT_WIDTH = 360;

/**
 * <Dialog open title onClose actions>…</Dialog> — a dialog in a `<popup>`,
 * centred over the owner window.
 *
 * **The window manager knows it is a dialog** (issue #130). The popup is a
 * managed window — `overrideRedirect={false}` — with `WM_TRANSIENT_FOR`
 * pointing at the window that owns it, resolved from the anchor this
 * component already keeps for placement. Measured against quartz-wm, the
 * thinnest EWMH implementation in the stack: the dialog is reparented into a
 * real frame, so it has a titlebar and can be moved and closed the way every
 * other window can; it loses maximize and fullscreen; and the WM puts
 * SKIP_TASKBAR and SKIP_PAGER on it, so it is not a second entry in the
 * taskbar or the alt-tab list. A fuller WM also stacks it above its owner
 * and iconifies it alongside.
 *
 * `managed={false}` goes back to the override-redirect popup 1.x shipped: no
 * frame, not movable, dismissed by a press anywhere outside (a pointer
 * grab). That is the right shape for a transient confirmation on a display
 * with no window manager at all, and the wrong one for anything the user
 * might want to move.
 *
 * `title` is drawn exactly once (issue #370). Managed, it is the frame's
 * caption and the window manager draws it, so the content starts with the
 * body; unmanaged there is no frame, so it is drawn as a bold heading at the
 * top of the content instead. Either way it names the dialog surface for
 * accessibility (`aria-label`).
 *
 * The two differ in how a press outside behaves, and it is not a bug either
 * way: a managed dialog stays open, because a real dialog does. Escape and
 * the WM close button both call `onClose`; so does a press outside when
 * `managed={false}`.
 *
 * The focus behaviour is the renderer's, not this component's: `trapFocus`
 * keeps Tab inside the dialog, stops presses elsewhere from moving focus,
 * and hands focus back to whatever had it — usually the button that opened
 * the dialog — when it closes. Put `autoFocus` on a control inside to choose
 * the first stop; otherwise the dialog surface itself takes focus, so
 * Escape and Tab work immediately (`docs/events.md`, "Focus scopes").
 *
 * Pointer modality is *not* enforced — widgets in the owner window stay
 * clickable behind the dialog, so use it for confirmations rather than as a
 * security boundary. `_NET_WM_STATE_MODAL` is the mechanism for that, and it
 * belongs to the `states` work; it means nothing without the
 * `WM_TRANSIENT_FOR` this now sets, which is why that had to come first.
 *
 * **The height is the content's** (issue #940). It used to be 170 whatever
 * the dialog held, because the dialog was centred from React — and centring
 * needs a size, which React does not have before anything is laid out. So
 * content past 170 was laid out below the bottom of the window and cut off
 * there, `actions` first: the one row a dialog cannot do without was the
 * first to go. Now the popup centres *itself*: `anchor={{ rect, placement:
 * 'center' }}` over its owner window, and `realize()` measures the content,
 * places it from that size and only then creates the window — so it is born
 * the right size in the right place, the order an anchored menu already
 * had. `height="auto"` is the default because a fixed height that clips is
 * never what anyone means; a number is still exactly that number.
 *
 * Three things follow from it:
 *
 * - **Capped at the monitor**, as every `'auto'` window is. Past that the
 *   body scrolls (`overflow: 'scroll'`, a tab stop only while it does) and
 *   the actions row stays pinned under it, in the window — under a fixed
 *   height too, which used to clip the same way.
 * - **It follows its content** while open (the `'auto'` re-fit, #929), and
 *   grows from where it is rather than being centred again: its top edge
 *   stays put, so a line appearing under a field does not move the field
 *   under the pointer. It is pulled up only as far as it takes to stay on
 *   the monitor (`_keepCentredTop`, nodes/window/anchoring.js).
 * - **It is centred once**, over where the owner was when it opened — the
 *   owner's rect is taken when the dialog opens and is not tracked after,
 *   so a managed dialog the user dragged aside stays where they put it.
 *
 * `width` stays a number by default (360): a body of prose wraps to it, and
 * a natural width would be as wide as its longest sentence. `width="auto"`
 * is there for a dialog whose content is laid out to its own width.
 */
export function Dialog({
  open,
  title,
  children,
  onClose,
  actions,
  managed = true,
  width = DEFAULT_WIDTH,
  height = 'auto',
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const anchor = useRef(null);
  const surface = useRef(null);
  // the owner window's rect on the screen, which the popup centres itself
  // over — taken once, when the dialog opens (see above)
  const [owner, setOwner] = useState(null);

  // Screen coordinates are only knowable once the anchor is laid out inside
  // a realized window — hence a layout effect rather than placement at
  // render time. The size is not needed here any more: the popup works out
  // its own, and its own position from it.
  useLayoutEffect(() => {
    if (!open) {
      setOwner(null);
      return;
    }
    const next = windowRect(anchor.current);
    if (next) setOwner(next);
  }, [open]);

  // nothing inside claimed focus (no autoFocus): the dialog takes it itself,
  // the way a browser focuses a <dialog> element, so keys have somewhere to
  // land and the trap has an inside
  useEffect(() => {
    const node = surface.current;
    if (!owner || !node || node.focusWithin) return;
    node.focus();
  }, [owner]);

  const onKeyDown = (ev) => {
    if (ev.keysym === XK_ESCAPE) {
      ev.preventDefault();
      onClose?.();
    }
  };

  return h(
    'box',
    // out of flow: an anchor for the window geometry, never part of layout
    {
      theme,
      ref: anchor,
      style: { position: 'absolute', width: 0, height: 0 },
    },
    owner &&
      h(
        'popup',
        {
          anchor: { rect: owner, placement: 'center' },
          width,
          height,
          trapFocus: true,
          // A managed window is the window manager's to move, and a
          // client-side pointer grab over one is a fight nobody wins — the
          // press that would start a titlebar drag is swallowed instead. So
          // the grab and the frame are the same choice, made once.
          overrideRedirect: !managed,
          grab: !managed,
          windowType: 'dialog',
          // inert on an override-redirect window, and ntk warns if asked to
          // write it there, so only the managed dialog claims an owner
          transientFor: managed ? anchor : undefined,
          title: managed ? title : undefined,
          onDismiss: managed ? undefined : () => onClose?.(),
          // the WM's close button, which a managed dialog now has
          onCloseRequest: managed ? () => onClose?.() : undefined,
          onKeyDown,
          style: { backgroundColor: theme.background },
        },
        h(
          'box',
          {
            ref: surface,
            role: 'dialog',
            'aria-modal': true,
            'aria-label': typeof title === 'string' ? title : undefined,
            tabIndex: -1,
            ...boxProps,
            style: [
              {
                flexGrow: 1,
                padding: 16,
                gap: 12,
                borderWidth: theme.borderWidth,
                borderColor: theme.border,
                backgroundColor: theme.surface,
              },
              style,
            ],
          },
          // a managed dialog's title is already in the WM frame's caption;
          // drawing it again here showed it twice (issue #370). Only the
          // unmanaged popup, which has no frame, needs the in-content heading.
          !managed &&
            title &&
            h(
              'text',
              {
                style: [
                  capTrim,
                  { fontSize: 15, fontWeight: 'bold', color: theme.text },
                ],
              },
              title,
            ),
          // The body is what gives way when the dialog cannot be as tall as
          // its content — capped at the monitor, or held to a `height` — so
          // it scrolls, and the actions row below it never leaves the window.
          //
          // The column inside it is `height: '100%'` rather than its natural
          // height, which is what keeps the body's old behaviour for content
          // that fills it: inside a scroller a box is as tall as its content,
          // and a dialog built as a field over a list that scrolls on its own
          // (the chat example's) would have its list laid out whole and the
          // body scrolled instead. At the viewport's height that content is
          // squeezed as it always was, and content that cannot be squeezed
          // that far — lines of text — is held at its automatic minimum
          // (#249), which is taller than the viewport, and that is the
          // overflow the body scrolls.
          h(
            'box',
            { style: { flexGrow: 1, overflow: 'scroll' } },
            h(
              'box',
              { style: { gap: 8, height: '100%' } },
              labelContent(children, { color: theme.text }),
            ),
          ),
          actions &&
            h(
              'box',
              {
                style: {
                  flexDirection: 'row',
                  justifyContent: 'flex-end',
                  alignItems: 'center',
                  gap: 8,
                },
              },
              actions,
            ),
        ),
      ),
  );
}
