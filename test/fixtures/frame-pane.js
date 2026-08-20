// The pane the frame tests mount: reports what reached it (props, bridged
// theme, bridged context) through a bridged callback, crashes on demand,
// and flushes through a callback from its close handler. Boxes only — no
// text — so the forked variant needs no fonts on the machine.
import React, { useEffect } from 'react';

import { useTheme } from '../../src/components/theme.js';
import { useFrameClose } from '../../src/frame/lifecycle.js';
import { Session } from './frame-contexts.js';

const h = React.createElement;

export default function Pane({ label, crash, onReport, onClosed }) {
  if (crash) throw new Error('pane asked to crash');
  const theme = useTheme();
  const session = Session.use();
  useFrameClose(() => {
    // the second argument is full of functions on purpose: what arrives is
    // what sanitizeArgs let through
    onClosed?.('closing', { flush: () => {} });
  });
  const accent = theme.accent;
  const user = session?.user ?? null;
  useEffect(() => {
    onReport?.(
      { label: label ?? null, accent, user },
      {
        preventDefault: () => {},
        kept: 'yes',
      },
    );
  }, [label, accent, user, onReport]);
  // `$accent` on purpose: the *node* route. The report above carries the
  // context route's answer; the pixels this paints carry the planted-theme
  // route's, and a theme update has to move both (issue: a framed pane
  // whose Button re-coloured while its $token background stayed). The
  // margin bares a band of the pane's *window*, whose background follows
  // the palette on its own — the third route, and the one that only works
  // when the bridge plants the palette on the window itself.
  return h('box', {
    style: { flexGrow: 1, margin: 6, backgroundColor: '$accent' },
  });
}
