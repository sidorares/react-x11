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
import { createRoot } from '../src/index.js';

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

function Button({ label, onPress, primary = false }) {
  const theme = useContext(ThemeContext);
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <box
      focusable
      cursor="pointer"
      paddingTop={8}
      paddingBottom={8}
      paddingLeft={16}
      paddingRight={16}
      borderRadius={6}
      borderWidth={2}
      borderColor={focused || hover ? theme.accent : theme.dim}
      backgroundColor={primary ? theme.accent : theme.panel}
      alignItems="center"
      justifyContent="center"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={onPress}
      onKeyDown={(ev) => {
        if (ev.codepoint === 32 || ev.keysym === 0xff0d) onPress(ev);
      }}
    >
      <text color={primary ? theme.accentText : theme.text}>{label}</text>
    </box>
  );
}

function StatCard({ label, value }) {
  const theme = useContext(ThemeContext);
  return (
    <box
      flexGrow={1}
      backgroundColor={theme.panel}
      borderRadius={8}
      padding={14}
      gap={6}
    >
      <text fontSize={12} color={theme.dim}>
        {label}
      </text>
      <text fontSize={26} color={theme.text}>
        {value}
      </text>
    </box>
  );
}

function App() {
  const [themeName, setThemeName] = useState('light');
  const [count, setCount] = useState(0);
  const theme = THEMES[themeName];
  const now = useClock();
  const squared = useMemo(() => count * count, [count]);

  return (
    <ThemeContext.Provider value={theme}>
      <window
        width={520}
        height={340}
        title="react-x11 dashboard"
        backgroundColor={theme.bg}
      >
        <box flexGrow={1} padding={16} gap={16}>
          <box flexDirection="row" alignItems="center" gap={12}>
            <text fontSize={20} color={theme.text}>
              Dashboard
            </text>
            <box flexGrow={1} />
            <text color={theme.dim}>{now.toLocaleTimeString()}</text>
            <Button
              label={themeName === 'light' ? 'Dark' : 'Light'}
              onPress={() =>
                setThemeName((t) => (t === 'light' ? 'dark' : 'light'))
              }
            />
          </box>

          <box flexDirection="row" gap={12}>
            <StatCard label="counter" value={String(count)} />
            <StatCard label="count squared" value={String(squared)} />
            <StatCard
              label="process uptime"
              value={`${Math.floor(process.uptime())}s`}
            />
          </box>

          <box flexGrow={1} />

          <box flexDirection="row" gap={12} justifyContent="center">
            <Button primary label="+1" onPress={() => setCount((c) => c + 1)} />
            <Button label="-1" onPress={() => setCount((c) => c - 1)} />
            <Button label="reset" onPress={() => setCount(0)} />
          </box>
        </box>
      </window>
    </ThemeContext.Provider>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
