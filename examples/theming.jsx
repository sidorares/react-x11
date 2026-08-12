// Theming and the style engine, end to end: three demo themes in light and
// dark, switched at runtime, plus a window size query that changes the
// layout as you resize.
//
// Nothing below reaches for a colour or a corner radius. Every widget reads
// the palette it is given, the panel's own styles name it with `$tokens`,
// and switching theme replaces one object.
// Run with: npm run examples:theming  (needs an X server / DISPLAY)
import React, { useState } from 'react';
import {
  Button,
  Checkbox,
  createRoot,
  createStyles,
  ProgressBar,
  RadioGroup,
  Radio,
  Select,
  Slider,
  Switch,
  Tabs,
  ThemeProvider,
  useSystemAppearance,
} from '../src/index.js';
import { THEME_OPTIONS, themeFor } from './themes.js';

const s = createStyles({
  // no horizontal padding out here: the scroll container spans the full
  // width so its scrollbar sits by the window edge, the way an application
  // window's does. The padding goes on the header and the content instead.
  root: {
    flexGrow: 1,
    paddingTop: 16,
    gap: 14,
    backgroundColor: '$background',
    transition: { backgroundColor: 180 },
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexShrink: 0,
    paddingLeft: 16,
    paddingRight: 16,
  },
  title: { fontSize: 18, color: '$text' },
  // below 520 the window has no room for the explanation, so it goes
  spacerHide: { flexGrow: 1, '@width < 520': { display: 'none' } },
  caption: {
    fontSize: 11,
    color: '$textMuted',
    '@width < 520': { display: 'none' },
  },
  // the gallery scrolls when the window is too short for it, which is easy
  // to arrange once the columns stack
  scroller: { flexGrow: 1, minHeight: 0 },
  // one column when narrow, two side by side once there is room for them
  gallery: {
    gap: 14,
    flexDirection: 'column',
    flexShrink: 0,
    paddingLeft: 16,
    paddingRight: 16,
    paddingBottom: 16,
    '@width >= 620': { flexDirection: 'row' },
  },
  column: { flexGrow: 1, minWidth: 0, gap: 12 },
  card: {
    padding: 12,
    gap: 10,
    borderRadius: 8,
    backgroundColor: '$surface',
    transition: { backgroundColor: 180 },
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  label: { width: 74, fontSize: 12, color: '$textMuted' },
  heading: { fontSize: 12, color: '$textMuted' },
  icon: { width: 16, height: 16 },
  note: { fontSize: 11, color: '$textMuted' },
});

/** Sun and moon, drawn as declarative SVG so they take the theme's ink. */
function ModeIcon({ mode, color }) {
  const stroke = { stroke: color, strokeWidth: 2, fill: 'none' };
  return mode === 'dark' ? (
    <svg viewBox="0 0 24 24" style={s.icon}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" {...stroke} />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" style={s.icon}>
      <circle cx="12" cy="12" r="4.5" {...stroke} />
      <line x1="12" y1="1.5" x2="12" y2="4" {...stroke} />
      <line x1="12" y1="20" x2="12" y2="22.5" {...stroke} />
      <line x1="1.5" y1="12" x2="4" y2="12" {...stroke} />
      <line x1="20" y1="12" x2="22.5" y2="12" {...stroke} />
      <line x1="4.6" y1="4.6" x2="6.4" y2="6.4" {...stroke} />
      <line x1="17.6" y1="17.6" x2="19.4" y2="19.4" {...stroke} />
      <line x1="4.6" y1="19.4" x2="6.4" y2="17.6" {...stroke} />
      <line x1="17.6" y1="6.4" x2="19.4" y2="4.6" {...stroke} />
    </svg>
  );
}

export function ThemingPanel() {
  const [name, setName] = useState('github');
  // **The desktop until the user picks.** `null` means "follow"; the toggle
  // in the header sets an explicit mode and takes over from there. Starting
  // on a hardcoded 'light' is what makes this panel a light rectangle inside
  // a dark app when it is hosted by examples/app.jsx.
  const system = useSystemAppearance();
  const [picked, setPicked] = useState(null);
  const mode = picked ?? (system.colorScheme === 'dark' ? 'dark' : 'light');
  const setMode = setPicked;
  const [agreed, setAgreed] = useState(true);
  const [notify, setNotify] = useState(false);
  const [flavour, setFlavour] = useState('vanilla');
  const [volume, setVolume] = useState(55);
  const [tab, setTab] = useState('one');
  const [presses, setPresses] = useState(0);

  const theme = themeFor(name, mode);

  return (
    // One provider, both channels: the widgets read it with useTheme() and
    // `$background`/`$surface` below resolve against the same palette.
    //
    // `colorScheme={mode}` pins the subtree to whichever scheme this palette
    // *is*, which is what stops a light theme being layered over a dark base
    // and producing a window of mixed controls. `mode` follows the desktop
    // until the header toggle picks one — the shape an app with its own theme
    // preference wants.
    <ThemeProvider value={theme} colorScheme={mode} style={s.root}>
      <box style={s.bar}>
        <text style={s.title}>Theme</text>
        <Select
          value={name}
          options={THEME_OPTIONS}
          onChange={(ev) => setName(ev.value)}
          style={{ width: 150 }}
        />
        <Button
          onPress={() => setMode(mode === 'dark' ? 'light' : 'dark')}
          aria-label="toggle light and dark"
        >
          <ModeIcon mode={mode} color={theme.text} />
        </Button>
        <box style={s.spacerHide} />
        <text style={s.caption}>
          resize me: the gallery splits in two past 620px
        </text>
      </box>

      <box style={[s.scroller, { overflow: 'scroll' }]}>
        <box style={s.gallery}>
          <box style={s.column}>
            <box style={s.card}>
              <text style={s.heading}>Buttons</text>
              <box style={s.row}>
                <Button
                  primary
                  label="Primary"
                  onPress={() => setPresses(presses + 1)}
                />
                <Button
                  label="Default"
                  onPress={() => setPresses(presses + 1)}
                />
                <Button disabled label="Disabled" />
              </box>
              <text style={s.note}>{presses} presses</text>
            </box>

            <box style={s.card}>
              <text style={s.heading}>Toggles</text>
              <Checkbox
                checked={agreed}
                onChange={(ev) => setAgreed(ev.value)}
                label="Checkbox"
              />
              <box style={s.row}>
                <Switch
                  checked={notify}
                  onChange={(ev) => setNotify(ev.value)}
                />
                <text style={s.note}>Switch</text>
              </box>
              <RadioGroup
                value={flavour}
                onChange={(ev) => setFlavour(ev.value)}
              >
                <Radio value="vanilla" label="Vanilla" />
                <Radio value="pistachio" label="Pistachio" />
              </RadioGroup>
            </box>
          </box>

          <box style={s.column}>
            <box style={s.card}>
              <text style={s.heading}>Ranges</text>
              <box style={s.row}>
                <text style={s.label}>Slider</text>
                <Slider
                  value={volume}
                  min={0}
                  max={100}
                  onChange={(ev) => setVolume(ev.value)}
                  style={{ flexGrow: 1 }}
                />
                <text style={s.note}>{String(volume)}</text>
              </box>
              <box style={s.row}>
                <text style={s.label}>Progress</text>
                <ProgressBar value={volume / 100} style={{ flexGrow: 1 }} />
              </box>
            </box>

            <box style={[s.card, { flexGrow: 1, minHeight: 0 }]}>
              <text style={s.heading}>Tabs and input</text>
              <Tabs
                value={tab}
                onChange={setTab}
                items={[
                  {
                    id: 'one',
                    label: 'First',
                    content: (
                      <textinput
                        placeholder="Type here…"
                        style={{
                          borderWidth: theme.borderWidth,
                          borderColor: theme.border,
                          borderRadius: theme.radius,
                          backgroundColor: theme.background,
                          color: theme.text,
                          padding: 8,
                          marginTop: 8,
                        }}
                      />
                    ),
                  },
                  {
                    id: 'two',
                    label: 'Second',
                    content: <text style={s.note}>Second panel</text>,
                  },
                  { id: 'three', label: 'Disabled', disabled: true },
                ]}
              />
            </box>
          </box>
        </box>
      </box>
    </ThemeProvider>
  );
}

function App() {
  return (
    <window title="theming" width={720} height={480} minWidth={360}>
      <ThemingPanel />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
