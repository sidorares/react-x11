// A pane with three stops, which says through a bridged callback which of
// them has the focus — the frame test's view into the pane's Tab order.
import React from 'react';

const h = React.createElement;

export default function PaneStops({ onFocusStop }) {
  const stop = (name) =>
    h('box', {
      key: name,
      focusable: true,
      style: { height: 10, flexShrink: 0 },
      onFocus: () => onFocusStop?.(name),
      onBlur: () => onFocusStop?.(`-${name}`),
    });
  return h('box', { style: { flexGrow: 1 } }, stop('a'), stop('b'), stop('c'));
}
