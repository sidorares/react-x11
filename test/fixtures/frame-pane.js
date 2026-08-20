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
  return h('box', {
    style: { flexGrow: 1, backgroundColor: accent },
  });
}
