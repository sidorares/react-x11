export default {
  id: 'widgets',
  title: 'The widget set',
  description:
    'Button, Checkbox, Switch, Slider, ProgressBar — determinate and the ' +
    'indeterminate one, whose block slides on a style loop rather than a ' +
    'timer — Select and Tabs. These ' +
    'are plain React over the host elements — no reconciler support — and a ' +
    'ThemeProvider carries shape as well as colour: radius, border weight, ' +
    'control padding and text size.',
  code: `import React, { useState } from 'react';
import {
  createRoot, ThemeProvider,
  Button, Checkbox, Switch, Slider, ProgressBar, Select, Tabs,
} from 'react-x11';

const macos = {
  background: '#ececec', surface: '#ffffff', text: '#1d1d1f',
  textMuted: '#8e8e93', border: '#d2d2d7',
  accent: '#0a84ff', accentHover: '#0060df', accentText: '#ffffff',
  surfaceHover: '#f2f2f7', hoverBackground: '#0a84ff', hoverText: '#ffffff',
  track: '#e5e5ea', borderFocus: '#0a84ff',
  radius: 6, radiusSmall: 4, borderWidth: 1,
  fontSize: 13, paddingX: 12, paddingY: 10,
};

function Controls() {
  const [checked, setChecked] = useState(true);
  const [on, setOn] = useState(false);
  const [volume, setVolume] = useState(45);
  const [fruit, setFruit] = useState('pear');

  return (
    <box style={{ padding: 16, gap: 14 }}>
      <box style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Button primary onPress={() => setVolume(0)}>Mute</Button>
        <Button onPress={() => setVolume(100)}>Max</Button>
        <Button disabled>Disabled</Button>
      </box>

      <box style={{ flexDirection: 'row', gap: 20, alignItems: 'center' }}>
        <Checkbox checked={checked} onChange={(ev) => setChecked(ev.value)}>
          Remember me
        </Checkbox>
        <Switch checked={on} onChange={(ev) => setOn(ev.value)} />
        <text style={{ fontSize: 13 }}>{on ? 'on' : 'off'}</text>
      </box>

      <box style={{ gap: 6 }}>
        <text style={{ fontSize: 13 }}>Volume: {volume}</text>
        <Slider value={volume} min={0} max={100} step={5}
                onChange={(ev) => setVolume(ev.value)} style={{ width: 260 }} />
        <ProgressBar value={volume / 100} style={{ width: 260 }} />
        <ProgressBar indeterminate style={{ width: 260 }} />
      </box>

      <box style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <text style={{ fontSize: 13 }}>Fruit</text>
        <Select
          value={fruit}
          onChange={(ev) => setFruit(ev.value)}
          style={{ width: 150 }}
          options={['apple', 'pear', 'cherry', 'quince']}
        />
        <text style={{ fontSize: 13, color: '#8e8e93' }}>
          the menu is a real popup window
        </text>
      </box>
    </box>
  );
}

function About() {
  return (
    <box style={{ padding: 16, gap: 8 }}>
      <text style={{ fontSize: 15 }}>Tabs</text>
      <text style={{ fontSize: 13, color: '#8e8e93' }}>
        The strip is a single tab stop: arrows move and wrap, Home and End
        jump to the ends, disabled tabs are skipped. A tab's content may be
        a function, so a panel nobody is looking at is never built.
      </text>
    </box>
  );
}

function App() {
  return (
    <window x={30} y={30} width={580} height={400} title="widgets"
            style={{ backgroundColor: '#ffffff' }}>
      <ThemeProvider value={macos}>
        <Tabs
          style={{ flexGrow: 1 }}
          items={[
            { id: 'controls', label: 'Controls', content: <Controls /> },
            { id: 'about', label: 'Tabs', content: () => <About /> },
            { id: 'off', label: 'Disabled', disabled: true },
          ]}
        />
      </ThemeProvider>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
`,
};
