// The pane the frame tests mount: reports what reached it (props, bridged
// theme, bridged context) through a bridged callback, crashes on demand,
// wedges its event loop on demand (`wedge`),
// and flushes through a callback from its close handler — and, asked with
// `probe`, what its process was started with. Boxes only — no text — so
// the forked variant needs no fonts on the machine.
import { getHeapStatistics } from 'node:v8';

import React, { useEffect } from 'react';

import { useTheme } from '../../src/components/theme.js';
import { useFrameClose } from '../../src/frame/lifecycle.js';
import { Session } from './frame-contexts.js';

const h = React.createElement;

/** What the pane's process was started with: its heap's limit, which a
 *  flag sets, and the variables `probe` names. */
function processReport(probe) {
  return {
    heapLimitMb: Math.round(getHeapStatistics().heap_size_limit / 2 ** 20),
    set: process.env[probe.set] ?? null,
    removed: process.env[probe.removed] ?? null,
    framed: process.env.REACT_X11_FRAME ?? null,
  };
}

export default function Pane({
  label,
  crash,
  wedge,
  probe,
  onReport,
  onClosed,
}) {
  if (crash) throw new Error('pane asked to crash');
  useEffect(() => {
    // after the report has gone: a loop nothing ends, but the process
    if (!wedge) return;
    const id = setTimeout(() => {
      for (;;);
    }, 50);
    return () => clearTimeout(id);
  }, [wedge]);
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
      {
        label: label ?? null,
        accent,
        user,
        ...(probe && { process: processReport(probe) }),
      },
      {
        preventDefault: () => {},
        kept: 'yes',
      },
    );
  }, [label, accent, user, probe, onReport]);
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
