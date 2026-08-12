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
        <Button
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
            padding: 8,
            borderRadius: 4,
            borderWidth: 1,
            borderColor: '$border',
            backgroundColor: '$surface',
          }}
        />
      </Row>

      <Row label="Markdown" alignItems="flex-start">
        {/* `flex: 1` — the zero basis is the point: with a content-sized
            basis the markdown's natural width sets this column's base size
            and pushes the row past the window edge. `minWidth: 0` lets it go
            below the content's floor as well */}
        <box style={{ flex: 1, minWidth: 0, gap: 8 }}>
          {/* the textarea is the source, the <markdown> element is the
              preview: every keystroke re-parses through ntk's
              MarkdownView, which is cheap enough for a document this size */}
          <textarea
            rows={4}
            value={note}
            onChange={(ev) => setNote(ev.target.value)}
            style={{
              flexGrow: 0,
              padding: 8,
              borderRadius: 4,
              borderWidth: 1,
              borderColor: '$border',
              backgroundColor: '$surface',
            }}
          />
          <box
            style={{
              overflow: 'scroll',
              height: 110,
              padding: 4,
              borderRadius: 4,
              borderWidth: 1,
              borderColor: '$track',
              // `<markdown>` draws with ntk's own document palette — its own
              // colours for headings, code, links and quotes — and does not
              // follow this one, so the surface under it stays light. That
              // is what "override if needed" is for.
              backgroundColor: 'white',
            }}
          >
            <markdown style={{ padding: 6 }}>{note}</markdown>
          </box>
        </box>
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
