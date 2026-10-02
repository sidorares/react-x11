// The pane the pane-window tests mount: a `<Select>`, whose menu is a
// `<popup grab>` anchored to its trigger or, with `nativeMenu`, the
// platform's, and on demand a `<Dialog>`, a managed window, and a
// `<popup anchor>` open from the first commit. What the user picks and
// closes goes back through bridged callbacks.
import React, { useRef, useState } from 'react';

import { Dialog } from '../../src/components/Dialog.js';
import { Select } from '../../src/components/Select.js';

const h = React.createElement;

export default function PopupPane({
  dialog,
  pinned,
  nativeMenu,
  onPick,
  onCloseDialog,
}) {
  const [value, setValue] = useState('alpha');
  const mark = useRef(null);
  return h(
    'box',
    { style: { paddingLeft: 20, paddingTop: 20, alignItems: 'flex-start' } },
    h(Select, {
      options: ['alpha', 'beta', 'gamma'],
      value,
      // the drawn trigger, whatever the bridge says about bezels, and the
      // drawn menu unless the test asks for the platform's
      native: false,
      nativeMenu,
      style: { width: 120 },
      onChange: (ev) => {
        setValue(ev.value);
        onPick?.(ev.value);
      },
    }),
    h(
      Dialog,
      {
        open: Boolean(dialog),
        title: 'Settings',
        onClose: () => onCloseDialog?.(),
      },
      h('box', { style: { height: 20 } }),
    ),
    h('box', {
      ref: mark,
      style: { marginTop: 40, width: 60, height: 10 },
    }),
    pinned &&
      h('popup', {
        anchor: { to: mark, placement: 'bottom', offset: 0 },
        width: 80,
        height: 20,
      }),
  );
}
