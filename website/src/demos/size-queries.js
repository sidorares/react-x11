export default {
  id: 'size-queries',
  title: 'Window size queries',
  description:
    "'@width >= 520' is the X11 answer to @media: what a style can usefully " +
    'ask about here is the window it is laid out in, not the screen. Click ' +
    'the button to resize the X window and watch the layout switch — the ' +
    'query is re-evaluated inside the layout pass the resize already needed.',
  code: `import React, { useState } from 'react';
import { createRoot, createStyles } from 'react-x11';

const s = createStyles({
  root: { flexGrow: 1, padding: 14, gap: 12, backgroundColor: '#f4f6f8' },

  // narrow first, then the wide layout overrides it. Size queries MAY set
  // layout properties (unlike :hover blocks) — they are only re-resolved
  // when the window size actually changed.
  shelf: {
    flexDirection: 'column',
    gap: 8,
    '@width >= 520': { flexDirection: 'row', gap: 16 },
  },
  card: {
    backgroundColor: '#ffffff',
    borderWidth: 1, borderColor: '#d8dee4', borderRadius: 8,
    padding: 12,
    flexGrow: 1, flexBasis: 0,
    gap: 4,
  },
  label: {
    fontSize: 13, color: '#7b8794',
    '@width >= 520': { color: '#2980b9' },
  },
  button: {
    alignSelf: 'flex-start',
    paddingLeft: 14, paddingRight: 14, paddingTop: 7, paddingBottom: 7,
    backgroundColor: '#2980b9', borderRadius: 6, cursor: 'pointer',
    ':hover': { backgroundColor: '#1f6693' },
  },
});

function App() {
  const [wide, setWide] = useState(false);
  const width = wide ? 600 : 380;

  return (
    <window
      x={20} y={30}
      width={width} height={300}
      title={'window is ' + width + 'px'}
      style={s.root}
    >
      <box style={s.button} onClick={() => setWide(!wide)}>
        <text style={{ color: '#ffffff', fontSize: 13 }}>
          resize to {wide ? 380 : 600}px
        </text>
      </box>

      <text style={s.label}>
        {wide ? "@width >= 520 matches — row layout" : 'narrow — column layout'}
      </text>

      <box style={s.shelf}>
        <box style={s.card}>
          <text style={{ fontSize: 14 }}>Requests</text>
          <text style={{ fontSize: 20, color: '#2980b9' }}>1,284</text>
        </box>
        <box style={s.card}>
          <text style={{ fontSize: 14 }}>Bytes</text>
          <text style={{ fontSize: 20, color: '#27ae60' }}>96 KB</text>
        </box>
        <box style={s.card}>
          <text style={{ fontSize: 14 }}>Composites</text>
          <text style={{ fontSize: 20, color: '#e67e22' }}>312</text>
        </box>
      </box>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
`,
};
