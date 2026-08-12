// A masked field whose mask is a scribble: type into it and watch the whole
// curve move, rather than one more identical bullet appear at the end of a
// row of identical bullets.
//
// The panel also shows what the mask is *for*: the same value drawn beside a
// row of bullets, so the two can be compared at a glance, and a second field
// with `drawMask` replaced to show the seam.
// Run with: npm run examples:password  (needs an X server / DISPLAY)
import React, { useState } from 'react';
import {
  Button,
  PasswordInput,
  Switch,
  createRoot,
  createStyles,
} from '../src/index.js';

const s = createStyles({
  panel: { flexGrow: 1, padding: 16, gap: 14 },
  heading: { fontSize: 20, color: '$text' },
  hint: { fontSize: 11, color: '$dim' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { color: '$dim', width: 110 },
  value: { color: '$text' },
  card: {
    borderWidth: 1,
    borderColor: '$border',
    borderRadius: 6,
    backgroundColor: '$background',
    padding: 12,
    gap: 10,
  },
  bullets: { fontSize: 14, color: '$text' },
  form: { gap: 10, width: 320 },
});

/** What the scribble replaces, for comparison — the same secret, the way
 *  every other toolkit would draw it. */
function Bullets({ value }) {
  return (
    <text style={s.bullets}>{value ? '•'.repeat([...value].length) : ' '}</text>
  );
}

/** The `drawMask` seam: a bar chart of the value's own bytes. Nothing here
 *  is a good mask — it is here to show that the mask is replaceable. */
function bars(ctx, { width, height, seed, color }) {
  const count = 14;
  const step = width / count;
  ctx.fillStyle = color;
  let n = seed >>> 0;
  const rects = [];
  for (let i = 0; i < count && i * step < width; i++) {
    n = (n * 1103515245 + 12345) >>> 0;
    const h = 2 + ((n >>> 16) % Math.max(2, height - 2));
    rects.push(i * step, height - h, Math.max(1, step - 2), h);
  }
  // bars in one colour are one request, not one each
  ctx.fillRects(rects);
}

/** The panel, without a window round it, so examples/app.jsx can show it in
 *  a tab. */
export function PasswordPanel() {
  const [secret, setSecret] = useState('');
  const [second, setSecond] = useState('');
  const [compare, setCompare] = useState(true);
  const [submitted, setSubmitted] = useState(null);

  return (
    <box style={s.panel}>
      <text style={s.heading}>Password</text>
      <text style={s.hint}>
        Type into the field. Every keystroke reseeds the curve, so the whole
        mask moves; the width grows with what you have typed, but by an uneven
        step, so it is not a ruler. Enter submits, Ctrl+U clears, Ctrl+V pastes.
        Press the eye and the mask gives way to an ordinary text input — caret,
        selection, arrows, click into the middle of a word — which hides itself
        again when the keyboard leaves. Copy is off in both states.
      </text>

      <box style={[s.card, s.form]}>
        <PasswordInput
          value={secret}
          onChange={(ev) => setSecret(ev.value)}
          onSubmit={(value) => setSubmitted(value.length)}
          placeholder="Password"
        />
        {compare && (
          <box style={s.row}>
            <text style={s.label}>as bullets</text>
            <Bullets value={secret} />
          </box>
        )}
        <box style={s.row}>
          <text style={s.label}>length</text>
          <text style={s.value}>{String([...secret].length)}</text>
        </box>
        <box style={s.row}>
          <Button primary onPress={() => setSubmitted([...secret].length)}>
            Sign in
          </Button>
          <Button onPress={() => setSecret('')}>Clear</Button>
          <text style={s.hint}>
            {submitted == null
              ? 'not submitted'
              : `submitted ${submitted} chars`}
          </text>
        </box>
      </box>

      <box style={s.row}>
        <Switch checked={compare} onChange={(ev) => setCompare(ev.value)} />
        <text style={s.value}>Show the same value as bullets</text>
      </box>

      <box style={[s.card, s.form]}>
        <text style={s.hint}>
          The mask is a seam: `drawMask` replaces it entirely. This one draws
          bars from the same seed.
        </text>
        <PasswordInput
          value={second}
          onChange={(ev) => setSecond(ev.value)}
          drawMask={bars}
          placeholder="Try this one too"
        />
      </box>

      <text style={s.hint}>
        The secret is never laid out or drawn while it is masked — the mask is
        measured from one reference character — so its glyphs never reach the X
        server. Revealing it costs what revealing it costs.
      </text>
    </box>
  );
}

function App() {
  return (
    <window
      width={520}
      height={520}
      title="password"
      style={{ backgroundColor: '$surfaceHover' }}
    >
      <PasswordPanel />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
