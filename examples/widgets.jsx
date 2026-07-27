// Widget gallery: every standard component in one window — Button,
// Checkbox, Radio/RadioGroup, Switch, Slider, ProgressBar, Select,
// <textinput>.
// Run with: npm run examples:widgets  (needs an X server / DISPLAY)
import React, { useEffect, useState } from 'react';
import {
  createRoot,
  Button,
  Checkbox,
  ProgressBar,
  Radio,
  RadioGroup,
  Select,
  Slider,
  Switch,
} from '../src/index.js';

function Row({ label, children }) {
  return (
    <box flexDirection="row" alignItems="center" gap={12}>
      <text color="#7f8c8d" width={90}>
        {label}
      </text>
      {children}
    </box>
  );
}

function App() {
  const [agreed, setAgreed] = useState(true);
  const [notify, setNotify] = useState(false);
  const [flavor, setFlavor] = useState('vanilla');
  const [speed, setSpeed] = useState('fast');
  const [presses, setPresses] = useState(0);
  const [volume, setVolume] = useState(40);
  const [progress, setProgress] = useState(0.2);

  // demo animation: creep the progress bar while "notifications" are on
  useEffect(() => {
    if (!notify) return undefined;
    const t = setInterval(
      () => setProgress((p) => (p >= 1 ? 0 : p + 0.02)),
      100,
    );
    return () => clearInterval(t);
  }, [notify]);

  return (
    <window width={460} height={580} title="widgets" backgroundColor="#f5f6fa">
      <box flexGrow={1} padding={16} gap={14}>
        <text fontSize={20} color="#2d3436">
          Widget gallery
        </text>

        <Row label="Button">
          <Button primary onPress={() => setPresses((n) => n + 1)}>
            Press me
          </Button>
          <Button onPress={() => setPresses(0)}>Reset</Button>
          <Button disabled>Disabled</Button>
          <text color="#2d3436">{`${presses}×`}</text>
        </Row>

        <Row label="Checkbox">
          <box gap={6}>
            <Checkbox checked={agreed} onChange={setAgreed}>
              I agree to nothing in particular
            </Checkbox>
            <Checkbox checked={false} disabled>
              Disabled
            </Checkbox>
          </box>
        </Row>

        <Row label="Radio">
          <RadioGroup value={flavor} onChange={setFlavor}>
            <Radio value="vanilla">Vanilla</Radio>
            <Radio value="chocolate">Chocolate</Radio>
            <Radio value="pistachio">Pistachio</Radio>
          </RadioGroup>
        </Row>

        <Row label="Switch">
          <Switch checked={notify} onChange={setNotify} />
          <text color="#2d3436">{notify ? 'notifications on' : 'off'}</text>
        </Row>

        <Row label="Slider">
          <Slider
            value={volume}
            min={0}
            max={100}
            step={5}
            width={200}
            onChange={setVolume}
          />
          <text color="#2d3436">{`${volume}`}</text>
        </Row>

        <Row label="Progress">
          <box flexGrow={1}>
            <ProgressBar value={progress} />
          </box>
          <text color="#7f8c8d">{`${Math.round(progress * 100)}%`}</text>
        </Row>

        <Row label="Select">
          <Select
            width={160}
            options={['fast', 'faster', 'ludicrous']}
            value={speed}
            onChange={setSpeed}
          />
        </Row>

        <Row label="Input">
          <textinput
            flexGrow={1}
            placeholder="Type here…"
            padding={8}
            borderRadius={4}
            borderWidth={1}
            borderColor="#b2bec3"
            backgroundColor="white"
          />
        </Row>

        <Row label="Textarea">
          <textarea
            flexGrow={1}
            rows={3}
            defaultValue={
              'Multi-line editing:\nEnter for a newline, arrows move by visual line, selection spans lines.'
            }
            padding={8}
            borderRadius={4}
            borderWidth={1}
            borderColor="#b2bec3"
            backgroundColor="white"
          />
        </Row>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
