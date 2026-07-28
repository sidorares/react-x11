// A small dashboard showing the React ecosystem on X11: context (theming),
// useState/useEffect/useMemo, a custom hook, reusable child components with
// hover + focus states, and flex layout that reflows when you resize the
// window. Run with: npm run examples:dashboard  (needs an X server / DISPLAY)
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Button,
  createRoot,
  createStyles,
  ProgressBar,
  ThemeProvider,
} from '../src/index.js';

// Styles are declared once, outside render: hoisting is what lets the
// renderer skip an update with an identity check, and what keeps the JSX
// below shorter than the flat-prop version it replaced.
// `$name` reads the nearest `theme` prop, so these can be declared once,
// outside render, and still follow the Light/Dark toggle — the whole reason
// the palette does not have to be threaded through every component.
const s = createStyles({
  root: { flexGrow: 1, padding: 16, gap: 16 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { fontSize: 20, color: '$text' },
  spacer: { flexGrow: 1 },
  row: { flexDirection: 'row', gap: 12 },
  footer: { flexDirection: 'row', gap: 12, justifyContent: 'center' },
  card: {
    flexGrow: 1,
    borderRadius: 8,
    padding: 14,
    gap: 6,
    backgroundColor: '$panel',
    transition: { backgroundColor: 200 },
  },
  cardLabel: { fontSize: 12, color: '$dim' },
  cardValue: { fontSize: 26, color: '$text' },
  clock: { color: '$dim' },
  window: { backgroundColor: '$bg', transition: { backgroundColor: 200 } },
});

const THEMES = {
  light: {
    bg: '#f5f6fa',
    panel: '#ffffff',
    text: '#2f3640',
    dim: '#7f8c8d',
    accent: '#2980b9',
    accentText: '#ffffff',
  },
  dark: {
    bg: '#1e272e',
    panel: '#2f3640',
    text: '#f5f6fa',
    dim: '#95a5a6',
    accent: '#f39c12',
    accentText: '#1e272e',
  },
};

const ThemeContext = createContext(THEMES.light);

/** Custom hook: a ticking clock. */
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Map a dashboard palette onto the shared widget theme (see components.js)
 * so the library Button follows the Light/Dark toggle. */
function widgetTheme(t) {
  return {
    background: t.panel,
    text: t.text,
    dim: t.dim,
    border: t.dim,
    borderActive: t.accent,
    accent: t.accent,
    accentHover: t.accent,
    accentText: t.accentText,
    surfaceHover: t.bg,
    hoverBackground: t.accent,
    hoverText: t.accentText,
    track: t.dim,
  };
}

function StatCard({ label, value, progress }) {
  const theme = useContext(ThemeContext);
  return (
    <box style={s.card}>
      <text style={s.cardLabel}>{label}</text>
      <text style={s.cardValue}>{value}</text>
      {progress != null && (
        <ProgressBar value={progress} color={theme.accent} />
      )}
    </box>
  );
}

function App() {
  const [themeName, setThemeName] = useState('light');
  const [count, setCount] = useState(0);
  const theme = THEMES[themeName];
  const now = useClock();
  const squared = useMemo(() => count * count, [count]);
  // re-read every tick, since useClock already re-renders us each second
  const heap = process.memoryUsage();

  return (
    <ThemeContext.Provider value={theme}>
      <ThemeProvider value={widgetTheme(theme)}>
        <window
          title="react-x11 dashboard"
          width={520}
          height={340}
          minWidth={360}
          minHeight={240}
          theme={theme}
          style={s.window}
        >
          <box style={s.root}>
            <box style={s.header}>
              <text style={s.title}>Dashboard</text>
              <box style={s.spacer} />
              <text style={s.clock}>{now.toLocaleTimeString()}</text>
              <Button
                label={themeName === 'light' ? 'Dark' : 'Light'}
                onPress={() =>
                  setThemeName((t) => (t === 'light' ? 'dark' : 'light'))
                }
              />
            </box>

            <box style={s.row}>
              <StatCard
                label="counter"
                value={String(count)}
                progress={(count % 10) / 10}
              />
              <StatCard label="count squared" value={String(squared)} />
              <StatCard
                label="heap used"
                value={`${Math.round(heap.heapUsed / 1024 / 1024)} MB`}
                progress={heap.heapUsed / heap.heapTotal}
              />
            </box>

            <box style={s.spacer} />

            <box style={s.footer}>
              <Button
                primary
                label="+1"
                onPress={() => setCount((c) => c + 1)}
              />
              <Button label="-1" onPress={() => setCount((c) => c - 1)} />
              <Button label="reset" onPress={() => setCount(0)} />
            </box>
          </box>
        </window>
      </ThemeProvider>
    </ThemeContext.Provider>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
