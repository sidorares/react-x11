export default {
  id: 'container-queries',
  title: 'Container queries',
  description:
    "'@container width >= 360' asks about the box a node is inside, not the " +
    'window: the same card is stacked in the narrow pane and a row in the ' +
    "wide one. '@container pane width >= 300' asks for a container by " +
    "name, reaching past the card's own. Click the button to swap which " +
    'pane is wide.',
  code: `import React, { useState } from 'react';
import { createRoot, createStyles } from 'react-x11';

const s = createStyles({
  root: { flexGrow: 1, padding: 14, gap: 12, backgroundColor: '#f4f6f8' },
  row: { flexDirection: 'row', gap: 12, flexGrow: 1 },

  // Each pane is a container, and named: a block can ask for "pane" from
  // inside a card, past the card's own container. A container's size must
  // not depend on what is inside it — a flex item with minWidth: 0 and a
  // basis is one that does not.
  pane: { container: 'pane', flexBasis: 0, minWidth: 0, gap: 10 },
  wide: { flexGrow: 3 },
  narrow: { flexGrow: 1 },
  paneTitle: { fontSize: 12, color: '#7b8794' },

  // the card asks its nearest container — the pane — and is one itself
  card: {
    container: true,
    backgroundColor: '#ffffff',
    borderWidth: 1, borderColor: '#d8dee4', borderRadius: 8,
    padding: 10, gap: 8,
    flexDirection: 'column',
    '@container width >= 360': { flexDirection: 'row', alignItems: 'center', gap: 12 },
  },
  swatch: { width: 36, height: 36, borderRadius: 6, flexShrink: 0 },
  body: { flexGrow: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 14 },
  // the card's own width: too narrow and the detail goes
  detail: { fontSize: 12, color: '#7b8794', '@container width < 200': { display: 'none' } },
  tools: { flexDirection: 'row', gap: 6 },
  tool: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingLeft: 7, paddingRight: 7, paddingTop: 3, paddingBottom: 3,
    borderRadius: 5, backgroundColor: '#eef1f4',
  },
  glyph: { fontSize: 12 },
  // by name, past the card: labels follow the pane's width, not the card's
  label: { fontSize: 12, display: 'none', '@container pane width >= 300': { display: 'flex' } },

  button: {
    alignSelf: 'flex-start',
    paddingLeft: 14, paddingRight: 14, paddingTop: 7, paddingBottom: 7,
    backgroundColor: '#2980b9', borderRadius: 6, cursor: 'pointer',
    ':hover': { backgroundColor: '#1f6693' },
  },
});

const ITEMS = [
  ['Requests', '1,284 in the last hour', '#8e44ad'],
  ['Bytes', '96 KB sent', '#27ae60'],
  ['Composites', '312 this frame', '#e67e22'],
];

function Card({ title, detail, color }) {
  return (
    <box style={s.card}>
      <box style={[s.swatch, { backgroundColor: color }]} />
      <box style={s.body}>
        <text style={s.title}>{title}</text>
        <text style={s.detail}>{detail}</text>
      </box>
      <box style={s.tools}>
        {[['+', 'Add'], ['…', 'More']].map(([glyph, name]) => (
          <box key={name} style={s.tool}>
            <text style={s.glyph}>{glyph}</text>
            <text style={s.label}>{name}</text>
          </box>
        ))}
      </box>
    </box>
  );
}

function Pane({ name, wide }) {
  return (
    <box style={[s.pane, wide ? s.wide : s.narrow]}>
      <text style={s.paneTitle}>{name} — {wide ? 'wide' : 'narrow'}</text>
      {ITEMS.map(([title, detail, color]) => (
        <Card key={title} title={title} detail={detail} color={color} />
      ))}
    </box>
  );
}

function App() {
  const [leftWide, setLeftWide] = useState(false);
  return (
    <window x={20} y={30} width={640} height={420} title="container queries" style={s.root}>
      <box style={s.button} onClick={() => setLeftWide(!leftWide)}>
        <text style={{ color: '#ffffff', fontSize: 13 }}>swap which pane is wide</text>
      </box>
      <box style={s.row}>
        <Pane name="left" wide={leftWide} />
        <Pane name="right" wide={!leftWide} />
      </box>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
`,
};
