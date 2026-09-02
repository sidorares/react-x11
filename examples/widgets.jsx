// Widget gallery: every standard component in one window — Button,
// Checkbox, Radio/RadioGroup, Switch, Slider, ProgressBar, Select,
// Tooltip, <textinput> and <textarea>.
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
    <box style={{ flexDirection: 'row', alignItems: alignItems, gap: 12 }}>
      <text style={{ color: '$textMuted', width: 90 }}>{label}</text>
      {children}
    </box>
  );
}

/** The gallery itself, without a window round it — so examples/app.jsx can
 * show it in a tab. */
export function WidgetsPanel() {
  const [agreed, setAgreed] = useState(true);
  const [notify, setNotify] = useState(false);
  const [flavor, setFlavor] = useState('vanilla');
  const [speed, setSpeed] = useState('fast');
  const [presses, setPresses] = useState(0);
  const [volume, setVolume] = useState(40);
  const [progress, setProgress] = useState(0.2);
  const [note, setNote] = useState(
    'A multi-line field: Enter inserts a newline, and the caret moves by\nvisual line rather than by index.\n',
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
    <box style={{ flexGrow: 1, padding: 16, gap: 14 }}>
      <text style={{ fontSize: 20, color: '$text' }}>Widget gallery</text>

      <Row label="Button">
        <Button primary onPress={() => setPresses((n) => n + 1)}>
          Press me
        </Button>
        <Tooltip label="Back to zero">
          <Button onPress={() => setPresses(0)}>Reset</Button>
        </Tooltip>
        <Button disabled>Disabled</Button>
        <text style={{ color: '$text' }}>{`${presses}×`}</text>
      </Row>

      {/* The status family (issue #258). A destructive button is a `Button`
          with the `danger` ramp instead of the accent one — the widget takes
          the style last, so naming the three states is the whole of it.
          The label is written out as a `<text>` because `Button` colours a
          string child itself, and the ink on a status fill is the palette's
          `$dangerText` — derived from the fill, so it stays legible if the
          theme moves the red. */}
      <Row label="Status">
        {/* A control that names its own colours opts out of the platform
            bezel: a native button ignores style fills, so `native={false}`
            keeps the danger ramp everywhere (docs/macos.md §Native
            controls — the per-instance escape hatch). */}
        <Button
          native={false}
          style={{
            backgroundColor: '$danger',
            borderColor: '$danger',
            ':hover': {
              backgroundColor: '$dangerHover',
              borderColor: '$dangerHover',
            },
            ':active': {
              backgroundColor: '$dangerActive',
              borderColor: '$dangerActive',
            },
          }}
          onPress={() => setPresses(0)}
        >
          <text style={{ color: '$dangerText', textBoxTrim: 'cap-alphabetic' }}>
            Delete
          </text>
        </Button>
        {/* and the same four colours as *ink*, which is what a validation
            message or a badge is: each clears 4.5:1 on the palette's ground,
            so nothing here needs a fill to be legible */}
        <text style={{ color: '$success' }}>Saved</text>
        <text style={{ color: '$warning' }}>Check the date</text>
        <text style={{ color: '$info' }}>Draft</text>
        <text style={{ color: '$danger' }}>Could not save</text>
      </Row>

      <Row label="Checkbox">
        <box style={{ gap: 6 }}>
          <Checkbox checked={agreed} onChange={(ev) => setAgreed(ev.value)}>
            I agree to nothing in particular
          </Checkbox>
          <Checkbox checked={false} disabled>
            Disabled
          </Checkbox>
        </box>
      </Row>

      <Row label="Radio">
        <RadioGroup value={flavor} onChange={(ev) => setFlavor(ev.value)}>
          <Radio value="vanilla">Vanilla</Radio>
          <Radio value="chocolate">Chocolate</Radio>
          <Radio value="pistachio">Pistachio</Radio>
        </RadioGroup>
      </Row>

      <Row label="Switch">
        {/* the label beside it is a sibling, not a name a screen reader
            can find — a control with no text of its own needs one */}
        <Switch
          aria-label="Notifications"
          checked={notify}
          onChange={(ev) => setNotify(ev.value)}
        />
        <text style={{ color: '$text' }}>
          {notify ? 'notifications on' : 'off'}
        </text>
      </Row>

      <Row label="Slider">
        <Slider
          aria-label="Volume"
          value={volume}
          min={0}
          max={100}
          step={5}
          onChange={(ev) => setVolume(ev.value)}
          style={{ width: 200 }}
        />
        <text style={{ color: '$text' }}>{`${volume}`}</text>
      </Row>

      <Row label="Progress">
        <box style={{ flexGrow: 1 }}>
          <ProgressBar aria-label="Download" value={progress} />
        </box>
        <text
          style={{ color: '$textMuted' }}
        >{`${Math.round(progress * 100)}%`}</text>
      </Row>

      <Row label="Busy">
        <box style={{ flexGrow: 1 }}>
          <ProgressBar aria-label="Reticulating splines" indeterminate />
        </box>
        <text style={{ color: '$textMuted' }}>no idea how long</text>
      </Row>

      <Row label="Select">
        <Select
          options={['fast', 'faster', 'ludicrous']}
          value={speed}
          onChange={(ev) => setSpeed(ev.value)}
          style={{ width: 160 }}
        />
      </Row>

      <Row label="Input">
        <textinput
          placeholder="Type here…"
          style={{
            flexGrow: 1,
            // The palette's control padding: this is the gallery, so a field
            // that is not the same height as the buttons above it is the one
            // thing this file must not show.
            paddingTop: '$paddingY',
            paddingBottom: '$paddingY',
            paddingLeft: 10,
            paddingRight: 10,
            borderRadius: '$radius',
            borderWidth: '$borderWidth',
            borderColor: '$border',
            backgroundColor: '$surface',
          }}
        />
      </Row>

      <Row label="Notes" alignItems="flex-start">
        <textarea
          rows={4}
          value={note}
          onChange={(ev) => setNote(ev.target.value)}
          style={{
            flexGrow: 1,
            minWidth: 0,
            padding: 8,
            borderRadius: 4,
            borderWidth: 1,
            borderColor: '$border',
            backgroundColor: '$surface',
          }}
        />
      </Row>
    </box>
  );
}

function App() {
  return (
    <window
      width={460}
      height={720}
      title="widgets"
      style={{ backgroundColor: '$surfaceHover' }}
    >
      <WidgetsPanel />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
