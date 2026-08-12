export default {
  id: 'selection',
  title: 'Text you can take',
  description:
    'One prop — selectable — turns a box into a document: drag across the ' +
    'paragraphs, double-click for a word, triple-click for a block, Ctrl+A ' +
    'for everything, Ctrl+C to copy. The release hands the text to PRIMARY, ' +
    'so a middle click in a terminal pastes it. The table below is the same ' +
    'selection: what a copy assembles comes from the layout, so cells are ' +
    'joined with tabs and rows with newlines, and the row numbers — marked ' +
    'selectable={false} — are not in it at all.',
  code: `import React, { useRef, useState } from 'react';
import { createRoot } from 'react-x11';

const rows = [
  ['README.md', '4 kB'],
  ['index.js', '12 kB'],
  ['notes.txt', '900 B'],
];

function App() {
  const doc = useRef(null);
  const [copied, setCopied] = useState('');

  return (
    <window x={30} y={30} width={520} height={380} title="release notes"
            style={{ backgroundColor: '#ffffff' }}>
      <box
        ref={doc}
        selectable
        onSelectionChange={(ev) => setCopied(ev.text)}
        style={{ padding: 18, gap: 12, flexGrow: 1 }}
      >
        <text style={{ fontSize: 20, fontWeight: 'bold' }}>
          Selecting text
        </text>
        <text style={{ fontSize: 14, lineHeight: 1.4 }}>
          A label is not selectable here, the way a GTK label is not: a
          desktop application is full of text that is chrome rather than
          content. Text becomes selectable when an element says so, and then
          everything under that element is one document.
        </text>
        <text style={{ fontSize: 14, lineHeight: 1.4 }}>
          Drag from this paragraph into the one above it. Both light up, and
          the copy has a newline between them.
        </text>

        {rows.map(([name, size], i) => (
          <box key={name} style={{ flexDirection: 'row', gap: 10 }}>
            <text selectable={false} style={{ width: 20, color: '#95a5a6' }}>
              {i + 1}.
            </text>
            <text style={{ width: 140 }}>{name}</text>
            <text>{size}</text>
          </box>
        ))}
      </box>

      <box style={{ padding: 12, gap: 4, backgroundColor: '#f4f6f8' }}>
        <text style={{ fontSize: 11, color: '#7f8c8d' }}>
          what a copy would put on the clipboard:
        </text>
        <text style={{ fontSize: 12 }}>
          {copied ? JSON.stringify(copied) : '(nothing selected)'}
        </text>
      </box>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
`,
};
