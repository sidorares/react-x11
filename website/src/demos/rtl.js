export default {
  id: 'rtl',
  title: 'Right to left',
  description:
    'One <ThemeProvider value={{ direction }}> mirrors the whole panel — ' +
    'rows run the other way, every logical edge swaps sides, the ' +
    "scrollbar moves to the left, and the widgets' own arithmetic follows: " +
    'the slider travels the other way and its arrow keys swap with it. The ' +
    'default comes from the locale, so an app started under LANG=ar_EG is ' +
    'already like this. Click the button.',
  code: `import React, { useState } from 'react';
import {
  createRoot, createStyles, ThemeProvider, Slider, Checkbox, Switch,
} from 'react-x11';

const s = createStyles({
  root: { flexGrow: 1, padding: 14, gap: 10, backgroundColor: '#f4f6f8' },
  button: {
    alignSelf: 'flex-start',
    paddingLeft: 14, paddingRight: 14, paddingTop: 7, paddingBottom: 7,
    backgroundColor: '#2980b9', borderRadius: 6, cursor: 'pointer',
    ':hover': { backgroundColor: '#1f6693' },
  },
  card: {
    backgroundColor: '#ffffff', borderRadius: 8, padding: 12, gap: 10,
    borderWidth: 1, borderColor: '#d8dee4',
  },
  // The whole point: written in logical edges, this is one stylesheet for
  // both directions. A borderStartWidth is the bar on the side the text
  // begins at — the left in ltr, the right in rtl — and it is layout, so
  // the label is inset by it either way.
  quote: {
    borderStartWidth: 3,
    borderStartColor: '#2980b9',
    paddingStart: 10,
    marginStart: 2,
  },
  // …and the indent of a tree row means "inside", not "to the right"
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 20 },
  list: { height: 78, overflow: 'scroll', backgroundColor: '#ffffff',
          borderRadius: 8, borderWidth: 1, borderColor: '#d8dee4' },
});

function App() {
  const [rtl, setRtl] = useState(false);
  const [volume, setVolume] = useState(30);

  return (
    <window x={20} y={30} width={420} height={330} title="direction" style={s.root}>
      <box style={s.button} onClick={() => setRtl(!rtl)}>
        <text style={{ color: '#ffffff', fontSize: 13 }}>
          {rtl ? 'switch to ltr' : 'switch to rtl'}
        </text>
      </box>

      <ThemeProvider value={{ direction: rtl ? 'rtl' : 'ltr' }}>
        <box style={s.card}>
          <text style={s.quote}>A bar on the side the text begins at.</text>

          <Checkbox checked onChange={() => {}}>The well leads its label</Checkbox>
          <Switch checked={rtl} onChange={() => setRtl(!rtl)} />
          <Slider value={volume} onChange={(ev) => setVolume(ev.value)} />
          <text style={{ fontSize: 12, color: '#7b8794' }}>
            volume {volume}
          </text>
        </box>

        <box style={s.list}>
          {[0, 1, 2, 1, 0, 2, 1].map((depth, i) => (
            <box key={i} style={[s.row, { paddingStart: 8 + depth * 16 }]}>
              <text style={{ fontSize: 12 }}>{'item ' + (i + 1)}</text>
            </box>
          ))}
        </box>
      </ThemeProvider>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
`,
};
