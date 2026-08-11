export default {
  id: 'anchored',
  title: 'A popup at a point inside a node',
  description:
    'A <popup> can hang off a rect *inside* an element — a caret, a cell, a ' +
    'datapoint — and size itself from its own content. The popup works out ' +
    'its own position, because with no width given it only learns how big ' +
    'it is between measuring the content and creating the window: too late ' +
    'for React to have passed a rect in, and exactly when the flip at a ' +
    'screen edge needs one. Click a cell.',
  code: `import React, { useRef, useState } from 'react';
import { createRoot, createStyles } from 'react-x11';

const COLS = 4;
const CELL = { width: 92, height: 46 };
const PAD = 12;

const READINGS = [
  { name: 'Oslo', note: 'a light frost, and clear' },
  { name: 'Lisbon', note: 'warm' },
  { name: 'Reykjavík', note: 'sleet, easing off by the afternoon' },
  { name: 'Cairo', note: 'hot' },
  { name: 'Bergen', note: 'rain' },
  { name: 'Tromsø', note: 'snow, and no light to speak of until ten' },
  { name: 'Nice', note: 'clear' },
  { name: 'Porto', note: 'a wind off the sea all day' },
];

const s = createStyles({
  root: { flexGrow: 1, padding: 16, gap: 12, backgroundColor: '#f4f6f8' },
  hint: { fontSize: 12, color: '#7b8794' },
  grid: {
    flexDirection: 'row', flexWrap: 'wrap',
    padding: PAD, gap: 0,
    alignSelf: 'flex-start',
    backgroundColor: '#ffffff',
    borderWidth: 1, borderColor: '#d8dee4', borderRadius: 8,
  },
  cell: {
    width: CELL.width - 2, height: CELL.height - 2,
    margin: 1,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#eef4fb', borderRadius: 4,
    cursor: 'pointer',
    ':hover': { backgroundColor: '#dbe7f5' },
  },
  cellOpen: { backgroundColor: '#2980b9' },
  cellLabel: { fontSize: 13, color: '#1f2933' },
  cellLabelOpen: { color: '#ffffff' },
  card: {
    padding: 10, gap: 4,
    backgroundColor: '#1f2933', borderRadius: 6,
  },
  cardTitle: { fontSize: 13, color: '#ffffff' },
  cardNote: { fontSize: 12, color: '#c7ccd4' },
});

function App() {
  const gridRef = useRef(null);
  const [open, setOpen] = useState(null);

  // the rect of one cell, in the grid's own coordinates — which is all \`at\`
  // ever wants, and what makes it survive the grid moving or scrolling
  const cellRect = (i) => ({
    x: PAD + (i % COLS) * CELL.width,
    y: PAD + Math.floor(i / COLS) * CELL.height,
    ...CELL,
  });

  return (
    <window x={30} y={30} width={560} height={320} title="anchored popups">
      <box style={s.root}>
        <text style={s.hint}>Click a cell: the card opens under that cell,
          not under the grid, and is as wide as the sentence in it.</text>
        <box ref={gridRef} style={s.grid}>
          {READINGS.map((r, i) => (
            <box
              key={r.name}
              style={[s.cell, open === i && s.cellOpen]}
              onClick={() => setOpen(i)}
            >
              <text style={[s.cellLabel, open === i && s.cellLabelOpen]}>
                {r.name}
              </text>
            </box>
          ))}
        </box>
      </box>

      {open !== null && (
        <popup
          anchor={{
            to: gridRef,
            at: cellRect(open),
            placement: 'bottom',
            align: 'center',
          }}
          maxWidth={260}
          grab
          onDismiss={() => setOpen(null)}
        >
          <box style={s.card}>
            <text style={s.cardTitle}>{READINGS[open].name}</text>
            <text style={s.cardNote}>{READINGS[open].note}</text>
          </box>
        </popup>
      )}
    </window>
  );
}

createRoot().then((root) => root.render(<App />));
`,
};
