// Following the desktop: light or dark, the accent colour, contrast and
// reduced motion, live.
//
// **Change your desktop theme while this is running.** GNOME: Settings →
// Appearance → Dark. KDE: Settings → Colours. The window follows without a
// restart — a `SettingChanged` signal becomes a `setState`, which is the
// whole feature.
//
// Two ways to use it, and the top half of the window is the one most apps
// want:
//
//   <ThemeProvider value={light} dark={dark}>   — nothing to read
//   const { accent } = useSystemAppearance();   — the values themselves
//
// The rung that answered is shown because it decides what can be known: only
// the portal has an accent colour, and only the portal answers reduced motion
// on GNOME. On a machine with none of the three — a bare startx, ssh, a
// container — everything below reads "no-preference", which means *use your
// own default* rather than *use light*.
//
// Run with: npm run examples:appearance  (needs an X server / DISPLAY)
import React, { useState } from 'react';
import {
  Button,
  Checkbox,
  createRoot,
  createStyles,
  ProgressBar,
  Slider,
  ThemeProvider,
  systemAppearance,
  useSystemAppearance,
  useTheme,
} from '../src/index.js';

// One design, in two schemes. `dark` layers over `light`, so it names only
// what changes — the shape tokens below are written once and apply to both.
const light = {
  background: '#ffffff',
  text: '#1b1f23',
  dim: '#6a737d',
  border: '#d1d5da',
  surfaceHover: '#f6f8fa',
  track: '#e1e4e8',
  radius: 6,
  fontSize: 14,
};

const dark = {
  background: '#1e2228',
  text: '#e6edf3',
  dim: '#8b949e',
  border: '#30363d',
  surfaceHover: '#262c33',
  track: '#30363d',
};

const s = createStyles({
  root: {
    flexGrow: 1,
    padding: 20,
    gap: 16,
    backgroundColor: '$background',
    // `transition` is what `reducedMotion` is for: the checkbox below turns
    // this off, which is all "respect reduced motion" amounts to.
    transition: { backgroundColor: 200 },
  },
  heading: { fontSize: 20, color: '$text' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  card: {
    padding: 14,
    gap: 10,
    borderRadius: '$radius',
    borderWidth: 1,
    borderColor: '$border',
    backgroundColor: '$surfaceHover',
    transition: { backgroundColor: 200, borderColor: 200 },
  },
  label: { color: '$dim' },
  value: { color: '$text' },
});

/** One `name: value` line, so the four values read as a table. */
function Row({ name, value }) {
  return (
    <box style={s.row}>
      <text style={[s.label, { width: 130 }]}>{name}</text>
      <text style={s.value}>{value}</text>
    </box>
  );
}

function Panel() {
  const { colorScheme, accent, contrast, reducedMotion, source } =
    useSystemAppearance();
  const theme = useTheme();
  const [level, setLevel] = useState(65);
  // The desktop's accent is taken deliberately rather than adopted: an app
  // that asked for dark mode did not ask for its buttons to change colour.
  // And it is null on most desktops, so there is always a fallback.
  const brand = accent ?? '#2980b9';

  return (
    <box style={s.root}>
      <text style={s.heading}>This window follows your desktop</text>

      <box style={s.card}>
        <Row name="colorScheme" value={colorScheme} />
        <Row name="accent" value={accent ?? 'null (not implemented here)'} />
        <Row name="contrast" value={contrast} />
        <Row name="reducedMotion" value={String(reducedMotion)} />
        <Row name="source" value={source ?? 'nothing answered'} />
      </box>

      <box style={s.card}>
        <text style={s.label}>
          Widgets read the palette; the palette follows the scheme.
        </text>
        <box style={s.row}>
          <Button primary label="Primary" />
          <Button label="Secondary" />
          <Button
            label="Desktop accent"
            style={{ backgroundColor: brand, borderColor: brand }}
          />
        </box>
        {/* Read-outs, so they are disabled: these mirror the desktop and
            there is nothing here that could change it back. */}
        <box style={s.row}>
          <Checkbox disabled checked={colorScheme === 'dark'} label="dark" />
          <Checkbox
            disabled
            checked={contrast === 'high'}
            label="high contrast"
          />
          <Checkbox disabled checked={reducedMotion} label="reduced motion" />
        </box>
        <box style={s.row}>
          <Slider
            value={level}
            onChange={(e) => setLevel(e.value)}
            style={{ width: 200 }}
          />
          <ProgressBar value={level / 100} style={{ width: 140 }} />
        </box>
      </box>

      <text style={s.label}>
        Change your desktop theme now — Settings → Appearance — and this
        follows. Nothing here polls; the desktop announces it.
      </text>
      <text style={[s.label, { fontSize: 12 }]}>
        radius {theme.radius}px came from the light palette and survived the
        switch: `dark` only names what changes.
      </text>
    </box>
  );
}

function App() {
  return (
    <window width={520} height={520} title="system appearance">
      {/* `dark` is the opt-in. Without it nothing is probed and no D-Bus
          connection is opened — which is why every existing themed app is
          unaffected by this feature existing. */}
      <ThemeProvider value={light} dark={dark}>
        <Panel />
      </ThemeProvider>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  // Resolved alongside the connection, so the very first frame is already in
  // the right colours — on the first ever run, where there is nothing
  // remembered from a previous one to start from. Every run after that is
  // served from the cache before this resolves, and the await costs nothing.
  const [root] = await Promise.all([createRoot(), systemAppearance()]);
  root.render(<App />);
}
