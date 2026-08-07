// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { labelContent, useTheme } from './theme.js';
import { centerRect } from './anchor.js';
import { XK_ESCAPE } from './keys.js';

const h = React.createElement;

const DEFAULT_WIDTH = 360;

const DEFAULT_HEIGHT = 170;

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
 * `width`/`height` are explicit rather than sized to content, and now only
 * because of where the dialog is *placed*: `centeredRect` needs the size to
 * work out the offset that centres it over its owner, and that is computed
 * during the render that opens the popup, before anything has been laid out.
 * The popup itself could size to its content — see "Natural size" in
 * docs/elements.md — so this is the anchor math's constraint, not the X
 * window's.
 */
export function Dialog({
  open,
  title,
  children,
  onClose,
  actions,
  managed = true,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const anchor = useRef(null);
  const surface = useRef(null);
  const [rect, setRect] = useState(null);

  // the popup needs screen coordinates, which are only knowable once the
  // anchor is laid out inside a realized window — hence a layout effect
  // rather than placement at render time
  useLayoutEffect(() => {
    if (!open) {
      setRect(null);
      return;
    }
    const next = centerRect(anchor.current, { width, height });
    if (next) setRect(next);
  }, [open, width, height]);

  // nothing inside claimed focus (no autoFocus): the dialog takes it itself,
  // the way a browser focuses a <dialog> element, so keys have somewhere to
  // land and the trap has an inside
  useEffect(() => {
    const node = surface.current;
    if (!rect || !node || node.focusWithin) return;
    node.focus();
  }, [rect]);

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
    rect &&
      h(
        'popup',
        {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
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
                backgroundColor: theme.background,
              },
              style,
            ],
          },
          title &&
            h(
              'text',
              {
                style: { fontSize: 15, fontWeight: 'bold', color: theme.text },
              },
              title,
            ),
          h(
            'box',
            { style: { flexGrow: 1, gap: 8 } },
            labelContent(children, { color: theme.text }),
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
