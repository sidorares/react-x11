// Widget gallery: every standard component in one window — Button,
// Checkbox, Radio/RadioGroup, Switch, Slider, ProgressBar, Select,
// Tooltip, <textinput> — plus a live <markdown> preview of what you type
// into the <textarea>.
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
  Tooltip,
} from '../src/index.js';

function Row({ label, children, alignItems = 'center' }) {
  return (
    <box flexDirection="row" alignItems={alignItems} gap={12}>
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
  const [note, setNote] = useState(
    '## Live preview\n\nType **markdown** — `code`, [links](https://x.org)\nand lists all render below.\n',
  );

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
    <window width={460} height={720} title="widgets" backgroundColor="#f5f6fa">
      <box flexGrow={1} padding={16} gap={14}>
        <text fontSize={20} color="#2d3436">
          Widget gallery
        </text>

        <Row label="Button">
          <Button primary onPress={() => setPresses((n) => n + 1)}>
            Press me
          </Button>
          <Tooltip label="Back to zero">
            <Button onPress={() => setPresses(0)}>Reset</Button>
          </Tooltip>
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

        <Row label="Markdown" alignItems="flex-start">
          <box flexGrow={1} gap={8}>
            {/* the textarea is the source, the <markdown> element is the
                preview: every keystroke re-parses through ntk's
                MarkdownView, which is cheap enough for a document this size */}
            <textarea
              flexGrow={0}
              rows={4}
              value={note}
              onChange={setNote}
              padding={8}
              borderRadius={4}
              borderWidth={1}
              borderColor="#b2bec3"
              backgroundColor="white"
            />
            <scrollview
              height={110}
              padding={4}
              borderRadius={4}
              borderWidth={1}
              borderColor="#dfe6e9"
              backgroundColor="white"
            >
              <markdown padding={6}>{note}</markdown>
            </scrollview>
          </box>
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
