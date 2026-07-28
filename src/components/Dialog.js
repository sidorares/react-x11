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
 * <Dialog open title onClose actions>…</Dialog> — a modal dialog in a
 * `<popup trapFocus grab>`, centred over the owner window.
 *
 * The focus behaviour is the renderer's, not this component's: `trapFocus`
 * keeps Tab inside the dialog, stops presses elsewhere from moving focus,
 * and hands focus back to whatever had it — usually the button that opened
 * the dialog — when it closes. Put `autoFocus` on a control inside to choose
 * the first stop; otherwise the dialog surface itself takes focus, so
 * Escape and Tab work immediately (`docs/events.md`, "Focus scopes").
 *
 * Escape closes: keys go to the focused node inside the popup and bubble out
 * through the popup's place in the JSX tree. `grab` makes a press anywhere
 * else in the session close it too. Pointer modality is *not* enforced —
 * widgets in the owner window stay clickable behind the dialog, so use it
 * for confirmations rather than as a security boundary.
 *
 * A `<popup>` is a real X window and needs its size up front, hence explicit
 * `width`/`height` rather than sizing to content.
 */
export function Dialog({
  open,
  title,
  children,
  onClose,
  actions,
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
          grab: true,
          windowType: 'dialog',
          onDismiss: () => onClose?.(),
          onKeyDown,
          style: { backgroundColor: theme.background },
        },
        h(
          'box',
          {
            ref: surface,
            tabIndex: -1,
            ...boxProps,
            style: [
              {
                flexGrow: 1,
                padding: 16,
                gap: 12,
                borderWidth: 1,
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
