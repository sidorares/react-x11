// Selecting read-only text (#259), and the manual harness for the half of
// it no headless test can reach: the PRIMARY selection.
//
//   npm run examples:selection      # needs an X server / DISPLAY
//
// The window is one `<box selectable>`. Drag across the paragraphs,
// double-click for a word, triple-click for a block, Ctrl+A for everything,
// Ctrl+C to copy. The strip at the bottom shows what a copy would put on
// the clipboard, which is the part worth watching while dragging over the
// table: cells arrive tab-separated and rows newline-separated, and the row
// numbers — `selectable={false}` — never arrive at all.
//
// Things worth trying, all of which need another application:
//   - Select something, then **middle-click in a terminal**. The release
//     hands the text to PRIMARY, which is what selecting means on X11.
//   - Select in the `<textinput>` at the top, then drag across a paragraph:
//     the field's highlight goes out. Only one selection is visible in an
//     application at a time, and the field and the document take turns.
//   - Drag from the middle of a paragraph out past the bottom of the
//     window and back. The nearest text answers, so the margin selects
//     whole lines rather than nothing.
//   - Type a right-to-left string into the field and copy it into the
//     bidi line: a range that crosses direction is two bands of highlight,
//     not one from caret to caret.
import React, { useRef, useState } from 'react';

import { createRoot, createStyles } from '../src/index.js';

const s = createStyles({
  doc: { padding: 18, gap: 12, flexGrow: 1 },
  heading: { fontSize: 20, fontWeight: 'bold' },
  para: { fontSize: 14, lineHeight: 1.4 },
  row: { flexDirection: 'row', gap: 10 },
  marker: { width: 22, color: '$dim' },
  name: { width: 150 },
  field: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  readout: {
    padding: 10,
    gap: 4,
    backgroundColor: '$surfaceHover',
    borderTopWidth: 1,
    borderColor: '$track',
  },
  small: { fontSize: 11, color: '$dim' },
});

const files = [
  ['README.md', '4 kB'],
  ['index.js', '12 kB'],
  ['notes.txt', '900 B'],
];

function App() {
  const doc = useRef(null);
  const [selected, setSelected] = useState('');

  return (
    <>
      <box style={s.field}>
        <text style={s.small}>a field, for the other half of the rule:</text>
        <textinput defaultValue="select me too" style={{ width: 160 }} />
      </box>

      <box
        ref={doc}
        selectable
        onSelectionChange={(ev) => setSelected(ev.text)}
        style={s.doc}
      >
        <text style={s.heading}>Selecting text</text>
        <text style={s.para}>
          A label is not selectable here, the way a GTK label is not: a desktop
          application is full of text that is chrome rather than content, and a
          stray drag lighting up a button&apos;s caption is noise. Text becomes
          selectable when an element says so.
        </text>
        <text style={s.para}>
          Everything under that element is then one document — including
          elements written outside this package, as long as they answer for
          their own characters (docs/extending.md).
        </text>
        <text style={s.para}>
          A line that changes direction: the file مرحبا is here.
        </text>

        {files.map(([name, size], i) => (
          <box key={name} style={s.row}>
            <text selectable={false} style={s.marker}>
              {i + 1}.
            </text>
            <text style={s.name}>{name}</text>
            <text>{size}</text>
          </box>
        ))}
      </box>

      <box style={s.readout}>
        <text style={s.small}>what a copy would put on the clipboard:</text>
        <text style={{ fontSize: 12 }}>
          {selected ? JSON.stringify(selected) : '(nothing selected)'}
        </text>
      </box>
    </>
  );
}

export function Selection() {
  return (
    <window
      width={540}
      height={430}
      title="react-x11 — selection"
      style={{ backgroundColor: '$background' }}
    >
      <App />
    </window>
  );
}

export default Selection;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<Selection />);
}
