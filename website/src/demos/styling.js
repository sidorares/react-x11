export default {
  id: 'styling',
  title: 'Styles, states, themes',
  description:
    'Inline styles with :hover / :focus / :active blocks that resolve in the ' +
    'renderer — a pointer move repaints one node and never renders React. ' +
    'Plus inherited type (color and the font properties travel down the ' +
    'tree, so a :hover on a row reaches its labels), theme tokens ($name, ' +
    'resolved against the nearest theme above the node), transitions, ' +
    'which lerp on the window frame clock, and the two decorations that are ' +
    'not a colour: a linear-gradient background and a blurred box shadow.',
  code: `import React, { useState } from 'react';
import { createRoot, createStyles } from 'react-x11';

const light = {
  bg: '#f4f6f8', panel: '#ffffff', text: '#1f2933',
  muted: '#7b8794', accent: '#2980b9', accentText: '#ffffff',
  border: '#d8dee4', gutter: 14,
};

const dark = {
  bg: '#1b1f24', panel: '#252b32', text: '#e6eaee',
  muted: '#8b98a5', accent: '#58a6ff', accentText: '#0d1117',
  border: '#333b44', gutter: 14,
};

// createStyles validates keys at declaration time and gives each object a
// stable identity, so applyProps can skip an unchanged style with ===
const s = createStyles({
  root: { flexGrow: 1, padding: '$gutter', gap: 12, backgroundColor: '$bg' },
  card: {
    backgroundColor: '$panel',
    borderWidth: 1,
    borderColor: '$border',
    borderRadius: 10,
    padding: 14,
    gap: 8,
    transition: 160,
    ':hover': { borderColor: '$accent' },
  },
  title: { fontSize: 16, color: '$text' },
  body: { fontSize: 13, color: '$muted' },
  button: {
    paddingLeft: 14, paddingRight: 14, paddingTop: 7, paddingBottom: 7,
    borderRadius: 6,
    backgroundColor: '$accent',
    cursor: 'pointer',
    transition: 140,
    ':hover': { backgroundColor: '$text' },
    ':active': { backgroundColor: '$muted' },
  },
  buttonText: { color: '$accentText', fontSize: 13 },
  swatch: { width: 34, height: 34, borderRadius: 17, transition: 200 },
  // color and the font properties inherit, so this row sets the type of
  // everything written inside it — including on hover, which is why there
  // is no "group hover" to learn
  row: {
    flexDirection: 'row',
    gap: 8,
    padding: 6,
    borderRadius: 6,
    color: '$muted',
    transition: 140,
    ':hover': { color: '$accent', backgroundColor: '$panel' },
  },
  // the two decorations that are not a colour. Paint properties like any
  // other, so the shadow can be lifted from a ':hover' block — it snaps
  // rather than lerping, being several numbers and a colour in one string
  banner: {
    padding: 12,
    borderRadius: 8,
    backgroundImage: 'linear-gradient(120deg, $accent, $text)',
    boxShadow: '0 2px 8px rgba(0, 0, 0, .35)',
    ':hover': { boxShadow: '0 10px 22px rgba(0, 0, 0, .45)' },
  },
});

function App() {
  const [isDark, setDark] = useState(false);
  const theme = isDark ? dark : light;

  return (
    <window x={50} y={40} width={520} height={400} title="styling"
            theme={theme} style={s.root}>

      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <box style={s.button} onClick={() => setDark(!isDark)}>
          <text style={s.buttonText}>{isDark ? 'light' : 'dark'} theme</text>
        </box>
        <text style={s.body}>
          one theme prop restyles the subtree in place
        </text>
      </box>

      <box style={s.card}>
        <text style={s.title}>Hover me</text>
        <text style={s.body}>
          The border colour comes from a ':hover' block. No React render
          happens: the event manager already knows the hover path, so the
          renderer recomputes this node's style and repaints it.
        </text>
      </box>

      <box style={s.card}>
        <text style={s.title}>Type travels down</text>
        <box style={s.row}>
          <text style={{ fontSize: 13 }}>Open recent</text>
          <box style={{ flexGrow: 1 }} />
          <text style={{ fontSize: 13 }}>Ctrl+R</text>
        </box>
        <text style={s.body}>
          Neither label names a colour. The row does, in its own style and in
          its ':hover' block, and 'color' is inherited — so both follow it.
        </text>
      </box>

      <box style={[s.card, { flexDirection: 'row', gap: 10, alignItems: 'center' }]}>
        <box style={[s.swatch, { backgroundColor: '$accent' }]} />
        <box style={[s.swatch, { backgroundColor: '$text' }]} />
        <box style={[s.swatch, { backgroundColor: '$muted' }]} />
        <text style={s.body}>
          transition: 200 — colours lerp per channel when the theme flips
        </text>
      </box>

      <box style={s.banner}>
        <text style={{ color: '$accentText', fontSize: 13 }}>
          backgroundImage and boxShadow — hover to lift this one
        </text>
      </box>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
`,
};
